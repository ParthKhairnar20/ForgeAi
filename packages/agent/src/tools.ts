import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";

import {
  CommandCategory,
  PermissionEvaluator,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@forgeai/core";

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 1_000_000;
const DESTRUCTIVE_PATTERNS = [/^rm\s+-rf\s/, /^del\s+\/f\s/, /^rmdir\s+\/s\s/, /^format\s/, /^mkfs\s/, /^shutdown\s/, /^:\(\)\{.*\|\:.*\&\}\;/];
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".vscode", "build", "tmp", "temp"]);
const BINARY_EXTENSIONS = new Set([
  ".bin", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib", ".pyc", ".class",
  ".jar", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".png", ".jpg", ".jpeg",
  ".gif", ".ico", ".pdf", ".pem", ".key", ".p12", ".pfx", ".mp3", ".mp4", ".avi",
  ".mov", ".wmv", ".flv", ".mkv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"
]);
const SENSITIVE_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /.*\.pem$/,
  /.*\.key$/,
  /^credentials\.json$/,
  /^credentials\..+$/,
  /^secrets\..+$/,
  /^secret\..+$/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^id_ecdsa$/,
  /^id_dsa$/,
  /.*\.p12$/,
  /.*\.pfx$/,
];

async function validateWorkspacePath(workspaceRoot: string, userPath: string): Promise<string> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, userPath);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(`Access denied: path "${userPath}" resolves outside the workspace.`);
  }

  let current = resolved;
  while (current !== resolvedRoot && current !== path.resolve(current, "..")) {
    try {
      const link = await fs.readlink(current);
      if (link) {
        const resolvedLink = path.isAbsolute(link) ? link : path.resolve(path.dirname(current), link);
        if (!resolvedLink.startsWith(resolvedRoot + path.sep) && resolvedLink !== resolvedRoot) {
          throw new Error(`Access denied: path "${userPath}" contains a symlink that resolves outside the workspace.`);
        }
      }
    } catch (error) {
      if ((error as Error).message.startsWith("Access denied:")) {
        throw error;
      }
      // Not a symlink or an unreadable path segment.
    }
    current = path.resolve(current, "..");
  }

  return resolved;
}

function isBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

async function getGitignorePatterns(workspaceRoot: string): Promise<Set<string>> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    return new Set(content.split("\n").filter((l) => l.trim() && !l.startsWith("#")));
  } catch {
    return new Set();
  }
}

function shouldIgnore(relativePath: string, patterns: Set<string>): boolean {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (patterns.has(part)) return true;
  }
  return false;
}

function isSensitiveFile(fileName: string): boolean {
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(fileName)) return true;
  }
  return false;
}

async function findRipgrep(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("where", ["rg"], { windowsHide: true });
    if (stdout.trim()) return "rg";
  } catch {
    // not found on Windows
  }
  try {
    const { stdout } = await execFileAsync("which", ["rg"], { windowsHide: true });
    if (stdout.trim()) return "rg";
  } catch {
    // not found on Unix
  }
  return null;
}

async function withPermission(
  evaluator: PermissionEvaluator,
  category: CommandCategory,
  pattern: string,
  action: () => Promise<string>,
  ctx: ToolContext
): Promise<{ result: string; durationMs: number }> {
  const start = Date.now();
  if (evaluator.isBlocked(category, pattern)) {
    throw new Error(`Permission denied: ${category} operation "${pattern}" is blocked by policy.`);
  }
  if (evaluator.requiresApproval(category, pattern)) {
    const approved = await ctx.requestApproval(`ForgeAI wants to execute ${category}: ${pattern}`);
    if (!approved) {
      throw new Error(`Permission denied: ${category} operation "${pattern}" was not approved.`);
    }
  }
  const result = await action();
  return { result, durationMs: Date.now() - start };
}

export function createBuiltinTools(evaluator: PermissionEvaluator): ToolDefinition[] {
  const readFileTool: ToolDefinition = {
    name: "read_file",
    description: "Read the contents of a file at the given absolute path.",
    category: "file_read",
    permissionLevel: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const userPath = String(args.path);
      const filePath = await validateWorkspacePath(ctx.workspaceRoot, userPath);

      if (isBinary(filePath)) {
        return { id: randomUUID(), toolCallId: "", name: "read_file", success: false, output: "", error: "Cannot read binary files.", durationMs: 0 };
      }

      if (isSensitiveFile(path.basename(filePath))) {
        return { id: randomUUID(), toolCallId: "", name: "read_file", success: false, output: "", error: "Cannot read sensitive files (credentials, keys, .env).", durationMs: 0 };
      }

      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        return { id: randomUUID(), toolCallId: "", name: "read_file", success: false, output: "", error: `File exceeds maximum size of ${MAX_FILE_SIZE} bytes.`, durationMs: 0 };
      }

      const { result: output, durationMs } = await withPermission(evaluator, "file_read", userPath, async () => fs.readFile(filePath, "utf-8"), ctx);
      return { id: randomUUID(), toolCallId: "", name: "read_file", success: true, output, durationMs };
    },
  };

  const writeFileTool: ToolDefinition = {
    name: "write_file",
    description: "Write content to a file at the given absolute path. Creates the file if it does not exist.",
    category: "file_write",
    permissionLevel: "approval",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    handler: async (args, ctx) => {
      const userPath = String(args.path);
      const content = String(args.content);
      const filePath = await validateWorkspacePath(ctx.workspaceRoot, userPath);

      const { result, durationMs } = await withPermission(evaluator, "file_write", userPath, async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return "ok";
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "write_file", success: true, output: "File written successfully.", durationMs };
    },
  };

  const listFilesTool: ToolDefinition = {
    name: "list_files",
    description: "List files and directories under the given absolute path.",
    category: "file_read",
    permissionLevel: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory path" },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const userPath = String(args.path);
      const dirPath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      const gitignorePatterns = await getGitignorePatterns(ctx.workspaceRoot);

      const { result: output, durationMs } = await withPermission(evaluator, "file_read", userPath, async () => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const matched = entries
          .filter((e) => !shouldIgnore(e.name, gitignorePatterns) && !isSensitiveFile(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return JSON.stringify(matched, null, 2);
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "list_files", success: true, output, durationMs };
    },
  };

  const searchFilesTool: ToolDefinition = {
    name: "search_files",
    description: "Search for text within files under a given directory. Uses ripgrep if available, otherwise falls back to filesystem scan.",
    category: "search",
    permissionLevel: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory path to search in" },
        query: { type: "string", description: "Search query" },
      },
      required: ["path", "query"],
    },
    handler: async (args, ctx) => {
      const userPath = String(args.path);
      const query = String(args.query);
      const searchPath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      const rg = await findRipgrep();
      const gitignorePatterns = await getGitignorePatterns(ctx.workspaceRoot);

      const { result: output, durationMs } = await withPermission(evaluator, "search", userPath, async () => {
        if (rg) {
          try {
            const { stdout } = await execFileAsync("rg", ["--no-heading", "--line-number", query, searchPath], {
              cwd: ctx.workspaceRoot,
              maxBuffer: 1024 * 1024 * 10,
              windowsHide: true,
            });
            const results: { file: string; line: number; content: string }[] = [];
            for (const line of stdout.split("\n")) {
              if (!line.trim()) continue;
              const match = line.match(/^(.+?):(\d+):(.*)$/);
              if (!match) continue;
              const file = match[1];
              const relative = path.relative(ctx.workspaceRoot, file);
              if (isSensitiveFile(path.basename(file)) || shouldIgnore(relative, gitignorePatterns)) continue;
              results.push({ file, line: parseInt(match[2], 10), content: match[3] });
            }
            return JSON.stringify(results, null, 2);
          } catch (error: any) {
            if (error.code === 1) return JSON.stringify([], null, 2);
            throw error;
          }
        }

        const results: { file: string; line: number; content: string }[] = [];
        const files = await getAllFiles(searchPath, gitignorePatterns);
        for (const file of files) {
          const relative = path.relative(ctx.workspaceRoot, file);
          if (shouldIgnore(relative, gitignorePatterns)) continue;
          if (isBinary(file)) continue;
          if (isSensitiveFile(path.basename(file))) continue;
          const stat = await fs.stat(file);
          if (stat.size > MAX_FILE_SIZE) continue;

          const content = await fs.readFile(file, "utf-8").catch(() => null);
          if (!content) continue;
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            if (line.includes(query)) {
              results.push({ file: relative, line: idx + 1, content: line.trim() });
            }
          });
        }
        return JSON.stringify(results, null, 2);
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "search_files", success: true, output, durationMs };
    },
  };

  const runCommandTool: ToolDefinition = {
    name: "run_command",
    description: "Execute a shell command in the workspace directory. Use with caution.",
    category: "shell",
    permissionLevel: "approval",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        args: { type: "array", items: { type: "string" }, description: "Command arguments" },
      },
      required: ["command"],
    },
    handler: async (args, ctx) => {
      const command = String(args.command);
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];

      for (const pattern of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(command.trim())) {
          return { id: randomUUID(), toolCallId: "", name: "run_command", success: false, output: "", error: `Destructive command blocked by policy: ${command}`, durationMs: 0 };
        }
      }

      const { result: output, durationMs } = await withPermission(evaluator, "shell", command, async () => {
        if (ctx.platform === "win32") {
          const executable = "powershell.exe";
          const executableArgs = [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `& ${toPowerShellLiteral(command)} ${cmdArgs.map(toPowerShellLiteral).join(" ")}`,
          ];
          const { stdout } = await execFileAsync(executable, executableArgs, {
            cwd: ctx.workspaceRoot,
            maxBuffer: 1024 * 1024 * 10,
            timeout: 30000,
            windowsHide: true,
          });
          return stdout;
        }

        // On Unix-like platforms, split the command into executable + args
        const parts = command.trim().split(/\s+/);
        const executable = parts[0];
        const unixArgs = [...parts.slice(1), ...cmdArgs];
        const { stdout } = await execFileAsync(executable, unixArgs, {
          cwd: ctx.workspaceRoot,
          maxBuffer: 1024 * 1024 * 10,
          timeout: 30000,
          windowsHide: true,
        });
        return stdout;
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "run_command", success: true, output, durationMs };
    },
  };

  const gitStatusTool: ToolDefinition = {
    name: "git_status",
    description: "Show the working tree status of the repository.",
    category: "git",
    permissionLevel: "safe",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) => {
      const { result: output, durationMs } = await withPermission(evaluator, "git", "git status", async () => {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
          cwd: ctx.workspaceRoot,
        });
        return stdout || "Working tree clean.";
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "git_status", success: true, output, durationMs };
    },
  };

  const gitDiffTool: ToolDefinition = {
    name: "git_diff",
    description: "Show the diff for changes in the working tree.",
    category: "git",
    permissionLevel: "safe",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async (_args, ctx) => {
      const { result: output, durationMs } = await withPermission(evaluator, "git", "git diff", async () => {
        const { stdout } = await execFileAsync("git", ["diff"], {
          cwd: ctx.workspaceRoot,
        });
        return stdout || "No changes.";
      }, ctx);
      return { id: randomUUID(), toolCallId: "", name: "git_diff", success: true, output, durationMs };
    },
  };

  async function getAllFiles(dir: string, gitignorePatterns: Set<string>): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (shouldIgnore(entry.name, gitignorePatterns)) continue;
      if (isSensitiveFile(entry.name)) continue;
      if (entry.isDirectory()) {
        files.push(...(await getAllFiles(fullPath, gitignorePatterns)));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  function toPowerShellLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  return [readFileTool, writeFileTool, listFilesTool, searchFilesTool, runCommandTool, gitStatusTool, gitDiffTool];
}
