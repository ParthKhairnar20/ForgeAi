import { randomUUID } from "crypto";
import { Message, ModelChunk, ProviderConfig, StreamOptions, ToolCall } from "@forgeai/core";
import { BaseProvider } from "./base-provider.js";

export class OpenRouterProvider extends BaseProvider {
  name = "openrouter";
  private readonly baseURL: string;

  constructor(private readonly config: ProviderConfig, logger: { info: (m: string) => void; error: (m: string, e?: Error) => void; warn: (m: string) => void; debug: (m: string) => void }) {
    super(logger);

    if (!config.apiKey) {
      throw new Error("OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable or configure provider.apiKey.");
    }

    this.baseURL = config.baseURL || "https://openrouter.ai/api/v1";
  }

  async *streamChat(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<ModelChunk> {
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://forgeai.dev",
          "X-Title": "ForgeAI",
        },
        body: JSON.stringify({
          model: this.config.model || "meta-llama/llama-3.1-8b-instruct",
          messages: messages.map((m) => {
            if (m.role === "assistant" && m.toolCalls?.length) {
              return {
                role: "assistant",
                content: m.content || null,
                tool_calls: m.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              };
            }
            if (m.role === "tool") {
              return { role: "tool", tool_call_id: m.metadata?.toolCallId, content: m.content };
            }
            return { role: m.role, content: m.content };
          }),
          stream: true,
          temperature: this.config.temperature ?? 0.2,
          max_tokens: this.config.maxTokens ?? 4096,
          tools: options.tools?.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        if (response.status === 401) {
          throw new Error(`OpenRouter authentication failed: ${response.statusText}`);
        } else if (response.status === 429) {
          throw new Error(`OpenRouter rate limit exceeded: ${response.statusText}`);
        } else {
          throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
        }
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("OpenRouter response body is not readable.");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") {
            yield {
              content: "",
              done: true,
              toolCalls: this.resolveToolCalls(pendingToolCalls),
              usage: { promptTokens: 0, completionTokens: 0 },
            };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            for (const toolCall of parsed.choices?.[0]?.delta?.tool_calls || []) {
              const index = toolCall.index ?? 0;
              const existing = pendingToolCalls.get(index) || { id: toolCall.id || randomUUID(), name: "", arguments: "" };
              if (toolCall.id) existing.id = toolCall.id;
              if (toolCall.function?.name) existing.name += toolCall.function.name;
              if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
              pendingToolCalls.set(index, existing);
            }
            yield { content: delta, done: false };
          } catch {
            // ignore malformed JSON
          }
        }
      }

      yield {
        content: "",
        done: true,
        toolCalls: this.resolveToolCalls(pendingToolCalls),
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    } catch (error) {
      this.logger.error("OpenRouterProvider streamChat failed", error as Error);
      if ((error as any).name === "AbortError") {
        yield { content: "", done: true };
      } else {
        yield { content: "", done: true, error: `OpenRouter error: ${(error as Error).message}` };
      }
    }
  }

  supportsStreaming(): boolean {
    return true;
  }

  private resolveToolCalls(calls: Map<number, { id: string; name: string; arguments: string }>): ToolCall[] | undefined {
    const resolved = Array.from(calls.values()).map((call) => {
      let arguments_: Record<string, unknown> = {};
      try {
        arguments_ = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        this.logger.warn(`Ignoring invalid arguments for tool call ${call.name}.`);
      }
      return { id: call.id, name: call.name, arguments: arguments_ };
    }).filter((call) => call.name);
    return resolved.length ? resolved : undefined;
  }
}
