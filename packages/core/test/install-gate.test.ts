import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[], homeDir: string, input?: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    {
      encoding: "utf8",
      cwd: PACKAGE_DIR,
      input: input ?? "",
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI gate", () => {
  it("is disabled by default with threshold 85", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    try {
      const { status, stdout } = runCli(["gate", "status", "--json"], home);
      assert.strictEqual(status, 0);
      const config = JSON.parse(stdout) as { enabled: boolean; threshold: number };
      assert.strictEqual(config.enabled, false);
      assert.strictEqual(config.threshold, 85);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enable/disable/set-threshold persist to the settings table", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      assert.strictEqual(runCli(["--db", db, "gate", "enable"], home).status, 0);
      assert.strictEqual(runCli(["--db", db, "gate", "set-threshold", "70"], home).status, 0);
      const after = JSON.parse(runCli(["--db", db, "gate", "status", "--json"], home).stdout) as { enabled: boolean; threshold: number };
      assert.strictEqual(after.enabled, true);
      assert.strictEqual(after.threshold, 70);
      assert.strictEqual(runCli(["--db", db, "gate", "disable"], home).status, 0);
      const disabled = JSON.parse(runCli(["--db", db, "gate", "status", "--json"], home).stdout) as { enabled: boolean };
      assert.strictEqual(disabled.enabled, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an invalid threshold", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    try {
      const { status, stderr } = runCli(["gate", "set-threshold", "150"], home);
      assert.strictEqual(status, 1);
      assert.ok(stderr.length > 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI install gate flow", () => {
  it("passes safe packages without prompting when enabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable"], home);
      const { status, stdout } = runCli(["--db", db, "install", "lodash", "--dry-run", "--threshold", "85"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("lodash is safe"));
      assert.ok(stdout.includes("[dry-run]"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prompts for confirmation when a package is below the threshold", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable"], home);
      // axios scores ~74 (< 85): an input of "n" must abort with exit code 3.
      const aborted = runCli(["--db", db, "install", "axios", "--dry-run"], home, "n\n");
      assert.strictEqual(aborted.status, 3);
      assert.ok(aborted.stderr.includes("below 85"));

      // "y" continues to the dry-run line.
      const confirmed = runCli(["--db", db, "install", "axios", "--dry-run"], home, "y\n");
      assert.strictEqual(confirmed.status, 0);
      assert.ok(confirmed.stdout.includes("[dry-run]"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--yes skips the prompt", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable"], home);
      const { status, stdout } = runCli(["--db", db, "install", "axios", "--dry-run", "--yes"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("[dry-run]"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not gate when the gate is disabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      // Disabled by default: --dry-run should not check or prompt, just echo.
      const { status, stdout } = runCli(["--db", db, "install", "axios", "--dry-run"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("[dry-run]"));
      assert.ok(!stdout.includes("below 85"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("per-run --threshold overrides the configured value", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable"], home);
      // lodash scores ~97; threshold 99 makes it "below" and requires confirmation.
      const { status, stdout, stderr } = runCli(["--db", db, "install", "lodash", "--dry-run", "--threshold", "99"], home, "n\n");
      assert.strictEqual(status, 3);
      assert.ok(stderr.includes("below 99"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

