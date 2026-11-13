# Changelog

All notable user-facing changes are documented here. The project follows
semantic versioning for `@npm-safe/core`.

## 2.0.1 - 2026-11-13

### Fixed

- Distinguish ordinary npm packages from DSH plugins during desktop install
  checks. Only plugins require a bundle patch and DSH host compatibility.
- Require executable shell-command evidence for remote-shell findings rather
  than matching scanner signatures, comments or documentation. Keep unrelated
  object assignments and uncalled function bodies out of command bindings.
- Accept npm's standard boolean `_hasShrinkwrap` metadata without a suspicious
  build-field finding. Invalidate older cached scans; retain malformed fields
  and actual process-execution capabilities as separate evidence.
- Use native desktop window borders and controls so edge resizing, maximize,
  restore and the Windows taskbar work correctly.
- Preserve long Windows PATH values and variable references when explicitly
  configuring `gate shell --user` or `--machine`. Recognize PowerShell profile
  wrappers in diagnostics without requiring persistent PATH changes.
- Explain truncated, filtered and empty model responses without accepting
  reasoning-only output as a completed source review.

## 2.0.0 - 2026-11-12

### Added

- Default-off LLM source review for deep checks, enabled separately with
  `llm enable-source`. OpenAI-compatible, Gemini and Anthropic providers can
  inspect bounded source excerpts and request one supplement. Reports preserve
  exact evidence, coverage and uncertainty without clearing static findings or
  changing static scores. Source reviews are not cached; failures cannot count
  as a completed clean result. Selected source is sent to the configured model.

### Fixed

- Require argument-local encoding evidence for JavaScript dynamic-execution
  findings. Lodash global-object probes and template compilation no longer
  inherit an obfuscation alert from unrelated data or comments in the file.
  Invalidate older scan reports so cached results are re-evaluated as well.
- Classify complete scans with High findings as at least `suspicious`, keeping
  the score unchanged. Explain the severity floor and heuristic limits in the
  CLI and documentation; invalidate older cached reports.
- Detect bounded private-key/seed-to-network flows, connected downloads with
  silent process execution, and concealed process/file/network capabilities
  recovered from constant string tables without executing package code.
  Respect later object fields and spreads that overwrite private data, including
  nested serialized payloads and accessor/method overrides.
- Inspect text files up to 4 MiB with a 1,600,000-token lexical budget. Retain
  the 8 MiB aggregate text limit and visible partial results on exhaustion.

### Upgrade notes

- Review consumers of the security level: a complete scan with a High finding
  is now at least `suspicious`, even when its numeric score is 80 or above.
  Severity weights are unchanged. CI still defaults to failing on `dangerous`;
  use `--fail-level suspicious` when High findings should fail the gate.
- Upgrading does not enable LLM source review. New and existing configurations
  default to `sourceReview: false`; an enabled metadata LLM does not opt in to
  source transmission. Enable/configure the provider, then use
  `llm enable-source` and an explicit deep check to opt in.
- Deep checks with source review enabled return an independent
  `security.sourceReview` report. A missing provider, failed request, invalid
  response or unknown model verdict makes an otherwise safe result `unknown`.
  Model findings can raise the combined level but cannot clear static alerts
  or change the static score. Clients should inspect the level and evidence,
  not infer the combined decision from the numeric score alone.
- Source review sends bounded excerpts to the configured model service and
  may make two API calls. Reviews are not cached. See
  [source review](docs/source-review.md) for data transmission, limits and
  [the integration evaluation](docs/evaluation/source-integration-2026-11-12.md)
  for observed results and remaining misses/false positives.

## 1.1.3 - 2026-11-10

### Fixed

- Keep Commander on the Node.js 20-compatible 14.x line so installations honor
  the documented Node.js 20.12 minimum.
- Preserve failing exit codes in JSON package checks, batches, and saved details.
- Scan the versions, ranges, tags, and npm aliases declared in package.json;
  reject unsupported dependency sources before CI can report a clean result.
- Apply the configured CI package-check rate limit and reject malformed limits.
- Preserve valid npm names ending in punctuation while continuing to reject
  whitespace and unsupported package sources.

- Detect concealed native-loader invocations assembled from quoted string
  fragments and combined browser response interception/payment-address signals.
- Exclude ordinary function syntax and JavaScript comments/string examples from
  dynamic-execution evidence. Report lexical inspection budgets as incomplete.
- Require local decoded-shell commands in README checks, inspect executable URL
  path suffixes, and distinguish response-to-command flow from incidental
  network/process capabilities.
- Reduce deep-scan token allocation with necessary-condition prefilters and a
  faster lexer that preserves token streams, offsets and resource limits.

### Added

- Compare two exact published versions with `npm-safe diff`: static finding
  deltas, registry-manifest changes and complete scan evidence. Incomplete
  inspection remains inconclusive instead of claiming signals were resolved.
- Freeze reproducible family-level evaluation splits, exclude declared observed
  inputs from test selection, and evaluate one split without opening the other.
  A harmless synthetic corpus demonstrates the workflow without new accuracy claims.
- Add regression and benign-behavior tests plus a fixed ten-version control
  challenge to compare detections, false positives, coverage and scan time.

## 1.1.1 - 2026-10-23

### Fixed

- Package desktop releases separately for Windows, Linux, and macOS with a
  bundled Node.js runtime, physical extension, and matching native SQLite
  dependency. Verify the extracted application before publishing it. Existing
  desktop users must download the complete 1.1.1 ZIP to migrate safely.
- Run gated Windows installs exactly once, preserve npm/pnpm/yarn command
  selection, arguments, and exit codes, and prevent shim recursion.
- Resolve explicit package versions, tags, and ranges before scanning and bind
  installs to those inspected versions. Reject unsupported sources and require
  confirmation when a bare install has no resolved installation plan.
- Keep JSON output parseable when confirmation is declined or input ends;
  validate CLI and desktop thresholds as integers from 0 to 100.
- Refresh shell blocks without damaging surrounding configuration and support
  removing machine PATH activation. Make doctor honor the selected database
  and handle unreadable configuration while continuing diagnostics.

### Added

- Add a visual DSH installation preflight to the desktop app for npm package
  names and public GitHub repositories. It checks lifecycle scripts, shared
  runtime dependencies, dependency sources, `dsh.bundle.patch`, published
  patch-file presence, and `@deepseek-ai/dsh-tools` peer compatibility.
- Generate copyable installation commands pinned to an exact npm version or
  immutable GitHub commit. Packages with install-time scripts default to
  `--ignore-scripts`; the risk-card flow never performs installation.

## 1.1.0 - 2026-08-29

### Fixed

- Pin the workspace to pnpm 10 and let GitHub Actions resolve that single
  version source, preserving the advertised Node.js 20.12 CI compatibility.
- Enumerate TypeScript test files in a cross-platform launcher instead of
  relying on shell/Node glob expansion that fails on the Node 20 Linux runner.
- Keep `undici` on the Node 20-compatible 6.x line so the package's declared
  Node.js 20.12 runtime floor is exercised successfully in CI.
- Keep the token-bucket refill timer referenced while consumers are queued so
  Node.js 20 cannot exit with their promises still pending.

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
