import * as fs from "fs/promises";

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "variable" | "import" | "export";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  signature?: string;
}

export interface ImportReference {
  source: string;
  names: string[];
  line: number;
}

export interface FileAnalysis {
  path: string;
  language: string;
  symbols: CodeSymbol[];
  imports: ImportReference[];
  exports: string[];
  error?: string;
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".java": "java",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".html": "html",
  ".css": "css",
};

export function detectLanguage(filePath: string): string | null {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  const mapped = LANGUAGE_EXTENSIONS[`.${ext}`];
  if (mapped) return mapped;

  const base = filePath.toLowerCase();
  if (base.endsWith(".tsx")) return "typescript";
  if (base.endsWith(".jsx")) return "javascript";
  if (base.endsWith(".ts")) return "typescript";
  if (base.endsWith(".js")) return "javascript";
  if (base.endsWith(".py")) return "python";
  if (base.endsWith(".java")) return "java";
  if (base.endsWith(".html")) return "html";
  if (base.endsWith(".css")) return "css";

  return null;
}

export async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const language = detectLanguage(filePath);
  if (!language) {
    return { path: filePath, language: "unknown", symbols: [], imports: [], exports: [] };
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols = extractSymbols(content, language);
    const imports = extractImports(content, language);
    const exports = extractExports(content, language);

    return { path: filePath, language, symbols, imports, exports };
  } catch (error) {
    return { path: filePath, language, symbols: [], imports: [], exports: [], error: (error as Error).message };
  }
}

function extractSymbols(content: string, language: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");

  if (language === "typescript" || language === "javascript") {
    let inClass = false;
    let classBraceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

      if (trimmed.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/)) {
        inClass = true;
        classBraceDepth = 0;
      }

      if (inClass) {
        classBraceDepth += (trimmed.match(/{/g) || []).length;
        classBraceDepth -= (trimmed.match(/}/g) || []).length;
        if (classBraceDepth <= 0 && i > 0) {
          inClass = false;
        }
      }

      const funcMatch = trimmed.match(/^(export\s+)?(async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
      if (funcMatch) {
        symbols.push({ name: funcMatch[3], kind: "function", line: i + 1, column: line.indexOf(funcMatch[3]), signature: funcMatch[2] ? funcMatch[3] + funcMatch[4] : undefined });
      }

      const classMatch = trimmed.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[3], kind: "class", line: i + 1, column: line.indexOf(classMatch[3]) });
      }

      const methodMatch = trimmed.match(/^(public|private|protected|readonly)?\s*(async\s+)?(\w+)\s*\(/);
      if (methodMatch && inClass) {
        symbols.push({ name: methodMatch[3], kind: "method", line: i + 1, column: line.indexOf(methodMatch[3]) });
      }

      const constructorMatch = trimmed.match(/^constructor\s*\(/);
      if (constructorMatch && inClass) {
        symbols.push({ name: "constructor", kind: "method", line: i + 1, column: line.indexOf("constructor") });
      }

      const interfaceMatch = trimmed.match(/^(export\s+)?interface\s+(\w+)/);
      if (interfaceMatch) {
        symbols.push({ name: interfaceMatch[2], kind: "interface", line: i + 1, column: line.indexOf(interfaceMatch[2]) });
      }

      const typeMatch = trimmed.match(/^(export\s+)?type\s+(\w+)/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[2], kind: "type", line: i + 1, column: line.indexOf(typeMatch[2]) });
      }

      const constMatch = trimmed.match(/^(export\s+)?(const|let|var)\s+(\w+)/);
      if (constMatch && !funcMatch && !methodMatch) {
        symbols.push({ name: constMatch[3], kind: "variable", line: i + 1, column: line.indexOf(constMatch[3]) });
      }
    }
  } else if (language === "python") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const funcMatch = trimmed.match(/^(async\s+)?def\s+(\w+)/);
      if (funcMatch) {
        symbols.push({ name: funcMatch[2], kind: "function", line: i + 1, column: line.indexOf(funcMatch[2]) });
      }

      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: "class", line: i + 1, column: line.indexOf(classMatch[1]) });
      }
    }
  } else if (language === "java") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const classMatch = trimmed.match(/^(public|private|protected)?\s*(abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[3], kind: "class", line: i + 1, column: line.indexOf(classMatch[3]) });
      }

      const interfaceMatch = trimmed.match(/^interface\s+(\w+)/);
      if (interfaceMatch) {
        symbols.push({ name: interfaceMatch[1], kind: "interface", line: i + 1, column: line.indexOf(interfaceMatch[1]) });
      }

      const methodMatch = trimmed.match(/^(?:\s*(?:public|private|protected|static|abstract|final|synchronized|strictfp)\s+)*[\w<>\[\],\s]+\s+(\w+)\s*\(/);
      if (methodMatch) {
        symbols.push({ name: methodMatch[1], kind: "method", line: i + 1, column: line.indexOf(methodMatch[1]) });
      }
    }
  } else if (language === "cpp") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const funcMatch = trimmed.match(/^(inline\s+)?(\w+)\s*(\w+)\s*\(/);
      if (funcMatch && !trimmed.includes("class ") && !trimmed.includes("struct ")) {
        symbols.push({ name: funcMatch[3], kind: "function", line: i + 1, column: line.indexOf(funcMatch[3]) });
      }

      const classMatch = trimmed.match(/^(class|struct)\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[2], kind: "class", line: i + 1, column: line.indexOf(classMatch[2]) });
      }
    }
  }

  return symbols;
}

function extractImports(content: string, language: string): ImportReference[] {
  const imports: ImportReference[] = [];
  const lines = content.split("\n");

  if (language === "typescript" || language === "javascript") {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const importMatch = trimmed.match(/^import\s+(?:\{([^}]+)\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const names = importMatch[1] ? importMatch[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()) : [importMatch[0].match(/\w+/)?.[0] || ""].filter(Boolean);
        imports.push({ source: importMatch[2], names, line: i + 1 });
      }
    }
  } else if (language === "python") {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const importMatch = trimmed.match(/^import\s+([\w.]+)/);
      const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
      if (importMatch) {
        imports.push({ source: importMatch[1], names: [importMatch[1]], line: i + 1 });
      } else if (fromMatch) {
        const names = fromMatch[2].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
        imports.push({ source: fromMatch[1], names, line: i + 1 });
      }
    }
  } else if (language === "java") {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const importMatch = trimmed.match(/^import\s+([\w.*]+);/);
      if (importMatch) {
        const names = [importMatch[1].split(".").pop() || importMatch[1]];
        imports.push({ source: importMatch[1], names, line: i + 1 });
      }
    }
  }

  return imports;
}

function extractExports(content: string, language: string): string[] {
  const exports: string[] = [];
  const lines = content.split("\n");

  if (language === "typescript" || language === "javascript") {
    for (const line of lines) {
      const trimmed = line.trim();
      const exportMatch = trimmed.match(/^export\s+(?:default\s+)?(?:function|class|interface|type|const|let|var)\s+(\w+)/);
      if (exportMatch) {
        exports.push(exportMatch[1]);
      }
    }
  } else if (language === "python") {
    for (const line of lines) {
      const trimmed = line.trim();
      const exportMatch = trimmed.match(/^__all__\s*=\s*\[([^\]]+)\]/);
      if (exportMatch) {
        exports.push(...exportMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, "")));
      }
    }
  }

  return exports;
}
