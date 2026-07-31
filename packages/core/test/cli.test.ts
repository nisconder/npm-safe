import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_TS = path.resolve("src/cli/cli.ts");
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", CLI_TS, ...args],
    {
      encoding: "utf8",
      // tsx is installed as a devDependency of @npm-safe/core, so run from
      // the package directory so the loader can be resolved.
      cwd: PACKAGE_DIR,
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
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
  });

  it("prints version", () => {
    const { stdout, status } = runCli(["--version"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.trim().startsWith("0."));
  });

  it("watch list shows empty list when no packages watched", () => {
    const db = path.resolve("test-cli-watch.db");
    const { stdout, status } = runCli(["--db", db, "watch", "list"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("No packages on the watchlist"));
  });
});
