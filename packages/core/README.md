# @npm-safe/core

A local-first npm supply-chain security engine. It analyzes published package
metadata and README content against known attack patterns — suspicious install
scripts, obfuscation, typosquatting and homograph lookalikes, exposed secrets,
binary downloads, and registry mismatches — then assigns a security score and
severity level.

Everything runs locally: metadata and scan reports are cached in a SQLite
database, requests are rate-limited, and no external service is required.
The current inspection boundary does not include package tarball source; see
the [threat model](https://github.com/nisconder/npm-safe/blob/main/docs/THREAT_MODEL.md).

## Features

- **Static analysis engine** — 10 built-in rules (install scripts, eval
  obfuscation, base64 shells, binary links, typosquatting, secret exposure,
  child_process in browser targets, suspicious build metadata, homograph
  attacks, registry mismatch) with severity-weighted scoring (0–100).
- **Optional LLM semantic scan** — OpenAI / Gemini / Anthropic backends,
  disabled by default; falls back to environment variables when no API key
  is configured.
- **CLI** — `check` (single / batch / from file / detail view), `search`,
  `watch`, `refresh`, `rules` (plugin system + per-rule config), `llm`,
  `ci` (dependency gate, incl. full-lockfile scans), `report` (JSON/CSV
  export), `install` (opt-in install gate with confirmation below a
  threshold), `telemetry` (opt-in, local-only), `settings`, `lang`,
  `doctor` (diagnostics).
- **Plugin system** — drop `*.mjs` / `*.js` rule plugins into
  `~/.npm-safe/rules/`; enable/disable and severity overrides persist in
  `~/.npm-safe/rules.json`.
- **Shared check history** — every check is recorded in the local database,
  shared with the desktop GUI.

## Install

```bash
npm install -g @npm-safe/core
```

Requires Node.js 20.12+.

## Quick start

```bash
npm-safe check lodash          # check one package
npm-safe check a b c           # check several at once
npm-safe ci --lockfile         # gate a project's dependencies
npm-safe install axios         # install through the opt-in security gate
npm-safe doctor                # diagnose the installation
```

## Documentation

- Full project README (setup, architecture, design decisions):
  <https://github.com/nisconder/npm-safe>
- Public API reference: [`API.md`](API.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Built-in scan rules: [`SCANNER_RULES.md`](SCANNER_RULES.md)

## License

Apache-2.0
