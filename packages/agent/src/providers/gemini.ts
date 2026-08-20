import { GoogleGenerativeAI, GenerativeModel, Content } from "@google/generative-ai";
import { Message, ModelChunk, ProviderConfig, StreamOptions } from "@forgeai/core";
import { BaseProvider } from "./base-provider";

export class GeminiProvider extends BaseProvider {
  name = "gemini";
  private model: GenerativeModel;
  private genAI: GoogleGenerativeAI;

  constructor(private readonly config: ProviderConfig, logger: { info: (m: string) => void; error: (m: string, e?: Error) => void; warn: (m: string) => void; debug: (m: string) => void }) {
    super(logger);

    if (!config.apiKey) {
      throw new Error("Gemini API key is required. Set GEMINI_API_KEY environment variable or configure provider.apiKey.");
    }

    this.genAI = new GoogleGenerativeAI(config.apiKey);
    const modelName = config.model || "gemini-pro";
    this.model = this.genAI.getGenerativeModel({ model: modelName });
  }

  async *streamChat(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<ModelChunk> {
    try {
      const history = this.buildHistory(messages);
      const userMessage = this.extractLastUserMessage(messages);

      const chat = this.model.startChat({ history });
      const result = await chat.sendMessageStream(userMessage || "Continue.", {
        signal: options.signal,
      });

      let fullContent = "";
      for await (const chunk of result.stream) {
        if (options.signal?.aborted) {
          yield { content: "", done: true };
          return;
        }
        const text = chunk.text();
        if (text) {
          fullContent += text;
          yield {
            content: text,
            done: false,
          };
        }
      }

      const response = await result.response;
      const usageMetadata = response.usageMetadata;
      yield {
        content: "",
        done: true,
        usage: {
          promptTokens: usageMetadata?.promptTokenCount ?? 0,
          completionTokens: usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error) {
      this.logger.error("GeminiProvider streamChat failed", error as Error);
      if ((error as any).status === 429) {
        yield { content: "", done: true, error: "Rate limit exceeded. Please retry later." };
      } else if ((error as any).status === 401) {
        yield { content: "", done: true, error: "Authentication failed. Check your API key." };
      } else {
        yield { content: "", done: true, error: `Gemini API error: ${(error as Error).message}` };
      }
    }
  }

  supportsStreaming(): boolean {
    return true;
  }

  private buildHistory(messages: Message[]): Content[] {
    const history: Content[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        history.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (msg.role === "assistant") {
        history.push({ role: "model", parts: [{ text: msg.content }] });
      }
    }
    return history;
  }

  private extractLastUserMessage(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return messages[i].content;
      }
    }
    return "";
  }
}
