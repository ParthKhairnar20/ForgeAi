import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "./tools";
import { PermissionEvaluator, ToolErrorCode } from "@forgeai/core";
import { PermissionLevel } from "@forgeai/core";
import * as path from "path";
import * as fs from "fs/promises";

describe("createBuiltinTools", () => {
  it("should return 7 builtin tools", () => {
    const policy = { rules: [], defaultLevel: "safe" as PermissionLevel };
    const evaluator = new PermissionEvaluator(policy, "win32");
    const tools = createBuiltinTools(evaluator);
    expect(tools).toHaveLength(7);
  });

  it("should include expected tool names", () => {
    const policy = { rules: [], defaultLevel: "safe" as PermissionLevel };
    const evaluator = new PermissionEvaluator(policy, "win32");
    const tools = createBuiltinTools(evaluator);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "read_file",
      "write_file",
      "list_files",
      "search_files",
      "run_command",
      "git_status",
      "git_diff",
    ]);
  });
});

describe("tool security", () => {
  const policy = { rules: [], defaultLevel: "approval" as PermissionLevel };
  const evaluator = new PermissionEvaluator(policy, "win32");
  const tools = new Map(createBuiltinTools(evaluator).map((t) => [t.name, t]));

  const testCtx = {
    workspaceRoot: "C:\\tmp\\forgeai-test-workspace",
    platform: "win32" as any,
    requestApproval: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  it("read_file should reject path traversal outside workspace", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: "C:\\tmp\\outside\\file.txt" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
  });

  it("write_file should reject path traversal outside workspace", async () => {
    const tool = tools.get("write_file")!;
    const result = await tool.handler({ path: "C:\\tmp\\outside\\file.txt", content: "x" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
  });

  it("list_files should reject path traversal outside workspace", async () => {
    const tool = tools.get("list_files")!;
    const result = await tool.handler({ path: "C:\\tmp\\outside" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
  });

  it("search_files should reject path traversal outside workspace", async () => {
    const tool = tools.get("search_files")!;
    const result = await tool.handler({ path: "C:\\tmp\\outside", query: "x" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
  });

  it("run_command should block destructive rm -rf commands", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "rm -rf /tmp/test" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.COMMAND_NOT_ALLOWED);
  });

  it("run_command should block format command", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "format C:" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.COMMAND_NOT_ALLOWED);
  });

  it("run_command should support PowerShell built-in commands on Windows", async () => {
    const tool = tools.get("run_command")!;
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });

    const result = await tool.handler({ command: "pwd" }, testCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("forgeai-test-workspace");
  });

  it("read_file should reject sensitive files like .env", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, ".env") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.SENSITIVE_FILE);
  });

  it("read_file should reject sensitive files like credentials.json", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "credentials.json") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.SENSITIVE_FILE);
  });

  it("read_file should reject sensitive files like *.key", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "secret.json") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.SENSITIVE_FILE);
  });

  it("list_files should hide sensitive files from directory listing", async () => {
    const tool = tools.get("list_files")!;
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(testCtx.workspaceRoot, ".env"), "SECRET=abc");
    await fs.writeFile(path.join(testCtx.workspaceRoot, "app.ts"), "export const x = 1;");

    const result = await tool.handler({ path: testCtx.workspaceRoot }, testCtx);
    expect(result.success).toBe(true);
    const listed = JSON.parse(result.output as string) as string[];
    expect(listed).toContain("app.ts");
    expect(listed).not.toContain(".env");
  });

  it("search_files should skip sensitive files", async () => {
    const tool = tools.get("search_files")!;
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(testCtx.workspaceRoot, "credentials.json"), '{"apiKey": "LEAKED"}');

    const result = await tool.handler({ path: testCtx.workspaceRoot, query: "LEAKED" }, testCtx);
    expect(result.success).toBe(true);
    const matches = JSON.parse(result.output as string) as any[];
    expect(matches).toHaveLength(0);
  });
});

describe("structured tool results", () => {
  const policy = { rules: [], defaultLevel: "safe" as PermissionLevel };
  const evaluator = new PermissionEvaluator(policy, "win32");
  const tools = new Map(createBuiltinTools(evaluator).map((t) => [t.name, t]));

  const testCtx = {
    workspaceRoot: "C:\\tmp\\forgeai-structured-test",
    platform: "win32" as any,
    requestApproval: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  it("successful read_file returns structured result with output and metadata", async () => {
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(testCtx.workspaceRoot, "test.txt"), "hello world");

    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "test.txt") }, testCtx);

    expect(result.success).toBe(true);
    expect(result.output).toBe("hello world");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.bytesRead).toBe(11);
    expect(result.error).toBeUndefined();
  });

  it("failed read_file returns structured error with code, message, recoverable", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "nonexistent.txt") }, testCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(result.error?.message).toContain("File not found");
    expect(result.error?.recoverable).toBe(true);
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("successful write_file returns structured result with bytesWritten", async () => {
    const tool = tools.get("write_file")!;
    const result = await tool.handler({
      path: path.join(testCtx.workspaceRoot, "new.txt"),
      content: "test content",
    }, testCtx);

    expect(result.success).toBe(true);
    expect(result.output).toBe("File written successfully.");
    expect(result.metadata?.bytesWritten).toBe(12);
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("failed write_file returns structured error", async () => {
    const tool = tools.get("write_file")!;
    const result = await tool.handler({
      path: "C:\\tmp\\outside\\file.txt",
      content: "x",
    }, testCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
    expect(result.error?.recoverable).toBe(false);
  });

  it("successful list_files returns structured result", async () => {
    const tool = tools.get("list_files")!;
    const result = await tool.handler({ path: testCtx.workspaceRoot }, testCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("test.txt");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("failed list_files returns structured error", async () => {
    const tool = tools.get("list_files")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "nonexistent-dir") }, testCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.DIRECTORY_NOT_FOUND);
    expect(result.error?.recoverable).toBe(true);
  });

  it("successful search_files returns structured result", async () => {
    const tool = tools.get("search_files")!;
    const result = await tool.handler({ path: testCtx.workspaceRoot, query: "hello" }, testCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("test.txt");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("failed search_files returns structured error", async () => {
    const tool = tools.get("search_files")!;
    const result = await tool.handler({ path: "C:\\tmp\\outside", query: "x" }, testCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.PATH_OUTSIDE_WORKSPACE);
  });

  it("successful run_command returns structured result with exitCode", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "pwd" }, testCtx);

    expect(result.success).toBe(true);
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("failed run_command returns structured error", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "rm -rf /tmp/test" }, testCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.COMMAND_NOT_ALLOWED);
    expect(result.error?.recoverable).toBe(false);
  });

  it("successful git_status returns structured result", async () => {
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init"], { cwd: testCtx.workspaceRoot });

    const tool = tools.get("git_status")!;
    const result = await tool.handler({}, testCtx);

    expect(result.success).toBe(true);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("failed git_status returns structured error", async () => {
    const tool = tools.get("git_status")!;
    const result = await tool.handler({}, {
      ...testCtx,
      workspaceRoot: "C:\\tmp\\nonexistent-git-repo",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.GIT_FAILED);
    expect(result.error?.recoverable).toBe(true);
  });

  it("successful git_diff returns structured result", async () => {
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init"], { cwd: testCtx.workspaceRoot });

    const tool = tools.get("git_diff")!;
    const result = await tool.handler({}, testCtx);

    expect(result.success).toBe(true);
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("failed git_diff returns structured error", async () => {
    const tool = tools.get("git_diff")!;
    const result = await tool.handler({}, {
      ...testCtx,
      workspaceRoot: "C:\\tmp\\nonexistent-git-repo",
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ToolErrorCode.GIT_FAILED);
    expect(result.error?.recoverable).toBe(true);
  });
});