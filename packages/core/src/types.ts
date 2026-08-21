import type { ToolResult, ToolError, ToolMetadata, ToolErrorCode } from "./tool-result.js";

export const PermissionLevel = {
  SAFE: "safe",
  APPROVAL: "approval",
  BLOCK: "block",
} as const;

export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

export const CommandCategory = {
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  SHELL: "shell",
  GIT: "git",
  SEARCH: "search",
  NETWORK: "network",
} as const;

export type CommandCategory = (typeof CommandCategory)[keyof typeof CommandCategory];

export interface PermissionRule {
  pattern: string;
  level: PermissionLevel;
  category: CommandCategory;
  platforms?: Platform[];
}

export type Platform = "win32" | "darwin" | "linux" | "any";

export interface PermissionPolicy {
  rules: PermissionRule[];
  defaultLevel: PermissionLevel;
}

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  category: CommandCategory;
  permissionLevel: PermissionLevel;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  platform: Platform;
  requestApproval: (reason: string) => Promise<boolean>;
  logger: Logger;
  cancellationToken?: CancellationToken;
}

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, error?: Error) => void;
  debug: (message: string) => void;
}

export interface CancellationToken {
  readonly cancelled: boolean;
  onCancelled: (callback: () => void) => void;
}

export interface AgentStep {
  type: "think" | "search" | "read" | "write" | "command" | "verify" | "edit";
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  toolCalls?: ToolCall[];
}

export interface AgentLoopState {
  status: "idle" | "thinking" | "searching" | "editing" | "verifying" | "completed" | "failed" | "cancelled";
  currentStep?: AgentStep;
  steps: AgentStep[];
  messages: Message[];
  contextFiles: string[];
}

export interface ModelProvider {
  name: string;
  streamChat(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<ModelChunk>;
  supportsStreaming(): boolean;
}

export interface ModelChunk {
  content: string;
  toolCalls?: ToolCall[];
  done: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface StreamOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderConfig {
  type: "gemini" | "openrouter" | "groq" | "ollama" | "mock";
  apiKey?: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RouterConfig {
  primary: ProviderConfig;
  fallback?: ProviderConfig;
}

export interface ForgeAIConfig {
  provider: ProviderConfig | RouterConfig;
  workspaceRoot: string;
  permissionPolicy: PermissionPolicy;
  maxIterations: number;
  contextWindowLimit: number;
}
