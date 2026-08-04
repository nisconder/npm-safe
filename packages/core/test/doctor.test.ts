import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[], homeDir: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    {
      encoding: "utf8",
      cwd: PACKAGE_DIR,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
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
});
