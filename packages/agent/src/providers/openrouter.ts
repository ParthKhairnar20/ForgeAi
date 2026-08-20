import { Message, ModelChunk, ProviderConfig, StreamOptions } from "@forgeai/core";
import { BaseProvider } from "./base-provider";

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
    _options: StreamOptions
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
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: this.config.temperature ?? 0.2,
          max_tokens: this.config.maxTokens ?? 4096,
        }),
        signal: _options.signal,
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
      let fullContent = "";

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
              content: fullContent,
              done: true,
              usage: { promptTokens: 0, completionTokens: 0 },
            };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            fullContent += delta;
            yield { content: delta, done: false };
          } catch {
            // ignore malformed JSON
          }
        }
      }

      yield {
        content: fullContent,
        done: true,
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
}
