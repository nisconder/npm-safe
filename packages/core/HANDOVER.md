# @npm-safe/core: Phase 1 to Phase 2 Handover

**Date:** 2026-07-29
**Package:** @npm-safe/core v0.1.0
**Status:** Phase 1 complete (engine core). 13 source files, zero TypeScript errors, smoke-tested end to end.

> **Update (2026-07-31):** Phase 2 items 1-3 are done. A full test suite (193 tests, all passing) covers every module; the `ReadonlySet` concern was verified as a non-issue; and a CLI binary (`check`, `search`, `watch`, `refresh`, `settings`, `lang`) is implemented, with proxy support and en/zh localization.

[中文版](HANDOVER_zh.md)

---

## 1. What Was Built

Phase 1 delivered the core `@npm-safe/core` engine across 14 implementation tasks in 5 waves, followed by 4 parallel verification reviews. The package lives under `packages/core/` in the pnpm monorepo at the workspace root.

### Source files

All source files reside under `packages/core/src/`:

| File | Role |
|---|---|
| `index.ts` | `NpmSafeEngine` facade — composes every dependency, exposes 12 public methods |
| `registry/types.ts` | Foundational types: `PackageMetadata`, `AbbreviatedVersion`, `SearchResult`, `NpmRegistryError`, `PackageIdentifier`, `ValidationResult` |
| `registry/validator.ts` | Pure validators: `validatePackageName`, `validateVersion`, `validateDomain`, `isKnownRegistryDomain` |
| `registry/client.ts` | `NpmRegistryClient` — HTTP fetch with 10s timeout, 3 retries, exponential backoff (1s/2s/4s) |
| `scanner/types.ts` | Enums: `SecurityLevel`, `Severity`, `ScanType`, `FindingCategory`. Interfaces: `ScanRule`, `ScanFinding`, `StaticScanReport`, `LlmScanReport`, `ScanReport`, `SecuritySummary` |
| `scanner/static-rules.ts` | `StaticAnalyzer` class + 10 built-in `ScanRule` implementations: install-script, eval-obfuscation, base64-shell, binary-links, typosquatting, secret-exposure, child-process-browser, suspicious-build-metadata, homograph-attack, registry-mismatch |
| `scheduler/rate-limiter.ts` | `TokenBucket` — 5 tokens/s refill, 10 burst, continuous-refill with 100ms tick granularity |
| `scheduler/refresh-scheduler.ts` | `RefreshScheduler` extends `EventEmitter` — periodic watchlist refresh with 1-hour default interval |
| `store/schema.ts` | DDL schema: 6 application tables + `_migrations` tracking, migration list, initial migration SQL |
| `store/database.ts` | `DatabaseManager` — better-sqlite3 connection with WAL pragmas, migration runner |
| `store/cache-manager.ts` | `CacheManager` — TTL-based get/set for packages, security reports, watchlist, settings |
| `translator/types.ts` | `TranslatorProviderType` enum, `TranslationResult`, `TranslatorConfig`, `ProviderNotConfigured`, `TranslationError` |
| `translator/provider.ts` | `TranslatorProvider` interface, `DeepLAdapter` and `OpenAIAdapter` skeletons, `createTranslator` factory |

### Architecture overview

The engine is composed of 5 layers, with `index.ts` acting as the composition root:

```
                    NpmSafeEngine (index.ts)
                   /          |            \
           Registry       Scanner        Scheduler
        (client.ts)   (static-rules.ts)  (refresh-scheduler.ts)
              \            |            /
                Store (database.ts + cache-manager.ts)
```

An auxiliary Translator layer (`translator/`) provides a pluggable translation interface but is not wired into the core scan pipeline in Phase 1.

### Public API (12 methods on `NpmSafeEngine`)

- `checkPackage(name)` — cache-first security check; returns `CheckResult` with metadata + static scan report
- `searchPackages(query, size?)` — delegates to the registry search endpoint
- `getWatchlist()` / `addToWatchlist(name)` / `removeFromWatchlist(name)` — watchlist CRUD
- `refreshPackage(name)` / `refreshAll()` — rate-limited registry refresh with event emission
- `getSetting(key)` / `setSetting(key, value)` — key-value settings access
- `startAutoRefresh(intervalMs?)` / `stopAutoRefresh()` — lifecycle for periodic refresh
- `close()` — graceful teardown (stop scheduler, dispose limiter, close database)

### Tech stack

- TypeScript 5.9.3, strict mode, `ESNext` target, `bundler` module resolution
- ESM (package `"type": "module"`), all imports use `.js` specifiers
- pnpm workspace monorepo
- better-sqlite3 ^11.0.0 for SQLite persistence (WAL mode, `busy_timeout=5000`, `synchronous=NORMAL`)
- `undici` ^7.0.0 and `type-fest` ^4.0.0 as dependencies (undici is unused in Phase 1; present for Phase 2)
- No build output committed — `tsc` compiles to `dist/` at build time

### Verification results

- `tsc --noEmit` clean via `pnpm -F @npm-safe/core exec tsc --noEmit` (zero errors, zero warnings)
- Module graph resolved: all 10 relative imports in `index.ts` resolve to existing files, transitive walk clean
- All 12 public API methods reachable via the `NpmSafeEngine` instance
- Constructor wiring verified: all 6 dependencies instantiated correctly
- 3 exported symbols from `index.ts`: `NpmSafeEngine`, `NpmSafeEngineOptions`, `CheckResult`

### Key design decisions

| Decision | Rationale |
|---|---|
| ESM-only | Aligns with modern Node.js. All imports use `.js` specifiers. |
| Strict TypeScript, no `any` | Every function and interface fully typed. Zero implicit `any`. |
| 250-LOC ceiling per module | Keeps each file focused. `index.ts` modestly exceeds this due to composition responsibilities. |
| SQLite via better-sqlite3 | Zero-config embedded database. WAL mode for safe concurrent reads. |
| Pure static analysis (no network) | Scanner inspects only metadata and README already fetched by the registry client. |
| TokenBucket rate limiter | 5 tokens/s refill, 10 burst. Continuous-refill with wall-clock time. |
| Cache-first with TTL staleness | Default 1-hour TTL. Stale rows return as cache miss, not stale data. |
| String enums for SecurityLevel/Severity | Safe to log, serialize, and use in switch statements without reverse-mapping surprises. |
| Score-based security levels | Score starts at 100, subtracts severity weights. Thresholds: >=80 Safe, >=50 Suspicious, >=20 Dangerous. |

---

## 2. What Was NOT Built (Deferred to Phase 2)

The following capabilities were deliberately deferred. They are listed in rough priority order.

1. **Unit and integration tests.** Phase 1 has zero tests. This is the top priority for Phase 2. Every module needs coverage: `validator.ts`, `client.ts` (mock fetch), `static-rules.ts` (each rule), `rate-limiter.ts` (timing), `refresh-scheduler.ts` (events), `database.ts` (migrations), `cache-manager.ts` (TTL, upserts), `index.ts` (integration).

2. **Network-layer adaptive rate limiting.** The `TokenBucket` uses fixed 5 tokens/s. There is no mechanism to dynamically adjust the refill rate based on registry response times or HTTP 429 responses.

3. **LLM-based analysis provider.** The `LlmScanReport` type is defined in `scanner/types.ts`, but no LLM provider is implemented. The `ScanReport` type includes `llmScan?: LlmScanReport`, but nothing writes to it.

4. **CLI binary.** No command-line interface exists. The engine is a library only. Phase 2 should add `commander` or `yargs` as a dependency and create a `bin/` entry point.

5. **Web UI.** No frontend exists.

6. **Multi-package batch API beyond refreshAll.** `refreshAll()` refreshes stale packages sequentially. There is no batch `checkPackage` for multiple names, no bulk search, and no batch report export.

7. **Telemetry and analytics.** No usage tracking, no metrics collection, no structured logging beyond the event emitter.

8. **Plugin system for custom rules.** The `StaticAnalyzer` constructor accepts an optional `ScanRule[]` array, but there is no dynamic discovery, registration API, or configuration file for third-party rules.

9. **CI/CD pipeline.** No GitHub Actions, no npm publish configuration, no version bumping workflow.

10. **npm publisher configuration.** The package is `"private": true` in `package.json`. No `.npmignore`, no `publishConfig`, no provenance setup.

---

## 3. Known Issues

### 3.1 `ReadonlySet` used as a value in `validator.ts` (line 52) — VERIFIED: NOT AN ISSUE

The `KNOWN_REGISTRY_DOMAINS` constant is declared as:

```typescript
const KNOWN_REGISTRY_DOMAINS: ReadonlySet<string> = new Set<string>([...]);
```

`ReadonlySet<string>` is a TypeScript utility type used as a type annotation; `new Set<string>(...)` is a runtime value. This is valid TypeScript and `tsc --noEmit` reports zero errors under strict mode. The initial concern was about `ReadonlySet` being used as a runtime value, but the code correctly uses it only as a type annotation.

**Status:** No fix needed. Verified with `pnpm -F @npm-safe/core exec tsc --noEmit` (zero errors).

### 3.2 Top-level `npx tsc` is broken

The workspace root does not hoist TypeScript to `node_modules/.bin/`. Running `npx tsc` at the monorepo root fails with a missing binary error. See Gotcha 4.1 for workarounds.

### 3.3 `security_reports` table stores only numeric score

The `security_reports.overall_score` column is `INTEGER`. The `SecurityLevel` string enum is reconstructed on read by `CacheManager.getSecurityReport()` via a local `scoreToLevel()` helper in `cache-manager.ts` (lines 94-99). This helper uses the same thresholds as `StaticAnalyzer.levelFromScore()` in `static-rules.ts` (lines 732-737): >=80 Safe, >=50 Suspicious, >=20 Dangerous.

**Maintenance burden:** If the thresholds change in one place, the other must be updated too. Consider extracting the thresholds to a shared constants module in Phase 2.

### 3.4 Duplicated `repositoryToString()` helper

A module-level `repositoryToString()` function in `index.ts` (lines 439-443) duplicates the private `repositoryToString()` function in `cache-manager.ts` (lines 109-113). Both implement the same logic: structured `PackageRepository` -> `"type:url"`, string -> verbatim, undefined -> `""`.

**Maintenance burden:** Changes to the repository string format must be applied in both places. Refactor into a shared utility in Phase 2.

### 3.5 No build output directory committed

The `dist/` directory is not in version control. Running `tsc` to produce the build output is required before the package can be consumed as a library. The `package.json` `main` and `types` fields both point to `./dist/index.js` and `./dist/index.d.ts` respectively.

### 3.6 `undici` dependency unused

The `package.json` lists `undici` ^7.0.0 as a dependency. It is not imported anywhere in Phase 1 source files. Consider removing it if it remains unused in Phase 2.

### 3.7 `type-fest` dependency unused

The `package.json` lists `type-fest` ^4.0.0 as a dependency. It is not imported anywhere in Phase 1 source files. It was included for potential utility type usage in future phases.

---

## 4. Gotchas for Phase 2

### 4.1 tsc invocation (CRITICAL)

TypeScript is a per-package devDependency under pnpm's isolated store. The workspace root does not have `typescript` in its `node_modules/.bin/`.

**Do NOT run:**
```
npx tsc                                    # fails
tsc                                        # fails
```

**Use one of these instead:**
```
pnpm -F @npm-safe/core exec tsc --noEmit   # preferred
node .\node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc -p packages\core\tsconfig.json
```

### 4.2 Value import vs type import for enums

`SecurityLevel` and `Severity` are TypeScript `enum` declarations. Enums produce runtime values. They **must** use a value import:

```typescript
// CORRECT
import { SecurityLevel } from './scanner/types.js';

// WRONG — will produce a runtime undefined
import type { SecurityLevel } from './scanner/types.js';
```

The same rule applies to `ScanType`, `FindingCategory`, and `TranslatorProviderType`. When in doubt, use a value import for any enum.

### 4.3 Value import for `Database` namespace from better-sqlite3

`Database` from `better-sqlite3` is used as a namespace (`Database.Database`). A value import is required:

```typescript
// CORRECT
import Database from "better-sqlite3";

// WRONG — TS2702 "only refers to a type, used as namespace"
import type Database from "better-sqlite3";
```

This import is unused as a runtime value (only the type namespace is needed). The `noUnusedLocals` compiler option is off in `tsconfig.base.json`, so the unused value import does not cause a compilation error.

### 4.4 `satisfies` pattern on event payloads

`RefreshScheduler` uses `satisfies` on event `emit()` calls to verify payload types at the call site without widening:

```typescript
this.emit('refresh:start', { packageName: name } satisfies RefreshStartPayload);
```

This pattern enforces type safety without requiring explicit type annotations on the emit argument. Any new event types added in Phase 2 should follow the same pattern.

### 4.5 `AbbreviatedVersion` to `Record<string, unknown>` double-cast

Converting an `AbbreviatedVersion` manifest to a plain `Record<string, unknown>` for the static analyzer requires a double cast because `AbbreviatedVersion` is a readonly interface:

```typescript
const packageJson = ({ ...manifest } as unknown as Record<string, unknown>);
```

The spread (`{ ...manifest }`) creates a mutable copy. The double cast (`as unknown as ...`) works around the readonly-to-mutable type mismatch. This pattern appears in both `index.ts` (line 216) and `refresh-scheduler.ts` (line 202).

### 4.6 Migration name type is `string`, not a union

`getMigrationList()` returns `string[]`, not a literal union type. This means the exhaustive `never` switch guard does not work for migration names:

```typescript
// THIS DOES NOT COMPILE
switch (name) {
  case "001_initial.sql": return getInitialMigration();
  default: const exhaustive: never = name; // TS2322: type 'string' not assignable to 'never'
}
```

Use a plain `default: throw` with `DatabaseManagerError` instead (as done in `database.ts` line 46).

### 4.7 `_migrations` table is created in two places

The `_migrations` tracking table is created both in `SCHEMA_SQL` (in `schema.ts`) and in the `DatabaseManager` constructor before the migration loop (in `database.ts` lines 120-126). The pre-creation in `database.ts` is intentional: it ensures the tracking table exists before the first migration runs, so the first migration can be recorded. This is not a bug, but it can be confusing for maintainers.

### 4.8 ESM imports use `.js` extensions

All relative imports use `.js` file extensions per Node.js native ESM convention:

```typescript
import { DatabaseManager } from './store/database.js';  // .ts file on disk
```

The TypeScript compiler resolves `.js` specifiers to `.ts` sources automatically via the `bundler` module resolution setting. Do not use `.ts` extensions in import specifiers.

### 4.9 TokenBucket interval timer

The `TokenBucket` uses a 100ms `setInterval` for refill ticks. The timer is unref'd so it does not keep the Node.js event loop alive. If Phase 2 adds tests that depend on timing, this timer will need to be mocked or the test will need to account for asynchronous refill behavior.

---

## 5. Recommended Phase 2 Order

This order minimises risk by building confidence from the bottom up.

| Priority | Work item | Rationale |
|---|---|---|
| 1 | **Write unit tests for all modules** | Phase 1 has zero tests. Without tests, every subsequent change is blind. Start with pure modules (`validator.ts`, `static-rules.ts`), then move to modules with side effects (`client.ts` with mock fetch, `database.ts` with in-memory SQLite, `cache-manager.ts`, `rate-limiter.ts`, `refresh-scheduler.ts`). Finish with integration tests for `index.ts`. |
| 2 | **Fix the `ReadonlySet` cosmetic error** | Correct `validator.ts` line 52. One-line fix, removes the only tsc diagnostic. |
| 3 | **Build a CLI binary** | Add commander or yargs, create `bin/npm-safe.ts`, implement commands for `check`, `search`, `watch`, `refresh`, `settings`. This makes the tool usable from the terminal without writing code. |
| 4 | **Implement the LLM scan provider** | Wire the `translator/provider.ts` skeletons into actual API calls. Integrate the `LlmScanReport` into `checkPackage` and the scheduler. |
| 5 | **Add the plugin framework** | Design a configuration-based or directory-based plugin discovery system for custom `ScanRule` registrations. |
| 6 | **Telemetry and analytics** | Add structured logging (pino or winston), optional usage reporting, and Prometheus metrics export. |
| 7 | **CI/CD and publishing** | Set up GitHub Actions for lint, type check, and test. Configure npm provenance publishing. |
