import { randomUUID } from "crypto";

import {
  AgentLoopState,
  AgentStep,
  ForgeAIConfig,
  Logger,
  Message,
  ModelChunk,
  ModelProvider,
  PermissionEvaluator,
  Platform,
  ProviderConfig,
  RouterConfig,
  StreamOptions,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@forgeai/core";
import { createBuiltinTools } from "./tools";
import { createProvider, ModelRouter } from "./providers";
import { discoverContextFiles, readContextFiles } from "./context";

export type AgentEvent =
  | { type: "step"; step: AgentStep }
  | { type: "message"; message: Message }
  | { type: "state"; state: AgentLoopState }
  | { type: "complete"; state: AgentLoopState }
  | { type: "error"; error: string };

export interface AgentLoopOptions {
  onEvent?: (event: AgentEvent) => void;
  cancellationToken?: { cancelled: boolean; onCancelled: (cb: () => void) => void };
}

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly toolContext: ToolContext;
  private readonly state: AgentLoopState;
  private readonly maxIterations: number;
  private abortController: AbortController | null = null;

  constructor(
    private readonly config: ForgeAIConfig,
    private readonly logger: Logger
  ) {
    const providerConfig = config.provider as any;
    if (providerConfig.primary) {
      const routerConfig = providerConfig as RouterConfig;
      this.provider = new ModelRouter(routerConfig.primary, routerConfig.fallback || null, logger);
    } else {
      this.provider = createProvider(providerConfig, logger);
    }

    const permissionEvaluator = new PermissionEvaluator(
      config.permissionPolicy,
      (process.platform as "win32" | "darwin" | "linux") || "win32"
    );
    this.tools = new Map(
      createBuiltinTools(permissionEvaluator).map((t) => [t.name, t])
    );
    this.toolContext = {
      workspaceRoot: config.workspaceRoot,
      platform: ((process.platform as "win32" | "darwin" | "linux") || "win32") as Platform,
      requestApproval: async (reason: string) => {
        this.logger.info(`Approval requested: ${reason}`);
        return true;
      },
      logger,
    };
    this.maxIterations = config.maxIterations;
    this.state = {
      status: "idle",
      steps: [],
      messages: [],
      contextFiles: [],
    };
  }

  async *run(userMessage: string, options?: AgentLoopOptions): AsyncIterable<AgentEvent> {
    this.state.status = "thinking";
    this.state.messages.push(this.createUserMessage(userMessage));
    this.abortController = new AbortController();

    try {
      const contextFiles = await discoverContextFiles(this.config.workspaceRoot, userMessage, this.config.contextWindowLimit);
      this.state.contextFiles = contextFiles.map((f) => f.relativePath);

      if (contextFiles.length > 0) {
        const contents = await readContextFiles(contextFiles);
        const contextBlock = contents.size > 0
          ? `You have access to the following project files:\n\n${Array.from(contents.entries()).map(([rel, content]) => `--- ${rel} ---\n${content}`).join("\n\n")}`
          : "No relevant project files found for context.";
        this.state.messages.unshift({
          id: randomUUID(),
          role: "system",
          content: contextBlock,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      this.logger.warn(`Context discovery failed: ${(error as Error).message}`);
    }

    yield this.emitState(options);

    try {
      let shouldStop = false;
      for (let i = 0; i < this.maxIterations && !shouldStop; i++) {
        if (options?.cancellationToken?.cancelled) {
          this.state.status = "cancelled";
          yield this.emitState(options);
          yield { type: "complete", state: { ...this.state } };
          return;
        }

        const step = this.startStep("think", `Iteration ${i + 1}: Planning`);
        yield this.emitStep(step, options);

        const toolCalls: ToolCall[] = [];
        const effectiveProvider = this.getEffectiveProviderConfig();
        const streamOptions: StreamOptions = {
          tools: Array.from(this.tools.values()),
          temperature: effectiveProvider.temperature ?? 0.2,
          maxTokens: effectiveProvider.maxTokens ?? 4096,
          signal: this.abortController!.signal,
        };

        let fullContent = "";
        for await (const chunk of this.provider.streamChat(this.state.messages, streamOptions)) {
          if (options?.cancellationToken?.cancelled) {
            this.state.status = "cancelled";
            yield this.emitState(options);
            yield { type: "complete", state: { ...this.state } };
            return;
          }

          fullContent += chunk.content;
          if (chunk.toolCalls) {
            toolCalls.push(...chunk.toolCalls);
          }
          if (chunk.done) {
            const assistantMessage = this.createAssistantMessage(fullContent, toolCalls);
            this.state.messages.push(assistantMessage);

            if (toolCalls.length > 0) {
              const editStep = this.startStep("edit", `Executing ${toolCalls.length} tool(s)`);
              yield this.emitStep(editStep, options);

              const results = await this.executeTools(toolCalls);

              for (const result of results) {
                this.state.messages.push(this.createToolResultMessage(result));
              }
              this.trimMessages();

              this.completeStep(editStep);
              yield this.emitStep(editStep, options);

              const needsCorrection = results.some((r) => !r.success);
              if (needsCorrection) {
                this.logger.warn("Tool execution failed, requesting correction.");
                const correctionPrompt = "Some operations failed. Please analyze the errors and retry with corrected actions.";
                this.state.messages.push(this.createUserMessage(correctionPrompt));
                toolCalls.length = 0;
                fullContent = "";
                continue;
              }
              toolCalls.length = 0;
              fullContent = "";
            } else {
              this.state.status = "completed";
              this.completeStep(step, fullContent);
              yield this.emitStep(step, options);
              yield { type: "complete", state: { ...this.state } };
              shouldStop = true;
              break;
            }
          }
        }

        if (!shouldStop) {
          this.completeStep(step, fullContent);
          yield this.emitStep(step, options);
        }
      }

      if (!shouldStop) {
        this.state.status = "failed";
        this.logger.error(`Agent loop exceeded max iterations (${this.maxIterations})`);
        yield { type: "complete", state: { ...this.state } };
      }
    } catch (error) {
      this.state.status = "failed";
      this.logger.error("Agent loop failed", error as Error);
      yield { type: "error", error: String(error) };
      yield { type: "complete", state: { ...this.state } };
    }
  }

  private async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      if (this.abortController?.signal.aborted) {
        break;
      }

      const tool = this.tools.get(call.name);
      if (!tool) {
        results.push({
          id: randomUUID(),
          toolCallId: call.id,
          name: call.name,
          success: false,
          output: "",
          error: `Unknown tool: ${call.name}`,
          durationMs: 0,
        });
        continue;
      }

      try {
        const result = await tool.handler(call.arguments, this.toolContext);
        results.push(result);
        this.logger.info(`Tool ${call.name} executed: ${result.success ? "success" : "failure"}`);
      } catch (error) {
        results.push({
          id: randomUUID(),
          toolCallId: call.id,
          name: call.name,
          success: false,
          output: "",
          error: String(error),
          durationMs: 0,
        });
        this.logger.error(`Tool ${call.name} failed`, error as Error);
      }
    }
    return results;
  }

  private getEffectiveProviderConfig(): ProviderConfig {
    const provider = this.config.provider as any;
    if (provider.primary) {
      return provider.primary;
    }
    return provider;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.state.status = "cancelled";
  }

  private startStep(type: AgentStep["type"], description: string): AgentStep {
    return {
      type,
      description,
      status: "running",
      startTime: Date.now(),
    };
  }

  private completeStep(step: AgentStep, result?: string): void {
    step.status = "completed";
    step.endTime = Date.now();
    step.result = result;
    this.state.steps.push(step);
  }

  private createUserMessage(content: string): Message {
    return {
      id: randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    };
  }

  private createAssistantMessage(content: string, toolCalls?: ToolCall[]): Message {
    return {
      id: randomUUID(),
      role: "assistant",
      content,
      timestamp: Date.now(),
      toolCalls,
    };
  }

  private createToolResultMessage(result: ToolResult): Message {
    return {
      id: randomUUID(),
      role: "tool",
      content: result.success
        ? `[${result.name}]\n${result.output}`
        : `[${result.name}] ERROR: ${result.error}`,
      timestamp: Date.now(),
      metadata: { success: result.success, durationMs: result.durationMs },
    };
  }

  private trimMessages(): void {
    const maxMessages = 50;
    if (this.state.messages.length > maxMessages) {
      const keepSystem = this.state.messages[0]?.role === "system" ? [this.state.messages[0]] : [];
      const remaining = this.state.messages.slice(-maxMessages);
      this.state.messages = [...keepSystem, ...remaining];
    }
  }

  private emitStep(step: AgentStep, options?: AgentLoopOptions): AgentEvent {
    return { type: "step", step };
  }

  private emitState(options?: AgentLoopOptions): AgentEvent {
    return { type: "state", state: { ...this.state } };
  }
}
