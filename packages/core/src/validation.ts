import { z } from "zod";
import {
  AgentStep,
  AgentLoopState,
  ForgeAIConfig,
  Logger,
  Message,
  ModelChunk,
  ModelProvider,
  PermissionLevel,
  PermissionPolicy,
  Platform,
  ProviderConfig,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export const ProviderConfigSchema = z.object({
  type: z.enum(["gemini", "openrouter", "groq", "ollama", "mock"]),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
});

export const RouterConfigSchema = z.object({
  primary: ProviderConfigSchema,
  fallback: ProviderConfigSchema.optional(),
});

export const PermissionRuleSchema = z.object({
  pattern: z.string().min(1),
  level: z.enum(["safe", "approval", "block"]),
  category: z.enum([
    "file_read",
    "file_write",
    "shell",
    "git",
    "search",
    "network",
  ]),
  platforms: z.array(z.enum(["win32", "darwin", "linux", "any"])).optional(),
});

export const PermissionPolicySchema = z.object({
  rules: z.array(PermissionRuleSchema),
  defaultLevel: z.enum(["safe", "approval", "block"]),
});

export const ForgeAIConfigSchema = z.object({
  provider: z.union([ProviderConfigSchema, RouterConfigSchema]),
  workspaceRoot: z.string().min(1),
  permissionPolicy: PermissionPolicySchema,
  maxIterations: z.number().positive().default(10),
  contextWindowLimit: z.number().positive().default(100000),
});

export type ValidatedProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ValidatedPermissionPolicy = z.infer<typeof PermissionPolicySchema>;
export type ValidatedForgeAIConfig = z.infer<typeof ForgeAIConfigSchema>;

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: z.ZodError;
}

export function validateConfig(
  config: unknown
): ValidationResult<ValidatedForgeAIConfig> {
  const result = ForgeAIConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function createNoopLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

export function createNoopCancellationToken() {
  return {
    get cancelled() {
      return false;
    },
    onCancelled: () => {},
  };
}

export function createToolContext(
  workspaceRoot: string,
  requestApproval: (reason: string) => Promise<boolean>,
  logger: Logger = createNoopLogger(),
  cancellationToken?: { cancelled: boolean; onCancelled: (cb: () => void) => void }
): ToolContext {
  return {
    workspaceRoot,
    platform: (process.platform as Platform) || "win32",
    requestApproval,
    logger,
    cancellationToken,
  };
}
