/**
 * TypeScript type definitions for the npm registry API v2.
 *
 * This file is the foundational types module for the registry package. It
 * contains no runtime code and no local imports — only type declarations
 * describing the shapes returned by the npm registry's JSON endpoints
 * (package metadata, abbreviated packuments, search results) plus the
 * utility types used across the registry layer.
 *
 * @see https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
 */

/**
 * A person or entity associated with a package, either as an author or a
 * maintainer. npm accepts both the structured form and a free-form string.
 */
export type PackagePerson =
  | {
      readonly name: string;
      readonly email?: string;
      readonly url?: string;
    }
  | string;

/**
 * Repository descriptor for a package. May be a structured object with a
 * type and url, or a shorthand string (e.g. `github:user/repo`).
 */
export type PackageRepository =
  | {
      readonly type: string;
      readonly url: string;
    }
  | string;

/**
 * Distribution metadata attached to a published package version. Returned
 * by the registry under the `dist` key of each version entry.
 */
export interface DistMetadata {
  /** Subresource Integrity (SRI) hash, e.g. `sha512-...`. */
  readonly integrity?: string;
  /** Legacy SHA-1 hex digest of the tarball. */
  readonly shasum?: string;
  /** Absolute URL to the downloadable `.tgz` tarball. */
  readonly tarball: string;
  /** Number of files contained in the tarball. */
  readonly fileCount?: number;
  /** Unpacked size of the tarball contents in bytes. */
  readonly unpackedSize?: number;
  /** Cryptographic signatures attached to the tarball. */
  readonly signatures?: ReadonlyArray<{
    readonly keyid: string;
    readonly sig: string;
  }>;
}

/**
 * Abbreviated packument for a single published version. This is the shape
 * used by the registry's abbreviated metadata endpoint and by the `versions`
 * map inside {@link PackageMetadata}.
 */
export interface AbbreviatedVersion {
  /** Package name (scoped names include the leading `@`). */
  readonly name: string;
  /** Semver version string. */
  readonly version: string;
  /** Legacy SHA-1 hex digest (mirrored from `dist.shasum`). */
  readonly shasum?: string;
  /** Subresource Integrity hash (mirrored from `dist.integrity`). */
  readonly integrity?: string;
  /** Runtime dependency ranges keyed by package name. */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** Development-only dependency ranges keyed by package name. */
  readonly devDependencies?: Readonly<Record<string, string>>;
  /** Optional dependency ranges keyed by package name. */
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  /** Peer dependency ranges keyed by package name. */
  readonly peerDependencies?: Readonly<Record<string, string>>;
  /** Names of bundled dependencies. */
  readonly bundleDependencies?: ReadonlyArray<string>;
  /** Deprecation message; presence marks the version as deprecated. */
  readonly deprecated?: string;
  /** Whether the version ships an install lifecycle script. */
  readonly hasInstallScript?: boolean;
  /** Whether the version ships an npm-shrinkwrap.json. */
  readonly hasShrinkwrap?: boolean;
  /** Distribution metadata for the tarball. */
  readonly dist: DistMetadata;
  /** Engine constraints keyed by engine name (e.g. `node`, `npm`). */
  readonly engines?: Readonly<Record<string, string>>;
  /** Internal flag mirroring {@link hasShrinkwrap}. */
  readonly _hasShrinkwrap?: boolean;
  /** Lifecycle scripts keyed by script name. */
  readonly scripts?: Readonly<Record<string, string>>;
  /** Executable binaries exposed by the package, keyed by bin name. */
  readonly bin?: Readonly<Record<string, string>>;
  /** Legacy directory layout descriptors. */
  readonly directories?: Readonly<Record<string, string>>;
}

/**
 * Full package metadata (packument) as returned by the registry's
 * `GET /{package}` endpoint. The `versions` map is keyed by semver version
 * string and contains abbreviated version entries.
 */
export interface PackageMetadata {
  /** Package name (scoped names include the leading `@`). */
  readonly name: string;
  /** ISO-8601 timestamp of the most recent modification. */
  readonly modified: string;
  /** Distribution tags keyed by tag name (e.g. `latest`) pointing to versions. */
  readonly 'dist-tags': Readonly<Record<string, string>>;
  /** All published versions keyed by semver version string. */
  readonly versions: Readonly<Record<string, AbbreviatedVersion>>;
  /** Short human-readable description. */
  readonly description?: string;
  /** URL to the package's homepage. */
  readonly homepage?: string;
  /** Source repository descriptor. */
  readonly repository?: PackageRepository;
  /** Search/discoverability keywords. */
  readonly keywords?: ReadonlyArray<string>;
  /** Original package author. */
  readonly author?: PackagePerson;
  /** Current maintainers of the package. */
  readonly maintainers?: ReadonlyArray<{
    readonly name: string;
    readonly email: string;
  }>;
  /** SPDX license identifier or license text. */
  readonly license?: string;
  /** Full readme contents. */
  readonly readme?: string;
  /** Filename of the readme (e.g. `README.md`). */
  readonly readmeFilename?: string;
  /** Publication timestamps keyed by version (plus `created`/`modified`). */
  readonly time?: Readonly<Record<string, string>>;
}

/**
 * A single hit from the registry's `GET /-/v1/search` endpoint.
 */
export interface SearchResult {
  /** The package document portion of the search hit. */
  readonly package: {
    /** Package name (scoped names include the leading `@`). */
    readonly name: string;
    /** Scope of the package without the `@`, or empty string if unscoped. */
    readonly scope: string;
    /** Semver version of the hit (typically the latest). */
    readonly version: string;
    /** Short human-readable description. */
    readonly description?: string;
    /** Search/discoverability keywords. */
    readonly keywords?: ReadonlyArray<string>;
    /** ISO-8601 publication timestamp of the version. */
    readonly date: string;
    /** Canonical links for the package. */
    readonly links: {
      /** URL to the package page on the registry. */
      readonly npm: string;
      /** URL to the package's homepage. */
      readonly homepage?: string;
      /** URL to the source repository. */
      readonly repository?: string;
      /** URL to the issue tracker. */
      readonly bugs?: string;
    };
    /** Publisher of the version. */
    readonly publisher: {
      readonly username: string;
      readonly email: string;
    };
    /** Maintainers of the package. */
    readonly maintainers: ReadonlyArray<{
      readonly username: string;
      readonly email: string;
    }>;
  };
  /** Search relevance and quality scores. */
  readonly score: {
    /** Aggregated final score in the range [0, 1]. */
    readonly final: number;
    /** Breakdown of the final score into sub-scores. */
    readonly detail: {
      /** Quality sub-score in the range [0, 1]. */
      readonly quality: number;
      /** Popularity sub-score in the range [0, 1]. */
      readonly popularity: number;
      /** Maintenance sub-score in the range [0, 1]. */
      readonly maintenance: number;
    };
  };
  /** Internal search score used for ranking; may differ from `score.final`. */
  readonly searchScore: number;
}

/**
 * Error thrown by registry clients when a request fails or returns a
 * non-success status. Carries the HTTP status code and status text when
 * available so callers can branch on specific failure modes.
 */
export class NpmRegistryError extends Error {
  /**
   * @param message - Human-readable error message.
   * @param statusCode - HTTP status code from the response, if any.
   * @param statusText - HTTP status text from the response, if any.
   */
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly statusText?: string,
  ) {
    super(message);
    this.name = 'NpmRegistryError';
  }
}

/**
 * Outcome of validating a package identifier or version string.
 */
export interface ValidationResult {
  /** `true` when the validated value is acceptable. */
  readonly valid: boolean;
  /** Human-readable explanation when {@link valid} is `false`. */
  readonly reason?: string;
}

/**
 * A parsed package identifier combining name, optional scope, and optional
 * version into a single immutable value.
 */
export interface PackageIdentifier {
  /** Package name without scope prefix. */
  readonly name: string;
  /** Semver version string, if specified. */
  readonly version?: string;
  /** Scope without the leading `@`, if the package is scoped. */
  readonly scope?: string;
  /** Fully-qualified name: `@scope/name` when scoped, otherwise `name`. */
  readonly fullName: string;
}