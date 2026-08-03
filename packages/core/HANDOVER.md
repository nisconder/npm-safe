# @npm-safe/core: Project Handover

**Date:** 2026-08-01
**Package:** @npm-safe/core v0.1.0 + @npm-safe/desktop v0.1.0
**Status:** All Phase 1 and Phase 2 plans complete. Engine core (17 source files) plus CLI (9 files) delivered, 240 tests passing, proxy support, en/zh localization, multi-provider LLM scanning (OpenAI / Gemini / Anthropic), a Neutralinojs desktop GUI (vanilla JS, Material You), a plugin system for custom scan rules, and LLM configuration management (CLI + GUI) shipped, zero TypeScript errors. A bug-fix pass on 2026-08-02 hardened the desktop GUI against XSS-to-RCE, added a watchlist foreign-key pre-check, corrected refresh semantics, and added sub-second TTL support (see section 3.8).

[中文版](HANDOVER_zh.md)

---

## 1. Plan Status Overview

This document records every project plan and its completion status.

| Plan | Status | Notes |
|---|---|---|
| Phase 1: engine core (`npm-safe-phase1`) | **Done** | Engine core modules, tsc-clean, smoke-tested |
| Phase 1: documentation pack (`phase1-documentation`) | **Done** | README, README_zh, ARCHITECTURE, API, SCANNER_RULES, HANDOVER, HANDOVER_zh |
| Phase 2: test suite | **Done** (2026-07-31) | 206 tests, all passing, 11 test files |
| Phase 2: CLI binary | **Done** (2026-07-31) | 9 files under `src/cli/`, 6 commands, `npm-safe` bin |
| Phase 2: proxy support | **Done** (2026-07-31) | `undici.ProxyAgent`, flag > setting > env resolution, `NO_PROXY` bypass, 4 tests |
| Phase 2: i18n | **Done** (2026-07-31) | en/zh CLI localization, persisted `lang` command, HANDOVER_zh.md |
| LLM-based scan provider | **Done** (2026-08-01) | Multi-provider: OpenAI / Gemini / Anthropic, see section 3.5 |
| Desktop GUI (`packages/desktop`) | **Done** (2026-08-01) | Neutralinojs + vanilla JS + Material You (M3), see section 6 |
| Neutralinojs GUI (MD3) | **Done** (2026-08-01) | Shipped as `packages/desktop` — Neutralinojs window app with a Material 3 (MD3) design system (light/dark themes). The original Preact+mdui plan was superseded by the delivered vanilla-JS implementation, which fulfills the MD3 requirement. |
| AI skill packaging | **Done** (2026-08-02) | Global agent skill `npm-safe-scan` installed at `~/.agents/skills/npm-safe-scan/SKILL.md`; packages the CLI as a global agent skill (any AI agent that loads `~/.agents/skills/`). |
| Plugin system | **Done** (2026-08-02) | Runtime rule registration API, `~/.npm-safe/rules.json` config, `~/.npm-safe/rules/` plugin discovery, `npm-safe rules` CLI, see section 3.9 |
| LLM configuration (CLI + GUI) | **Done** (2026-08-02) | Optional LLM scanning via `~/.npm-safe/llm.json`; `npm-safe llm` commands; GUI rules and LLM settings pages, see section 3.10 |
| CI/CD integration | **Done** (2026-08-02) | `npm-safe ci` dependency scan gate + GitHub Actions workflow, see section 3.11 |
| Multi-package batch API | **Done** (2026-08-02) | `checkPackages` (parallel + rate-limited), batch `check`, `ci --lockfile`, see section 3.12 |
| Report export | **Done** (2026-08-03) | `npm-safe report` (JSON/CSV, --file/--batch/--output), see section 3.13 |
| Telemetry and analytics | **Done** (2026-08-03) | Opt-in local telemetry, `npm-safe telemetry` CLI, see section 3.13 |
| npm publisher configuration | **Deferred** (2026-08-03) | On hold by decision — package stays `"private": true`, not publishing for now |

---

## 2. Phase 1: Engine Core (Completed)

Phase 1 delivered the core `@npm-safe/core` engine across 14 implementation tasks in 5 waves, followed by 4 parallel verification reviews. The package lives under `packages/core/` in the pnpm monorepo at the workspace root.

### Source files

All source files reside under `packages/core/src/`:

| File | Role |
|---|---|
| `index.ts` | `NpmSafeEngine` facade, composes every dependency, exposes 25 public methods |
| `registry/types.ts` | Foundational types: `PackageMetadata`, `AbbreviatedVersion`, `SearchResult`, `NpmRegistryError`, `PackageIdentifier`, `ValidationResult` |
| `registry/validator.ts` | Pure validators: `validatePackageName`, `validateVersion`, `validateDomain`, `isKnownRegistryDomain` |
| `registry/client.ts` | `NpmRegistryClient`, HTTP fetch with 10s timeout, 3 retries, exponential backoff (1s/2s/4s) |
| `scanner/types.ts` | Enums: `SecurityLevel`, `Severity`, `ScanType`, `FindingCategory`. Interfaces: `ScanRule`, `ScanFinding`, `StaticScanReport`, `LlmScanReport`, `ScanReport`, `SecuritySummary` |
| `scanner/static-rules.ts` | `StaticAnalyzer` class plus 10 built-in `ScanRule` implementations: install-script, eval-obfuscation, base64-shell, binary-links, typosquatting, secret-exposure, child-process-browser, suspicious-build-metadata, homograph-attack, registry-mismatch |
| `scheduler/rate-limiter.ts` | `TokenBucket`, 5 tokens/s refill, 10 burst, continuous-refill with 100ms tick granularity |
| `scheduler/refresh-scheduler.ts` | `RefreshScheduler` extends `EventEmitter`, periodic watchlist refresh with 1-hour default interval |
| `store/schema.ts` | DDL schema: 6 application tables plus `_migrations` tracking, migration list, initial migration SQL |
| `store/database.ts` | `DatabaseManager`, better-sqlite3 connection with WAL pragmas, migration runner |
| `store/cache-manager.ts` | `CacheManager`, TTL-based get/set for packages, security reports, watchlist, settings |
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

- `checkPackage(name)` — cache-first security check; returns `CheckResult` with metadata plus static scan report
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
- `undici` ^7.0.0 (used for proxy support since Phase 2) and `type-fest` ^4.0.0 as dependencies
- No build output committed, `tsc` compiles to `dist/` at build time

### Verification results

- `tsc --noEmit` clean via `pnpm -F @npm-safe/core exec tsc --noEmit` (zero errors, zero warnings)
- Module graph resolved: all 10 relative imports in `index.ts` resolve to existing files, transitive walk clean
- All 25 public API methods reachable via the `NpmSafeEngine` instance
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

## 3. Phase 2: Tests, CLI, Proxy, i18n, LLM Scan Provider (Completed)

Phase 2 shipped on 2026-07-31 and the LLM scan provider followed on
2026-08-01. The phase added a full test suite, a terminal CLI binary, proxy
support for restricted networks, en/zh localization, and a multi-provider LLM
scan core. All five workstreams are complete and verified.

### 3.1 Test suite

206 tests across 11 files, all passing. Run with:

```
pnpm -F @npm-safe/core test
```

The test runner is the Node.js built-in test runner invoked through `tsx` (`node --import tsx --test --test-reporter spec "test/**/*.test.ts"`).

| Test file | Coverage |
|---|---|
| `test/validator.test.ts` | Package name, version, and domain validation |
| `test/static-rules.test.ts` | All 10 rules plus scoring and level mapping |
| `test/rate-limiter.test.ts` | Token bucket timing and burst behavior |
| `test/store.test.ts` | Database manager (migrations) and cache manager (TTL, upserts) |
| `test/client.test.ts` | Registry client with mocked fetch, retry/backoff, and proxy paths |
| `test/refresh-scheduler.test.ts` | Scheduler events and watchlist refresh cycles |
| `test/engine.test.ts` | `NpmSafeEngine` integration surface |
| `test/cli.test.ts` | CLI commands, language switching, and shorthand invocation |
| `test/llm-provider.test.ts` | `createLlmProvider` factory and shared provider behaviour |
| `test/llm-gemini.test.ts` | Gemini provider request and response handling |
| `test/llm-anthropic.test.ts` | Anthropic provider request and response handling |

### 3.2 CLI binary

Nine new files under `packages/core/src/cli/`: `cli.ts`, `check.ts`, `search.ts`, `watch.ts`, `refresh.ts`, `settings.ts`, `lang.ts`, `i18n.ts`, `shared.ts`.

Commands:

- `check <package>` — run a security check (also reachable via the `npm-safe <package>` shorthand)
- `search <query>` — search the npm registry
- `watch list` / `watch add <package>` / `watch remove <package>` — watchlist management
- `refresh [package]` — refresh one package, or all watched packages when omitted
- `settings get <key>` / `settings set <key> <value>` — read and write persisted settings
- `lang [en|zh]` — get or set the output language (persisted)

Global options:

- `-d, --db <path>` — custom SQLite database path (default `~/.npm-safe/npm-safe.db`)
- `-p, --proxy <url>` — HTTP proxy for registry requests
- `-j, --json` — JSON output
- `-v, --version` — print version

The `package.json` declares `"bin": { "npm-safe": "./dist/cli/cli.js" }`, backed by the `commander` ^15 dependency. Build with:

```
pnpm -F @npm-safe/core run build
```

### 3.3 Proxy support

`registry/client.ts` now routes registry requests through `undici.ProxyAgent`. Proxy resolution order:

1. `--proxy` CLI flag
2. Persisted `proxy` setting (`npm-safe settings set proxy <url>`)
3. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables

The `NO_PROXY` environment variable bypasses the proxy using exact match, `.suffix` match, or `*`. Four dedicated proxy tests cover the resolution order and the bypass rules.

### 3.4 i18n

The CLI ships an en/zh localization module (`cli/i18n.ts`). The `lang` command reads and writes the persisted language, so the choice survives across invocations. The Chinese handover document is `HANDOVER_zh.md`.

### 3.5 LLM scan provider

The optional semantic scan now supports three backends selected via
`LlmProviderType`: OpenAI-compatible chat-completions endpoints (`OpenAi`),
Google Gemini (`Gemini`), and Anthropic Claude (`Anthropic`). A single
`LlmProviderOptions` interface feeds the `createLlmProvider(options?)`
factory, which dispatches on `options.provider` and defaults to the
OpenAI-compatible provider. `OpenAICompatibleLlmOptions` remains as a
deprecated alias for backward compatibility.

Provider implementations (all under `packages/core/src/llm/`):

- `OpenAICompatibleLlmProvider` (`provider.ts`): `/chat/completions` surface, env fallback `OPENAI_API_KEY`, default model `gpt-4o-mini`
- `GeminiLlmProvider` (`gemini.ts`): `models/<model>:generateContent`, env fallback `GEMINI_API_KEY`, default model `gemini-2.0-flash`
- `AnthropicLlmProvider` (`anthropic.ts`): `/v1/messages`, env fallback `ANTHROPIC_API_KEY`, default model `claude-3-5-sonnet-latest`

Shared parsing and validation helpers plus the `LlmProviderError` class live
in `llm/parse.ts`; `LlmProviderError` is re-exported from `provider.ts` for
backward compatibility. The CLI (`cli/shared.ts`) auto-detects the provider
from the environment in priority order `ANTHROPIC_API_KEY`, then
`GEMINI_API_KEY`, then `OPENAI_API_KEY`, and wires the chosen options into
`NpmSafeEngineOptions.llm`. Three dedicated test files cover the provider
factory and the two new backends.

### 3.6 Desktop GUI (`packages/desktop`)

A Neutralinojs desktop GUI shipped on 2026-08-01. It is an independent
vanilla-JS implementation (no Preact/mdui) styled with Material You /
Material Design 3 color tokens. The desktop package is licensed under
Apache-2.0.

- **Architecture:** The Neutralinojs main process spawns a Node.js extension
  (`resources/extensions/core/main.mjs`) that hosts `NpmSafeEngine`. The
  frontend talks to the extension over WebSocket IPC via
  `Neutralino.extensions.dispatch`.
- **Views:** Overview dashboard (half-circle average-score gauge, recent
  checks, 7-day histogram, total count, risk breakdown), Check, Search,
  Watch, 评价体系 (Rules), LLM, and Settings.
- **Window chrome:** Borderless window with a custom title bar — draggable
  region, minimize and close buttons, and a light/dark theme toggle. Two
  independent M3 palettes: dark seed `#4f8cff`, light seed `#7c2d12`.
- **Persisted preferences (2026-08-02):** the theme choice and the last
  active tab are remembered across sessions. They are written to both
  `localStorage` (applied instantly at startup) and the engine settings
  table in `~/.npm-safe/npm-safe.db` (survives webview cache clears). On
  connect the extension broadcasts `engineReady`; the frontend then hydrates
  the preferences from the settings table, with the backend value winning.
- **History:** every successful `checkPackage` is recorded by the extension
  to `~/.npm-safe/history.json` (latest 1000 entries), read by the dashboard
  via the `getHistory` event.
- **Windows first-run:** WebView2 loopback exemption is required once:
  `CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"`.

Run with `cd packages/desktop && pnpm run` (dev) or `pnpm run build:release`.

### 3.7 AI skill packaging

A global agent skill `npm-safe-scan` was installed on 2026-08-02 at
`~/.agents/skills/npm-safe-scan/SKILL.md`. It packages the `npm-safe` CLI as
an agent skill usable by any AI agent that loads `~/.agents/skills/`, exposing
the tool's commands (check, search, watch, refresh, settings, lang) so the
agent can invoke them directly to scan npm packages. The skill is bundled
inside the package at `skill/npm-safe-scan/SKILL.md` and auto-installed to
`~/.agents/skills/` via a `postinstall` hook (`scripts/install-skill.mjs`)
whenever the package is installed.

### 3.8 Bug-fix pass (2026-08-02)

A security and correctness review on 2026-08-02 found and fixed 12 issues,
split across severities:

- **Critical (2): XSS-to-RCE in the desktop GUI.** Package-controlled fields
  were rendered into the DOM without escaping, which would let script
  injection reach the Neutralinojs window's host API. All fields are now
  escaped before rendering.
- **High (2).** The LLM finding renderer carried the same XSS exposure and is
  now escaped too. A watchlist refresh could crash on a foreign-key violation
  when a package was removed mid-cycle; the violation is now pre-checked.
- **Medium (3).** The dev-guard that asserts development-only invocation was
  tightened, `setBusy` became idempotent, and the no-argument `refresh`
  command now refreshes the watchlist to match its documented behaviour.
- **Low (5).** A `.com` false positive in the typosquatting rule was removed;
  `search --size` now validates and clamps 1-250 with a default of 20 (the
  previous NaN path is gone); `levelLabel` gained a safe fallback; the
  `callEngine` timeout was fixed; and sub-second TTLs are now honoured with
  millisecond precision.
- **CLI `-j` flag.** The JSON output flag was repaired as part of the same
  pass.

The suite grew from 205 to 206 tests; all pass. The source-file count under
`packages/core/src/` is now 26 (the earlier 13 figure predated the CLI and
LLM provider files).

### 3.9 Plugin system (2026-08-02)

The plugin system plan was delivered on 2026-08-02. It adds three layers on
top of the existing `ScanRule` interface:

- **Runtime registration API.** `StaticAnalyzer` gained `registerRule`,
  `unregisterRule`, and `listRules`. `NpmSafeEngine` exposes the same surface
  plus `setRuleEnabled`, `setRuleSeverity`, `setRuleOptions`, `getRuleConfig`,
  and `loadRulePlugins`.
- **Per-rule configuration.** `RuleConfigManager`
  (`src/scanner/rule-config.ts`) persists enable/disable, severity overrides,
  and free-form options to `~/.npm-safe/rules.json`. Overrides are applied at
  analysis time: disabled rules are skipped and finding severities are
  remapped.
- **Plugin discovery.** `loadRulesFromDirectory`
  (`src/scanner/rule-loader.ts`) scans `~/.npm-safe/rules/` for `*.mjs` /
  `*.js` ES modules. Each file may export `rule`, `rules`, or `default`
  holding one or more `ScanRule`s. Files are loaded in lexical order; invalid
  files are skipped. The engine loads plugins automatically at startup.
- **CLI.** `npm-safe rules list | enable | disable | severity` manages the
  persisted config (en/zh localized).

The test suite grew from 206 to 226 tests; all pass.

### 3.10 LLM configuration (CLI + GUI) (2026-08-02)

LLM scanning was made optional and configurable through both the CLI and the
desktop GUI:

- **Persistence.** `LlmConfigManager` (`src/llm/llm-config.ts`) stores
  `~/.npm-safe/llm.json` with a 0o600 permission attempt. It tracks `enabled`,
  `provider`, `apiKey`, `baseUrl`, `model`, and provider-specific timeouts.
- **Graceful fallback.** If the persisted file is missing or no API key is
  configured, the engine falls back to provider-specific environment variables
  (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`). If neither is
  present, LLM scanning is silently disabled and static analysis continues
  normally.
- **Runtime updates.** `NpmSafeEngine.setLlmConfig` recreates the provider and
  notifies the refresh scheduler, so enabling/disabling LLM takes effect
  immediately without restarting the engine.
- **CLI commands.** `npm-safe llm status | enable | disable | set-provider |
  set-key | set-model | set-base-url | test-connection` manage the persisted
  config (en/zh localized).
- **Desktop GUI pages.** The Navigation Drawer gained two new tabs:
  - **评价体系 (Rules)** — lists all registered rules, shows source
    (`builtin`/`plugin`), description, and lets users toggle each rule and
    override its severity. A button reloads plugin rules from
    `~/.npm-safe/rules/`.
  - **LLM** — a form with an enable switch, provider selector, API key, model,
    and base URL inputs, plus save/test/reset actions. The API key is masked
    in the status display.

The test suite grew from 226 to 240 tests; all pass.

### 3.11 CI/CD integration (2026-08-02)

The CI/CD plan was delivered on 2026-08-02:

- **`npm-safe ci` command.** Scans a project's direct dependencies
  (`dependencies` + `devDependencies`, or `--prod` for production only),
  aggregates the per-package security levels, and fails the build when any
  dependency reaches a configurable threshold. Options: `--dir`, `--json`,
  `--prod`, `--fail-level` (default `dangerous`), `--rate-limit` (default 20
  requests/s; the engine's token bucket is configured accordingly). Exit
  codes: `0` pass, `1` usage/config error, `2` dependency at/above the fail
  level or scan error. Missing packages are reported as warnings, network
  errors count as failures.
- **GitHub Actions workflow** (`.github/workflows/ci.yml`): two jobs —
  `quality` (install, typecheck, build, full test suite) and
  `dependency-scan` (runs `npm-safe ci --fail-level dangerous` on
  `packages/core`), gating every push/PR.
- **Engine plumbing.** `createEngine` gained optional `rateLimit` /
  `rateLimitBurst` overrides so the CI command can scan faster than the
  interactive default.

The test suite grew from 240 to 247 tests; all pass.

### 3.12 Multi-package batch API (2026-08-02)

The batch API plan was delivered on 2026-08-02:

- **`NpmSafeEngine.checkPackages(names, options)`.** Checks many packages in
  parallel with a concurrency cap (default 5). Every check consumes one token
  from the rate limiter, so batches respect the configured request budget.
  Failures are isolated per package (`{ ok: false, error }`) instead of
  rejecting the whole batch; results come back in input order. Options:
  `concurrency`, `onProgress(done, total, entry)`.
- **Batch CLI.** `npm-safe check` accepts any number of package names
  (`check lodash express axios`), reads lists from files (`--file`, one per
  line, `#` comments), and supports `--concurrency`. Batch JSON output is a
  `BatchPackageResult[]`. Single-package output is unchanged.
- **Full-lockfile CI scanning.** `npm-safe ci --lockfile` parses
  `package-lock.json` (npm lockfile v2/v3 `packages` map with a v1
  `dependencies` fallback) and scans every package including transitive
  dependencies; `--lockfile --prod` restricts to the direct production
  dependencies declared in `package.json`.
- **Batch detail view.** The most recent batch result is persisted to
  `~/.npm-safe/last-batch.json`; `npm-safe check detail <n>` re-renders the
  full report (findings, recommendations, snippets) of the n-th package
  without re-fetching, with index validation and error handling for failed
  entries.

The test suite grew from 247 to 260 tests; all pass.

### 3.13 Report export + telemetry (2026-08-03)

Two Phase-3 plans were delivered on 2026-08-03:

- **Report export (`npm-safe report`).** Exports security reports for any
  package set as JSON (full `BatchPackageResult[]`) or CSV
  (`name,version,level,score,findingCount`). Package sources: positional
  names, `--file` (one per line), or `--batch` (the last batch check). Output
  goes to stdout or `--output <path>`; `--concurrency` controls scan
  parallelism. Invalid entries are exported as `error` rows.
- **Telemetry and analytics.** `TelemetryManager`
  (`src/telemetry/telemetry.ts`) aggregates opt-in, local-only usage data in
  `~/.npm-safe/telemetry.json`: per-event counters (`check`, `ci`), total
  packages scanned, security-level distribution, error counts, and a rolling
  window of the last 200 events. Disabled by default; nothing is sent
  anywhere. CLI: `npm-safe telemetry status | enable | disable | export |
  reset`. `check` (single and batch) and `ci` record events automatically
  once enabled.

The test suite grew from 260 to 277 tests; all pass.

---

## 4. Documentation Deliverables (Completed)

The Phase 1 documentation pack, plus the Phase 2 updates, is complete:

| Document | Purpose |
|---|---|
| `README.md` (workspace root) | English project readme: setup, CLI usage, architecture, design decisions, phase status |
| `README_zh.md` (workspace root) | Chinese translation of the readme, cross-linked with the English version |
| `packages/core/ARCHITECTURE.md` | Layer map, module dependency graph, data flow (hot path and refresh path), database schema, migration system, error taxonomy, design decisions |
| `packages/core/API.md` | Complete public API reference: `NpmSafeEngine` (all 24 methods), exported interfaces, and type definitions |
| `packages/core/SCANNER_RULES.md` | Reference for all 10 built-in rules: category, severity, detection logic, mitigations |
| `packages/core/HANDOVER.md` | This document, English |
| `packages/core/HANDOVER_zh.md` | Chinese handover document |

---

## 5. Remaining Plans (Future Phases)

The following plans are not started. They are listed in rough priority order.
The Neutralinojs GUI (MD3) plan is delivered and no longer listed here; it is
covered by the shipped desktop GUI in section 3.6.

| Priority | Plan | Description |
|---|---|---|
| 1 | **Structured command logs** | JSONL logs for CLI commands; usage stats and metrics export are already covered by the telemetry module. |

> **Deferred by decision (2026-08-03):** npm publisher configuration
> (`publishConfig`, `.npmignore`, provenance) is intentionally on hold — the
> package stays `"private": true` and will not be published for now.

---

## 6. Known Issues

### 6.1 `ReadonlySet` used as a value in `validator.ts` (line 52) — VERIFIED: NOT AN ISSUE

The `KNOWN_REGISTRY_DOMAINS` constant is declared as:

```typescript
const KNOWN_REGISTRY_DOMAINS: ReadonlySet<string> = new Set<string>([...]);
```

`ReadonlySet<string>` is a TypeScript utility type used as a type annotation; `new Set<string>(...)` is a runtime value. This is valid TypeScript and `tsc --noEmit` reports zero errors under strict mode. The initial concern was about `ReadonlySet` being used as a runtime value, but the code correctly uses it only as a type annotation.

**Status:** No fix needed. Verified with `pnpm -F @npm-safe/core exec tsc --noEmit` (zero errors).

### 6.2 Top-level `npx tsc` is broken

The workspace root does not hoist TypeScript to `node_modules/.bin/`. Running `npx tsc` at the monorepo root fails with a missing binary error. See Gotcha 7.1 for workarounds.

### 6.3 `security_reports` table stores only numeric score

The `security_reports.overall_score` column is `INTEGER`. The `SecurityLevel` string enum is reconstructed on read by `CacheManager.getSecurityReport()` via a local `scoreToLevel()` helper in `cache-manager.ts` (lines 94-99). This helper uses the same thresholds as `StaticAnalyzer.levelFromScore()` in `static-rules.ts` (lines 732-737): >=80 Safe, >=50 Suspicious, >=20 Dangerous.

**Maintenance burden:** If the thresholds change in one place, the other must be updated too. Consider extracting the thresholds to a shared constants module.

### 6.4 Duplicated `repositoryToString()` helper

A module-level `repositoryToString()` function in `index.ts` (lines 439-443) duplicates the private `repositoryToString()` function in `cache-manager.ts` (lines 109-113). Both implement the same logic: structured `PackageRepository` -> `"type:url"`, string -> verbatim, undefined -> `""`.

**Maintenance burden:** Changes to the repository string format must be applied in both places. Refactor into a shared utility.

### 6.5 No build output directory committed

The `dist/` directory is not in version control. Running `tsc` to produce the build output is required before the package can be consumed as a library or as the CLI binary. The `package.json` `main` and `types` fields both point to `./dist/index.js` and `./dist/index.d.ts` respectively, and `bin` points to `./dist/cli/cli.js`.

### 6.6 `type-fest` dependency unused

The `package.json` lists `type-fest` ^4.0.0 as a dependency. It is not imported anywhere in the source files. It was included for potential utility type usage in future phases. Consider removing it if it remains unused.

### 6.7 `undici` was unused in Phase 1, now used

`undici` ^7.0.0 was listed as a dependency during Phase 1 and imported nowhere at that time. Since Phase 2, `registry/client.ts` imports `ProxyAgent` and `Dispatcher` from it for proxy support (lines 31-32). The dependency is now justified; the earlier "unused dependency" note no longer applies.

---

## 7. Gotchas for Phase 2

These are practical pitfalls recorded during development. They remain relevant to future work.

### 7.1 tsc invocation (CRITICAL)

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

### 7.2 Value import vs type import for enums

`SecurityLevel` and `Severity` are TypeScript `enum` declarations. Enums produce runtime values. They **must** use a value import:

```typescript
// CORRECT
import { SecurityLevel } from './scanner/types.js';

// WRONG — will produce a runtime undefined
import type { SecurityLevel } from './scanner/types.js';
```

The same rule applies to `ScanType`, `FindingCategory`, `TranslatorProviderType`, and `LlmProviderType`. When in doubt, use a value import for any enum.

### 7.3 Value import for `Database` namespace from better-sqlite3

`Database` from `better-sqlite3` is used as a namespace (`Database.Database`). A value import is required:

```typescript
// CORRECT
import Database from "better-sqlite3";

// WRONG — TS2702 "only refers to a type, used as namespace"
import type Database from "better-sqlite3";
```

This import is unused as a runtime value (only the type namespace is needed). The `noUnusedLocals` compiler option is off in `tsconfig.base.json`, so the unused value import does not cause a compilation error.

### 7.4 `satisfies` pattern on event payloads

`RefreshScheduler` uses `satisfies` on event `emit()` calls to verify payload types at the call site without widening:

```typescript
this.emit('refresh:start', { packageName: name } satisfies RefreshStartPayload);
```

This pattern enforces type safety without requiring explicit type annotations on the emit argument. Any new event types should follow the same pattern.

### 7.5 `AbbreviatedVersion` to `Record<string, unknown>` double-cast

Converting an `AbbreviatedVersion` manifest to a plain `Record<string, unknown>` for the static analyzer requires a double cast because `AbbreviatedVersion` is a readonly interface:

```typescript
const packageJson = ({ ...manifest } as unknown as Record<string, unknown>);
```

The spread (`{ ...manifest }`) creates a mutable copy. The double cast (`as unknown as ...`) works around the readonly-to-mutable type mismatch. This pattern appears in both `index.ts` (line 216) and `refresh-scheduler.ts` (line 202).

### 7.6 Migration name type is `string`, not a union

`getMigrationList()` returns `string[]`, not a literal union type. This means the exhaustive `never` switch guard does not work for migration names:

```typescript
// THIS DOES NOT COMPILE
switch (name) {
  case "001_initial.sql": return getInitialMigration();
  default: const exhaustive: never = name; // TS2322: type 'string' not assignable to 'never'
}
```

Use a plain `default: throw` with `DatabaseManagerError` instead (as done in `database.ts` line 46).

### 7.7 `_migrations` table is created in two places

The `_migrations` tracking table is created both in `SCHEMA_SQL` (in `schema.ts`) and in the `DatabaseManager` constructor before the migration loop (in `database.ts` lines 120-126). The pre-creation in `database.ts` is intentional: it ensures the tracking table exists before the first migration runs, so the first migration can be recorded. This is not a bug, but it can be confusing for maintainers.

### 7.8 ESM imports use `.js` extensions

All relative imports use `.js` file extensions per Node.js native ESM convention:

```typescript
import { DatabaseManager } from './store/database.js';  // .ts file on disk
```

The TypeScript compiler resolves `.js` specifiers to `.ts` sources automatically via the `bundler` module resolution setting. Do not use `.ts` extensions in import specifiers.

### 7.9 TokenBucket interval timer

The `TokenBucket` uses a 100ms `setInterval` for refill ticks. The timer is unref'd so it does not keep the Node.js event loop alive. Tests that depend on timing must account for asynchronous refill behavior; the existing `rate-limiter.test.ts` handles this with fake clocks.

### 7.10 Desktop GUI history persistence

The desktop extension records every successful `checkPackage` result in
`~/.npm-safe/history.json` (latest 1000 entries). The dashboard reads it via
the `getHistory` extension event. This file is separate from the SQLite
cache/settings database and is intended purely for UI analytics — do not treat
it as authoritative scan storage.

### 7.11 Desktop IPC message filtering

The extension (`packages/desktop/resources/extensions/core/main.mjs`) only
handles messages whose `event` is in `SUPPORTED_METHODS`. Messages carrying a
native `method` field (e.g. ACKs for its own `app.broadcast` calls) and
framework-internal events (`appClientConnect`, `clientConnect`, ...) must be
ignored — otherwise they surface as `Unknown method: undefined` errors.
