# @npm-safe — Local npm Package Security Engine

[中文版](README_zh.md)

@npm-safe is a local-first engine for analyzing npm packages against known
supply-chain attack patterns. It fetches package metadata from the public npm
registry, runs static analysis rules against the metadata and README content,
caches results in a local SQLite database, and exposes a typed API for
querying, watching, and refreshing security assessments. The engine is
designed to operate as a library rather than a standalone service.

**Status: Phase 1 — Engine Core (complete).** 13 source files, zero TypeScript
errors, smoke-tested end to end.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later (global `fetch` required)
- [pnpm](https://pnpm.io/) 9 or later

---

## Setup

```bash
pnpm install
pnpm -F @npm-safe/core exec tsc --noEmit
```

The TypeScript compiler (`tsc`) is installed as a per-package devDependency
under pnpm's isolated store and is **not hoisted** to the workspace root.
Running `npx tsc` or `tsc` at the top level will therefore fail. The
`pnpm -F @npm-safe/core exec tsc --noEmit` workaround invokes the correct
binary via pnpm's filtered execution. The same pattern applies to any other
per-package CLI tool.

---

## Documentation

Detailed documentation for the engine is available under `packages/core/`:

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)** -- Layer map, module dependency graph, data flow diagrams (hot path and refresh path), database schema (ERD), migration system, error taxonomy, and annotated design decisions.
- **[API.md](packages/core/API.md)** -- Complete public API reference covering the `NpmSafeEngine` class (all 12 methods), exported interfaces, and all type definitions (`SecurityLevel`, `Severity`, `FindingCategory`, `CheckResult`, `ScanFinding`, `StaticScanReport`, etc.).
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)** -- Comprehensive reference for all 10 built-in static analysis rules. Each rule documents its category, severity, detection logic (regex patterns), and mitigation recommendations.
- **[HANDOVER.md](packages/core/HANDOVER.md)** -- Phase 1 to Phase 2 handover document. Covers what was built, what was deferred, known issues, development gotchas, and a recommended Phase 2 implementation order.
- **[README_zh.md](README_zh.md)** -- Chinese translation of the project README.

---

## Directory Structure

```
npm-store/
  pnpm-workspace.yaml          # workspace = packages/*
  tsconfig.base.json           # shared TypeScript config (ESNext, strict)
  .codegraph/
    .gitignore
  .omo/                        # OpenCode planning & evidence (internal)
  packages/
    core/
      package.json             # @npm-safe/core v0.1.0, ESM, private
      tsconfig.json            # extends ../../tsconfig.base.json
      src/
        index.ts               # NpmSafeEngine facade — unified public API
        registry/
          types.ts             # PackageMetadata, AbbreviatedVersion, SearchResult, NpmRegistryError
          validator.ts         # validatePackageName, validateVersion, validateDomain, isKnownRegistryDomain
          client.ts            # NpmRegistryClient — HTTP fetch with retry & backoff
        scanner/
          types.ts             # SecurityLevel, Severity, ScanFinding, ScanRule, StaticScanReport
          static-rules.ts      # StaticAnalyzer — 10 built-in analysis rules
        scheduler/
          rate-limiter.ts      # TokenBucket — 5 tokens/s, 10 burst
          refresh-scheduler.ts # RefreshScheduler — periodic watchlist refresh via EventEmitter
        store/
          schema.ts            # SCHEMA_SQL (DDL), getMigrationList, getInitialMigration
          database.ts          # DatabaseManager — better-sqlite3 with WAL, migrations
          cache-manager.ts     # CacheManager — TTL-based get/set for packages, reports, watchlist, settings
        translator/
          types.ts             # TranslationProvider interface, target-language config
          provider.ts          # Built-in translation provider implementation
```

---

## Architecture

The engine is composed of five layers. Each layer depends only on the layers
below it. The `index.ts` facade composes every dependency and exposes the
result as a single `NpmSafeEngine` class.

```
                           +-----------------------+
                           |      index.ts          |
                           |  NpmSafeEngine facade  |
                           |  12 public methods     |
                           +-----------+-----------+
                                       |
              +------------------------+------------------------+
              |                        |                        |
     +--------v--------+     +---------v---------+     +--------v--------+
     |   Registry      |     |    Scanner        |     |   Scheduler     |
     |  NpmRegistryClient|   |  StaticAnalyzer   |     | RefreshScheduler|
     |  Validator       |     |  10 rules         |     |  TokenBucket    |
     |  (HTTP fetch)    |     |  (pure analysis)  |     |  (rate-limit)   |
     +--------+---------+     +---------+---------+     +--------+--------+
              |                          |                        |
              |                          |                        |
              +--------------------------+------------------------+
                                         |
                                +--------v--------+
                                |     Store       |
                                | DatabaseManager |
                                |  CacheManager   |
                                |  SQLite (WAL)   |
                                +-----------------+
```

### Layer responsibilities

| Layer | Module(s) | Role |
|---|---|---|
| **Registry** | `registry/client.ts`, `registry/validator.ts`, `registry/types.ts` | HTTP communication with the npm registry API. Fetches packuments, validates package names and versions, defines all registry-facing TypeScript types. |
| **Scanner** | `scanner/static-rules.ts`, `scanner/types.ts` | Pure static analysis of package metadata and README content. Ten built-in rules detect install scripts, obfuscation, typosquatting, secret exposure, homograph attacks, and more. |
| **Scheduler** | `scheduler/refresh-scheduler.ts`, `scheduler/rate-limiter.ts` | Manages periodic refresh cycles for watched packages. A token bucket (5 tokens/s, 10 burst) limits registry request frequency. |
| **Store** | `store/database.ts`, `store/cache-manager.ts`, `store/schema.ts` | Persistent storage via better-sqlite3 with WAL mode. Handles migrations, TTL-based caching of metadata and scan reports, watchlist persistence, and key-value settings. |
| **Facade** | `index.ts` | The `NpmSafeEngine` class composes all four layers. Exposes 12 public methods: `checkPackage`, `searchPackages`, watchlist CRUD, refresh operations, settings access, and lifecycle (`startAutoRefresh`, `stopAutoRefresh`, `close`). |

A sixth auxiliary layer, **Translator** (`translator/types.ts`,
`translator/provider.ts`), provides a pluggable translation interface for
converting findings and summaries into different languages. It is not wired
into the core scan pipeline in Phase 1 but is fully typed and importable.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **ESM-only** (`"type": "module"`) | Aligns with the modern Node.js ecosystem. All imports use `.js` specifiers as required by native ESM. |
| **Strict TypeScript, no `any`** | Every function and interface is fully typed. The project compiles with `--strict` and zero implicit `any`. |
| **250-LOC ceiling per module** | Keeps each file focused and reviewable. The facade (`index.ts`) is the only module that modestly exceeds this limit due to its composition responsibilities. |
| **SQLite via better-sqlite3** | Zero-configuration embedded database. WAL mode, `busy_timeout=5000`, `synchronous=NORMAL`, and foreign keys are enabled on open. |
| **Pure static analysis (no network)** | The scanner inspects only metadata and README text already fetched by the registry client. No external API calls during analysis. |
| **TokenBucket rate limiter (5 tokens/s, 10 burst)** | Prevents registry throttling. Tokens refill at 5 per second; burst allows up to 10 immediate requests. |
| **Cache-first `checkPackage` with TTL staleness** | Returns cached results immediately when the TTL has not expired. Stale cache triggers a background refresh. Default TTL is 1 hour. |
| **String enums for `SecurityLevel` / `Severity`** | Unlike numeric enums, string enums are safe to log, serialize, and use in `switch` statements without reverse-mapping surprises. |
| **Score: 100 minus severity weights** | Critical = 25, High = 15, Medium = 8, Low = 3. Starting from 100 ensures an unscored package scores 100 (safe). |
| **Level thresholds** | `>=80` Safe, `>=50` Suspicious, `>=20` Dangerous, else Unknown. These thresholds are shared between `StaticAnalyzer` and `CacheManager` for consistency. |

---

## What Is Next (Phase 2)

Phase 1 delivered a working, tsc-clean engine core. Phase 2 will extend the
project in the following directions:

- **LLM-based scan provider.** Integrate the translator layer with an LLM
  (local or remote) for semantic analysis of package behavior and
  functionality-mismatch detection.
- **Dashboard UI.** A browser-based interface for viewing scan results,
  managing the watchlist, and configuring engine settings.
- **Plugin system.** Allow third-party scan rules and output formatters to be
  registered dynamically.
- **CI/CD integration.** A GitHub Action or CLI tool that runs
  `@npm-safe/core` checks as part of a CI pipeline.
