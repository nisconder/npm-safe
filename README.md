# @npm-safe: Local npm Package Security Engine

[中文版](README_zh.md)

![Version](https://img.shields.io/github/v/release/nisconder/npm-safe?label=Version&color=2196F3)
![License](https://img.shields.io/badge/license-Apache--2.0-4CAF50)
![Language](https://img.shields.io/badge/Language-TypeScript-3178C6?logo=typescript&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/nisconder/npm-safe/ci.yml?branch=main&label=CI)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Desktop](https://img.shields.io/badge/Desktop-Neutralinojs-purple)

@npm-safe is a local-first engine for analyzing npm packages against known
supply-chain attack patterns. It fetches package metadata from the public npm
registry, runs static analysis rules against the metadata and README content,
caches results in a local SQLite database, and exposes a typed API for
querying, watching, and refreshing security assessments. The engine is
designed to operate as a library rather than a standalone service.

## Quick Start

Requires Node.js 18 or later.

**Install as a CLI (global):**

```bash
npm install -g @npm-safe/core
npm-safe check lodash
```

**Install as a library:**

```bash
npm install @npm-safe/core
```

```ts
import { NpmSafeEngine } from "@npm-safe/core";

const engine = new NpmSafeEngine();
const result = await engine.checkPackage("lodash");
console.log(result.security.overallLevel, result.security.overallScore);
engine.close();
```

---

## CLI Usage

The `npm-safe` binary ships with the `@npm-safe/core` package. Global options:

- `-d, --db <path>`: custom SQLite database path (default `~/.npm-safe/npm-safe.db`)
- `-p, --proxy <url>`: HTTP proxy for registry requests
- `-j, --json`: JSON output
- `-v, --version`: print version

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

A few everyday examples:

```bash
npm-safe check react                # check a single package
npm-safe search "web framework"     # search the npm registry
npm-safe watch add lodash           # watch a package for changes
npm-safe refresh                    # refresh all watched packages
npm-safe settings set lang zh       # persist a setting
```

Example output:

```bash
npm-safe check lodash
# Package: lodash
# Latest version: 4.18.1
# Security level: suspicious
# Score: 65/100
# Findings: 5
# ...
```

> **Windows PATH note:** a global install places `npm-safe` in the npm global
> bin directory (`%APPDATA%\npm`), which must be on your `PATH` for external
> terminals to find it. The official Node.js MSI adds it automatically; for
> custom installs (e.g. Node unpacked to a custom folder) add it yourself:
> `setx PATH "%APPDATA%\npm;%PATH%"`, then reopen the terminal. If anything
> looks off, run `npm-safe doctor` for a diagnosis.

The deeper features (proxy details, custom rule plugins, LLM scanning, CI/CD,
batch operations, report export, telemetry, the shared check history, the
command log, and the install-time security gate) are covered in the
[Features](#features) section below.

---

## Desktop GUI

A Neutralinojs desktop app (Material You dashboard with check, search, watch,
rules, LLM, and settings tabs) is distributed as a portable ZIP asset on each
GitHub Release, not as an npm package. To download:

1. Open the [Releases page](https://github.com/nisconder/npm-safe/releases).
2. Pick the latest release and download the portable ZIP
   (`npm-safe-release.zip`).
3. Unzip and run the `npm-safe` executable (Windows) or `npm-safe` binary
   (macOS/Linux). The app bundles the `@npm-safe/core` engine and stores data
   in `~/.npm-safe/`.

The app checks for updates automatically on startup: when a newer version is
available on the Releases page, it prompts and installs the update in place,
then restarts. Only the first installation requires a manual ZIP download;
subsequent updates are automatic.

What the GUI offers:

- **Overview dashboard**: average security score with a half-circle gauge,
  recent checks list, 7-day check histogram, total count, and risk breakdown.
- **Check**: enter a package name and view the security level, score, and
  findings.
- **Search**: keyword search against the npm registry; click a result to jump
  straight to Check.
- **Watch**: manage the watchlist and refresh individual packages or all
  watched packages.
- **Rules**: list all registered rules, toggle each rule, and override its
  severity; reload custom rule plugins from `~/.npm-safe/rules/`.
- **LLM**: configure optional LLM scanning with a test-connection button.
- **Settings**: read/write arbitrary engine settings (e.g. `proxy`, `lang`),
  including the install gate.
- **Light/Dark themes** and **custom window chrome**: two independent Material
  You palettes from the custom title bar, with the theme and last active tab
  remembered across sessions.

Check history is persisted by the Node.js extension process to the shared
SQLite database (`~/.npm-safe/npm-safe.db`, `check_history` table); see
[Shared check history](#shared-check-history).

> **Windows first run:** if the WebView2 window fails to load with a loopback
> error, run once in an administrator PowerShell:
> `CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.Win32WebViewHost_cw5n1h2txyewy"`.

Developer instructions for running and building the desktop app live in
[CONTRIBUTING.md](CONTRIBUTING.md); the app itself is documented in the
[Desktop README](packages/desktop/README.md).

---

## AI Skill

The `npm-safe-scan` agent skill (for AI agents that auto-load
`~/.agents/skills/`) is bundled with the package but is NOT installed
automatically. When you install `@npm-safe/core` in an interactive terminal,
you are asked whether to install it; in CI or other non-interactive
environments it is skipped silently.

To manage the skill manually:

- `npm-safe skill install` — install to `~/.agents/skills/npm-safe-scan/`
- `npm-safe skill status` — check whether it is installed
- `npm-safe skill uninstall` — remove it

The skill lets AI agents invoke `npm-safe` commands (check, search, watch,
refresh, settings, lang) to scan npm packages.

---

## Features

### Proxy

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

### Rules and plugins

Ten built-in rules detect install scripts, obfuscation, typosquatting, secret
exposure, homograph attacks, and more. Rules can be managed at runtime;
configuration is persisted in `~/.npm-safe/rules.json`:

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
exported from `@npm-safe/core` for programmatic use. See
[SCANNER_RULES.md](packages/core/SCANNER_RULES.md) for the built-in rule
reference.

### LLM scanning

LLM-based semantic scanning is optional and disabled by default. When no API
key is configured, static analysis continues normally. Providers: OpenAI,
Gemini, Anthropic. Configuration is persisted in `~/.npm-safe/llm.json` and
can also be supplied via environment variables (`OPENAI_API_KEY`,
`GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`).

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
workflow lives at `.github/workflows/ci.yml`; it runs the test suite, type
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

Every package checked via the CLI (`check` / `ci`), and every check run
inside the desktop GUI, is written to the shared SQLite database
(`~/.npm-safe/npm-safe.db`, `check_history` table, newest-first, capped at
1000). The desktop GUI's overview dashboard loads this history directly, so
packages scanned on the command line appear in the app, and vice versa.
Legacy `~/.npm-safe/history.json` data is migrated into the database once on
first launch. Programmatic access: `engine.recordCheckHistory(result)`,
`engine.getCheckHistory()`, `engine.clearCheckHistory()`.

The desktop extension also honours the persisted `proxy` setting: on startup
it reads the settings table and configures the engine, so a proxy configured
in the GUI or via `npm-safe settings set proxy ...` applies to desktop scans
too.

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
**PATH shims** into `~/.npm-safe/bin` (npm.cmd / pnpm.cmd / yarn.cmd; they
work in every shell), and appends wrapper functions for `npm`, `pnpm`, and
`yarn` to your shell config (PowerShell `$PROFILE` on Windows,
`~/.zshrc`/`~/.bashrc` otherwise). How to activate:

| Your shell | Activation |
|---|---|
| PowerShell / bash / zsh | Just restart the shell; the profile wrappers load automatically |
| **Windows cmd** (or any shell where the shim dir isn't first in PATH) | Run **once as administrator**: `npm-safe gate shell --machine`; this prepends the shim directory to the **system** PATH, so every new terminal (incl. cmd) is intercepted. Reopen terminals afterwards. |

On Windows, only the system PATH reliably precedes the Node.js installation
directory; user-PATH edits are not enough when a tool puts the machine PATH
first. `npm-safe doctor` verifies that `where npm.cmd` resolves to the shim
first and prints the exact fix.

Pass `--shell-file <path>` to target a specific config file, `--no-shell` to
skip. After activation, any `pnpm add <pkg>` or `npm install <pkg>` first
runs `npm-safe install ...`; the gate checks the package and asks for
confirmation below the threshold before the real package manager runs.
Remove everything with:

```bash
npm-safe gate shell --remove
```

The gate shares the same settings table as the GUI, so the CLI switch and the
GUI toggle stay in sync.

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
into the core scan pipeline but is fully typed and importable.

---

## Documentation

Detailed documentation is available under `packages/core/`:

- **[ARCHITECTURE.md](packages/core/ARCHITECTURE.md)**: layer map, module dependency graph, data flow diagrams (hot path and refresh path), database schema (ERD), migration system, error taxonomy, and annotated design decisions.
- **[API.md](packages/core/API.md)**: complete public API reference covering the `NpmSafeEngine` class (all 29 public methods), exported interfaces, and all type definitions (`SecurityLevel`, `Severity`, `FindingCategory`, `CheckResult`, `ScanFinding`, `StaticScanReport`, etc.).
- **[SCANNER_RULES.md](packages/core/SCANNER_RULES.md)**: comprehensive reference for all 10 built-in static analysis rules. Each rule documents its category, severity, detection logic (regex patterns), and mitigation recommendations.
- **[CONTRIBUTING.md](CONTRIBUTING.md)**: developer guide covering development setup, code conventions, testing, the publishing workflow, and the desktop GUI build.
- **[README_zh.md](README_zh.md)**: Chinese translation of the project README.

The desktop GUI lives under `packages/desktop/` and is documented in the
[Desktop README](packages/desktop/README.md).

---

## Directory Structure

```
npm-safe/
  LICENSE                  # Apache-2.0
  README.md                # project README (English)
  README_zh.md             # project README (Chinese)
  CONTRIBUTING.md          # developer guide (setup, conventions, publishing)
  pnpm-workspace.yaml      # workspace = packages/*
  tsconfig.base.json       # shared TypeScript config (ESNext, strict)
  .github/
    workflows/
      ci.yml               # CI: typecheck + tests + dependency security scan
      publish.yml          # npm publish (SLSA provenance, tag-triggered)
      desktop-release.yml  # desktop ZIP assets on GitHub Releases
  packages/
    core/
      package.json         # @npm-safe/core v1.0.0, ESM, publishConfig (public, provenance)
      .npmignore           # publish exclude rules
      tsconfig.json        # extends ../../tsconfig.base.json
      API.md               # public API reference
      ARCHITECTURE.md      # layer map, data flows, DB schema
      SCANNER_RULES.md     # 10 static rule reference
      skill/
        npm-safe-scan/
          SKILL.md         # AI skill, ask-on-install via postinstall / `skill install`
      scripts/
        install-skill.mjs  # postinstall hook
      src/
        index.ts           # NpmSafeEngine facade, unified public API
        cli/               # command implementations, command log, i18n
        llm/               # LLM providers (OpenAI / Gemini / Anthropic)
        registry/          # registry client, validator, types
        scanner/           # StaticAnalyzer, rule config, plugin loader
        scheduler/         # rate limiter + refresh scheduler
        store/             # SQLite database, migrations, cache manager
        translator/        # pluggable translation interface
      test/                # module tests (see CONTRIBUTING.md)
    desktop/               # @npm-safe/desktop (Neutralinojs GUI)
      package.json         # desktop workspace package
      neutralino.config.json  # Neutralino app config (borderless, extensions)
      resources/           # index.html, styles.css, js/, icons/, extensions/core/main.mjs
```

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

## License

Apache-2.0. See [LICENSE](LICENSE).
