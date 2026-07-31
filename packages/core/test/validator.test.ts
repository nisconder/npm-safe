import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePackageName,
  validateVersion,
  validateDomain,
  isKnownRegistryDomain,
} from "../src/registry/validator.js";

// ============================================================================
// validatePackageName
// ============================================================================

describe("validatePackageName", () => {
  // --- valid unscoped names ---
  it("accepts a simple unscoped name", () => {
    assert.deepStrictEqual(validatePackageName("lodash"), {
      valid: true,
    });
  });

  it("accepts name with hyphens", () => {
    assert.deepStrictEqual(validatePackageName("my-cool-package"), {
      valid: true,
    });
  });

  it("accepts name with dots and underscores", () => {
    assert.deepStrictEqual(validatePackageName("dot.env_file"), {
      valid: true,
    });
  });

  it("accepts name starting and ending with digit", () => {
    assert.deepStrictEqual(validatePackageName("7zip"), { valid: true });
  });

  // --- valid scoped names ---
  it("accepts a scoped package name", () => {
    assert.deepStrictEqual(validatePackageName("@babel/core"), {
      valid: true,
    });
  });

  it("accepts scoped name with hyphens in scope", () => {
    assert.deepStrictEqual(validatePackageName("@my-scope/pkg"), {
      valid: true,
    });
  });

  it("accepts scoped name with dots in name", () => {
    assert.deepStrictEqual(validatePackageName("@types/node.fs"), {
      valid: true,
    });
  });

  // --- edge cases: length ---
  it("accepts name at max length (214 chars)", () => {
    const name = "a".repeat(214);
    assert.deepStrictEqual(validatePackageName(name), { valid: true });
  });

  it("rejects name exceeding max length (215 chars)", () => {
    const name = "a".repeat(215);
    assert.deepStrictEqual(validatePackageName(name), {
      valid: false,
      reason: "Package name must not exceed 214 characters.",
    });
  });

  // --- invalid: empty / non-string ---
  it("rejects empty string", () => {
    assert.deepStrictEqual(validatePackageName(""), {
      valid: false,
      reason: "Package name must be a non-empty string.",
    });
  });

  it("rejects whitespace-only", () => {
    const result = validatePackageName(" ");
    assert.strictEqual(result.valid, false);
  });

  // --- invalid: case ---
  it("rejects uppercase characters", () => {
    const result = validatePackageName("Lodash");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("lowercase"));
  });

  it("rejects mixed-case scoped name", () => {
    const result = validatePackageName("@Babel/Core");
    assert.strictEqual(result.valid, false);
  });

  // --- invalid: spaces ---
  it("rejects name containing spaces", () => {
    const result = validatePackageName("my package");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("spaces"));
  });

  // --- invalid: leading dot / underscore ---
  it("rejects name starting with dot", () => {
    const result = validatePackageName(".hidden-pkg");
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.reason?.includes("begin with a dot"),
    );
  });

  it("rejects name starting with underscore", () => {
    const result = validatePackageName("_private");
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.reason?.includes("begin with a dot"),
    );
  });

  // --- invalid: scoped names ---
  it("rejects scoped name without '/' separator", () => {
    const result = validatePackageName("@noscope");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes('"/" separator'));
  });

  it("rejects scoped name with empty scope", () => {
    const result = validatePackageName("@/pkg");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("scope must not be empty"));
  });

  it("rejects scoped name with empty name segment", () => {
    const result = validatePackageName("@scope/");
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.reason?.includes("name segment must not be empty"),
    );
  });

  it("rejects name segment starting with @", () => {
    const result = validatePackageName("@outer/@inner");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("invalid characters"));
  });

  // --- invalid: special characters ---
  it("rejects name with special chars like !", () => {
    const result = validatePackageName("bad!");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes("invalid characters"));
  });

  it("rejects Unicode homograph characters (Cyrillic)", () => {
    const result = validatePackageName("evo"); // using ASCII for demonstration
    assert.strictEqual(result.valid, true);
    // Real homograph test: Cyrillic 'а' (U+0430) in "lodash"
    const homograph = "lod\u0430sh"; // lodаsh with Cyrillic a
    const r = validatePackageName(homograph);
    assert.strictEqual(r.valid, false);
    assert.ok(r.reason?.includes("invalid characters"));
  });
});

// ============================================================================
// validateVersion
// ============================================================================

describe("validateVersion", () => {
  it("accepts a simple semver (1.2.3)", () => {
    assert.strictEqual(validateVersion("1.2.3"), true);
  });

  it("accepts a leading-zero-free version (0.0.1)", () => {
    assert.strictEqual(validateVersion("0.0.1"), true);
  });

  it("accepts a large version number", () => {
    assert.strictEqual(validateVersion("999999.999999.999999"), true);
  });

  it("accepts pre-release identifiers", () => {
    assert.strictEqual(validateVersion("1.0.0-alpha.1"), true);
  });

  it("accepts build metadata", () => {
    assert.strictEqual(validateVersion("1.0.0+build.2024"), true);
  });

  it("accepts pre-release with build metadata", () => {
    assert.strictEqual(
      validateVersion("1.0.0-beta.1+build.42"),
      true,
    );
  });

  // --- invalid ---
  it("rejects empty string", () => {
    assert.strictEqual(validateVersion(""), false);
  });

  it("rejects partial semver (1.2)", () => {
    assert.strictEqual(validateVersion("1.2"), false);
  });

  it("rejects non-numeric version (a.b.c)", () => {
    assert.strictEqual(validateVersion("a.b.c"), false);
  });

  it("rejects leading zero in major (01.2.3)", () => {
    assert.strictEqual(validateVersion("01.2.3"), false);
  });

  it("rejects leading zero in minor (1.02.3)", () => {
    assert.strictEqual(validateVersion("1.02.3"), false);
  });

  it("rejects leading zero in patch (1.2.03)", () => {
    assert.strictEqual(validateVersion("1.2.03"), false);
  });

  it("rejects v-prefixed version (v1.2.3)", () => {
    assert.strictEqual(validateVersion("v1.2.3"), false);
  });

  it("rejects version with trailing characters", () => {
    assert.strictEqual(validateVersion("1.2.3 "), false);
  });

  it("rejects single number (1)", () => {
    assert.strictEqual(validateVersion("1"), false);
  });

  it("rejects negative numbers", () => {
    assert.strictEqual(validateVersion("-1.2.3"), false);
  });
});

// ============================================================================
// validateDomain
// ============================================================================

describe("validateDomain", () => {
  it("extracts domain from a full URL", () => {
    const result = validateDomain("https://registry.npmjs.org/package");
    assert.deepStrictEqual(result, {
      valid: true,
      domain: "registry.npmjs.org",
    });
  });

  it("prepends https:// for bare domain", () => {
    const result = validateDomain("github.com/user/repo");
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.domain, "github.com");
  });

  it("lowercases the domain", () => {
    const result = validateDomain("HTTPS://GitHub.com");
    assert.strictEqual(result.domain, "github.com");
  });

  it("returns invalid for empty string", () => {
    const result = validateDomain("");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.domain, "");
  });

  it("returns valid for relative paths (treated as hostname)", () => {
    const result = validateDomain("/relative/path");
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.domain, "relative");
  });

  it("returns invalid for invalid URL syntax", () => {
    const result = validateDomain("not a url at all !!!");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.domain, "");
  });
});

// ============================================================================
// isKnownRegistryDomain
// ============================================================================

describe("isKnownRegistryDomain", () => {
  it("recognizes registry.npmjs.org", () => {
    assert.strictEqual(
      isKnownRegistryDomain("registry.npmjs.org"),
      true,
    );
  });

  it("recognizes npmjs.com", () => {
    assert.strictEqual(isKnownRegistryDomain("npmjs.com"), true);
  });

  it("recognizes github.com", () => {
    assert.strictEqual(isKnownRegistryDomain("github.com"), true);
  });

  it("recognizes gitlab.com", () => {
    assert.strictEqual(isKnownRegistryDomain("gitlab.com"), true);
  });

  it("recognizes bitbucket.org", () => {
    assert.strictEqual(isKnownRegistryDomain("bitbucket.org"), true);
  });

  it("recognizes domain case-insensitively", () => {
    assert.strictEqual(
      isKnownRegistryDomain("REGISTRY.NPMJS.ORG"),
      true,
    );
  });

  it("rejects unknown domain", () => {
    assert.strictEqual(
      isKnownRegistryDomain("evil-registry.io"),
      false,
    );
  });

  it("rejects empty string", () => {
    assert.strictEqual(isKnownRegistryDomain(""), false);
  });

  it("rejects subdomains of known hosts", () => {
    assert.strictEqual(
      isKnownRegistryDomain("evil.github.com"),
      false,
    );
  });
});
