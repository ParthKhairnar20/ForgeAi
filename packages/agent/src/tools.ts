import * as fs from "fs/promises";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";

import {
  CommandCategory,
  PermissionEvaluator,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolErrorCode,
  ToolMetadata,
  ToolPagination,
  createSuccessResult,
  createErrorResult,
} from "@forgeai/core";
import { paginationStore, chunkText, PAGINATION_MAX_BUFFER_BYTES } from "./pagination.js";

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 1_000_000;
const DESTRUCTIVE_PATTERNS = [
  /^rm\s+-rf(\s|$)/, /^del\s+\/f(\s|$)/, /^rmdir(\s|$)/, /^rd\s+\/s(\s|$)/,
  /^format(\s|$)/, /^mkfs(\s|$)/, /^shutdown(\s|$)/, /^restart(\s|$)/, /^diskpart(\s|$)/,
  /^:\(\)\{.*\|\:.*\&\}\;/,
];
// v0.3.1: per-stream output limit for run_command (prevents unbounded context growth)
const COMMAND_OUTPUT_LIMIT_BYTES = 100 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
// v0.3.2: pagination page sizes (first response is always bounded)
const COMMAND_PAGE_SIZE_BYTES = 16 * 1024;
const READ_FILE_PAGE_LINES = 400;
const READ_FILE_PAGE_MAX_BYTES = 64 * 1024;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_RESULTS = 2000;
const LIST_FILES_PAGE_SIZE = 100;
const LIST_FILES_MAX_ENTRIES = 5000;

/** Timeout is configurable via FORGEAI_COMMAND_TIMEOUT_MS (ms) for testing/embedding. */
function getCommandTimeoutMs(): number {
  const value = Number(process.env.FORGEAI_COMMAND_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMMAND_TIMEOUT_MS;
}
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

async function withPermission<T>(
  evaluator: PermissionEvaluator,
  category: CommandCategory,
  pattern: string,
  action: () => Promise<T>,
  ctx: ToolContext
): Promise<{ result: T; durationMs: number }> {
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

/** Extracts an optional pagination cursor from tool arguments. */
function getCursorArg(args: Record<string, unknown>): string | undefined {
  const value = args.cursor;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Builds a structured error for invalid/expired/consumed cursors. */
function cursorError(name: string, toolCallId: string): ToolResult {
  return createErrorResult(
    name,
    toolCallId,
    ToolErrorCode.INVALID_CURSOR,
    "Invalid, expired, or already-used pagination cursor. Re-run the tool without a cursor to start over.",
    false
  );
}

/**
 * Builds a success result whose output is bounded to one page.
 * When the text spans multiple pages, pages 2..N are buffered in the
 * pagination store behind an opaque single-use cursor.
 * Security note: `fullText` must already be security-filtered — pagination
 * never bypasses filtering because it only slices pre-filtered content.
 */
function buildPaginatedResult(
  name: string,
  toolCallId: string,
  fullText: string,
  pageSizeBytes: number,
  metadata: ToolMetadata
): ToolResult {
  const pages = chunkText(fullText, pageSizeBytes);
  const firstPage = pages[0] ?? "";

  if (pages.length <= 1) {
    return createSuccessResult(name, toolCallId, firstPage, metadata);
  }

  const nextCursor = paginationStore.store(pages.slice(1), name);
  const pagination: ToolPagination = {
    page: 1,
    pageSize: Buffer.byteLength(firstPage, "utf-8"),
    hasMore: true,
    nextCursor,
    totalBytes: Buffer.byteLength(fullText, "utf-8"),
  };
  return createSuccessResult(name, toolCallId, firstPage, { ...metadata, pagination });
}

// ---------------------------------------------------------------------------
// v0.3.2: incremental file reading (bounded memory; never loads whole file)
// ---------------------------------------------------------------------------

interface FilePageState {
  filePath: string;
  offset: number;
}
const FILE_PAGE_MAX_ENTRIES = 50;
const FILE_PAGE_TTL_MS = 15 * 60 * 1000;
const filePageStates = new Map<string, { state: FilePageState; createdAt: number }>();

function storeFilePageState(state: FilePageState): string {
  // Evict expired / enforce bound
  const now = Date.now();
  for (const [key, entry] of filePageStates) {
    if (now - entry.createdAt > FILE_PAGE_TTL_MS) filePageStates.delete(key);
  }
  while (filePageStates.size >= FILE_PAGE_MAX_ENTRIES) {
    const oldest = filePageStates.keys().next().value;
    if (oldest === undefined) break;
    filePageStates.delete(oldest);
  }
  const cursor = randomUUID();
  filePageStates.set(cursor, { state, createdAt: now });
  return cursor;
}

function takeFilePageState(cursor: string): FilePageState | null {
  const entry = filePageStates.get(cursor);
  if (!entry) return null;
  filePageStates.delete(cursor); // single-use
  return entry.state;
}

interface FilePageRead {
  content: string;
  endOffset: number;
  hasMore: boolean;
}

/**
 * Reads one bounded page of lines from `filePath` starting at byte offset
 * `startOffset`. Memory-bounded: reads at most ~64 KB chunks and stops as soon
 * as the page limits are reached. Line boundaries are found in raw bytes so
 * multi-byte UTF-8 sequences are never split mid-line.
 */
async function readFilePage(
  filePath: string,
  startOffset: number
): Promise<FilePageRead> {
  const handle = await fs.open(filePath, "r");
  try {
    const lines: string[] = [];
    let contentBytes = 0;
    let position = startOffset;
    let carryover = Buffer.alloc(0);
    let eofReached = false;

    while (!eofReached) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) {
        eofReached = true;
        break;
      }
      position += bytesRead;
      const data = Buffer.concat([carryover, buf.subarray(0, bytesRead)]);
      carryover = Buffer.alloc(0);

      let searchFrom = 0;
      while (true) {
        const nl = data.indexOf(0x0a, searchFrom);
        if (nl === -1) {
          carryover = Buffer.from(data.subarray(searchFrom));
          break;
        }
        const lineEnd = nl + 1; // include the newline
        const lineBytes = lineEnd - searchFrom;
        if (lines.length >= READ_FILE_PAGE_LINES || contentBytes + lineBytes > READ_FILE_PAGE_MAX_BYTES) {
          // Page full — rewind to the start of this unconsumed line.
          const consumedUpTo = position - data.length + searchFrom;
          return { content: lines.join(""), endOffset: consumedUpTo, hasMore: true };
        }
        lines.push(data.toString("utf-8", searchFrom, lineEnd));
        contentBytes += lineBytes;
        searchFrom = lineEnd;
      }
    }

    // EOF reached: include trailing partial line when it fits.
    if (carryover.length > 0) {
      if (lines.length < READ_FILE_PAGE_LINES && contentBytes + carryover.length <= READ_FILE_PAGE_MAX_BYTES) {
        lines.push(carryover.toString("utf-8"));
        return { content: lines.join(""), endOffset: position, hasMore: false };
      }
      // Trailing partial line does not fit in this page.
      return { content: lines.join(""), endOffset: position - carryover.length, hasMore: true };
    }

    return { content: lines.join(""), endOffset: position, hasMore: false };
  } finally {
    await handle.close();
  }
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
      const toolCallId = randomUUID();
      const userPath = String(args.path);
      const start = Date.now();

      // v0.3.2: continuation request for a previous read_file page.
      // The stored path is re-validated against every security check so a
      // later page can never bypass workspace/sensitive-file protections.
      const cursor = getCursorArg(args);
      if (cursor) {
        const state = takeFilePageState(cursor);
        if (!state) return cursorError("read_file", toolCallId);

        // Re-run all security checks on the stored path
        try {
          await validateWorkspacePath(ctx.workspaceRoot, state.filePath);
        } catch {
          return cursorError("read_file", toolCallId);
        }
        if (isBinary(state.filePath) || isSensitiveFile(path.basename(state.filePath))) {
          return cursorError("read_file", toolCallId);
        }

        try {
          const page = await readFilePage(state.filePath, state.offset);
          const metadata: ToolMetadata = { durationMs: Date.now() - start };
          if (page.hasMore) {
            const nextCursor = storeFilePageState({ filePath: state.filePath, offset: page.endOffset });
            metadata.pagination = { page: 2, pageSize: Buffer.byteLength(page.content, "utf-8"), hasMore: true, nextCursor };
          }
          return createSuccessResult("read_file", toolCallId, page.content, metadata);
        } catch (error) {
          return createErrorResult("read_file", toolCallId, ToolErrorCode.FILE_READ_FAILED, `Failed to continue reading file: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
        }
      }

      let filePath: string;
      try {
        filePath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      } catch (error) {
        return createErrorResult("read_file", toolCallId, ToolErrorCode.PATH_OUTSIDE_WORKSPACE, (error as Error).message, false, { durationMs: Date.now() - start });
      }

      if (isBinary(filePath)) {
        return createErrorResult("read_file", toolCallId, ToolErrorCode.BINARY_FILE, "Cannot read binary files.", false, { durationMs: Date.now() - start });
      }

      if (isSensitiveFile(path.basename(filePath))) {
        return createErrorResult("read_file", toolCallId, ToolErrorCode.SENSITIVE_FILE, "Cannot read sensitive files (credentials, keys, .env).", false, { durationMs: Date.now() - start });
      }

      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          return createErrorResult("read_file", toolCallId, ToolErrorCode.OUTPUT_LIMIT, `File exceeds maximum size of ${MAX_FILE_SIZE} bytes.`, false, { durationMs: Date.now() - start });
        }

        // Small files fit in one page — read directly (backward compatible).
        if (stat.size <= READ_FILE_PAGE_MAX_BYTES) {
          const { result: output, durationMs } = await withPermission(evaluator, "file_read", userPath, async () => fs.readFile(filePath, "utf-8"), ctx);
          return createSuccessResult("read_file", toolCallId, output, { durationMs, bytesRead: stat.size });
        }

        // Large file: bounded incremental first page
        const { result: allowed, durationMs } = await withPermission(evaluator, "file_read", userPath, async () => true, ctx);
        void allowed;
        const page = await readFilePage(filePath, 0);
        const metadata: ToolMetadata = { durationMs, bytesRead: page.endOffset };
        if (page.hasMore) {
          const nextCursor = storeFilePageState({ filePath, offset: page.endOffset });
          metadata.pagination = { page: 1, pageSize: Buffer.byteLength(page.content, "utf-8"), hasMore: true, nextCursor, totalBytes: stat.size };
        }
        return createSuccessResult("read_file", toolCallId, page.content, metadata);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          return createErrorResult("read_file", toolCallId, ToolErrorCode.FILE_NOT_FOUND, `File not found: ${userPath}`, true, { durationMs: Date.now() - start });
        }
        return createErrorResult("read_file", toolCallId, ToolErrorCode.FILE_READ_FAILED, `Failed to read file: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
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
      const toolCallId = randomUUID();
      const userPath = String(args.path);
      const content = String(args.content);
      const start = Date.now();

      let filePath: string;
      try {
        filePath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      } catch (error) {
        return createErrorResult("write_file", toolCallId, ToolErrorCode.PATH_OUTSIDE_WORKSPACE, (error as Error).message, false, { durationMs: Date.now() - start });
      }

      try {
        const { result, durationMs } = await withPermission(evaluator, "file_write", userPath, async () => {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
          return "ok";
        }, ctx);
        return createSuccessResult("write_file", toolCallId, "File written successfully.", { durationMs, bytesWritten: Buffer.byteLength(content, "utf-8") });
      } catch (error) {
        return createErrorResult("write_file", toolCallId, ToolErrorCode.FILE_WRITE_FAILED, `Failed to write file: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
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
      const toolCallId = randomUUID();
      const userPath = String(args.path);
      const start = Date.now();

      let dirPath: string;
      try {
        dirPath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      } catch (error) {
        return createErrorResult("list_files", toolCallId, ToolErrorCode.PATH_OUTSIDE_WORKSPACE, (error as Error).message, false, { durationMs: Date.now() - start });
      }

      const gitignorePatterns = await getGitignorePatterns(ctx.workspaceRoot);

      // v0.3.2: continuation request for a previous list_files page.
      const cursor = getCursorArg(args);
      if (cursor) {
        const page = paginationStore.fetch(cursor, "list_files");
        if (!page) return cursorError("list_files", toolCallId);
        const metadata: ToolMetadata = { durationMs: Date.now() - start };
        if (page.hasMore && page.nextCursor) {
          metadata.pagination = { page: page.page + 1, pageSize: page.pageSize, hasMore: true, nextCursor: page.nextCursor };
        }
        return createSuccessResult("list_files", toolCallId, page.content, metadata);
      }

      try {
        const { result: output, durationMs } = await withPermission(evaluator, "file_read", userPath, async () => {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const matched = entries
            .filter((e) => !shouldIgnore(e.name, gitignorePatterns) && !isSensitiveFile(e.name))
            .slice(0, LIST_FILES_MAX_ENTRIES)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

          // v0.3.2: paginate large listings (security filtering happens first)
          const pages: string[] = [];
          for (let i = 0; i < matched.length; i += LIST_FILES_PAGE_SIZE) {
            pages.push(JSON.stringify(matched.slice(i, i + LIST_FILES_PAGE_SIZE), null, 2));
          }
          if (pages.length === 0) pages.push(JSON.stringify([], null, 2));
          return { pages, totalItems: matched.length };
        }, ctx);

        const [firstPage, ...restPages] = output.pages;
        const metadata: ToolMetadata = { durationMs };
        if (restPages.length > 0) {
          const nextCursor = paginationStore.store(restPages, "list_files");
          metadata.pagination = { page: 1, pageSize: LIST_FILES_PAGE_SIZE, hasMore: true, nextCursor, totalItems: output.totalItems };
        }
        return createSuccessResult("list_files", toolCallId, firstPage, metadata);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          return createErrorResult("list_files", toolCallId, ToolErrorCode.DIRECTORY_NOT_FOUND, `Directory not found: ${userPath}`, true, { durationMs: Date.now() - start });
        }
        return createErrorResult("list_files", toolCallId, ToolErrorCode.FILE_READ_FAILED, `Failed to list directory: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
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
      const toolCallId = randomUUID();
      const userPath = String(args.path);
      const query = String(args.query);
      const start = Date.now();

      let searchPath: string;
      try {
        searchPath = await validateWorkspacePath(ctx.workspaceRoot, userPath);
      } catch (error) {
        return createErrorResult("search_files", toolCallId, ToolErrorCode.PATH_OUTSIDE_WORKSPACE, (error as Error).message, false, { durationMs: Date.now() - start });
      }

      const rg = await findRipgrep();
      const gitignorePatterns = await getGitignorePatterns(ctx.workspaceRoot);

      // v0.3.2: continuation request for a previous search_files page.
      const cursor = getCursorArg(args);
      if (cursor) {
        const page = paginationStore.fetch(cursor, "search_files");
        if (!page) return cursorError("search_files", toolCallId);
        const metadata: ToolMetadata = { durationMs: Date.now() - start };
        if (page.hasMore && page.nextCursor) {
          metadata.pagination = { page: page.page + 1, pageSize: page.pageSize, hasMore: true, nextCursor: page.nextCursor };
        }
        return createSuccessResult("search_files", toolCallId, page.content, metadata);
      }

      try {
        const { result: output, durationMs } = await withPermission(evaluator, "search", userPath, async () => {
          if (rg) {
            try {
              const { stdout } = await execFileAsync("rg", ["--no-heading", "--line-number", query, searchPath], {
                cwd: ctx.workspaceRoot,
                maxBuffer: 1024 * 1024 * 10,
                windowsHide: true,
              });
              // Security filtering happens BEFORE pagination and BEFORE the
              // hard cap — filtered-out matches are never buffered or paged.
              const results: { file: string; line: number; content: string }[] = [];
              for (const line of stdout.split("\n")) {
                if (!line.trim()) continue;
                if (results.length >= SEARCH_MAX_RESULTS) break;
                const match = line.match(/^(.+?):(\d+):(.*)$/);
                if (!match) continue;
                const file = match[1];
                const relative = path.relative(ctx.workspaceRoot, file);
                if (isSensitiveFile(path.basename(file)) || shouldIgnore(relative, gitignorePatterns)) continue;
                results.push({ file, line: parseInt(match[2], 10), content: match[3] });
              }
              return results;
            } catch (error: any) {
              if (error.code === 1) return [];
              throw error;
            }
          }

          const results: { file: string; line: number; content: string }[] = [];
          const files = await getAllFiles(searchPath, gitignorePatterns);
          for (const file of files) {
            if (results.length >= SEARCH_MAX_RESULTS) break;
            const relative = path.relative(ctx.workspaceRoot, file);
            if (shouldIgnore(relative, gitignorePatterns)) continue;
            if (isBinary(file)) continue;
            if (isSensitiveFile(path.basename(file))) continue;
            const stat = await fs.stat(file);
            if (stat.size > MAX_FILE_SIZE) continue;

            const content = await fs.readFile(file, "utf-8").catch(() => null);
            if (!content) continue;
            const lines = content.split("\n");
            for (let idx = 0; idx < lines.length && results.length < SEARCH_MAX_RESULTS; idx++) {
              if (lines[idx].includes(query)) {
                results.push({ file: relative, line: idx + 1, content: lines[idx].trim() });
              }
            }
          }
          return results;
        }, ctx);

        // v0.3.2: paginate the already-filtered match list.
        const pages: string[] = [];
        for (let i = 0; i < output.length; i += SEARCH_PAGE_SIZE) {
          pages.push(JSON.stringify(output.slice(i, i + SEARCH_PAGE_SIZE), null, 2));
        }
        if (pages.length === 0) pages.push(JSON.stringify([], null, 2));

        const [firstPage, ...restPages] = pages;
        const metadata: ToolMetadata = { durationMs };
        if (restPages.length > 0) {
          const nextCursor = paginationStore.store(restPages, "search_files");
          metadata.pagination = { page: 1, pageSize: SEARCH_PAGE_SIZE, hasMore: true, nextCursor, totalItems: output.length };
        }
        return createSuccessResult("search_files", toolCallId, firstPage, metadata);
      } catch (error) {
        return createErrorResult("search_files", toolCallId, ToolErrorCode.SEARCH_FAILED, `Search failed: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
    },
  };

  interface CommandExecution {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    spawnError?: string;
  }

  /**
   * Executes a command via spawn with per-stream output limits, timeout and
   * cancellation support. Never throws — all outcomes are reported in the
   * returned CommandExecution so callers can classify errors deterministically.
   *
   * Known parsing limitation (documented): on Unix the raw command string is
   * split on whitespace; quoted arguments containing spaces are not supported.
   * On Windows the command is passed to PowerShell which handles quoting.
   */
  function executeCommand(
    executable: string,
    execArgs: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CommandExecution> {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const child = spawn(executable, execArgs, { cwd, windowsHide: true });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const onAbort = () => {
        child.kill("SIGKILL");
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: true, stdoutTruncated: false, stderrTruncated: false });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes + chunk.length <= COMMAND_OUTPUT_LIMIT_BYTES) {
          stdoutBytes += chunk.length;
          stdout += chunk.toString("utf-8");
        } else {
          stdoutTruncated = true;
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes + chunk.length <= COMMAND_OUTPUT_LIMIT_BYTES) {
          stderrBytes += chunk.length;
          stderr += chunk.toString("utf-8");
        } else {
          stderrTruncated = true;
        }
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({
          stdout,
          stderr,
          exitCode: null,
          timedOut,
          cancelled: signal?.aborted ?? false,
          stdoutTruncated,
          stderrTruncated,
          spawnError: err.code ?? err.message,
        });
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          cancelled: signal?.aborted ?? false,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }

  function formatCommandOutput(exec: CommandExecution): string {
    const sections: string[] = [];
    if (exec.stdout.trim()) {
      sections.push(`--- stdout ---\n${exec.stdout.trimEnd()}`);
    }
    if (exec.stderr.trim()) {
      sections.push(`--- stderr ---\n${exec.stderr.trimEnd()}`);
    }
    if (sections.length === 0) {
      return "(no output)";
    }
    return sections.join("\n\n");
  }

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
      const toolCallId = randomUUID();
      const command = String(args.command);
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const start = Date.now();

      // v0.3.2: continuation request for a previous run_command output page.
      const cursor = getCursorArg(args);
      if (cursor) {
        const page = paginationStore.fetch(cursor, "run_command");
        if (!page) return cursorError("run_command", toolCallId);
        const metadata: ToolMetadata = { durationMs: Date.now() - start };
        if (page.hasMore && page.nextCursor) {
          metadata.pagination = { page: page.page + 1, pageSize: page.pageSize, hasMore: true, nextCursor: page.nextCursor };
        }
        return createSuccessResult("run_command", toolCallId, page.content, metadata);
      }

      for (const pattern of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(command.trim())) {
          return createErrorResult("run_command", toolCallId, ToolErrorCode.COMMAND_NOT_ALLOWED, `Destructive command blocked by policy: ${command}`, false, { durationMs: Date.now() - start });
        }
      }

      // Permission check first (approval may be rejected before any process starts)
      try {
        await withPermission(evaluator, "shell", command, async () => undefined, ctx);
      } catch (error) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.PERMISSION_DENIED, (error as Error).message, false, { durationMs: Date.now() - start });
      }

      // Build platform-specific execution plan.
      // Both platforms tokenize the command respecting quotes so that inline
      // arguments such as `node -e "code here"` work correctly.
      const tokens = tokenizeCommand(command);
      if (tokens.length === 0) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.INVALID_ARGUMENT, "Command must not be empty.", false, { durationMs: Date.now() - start });
      }

      let executable: string;
      let execArgs: string[];
      if (ctx.platform === "win32") {
        // `Out-String` forces synchronous output formatting (otherwise `exit`
        // can terminate before formatted output is flushed), and
        // `exit $LASTEXITCODE` propagates the native child's exit code through
        // powershell.exe (PS 5.1 does not do this automatically).
        executable = "powershell.exe";
        execArgs = [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& ${tokens.map(toPowerShellLiteral).join(" ")}${cmdArgs.length ? " " + cmdArgs.map(toPowerShellLiteral).join(" ") : ""} | Out-String; exit $LASTEXITCODE`,
        ];
      } else {
        executable = tokens[0];
        execArgs = [...tokens.slice(1), ...cmdArgs];
      }

      // Wire agent cancellation to an AbortSignal so the child process is killed
      const abortController = new AbortController();
      if (ctx.cancellationToken) {
        ctx.cancellationToken.onCancelled(() => abortController.abort());
      }

      const exec = await executeCommand(executable, execArgs, ctx.workspaceRoot, getCommandTimeoutMs(), abortController.signal);

      const durationMs = Date.now() - start;
      const totalOutputBytes = Buffer.byteLength(exec.stdout, "utf-8") + Buffer.byteLength(exec.stderr, "utf-8");

      // Classification order matters: cancellation > timeout > spawn error > exit code
      if (exec.cancelled) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.CANCELLED, "Command cancelled.", false, { durationMs, cancelled: true, stdout: exec.stdout || undefined, stderr: exec.stderr || undefined });
      }
      if (exec.timedOut) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.TIMEOUT, `Command timed out after ${getCommandTimeoutMs()}ms: ${command}`, true, { durationMs, timedOut: true, stdout: exec.stdout || undefined, stderr: exec.stderr || undefined });
      }
      if (exec.spawnError) {
        if (exec.spawnError === "ENOENT") {
          return createErrorResult("run_command", toolCallId, ToolErrorCode.COMMAND_NOT_FOUND, `Command not found: ${executable}`, true, { durationMs });
        }
        return createErrorResult("run_command", toolCallId, ToolErrorCode.COMMAND_FAILED, `Failed to start command: ${exec.spawnError}`, true, { durationMs });
      }
      // On Windows the outer process is powershell.exe (which always exists),
      // so unknown *inner* commands surface as a non-zero exit with a
      // recognizable stderr message rather than a spawn ENOENT.
      const notRecognized = /is not recognized as (the name of a cmdlet|an internal or external command)/i.test(exec.stderr);
      if (notRecognized) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.COMMAND_NOT_FOUND, `Command not found: ${tokens[0]}`, true, { durationMs, exitCode: exec.exitCode ?? undefined, stderr: exec.stderr || undefined });
      }
      if (exec.exitCode !== 0 && exec.exitCode !== null) {
        return createErrorResult("run_command", toolCallId, ToolErrorCode.COMMAND_FAILED, `Command exited with code ${exec.exitCode}: ${command}`, true, {
          durationMs,
          exitCode: exec.exitCode,
          truncated: (exec.stdoutTruncated || exec.stderrTruncated) || undefined,
          stdout: exec.stdout || undefined,
          stderr: exec.stderr || undefined,
        });
      }

      // v0.3.2: bounded first page with continuation cursor for large output.
      // stdout/stderr separation is preserved inside the formatted text.
      const fullOutput = formatCommandOutput(exec);
      const baseMetadata: ToolMetadata = {
        durationMs,
        exitCode: 0,
        bytesRead: totalOutputBytes,
        truncated: (exec.stdoutTruncated || exec.stderrTruncated) || undefined,
        // Only embed raw streams when small enough to keep results bounded.
        stdout: exec.stdout.length <= 4096 ? exec.stdout : undefined,
        stderr: exec.stderr.length <= 4096 ? exec.stderr : undefined,
      };
      return buildPaginatedResult("run_command", toolCallId, fullOutput, COMMAND_PAGE_SIZE_BYTES, baseMetadata);
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
    handler: async (args, ctx) => {
      const toolCallId = randomUUID();
      const start = Date.now();

      // v0.3.2: continuation request for a previous git_status page.
      const cursor = getCursorArg(args);
      if (cursor) {
        const page = paginationStore.fetch(cursor, "git_status");
        if (!page) return cursorError("git_status", toolCallId);
        const metadata: ToolMetadata = { durationMs: Date.now() - start };
        if (page.hasMore && page.nextCursor) {
          metadata.pagination = { page: page.page + 1, pageSize: page.pageSize, hasMore: true, nextCursor: page.nextCursor };
        }
        return createSuccessResult("git_status", toolCallId, page.content, metadata);
      }

      try {
        const { result: allowed, durationMs } = await withPermission(evaluator, "git", "git status", async () => true, ctx);
        void allowed;
        const exec = await executeCommand("git", ["status", "--porcelain"], ctx.workspaceRoot, getCommandTimeoutMs());
        if (exec.spawnError) {
          const detail = exec.spawnError === "ENOENT" ? "git executable not found" : exec.spawnError;
          return createErrorResult("git_status", toolCallId, ToolErrorCode.GIT_FAILED, `Git status failed: ${detail}`, true, { durationMs: Date.now() - start });
        }
        if (exec.timedOut) {
          return createErrorResult("git_status", toolCallId, ToolErrorCode.TIMEOUT, "Git status timed out.", true, { durationMs: Date.now() - start, timedOut: true });
        }
        if (exec.cancelled) {
          return createErrorResult("git_status", toolCallId, ToolErrorCode.CANCELLED, "Git status cancelled.", false, { durationMs: Date.now() - start, cancelled: true });
        }
        if (exec.exitCode !== 0 && exec.exitCode !== null) {
          return createErrorResult("git_status", toolCallId, ToolErrorCode.GIT_FAILED, `Git status failed with exit code ${exec.exitCode}`, true, { durationMs: Date.now() - start });
        }
        const fullOutput = exec.stdout.trim() || "Working tree clean.";
        return buildPaginatedResult("git_status", toolCallId, fullOutput, COMMAND_PAGE_SIZE_BYTES, { durationMs: Date.now() - start, exitCode: 0 });
      } catch (error) {
        return createErrorResult("git_status", toolCallId, ToolErrorCode.GIT_FAILED, `Git status failed: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
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
    handler: async (args, ctx) => {
      const toolCallId = randomUUID();
      const start = Date.now();

      // v0.3.2: continuation request for a previous git_diff page.
      const cursor = getCursorArg(args);
      if (cursor) {
        const page = paginationStore.fetch(cursor, "git_diff");
        if (!page) return cursorError("git_diff", toolCallId);
        const metadata: ToolMetadata = { durationMs: Date.now() - start };
        if (page.hasMore && page.nextCursor) {
          metadata.pagination = { page: page.page + 1, pageSize: page.pageSize, hasMore: true, nextCursor: page.nextCursor };
        }
        return createSuccessResult("git_diff", toolCallId, page.content, metadata);
      }

      try {
        const { result: allowed, durationMs } = await withPermission(evaluator, "git", "git diff", async () => true, ctx);
        void allowed;
        const exec = await executeCommand("git", ["diff"], ctx.workspaceRoot, getCommandTimeoutMs());
        if (exec.spawnError) {
          const detail = exec.spawnError === "ENOENT" ? "git executable not found" : exec.spawnError;
          return createErrorResult("git_diff", toolCallId, ToolErrorCode.GIT_FAILED, `Git diff failed: ${detail}`, true, { durationMs: Date.now() - start });
        }
        if (exec.timedOut) {
          return createErrorResult("git_diff", toolCallId, ToolErrorCode.TIMEOUT, "Git diff timed out.", true, { durationMs: Date.now() - start, timedOut: true });
        }
        if (exec.cancelled) {
          return createErrorResult("git_diff", toolCallId, ToolErrorCode.CANCELLED, "Git diff cancelled.", false, { durationMs: Date.now() - start, cancelled: true });
        }
        if (exec.exitCode !== 0 && exec.exitCode !== null) {
          return createErrorResult("git_diff", toolCallId, ToolErrorCode.GIT_FAILED, `Git diff failed with exit code ${exec.exitCode}`, true, { durationMs: Date.now() - start });
        }
        // Diff boundaries are preserved: chunking happens on the raw diff text
        // at byte boundaries, never mid-line (chunkText splits on code points
        // and diffs are line-oriented text).
        const fullOutput = exec.stdout.trim() || "No changes.";
        return buildPaginatedResult("git_diff", toolCallId, fullOutput, COMMAND_PAGE_SIZE_BYTES, { durationMs: Date.now() - start, exitCode: 0 });
      } catch (error) {
        return createErrorResult("git_diff", toolCallId, ToolErrorCode.GIT_FAILED, `Git diff failed: ${(error as Error).message}`, true, { durationMs: Date.now() - start });
      }
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

  /**
   * Tokenizes a command string respecting double and single quotes.
   * Example: `node -e "console.log('x')"` -> ["node", "-e", "console.log('x')"]
   *
   * Known limitations (documented):
   * - Escaped quotes inside quoted segments (\") are not supported.
   * - Mixed quoting edge cases may differ slightly from native shell parsing.
   */
  function tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    for (const ch of command.trim()) {
      if (quote) {
        if (ch === quote) {
          quote = null;
          continue;
        }
        current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function toPowerShellLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  return [readFileTool, writeFileTool, listFilesTool, searchFilesTool, runCommandTool, gitStatusTool, gitDiffTool];
}