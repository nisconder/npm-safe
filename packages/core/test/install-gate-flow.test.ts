import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StaticAnalyzer } from "../src/scanner/static-rules.js";
import { RuleConfigManager } from "../src/scanner/rule-config.js";
import { CacheManager } from "../src/store/cache-manager.js";
import { DatabaseManager } from "../src/store/database.js";
import { SecurityLevel } from "../src/scanner/types.js";
import type { PackageMetadata } from "../src/registry/types.js";

const CORE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_TEST = import.meta.url.endsWith(".ts");
const CLI = path.join(CORE_DIR, "src", "cli", SOURCE_TEST ? "cli.ts" : "cli.js");
const LOADER_ARGS = SOURCE_TEST
  ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
  : [];

interface Invocation {
  readonly pm: string;
  readonly argv: string[];
  readonly cwd: string;
}

interface GateReport {
  readonly threshold: number;
  readonly packages: Array<{
    name: string;
    version: string;
    score: number;
    belowThreshold: boolean;
    requiresConfirmation: boolean;
  }>;
}

const METADATA: PackageMetadata = {
  name: "flow-fixture",
  modified: "2026-01-01T00:00:00.000Z",
  "dist-tags": { latest: "2.0.0", old: "1.0.0" },
  versions: Object.fromEntries(["1.0.0", "2.0.0"].map((version) => [version, {
    name: "flow-fixture",
    version,
    dist: { tarball: `https://registry.npmjs.org/flow-fixture/-/flow-fixture-${version}.tgz` },
  }])),
  readme: "Offline install-gate flow fixture.",
};

async function fixture(project: Record<string, unknown> = { packageManager: "npm@10.0.0" }) {
  const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe gate-flow-"));
  const root = path.join(home, "project");
  mkdirSync(root);
  const dbPath = path.join(root, "cache.db");
  const callsPath = path.join(root, "pm-calls.jsonl");
  const networkPath = path.join(root, "unexpected-network.jsonl");
  const preloadPath = path.join(root, "offline-preload.mjs");
  const writerPath = path.join(root, "record-pm.mjs");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "offline-project", ...project }));
  mkdirSync(path.join(home, ".npm-safe"));
  writeFileSync(path.join(home, ".npm-safe", "llm.json"), JSON.stringify({ enabled: false }));
  const globalConfig = path.join(home, "global.npmrc");
  writeFileSync(globalConfig, "");

  // No fixture may silently miss the cache and contact a registry or LLM. The
  // tripwire terminates immediately instead of waiting through HTTP retries.
  writeFileSync(preloadPath, `
import fs from 'node:fs';
import os from 'node:os';
try { os.userInfo(); } catch {
  os.userInfo = () => ({ username: 'offline-test', uid: -1, gid: -1, shell: null, homedir: process.env.HOME });
}
globalThis.fetch = (url) => {
  fs.appendFileSync(${JSON.stringify(networkPath)}, JSON.stringify(String(url)) + '\\n');
  process.exit(91);
};
`);
  writeFileSync(writerPath, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  pm: process.argv[2], argv: process.argv.slice(3), cwd: process.cwd()
}) + '\\n');
if (process.env.NPMSAFE_PM_LOG === '1') console.log('added 1 package in 1s');
process.exitCode = Number(process.env.NPMSAFE_PM_EXIT || '0');
`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    NODE_OPTIONS: "",
  };
  // A developer's registry/configuration environment must not affect fixtures.
  for (const name of Object.keys(env)) {
    if (/^(?:npm_config_|yarn_)/i.test(name)) delete env[name];
  }
  env.npm_config_globalconfig = globalConfig;
  for (const pm of ["npm", "pnpm", "yarn"]) {
    const binary = path.join(root, process.platform === "win32" ? `${pm}.cmd` : pm);
    if (process.platform === "win32") {
      writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${writerPath}" ${pm} %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(writerPath)} ${pm} "$@"\n`);
      chmodSync(binary, 0o755);
    }
    env[`NPMSAFE_REAL_${pm.toUpperCase()}`] = binary;
  }

  const db = new DatabaseManager(dbPath);
  try {
    const cache = new CacheManager(db);
    await cache.setSetting("installGate.enabled", "true");
    await cache.setSetting("installGate.threshold", "85");
    await cache.setPackage(METADATA);
    for (const [version, score] of [["1.0.0", 25], ["2.0.0", 100]] as const) {
      await cache.setSecurityReport({
        scannerFingerprint: new StaticAnalyzer(undefined, new RuleConfigManager(path.join(home, ".npm-safe", "rules.json"))).getFingerprint(),
        packageName: METADATA.name,
        version,
        overallLevel: score === 100 ? SecurityLevel.Safe : SecurityLevel.Dangerous,
        score,
        findings: [],
        scannedAt: new Date().toISOString(),
      });
    }
  } finally {
    db.close();
  }

  return {
    root,
    home,
    run(args: string[], options?: { input?: string; exit?: number; log?: boolean; env?: NodeJS.ProcessEnv }) {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(preloadPath).href, ...LOADER_ARGS, CLI, "--db", dbPath, ...args,
      ], {
        cwd: root,
        env: { ...env, ...options?.env, NPMSAFE_PM_EXIT: String(options?.exit ?? 0), NPMSAFE_PM_LOG: options?.log ? "1" : "0" },
        encoding: "utf8",
        input: options?.input ?? "",
        timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(existsSync(networkPath), false, `Unexpected network request: ${existsSync(networkPath) ? readFileSync(networkPath, "utf8") : ""}`);
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    },
    calls(): Invocation[] {
      return existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    async threshold(value: string) {
      const database = new DatabaseManager(dbPath);
      try {
        await new CacheManager(database).setSetting("installGate.threshold", value);
      } finally {
        database.close();
      }
    },
    close() { rmSync(home, { recursive: true, force: true }); },
  };
}

describe("offline install-gate command flows", () => {
  it("preserves the caller's manager and verb and runs its pinned target exactly once", async () => {
    const context = await fixture({ packageManager: "yarn@1.22.0" });
    try {
      const result = context.run(["install", "--pm", "pnpm", "--verb", "i", "--", "flow-fixture@^2"], { exit: 17 });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(context.calls(), [{ pm: "pnpm", argv: ["i", "flow-fixture@2.0.0"], cwd: context.root }]);
    } finally {
      context.close();
    }
  });

  it("checks the requested old range rather than approving it using the safe latest version", async () => {
    const context = await fixture();
    try {
      const denied = context.run(["install", "--pm=npm", "--json", "flow-fixture@^1"]);
      assert.equal(denied.status, 3, denied.stderr);
      const report = JSON.parse(denied.stdout) as GateReport;
      assert.equal(report.packages[0]?.version, "1.0.0");
      assert.equal(report.packages[0]?.score, 25);
      assert.equal(report.packages[0]?.requiresConfirmation, true);
      assert.deepEqual(context.calls(), []);

      const approved = context.run(["install", "--pm=npm", "--yes", "flow-fixture@^1"]);
      assert.equal(approved.status, 0, approved.stderr);
      assert.deepEqual(context.calls().map((call) => call.argv), [["install", "flow-fixture@1.0.0"]]);
    } finally {
      context.close();
    }
  });

  it("keeps both local --json and global -j machine-readable when EOF rejects risk", async () => {
    const context = await fixture();
    try {
      for (const args of [
        ["install", "--json", "flow-fixture@old"],
        ["-j", "install", "flow-fixture@old"],
      ]) {
        const result = context.run(args);
        assert.equal(result.status, 3, result.stderr);
        const report = JSON.parse(result.stdout) as GateReport;
        assert.equal(report.threshold, 85);
        assert.equal(report.packages[0]?.belowThreshold, true);
      }
      assert.deepEqual(context.calls(), []);
    } finally {
      context.close();
    }
  });

  it("keeps JSON stdout parseable when the actual manager prints ordinary install logs", async () => {
    const context = await fixture();
    try {
      const result = context.run(["install", "--pm=npm", "--json", "flow-fixture@^2"], { log: true });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as GateReport;
      assert.equal(report.packages[0]?.version, "2.0.0");
      assert.match(result.stderr, /added 1 package in 1s/);
      assert.deepEqual(context.calls().map((call) => call.argv), [["install", "flow-fixture@2.0.0"]]);
    } finally {
      context.close();
    }
  });

  it("rejects private home/project/environment registries before execution and accepts public configuration", async () => {
    const context = await fixture();
    try {
      for (const config of [path.join(context.home, ".npmrc"), path.join(context.root, ".npmrc")]) {
        writeFileSync(config, "registry=https://private.example.test/\n");
        const denied = context.run(["install", "--pm=npm", "flow-fixture"]);
        assert.equal(denied.status, 1, denied.stderr);
        assert.match(denied.stderr, /registry/i);
        assert.deepEqual(context.calls(), []);
        rmSync(config);
      }
      const denied = context.run(["install", "--pm=npm", "flow-fixture"], {
        env: { npm_config_registry: "https://private.example.test/" },
      });
      assert.equal(denied.status, 1, denied.stderr);
      assert.match(denied.stderr, /registry/i);
      assert.deepEqual(context.calls(), []);

      writeFileSync(path.join(context.home, ".npmrc"), "registry=https://registry.npmjs.org/\n");
      writeFileSync(path.join(context.root, ".npmrc"), "@scope:registry=https://registry.npmjs.org/\n");
      const allowed = context.run(["install", "--pm=npm", "--json", "flow-fixture"], {
        env: { npm_config_registry: "https://registry.npmjs.org/" },
      });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal((JSON.parse(allowed.stdout) as GateReport).packages[0]?.version, "2.0.0");
      assert.deepEqual(context.calls().map((call) => call.argv), [["install", "flow-fixture@2.0.0"]]);
    } finally {
      context.close();
    }
  });

  it("does not scan registry/workspace values or overwrite an identical workspace name", async () => {
    const context = await fixture();
    try {
      const result = context.run([
        "install", "--pm=npm", "--json", "--", "--registry", "https://registry.npmjs.org/",
        "--workspace", "flow-fixture", "flow-fixture",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as GateReport;
      assert.equal(report.packages.length, 1);
      assert.equal(report.packages[0]?.version, "2.0.0");
      assert.deepEqual(context.calls().map((call) => call.argv), [[
        "install", "--registry", "https://registry.npmjs.org/", "--workspace", "flow-fixture", "flow-fixture@2.0.0",
      ]]);
    } finally {
      context.close();
    }
  });

  it("never launches the manager when a gate or package-manager option is missing its value", async () => {
    const context = await fixture();
    try {
      for (const option of ["--threshold", "--dir", "--pm", "--verb", "--registry"]) {
        const result = context.run(["install", option]);
        assert.equal(result.status, 1, `${option}: ${result.stderr}`);
      }
      assert.deepEqual(context.calls(), []);
    } finally {
      context.close();
    }
  });

  it("falls back to threshold 85 when a persisted threshold is malformed or out of range", async () => {
    const context = await fixture();
    try {
      for (const value of ["0oops", "101", "-1"]) {
        await context.threshold(value);
        const result = context.run(["gate", "status", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as GateReport).threshold, 85);
      }
      assert.deepEqual(context.calls(), []);
    } finally {
      context.close();
    }
  });

  it("requires confirmation for an unresolved bare yarn install and preserves the bare verb", async () => {
    const context = await fixture({ packageManager: "yarn@1.22.0", dependencies: { "flow-fixture": "^2" } });
    try {
      writeFileSync(path.join(context.root, "yarn.lock"), '# yarn lockfile v1\n"flow-fixture@^2":\n  version "2.0.0"\n');
      const denied = context.run(["install", "--pm=yarn", "--verb=install", "--json"]);
      assert.equal(denied.status, 3, denied.stderr);
      assert.equal((JSON.parse(denied.stdout) as GateReport).packages[0]?.version, "2.0.0");
      assert.deepEqual(context.calls(), []);

      const approved = context.run(["install", "--pm=yarn", "--verb=install", "--yes"]);
      assert.equal(approved.status, 0, approved.stderr);
      assert.deepEqual(context.calls(), [{ pm: "yarn", argv: ["install"], cwd: context.root }]);
    } finally {
      context.close();
    }
  });
});
