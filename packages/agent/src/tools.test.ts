import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "./tools";
import { PermissionEvaluator } from "@forgeai/core";
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
    await expect(tool.handler({ path: "C:\\tmp\\outside\\file.txt" }, testCtx)).rejects.toThrow("Access denied");
  });

  it("write_file should reject path traversal outside workspace", async () => {
    const tool = tools.get("write_file")!;
    await expect(tool.handler({ path: "C:\\tmp\\outside\\file.txt", content: "x" }, testCtx)).rejects.toThrow("Access denied");
  });

  it("list_files should reject path traversal outside workspace", async () => {
    const tool = tools.get("list_files")!;
    await expect(tool.handler({ path: "C:\\tmp\\outside" }, testCtx)).rejects.toThrow("Access denied");
  });

  it("search_files should reject path traversal outside workspace", async () => {
    const tool = tools.get("search_files")!;
    await expect(tool.handler({ path: "C:\\tmp\\outside", query: "x" }, testCtx)).rejects.toThrow("Access denied");
  });

  it("run_command should block destructive rm -rf commands", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "rm -rf /tmp/test" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
  });

  it("run_command should block format command", async () => {
    const tool = tools.get("run_command")!;
    const result = await tool.handler({ command: "format C:" }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
  });

  it("read_file should reject sensitive files like .env", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, ".env") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("sensitive");
  });

  it("read_file should reject sensitive files like credentials.json", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "credentials.json") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("sensitive");
  });

  it("read_file should reject sensitive files like *.key", async () => {
    const tool = tools.get("read_file")!;
    const result = await tool.handler({ path: path.join(testCtx.workspaceRoot, "secret.json") }, testCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("sensitive");
  });

  it("list_files should hide sensitive files from directory listing", async () => {
    const tool = tools.get("list_files")!;
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(testCtx.workspaceRoot, ".env"), "SECRET=abc");
    await fs.writeFile(path.join(testCtx.workspaceRoot, "app.ts"), "export const x = 1;");

    const result = await tool.handler({ path: testCtx.workspaceRoot }, testCtx);
    expect(result.success).toBe(true);
    const listed = JSON.parse(result.output) as string[];
    expect(listed).toContain("app.ts");
    expect(listed).not.toContain(".env");
  });

  it("search_files should skip sensitive files", async () => {
    const tool = tools.get("search_files")!;
    await fs.mkdir(testCtx.workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(testCtx.workspaceRoot, "credentials.json"), '{"apiKey": "LEAKED"}');

    const result = await tool.handler({ path: testCtx.workspaceRoot, query: "LEAKED" }, testCtx);
    expect(result.success).toBe(true);
    const matches = JSON.parse(result.output) as any[];
    expect(matches).toHaveLength(0);
  });
});
