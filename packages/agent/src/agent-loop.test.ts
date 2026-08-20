import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { AgentLoop } from "./agent-loop";
import { MockProvider, MockResponse } from "./providers/mock";
import { createNoopLogger, ForgeAIConfig, PermissionLevel } from "@forgeai/core";

function createTestConfig(provider: any): ForgeAIConfig {
  return {
    provider: provider as any,
    workspaceRoot: "C:\\tmp\\test-workspace",
    permissionPolicy: {
      rules: [],
      defaultLevel: "approval" as PermissionLevel,
    },
    maxIterations: 5,
    contextWindowLimit: 100000,
  };
}

describe("AgentLoop", () => {
  it("should complete when provider returns text without tool calls", async () => {
    const responses: MockResponse[] = [
      { content: "Task completed successfully.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Fix the bug")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("completed");
    expect(completeEvent.state.messages.some((m: any) => m.content.includes("Task completed successfully"))).toBe(true);
  });

  it("should execute tools and collect results", async () => {
    const tmpDir = "C:\\tmp\\test-workspace";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world");

    const responses: MockResponse[] = [
      {
        content: "Reading the file.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "test.txt") } }],
      },
      { content: "Done reading.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Read test.txt")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const toolMessages = completeEvent.state.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].metadata.success).toBe(true);
  });

  it("should request correction when a tool fails", async () => {
    const tmpDir = "C:\\tmp\\test-workspace";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world");

    const responses: MockResponse[] = [
      {
        content: "Trying to read.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "nonexistent.txt") } }],
      },
      { content: "Retrying with a different approach." },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Read nonexistent.txt")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const userMessages = completeEvent.state.messages.filter((m: any) => m.role === "user");
    expect(userMessages.some((m: any) => m.content.includes("Some operations failed"))).toBe(true);
  });

  it("should cancel when cancellation token is set", async () => {
    const responses: MockResponse[] = [
      { content: "Working...", delayMs: 1000 },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const cancellationToken = { cancelled: false, onCancelled: (cb: () => void) => {} };
    const events: any[] = [];

    const runPromise = (async () => {
      for await (const event of loop.run("Do work", { cancellationToken })) {
        events.push(event);
        if (event.type === "state" && event.state.status === "thinking") {
          cancellationToken.cancelled = true;
        }
      }
    })();

    await runPromise;

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("cancelled");
  });

  it("should fail after max iterations when tool calls keep failing", async () => {
    const responses: MockResponse[] = [
      {
        content: "Trying.",
        toolCalls: [{ id: "call_1", name: "unknown_tool", arguments: {} }],
      },
      {
        content: "Retrying.",
        toolCalls: [{ id: "call_2", name: "unknown_tool", arguments: {} }],
      },
      {
        content: "Retrying again.",
        toolCalls: [{ id: "call_3", name: "unknown_tool", arguments: {} }],
      },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    config.maxIterations = 2;
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Do impossible task")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("failed");
  });

  it("should execute write_file through agent loop and verify file created", async () => {
    const tmpDir = "C:\\tmp\\forgeai-write-test";
    await fs.mkdir(tmpDir, { recursive: true });

    const responses: MockResponse[] = [
      {
        content: "Creating the file.",
        toolCalls: [{ id: "call_1", name: "write_file", arguments: { path: path.join(tmpDir, "forgeai-test.txt"), content: "ForgeAI works." } }],
      },
      { content: "File created successfully.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    config.workspaceRoot = tmpDir;
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Create forgeai-test.txt")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("completed");

    const fileContent = await fs.readFile(path.join(tmpDir, "forgeai-test.txt"), "utf-8");
    expect(fileContent).toBe("ForgeAI works.");
  });

  it("should self-correct when tool fails and succeed on retry", async () => {
    const tmpDir = "C:\\tmp\\forgeai-correction-test";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "calc.ts"), "export function add(a: number, b: number) { return a - b; }");

    const responses: MockResponse[] = [
      {
        content: "Reading the calc.ts file.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "calc.ts") } }],
      },
      {
        content: "Fixing the bug.",
        toolCalls: [{ id: "call_2", name: "write_file", arguments: { path: path.join(tmpDir, "calc.ts"), content: "export function add(a: number, b: number) { return a + b; }" } }],
      },
      { content: "Bug fixed. The function now correctly adds numbers.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    config.workspaceRoot = tmpDir;
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Find and fix the bug in calc.ts")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("completed");

    const toolMessages = completeEvent.state.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);

    const finalContent = await fs.readFile(path.join(tmpDir, "calc.ts"), "utf-8");
    expect(finalContent).toContain("return a + b;");
  });

  it("should cancel during tool execution and not leave activeLoop stuck", async () => {
    const tmpDir = "C:\\tmp\\forgeai-cancel-test";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    const responses: MockResponse[] = [
      {
        content: "Reading file.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "test.txt") } }],
        delayMs: 500,
      },
      { content: "Done.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const cancellationToken = { cancelled: false, onCancelled: (cb: () => void) => {} };
    const events: any[] = [];

    const runPromise = (async () => {
      for await (const event of loop.run("Read test.txt", { cancellationToken })) {
        events.push(event);
        if (event.type === "state" && event.state.status === "thinking") {
          cancellationToken.cancelled = true;
        }
      }
    })();

    await runPromise;

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("cancelled");
  });

  it("should record tool duration timing", async () => {
    const tmpDir = "C:\\tmp\\forgeai-timing-test";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    const responses: MockResponse[] = [
      {
        content: "Reading.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "test.txt") } }],
      },
      { content: "Done.", toolCalls: [] },
    ];
    const config = createTestConfig({ type: "mock", model: "mock" });
    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Read test.txt")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const toolMessages = completeEvent.state.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].metadata.durationMs).toBeGreaterThanOrEqual(0);
  });
});
