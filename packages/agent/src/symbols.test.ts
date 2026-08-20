import { describe, it, expect } from "vitest";
import { analyzeFile, detectLanguage } from "./symbols";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("detectLanguage", () => {
  it("should detect TypeScript", () => {
    expect(detectLanguage("foo.ts")).toBe("typescript");
    expect(detectLanguage("src/bar.tsx")).toBe("typescript");
  });

  it("should detect JavaScript", () => {
    expect(detectLanguage("app.js")).toBe("javascript");
    expect(detectLanguage("app.jsx")).toBe("javascript");
  });

  it("should detect Python", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("should detect Java", () => {
    expect(detectLanguage("Main.java")).toBe("java");
  });

  it("should detect C++", () => {
    expect(detectLanguage("main.cpp")).toBe("cpp");
    expect(detectLanguage("main.h")).toBe("cpp");
  });

  it("should detect HTML", () => {
    expect(detectLanguage("index.html")).toBe("html");
  });

  it("should detect CSS", () => {
    expect(detectLanguage("style.css")).toBe("css");
  });

  it("should return null for unknown extensions", () => {
    expect(detectLanguage("file.unknown")).toBeNull();
  });
});

describe("analyzeFile", () => {
  it("should extract TypeScript functions, classes, interfaces, types, and variables", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "sample.ts");
    await fs.writeFile(filePath, `export interface User { id: number; name: string; }
export type Status = "active" | "inactive";
export class UserService {
  private users: User[] = [];
  async getUser(id: number): Promise<User> { return this.users[0]; }
  public addUser(user: User) { this.users.push(user); }
}
export function formatUser(user: User): string { return user.name; }
export const MAX_USERS = 100;
`);

    const analysis = await analyzeFile(filePath);

    expect(analysis.language).toBe("typescript");
    expect(analysis.error).toBeUndefined();

    const names = analysis.symbols.map((s) => s.name);
    expect(names).toContain("User");
    expect(names).toContain("Status");
    expect(names).toContain("UserService");
    expect(names).toContain("getUser");
    expect(names).toContain("addUser");
    expect(names).toContain("formatUser");
    expect(names).toContain("MAX_USERS");

    const kinds = analysis.symbols.reduce((acc, s) => { acc[s.name] = s.kind; return acc; }, {} as Record<string, string>);
    expect(kinds["User"]).toBe("interface");
    expect(kinds["Status"]).toBe("type");
    expect(kinds["UserService"]).toBe("class");
    expect(kinds["getUser"]).toBe("method");
    expect(kinds["addUser"]).toBe("method");
    expect(kinds["formatUser"]).toBe("function");
    expect(kinds["MAX_USERS"]).toBe("variable");
  });

  it("should extract Python functions and classes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "main.py");
    await fs.writeFile(filePath, `class Calculator:
    def add(self, a, b): return a + b
    def subtract(self, a, b): return a - b

def multiply(a, b): return a * b
`);

    const analysis = await analyzeFile(filePath);
    expect(analysis.language).toBe("python");

    const names = analysis.symbols.map((s) => s.name);
    expect(names).toContain("Calculator");
    expect(names).toContain("add");
    expect(names).toContain("subtract");
    expect(names).toContain("multiply");
  });

  it("should extract Java classes and methods", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "Main.java");
    await fs.writeFile(filePath, `public class Main {
    public static void main(String[] args) { }
    private String getName() { return ""; }
}
interface Service { void run(); }
`);

    const analysis = await analyzeFile(filePath);
    expect(analysis.language).toBe("java");

    const names = analysis.symbols.map((s) => s.name);
    expect(names).toContain("Main");
    expect(names).toContain("main");
    expect(names).toContain("getName");
    expect(names).toContain("Service");
  });

  it("should extract imports and exports", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "app.ts");
    await fs.writeFile(filePath, `import { foo } from "./foo";
import { bar } from "bar";
export function hello() {}
`);

    const analysis = await analyzeFile(filePath);

    expect(analysis.imports).toHaveLength(2);
    expect(analysis.imports[0].source).toBe("./foo");
    expect(analysis.imports[0].names).toContain("foo");
    expect(analysis.imports[1].source).toBe("bar");

    expect(analysis.exports).toContain("hello");
  });

  it("should not crash on unsupported languages", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "file.rs");
    await fs.writeFile(filePath, "fn main() {}");

    const analysis = await analyzeFile(filePath);
    expect(analysis.language).toBe("unknown");
    expect(analysis.symbols).toEqual([]);
    expect(analysis.imports).toEqual([]);
  });

  it("should return empty analysis for binary content without crashing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "bad.bin");
    await fs.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]));

    const analysis = await analyzeFile(filePath);
    expect(analysis.language).toBe("unknown");
    expect(analysis.symbols).toEqual([]);
    expect(analysis.imports).toEqual([]);
  });

  it("should handle empty files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-symbols-"));
    const filePath = path.join(tmpDir, "empty.ts");
    await fs.writeFile(filePath, "");

    const analysis = await analyzeFile(filePath);
    expect(analysis.symbols).toEqual([]);
    expect(analysis.imports).toEqual([]);
    expect(analysis.exports).toEqual([]);
  });
});
