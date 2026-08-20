import { describe, it, expect } from "vitest";
import { discoverContextFiles } from "./context";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("context quality", () => {
  it("should prioritize authentication-related files for login task", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-quality-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "src", "components"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });

    await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export function login() {}");
    await fs.writeFile(path.join(tmpDir, "src", "auth.service.ts"), "export class AuthService { async login() {} }");
    await fs.writeFile(path.join(tmpDir, "src", "components", "Button.tsx"), "export function Button() {}");
    await fs.writeFile(path.join(tmpDir, "tests", "auth.test.ts"), "test login");
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Project");
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, ".env"), "SECRET=abc");
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {};");
    await fs.writeFile(path.join(tmpDir, "large.txt"), "x".repeat(50000));

    const files = await discoverContextFiles(tmpDir, "Fix login authentication");
    const relativePaths = files.map((f) => f.relativePath);

    const authFiles = files.filter((f) => f.relativePath.includes("auth"));
    const nonAuthFiles = files.filter((f) => !f.relativePath.includes("auth") && !f.relativePath.includes("README") && !f.relativePath.includes("package.json"));

    expect(authFiles.length).toBeGreaterThan(0);
    if (authFiles.length > 0 && nonAuthFiles.length > 0) {
      expect(authFiles[0].score).toBeGreaterThanOrEqual(nonAuthFiles[0].score);
    }
    expect(relativePaths).not.toContain(".env");
    expect(relativePaths).not.toContain("node_modules/pkg/index.js");
    expect(relativePaths).not.toContain("large.txt");
  });

  it("should prioritize database/config files for database task", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-quality-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "db.ts"), "export function connect() {}");
    await fs.writeFile(path.join(tmpDir, "src", "api.ts"), "export function fetch() {}");
    await fs.writeFile(path.join(tmpDir, "config.ts"), "export const config = {};");

    const files = await discoverContextFiles(tmpDir, "Fix database connection");
    const relativePaths = files.map((f) => f.relativePath);

    const dbFiles = files.filter((f) => f.relativePath.includes("db") || f.relativePath.includes("config"));
    expect(dbFiles.length).toBeGreaterThan(0);
    if (dbFiles.length > 0) {
      expect(dbFiles[0].score).toBeGreaterThan(0);
    }
  });

  it("should respect contextWindowLimit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-quality-"));
    await fs.writeFile(path.join(tmpDir, "small.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "medium.ts"), "x".repeat(1000));
    await fs.writeFile(path.join(tmpDir, "large.ts"), "x".repeat(10000));

    const files = await discoverContextFiles(tmpDir, "task", 500);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    expect(totalBytes).toBeLessThanOrEqual(500);
  });

  it("should handle empty repository gracefully", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-quality-"));
    const files = await discoverContextFiles(tmpDir, "task");
    expect(files).toEqual([]);
  });

  it("should handle repository with only sensitive files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgeai-quality-"));
    await fs.writeFile(path.join(tmpDir, ".env"), "SECRET=abc");
    await fs.writeFile(path.join(tmpDir, "credentials.json"), '{"key": "secret"}');
    await fs.writeFile(path.join(tmpDir, "id_rsa"), "key data");

    const files = await discoverContextFiles(tmpDir, "task");
    expect(files).toEqual([]);
  });
});
