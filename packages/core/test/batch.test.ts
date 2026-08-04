import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NpmSafeEngine } from "../src/index.js";
import type { PackageMetadata } from "../src/registry/types.js";

const ORIGINAL_FETCH = globalThis.fetch;

function meta(name: string, version: string, postinstall?: string): PackageMetadata {
  return {
    name,
    modified: "2026-01-01T00:00:00.000Z",
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        scripts: postinstall
          ? { postinstall }
          : { test: "jest" },
        dist: { tarball: `https://example.com/${name}-${version}.tgz` },
      },
    },
    description: `Package ${name}`,
    readme: `# ${name}\n\nHarmless.`,
  };
}

describe("NpmSafeEngine.checkPackages", () => {
  let tmpDir: string;
  let engine: NpmSafeEngine;

  afterEach(() => {
    try {
      engine?.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("checks multiple packages and preserves input order", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-batch-"));
    engine = new NpmSafeEngine({
      dbPath: path.join(tmpDir, "test.db"),
      rateLimit: 1000,
      rateLimitBurst: 50,
    });

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("safe-lib")) {
        return new Response(JSON.stringify(meta("safe-lib", "1.0.0")));
      }
      if (url.includes("other-lib")) {
        return new Response(JSON.stringify(meta("other-lib", "2.0.0")));
      }
      if (url.includes("missing-pkg")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const results = await engine.checkPackages(["safe-lib", "other-lib", "missing-pkg"], {
      concurrency: 3,
    });

    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(
      results.map((r) => r.name),
      ["safe-lib", "other-lib", "missing-pkg"],
    );
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(results[0].result?.latestVersion, "1.0.0");
    assert.strictEqual(results[1].ok, true);
    assert.strictEqual(results[1].result?.latestVersion, "2.0.0");
    // A 404 yields exists: false rather than an error.
    assert.strictEqual(results[2].ok, true);
    assert.strictEqual(results[2].result?.exists, false);
  });

  it("isolates network failures and reports them per package", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-batch-"));
    engine = new NpmSafeEngine({
      dbPath: path.join(tmpDir, "test.db"),
      rateLimit: 1000,
      rateLimitBurst: 50,
    });

    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("broken")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response(JSON.stringify(meta("good-lib", "1.0.0")));
    }) as typeof fetch;

    const results = await engine.checkPackages(["good-lib", "broken"], { concurrency: 2 });
    assert.strictEqual(results[0].ok, true);
    assert.strictEqual(results[1].ok, false);
    assert.ok(results[1].error?.includes("ECONNREFUSED"));
  });

  it("invokes the progress callback for every completed package", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-batch-"));
    engine = new NpmSafeEngine({
      dbPath: path.join(tmpDir, "test.db"),
      rateLimit: 1000,
      rateLimitBurst: 50,
    });

    globalThis.fetch = (async (input: unknown) => {
      const name = String(input).split("/")[3] ?? "pkg";
      return new Response(JSON.stringify(meta(name, "1.0.0")));
    }) as typeof fetch;

    const calls: Array<[number, number]> = [];
    await engine.checkPackages(["a", "b", "c", "d"], {
      concurrency: 2,
      onProgress: (done, total) => calls.push([done, total]),
    });

    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(calls[3], [4, 4]);
  });

  it("uses cached results for packages checked before", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-batch-"));
    engine = new NpmSafeEngine({
      dbPath: path.join(tmpDir, "test.db"),
      rateLimit: 1000,
      rateLimitBurst: 50,
    });

    let fetches = 0;
    globalThis.fetch = (async (input: unknown) => {
      fetches++;
      return new Response(JSON.stringify(meta("cached-lib", "1.0.0")));
    }) as typeof fetch;

    await engine.checkPackages(["cached-lib"], { concurrency: 1 });
    const before = fetches;
    const second = await engine.checkPackages(["cached-lib", "cached-lib"], { concurrency: 2 });
    assert.strictEqual(fetches, before, "second batch should hit the cache");
    assert.strictEqual(second.length, 2);
    assert.ok(second.every((r) => r.ok));
  });
});
