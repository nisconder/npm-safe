# Changelog

All notable user-facing changes are documented here. The project follows
semantic versioning for `@npm-safe/core`.

## Unreleased

### Fixed

- Pin the workspace to pnpm 10 and let GitHub Actions resolve that single
  version source, preserving the advertised Node.js 20.12 CI compatibility.
- Enumerate TypeScript test files in a cross-platform launcher instead of
  relying on shell/Node glob expansion that fails on the Node 20 Linux runner.

### Security

- Add opt-in bounded tarball scanning with same-origin download enforcement,
  streamed compressed-size limits, SRI/shasum verification, safe in-memory TAR
  parsing, path/link checks, and decompression/entry/file/text ceilings.
- Detect remote shell pipelines, encoded dynamic execution, process/network
  combinations, sensitive environment access with networking, and bundled
  native/executable content in published package files. Deep CI scans fail
  closed when inspection is partial or unavailable.

- Redact LLM API keys, proxy credentials, auth tokens, and arbitrary setting
  values before writing CLI arguments to the local command log, and restrict
  the log to the current user (`0600`) where supported.
- Report every install-time lifecycle script and escalate remote downloads,
  shell pipelines, raw-IP fetches, process execution, and encoded payloads.
- Remove the package `postinstall` hook. The bundled AI-agent skill is now
  installed only through an explicit `npm-safe skill install` command.
- Declare the Node.js 20+ runtime requirement in the published package
  manifest, not only at the private workspace root.
- Publish a security reporting policy and an explicit threat model.
- Refuse automated or manual releases when the requested tag/version does not
  match the core and desktop package manifests.

### Added

- Add `--deep` to package checks, batch checks, CI dependency scans, and the
  install gate, with cached content-scan summaries and file/line findings.

- Add root-level `build`, `typecheck`, `test`, `verify`, and package dry-run
  commands for a consistent contributor and CI workflow.
- Cap test-file concurrency to avoid exhausting process and memory limits on
  smaller developer machines and CI runners.
- GitHub Issue forms, pull request template, Code of Conduct, and Dependabot
  configuration.
- Public product roadmap and reusable GitHub Actions example.

### Documentation

- Document the default metadata boundary, opt-in deep content scan, safety
  limits, rule catalogue, and CI failure behavior.
- Align all documented runtime requirements with Node.js 20.12 or later.

## 1.0.5 - 2026-08-13

- Add the desktop application release bundle and automatic resource updates.
- Add CI dependency scanning, report export, local telemetry, shared history,
  install-gate diagnostics, and multi-agent skill installation support.
