# @npm-safe/core

A local-first npm supply-chain security engine. Its default scan analyzes
published metadata and README content. Opt-in deep mode also verifies and
inspects the published tarball for unsafe archive structure, executable
content, obfuscation, process/network combinations, and sensitive data access.

Default static analysis runs locally: metadata and scan reports are cached in
a SQLite database, and registry requests are rate-limited. No LLM service is
required for static scanning. Optional source review sends selected excerpts
to the configured model service only after an explicit opt-in.
Deep scanning is bounded, runs in memory, and never extracts or executes the
package; see the [threat model](https://github.com/nisconder/npm-safe/blob/main/docs/THREAT_MODEL.md).

Complete scans with HIGH findings are at least `suspicious`; CRITICAL findings
are `dangerous`. `safe` means no configured high-risk signal was detected.
Review each finding: scores are not safety probabilities, and both false
positives and missed detections are possible. Passing tests verifies tested
behavior, not real-world detection accuracy.

Version 2.0.0 adds optional source review with a separate switch that remains
off for new installations and upgrades, including existing metadata LLM users.
Read the [2.0.0 upgrade notes](https://github.com/nisconder/npm-safe/blob/main/CHANGELOG.md#200---2026-11-12)
before relying on numeric scores or security levels in automation.

## Features

- **Static analysis engine** — 10 built-in rules (install scripts, eval
  obfuscation, base64 shells, binary links, typosquatting, secret exposure,
  child_process in browser targets, suspicious build metadata, homograph
  attacks, registry mismatch) with severity-weighted scoring (0–100).
- **Deep package-content scan** — 17 configurable rules, npm integrity
  verification, safe in-memory TAR parsing, and strict resource/origin limits.
- **Visual DSH installation preflight** — resolve an npm package or public
  GitHub repository to an immutable source, check lifecycle scripts, DSH core
  duplication, bundle patch files, and peer compatibility, then return a
  red / amber / green card plus a pinned command without installing anything.
- **Optional LLM semantic scan** — OpenAI / Gemini / Anthropic backends,
  disabled by default; falls back to environment variables when no API key
  is configured.
- **Optional source review** — separately opt into `llm enable-source` for
  deep checks; validates source citations, permits one bounded supplement,
  preserves static alerts and reports unknown/failed reviews explicitly.
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
npm-safe check lodash --deep   # verify + inspect the published tarball
npm-safe ci --lockfile         # gate a project's dependencies
npm-safe ci --lockfile --deep  # fail closed if a deep scan cannot complete
npm-safe install axios         # install through the opt-in security gate
npm-safe doctor                # diagnose the installation
```

After configuring and enabling an LLM provider, opt in to source review with
`npm-safe llm enable-source`, then run `npm-safe check <package> --deep`.
Use `npm-safe llm disable-source` to turn it off. A requested source review that
fails or remains unknown makes an otherwise safe result `unknown`; existing
static alerts and scores are retained. See the
[source-review guide](https://github.com/nisconder/npm-safe/blob/main/docs/source-review.md)
for provider setup, evidence limits and data transmission.

## Documentation

- Full project README (setup, architecture, design decisions):
  <https://github.com/nisconder/npm-safe>
- Public API reference: [`API.md`](API.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Built-in scan rules: [`SCANNER_RULES.md`](SCANNER_RULES.md)

## License

Apache-2.0
