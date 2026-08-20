import * as fs from "fs/promises";
import * as path from "path";
import { analyzeFile } from "./symbols";
import { createContextBudget } from "./context-budget";

export interface ContextFile {
  path: string;
  relativePath: string;
  size: number;
  score: number;
  symbols?: { name: string; kind: string; line: number }[];
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
const MAX_SINGLE_FILE_BYTES = 20000;
const DEFAULT_MAX_CONTEXT_BYTES = 80000;

export { createContextBudget } from "./context-budget";
export type { ContextBudget } from "./context-budget";

export async function discoverContextFiles(workspaceRoot: string, task: string, contextWindowLimit = DEFAULT_MAX_CONTEXT_BYTES): Promise<ContextFile[]> {
  const gitignorePatterns = await readGitignore(workspaceRoot);
  const files = await scanFiles(workspaceRoot, "", gitignorePatterns);
  const scored = scoreFiles(files, task);

  const budget = createContextBudget(contextWindowLimit, MAX_SINGLE_FILE_BYTES);

  const selected: ContextFile[] = [];
  for (const file of scored) {
    if (!budget.canAllocate(file.size)) break;
    budget.allocate(file.size);
    selected.push(file);
  }

  const withSymbols = await Promise.all(
    selected.map(async (file) => {
      try {
        const analysis = await analyzeFile(file.path);
        return { ...file, symbols: analysis.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })) };
      } catch {
        return file;
      }
    })
  );

  return rescoreWithSymbols(withSymbols, task);
}

async function readGitignore(workspaceRoot: string): Promise<Set<string>> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    return new Set(content.split("\n").filter((l) => l.trim() && !l.startsWith("#")));
  } catch {
    return new Set();
  }
}

async function scanFiles(dir: string, relativeDir: string, gitignorePatterns: Set<string>): Promise<ContextFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: ContextFile[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);

    if (IGNORED_DIRS.has(entry.name)) continue;
    if (shouldIgnore(relativePath, gitignorePatterns)) continue;
    if (isSensitiveFile(entry.name)) continue;

    if (entry.isDirectory()) {
      files.push(...(await scanFiles(fullPath, relativePath, gitignorePatterns)));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_SINGLE_FILE_BYTES) continue;
        files.push({ path: fullPath, relativePath, size: stat.size, score: 0 });
      } catch {
        continue;
      }
    }
  }

  return files;
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

function scoreFiles(files: ContextFile[], task: string): ContextFile[] {
  const taskLower = task.toLowerCase();
  const keywords = taskLower.split(/\s+/).filter((w) => w.length > 3);

  const scored = files.map((file) => {
    let score = 0;
    const nameLower = path.basename(file.relativePath).toLowerCase();
    const dirLower = path.dirname(file.relativePath).toLowerCase();

    if (nameLower.includes("test") || nameLower.includes("spec")) score += 2;
    if (nameLower.includes("readme") || nameLower.includes("package.json") || nameLower.includes("tsconfig")) score += 3;
    if (dirLower.includes("src") || dirLower.includes("lib")) score += 1;

    for (const keyword of keywords) {
      if (nameLower.includes(keyword)) score += 5;
      if (dirLower.includes(keyword)) score += 3;
    }

    return { ...file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return scored;
}

function rescoreWithSymbols(files: ContextFile[], task: string): ContextFile[] {
  const taskLower = task.toLowerCase();
  const keywords = taskLower.split(/\s+/).filter((w) => w.length > 3);

  return files.map((file) => {
    let bonus = 0;
    if (file.symbols) {
      for (const symbol of file.symbols) {
        const nameLower = symbol.name.toLowerCase();
        for (const keyword of keywords) {
          if (nameLower.includes(keyword)) {
            bonus += symbol.kind === "function" ? 4 : symbol.kind === "class" ? 3 : 2;
          }
        }
      }
    }
    return { ...file, score: file.score + bonus };
  }).sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
}

export async function readContextFiles(files: ContextFile[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await fs.readFile(file.path, "utf-8");
      contents.set(file.relativePath, content);
    } catch {
      continue;
    }
  }
  return contents;
}
