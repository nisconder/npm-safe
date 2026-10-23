import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_TS = path.join(PACKAGE_DIR, "src/cli/cli.ts");

function runCli(args: string[], homeDir: string, env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_TS, ...args],
    {
      encoding: "utf8",
      cwd: PACKAGE_DIR,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ...env },
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI doctor", () => {
  it("reports on a fresh sandbox (gate disabled, problems flagged)", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    try {
      const { status, stdout } = runCli(["doctor"], home);
      // Non-zero exit because the sandbox has problems (disabled gate, etc.).
      assert.strictEqual(status, 1);
      assert.ok(stdout.includes("npm-safe doctor"));
      assert.ok(stdout.includes("Install gate: disabled"));
      assert.ok(stdout.includes("problem(s) found"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects an enabled gate with shims installed", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    try {
      const enable = runCli(["gate", "enable", "--no-shell"], home);
      assert.strictEqual(enable.status, 0);
      // Install the shims into the sandbox home explicitly.
      const shell = runCli(["gate", "shell"], home);
      assert.strictEqual(shell.status, 0);

      const { stdout } = runCli(["doctor"], home);
      assert.ok(stdout.includes("Install gate: enabled"));
      const shimDir = path.join(home, ".npm-safe", "bin");
      // .cmd shims only exist on Windows; other platforms use profile wrappers.
      if (process.platform === "win32") {
        assert.ok(existsSync(path.join(shimDir, "npm.cmd")));
        assert.ok(stdout.includes(shimDir));
      } else {
        assert.ok(stdout.includes("Shell wrappers"));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("diagnoses the database selected with --db without changing its settings", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    const db = path.join(home, "selected.db");
    try {
      assert.strictEqual(runCli(["--db", db, "gate", "enable", "--no-shell"], home).status, 0);
      assert.strictEqual(runCli(["--db", db, "gate", "set-threshold", "61"], home).status, 0);
      assert.strictEqual(runCli(["--db", db, "settings", "set", "__npm_safe_doctor__", "keep"], home).status, 0);

      const { stdout } = runCli(["--db", db, "--proxy", "http://127.0.0.1:1", "doctor"], home);
      assert.ok(stdout.includes("Install gate: enabled (threshold 61)"), stdout);
      assert.ok(stdout.includes(`Database writable: ${db}`), stdout);
      assert.ok(!existsSync(path.join(home, ".npm-safe", "npm-safe.db")), "must not create or inspect the default database");
      const saved = runCli(["--db", db, "settings", "get", "__npm_safe_doctor__"], home);
      assert.strictEqual(saved.stdout.trim(), "keep", "the write probe must roll back");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("continues diagnostics and reports a corrupt selected database", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    const db = path.join(home, "corrupt.db");
    try {
      writeFileSync(db, "not a SQLite database");
      const { status, stdout, stderr } = runCli(["--db", db, "doctor"], home);
      assert.strictEqual(status, 1);
      assert.ok(stdout.includes(`Install gate configuration could not be read: ${db}`), stdout);
      assert.ok(stdout.includes(`Database not writable: ${db}`), stdout);
      assert.ok(stdout.includes("problem(s) found"), stdout);
      assert.ok(!stderr.includes("DatabaseManagerError:"), stderr);
      assert.ok(!existsSync(path.join(home, ".npm-safe", "npm-safe.db")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a blocked default database directory without aborting", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    try {
      writeFileSync(path.join(home, ".npm-safe"), "directory is unavailable");
      const { status, stdout, stderr } = runCli(["doctor"], home);
      assert.strictEqual(status, 1);
      assert.ok(stdout.includes("Install gate configuration could not be read"), stdout);
      assert.ok(stdout.includes("Database not writable"), stdout);
      assert.ok(stdout.includes("problem(s) found"), stdout);
      assert.ok(!stderr.includes("Error:"), stderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recognizes Windows PATH casing, quoted entries and short-path variants", { skip: process.platform !== "win32" }, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    try {
      assert.strictEqual(runCli(["gate", "shell"], home).status, 0);
      const shimDir = path.join(home, ".npm-safe", "bin");
      const globalBin = path.join(home, "npm");
      const { stdout } = runCli(["doctor"], home, {
        APPDATA: home,
        PATH: `${shimDir.toUpperCase()};"${globalBin.toUpperCase()}";${process.env.PATH ?? ""}`,
      });
      assert.ok(stdout.includes(`✓ npm global bin in PATH: ${globalBin}`), stdout);
      assert.ok(stdout.includes("✓ Shim directory present in PATH"), stdout);
      assert.ok(stdout.includes("✓ npm resolves to the gate shim first"), stdout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("checks prefix/bin rather than the npm prefix on Unix", { skip: process.platform === "win32" }, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-doctor-"));
    try {
      const prefix = path.join(home, "global");
      const bin = path.join(prefix, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nprintf '%s\\n' \"$npm_config_prefix\"\n", { mode: 0o755 });
      const { stdout } = runCli(["doctor"], home, {
        npm_config_prefix: prefix,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      assert.ok(stdout.includes(`✓ npm global bin in PATH: ${bin}`), stdout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
