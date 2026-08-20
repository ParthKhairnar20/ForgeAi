import { describe, it, expect } from "vitest";
import { ModelRouter, RouterDecision } from "./providers/model-router";
import { MockProvider, MockResponse } from "./providers/mock";
import { createNoopLogger } from "@forgeai/core";

describe("ModelRouter", () => {
  it("should use primary provider when it succeeds", async () => {
    const responses: MockResponse[] = [
      { content: "Primary response", toolCalls: [] },
    ];
    const router = new ModelRouter(
      { type: "mock", model: "mock" },
      { type: "mock", model: "mock" },
      createNoopLogger()
    );
    (router as any).primaryProvider = new MockProvider(responses, createNoopLogger());
    (router as any).fallbackProvider = new MockProvider([{ content: "Fallback", toolCalls: [] }], createNoopLogger());

    const chunks: any[] = [];
    for await (const chunk of router.streamChat([{ id: "1", role: "user", content: "hi", timestamp: 0 }], {})) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.content === "Primary response")).toBe(true);
    const decision = router.getLastDecision();
    expect(decision).toBeDefined();
    expect(decision!.fallback).toBe(false);
  });

  it("should fallback to secondary when primary fails", async () => {
    const router = new ModelRouter(
      { type: "mock", model: "mock" },
      { type: "mock", model: "mock" },
      createNoopLogger()
    );
    (router as any).primaryProvider = new MockProvider([{ content: "", error: "Primary failed" }], createNoopLogger());
    (router as any).fallbackProvider = new MockProvider([{ content: "Fallback response", toolCalls: [] }], createNoopLogger());

    const chunks: any[] = [];
    for await (const chunk of router.streamChat([{ id: "1", role: "user", content: "hi", timestamp: 0 }], {})) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.content === "Fallback response")).toBe(true);
    const decision = router.getLastDecision();
    expect(decision).toBeDefined();
    expect(decision!.fallback).toBe(true);
    expect(decision!.reason).toContain("Primary provider");
  });

  it("should return combined error when both providers fail", async () => {
    const router = new ModelRouter(
      { type: "mock", model: "mock" },
      { type: "mock", model: "mock" },
      createNoopLogger()
    );
    (router as any).primaryProvider = new MockProvider([{ content: "", error: "Primary failed" }], createNoopLogger());
    (router as any).fallbackProvider = new MockProvider([{ content: "", error: "Fallback failed" }], createNoopLogger());

    const chunks: any[] = [];
    for await (const chunk of router.streamChat([{ id: "1", role: "user", content: "hi", timestamp: 0 }], {})) {
      chunks.push(chunk);
    }

    const errorChunk = chunks.find((c) => c.error);
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toContain("Both providers failed");
    expect(errorChunk!.error).toContain("Primary failed");
    expect(errorChunk!.error).toContain("Fallback failed");
  });

  it("should report error when primary fails and no fallback configured", async () => {
    const router = new ModelRouter(
      { type: "mock", model: "mock" },
      null,
      createNoopLogger()
    );
    (router as any).primaryProvider = new MockProvider([{ content: "", error: "Only provider failed" }], createNoopLogger());

    const chunks: any[] = [];
    for await (const chunk of router.streamChat([{ id: "1", role: "user", content: "hi", timestamp: 0 }], {})) {
      chunks.push(chunk);
    }

    const errorChunk = chunks.find((c) => c.error);
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toContain("Primary provider failed");
  });
});
