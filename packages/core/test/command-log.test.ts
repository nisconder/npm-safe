import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  logCommand,
  sanitizeCommandArgv,
  type CommandLogEntry,
} from "../src/cli/command-log.js";

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_TS = path.resolve("src/cli/cli.ts");

const tempPaths: string[] = [];

after(() => {
  for (const p of tempPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeTempFile(): string {
  const f = path.join(os.tmpdir(), `npm-safe-cmdlog-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  tempPaths.push(f);
  try {
    unlinkSync(f);
  } catch {
    // ignore
  }
  return f;
}

describe("command-log", () => {
  it("redacts credentials while preserving ordinary diagnostic arguments", () => {
    assert.deepStrictEqual(
      sanitizeCommandArgv(["--db", "cache.db", "llm", "set-key", "sk-live-secret"]),
      ["--db", "cache.db", "llm", "set-key", "[REDACTED]"],
    );
    assert.deepStrictEqual(
      sanitizeCommandArgv(["settings", "set", "proxy", "https://user:pass@example.test"]),
      ["settings", "set", "proxy", "[REDACTED]"],
    );
    assert.deepStrictEqual(
      sanitizeCommandArgv(["--proxy=https://user:pass@example.test", "check", "lodash"]),
      ["--proxy=[REDACTED]", "check", "lodash"],
    );
    assert.deepStrictEqual(
      sanitizeCommandArgv(["install", "lodash", "--//registry.npmjs.org/:_authToken=top-secret"]),
      ["install", "lodash", "--//registry.npmjs.org/:_authToken=[REDACTED]"],
    );
    assert.deepStrictEqual(
      sanitizeCommandArgv(["check", "lodash", "--json"]),
      ["check", "lodash", "--json"],
    );
  });

  it("logCommand appends a valid JSONL line", () => {
    const tempPath = makeTempFile();
    const entry: CommandLogEntry = {
      timestamp: "2026-08-04T00:00:00.000Z",
      command: "check",
      argv: ["check", "lodash"],
      exitCode: 0,
      durationMs: 42,
    };
    logCommand(entry, tempPath);

    assert.ok(existsSync(tempPath), "log file should exist after logCommand");
    const content = readFileSync(tempPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 1, "exactly one JSONL line expected");

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.timestamp, "2026-08-04T00:00:00.000Z");
    assert.strictEqual(parsed.command, "check");
    assert.deepStrictEqual(parsed.argv, ["check", "lodash"]);
    assert.strictEqual(parsed.exitCode, 0);
    assert.strictEqual(parsed.durationMs, 42);
  });

  it("appends multiple entries as JSONL (one per line)", () => {
    const tempPath = makeTempFile();
    const first: CommandLogEntry = {
      timestamp: "2026-08-04T00:00:00.000Z",
      command: "check",
      argv: ["check", "lodash"],
      exitCode: 0,
      durationMs: 10,
    };
    const second: CommandLogEntry = {
      timestamp: "2026-08-04T00:01:00.000Z",
      command: "search",
      argv: ["search", "react"],
      exitCode: 0,
      durationMs: 25,
    };

    logCommand(first, tempPath);
    logCommand(second, tempPath);

    const content = readFileSync(tempPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 2, "two JSONL lines expected");

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.strictEqual(a.command, "check");
    assert.strictEqual(b.command, "search");

    // second line is the newer entry
    assert.ok(b.timestamp > a.timestamp, "second line should be the newer entry");
    assert.deepStrictEqual(b.argv, ["search", "react"]);
    assert.strictEqual(b.durationMs, 25);
  });

  it(
    "restricts a new command log to the current user",
    { skip: process.platform === "win32" },
    () => {
      const tempPath = makeTempFile();
      logCommand(
        {
          timestamp: "2026-08-04T00:00:00.000Z",
          command: "check",
          argv: ["check", "lodash"],
          exitCode: 0,
          durationMs: 1,
        },
        tempPath,
      );
      assert.strictEqual(statSync(tempPath).mode & 0o777, 0o600);
    },
  );

  it("never throws when the target directory is unwritable", () => {
    // Create a temp file and use it as the "parent directory" — mkdirSync on a
    // path whose parent is a file fails with ENOTDIR, which logCommand catches.
    const blockerDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cmdlog-block-"));
    tempPaths.push(blockerDir);
    const blockerFile = path.join(blockerDir, "blocker.txt");
    writeFileSync(blockerFile, "blocker", "utf8");

    const impossiblePath = path.join(blockerFile, "x.jsonl");

    assert.doesNotThrow(() => {
      logCommand(
        {
          timestamp: "2026-08-04T00:00:00.000Z",
          command: "check",
          argv: ["check"],
          exitCode: 0,
          durationMs: 1,
        },
        impossiblePath,
      );
    });

    // nothing should have been written anywhere new under blockerFile
    assert.ok(!existsSync(impossiblePath), "no output should be written to the impossible path");
  });

  it("CLI writes a command log line on real invocation", () => {
    const tempPath = makeTempFile();
    const result = spawnSync(
      "node",
      ["--import", "tsx", CLI_TS, "--version"],
      {
        encoding: "utf8",
        cwd: PACKAGE_DIR,
        env: { ...process.env, NPM_SAFE_COMMAND_LOG: tempPath },
      },
    );
    assert.strictEqual(result.status, 0, `CLI should exit 0; stderr=${result.stderr}`);

    assert.ok(existsSync(tempPath), "command log file should exist after CLI invocation");
    const content = readFileSync(tempPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 1, "exactly one JSONL line expected from one CLI invocation");

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(typeof parsed.timestamp, "string");
    assert.strictEqual(parsed.command, "(help)");
    assert.ok(Array.isArray(parsed.argv));
    assert.strictEqual(typeof parsed.exitCode, "number");
    assert.strictEqual(typeof parsed.durationMs, "number");
  });

  it("CLI never persists an LLM API key in the command log", () => {
    const tempPath = makeTempFile();
    const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-cmdlog-home-"));
    tempPaths.push(home);
    const apiKey = "sk-test-command-log-secret";
    const result = spawnSync(
      "node",
      ["--import", "tsx", CLI_TS, "llm", "set-key", apiKey],
      {
        encoding: "utf8",
        cwd: PACKAGE_DIR,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          NPM_SAFE_COMMAND_LOG: tempPath,
        },
      },
    );
    assert.strictEqual(result.status, 0, `CLI should exit 0; stderr=${result.stderr}`);

    const content = readFileSync(tempPath, "utf8");
    assert.ok(!content.includes(apiKey), "the raw API key must never be logged");
    const parsed = JSON.parse(content.trim()) as { argv: string[] };
    assert.deepStrictEqual(parsed.argv, ["llm", "set-key", "[REDACTED]"]);
  });
});
