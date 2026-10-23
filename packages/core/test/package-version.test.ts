import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePackageVersion } from "../src/registry/package-version.js";
import type { PackageMetadata } from "../src/registry/types.js";

function metadata(): PackageMetadata {
  const name = "versioned-library";
  return {
    name,
    modified: "2026-01-01T00:00:00.000Z",
    "dist-tags": { latest: "2.0.0", legacy: "1.0.0", next: "3.0.0-beta.1" },
    versions: Object.fromEntries([
      "1.0.0", "1.2.0", "1.9.0", "2.0.0", "2.5.0", "3.0.0-beta.1", "3.0.0-beta.2",
    ].map((version) => [version, {
      name,
      version,
      dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
    }])),
  };
}

describe("published package version resolution", () => {
  it("resolves the default tag, named tags and exact versions", () => {
    const meta = metadata();
    assert.strictEqual(resolvePackageVersion(meta), "2.0.0");
    assert.strictEqual(resolvePackageVersion(meta, "latest"), "2.0.0");
    assert.strictEqual(resolvePackageVersion(meta, "legacy"), "1.0.0");
    assert.strictEqual(resolvePackageVersion(meta, "next"), "3.0.0-beta.1");
    assert.strictEqual(resolvePackageVersion(meta, "1.2.0"), "1.2.0");
    assert.strictEqual(resolvePackageVersion(meta, "3.0.0-beta.2"), "3.0.0-beta.2");
  });

  it("honors semver ranges and prefers the latest tag when it satisfies the range", () => {
    const meta = metadata();
    assert.strictEqual(resolvePackageVersion(meta, "^1.0.0"), "1.9.0");
    assert.strictEqual(resolvePackageVersion(meta, "~1.2.0"), "1.2.0");
    assert.strictEqual(resolvePackageVersion(meta, ">=1.0.0 <1.9.0"), "1.2.0");
    assert.strictEqual(resolvePackageVersion(meta, "1.0.0 - 1.2.0"), "1.2.0");
    assert.strictEqual(resolvePackageVersion(meta, "^2.0.0"), "2.0.0");
    assert.strictEqual(resolvePackageVersion(meta, "*"), "2.0.0");
  });

  it("includes prereleases only when the request permits them", () => {
    const meta = metadata();
    assert.strictEqual(resolvePackageVersion(meta, ">=3.0.0-beta.1 <3.0.0"), "3.0.0-beta.2");
    assert.throws(() => resolvePackageVersion(meta, "^3.0.0"), /no published version matching/);
    assert.throws(() => resolvePackageVersion(meta, ">2.5.0"), /no published version matching/);
  });

  it("fails when an exact version, tag or range has no published match", () => {
    for (const requested of ["99.0.0", "missing-tag", "^99.0.0", "file:../local", "npm:other@1", "1.2.3.4", "constructor"]) {
      assert.throws(() => resolvePackageVersion(metadata(), requested), /no published version matching/, requested);
    }
  });

  it("fails when a dist-tag is absent or points to an unpublished version", () => {
    const meta = metadata();
    assert.throws(() => resolvePackageVersion({ ...meta, "dist-tags": {} }), /no published version matching/);
    assert.throws(() => resolvePackageVersion({ ...meta, "dist-tags": { latest: "99.0.0" } }), /no published version matching/);
    assert.throws(() => resolvePackageVersion({ ...meta, "dist-tags": { next: "99.0.0" } }, "next"), /no published version matching/);
  });
});
