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
    { encoding: "utf8", cwd: PACKAGE_DIR },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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

  it("shorthand: npm-safe <package> runs check", () => {
    const { stdout, status } = runCli(["lodash"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("Package: lodash"));
  });

  it("npm-safe check <package> still works", () => {
    const { stdout, status } = runCli(["check", "lodash"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("Package: lodash"));
  });

  it("watch list shows empty list", () => {
    const db = path.resolve("test-cli-watch.db");
    const { stdout, status } = runCli(["--db", db, "watch", "list"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("No packages on the watchlist"));
  });
});
