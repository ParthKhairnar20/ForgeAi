import { Logger, Message, ModelChunk, ModelProvider, StreamOptions } from "@forgeai/core";

export abstract class BaseProvider implements ModelProvider {
  abstract name: string;
  protected logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  abstract streamChat(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<ModelChunk>;

  supportsStreaming(): boolean {
    return true;
  }
}
