import { randomUUID } from "crypto";
import { Message, ModelChunk, StreamOptions } from "@forgeai/core";
import { BaseProvider } from "./base-provider";

export interface MockResponse {
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  delayMs?: number;
  error?: string;
}

export class MockProvider extends BaseProvider {
  name = "mock";

  constructor(
    private readonly responses: MockResponse[],
    logger: { info: (m: string) => void; error: (m: string, e?: Error) => void; warn: (m: string) => void; debug: (m: string) => void }
  ) {
    super(logger);
  }

  async *streamChat(
    _messages: Message[],
    _options: StreamOptions
  ): AsyncIterable<ModelChunk> {
    for (const response of this.responses) {
      if (response.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }

      if (response.error) {
        throw new Error(response.error);
      }

      yield {
        content: response.content,
        toolCalls: response.toolCalls?.map((tc) => ({ ...tc, id: `call_${randomUUID()}` })) as any,
        done: true,
      };
    }
  }

  supportsStreaming(): boolean {
    return true;
  }
}
