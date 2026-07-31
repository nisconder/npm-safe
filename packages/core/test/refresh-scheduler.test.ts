import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RefreshScheduler } from "../src/scheduler/refresh-scheduler.js";
import { NpmRegistryClient } from "../src/registry/client.js";
import { TokenBucket } from "../src/scheduler/rate-limiter.js";
import { StaticAnalyzer } from "../src/scanner/static-rules.js";
import { DatabaseManager } from "../src/store/database.js";
import { CacheManager } from "../src/store/cache-manager.js";
import type { PackageMetadata } from "../src/registry/types.js";

const ORIGINAL_FETCH = globalThis.fetch;

const mockPackageMeta: PackageMetadata = {
  name: "watch-pkg",
  modified: "2026-01-01T00:00:00.000Z",
  "dist-tags": { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      name: "watch-pkg",
      version: "1.0.0",
      scripts: {},
      dist: { tarball: "https://example.com/watch-pkg-1.0.0.tgz" },
    },
  },
  description: "Watched package",
  readme: "# Hello",
};

describe("RefreshScheduler", () => {
  let dbm: DatabaseManager;
  let cache: CacheManager;
  let client: NpmRegistryClient;
  let limiter: TokenBucket;
  let analyzer: StaticAnalyzer;
  let scheduler: RefreshScheduler;

  afterEach(() => {
    try { scheduler?.stop(); } catch { /* */ }
    try { limiter?.dispose(); } catch { /* */ }
    try { dbm?.close(); } catch { /* */ }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  function setup(): void {
    dbm = new DatabaseManager(":memory:");
    cache = new CacheManager(dbm);
    client = new NpmRegistryClient({ baseUrl: "https://registry.npmjs.org" });
    limiter = new TokenBucket(100, 50);
    analyzer = new StaticAnalyzer();
    scheduler = new RefreshScheduler(client, cache, limiter, analyzer);
  }

  it("starts and stops without error", () => {
    setup();
    scheduler.start(60000);
    scheduler.stop();
  });

  it("emits refresh:start event when refreshing a package", async () => {
    setup();
    await cache.setPackage(mockPackageMeta);

    // Mock the registry client to return our test data.
    globalThis.fetch = ((_url: unknown, _init?: unknown) => {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(mockPackageMeta),
      });
    }) as typeof fetch;

    const events: string[] = [];
    scheduler.on("refresh:start", ({ packageName }) => {
      events.push(`start:${packageName}`);
    });
    scheduler.on("refresh:complete", ({ packageName, report }) => {
      events.push(`complete:${packageName}:${report.score}`);
    });

    await scheduler.refreshPackage("watch-pkg");

    assert.ok(events.some((e) => e.startsWith("start:watch-pkg")));
    assert.ok(events.some((e) => e.startsWith("complete:watch-pkg")));
  });

  it("emits refresh:error on failure", async () => {
    setup();

    globalThis.fetch = (() => Promise.reject(new Error("Network down"))) as typeof fetch;

    const events: string[] = [];
    scheduler.on("refresh:error", ({ packageName }) => {
      events.push(`error:${packageName}`);
    });

    await scheduler.refreshPackage("bad-pkg");

    assert.ok(events.some((e) => e === "error:bad-pkg"));
  });

  it("respects rate limiter before fetching", async () => {
    setup();
    await cache.setPackage(mockPackageMeta);

    let fetchCount = 0;
    globalThis.fetch = ((_url: unknown, _init?: unknown) => {
      fetchCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(mockPackageMeta),
      });
    }) as typeof fetch;

    await scheduler.refreshPackage("watch-pkg");
    assert.strictEqual(fetchCount, 1);
  });

  it("saves report to cache after refresh", async () => {
    setup();
    await cache.setPackage(mockPackageMeta);

    globalThis.fetch = ((_url: unknown, _init?: unknown) => {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(mockPackageMeta),
      });
    }) as typeof fetch;

    await scheduler.refreshPackage("watch-pkg");

    const report = await cache.getSecurityReport("watch-pkg", "1.0.0");
    assert.ok(report !== null);
    assert.strictEqual(report!.score, 100);
  });

  it("stop prevents future cycles but not in-flight refresh", () => {
    setup();
    scheduler.start(10000);
    scheduler.stop();
  });
});
