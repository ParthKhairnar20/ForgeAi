import { Message, ModelChunk, ProviderConfig, StreamOptions } from "@forgeai/core";
import { BaseProvider } from "./base-provider.js";

export class OllamaProvider extends BaseProvider {
  name = "ollama";

  constructor(private readonly config: ProviderConfig, logger: { info: (m: string) => void; error: (m: string, e?: Error) => void; warn: (m: string) => void; debug: (m: string) => void }) {
    super(logger);
  }

  async *streamChat(
    messages: Message[],
    _options: StreamOptions
  ): AsyncIterable<ModelChunk> {
    throw new Error("OllamaProvider is not implemented yet. Use 'gemini' provider for V0.");
  }

  supportsStreaming(): boolean {
    return false;
  }
}
