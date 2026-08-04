import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[], env?: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    { encoding: "utf8", cwd: PACKAGE_DIR, env: env ? { ...process.env, ...env } : undefined },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Run a CLI command with a sandboxed home so last-batch.json is isolated. */
function runCliSandboxed(args: string[], homeDir: string): { stdout: string; stderr: string; status: number | null } {
  return runCli(args, { HOME: homeDir, USERPROFILE: homeDir });
}

describe("CLI", () => {
  it("prints help and lists all commands", () => {
    const { stdout, status } = runCli(["--help"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("Usage: npm-safe"));
    assert.ok(stdout.includes("check"));
    assert.ok(stdout.includes("search"));
    assert.ok(stdout.includes("watch"));
    assert.ok(stdout.includes("refresh"));
    assert.ok(stdout.includes("settings"));
    assert.ok(stdout.includes("lang"));
  });

  it("prints version", () => {
    const { stdout, status } = runCli(["--version"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.trim().startsWith("0."));
  });

  it("shorthand: npm-safe <package> runs check", () => {
    const db = path.resolve("test-cli-check.db");
    runCli(["--db", db, "lang", "en"]);
    const { stdout, status } = runCli(["--db", db, "lodash"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("Package: lodash"));
  });

  it("npm-safe check <package> still works", () => {
    const db = path.resolve("test-cli-check2.db");
    runCli(["--db", db, "lang", "en"]);
    const { stdout, status } = runCli(["--db", db, "check", "lodash"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("Package: lodash"));
  });

  it("watch list shows empty list", () => {
    const db = path.resolve("test-cli-watch.db");
    const { stdout, status } = runCli(["--db", db, "watch", "list"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("No packages on the watchlist"));
  });

  it("lang command switches to Chinese", () => {
    const db = path.resolve("test-cli-lang.db");
    const { stdout } = runCli(["--db", db, "lang", "zh"]);
    assert.ok(stdout.includes("zh"));

    const { stdout: s2 } = runCli(["--db", db, "watch", "list"]);
    assert.ok(s2.includes("监控列表中没有包"));
  });

  it("lang command switches back to English", () => {
    const db = path.resolve("test-cli-lang-en.db");
    runCli(["--db", db, "lang", "en"]);

    const { stdout } = runCli(["--db", db, "watch", "list"]);
    assert.ok(stdout.includes("No packages on the watchlist"));
  });

  it("check accepts multiple package names", () => {
    const db = path.resolve("test-cli-batch.db");
    runCli(["--db", db, "lang", "en"]);
    const { stdout, status } = runCli(["--db", db, "check", "lodash", "express"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("lodash"));
    assert.ok(stdout.includes("express"));
  });

  it("check --json outputs a batch report for multiple packages", () => {
    const db = path.resolve("test-cli-batch-json.db");
    runCli(["--db", db, "lang", "en"]);
    const { stdout, status } = runCli(["--db", db, "check", "lodash", "express", "--json"]);
    assert.strictEqual(status, 0);
    const results = JSON.parse(stdout) as Array<{ name: string; ok: boolean }>;
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.ok));
  });

  it("check --file reads package names from a file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cli-file-"));
    const file = path.join(dir, "pkgs.txt");
    writeFileSync(file, "# comment line\nlodash\nexpress\n");
    try {
      const db = path.resolve("test-cli-batch-file.db");
      runCli(["--db", db, "lang", "en"]);
      const { stdout, status } = runCli(["--db", db, "check", "--file", file, "--json"]);
      assert.strictEqual(status, 0);
      const results = JSON.parse(stdout) as Array<{ name: string }>;
      assert.deepStrictEqual(results.map((r) => r.name), ["lodash", "express"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check detail <n> renders the n-th package of the last batch", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cli-detail-"));
    const db = path.join(home, "detail.db");
    try {
      const batch = runCliSandboxed(["--db", db, "check", "lodash", "express"], home);
      assert.strictEqual(batch.status, 0);

      const first = runCliSandboxed(["--db", db, "check", "detail", "1"], home);
      assert.strictEqual(first.status, 0);
      assert.ok(first.stdout.includes("Package: lodash"));

      const second = runCliSandboxed(["--db", db, "check", "detail", "2"], home);
      assert.strictEqual(second.status, 0);
      assert.ok(second.stdout.includes("Package: express"));

      const json = runCliSandboxed(["--db", db, "check", "detail", "1", "--json"], home);
      const parsed = JSON.parse(json.stdout) as { packageName: string };
      assert.strictEqual(parsed.packageName, "lodash");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("check detail validates the index", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cli-detail-"));
    const db = path.join(home, "detail.db");
    try {
      const batch = runCliSandboxed(["--db", db, "check", "lodash", "express"], home);
      assert.strictEqual(batch.status, 0);

      const outOfRange = runCliSandboxed(["--db", db, "check", "detail", "99"], home);
      assert.strictEqual(outOfRange.status, 1);
      assert.ok(outOfRange.stderr.includes("index 99"));

      const invalid = runCliSandboxed(["--db", db, "check", "detail", "abc"], home);
      assert.strictEqual(invalid.status, 1);
      assert.ok(invalid.stderr.includes("abc"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("check detail reports when no batch has been run", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cli-detail-"));
    const db = path.join(home, "detail.db");
    try {
      const { status, stderr } = runCliSandboxed(["--db", db, "check", "detail", "1"], home);
      assert.strictEqual(status, 1);
      assert.ok(stderr.length > 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
