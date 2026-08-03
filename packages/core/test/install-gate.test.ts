import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
      assert.strictEqual(runCli(["--db", db, "gate", "enable", "--no-shell"], home).status, 0);
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

  it("installs shell wrappers automatically when enabling with an existing config", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    const rc = path.join(home, ".bashrc");
    try {
      writeFileSync(rc, "# existing shell config\n");
      const { status, stdout } = runCli(["--db", db, "gate", "enable", "--shell-file", rc], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("Gate wrappers installed"));
      const content = readFileSync(rc, "utf8");
      assert.ok(content.includes("# >>> npm-safe gate >>>"));
      assert.ok(content.includes("pnpm()"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips wrapper installation with --no-shell", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    const rc = path.join(home, ".bashrc");
    try {
      writeFileSync(rc, "# existing shell config\n");
      const { status, stdout } = runCli(["--db", db, "gate", "enable", "--no-shell", "--shell-file", rc], home);
      assert.strictEqual(status, 0);
      assert.ok(!stdout.includes("Gate wrappers installed"));
      assert.ok(!readFileSync(rc, "utf8").includes("npm-safe gate"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs and removes shell wrappers idempotently", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const rc = path.join(home, ".bashrc");
    try {
      const first = runCli(["gate", "shell", "--file", rc], home);
      assert.strictEqual(first.status, 0);
      const content = readFileSync(rc, "utf8");
      assert.ok(content.includes("# >>> npm-safe gate >>>"));
      assert.ok(content.includes("pnpm()"));
      assert.ok(content.includes("npm-safe install"));

      // Idempotent: a second run must not duplicate the block.
      const second = runCli(["gate", "shell", "--file", rc], home);
      assert.strictEqual(second.status, 0);
      const occurrences = readFileSync(rc, "utf8").split("# >>> npm-safe gate >>>").length - 1;
      assert.strictEqual(occurrences, 1);

      const removed = runCli(["gate", "shell", "--file", rc, "--remove"], home);
      assert.strictEqual(removed.status, 0);
      assert.ok(!readFileSync(rc, "utf8").includes("npm-safe gate"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes PowerShell wrappers on Windows-style files", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const ps1 = path.join(home, "profile.ps1");
    try {
      const { status, stdout } = runCli(["gate", "shell", "--file", ps1], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes(ps1));
      const content = readFileSync(ps1, "utf8");
      assert.ok(content.includes("function pnpm"));
      assert.ok(content.includes("Get-Command pnpm.cmd"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it(
    "installs PATH shims on Windows when no --file is given",
    { skip: process.platform !== "win32" },
    () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
      try {
        const { status, stdout } = runCli(["gate", "shell"], home);
        assert.strictEqual(status, 0);
        assert.ok(stdout.includes("shims"));
        const shimDir = path.join(home, ".npm-safe", "bin");
        for (const pm of ["npm", "pnpm", "yarn"]) {
          const file = path.join(shimDir, `${pm}.cmd`);
          assert.ok(existsSync(file), `${file} should exist`);
          const content = readFileSync(file, "utf8");
          assert.ok(content.includes(`NPMSAFE_REAL_${pm.toUpperCase()}`));
          assert.ok(content.includes("npm-safe install"));
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "gate shell --remove cleans up the shims",
    { skip: process.platform !== "win32" },
    () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
      try {
        const install = runCli(["gate", "shell"], home);
        assert.strictEqual(install.status, 0);
        const shimDir = path.join(home, ".npm-safe", "bin");
        assert.ok(existsSync(path.join(shimDir, "npm.cmd")));

        const remove = runCli(["gate", "shell", "--remove"], home);
        assert.strictEqual(remove.status, 0);
        assert.ok(!existsSync(path.join(shimDir, "npm.cmd")));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe("CLI install gate flow", () => {
  it("passes safe packages without prompting when enabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable", "--no-shell"], home);
      const { status, stdout } = runCli(["--db", db, "install", "lodash", "--dry-run", "--threshold", "85"], home);
      assert.strictEqual(status, 0);
      // Safe packages still print the full check result (level, version, score, findings).
      assert.ok(stdout.includes("[safe] lodash@"));
      assert.ok(stdout.includes("/100"));
      assert.ok(stdout.includes("[dry-run]"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--json prints the full check results for every package", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable", "--no-shell"], home);
      const { status, stdout } = runCli(["--db", db, "install", "lodash", "express", "--dry-run", "--json"], home);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as {
        threshold: number;
        packages: Array<{ name: string; level: string; score: number; belowThreshold: boolean }>;
      };
      assert.strictEqual(report.threshold, 85);
      assert.strictEqual(report.packages.length, 2);
      assert.ok(report.packages.every((p) => p.name && p.level && typeof p.score === "number"));
      assert.ok(report.packages.every((p) => p.belowThreshold === false));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prompts for confirmation when a package is below the threshold", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable", "--no-shell"], home);
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
      runCli(["--db", db, "gate", "enable", "--no-shell"], home);
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

  it("detects pnpm projects and uses pnpm add", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "p", version: "0.0.0" }));
      writeFileSync(path.join(home, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const { status, stdout } = runCli(["--db", db, "install", "--dry-run", "--dir", home, "lodash"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("pnpm add lodash"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects npm projects and uses npm install", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "p", version: "0.0.0" }));
      writeFileSync(path.join(home, "package-lock.json"), "{\"lockfileVersion\":3}\n");
      const { status, stdout } = runCli(["--db", db, "install", "--dry-run", "--dir", home, "lodash"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("npm install lodash"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes through unknown flags to the package manager", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "p", version: "0.0.0" }));
      writeFileSync(path.join(home, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const { status, stdout } = runCli(["--db", db, "install", "--dry-run", "--dir", home, "-D", "@scope/pkg@^2.0.0"], home);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("pnpm add -D @scope/pkg@^2.0.0"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("per-run --threshold overrides the configured value", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-gate-"));
    const db = path.join(home, "g.db");
    try {
      runCli(["--db", db, "gate", "enable", "--no-shell"], home);
      // lodash scores ~97; threshold 99 makes it "below" and requires confirmation.
      const { status, stdout, stderr } = runCli(["--db", db, "install", "lodash", "--dry-run", "--threshold", "99"], home, "n\n");
      assert.strictEqual(status, 3);
      assert.ok(stderr.includes("below 99"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});




