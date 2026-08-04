import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    { encoding: "utf8", cwd: PACKAGE_DIR },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function tempProject(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-ci-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

describe("CLI ci", () => {
  it("fails when no package.json exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-ci-empty-"));
    try {
      const { status, stderr } = runCli(["--db", path.join(dir, "x.db"), "ci", "--dir", dir]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes("package.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the manifest has no dependencies", () => {
    const dir = tempProject({ name: "no-deps", version: "0.0.0" });
    try {
      const { status, stdout } = runCli(["--db", path.join(dir, "x.db"), "ci", "--dir", dir]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("No direct dependencies"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown fail level", () => {
    const dir = tempProject({ name: "x", version: "0.0.0", dependencies: {} });
    try {
      const { status, stderr } = runCli([
        "--db", path.join(dir, "x.db"),
        "ci", "--dir", dir, "--fail-level", "banana",
      ]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes("banana"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid rate limit", () => {
    const dir = tempProject({ name: "x", version: "0.0.0", dependencies: {} });
    try {
      const { status, stderr } = runCli([
        "--db", path.join(dir, "x.db"),
        "ci", "--dir", dir, "--rate-limit", "abc",
      ]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans real dependencies and passes for safe packages", () => {
    const dir = tempProject({
      name: "scan-test",
      version: "0.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    try {
      const db = path.join(dir, "x.db");
      const { status, stdout } = runCli(["--db", db, "ci", "--dir", dir, "--fail-level", "dangerous"]);
      assert.strictEqual(status, 0);
      assert.ok(stdout.includes("lodash"));
      assert.ok(stdout.includes("Passed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outputs a machine-readable JSON report with --json", () => {
    const dir = tempProject({
      name: "json-test",
      version: "0.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    try {
      const db = path.join(dir, "x.db");
      const { status, stdout } = runCli(["--db", db, "ci", "--dir", dir, "--json"]);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as {
        dependencyCount: number;
        failed: boolean;
        packages: Array<{ name: string; level: string }>;
      };
      assert.strictEqual(report.dependencyCount, 1);
      assert.strictEqual(report.failed, false);
      assert.ok(report.packages.some((p) => p.name === "lodash"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors --prod by skipping devDependencies", () => {
    const dir = tempProject({
      name: "prod-test",
      version: "0.0.0",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { chalk: "^4.1.2" },
    });
    try {
      const db = path.join(dir, "x.db");
      const { status, stdout } = runCli(["--db", db, "ci", "--dir", dir, "--prod", "--json"]);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as { dependencyCount: number };
      assert.strictEqual(report.dependencyCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when --lockfile is used without a lockfile", () => {
    const dir = tempProject({ name: "x", version: "0.0.0" });
    try {
      const { status, stderr } = runCli(["--db", path.join(dir, "x.db"), "ci", "--dir", dir, "--lockfile"]);
      assert.strictEqual(status, 1);
      assert.ok(stderr.includes("package-lock.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans transitive dependencies from a lockfile with --lockfile", () => {
    const dir = tempProject({
      name: "lock-test",
      version: "0.0.0",
      dependencies: { a: "^1.0.0" },
    });
    // npm lockfile v3 shape: packages map with node_modules/ keys.
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "lock-test",
        version: "0.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "lock-test", version: "0.0.0" },
          "node_modules/a": { version: "1.0.0" },
          "node_modules/b": { version: "2.0.0" },
          "node_modules/@scope/c": { version: "3.0.0" },
          "node_modules/a/node_modules/d": { version: "4.0.0" },
        },
      }),
    );
    try {
      const db = path.join(dir, "x.db");
      const { status, stdout } = runCli(["--db", db, "ci", "--dir", dir, "--lockfile", "--json", "--rate-limit", "100"]);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as {
        dependencyCount: number;
        packages: Array<{ name: string }>;
      };
      assert.strictEqual(report.dependencyCount, 4);
      const names = report.packages.map((p) => p.name);
      assert.ok(names.includes("a"));
      assert.ok(names.includes("b"));
      assert.ok(names.includes("@scope/c"));
      assert.ok(names.includes("d"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restricts --lockfile --prod to direct production dependencies", () => {
    const dir = tempProject({
      name: "lock-prod",
      version: "0.0.0",
      dependencies: { a: "^1.0.0" },
    });
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "lock-prod",
        version: "0.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "lock-prod", version: "0.0.0" },
          "node_modules/a": { version: "1.0.0" },
          "node_modules/b": { version: "2.0.0" },
        },
      }),
    );
    try {
      const db = path.join(dir, "x.db");
      const { status, stdout } = runCli(["--db", db, "ci", "--dir", dir, "--lockfile", "--prod", "--json", "--rate-limit", "100"]);
      assert.strictEqual(status, 0);
      const report = JSON.parse(stdout) as { dependencyCount: number };
      assert.strictEqual(report.dependencyCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
