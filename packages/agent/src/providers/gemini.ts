import { Content, FunctionDeclaration, GoogleGenAI, Type } from "@google/genai";
import { randomUUID } from "crypto";
import { Message, ModelChunk, ProviderConfig, StreamOptions, ToolCall } from "@forgeai/core";
import { BaseProvider } from "./base-provider.js";

export class GeminiProvider extends BaseProvider {
  name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(private readonly config: ProviderConfig, logger: { info: (m: string) => void; error: (m: string, e?: Error) => void; warn: (m: string) => void; debug: (m: string) => void }) {
    super(logger);
    if (!config.apiKey) throw new Error("Gemini API key is required. Set GEMINI_API_KEY environment variable or configure provider.apiKey.");
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async *streamChat(messages: Message[], options: StreamOptions): AsyncIterable<ModelChunk> {
    try {
      const { systemInstruction, contents } = this.buildContents(messages);
      const stream = await this.client.models.generateContentStream({
        model: this.config.model || "gemini-3.6-flash",
        contents,
        config: {
          systemInstruction,
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
          abortSignal: options.signal,
          tools: options.tools?.length ? [{ functionDeclarations: options.tools.map((tool) => this.toFunctionDeclaration(tool)) }] : undefined,
        },
      });

      let finalContent: Content | undefined;
      let finalToolCalls: ToolCall[] | undefined;
      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          yield { content: "", done: true };
          return;
        }
        const content = chunk.candidates?.[0]?.content;
        if (content) finalContent = content;
        const calls = chunk.functionCalls?.map((call) => ({
          id: call.id || randomUUID(),
          name: call.name || "",
          arguments: (call.args || {}) as Record<string, unknown>,
        })).filter((call) => call.name);
        if (calls?.length) finalToolCalls = calls;
        if (chunk.text) yield { content: chunk.text, done: false };
      }

      yield { content: "", done: true, toolCalls: finalToolCalls, metadata: finalContent ? { geminiContent: finalContent } : undefined };
    } catch (error) {
      this.logger.error("GeminiProvider streamChat failed", error as Error);
      if (options.signal?.aborted || (error as { name?: string }).name === "AbortError") {
        yield { content: "", done: true };
      } else if ((error as { status?: number }).status === 429) {
        yield { content: "", done: true, error: "Rate limit exceeded. Please retry later." };
      } else if ((error as { status?: number }).status === 401) {
        yield { content: "", done: true, error: "Authentication failed. Check your API key." };
      } else {
        yield { content: "", done: true, error: `Gemini API error: ${(error as Error).message}` };
      }
    }
  }

  supportsStreaming(): boolean { return true; }

  private buildContents(messages: Message[]): { systemInstruction?: Content; contents: Content[] } {
    const contents: Content[] = [];
    let systemInstruction: Content | undefined;
    for (const message of messages) {
      if (message.role === "system") {
        systemInstruction = { role: "user", parts: [{ text: message.content }] };
      } else if (message.role === "assistant") {
        const originalContent = message.metadata?.geminiContent as Content | undefined;
        contents.push(originalContent || {
          role: "model",
          parts: message.toolCalls?.length
            ? message.toolCalls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.arguments } }))
            : [{ text: message.content }],
        });
      } else if (message.role === "tool") {
        const name = typeof message.metadata?.name === "string" ? message.metadata.name : "tool";
        const id = typeof message.metadata?.toolCallId === "string" ? message.metadata.toolCallId : undefined;
        contents.push({ role: "user", parts: [{ functionResponse: { id, name, response: { result: message.content } } }] });
      } else {
        contents.push({ role: "user", parts: [{ text: message.content }] });
      }
    }
    return { systemInstruction, contents };
  }

  private toFunctionDeclaration(tool: NonNullable<StreamOptions["tools"]>[number]): FunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: Object.fromEntries(Object.entries(tool.parameters.properties).map(([name, schema]) => [name, this.toSchema(schema)])),
        required: tool.parameters.required,
      },
    };
  }

  private toSchema(schema: unknown): Record<string, unknown> {
    const value = schema as { type?: string; description?: string; items?: unknown };
    const typeMap: Record<string, Type> = { string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER, boolean: Type.BOOLEAN, array: Type.ARRAY, object: Type.OBJECT };
    return { type: typeMap[value.type || "string"] || Type.STRING, description: value.description, ...(value.items ? { items: this.toSchema(value.items) } : {}) };
  }
}
