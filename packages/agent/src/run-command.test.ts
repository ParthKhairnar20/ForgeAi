import { describe, it, expect, afterEach } from "vitest";
import { createBuiltinTools } from "./tools";
import { PermissionEvaluator, ToolErrorCode, PermissionLevel } from "@forgeai/core";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const IS_WINDOWS = process.platform === "win32";

function makeCtx(workspaceRoot: string, overrides?: Partial<{ requestApproval: () => Promise<boolean>; cancellationToken: any }>) {
  return {
    workspaceRoot,
    platform: process.platform as any,
    requestApproval: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...overrides,
  };
}

function makeTools(policy = { rules: [], defaultLevel: "safe" as PermissionLevel }) {
  const evaluator = new PermissionEvaluator(policy, process.platform as any);
  return new Map(createBuiltinTools(evaluator).map((t) => [t.name, t]));
}

describe("run_command hardening (v0.3.1)", () => {
  let tmpDir: string;
  let tools: Map<string, any>;

  afterEach(async () => {
    delete process.env.FORGEAI_COMMAND_TIMEOUT_MS;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("successful command returns structured result with exitCode 0", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "console.log('hello-forgeai')"` }, makeCtx(tmpDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello-forgeai");
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("command with separate args array works", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: "node", args: ["--version"] }, makeCtx(tmpDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain("--- stdout ---");
    expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("command not found returns COMMAND_NOT_FOUND", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: "definitely-not-a-real-command-xyz-12345" }, makeCtx(tmpDir));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.COMMAND_NOT_FOUND);
    expect(result.error?.recoverable).toBe(true);
  });

  it("non-zero exit code returns COMMAND_FAILED with exitCode metadata", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "process.exit(3)"` }, makeCtx(tmpDir));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.COMMAND_FAILED);
    expect(result.error?.message).toContain("code 3");
    expect(result.metadata?.exitCode).toBe(3);
    expect(result.error?.recoverable).toBe(true);
  });

  it("captures stdout", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "console.log('STDOUT_MARKER')"` }, makeCtx(tmpDir));

    expect(result.success).toBe(true);
    expect(result.output).toContain("--- stdout ---");
    expect(result.output).toContain("STDOUT_MARKER");
    expect(result.metadata?.stdout).toContain("STDOUT_MARKER");
  });

  it("captures stderr without failing when exit code is 0", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "console.error('STDERR_MARKER')"` }, makeCtx(tmpDir));

    // stderr alone does not fail the command if exit code is 0
    expect(result.success).toBe(true);
    expect(result.output).toContain("--- stderr ---");
    expect(result.output).toContain("STDERR_MARKER");
    expect(result.metadata?.stderr).toContain("STDERR_MARKER");
  });

  it("captures stdout and stderr together in distinct sections", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler(
      { command: `node -e "console.log('OUT'); console.error('ERR')"` },
      makeCtx(tmpDir)
    );

    expect(result.success).toBe(true);
    const outIdx = result.output.indexOf("OUT");
    const errIdx = result.output.indexOf("ERR");
    const stdoutHeader = result.output.indexOf("--- stdout ---");
    const stderrHeader = result.output.indexOf("--- stderr ---");
    expect(stdoutHeader).toBeGreaterThanOrEqual(0);
    expect(stderrHeader).toBeGreaterThan(stdoutHeader);
    expect(outIdx).toBeGreaterThan(stdoutHeader);
    expect(errIdx).toBeGreaterThan(stderrHeader);
  });

  it("timeout returns TIMEOUT error code", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;
    process.env.FORGEAI_COMMAND_TIMEOUT_MS = "400";

    const result = await tool.handler(
      { command: `node -e "setTimeout(function(){}, 10000)"` },
      makeCtx(tmpDir)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.TIMEOUT);
    expect(result.error?.message).toContain("timed out");
    expect(result.metadata?.timedOut).toBe(true);
    expect(result.error?.recoverable).toBe(true);
  });

  it("cancellation returns CANCELLED (not COMMAND_FAILED or UNKNOWN_ERROR)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    // Token records callbacks registered by the handler, then fires them mid-run
    const cbs: (() => void)[] = [];
    const realToken = {
      cancelled: false,
      onCancelled(cb: () => void) { cbs.push(cb); },
    };

    setTimeout(() => {
      realToken.cancelled = true;
      cbs.forEach((cb) => cb());
    }, 300);

    const result = await tool.handler(
      { command: `node -e "setTimeout(function(){}, 8000)"` },
      makeCtx(tmpDir, { cancellationToken: realToken })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.CANCELLED);
    expect(result.error?.code).not.toBe(ToolErrorCode.COMMAND_FAILED);
    expect(result.error?.code).not.toBe(ToolErrorCode.UNKNOWN_ERROR);
    expect(result.metadata?.cancelled).toBe(true);
  });

  it("blocks destructive commands including newly added patterns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    for (const cmd of ["rm -rf /tmp/x", "format C:", "shutdown /s", "restart now", "diskpart", "rd /s C:\\x"]) {
      const result = await tool.handler({ command: cmd }, makeCtx(tmpDir));
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ToolErrorCode.COMMAND_NOT_ALLOWED);
      expect(result.error?.recoverable).toBe(false);
    }
  });

  it("permission denied returns PERMISSION_DENIED when approval rejected", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    const policy = { rules: [], defaultLevel: "approval" as PermissionLevel };
    const evaluator = new PermissionEvaluator(policy, process.platform as any);
    const localTools = new Map(createBuiltinTools(evaluator).map((t) => [t.name, t]));
    const tool = localTools.get("run_command")!;

    const result = await tool.handler(
      { command: `node -e "console.log('x')"` },
      makeCtx(tmpDir, { requestApproval: async () => false })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PERMISSION_DENIED);
    expect(result.error?.recoverable).toBe(false);
  });

  it("output exceeding limit is truncated with truncated metadata", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler(
      { command: `node -e "console.log('x'.repeat(200000))"` },
      makeCtx(tmpDir)
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.truncated).toBe(true);
    // Output must be bounded well below the generated 200KB
    expect((result.output as string).length).toBeLessThan(150 * 1024);
  });

  it("structured metadata includes durationMs and bytesRead", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "console.log('meta')"` }, makeCtx(tmpDir));

    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.bytesRead).toBeGreaterThan(0);
    expect(typeof result.metadata?.exitCode).toBe("number");
  });

  it("error messages do not contain stack traces or internal paths", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: `node -e "process.exit(1)"` }, makeCtx(tmpDir));

    expect(result.error?.message).not.toContain("at ");
    expect(result.error?.message).not.toContain("node_modules");
    expect(JSON.stringify(result)).not.toContain(".ts:");
  });

  it.runIf(IS_WINDOWS)("Windows path: PowerShell built-in dir works", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-win-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: "Get-ChildItem" }, makeCtx(tmpDir));
    expect(result.success).toBe(true);
  });

  it.skipIf(IS_WINDOWS)("Unix path: ls works", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-cmd-unix-"));
    tools = makeTools();
    const tool = tools.get("run_command")!;

    const result = await tool.handler({ command: "ls -la" }, makeCtx(tmpDir));
    expect(result.success).toBe(true);
    expect(result.output).toContain("total");
  });
});