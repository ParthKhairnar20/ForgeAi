import { describe, it, expect, afterEach } from "vitest";
import { createBuiltinTools } from "./tools";
import { AgentLoop } from "./agent-loop.js";
import { MockProvider, MockResponse } from "./providers/mock.js";
import { createNoopLogger, ForgeAIConfig, PermissionEvaluator, ToolErrorCode, PermissionLevel } from "@forgeai/core";
import { paginationStore, chunkText } from "./pagination";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const READ_PAGE_MAX = 64 * 1024;

function makeCtx(workspaceRoot: string) {
  return {
    workspaceRoot,
    platform: process.platform as any,
    requestApproval: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

function makeTools(policy = { rules: [], defaultLevel: "safe" as PermissionLevel }) {
  const evaluator = new PermissionEvaluator(policy, process.platform as any);
  return new Map(createBuiltinTools(evaluator).map((t) => [t.name, t]));
}

let tmpDir: string;
let tools: Map<string, any>;

describe("pagination store", () => {
  it("small output fits in one page (no cursor)", () => {
    const pages = chunkText("hello world", 16 * 1024);
    expect(pages).toHaveLength(1);
  });

  it("large output produces multiple deterministic pages", () => {
    const text = "a".repeat(50_000);
    const pages = chunkText(text, 16 * 1024);
    expect(pages.length).toBeGreaterThan(1);
    const again = chunkText(text, 16 * 1024);
    expect(again.map((p) => p.length)).toEqual(pages.map((p) => p.length));
    expect(pages.join("").length).toBe(text.length);
  });

  it("cursor is single-use; reuse is rejected", () => {
    const cursor = paginationStore.store(["page2", "page3"], "run_command");
    const first = paginationStore.fetch(cursor, "run_command");
    expect(first).not.toBeNull();
    expect(first!.content).toBe("page2");
    expect(first!.hasMore).toBe(true);
    expect(first!.nextCursor).toBeDefined();

    const replay = paginationStore.fetch(cursor, "run_command");
    expect(replay).toBeNull();
  });

  it("cursor cannot be reused across different tools", () => {
    const cursor = paginationStore.store(["secret-page"], "run_command");
    // Presenting a run_command cursor to list_files must fail
    const crossTool = paginationStore.fetch(cursor, "list_files");
    expect(crossTool).toBeNull();
    // The original owner can still consume it
    const owner = paginationStore.fetch(cursor, "run_command");
    expect(owner).not.toBeNull();
  });

  it("final page reports hasMore=false and no nextCursor", () => {
    const c1 = paginationStore.store(["p2", "p3"], "git_diff");
    const r1 = paginationStore.fetch(c1, "git_diff")!;
    expect(r1.hasMore).toBe(true);

    const r2 = paginationStore.fetch(r1.nextCursor!, "git_diff")!;
    expect(r2.content).toBe("p3");
    expect(r2.hasMore).toBe(false);
    expect(r2.nextCursor).toBeUndefined();
  });
});

describe("tool output pagination (v0.3.2)", () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("invalid cursor is rejected with structured error and no leaks", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: "node --version", cursor: "not-a-real-cursor" }, makeCtx(tmpDir));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.INVALID_CURSOR);
    expect(result.error?.message).not.toMatch(/at |node_modules|\.ts:/);
  });

  it("run_command: large stdout paginates with correct continuation", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler(
      { command: 'node -e "for(let i=0;i<2000;i++)console.log(\'LINE-\'+i)"' },
      makeCtx(tmpDir)
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("LINE-0");
    expect(result.metadata?.pagination?.hasMore).toBe(true);
    const cursor = result.metadata?.pagination?.nextCursor;
    expect(typeof cursor).toBe("string");

    // Drain all pages; verify full content round-trip
    let combined = result.output as string;
    let nextCursor: string | undefined = cursor;
    let guard = 0;
    while (nextCursor && guard < 10) {
      const next = await tool.handler({ command: "", cursor: nextCursor }, makeCtx(tmpDir));
      expect(next.success).toBe(true);
      combined += "\n" + (next.output as string);
      nextCursor = next.metadata?.pagination?.nextCursor;
      guard++;
    }
    expect(combined).toContain("LINE-1999");
  });

  it("read_file: small file fits in one page (backward compatible)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("read_file")!;

    await fs.writeFile(path.join(tmpDir, "small.txt"), "line1\nline2\nline3");
    const result = await tool.handler({ path: path.join(tmpDir, "small.txt") }, makeCtx(tmpDir));

    expect(result.success).toBe(true);
    expect(result.output).toBe("line1\nline2\nline3");
    expect(result.metadata?.pagination).toBeUndefined();
  });

  it("read_file: large file paginates incrementally without data loss", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("read_file")!;

    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`ROW-${i}-${"x".repeat(30)}`);
    const filePath = path.join(tmpDir, "big.txt");
    await fs.writeFile(filePath, lines.join("\n"));

    const page1 = await tool.handler({ path: filePath }, makeCtx(tmpDir));
    expect(page1.success).toBe(true);
    expect(page1.metadata?.pagination?.hasMore).toBe(true);
    expect((page1.output as string).length).toBeLessThanOrEqual(READ_PAGE_MAX + 1024);
    expect(page1.output).toContain("ROW-0-");

    let collected = page1.output as string;
    let nextCursor = page1.metadata?.pagination?.nextCursor;
    let guard = 0;
    while (nextCursor && guard < 20) {
      const next = await tool.handler({ path: filePath, cursor: nextCursor }, makeCtx(tmpDir));
      expect(next.success).toBe(true);
      collected += next.output as string;
      nextCursor = next.metadata?.pagination?.nextCursor;
      guard++;
    }
    expect(nextCursor).toBeUndefined();
    const original = await fs.readFile(filePath, "utf-8");
    expect(collected.replace(/\r/g, "")).toBe(original.replace(/\r/g, ""));
  });

  it("pagination cannot access sensitive files (.env stays blocked)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("read_file")!;

    const bigLines: string[] = [];
    for (let i = 0; i < 3000; i++) bigLines.push(`L-${i}-${"z".repeat(40)}`);
    await fs.writeFile(path.join(tmpDir, "big.txt"), bigLines.join("\n"));
    const page1 = await tool.handler({ path: path.join(tmpDir, "big.txt") }, makeCtx(tmpDir));
    const cursor = page1.metadata?.pagination?.nextCursor;
    expect(cursor).toBeDefined();

    // Continuation ignores user-supplied paths (stored validated path wins),
    // so a .env path can never be injected into an existing pagination.
    await fs.writeFile(path.join(tmpDir, ".env"), "SECRET=abc");
    const sneaky = await tool.handler({ path: path.join(tmpDir, ".env"), cursor }, makeCtx(tmpDir));
    expect(sneaky.success).toBe(true);
    expect(sneaky.output).not.toContain("SECRET");

    // Direct .env reads remain blocked
    const direct = await tool.handler({ path: path.join(tmpDir, ".env") }, makeCtx(tmpDir));
    expect(direct.success).toBe(false);
    expect(direct.error?.code).toBe(ToolErrorCode.SENSITIVE_FILE);
  });

  it("pagination cannot escape the workspace", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("read_file")!;

    const bigLines: string[] = [];
    for (let i = 0; i < 3000; i++) bigLines.push(`L-${i}-${"z".repeat(40)}`);
    await fs.writeFile(path.join(tmpDir, "big.txt"), bigLines.join("\n"));
    const page1 = await tool.handler({ path: path.join(tmpDir, "big.txt") }, makeCtx(tmpDir));
    const cursor = page1.metadata?.pagination?.nextCursor;
    expect(cursor).toBeDefined();

    // Attempt to redirect continuation outside workspace: stored path wins.
    const outside = path.join(path.dirname(tmpDir), "outside.txt");
    await fs.writeFile(outside, "OUTSIDE-DATA");
    const attempt = await tool.handler({ path: outside, cursor }, makeCtx(tmpDir));
    expect(attempt.success).toBe(true);
    expect(attempt.output).not.toContain("OUTSIDE-DATA");
    expect(attempt.output).toContain("L-");
    await fs.rm(outside, { force: true });
  });

  it("search_files: many matches paginate with filtering applied first", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("search_files")!;

    for (let i = 0; i < 120; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.txt`), `needle here ${i}\n`);
    }
    await fs.writeFile(path.join(tmpDir, ".env"), "needle SECRET");

    const page1 = await tool.handler({ path: tmpDir, query: "needle" }, makeCtx(tmpDir));
    expect(page1.success).toBe(true);
    const matches1 = JSON.parse(page1.output as string) as any[];
    expect(matches1.length).toBeLessThanOrEqual(50);
    expect(page1.metadata?.pagination?.hasMore).toBe(true);
    expect(JSON.stringify(matches1)).not.toContain(".env");

    let total = matches1.length;
    let nextCursor = page1.metadata?.pagination?.nextCursor;
    let guard = 0;
    while (nextCursor && guard < 10) {
      const next = await tool.handler({ path: tmpDir, query: "needle", cursor: nextCursor }, makeCtx(tmpDir));
      const matches = JSON.parse(next.output as string) as any[];
      total += matches.length;
      expect(JSON.stringify(matches)).not.toContain(".env");
      nextCursor = next.metadata?.pagination?.nextCursor;
      guard++;
    }
    expect(total).toBe(120);
  });

  it("list_files: large directory listing paginates", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("list_files")!;

    for (let i = 0; i < 250; i++) {
      await fs.writeFile(path.join(tmpDir, `item${i}.txt`), "x");
    }

    const page1 = await tool.handler({ path: tmpDir }, makeCtx(tmpDir));
    expect(page1.success).toBe(true);
    const listed1 = JSON.parse(page1.output as string) as string[];
    expect(listed1.length).toBeLessThanOrEqual(100);
    expect(page1.metadata?.pagination?.hasMore).toBe(true);

    let total = listed1.length;
    let nextCursor = page1.metadata?.pagination?.nextCursor;
    let guard = 0;
    while (nextCursor && guard < 5) {
      const next = await tool.handler({ path: tmpDir, cursor: nextCursor }, makeCtx(tmpDir));
      total += (JSON.parse(next.output as string) as string[]).length;
      nextCursor = next.metadata?.pagination?.nextCursor;
      guard++;
    }
    expect(total).toBe(250);
  });

  it("git_diff: large diff paginates deterministically", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-git-"));
    tools = makeTools();
    const tool = tools.get("git_diff")!;

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    await run("git", ["init"], { cwd: tmpDir });
    await run("git", ["config", "user.email", "t@t.local"], { cwd: tmpDir });
    await run("git", ["config", "user.name", "t"], { cwd: tmpDir });

    const bigContent = Array.from({ length: 1500 }, (_, i) => `orig line ${i}`).join("\n");
    await fs.writeFile(path.join(tmpDir, "huge.txt"), bigContent);
    await run("git", ["add", "."], { cwd: tmpDir });
    await run("git", ["commit", "-m", "init"], { cwd: tmpDir });

    const modified = Array.from({ length: 1500 }, (_, i) => `changed line ${i}`).join("\n");
    await fs.writeFile(path.join(tmpDir, "huge.txt"), modified);

    const page1 = await tool.handler({}, makeCtx(tmpDir));
    expect(page1.success).toBe(true);
    expect(page1.output).toContain("diff --git");
    expect(page1.metadata?.pagination?.hasMore).toBe(true);

    const page2 = await tool.handler({ cursor: page1.metadata?.pagination?.nextCursor }, makeCtx(tmpDir));
    expect(page2.success).toBe(true);
    expect(page2.output).toContain("changed line");
  });

  it("repeated identical cursors are safely rejected", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-"));
    tools = makeTools();
    const tool = tools.get("list_files")!;

    for (let i = 0; i < 150; i++) {
      await fs.writeFile(path.join(tmpDir, `x${i}.txt`), "x");
    }
    const page1 = await tool.handler({ path: tmpDir }, makeCtx(tmpDir));
    const cursor = page1.metadata?.pagination?.nextCursor!;

    const page2 = await tool.handler({ path: tmpDir, cursor }, makeCtx(tmpDir));
    expect(page2.success).toBe(true);

    const replay = await tool.handler({ path: tmpDir, cursor }, makeCtx(tmpDir));
    expect(replay.success).toBe(false);
    expect(replay.error?.code).toBe(ToolErrorCode.INVALID_CURSOR);
  });

  it("read_file: UTF-8, multibyte, CRLF, long lines, empty lines round-trip without corruption", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-utf-"));
    tools = makeTools();
    const tool = tools.get("read_file")!;

    // Build a >64KB file exercising every tricky case
    const NL = String.fromCharCode(10);
    const parts: string[] = [];
    parts.push("ascii line" + NL);
    parts.push("multibyte: héllo wörld 日本語テキスト 🚀🎉" + NL);
    parts.push(NL); // empty line
    parts.push("crlf line" + String.fromCharCode(13) + NL);
    parts.push("x".repeat(5000) + NL); // long line
    for (let i = 0; i < 2600; i++) {
      parts.push(`行-${i}-日本語-${"🎉".repeat(3)}` + NL); // multibyte-heavy lines
      if (i % 50 === 0) parts.push(NL); // sprinkle empty lines
    }
    const content = parts.join("");
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(READ_PAGE_MAX);
    const filePath = path.join(tmpDir, "utf8.txt");
    await fs.writeFile(filePath, content, "utf-8");

    // Walk all pages
    let collected = "";
    let nextCursor: string | undefined;
    let guard = 0;
    let first = true;
    while (guard < 30) {
      const result = first
        ? await tool.handler({ path: filePath }, makeCtx(tmpDir))
        : await tool.handler({ path: filePath, cursor: nextCursor }, makeCtx(tmpDir));
      expect(result.success).toBe(true);
      collected += result.output as string;
      nextCursor = result.metadata?.pagination?.nextCursor;
      first = false;
      guard++;
      if (!nextCursor) break;
    }
    expect(nextCursor).toBeUndefined();

    // Exact round-trip: no loss, no duplication, no corruption
    const original = await fs.readFile(filePath, "utf-8");
    expect(collected).toBe(original);
    // Multibyte characters intact
    expect(collected).toContain("日本語テキスト 🚀🎉");
    expect(collected).toContain("crlf line" + String.fromCharCode(13));
  });
});

describe("agent loop pagination scenario (audit 9)", () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("agent receives page 1, requests page 2 via cursor, and completes without exhausting maxIterations", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-pag-agent-"));

    // Generator script avoids shell-quoting complexity
    const genScript = path.join(tmpDir, "gen.js");
    await fs.writeFile(genScript, "for(let i=0;i<4000;i++)console.log('AG-'+i);" + String.fromCharCode(10));

    const config: ForgeAIConfig = {
      provider: { type: "mock", model: "mock" },
      workspaceRoot: tmpDir,
      permissionPolicy: { rules: [], defaultLevel: "safe" as PermissionLevel },
      maxIterations: 5,
      contextWindowLimit: 100000,
    };

    // Turn 2's tool-call arguments are computed lazily: when the MockProvider
    // spreads this response (during iteration 2), the page-1 tool message
    // already exists, so the cursor can be extracted from the hint.
    const responses: MockResponse[] = [
      {
        content: "Running a big command.",
        toolCalls: [{ id: "c1", name: "run_command", arguments: { command: `node "${genScript}"` } }],
      },
      {
        content: "Fetching the next page.",
        toolCalls: [{
          id: "c2",
          name: "run_command",
          get arguments() {
            const lastTool = [...(loop as any).state.messages].reverse().find((m: any) => m.role === "tool");
            const match = lastTool ? lastTool.content.match(/\{"cursor": "([^"]+)"\}/) : null;
            return { command: "", cursor: match ? match[1] : "" };
          },
        }],
      },
      { content: "I have enough output now. Task complete.", toolCalls: [] },
    ];

    const loop = new AgentLoop(config, createNoopLogger());
    (loop as any).provider = new MockProvider(responses, createNoopLogger());

    let finalState: any = null;
    let completedSteps = 0;
    for await (const event of loop.run("Run a big command and paginate")) {
      if (event.type === "step" && event.step.status === "completed") completedSteps++;
      if (event.type === "complete") finalState = event.state;
    }

    const toolMessages = finalState.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBe(2); // exactly page 1 + page 2, no extra fetches

    const page1 = toolMessages[0];
    const page2 = toolMessages[1];
    expect(page1.content).toContain("more output available"); // hint present
    expect(page1.content).toContain("AG-0");
    expect(page2.content).toContain("AG-");
    expect(page2.content).not.toBe(page1.content); // different page content

    // Agent completed successfully — maxIterations NOT exhausted
    expect(finalState.status).toBe("completed");
    expect(completedSteps).toBeLessThanOrEqual(6);
  });
});
