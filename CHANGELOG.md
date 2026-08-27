# Changelog

All notable user-facing changes are documented here. The project follows
semantic versioning for `@npm-safe/core`.

## Unreleased

### Security

- Report every install-time lifecycle script and escalate remote downloads,
  shell pipelines, raw-IP fetches, process execution, and encoded payloads.
- Remove the package `postinstall` hook. The bundled AI-agent skill is now
  installed only through an explicit `npm-safe skill install` command.
- Declare the Node.js 20+ runtime requirement in the published package
  manifest, not only at the private workspace root.
- Publish a security reporting policy and an explicit threat model.

### Added

- GitHub Issue forms, pull request template, Code of Conduct, and Dependabot
  configuration.
- Public product roadmap and reusable GitHub Actions example.

### Documentation

- Clarify that the current scanner inspects registry metadata, the package
  manifest, and README content, but not tarball source code yet.
- Align all documented runtime requirements with Node.js 20 or later.

## 1.0.5 - 2026-08-13

- Add the desktop application release bundle and automatic resource updates.
- Add CI dependency scanning, report export, local telemetry, shared history,
  install-gate diagnostics, and multi-agent skill installation support.
