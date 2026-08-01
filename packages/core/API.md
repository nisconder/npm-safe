# @npm-safe/core API Reference (Phase 1)

This document describes every public export from `@npm-safe/core` in Phase 1. Signatures are copied from the source and reflect the exact runtime behaviour of the code at `packages/core/src/`.

---

## Table of Contents

- [Installation](#installation)
- [Import Notes](#import-notes)
- [NpmSafeEngine](#npmsafeengine)
- [NpmSafeEngineOptions](#npmsafeengineoptions)
- [CheckResult](#checkresult)
- [Enums](#enums)
  - [SecurityLevel](#securitylevel)
  - [Severity](#severity)
  - [ScanType](#scantype)
  - [FindingCategory](#findingcategory)
- [Scanner Types](#scanner-types)
  - [ScanFinding](#scanfinding)
  - [ScanRule](#scanrule)
  - [StaticScanReport](#staticscanreport)
  - [LlmScanReport](#llmscanreport)
  - [ScanReport](#scanreport)
  - [SecuritySummary](#securitysummary)
- [Registry Types](#registry-types)
  - [NpmRegistryError](#npmregistryerror)
  - [PackageMetadata](#packagemetadata)
  - [AbbreviatedVersion](#abbreviatedversion)
  - [DistMetadata](#distmetadata)
  - [SearchResult](#searchresult)
  - [ValidationResult](#validationresult)
  - [PackageIdentifier](#packageidentifier)
  - [PackageRepository](#packagerepository)
  - [PackagePerson](#packageperson)
  - [DomainValidationResult](#domainvalidationresult)
- [Internal But Reusable Exports](#internal-but-reusable-exports)
  - [Registry Client](#registry-client)
  - [Static Analyzer](#static-analyzer)
  - [Database Manager](#database-manager)
  - [Cache Manager](#cache-manager)
  - [Rate Limiter (Token Bucket)](#rate-limiter-token-bucket)
  - [Refresh Scheduler](#refresh-scheduler)
  - [Validator Functions](#validator-functions)

---

## Installation

```bash
pnpm add @npm-safe/core
```

## Import Notes

All TypeScript enums in this package are **string enums**. They exist at runtime as values and must be imported with a value import, not a type-only import:

```ts
// Correct — SecurityLevel is a runtime value
import { SecurityLevel } from '@npm-safe/core';

// Incorrect — will not compile
import type { SecurityLevel } from '@npm-safe/core';
```

Interfaces and type aliases may use `import type`:

```ts
import type { CheckResult, ScanFinding } from '@npm-safe/core';
```

---

## NpmSafeEngine

The main facade class. Composes the database, cache, registry client, rate limiter, static analyser, and refresh scheduler into a single public API surface.

```ts
class NpmSafeEngine
```

### Constructor

```ts
constructor(options?: NpmSafeEngineOptions)
```

Creates all internal collaborators (DatabaseManager, CacheManager, NpmRegistryClient, TokenBucket, StaticAnalyzer, RefreshScheduler) using the defaults or values provided in `options`.

### Methods

#### checkPackage

```ts
checkPackage(name: string): Promise<CheckResult>
```

Check a package by name. Cache-first: returns cached data if still fresh, otherwise fetches from the registry, runs static analysis, and caches the result.

When the package does not exist on the registry (HTTP 404), the returned `CheckResult` has `exists: false` and the `security` / `registryInfo` fields are empty. All other errors (network failure, timeout) are rethrown.

#### searchPackages

```ts
searchPackages(query: string, size?: number): Promise<SearchResult[]>
```

Search the npm registry for packages matching a text query. Delegates to `NpmRegistryClient.searchPackages`. `size` defaults to `20`.

#### getWatchlist

```ts
getWatchlist(): Promise<string[]>
```

Returns the list of package names currently on the watchlist, in insertion order.

#### addToWatchlist

```ts
addToWatchlist(name: string): Promise<void>
```

Add a package to the watchlist. Idempotent: adding a name already watched is a no-op.

#### removeFromWatchlist

```ts
removeFromWatchlist(name: string): Promise<void>
```

Remove a package from the watchlist. No-op if the name was not watched.

#### refreshPackage

```ts
refreshPackage(name: string): Promise<boolean>
```

Refresh a single package: fetch its latest metadata from the registry, re-run static analysis, and persist the results. Per-package failures are surfaced via the scheduler's `refresh:error` event rather than thrown; the returned promise resolves after emitting the error so a failing package does not abort a batch.

#### refreshAll

```ts
refreshAll(): Promise<boolean>
```

Refresh every package whose cached metadata has passed its TTL. Packages are processed sequentially so the rate limiter is respected.

#### startAutoRefresh

```ts
startAutoRefresh(intervalMs?: number): void
```

Start the periodic auto-refresh loop. Returns `void`, not a Promise. The first refresh cycle kicks off immediately in the background; subsequent cycles repeat at `intervalMs`. Defaults to `3_600_000` (1 hour). Calling while already running resets the interval (idempotent restart).

#### stopAutoRefresh

```ts
stopAutoRefresh(): void
```

Stop the periodic auto-refresh loop. Safe to call when the scheduler is not running. Any in-flight refresh continues to completion.

#### getSetting

```ts
getSetting(key: string): Promise<string | null>
```

Retrieve a setting value by key. Returns `null` when the key is unset.

#### setSetting

```ts
setSetting(key: string, value: string): Promise<void>
```

Upsert a setting value by key (INSERT OR REPLACE semantics).

#### close

```ts
close(): void
```

Release all resources held by the engine. Stops the auto-refresh scheduler, disposes the rate limiter timer, and closes the database connection. Idempotent. After calling this method the engine instance must not be used for further operations.

---

## NpmSafeEngineOptions

Options accepted by the `NpmSafeEngine` constructor. All fields are optional.

```ts
interface NpmSafeEngineOptions {
  readonly dbPath?: string;
  readonly registryUrl?: string;
  readonly rateLimit?: number;
  readonly rateLimitBurst?: number;
  readonly cacheTtlMs?: number;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dbPath` | `string` | `'./npm-safe.db'` | Filesystem path to the SQLite database file. |
| `registryUrl` | `string` | `'https://registry.npmjs.org'` | Base URL of the npm registry. |
| `rateLimit` | `number` | `5` | Token bucket refill rate (tokens per second). |
| `rateLimitBurst` | `number` | `10` | Maximum burst size for the token bucket. |
| `cacheTtlMs` | `number` | `3600000` | Cache TTL for package metadata in milliseconds. |
| `llm` | `OpenAICompatibleLlmOptions` | unset | Optional OpenAI-compatible semantic security scan. |

When using the CLI, set `OPENAI_API_KEY`. `OPENAI_BASE_URL` and `OPENAI_MODEL`
can override the API endpoint and model. LLM analysis is optional and static
scanning remains available when it is not configured.

---

## CheckResult

Returned by `NpmSafeEngine.checkPackage`.

```ts
interface CheckResult {
  readonly packageName: string;
  readonly exists: boolean;
  readonly latestVersion: string;
  readonly security: {
    readonly overallLevel: SecurityLevel;
    readonly overallScore: number;
    readonly staticScan: StaticScanReport | null;
    readonly llmScan?: LlmScanReport;
  };
  readonly registryInfo: {
    readonly description: string;
    readonly homepage: string;
    readonly repository: string;
  } | null;
  readonly cachedAt: string | null;
}
```

| Field | Description |
|-------|-------------|
| `packageName` | Name of the checked package. |
| `exists` | Whether the package exists on the registry. |
| `latestVersion` | The latest available version, or an empty string when `exists` is `false`. |
| `security.overallLevel` | Overall security level derived from the combined scan. |
| `security.overallScore` | Numeric security score (0-100, higher is safer). |
| `security.staticScan` | Full static scan report, or `null` if one is not available. |
| `registryInfo.description` | Human-readable description of the package. |
| `registryInfo.homepage` | URL to the package's homepage. |
| `registryInfo.repository` | Repository descriptor as a string (e.g. `"github:user/repo"`). |
| `cachedAt` | ISO-8601 timestamp of when this result was last cached, or `null` when the exact cached-at time is not known. |

---

## Enums

### SecurityLevel

```ts
enum SecurityLevel {
  Safe = 'safe',
  Suspicious = 'suspicious',
  Dangerous = 'dangerous',
  Unknown = 'unknown',
}
```

Overall security classification for a scanned package. String enum, usable in `switch` statements.

### Severity

```ts
enum Severity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}
```

Severity of an individual scan finding. String enum.

### ScanType

```ts
enum ScanType {
  Static = 'static',
  Llm = 'llm',
}
```

The kind of scan that produced a report or finding. String enum.

### FindingCategory

```ts
enum FindingCategory {
  InstallScript = 'install-script',
  CodeObfuscation = 'code-obfuscation',
  BinaryDownload = 'binary-download',
  SensitiveExposure = 'sensitive-exposure',
  Typosquatting = 'typosquatting',
  SuspiciousDep = 'suspicious-dependency',
  HomographAttack = 'homograph-attack',
  RegistryMismatch = 'registry-mismatch',
  KnownMalicious = 'known-malicious',
  Informational = 'informational',
}
```

Categorisation of what a finding represents. String enum.

---

## Scanner Types

### ScanFinding

A single issue discovered during a security scan.

```ts
interface ScanFinding {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: Severity;
  readonly message: string;
  readonly codeSnippet?: string;
  readonly lineNumber?: number;
  readonly recommendation?: string;
  readonly category: FindingCategory;
}
```

| Field | Description |
|-------|-------------|
| `ruleId` | Stable identifier of the rule that produced this finding. |
| `ruleName` | Human-readable name of the rule. |
| `severity` | How severe this finding is. |
| `message` | Human-readable description of the issue. |
| `codeSnippet` | Optional code snippet that triggered the finding. |
| `lineNumber` | Optional 1-based line number where the issue was detected. |
| `recommendation` | Optional remediation guidance. |
| `category` | Category classifying the nature of this finding. |

### ScanRule

A rule that inspects package metadata and README content to produce findings.

```ts
interface ScanRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly severity: Severity;
  readonly category: FindingCategory;
  readonly enabled: boolean;
  match(readme: string, packageJson?: Record<string, unknown>): ScanFinding[];
}
```

| Field | Description |
|-------|-------------|
| `id` | Stable unique identifier for the rule. |
| `name` | Human-readable name of the rule. |
| `description` | Description of what the rule detects. |
| `severity` | Default severity assigned to findings produced by this rule. |
| `category` | Category assigned to findings produced by this rule. |
| `enabled` | Whether the rule is enabled by default. |
| `match()` | Inspect the given README and/or package.json and return any findings. |

### StaticScanReport

Report produced by a static (non-LLM) scan of a package.

```ts
interface StaticScanReport {
  readonly packageName: string;
  readonly version: string;
  readonly overallLevel: SecurityLevel;
  readonly score: number;
  readonly findings: readonly ScanFinding[];
  readonly scannedAt: string;
}
```

| Field | Description |
|-------|-------------|
| `packageName` | Name of the scanned package. |
| `version` | Version of the scanned package. |
| `overallLevel` | Overall security level derived from static findings. |
| `score` | Numeric score from 0 to 100 (higher is safer). |
| `findings` | Findings produced by the static scan. |
| `scannedAt` | ISO 8601 timestamp of when the scan ran. |

### LlmScanReport

Report produced by an LLM-based scan of a package.

```ts
interface LlmScanReport {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly summary?: string;
  readonly functionalMatch?: boolean;
  readonly suspiciousScore?: number;
  readonly findings?: readonly ScanFinding[];
  readonly scannedAt?: string;
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Whether the LLM scan was actually performed. |
| `reason` | Reason the LLM scan was skipped or disabled, if applicable. |
| `summary` | Natural-language summary of the LLM analysis. |
| `functionalMatch` | Whether the package matches its declared functionality per the LLM. |
| `suspiciousScore` | Suspiciousness score assigned by the LLM (0-100, higher is more suspicious). |
| `findings` | Findings produced by the LLM scan. |
| `scannedAt` | ISO 8601 timestamp of when the LLM scan ran. |

### ScanReport

Combined report for a package, including static and optional LLM scans.

```ts
interface ScanReport {
  readonly packageName: string;
  readonly version: string;
  readonly staticScan: StaticScanReport;
  readonly llmScan?: LlmScanReport;
  readonly overallLevel: SecurityLevel;
  readonly overallScore: number;
  readonly scannedAt: string;
}
```

| Field | Description |
|-------|-------------|
| `packageName` | Name of the scanned package. |
| `version` | Version of the scanned package. |
| `staticScan` | Results of the static scan. |
| `llmScan` | Results of the LLM scan, if performed. |
| `overallLevel` | Overall security level combining static and LLM results. |
| `overallScore` | Overall numeric score (0-100, higher is safer). |
| `scannedAt` | ISO 8601 timestamp of when the combined scan ran. |

### SecuritySummary

Aggregated security summary for a package, suitable for storage and display.

```ts
interface SecuritySummary {
  readonly packageName: string;
  readonly latestVersion: string;
  readonly overallLevel: SecurityLevel;
  readonly overallScore: number;
  readonly findingCount: number;
  readonly criticalCount: number;
  readonly highCount: number;
  readonly mediumCount: number;
  readonly lowCount: number;
  readonly lastScanned: string | null;
  readonly cachedAt: string;
}
```

| Field | Description |
|-------|-------------|
| `packageName` | Name of the package. |
| `latestVersion` | Latest known version of the package. |
| `overallLevel` | Overall security level for the package. |
| `overallScore` | Overall numeric score (0-100, higher is safer). |
| `findingCount` | Total number of findings across all scans. |
| `criticalCount` | Number of findings with critical severity. |
| `highCount` | Number of findings with high severity. |
| `mediumCount` | Number of findings with medium severity. |
| `lowCount` | Number of findings with low severity. |
| `lastScanned` | ISO 8601 timestamp of the last scan, or null if never scanned. |
| `cachedAt` | ISO 8601 timestamp of when this summary was cached. |

---

## Registry Types

### NpmRegistryError

Typed error thrown by registry clients when a request fails or returns a non-success status.

```ts
class NpmRegistryError extends Error {
  readonly statusCode?: number;
  readonly statusText?: string;

  constructor(
    message: string,
    statusCode?: number,
    statusText?: string,
  );
}
```

Carries the HTTP status code and status text when available so callers can branch on specific failure modes. The `name` property is set to `'NpmRegistryError'`.

### PackageMetadata

Full package metadata (packument) as returned by the registry's `GET /{package}` endpoint.

```ts
interface PackageMetadata {
  readonly name: string;
  readonly modified: string;
  readonly 'dist-tags': Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, AbbreviatedVersion>>;
  readonly description?: string;
  readonly homepage?: string;
  readonly repository?: PackageRepository;
  readonly keywords?: ReadonlyArray<string>;
  readonly author?: PackagePerson;
  readonly maintainers?: ReadonlyArray<{
    readonly name: string;
    readonly email: string;
  }>;
  readonly license?: string;
  readonly readme?: string;
  readonly readmeFilename?: string;
  readonly time?: Readonly<Record<string, string>>;
}
```

| Field | Description |
|-------|-------------|
| `name` | Package name (scoped names include the leading `@`). |
| `modified` | ISO-8601 timestamp of the most recent modification. |
| `dist-tags` | Distribution tags keyed by tag name (e.g. `latest`) pointing to versions. |
| `versions` | All published versions keyed by semver version string. |
| `description` | Short human-readable description. |
| `homepage` | URL to the package's homepage. |
| `repository` | Source repository descriptor. |
| `keywords` | Search/discoverability keywords. |
| `author` | Original package author. |
| `maintainers` | Current maintainers of the package. |
| `license` | SPDX license identifier or license text. |
| `readme` | Full readme contents. |
| `readmeFilename` | Filename of the readme (e.g. `README.md`). |
| `time` | Publication timestamps keyed by version (plus `created`/`modified`). |

### AbbreviatedVersion

Abbreviated packument for a single published version.

```ts
interface AbbreviatedVersion {
  readonly name: string;
  readonly version: string;
  readonly shasum?: string;
  readonly integrity?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly bundleDependencies?: ReadonlyArray<string>;
  readonly deprecated?: string;
  readonly hasInstallScript?: boolean;
  readonly hasShrinkwrap?: boolean;
  readonly dist: DistMetadata;
  readonly engines?: Readonly<Record<string, string>>;
  readonly _hasShrinkwrap?: boolean;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly directories?: Readonly<Record<string, string>>;
}
```

### DistMetadata

Distribution metadata attached to a published package version.

```ts
interface DistMetadata {
  readonly integrity?: string;
  readonly shasum?: string;
  readonly tarball: string;
  readonly fileCount?: number;
  readonly unpackedSize?: number;
  readonly signatures?: ReadonlyArray<{
    readonly keyid: string;
    readonly sig: string;
  }>;
}
```

| Field | Description |
|-------|-------------|
| `integrity` | Subresource Integrity (SRI) hash, e.g. `sha512-...`. |
| `shasum` | Legacy SHA-1 hex digest of the tarball. |
| `tarball` | Absolute URL to the downloadable `.tgz` tarball. |
| `fileCount` | Number of files contained in the tarball. |
| `unpackedSize` | Unpacked size of the tarball contents in bytes. |
| `signatures` | Cryptographic signatures attached to the tarball. |

### SearchResult

A single hit from the registry's `GET /-/v1/search` endpoint.

```ts
interface SearchResult {
  readonly package: {
    readonly name: string;
    readonly scope: string;
    readonly version: string;
    readonly description?: string;
    readonly keywords?: ReadonlyArray<string>;
    readonly date: string;
    readonly links: {
      readonly npm: string;
      readonly homepage?: string;
      readonly repository?: string;
      readonly bugs?: string;
    };
    readonly publisher: {
      readonly username: string;
      readonly email: string;
    };
    readonly maintainers: ReadonlyArray<{
      readonly username: string;
      readonly email: string;
    }>;
  };
  readonly score: {
    readonly final: number;
    readonly detail: {
      readonly quality: number;
      readonly popularity: number;
      readonly maintenance: number;
    };
  };
  readonly searchScore: number;
}
```

### ValidationResult

Outcome of validating a package identifier or version string.

```ts
interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}
```

### PackageIdentifier

A parsed package identifier combining name, optional scope, and optional version.

```ts
interface PackageIdentifier {
  readonly name: string;
  readonly version?: string;
  readonly scope?: string;
  readonly fullName: string;
}
```

| Field | Description |
|-------|-------------|
| `name` | Package name without scope prefix. |
| `version` | Semver version string, if specified. |
| `scope` | Scope without the leading `@`, if the package is scoped. |
| `fullName` | Fully-qualified name: `@scope/name` when scoped, otherwise `name`. |

### PackageRepository

Repository descriptor for a package. May be a structured object or a shorthand string.

```ts
type PackageRepository =
  | {
      readonly type: string;
      readonly url: string;
    }
  | string;
```

### PackagePerson

A person or entity associated with a package.

```ts
type PackagePerson =
  | {
      readonly name: string;
      readonly email?: string;
      readonly url?: string;
    }
  | string;
```

### DomainValidationResult

Result returned by `validateDomain`.

```ts
interface DomainValidationResult {
  readonly valid: boolean;
  readonly domain: string;
}
```

| Field | Description |
|-------|-------------|
| `valid` | `true` when the input parsed into a URL with a usable hostname. |
| `domain` | Lowercased hostname extracted from the URL, or empty string on failure. |

---

## Internal But Reusable Exports

The following modules are used internally by `NpmSafeEngine` but are also exported for advanced use cases. Their APIs are stable within Phase 1.

### Registry Client

**Source:** `src/registry/client.ts`

```ts
class NpmRegistryClient
```

HTTP client for the npm registry API v2. Thin wrapper around `fetch` with 10s timeout, exponential backoff retries (up to 3 attempts), and typed error handling.

#### Constructor

```ts
constructor(options?: {
  readonly baseUrl?: string;
  readonly userAgent?: string;
})
```

Defaults: `baseUrl = 'https://registry.npmjs.org'`, `userAgent = '@npm-safe/core (https://npmjs.org)'`.

#### Methods

```ts
getPackageMetadata(name: string): Promise<PackageMetadata>
getVersionManifest(name: string, version: string): Promise<AbbreviatedVersion>
searchPackages(query: string, size?: number): Promise<SearchResult[]>
```

- `getPackageMetadata`: Fetch the full packument for a package (`GET /{name}`).
- `getVersionManifest`: Fetch the abbreviated version manifest (`GET /{name}/{version}`).
- `searchPackages`: Search the registry (`GET /-/v1/search?text={query}&size={size}`). `size` defaults to 20.

All methods throw `NpmRegistryError` on failure.

### Static Analyzer

**Source:** `src/scanner/static-rules.ts`

```ts
class StaticAnalyzer

const BUILTIN_RULES: readonly ScanRule[]
```

`BUILTIN_RULES` is an array of 10 built-in `ScanRule` implementations covering install script detection, eval/Function obfuscation, base64-encoded shell payloads, binary download links, typosquatting, secret exposure, child_process in browser packages, suspicious build metadata, homograph attacks, and registry mismatches.

#### Constructor

```ts
constructor(rules?: ScanRule[])
```

Accepts an optional custom rule array. Defaults to `BUILTIN_RULES`.

#### Methods

```ts
analyze(readme: string, packageJson?: Record<string, unknown>): StaticScanReport
```

Runs all enabled rules against the given README and package.json. Scoring starts at 100 and subtracts per-finding weights (Critical -25, High -15, Medium -8, Low -3), clamped to [0, 100]. Overall level: `>= 80` Safe, `>= 50` Suspicious, `>= 20` Dangerous, else Unknown.

### Database Manager

**Source:** `src/store/database.ts`

```ts
class DatabaseManager
class DatabaseManagerError extends Error
```

#### Constructor

```ts
constructor(dbPath: string)
```

Opens (or creates) the SQLite database at `dbPath`, applies WAL-mode pragmas, and runs pending migrations. Throws `DatabaseManagerError` on failure.

#### Methods

```ts
getDb(): Database.Database
close(): void
isOpen(): boolean
```

- `getDb`: Returns the underlying `better-sqlite3` connection. Throws if the connection has been closed.
- `close`: Closes the database connection. Idempotent. Throws `DatabaseManagerError` if closing fails.
- `isOpen`: Returns `true` if the connection has not been closed.

#### DatabaseManagerError

```ts
class DatabaseManagerError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown);
}
```

The `name` property is set to `'DatabaseManagerError'`.

### Cache Manager

**Source:** `src/store/cache-manager.ts`

```ts
class CacheManager

interface CacheManagerOptions {
  readonly cacheTtlMs?: number;
}
```

Cache read/write layer backed by a `DatabaseManager` connection. All public methods return Promises for API consistency; the underlying `better-sqlite3` calls are synchronous.

#### Constructor

```ts
constructor(database: DatabaseManager, options?: CacheManagerOptions)
```

`cacheTtlMs` defaults to `3_600_000` (1 hour). The constant `DEFAULT_CACHE_TTL_MS` is also exported.

#### Methods

```ts
getPackage(name: string): Promise<PackageMetadata | null>
setPackage(meta: PackageMetadata): Promise<void>
getSecurityReport(pkg: string, version: string): Promise<StaticScanReport | null>
setSecurityReport(report: StaticScanReport): Promise<void>
getWatchlist(): Promise<string[]>
addToWatchlist(name: string): Promise<void>
removeFromWatchlist(name: string): Promise<void>
getSetting(key: string): Promise<string | null>
setSetting(key: string, value: string): Promise<void>
getStalePackages(): Promise<string[]>
```

| Method | Description |
|--------|-------------|
| `getPackage` | Returns cached metadata if still fresh (TTL not elapsed), otherwise `null`. |
| `setPackage` | Upserts a packument, stamping a fresh TTL. |
| `getSecurityReport` | Returns the most recent static security report, or `null`. The `SecurityLevel` is reconstructed from the persisted numeric score. |
| `setSecurityReport` | Upserts a static scan report (keyed by package_name + version + scan_type). |
| `getWatchlist` | Returns all watched package names in insertion order. |
| `addToWatchlist` | Adds a name (INSERT OR IGNORE, idempotent). |
| `removeFromWatchlist` | Removes a name (no-op if absent). |
| `getSetting` | Returns a setting value, or `null` if unset. |
| `setSetting` | Upserts a setting (INSERT OR REPLACE). |
| `getStalePackages` | Returns names of cached packages whose TTL has elapsed. |

### Rate Limiter (Token Bucket)

**Source:** `src/scheduler/rate-limiter.ts`

```ts
class TokenBucket
```

Token bucket rate limiter using continuous refill. Tokens accumulate at a configurable rate up to a maximum burst capacity. `consume()` blocks until tokens are available, servicing concurrent callers in FIFO order.

#### Constructor

```ts
constructor(tokensPerSecond: number = 5, maxBurst: number = 10)
```

Both parameters must be positive finite numbers; throws `RangeError` otherwise.

#### Methods

```ts
consume(count?: number): Promise<void>
tryConsume(count?: number): boolean
getStats(): { available: number; maxBurst: number; rate: number }
dispose(): void
```

| Method | Description |
|--------|-------------|
| `consume` | Wait until `count` tokens are available (default: 1). Resolves immediately if tokens suffice, otherwise enqueues until the next refill tick. Rejects if called after disposal. |
| `tryConsume` | Non-blocking variant. Returns `true` if tokens were consumed, `false` otherwise. Returns `false` after disposal. |
| `getStats` | Returns current available tokens, max burst capacity, and refill rate. |
| `dispose` | Stops the refill timer and rejects all pending consumers. Idempotent. |

### Refresh Scheduler

**Source:** `src/scheduler/refresh-scheduler.ts`

```ts
class RefreshScheduler extends EventEmitter
```

Auto-refresh scheduler that periodically polls the npm registry for updated package metadata, re-caches it, and re-runs the static analyzer. Extends `EventEmitter` from `node:events`.

#### Constructor

```ts
constructor(
  client: NpmRegistryClient,
  cache: CacheManager,
  limiter: TokenBucket,
  analyzer: StaticAnalyzer,
)
```

#### Methods

```ts
start(intervalMs?: number): void
stop(): void
refreshPackage(name: string): Promise<boolean>
refreshAll(): Promise<boolean>
```

| Method | Description |
|--------|-------------|
| `start` | Start the periodic refresh loop. Kicks off an immediate background cycle, then repeats at `intervalMs` (default: 1 hour). Idempotent restart. |
| `stop` | Stop the periodic refresh loop. Safe when not running. In-flight refreshes continue to completion. |
| `refreshPackage` | Refresh a single package. Catches per-package errors, emits them as events instead of rejecting, and returns whether the refresh succeeded. |
| `refreshAll` | Refresh every package with stale cache entries, processed sequentially, and returns whether all refreshes succeeded. |

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `'refresh:start'` | `RefreshStartPayload` | Emitted before each package refresh begins. |
| `'refresh:complete'` | `RefreshCompletePayload` | Emitted after a package refresh succeeds. |
| `'refresh:error'` | `RefreshErrorPayload` | Emitted when a package refresh fails. The scheduler does not throw on per-package failures; it emits the error and continues. |

#### Event Payload Interfaces

```ts
interface RefreshStartPayload {
  readonly packageName: string;
}

interface RefreshCompletePayload {
  readonly packageName: string;
  readonly report: StaticScanReport;
}

interface RefreshErrorPayload {
  readonly packageName: string;
  readonly error: unknown;
}
```

### Validator Functions

**Source:** `src/registry/validator.ts`

Pure string-parsing validators with no network calls or side effects.

```ts
function validatePackageName(name: string): ValidationResult
function validateVersion(version: string): boolean
function validateDomain(url: string): DomainValidationResult
function isKnownRegistryDomain(domain: string): boolean
```

#### validatePackageName

Validates an npm package name according to the public registry's naming rules.

Rules enforced:
- Must be a non-empty string, maximum 214 characters.
- Must be entirely lowercase.
- Must not contain spaces.
- Must not begin with a dot (`.`) or underscore (`_`).
- Scoped names use `@scope/name` syntax; both segments are validated independently.
- Rejects Unicode homograph look-alikes by restricting to ASCII lowercase letters, digits, hyphen, underscore, and dot.

Returns a `ValidationResult` with `valid: boolean` and an optional `reason` string.

#### validateVersion

Validates a string as a compliant semver 2.0.0 version (`MAJOR.MINOR.PATCH` with optional pre-release and build metadata). Numeric components with leading zeros are rejected. Returns `boolean`.

#### validateDomain

Parses a URL string and extracts its hostname. Prepends `https://` when no scheme is present. Returns a `DomainValidationResult` with `valid: boolean` and `domain: string` (lowercased hostname, or empty string on failure).

#### isKnownRegistryDomain

Checks whether a domain is a known npm registry or source-control host. The whitelist includes `npmjs.com`, `registry.npmjs.org`, `github.com`, `bitbucket.org`, and `gitlab.com`. Comparison is case-insensitive and exact. Returns `boolean`.
