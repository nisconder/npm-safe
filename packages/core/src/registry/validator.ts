/**
 * Pure string-parsing validators for npm package names, semver versions,
 * and registry/repository domains.
 *
 * This module contains no network calls and no side effects — every
 * function is a pure transformation of its string input into a typed
 * validation result. Inputs are treated as untrusted: empty strings,
 * non-string values (rejected by the type system at compile time, but
 * defended against at runtime via narrowing), and Unicode homograph
 * attacks are all handled explicitly.
 *
 * @module registry/validator
 */

import type { ValidationResult } from './types.js';

/**
 * Maximum length of an npm package name, enforced by the public registry.
 *
 * @see https://github.com/npm/validate-npm-package-name#naming-rules
 */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * Regular expression matching a single path segment of an npm package name
 * (the part after an optional `@scope/` prefix). Per the registry naming
 * rules, segments must be lowercase, must not contain leading dots or
 * underscores, and may contain ASCII letters, digits, hyphens, underscores,
 * and dots — but no spaces or other special characters.
 */
const PACKAGE_NAME_SEGMENT_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

/**
 * Regular expression matching a semver version string with optional
 * pre-release and build-metadata identifiers, per the semver 2.0.0 spec.
 *
 * - Major.minor.patch: three dot-separated non-negative integer groups.
 * - Pre-release: hyphen followed by dot-separated alphanumeric identifiers.
 * - Build metadata: plus sign followed by dot-separated alphanumeric
 *   identifiers.
 *
 * @see https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Immutable whitelist of registry/repository domains recognised by the
 * tool. Used by {@link isKnownRegistryDomain} to gate trust decisions
 * without performing any network lookups.
 */
const KNOWN_REGISTRY_DOMAINS: ReadonlySet<string> = new Set<string>([
  'npmjs.com',
  'registry.npmjs.org',
  'github.com',
  'bitbucket.org',
  'gitlab.com',
]);

/**
 * Validate an npm package name according to the public registry's naming
 * rules. Accepts both unscoped (`lodash`) and scoped (`@babel/core`)
 * names.
 *
 * Rules enforced:
 * - Must be a non-empty string.
 * - Maximum length of 214 characters.
 * - Must be entirely lowercase (no uppercase letters).
 * - Must not contain spaces.
 * - Must not begin with a dot (`.`) or underscore (`_`).
 * - Scoped names use the `@scope/name` syntax; both `scope` and `name`
 *   segments must independently satisfy the segment naming rules.
 * - Rejects Unicode homograph look-alikes by restricting to ASCII
 *   lowercase letters, digits, hyphen, underscore, and dot.
 *
 * @param name - Candidate package name to validate.
 * @returns A {@link ValidationResult} indicating validity and, when
 *   invalid, a human-readable reason.
 */
export function validatePackageName(name: string): ValidationResult {
  if (typeof name !== 'string' || name.length === 0) {
    return { valid: false, reason: 'Package name must be a non-empty string.' };
  }

  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    return {
      valid: false,
      reason: `Package name must not exceed ${MAX_PACKAGE_NAME_LENGTH} characters.`,
    };
  }

  // Reject any uppercase letters outright — npm names are case-sensitive
  // and the registry only permits lowercase.
  if (name !== name.toLowerCase()) {
    return { valid: false, reason: 'Package name must be lowercase.' };
  }

  if (name.includes(' ')) {
    return { valid: false, reason: 'Package name must not contain spaces.' };
  }

  // Scoped package: @scope/name
  if (name.startsWith('@')) {
    const slashIndex = name.indexOf('/');
    if (slashIndex === -1) {
      return {
        valid: false,
        reason: 'Scoped package name must contain a "/" separator.',
      };
    }
    const scope = name.slice(1, slashIndex);
    const rest = name.slice(slashIndex + 1);

    if (scope.length === 0) {
      return { valid: false, reason: 'Package scope must not be empty.' };
    }
    if (rest.length === 0) {
      return { valid: false, reason: 'Package name segment must not be empty.' };
    }

    // Scope must not itself be scoped (no nested @s).
    if (scope.startsWith('@')) {
      return { valid: false, reason: 'Package scope must not be nested.' };
    }

    if (!PACKAGE_NAME_SEGMENT_PATTERN.test(scope)) {
      return {
        valid: false,
        reason: `Package scope "${scope}" contains invalid characters or a leading dot/underscore.`,
      };
    }
    if (!PACKAGE_NAME_SEGMENT_PATTERN.test(rest)) {
      return {
        valid: false,
        reason: `Package name segment "${rest}" contains invalid characters or a leading dot/underscore.`,
      };
    }
    return { valid: true };
  }

  // Unscoped package.
  if (name.startsWith('.') || name.startsWith('_')) {
    return {
      valid: false,
      reason: 'Package name must not begin with a dot or underscore.',
    };
  }

  if (!PACKAGE_NAME_SEGMENT_PATTERN.test(name)) {
    return {
      valid: false,
      reason: `Package name "${name}" contains invalid characters.`,
    };
  }

  return { valid: true };
}

/**
 * Validate that a string is a compliant semantic version (semver 2.0.0).
 *
 * Accepts strings of the form `MAJOR.MINOR.PATCH` with optional pre-release
 * (`-prerelease`) and build metadata (`+build`) identifiers. Numeric
 * components with leading zeros (e.g. `01.2.3`) are rejected, matching the
 * semver specification.
 *
 * @param version - Candidate version string to validate.
 * @returns `true` when the string is a valid semver version, `false`
 *   otherwise.
 */
export function validateVersion(version: string): boolean {
  if (typeof version !== 'string' || version.length === 0) {
    return false;
  }
  return SEMVER_PATTERN.test(version);
}

/**
 * Result of {@link validateDomain}. The `domain` field is always present
 * (empty string when parsing fails) so callers can destructure safely.
 */
export interface DomainValidationResult {
  /** `true` when the input parsed into a URL with a usable hostname. */
  readonly valid: boolean;
  /** Lowercased hostname extracted from the URL, or empty string on failure. */
  readonly domain: string;
}

/**
 * Validate a URL string and extract its hostname.
 *
 * Handles edge cases including:
 * - Missing protocol (defaults to `https://`).
 * - Relative URLs (rejected — no hostname).
 * - Invalid URL syntax (rejected).
 * - Unicode hostnames (returned as-is, lowercased; punycode conversion is
 *   the caller's responsibility).
 *
 * @param url - Candidate URL string to parse.
 * @returns A {@link DomainValidationResult} with the parsed hostname
 *   (lowercased) when valid, or an empty domain when parsing fails.
 */
export function validateDomain(url: string): DomainValidationResult {
  if (typeof url !== 'string' || url.length === 0) {
    return { valid: false, domain: '' };
  }

  // Reject relative URLs early: a usable registry/repository URL must have
  // a scheme. If none is present, prepend `https://` as a convenience for
  // inputs like `github.com/user/repo`.
  let candidate = url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, domain: '' };
  }

  const hostname = parsed.hostname;
  if (hostname.length === 0) {
    return { valid: false, domain: '' };
  }

  return { valid: true, domain: hostname.toLowerCase() };
}

/**
 * Check whether a domain is a known npm registry or source-control host.
 *
 * The whitelist includes `npmjs.com`, `registry.npmjs.org`, `github.com`,
 * `bitbucket.org`, and `gitlab.com`. Comparison is case-insensitive and
 * exact — subdomains are not automatically trusted (callers must normalise
 * or extend the check if wildcard matching is desired).
 *
 * @param domain - Hostname to check against the known-domain whitelist.
 * @returns `true` when the domain (case-insensitively) matches a known
 *   registry/repository host, `false` otherwise.
 */
export function isKnownRegistryDomain(domain: string): boolean {
  if (typeof domain !== 'string' || domain.length === 0) {
    return false;
  }
  return KNOWN_REGISTRY_DOMAINS.has(domain.toLowerCase());
}