import { describe, it, expect, beforeEach } from "vitest";
import { PermissionEvaluator, PermissionLevel, CommandCategory } from "./permission";
import { resolveProviderApiKey, redactApiKey } from "./secrets";

describe("PermissionEvaluator", () => {
  let evaluator: PermissionEvaluator;

  beforeEach(() => {
    const policy = {
      rules: [
        {
          pattern: "node",
          level: "approval" as PermissionLevel,
          category: "shell" as CommandCategory,
        },
        {
          pattern: "npm",
          level: "safe" as PermissionLevel,
          category: "shell" as CommandCategory,
        },
        {
          pattern: "*",
          level: "block" as PermissionLevel,
          category: "shell" as CommandCategory,
        },
      ],
      defaultLevel: "safe" as PermissionLevel,
    };
    evaluator = new PermissionEvaluator(policy, "win32");
  });

  it("should return safe for npm command", () => {
    expect(evaluator.evaluate("shell", "npm")).toBe("safe");
  });

  it("should return approval for node command", () => {
    expect(evaluator.evaluate("shell", "node")).toBe("approval");
  });

  it("should return block for other commands", () => {
    expect(evaluator.evaluate("shell", "python")).toBe("block");
  });

  it("should return default level for unknown categories", () => {
    expect(evaluator.evaluate("git", "git status")).toBe("safe");
  });
});

describe("resolveProviderApiKey", () => {
  it("should return config apiKey when provided", () => {
    const result = resolveProviderApiKey({ type: "gemini", apiKey: "config-key" }, {});
    expect(result).toBe("config-key");
  });

  it("should fallback to GEMINI_API_KEY env var", () => {
    const result = resolveProviderApiKey({ type: "gemini", apiKey: "" }, { GEMINI_API_KEY: "env-gemini-key" });
    expect(result).toBe("env-gemini-key");
  });

  it("should fallback to OPENROUTER_API_KEY env var for openrouter", () => {
    const result = resolveProviderApiKey({ type: "openrouter", apiKey: "" }, { OPENROUTER_API_KEY: "env-or-key" });
    expect(result).toBe("env-or-key");
  });

  it("should throw when no apiKey and no env var for gemini", () => {
    expect(() => resolveProviderApiKey({ type: "gemini", apiKey: "" }, {})).toThrow("Missing API key");
  });

  it("should throw when no apiKey and no env var for openrouter", () => {
    expect(() => resolveProviderApiKey({ type: "openrouter", apiKey: "" }, {})).toThrow("Missing API key");
  });

  it("should throw for unknown provider type", () => {
    expect(() => resolveProviderApiKey({ type: "unknown", apiKey: "" }, {})).toThrow("Unknown provider type");
  });
});

describe("redactApiKey", () => {
  it("should redact long keys", () => {
    const result = redactApiKey("abcdefghijklmnop");
    expect(result).toBe("abcd...mnop");
  });

  it("should return *** for short keys", () => {
    expect(redactApiKey("abc")).toBe("***");
  });

  it("should return *** for 8 char keys", () => {
    expect(redactApiKey("12345678")).toBe("***");
  });

  it("should redact 9 char keys", () => {
    expect(redactApiKey("123456789")).toBe("1234...6789");
  });
});
