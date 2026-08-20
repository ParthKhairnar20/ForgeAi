import { describe, it, expect } from "vitest";
import { discoverContextFiles, readContextFiles } from "./context";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("context", () => {
  it("should discover files and ignore binary and ignored directories", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "src", "test.txt"), "test content");
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {};");
    await fs.writeFile(path.join(tmpDir, "binary.exe"), "binary");

    const files = await discoverContextFiles(tmpDir, "test task");
    const relativePaths = files.map((f) => f.relativePath.split(path.sep).join("/"));

    expect(relativePaths).toContain("src/index.ts");
    expect(relativePaths).toContain("src/test.txt");
    expect(relativePaths).not.toContain("node_modules/pkg/index.js");
    expect(relativePaths).not.toContain("binary.exe");
  });

  it("should rank files by relevance to task", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "login.ts"), "export function login() {}");
    await fs.writeFile(path.join(tmpDir, "helper.ts"), "export function helper() {}");

    const files = await discoverContextFiles(tmpDir, "implement login function");

    expect(files[0].relativePath).toBe("login.ts");
  });

  it("should read context files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "a.ts"), "content A");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "content B");

    const files = await discoverContextFiles(tmpDir, "task");
    const contents = await readContextFiles(files);

    expect(contents.get("a.ts")).toBe("content A");
    expect(contents.get("b.ts")).toBe("content B");
  });

  it("should exclude sensitive files by default", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "app.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, ".env"), "SECRET=abc");
    await fs.writeFile(path.join(tmpDir, "credentials.json"), '{"key": "secret"}');
    await fs.writeFile(path.join(tmpDir, "id_rsa"), "key data");
    await fs.writeFile(path.join(tmpDir, "secret.key"), "key data");

    const files = await discoverContextFiles(tmpDir, "task");
    const relativePaths = files.map((f) => f.relativePath);

    expect(relativePaths).toContain("app.ts");
    expect(relativePaths).not.toContain(".env");
    expect(relativePaths).not.toContain("credentials.json");
    expect(relativePaths).not.toContain("id_rsa");
    expect(relativePaths).not.toContain("secret.key");
  });

  it("should exclude .env.* variants", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, ".env.local"), "SECRET=abc");
    await fs.writeFile(path.join(tmpDir, ".env.development"), "SECRET=abc");
    await fs.writeFile(path.join(tmpDir, "app.ts"), "export const x = 1;");

    const files = await discoverContextFiles(tmpDir, "task");
    const relativePaths = files.map((f) => f.relativePath);

    expect(relativePaths).not.toContain(".env.local");
    expect(relativePaths).not.toContain(".env.development");
    expect(relativePaths).toContain("app.ts");
  });

  it("should attach symbols for relevant languages", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "login.ts"), "export function login() {}");

    const files = await discoverContextFiles(tmpDir, "login feature");
    const loginFile = files.find((f) => f.relativePath === "login.ts");

    expect(loginFile).toBeDefined();
    expect(loginFile!.symbols).toBeDefined();
    expect(loginFile!.symbols!.length).toBeGreaterThanOrEqual(1);
    expect(loginFile!.symbols!.some((s: any) => s.name === "login")).toBe(true);
  });

  it("should not include symbols for non-code files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "just some notes");

    const files = await discoverContextFiles(tmpDir, "task");
    const notesFile = files.find((f) => f.relativePath === "notes.txt");

    expect(notesFile).toBeDefined();
    expect(notesFile!.symbols).toBeDefined();
    expect(notesFile!.symbols).toEqual([]);
  });

  it("should rescore files with symbol matches", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-test-"));
    await fs.writeFile(path.join(tmpDir, "login.ts"), "export function login() {}");
    await fs.writeFile(path.join(tmpDir, "helper.ts"), "export function helper() {}");

    const files = await discoverContextFiles(tmpDir, "implement login function");

    expect(files[0].relativePath).toBe("login.ts");
    expect(files[0].score).toBeGreaterThan(files[1].score);
  });
});
