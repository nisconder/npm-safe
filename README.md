# @npm-safe — Local npm Package Security Engine

[中文版](README_zh.md)

![Version](https://img.shields.io/badge/version-v0.1.0-2196F3)
![License](https://img.shields.io/badge/license-Apache--2.0-4CAF50)
![Language](https://img.shields.io/badge/Language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-307%20passing-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Desktop](https://img.shields.io/badge/Desktop-Neutralinojs-purple)

@npm-safe is a local-first engine for analyzing npm packages against known
supply-chain attack patterns. It fetches package metadata from the public npm
registry, runs static analysis rules against the metadata and README content,
caches results in a local SQLite database, and exposes a typed API for
querying, watching, and refreshing security assessments. The engine is
designed to operate as a library rather than a standalone service.

**Status: Phase 1 complete (engine core) + Phase 2 complete.** Engine core
delivered with 29 source files and zero TypeScript errors. Phase 2 added a
full test suite (307 tests, all passing), a CLI binary with commands for
`check`, `search`, `watch`, `refresh`, `settings`, `lang`, `rules`, and `llm`,
proxy support for restricted networks, an optional multi-provider LLM scan
provider (OpenAI / Gemini / Anthropic) with persisted configuration, and a
Neutralinojs desktop GUI with a Material You dashboard,
check/search/watch/rules/llm/settings tabs, light/dark themes, and persistent
check history. A hardening pass (2026-08-02) fixed 12 issues found by a bug
screen, including two critical XSS-to-RCE exposures in the desktop GUI (all
fields are now escaped), a watchlist refresh crash, and
several CLI correctness problems such as the `-j` output flag and sub-second
TTL precision.

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

## Command Line Interface

Build the CLI and link it globally (or run `node packages/core/dist/cli/cli.js`
directly):

```bash
pnpm -F @npm-safe/core run build
cd packages/core && npm link
```

> **Windows PATH note:** `npm link` installs `npm-safe` into the npm global
> bin directory (`%APPDATA%\npm`), which must be on your `PATH` for external
> terminals to find it. The official Node.js MSI adds it automatically; for
> custom installs (e.g. Node unpacked to a custom folder) add it yourself:
> `setx PATH "%APPDATA%\npm;%PATH%"`, then reopen the terminal. If anything
> looks off, run `npm-safe doctor` for a diagnosis.

### Commands

```bash
npm-safe <package>                 # Shorthand for check
npm-safe check <package>            # Check a package's security posture
npm-safe check <pkg1> <pkg2> ...    # Check multiple packages (batch)
npm-safe check --file deps.txt      # Read package names from a file
npm-safe search <query>            # Search the npm registry
npm-safe watch list                # List watched packages
npm-safe watch add <package>       # Add a package to the watchlist
npm-safe watch remove <package>    # Remove a package from the watchlist
npm-safe refresh [package]         # Refresh one (or all watched) packages
npm-safe settings get <key>        # Read a setting
npm-safe settings set <key> <val>  # Write a setting
npm-safe lang [en|zh]              # Get or set the output language
npm-safe rules list                # List scan rules with effective status
npm-safe rules enable <rule-id>    # Enable a scan rule (persisted)
npm-safe rules disable <rule-id>   # Disable a scan rule (persisted)
npm-safe rules severity <rule-id> <severity>  # Override a rule's severity
npm-safe llm status                # Show LLM provider status
npm-safe llm enable                # Enable LLM scanning
npm-safe llm disable               # Disable LLM scanning
npm-safe llm set-provider <openai|gemini|anthropic>
npm-safe llm set-key <api-key>     # Set the LLM API key
npm-safe llm set-model <model>     # Set the LLM model identifier
npm-safe llm test-connection       # Test the LLM connection
npm-safe ci                        # Scan dependencies, fail the build on severe findings
npm-safe ci --lockfile             # Scan every dependency (incl. transitive) in package-lock.json
npm-safe report lodash express     # Export security reports (JSON/CSV)
npm-safe telemetry status          # Show telemetry status (opt-in, local only)
npm-safe gate status               # Show install gate status (opt-in)
npm-safe gate enable               # Enable the gate + auto-install wrappers/shims
npm-safe gate shell                # Install shell wrappers + PATH shims
npm-safe gate shell --machine      # Windows (admin): prepend shims to system PATH
npm-safe install axios             # Install with the security gate (if enabled)
npm-safe doctor                    # Diagnose PATH / gate / shim setup
```

### Desktop Application

A Neutralinojs desktop GUI is provided under `packages/desktop/`:

```bash
# Build the core engine and run the desktop app in development mode
cd packages/desktop
pnpm run run

# Build a release bundle
pnpm run build
```

Features:

- **Overview dashboard** — average security score with a half-circle gauge,
  recent checks list, 7-day check histogram, total count, and risk breakdown.
- **Check** — enter a package name and view the security level, score, and
  findings.
- **Search** — keyword search against the npm registry; click a result to jump
  straight to Check.
- **Watch** — manage the watchlist and refresh individual packages or all
  watched packages.
- **评价体系 (Rules)** — list all registered rules, toggle each rule, and
  override its severity. Reload custom rule plugins from `~/.npm-safe/rules/`.
- **LLM** — configure optional LLM scanning: enable/disable switch, provider,
  API key, model, and base URL, with a test-connection button.
- **Settings** — read/write arbitrary engine settings (e.g. `proxy`, `lang`).
- **Light/Dark themes** — toggle between two independent Material You palettes
  from the custom title bar; the choice and the last active tab are remembered
  across sessions (localStorage + engine settings table).
- **Custom window chrome** — borderless window with draggable title bar, minimize
  and close buttons (Windows loopback exemption is required for WebView2; see
  setup notes below).

Check history is persisted in `~/.npm-safe/history.json` by the Node.js
extension process.

Global options:

- `-d, --db <path>` — custom SQLite database path (default `~/.npm-safe/npm-safe.db`)
- `-p, --proxy <url>` — HTTP proxy for registry requests
- `-j, --json` — JSON output
- `-v, --version` — print version

Example:

```bash
npm-safe check lodash
# Package: lodash
# Latest version: 4.18.1
# Security level: suspicious
# Score: 65/100
# Findings: 5
# ...
```

### Proxy configuration

On restricted networks the registry may only be reachable through a proxy.
Proxy resolution order: `--proxy` flag > persisted `proxy` setting >
`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables. The
`NO_PROXY` variable (exact match, `.suffix` match, or `*`) bypasses the proxy.

```bash
# Persist a proxy (recommended)
npm-safe settings set proxy http://127.0.0.1:7897

# Or pass it per invocation
npm-safe --proxy http://127.0.0.1:7897 check react
```

### Language

```bash
npm-safe lang          # Show the current language
npm-safe lang zh       # Switch to Chinese (persisted)
npm-safe lang en       # Switch to English (persisted)
```

### Rules and plugins

Rules can be managed at runtime. Configuration is persisted in
`~/.npm-safe/rules.json`:

```bash
npm-safe rules list                          # Show every rule and its status
npm-safe rules disable install-script        # Disable a rule
npm-safe rules enable install-script         # Re-enable it
npm-safe rules severity typosquatting critical  # Override a rule's severity
```

Third-party rule plugins can be dropped into `~/.npm-safe/rules/` as ES module
files (`*.mjs` / `*.js`). Each file may export `rule`, `rules`, or `default`
holding one or more rules conforming to the `ScanRule` interface:

```js
// ~/.npm-safe/rules/my-rule.mjs
export const rule = {
  id: "my-rule",
  name: "My rule",
  description: "Detects something bad",
  severity: "high",
  category: "informational",
  enabled: true,
  match(readme, packageJson) {
    return packageJson?.scripts?.postinstall?.includes("wget")
      ? [{ ruleId: "my-rule", ruleName: "My rule", severity: "high",
           message: "postinstall uses wget", category: "informational" }]
      : [];
  },
};
```

Plugin files are loaded at engine startup and bad files are skipped. The
`ScanRule` interface and the full engine rule API (`registerRule`,
`unregisterRule`, `listRules`, `setRuleEnabled`, `setRuleSeverity`) are
exported from `@npm-safe/core` for programmatic use.

### LLM scanning

LLM-based semantic scanning is optional and disabled by default. When no API
key is configured, static analysis continues normally. Configuration is
persisted in `~/.npm-safe/llm.json` and can also be supplied via environment
variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`).

```bash
npm-safe llm status                 # Show the current provider and status
npm-safe llm enable                 # Turn LLM scanning on
npm-safe llm set-provider openai    # Select provider
npm-safe llm set-key $OPENAI_API_KEY
npm-safe llm set-model gpt-4o-mini
npm-safe llm test-connection        # Verify the provider works
```

### CI/CD integration

`npm-safe ci` scans a project's direct dependencies and fails the build when
any dependency reaches a configurable security level:

```bash
npm-safe ci --dir ./packages/core          # default fail level: dangerous
npm-safe ci --fail-level suspicious        # stricter gate
npm-safe ci --prod                         # skip devDependencies
npm-safe ci --lockfile                     # scan all lockfile deps (incl. transitive)
npm-safe ci --json                         # machine-readable report
npm-safe ci --rate-limit 50                # registry requests per second
```

Exit codes: `0` pass, `1` usage/config error, `2` one or more dependencies
reached the fail level (or the scan errored). A ready-to-use GitHub Actions
workflow lives at `.github/workflows/ci.yml` — it runs the test suite, type
checks, and a dependency security scan on every push/PR.

### Batch operations

`check` accepts any number of package names and reads lists from files,
scanning concurrently (default 5) while still respecting the rate limiter:

```bash
npm-safe check lodash express axios       # batch check
npm-safe check --file deps.txt --concurrency 10
npm-safe check lodash express --json      # machine-readable batch report
npm-safe check detail 2                   # full report of the 2nd package of the last batch
```

Programmatic consumers can use `NpmSafeEngine.checkPackages(names, options)`
with a `concurrency` cap and an `onProgress` callback. The most recent batch
is saved to `~/.npm-safe/last-batch.json`; `check detail <n>` re-renders one
package's full report (findings, recommendations, snippets) from it without
re-fetching.

### Report export

Export security reports for any set of packages as JSON or CSV, to stdout or
a file:

```bash
npm-safe report lodash express                    # JSON to stdout
npm-safe report --format csv lodash express       # CSV
npm-safe report --file deps.txt --format csv --output report.csv
npm-safe report --batch                           # export the last batch check
```

JSON output includes the full per-package results (`BatchPackageResult[]`);
CSV rows are `name,version,level,score,findingCount`.

### Telemetry and analytics

Local, opt-in usage telemetry (disabled by default, nothing is sent anywhere):

```bash
npm-safe telemetry status         # show whether enabled + aggregated stats
npm-safe telemetry enable         # start collecting (local only)
npm-safe telemetry disable        # stop collecting (keeps existing data)
npm-safe telemetry export         # dump the collected data as JSON
npm-safe telemetry reset          # clear all collected data
```

When enabled, `check` and `ci` runs are recorded to
`~/.npm-safe/telemetry.json`: per-event counters, total packages scanned,
security-level distribution, error counts, and a rolling window of the last
200 events.

### Shared check history

Every package checked via the CLI (`check` / `ci`) — and every check run
inside the desktop GUI — is written to the shared SQLite database
(`~/.npm-safe/npm-safe.db`, `check_history` table, newest-first, capped at
1000). The desktop GUI's overview dashboard loads this history directly, so
packages scanned on the command line appear in the app, and vice versa.
Legacy `~/.npm-safe/history.json` data is migrated into the database once on
first launch. Programmatic access: `engine.recordCheckHistory(result)`,
`engine.getCheckHistory()`, `engine.clearCheckHistory()`.

The desktop extension also honours the persisted `proxy` setting: on startup
it reads the settings table and configures the engine, so a proxy configured
in the GUI or via `npm-safe settings set proxy ...` applies to desktop
scans too.

### Command log

Every CLI invocation appends one JSONL line to
`~/.npm-safe/commands.jsonl` with `{ timestamp, command, argv, exitCode,
durationMs }`, written on process exit. The location can be redirected with
the `NPM_SAFE_COMMAND_LOG` environment variable.

### Install-time security gate (opt-in)

`npm-safe install` wraps `npm install` with an optional security gate: every
target package is checked first, and any package scoring **below the
threshold (default 85)** requires manual confirmation before the install
proceeds. The gate is **disabled by default** and can be turned on via the
CLI or the desktop GUI (Settings → 安装安全检查):

```bash
npm-safe gate status               # show enabled state + threshold
npm-safe gate enable               # turn the gate on (auto-installs shell wrappers)
npm-safe gate disable              # turn it off
npm-safe gate set-threshold 90     # raise the bar
npm-safe install axios             # gated install (prompts below threshold)
npm-safe install axios --yes       # auto-confirm
npm-safe install axios --dry-run   # check + prompt without installing
```

`gate enable` does everything in one step: it enables the check, installs
**PATH shims** into `~/.npm-safe/bin` (npm.cmd / pnpm.cmd / yarn.cmd — they
work in every shell), and appends wrapper functions for `npm`, `pnpm`, and
`yarn` to your shell config (PowerShell `$PROFILE` on Windows,
`~/.zshrc`/`~/.bashrc` otherwise). How to activate:

| Your shell | Activation |
|---|---|
| PowerShell / bash / zsh | Just restart the shell — the profile wrappers load automatically |
| **Windows cmd** (or any shell where the shim dir isn't first in PATH) | Run **once as administrator**: `npm-safe gate shell --machine` — this prepends the shim directory to the **system** PATH, so every new terminal (incl. cmd) is intercepted. Reopen terminals afterwards. |

On Windows, only the system PATH reliably precedes the Node.js installation
directory; user-PATH edits are not enough when a tool puts the machine PATH
first. `npm-safe doctor` verifies that `where npm.cmd` resolves to the shim
first and prints the exact fix.

Pass `--shell-file <path>` to target a specific config file, `--no-shell` to
skip. After activation, any `pnpm add <pkg>` or `npm install <pkg>` first
runs `npm-safe install ...` — the gate checks the package and asks for
confirmation below the threshold before the real package manager runs.
Remove everything with:

```bash
npm-safe gate shell --remove
```

The gate shares the same settings table as the GUI, so the CLI switch and the
GUI toggle stay in sync.

### Desktop first-run (Windows)

If the WebView2 window fails to load with a loopback error, run once in an
administrator PowerShell:

```powershell
CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"
```

### Tests

```bash
pnpm -F @npm-safe/core test
```

307 tests cover every module: validators, static rules, rate limiter, store
layer, registry client (with mocked fetch), refresh scheduler, the engine
integration surface, the LLM providers, the LLM configuration manager, the
rule plugin system, the CI command, batch operations, report export, the
telemetry manager, the shared check history, the install gate, the doctor
diagnostics, the structured command log, and the CLI itself.

---

## Documentation

Detailed documentation for the engine is available under `packages/core/`:

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)** -- Layer map, module dependency graph, data flow diagrams (hot path and refresh path), database schema (ERD), migration system, error taxonomy, and annotated design decisions.
- **[API.md](packages/core/API.md)** -- Complete public API reference covering the `NpmSafeEngine` class (all 29 public methods), exported interfaces, and all type definitions (`SecurityLevel`, `Severity`, `FindingCategory`, `CheckResult`, `ScanFinding`, `StaticScanReport`, etc.).
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)** -- Comprehensive reference for all 10 built-in static analysis rules. Each rule documents its category, severity, detection logic (regex patterns), and mitigation recommendations.
- **[README_zh.md](README_zh.md)** -- Chinese translation of the project README.

The desktop GUI lives under `packages/desktop/` and is documented in the
[Desktop README](packages/desktop/README.md).

---

## AI Skill

An agent skill named `npm-safe-scan` is bundled with this package and
**auto-installed on install** via a `postinstall` hook: installing
`@npm-safe/core` copies `skill/npm-safe-scan/SKILL.md` to
`~/.agents/skills/npm-safe-scan/SKILL.md`. Any AI agent that auto-loads skills
from the user's `~/.agents/skills/` directory can then automatically invoke
`npm-safe` commands. The skill's trigger is biased towards install intent: a
coding agent is expected to run `npm-safe check <name>` **before installing
any npm package**, and it documents the full command surface (check, batch
check, ci, report, rules, llm, watch, settings, telemetry), common workflows,
and JSON output interpretation.

---

## Directory Structure

```
npm-safe/
  .gitignore
  LICENSE                  # Apache-2.0
  README.md                # project README (English)
  README_zh.md             # project README (Chinese)
  pnpm-lock.yaml           # lockfile
  pnpm-workspace.yaml      # workspace = packages/*
  tsconfig.base.json       # shared TypeScript config (ESNext, strict)
  .github/
    workflows/
      ci.yml               # CI: typecheck + tests + dependency security scan
  packages/
    core/
      package.json         # @npm-safe/core v0.1.0, ESM, publishConfig (public, provenance)
      .npmignore           # publish exclude rules
      tsconfig.json        # extends ../../tsconfig.base.json
      API.md               # public API reference
      ARCHITECTURE.md      # layer map, data flows, DB schema
      SCANNER_RULES.md     # 10 static rule reference
      skill/
        npm-safe-scan/
          SKILL.md         # AI skill, auto-installed via postinstall
      scripts/
        install-skill.mjs  # postinstall hook
      src/
        index.ts           # NpmSafeEngine facade — unified public API
        cli/
          cli.ts           # CLI entry — commander program + shorthand check
          command-log.ts   # structured JSONL command log (~/.npm-safe/commands.jsonl)
          check.ts         # check command (shared with shorthand)
          search.ts        # search command
          watch.ts         # watchlist commands (list/add/remove)
          refresh.ts       # refresh command
          settings.ts      # settings get/set commands
          lang.ts          # lang command (en/zh, persisted)
          rules.ts         # rules management commands
          llm.ts           # LLM configuration commands
          i18n.ts          # en/zh localization module
          shared.ts        # engine factory + default DB path
        llm/
          provider.ts      # createLlmProvider factory (OpenAI / Gemini / Anthropic)
          llm-config.ts    # LlmConfigManager persistence and env fallback
          gemini.ts        # Gemini LLM provider
          anthropic.ts     # Anthropic LLM provider
          parse.ts         # LLM response parsing helpers
        registry/
          types.ts         # PackageMetadata, AbbreviatedVersion, SearchResult, NpmRegistryError
          validator.ts     # validatePackageName, validateVersion, validateDomain, isKnownRegistryDomain
          client.ts        # NpmRegistryClient — HTTP fetch with retry, backoff & proxy support
        scanner/
          types.ts         # SecurityLevel, Severity, ScanFinding, ScanRule, StaticScanReport
          static-rules.ts  # StaticAnalyzer — 10 built-in analysis rules + rule registration
          rule-config.ts   # RuleConfigManager persistence
          rule-loader.ts   # Plugin rule discovery from ~/.npm-safe/rules/
        scheduler/
          rate-limiter.ts      # TokenBucket — 5 tokens/s, 10 burst
          refresh-scheduler.ts # RefreshScheduler — periodic watchlist refresh via EventEmitter
        store/
          schema.ts        # SCHEMA_SQL (DDL), getMigrationList, getInitialMigration
          database.ts      # DatabaseManager — better-sqlite3 with WAL, migrations
          cache-manager.ts # CacheManager — TTL-based get/set for packages, reports, watchlist, settings
        translator/
          types.ts         # TranslationProvider interface, target-language config
          provider.ts      # Built-in translation provider implementation
      test/
        validator.test.ts      # package name/version/domain validation tests
        static-rules.test.ts   # 10 rules + scoring/level tests
        rate-limiter.test.ts   # token bucket tests
        store.test.ts          # database + cache manager tests
        client.test.ts         # registry client tests (mock fetch, proxy)
        refresh-scheduler.test.ts # scheduler event tests
        engine.test.ts         # NpmSafeEngine integration tests
        cli.test.ts            # CLI tests (commands, lang, shorthand)
        llm-provider.test.ts   # createLlmProvider factory + shared behaviour
        llm-gemini.test.ts     # Gemini LLM provider tests
        llm-anthropic.test.ts  # Anthropic LLM provider tests
        llm-config.test.ts     # LLM configuration persistence and engine integration
        rule-config.test.ts    # RuleConfigManager persistence tests
        rule-loader.test.ts    # Plugin rule discovery tests
        rule-plugin.test.ts    # Rule registration and engine integration tests
    desktop/                         # @npm-safe/desktop (Neutralinojs GUI)
      package.json                   # desktop workspace package
      neutralino.config.json         # Neutralino app config (borderless, extensions)
      resources/
        index.html                   # Material You UI with Navigation Drawer
        styles.css                   # M3 light/dark themes, custom title bar
        js/main.js                   # frontend IPC bridge + dashboard logic
        js/neutralino.js             # Neutralinojs client library
        js/neutralino.d.ts           # Neutralinojs type definitions
        icons/
          appIcon.png                # app icon
          trayIcon.png               # tray icon
          logo.gif                   # logo animation
        extensions/core/main.mjs     # Node.js extension hosting NpmSafeEngine
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
                           |  29 public methods     |
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
| **Scanner** | `scanner/static-rules.ts`, `scanner/rule-config.ts`, `scanner/rule-loader.ts`, `scanner/types.ts` | Pure static analysis of package metadata and README content. Ten built-in rules detect install scripts, obfuscation, typosquatting, secret exposure, homograph attacks, and more; plus runtime rule registration, per-rule config overrides, and plugin discovery. |
| **Scheduler** | `scheduler/refresh-scheduler.ts`, `scheduler/rate-limiter.ts` | Manages periodic refresh cycles for watched packages. A token bucket (5 tokens/s, 10 burst) limits registry request frequency. |
| **Store** | `store/database.ts`, `store/cache-manager.ts`, `store/schema.ts` | Persistent storage via better-sqlite3 with WAL mode. Handles migrations, TTL-based caching of metadata and scan reports, watchlist persistence, and key-value settings. |
| **Facade** | `index.ts` | The `NpmSafeEngine` class composes all four layers. Exposes 29 public methods: `checkPackage`, `searchPackages`, watchlist CRUD, refresh operations, settings access, lifecycle, rule management, and LLM configuration (`startAutoRefresh`, `stopAutoRefresh`, `close`). |

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

## Publishing

`@npm-safe/core` is published to the npm registry from GitHub Actions with
SLSA provenance attestation. To release a version:

1. Create an npm automation token and store it as the `NPM_TOKEN` GitHub
   secret on the repository.
2. Tag the release: `git tag v0.1.0 && git push origin v0.1.0`.
3. The `Publish` workflow (`.github/workflows/publish.yml`) runs tests and
   the build, then runs `npm publish --provenance --access public`.

Publishing requires GitHub Actions OIDC, so `npm publish` run locally will
not attach provenance and is not the supported path.

---

## What Is Next (Phase 3)

Phase 1 delivered a working, tsc-clean engine core. Phase 2 completed the test
suite, CLI, proxy support, the LLM scan provider with persisted configuration,
a Neutralinojs desktop GUI, a plugin system for custom scan rules, LLM
configuration management (CLI + GUI), CI/CD integration, multi-package batch
operations, report export, opt-in telemetry, a shared check history between
CLI and GUI, and an install-time security gate (shell wrappers + PATH shims +
doctor), followed by a security hardening pass (2026-08-02) that fixed
12 issues found by a bug screen. The final two Phase 3 items were completed
on 2026-08-04:

- **Structured command logs.** Every CLI invocation appends one JSONL line to
  `~/.npm-safe/commands.jsonl` (`{ timestamp, command, argv, exitCode,
  durationMs }`), wired via `process.on("exit")`.
- **npm publisher configuration.** `publishConfig` (`access: "public"`,
  `provenance: true`), full package metadata, and `.npmignore`. The actual
  publish must go through the GitHub Actions workflow, since provenance
  requires OIDC.

The project is feature-complete: all planned work items are done.


