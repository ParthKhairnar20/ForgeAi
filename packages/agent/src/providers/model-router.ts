import { Logger, Message, ModelChunk, ProviderConfig, StreamOptions } from "@forgeai/core";
import { BaseProvider } from "./base-provider";
import { createProvider } from "./index";

export interface RouterDecision {
  providerName: string;
  providerType: string;
  fallback: boolean;
  reason?: string;
}

export class ModelRouter extends BaseProvider {
  name = "model-router";
  private readonly primaryProvider: BaseProvider;
  private readonly fallbackProvider: BaseProvider | null;
  private lastDecision: RouterDecision | null = null;

  constructor(
    private readonly primaryConfig: ProviderConfig,
    private readonly fallbackConfig: ProviderConfig | null,
    logger: Logger
  ) {
    super(logger);
    this.primaryProvider = createProvider(primaryConfig, logger);
    this.fallbackProvider = fallbackConfig ? createProvider(fallbackConfig, logger) : null;
  }

  async *streamChat(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<ModelChunk> {
    try {
      this.lastDecision = {
        providerName: this.primaryProvider.name,
        providerType: this.primaryConfig.type,
        fallback: false,
      };
      this.logger.info(`Routing to primary provider: ${this.primaryProvider.name}`);

      for await (const chunk of this.primaryProvider.streamChat(messages, options)) {
        yield chunk;
        if (chunk.done) return;
      }
    } catch (primaryError) {
      this.logger.warn(`Primary provider ${this.primaryProvider.name} failed: ${(primaryError as Error).message}`);

      if (!this.fallbackProvider) {
        yield { content: "", done: true, error: `Primary provider failed and no fallback configured: ${(primaryError as Error).message}` };
        return;
      }

      try {
        this.lastDecision = {
          providerName: this.fallbackProvider.name,
          providerType: this.fallbackConfig!.type,
          fallback: true,
          reason: `Primary provider (${this.primaryProvider.name}) failed: ${(primaryError as Error).message}`,
        };
        this.logger.info(`Falling back to: ${this.fallbackProvider.name}`);

        for await (const chunk of this.fallbackProvider.streamChat(messages, options)) {
          yield chunk;
          if (chunk.done) return;
        }
      } catch (fallbackError) {
        this.logger.error(`Fallback provider ${this.fallbackProvider.name} also failed`, fallbackError as Error);
        yield {
          content: "",
          done: true,
          error: `Both providers failed. Primary (${this.primaryProvider.name}): ${(primaryError as Error).message}. Fallback (${this.fallbackProvider.name}): ${(fallbackError as Error).message}`,
        };
      }
    }
  }

  supportsStreaming(): boolean {
    return this.primaryProvider.supportsStreaming() || (this.fallbackProvider?.supportsStreaming() ?? false);
  }

  getLastDecision(): RouterDecision | null {
    return this.lastDecision;
  }
}
