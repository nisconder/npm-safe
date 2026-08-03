import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[], homeDir?: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    {
      encoding: "utf8",
      cwd: PACKAGE_DIR,
      env: homeDir ? { ...process.env, HOME: homeDir, USERPROFILE: homeDir } : undefined,
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI report", () => {
  it("exports JSON to stdout by default", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    const db = path.join(home, "r.db");
    try {
      const { status, stdout } = runCli(["--db", db, "report", "lodash"], home);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as { count: number; packages: Array<{ name: string; ok: boolean }> };
      assert.strictEqual(report.count, 1);
      assert.strictEqual(report.packages[0].name, "lodash");
      assert.strictEqual(report.packages[0].ok, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exports CSV with the expected header and rows", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    const db = path.join(home, "r.db");
    try {
      const { status, stdout } = runCli(["--db", db, "report", "lodash", "express", "--format", "csv"], home);
      assert.strictEqual(status, 0);
      const lines = stdout.trim().split("\n");
      assert.strictEqual(lines[0], "name,version,level,score,findingCount");
      assert.ok(lines.some((l) => l.startsWith("lodash,")));
      assert.ok(lines.some((l) => l.startsWith("express,")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes to --output and reports the path", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    const db = path.join(home, "r.db");
    const out = path.join(home, "report.json");
    try {
      const { status, stdout } = runCli(["--db", db, "report", "lodash", "--output", out], home);
      assert.strictEqual(status, 0);
      assert.ok(existsSync(out));
      assert.ok(stdout.includes(out));
      const parsed = JSON.parse(readFileSync(out, "utf8")) as { count: number };
      assert.strictEqual(parsed.count, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exports the last batch with --batch", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    const db = path.join(home, "r.db");
    try {
      const batch = runCli(["--db", db, "check", "lodash", "express"], home);
      assert.strictEqual(batch.status, 0);
      const { status, stdout } = runCli(["--db", db, "report", "--batch", "--format", "csv"], home);
      assert.strictEqual(status, 0);
      const lines = stdout.trim().split("\n");
      assert.ok(lines.some((l) => l.startsWith("lodash,")));
      assert.ok(lines.some((l) => l.startsWith("express,")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails without any package source", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    try {
      const { status } = runCli(["--db", path.join(home, "r.db"), "report"], home);
      assert.strictEqual(status, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported format", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-report-"));
    try {
      const { status, stderr } = runCli(["--db", path.join(home, "r.db"), "report", "lodash", "--format", "xml"], home);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes("xml"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI telemetry", () => {
  it("is disabled by default and can be enabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-telemetry-cli-"));
    try {
      const before = runCli(["telemetry", "status", "--json"], home);
      assert.strictEqual(before.status, 0);
      assert.strictEqual((JSON.parse(before.stdout) as { enabled: boolean }).enabled, false);

      const enabled = runCli(["telemetry", "enable"], home);
      assert.strictEqual(enabled.status, 0);

      const after = runCli(["telemetry", "status", "--json"], home);
      assert.strictEqual((JSON.parse(after.stdout) as { enabled: boolean }).enabled, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("records check events once enabled", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-telemetry-cli-"));
    const db = path.join(home, "t.db");
    try {
      runCli(["telemetry", "enable"], home);
      const check = runCli(["--db", db, "check", "lodash", "express"], home);
      assert.strictEqual(check.status, 0);

      const { stdout } = runCli(["telemetry", "status", "--json"], home);
      const state = JSON.parse(stdout) as {
        enabled: boolean;
        counts: Record<string, number>;
        totalPackagesScanned: number;
        levelTotals: Record<string, number>;
        recentEvents: Array<{ event: string; packageCount: number }>;
      };
      assert.strictEqual(state.counts.check, 1);
      assert.strictEqual(state.totalPackagesScanned, 2);
      assert.strictEqual(state.recentEvents[0].event, "check");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exports telemetry to a file and resets", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-telemetry-cli-"));
    const db = path.join(home, "t.db");
    const out = path.join(home, "telemetry-export.json");
    try {
      runCli(["telemetry", "enable"], home);
      runCli(["--db", db, "check", "lodash"], home);

      const exported = runCli(["telemetry", "export", "--output", out], home);
      assert.strictEqual(exported.status, 0);
      const parsed = JSON.parse(readFileSync(out, "utf8")) as { counts: Record<string, number> };
      assert.strictEqual(parsed.counts.check, 1);

      const reset = runCli(["telemetry", "reset"], home);
      assert.strictEqual(reset.status, 0);
      const { stdout } = runCli(["telemetry", "status", "--json"], home);
      const state = JSON.parse(stdout) as { totalPackagesScanned: number };
      assert.strictEqual(state.totalPackagesScanned, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
