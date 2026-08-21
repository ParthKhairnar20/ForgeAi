import { describe, it, expect } from "vitest";
import { AgentLoop } from "./agent-loop.js";
import { MockProvider, MockResponse } from "./providers/mock.js";
import { createNoopLogger, ForgeAIConfig, PermissionLevel } from "@forgeai/core";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("ForgeAI small task test", () => {
  it("should find and fix a bug in calc.ts using read_file + write_file + verify", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-small-task-"));
    await fs.writeFile(path.join(tmpDir, "calc.ts"), "export function add(a: number, b: number) { return a - b; }");

    const config: ForgeAIConfig = {
      provider: { type: "mock", model: "mock" },
      workspaceRoot: tmpDir,
      permissionPolicy: {
        rules: [],
        defaultLevel: "approval" as PermissionLevel,
      },
      maxIterations: 5,
      contextWindowLimit: 100000,
    };

    const responses: MockResponse[] = [
      {
        content: "Let me read the calc.ts file to understand the bug.",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: path.join(tmpDir, "calc.ts") } }],
      },
      {
        content: "I found the bug. The add function subtracts instead of adding. Let me fix it.",
        toolCalls: [{ id: "call_2", name: "write_file", arguments: { path: path.join(tmpDir, "calc.ts"), content: "export function add(a: number, b: number) { return a + b; }" } }],
      },
      { content: "Bug fixed! The add function now correctly adds numbers.", toolCalls: [] },
    ];

    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    const events: any[] = [];
    for await (const event of loop.run("Find and fix the bug in calc.ts")) {
      events.push(event);
    }

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.state.status).toBe("completed");

    // Verify the tool steps were executed
    const toolMessages = completeEvent.state.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);

    // Verify the file was actually fixed
    const finalContent = await fs.readFile(path.join(tmpDir, "calc.ts"), "utf-8");
    expect(finalContent).toContain("return a + b;");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});