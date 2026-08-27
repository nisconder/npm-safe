# Security Policy

Security reports are welcome and are handled privately.

## Supported Versions

The latest published release receives security fixes. Older releases are
supported on a best-effort basis; users should upgrade before reporting an
issue that is already fixed in the latest version.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Email **1031402408@qq.com** with the subject `[npm-safe security]` and include:

- the affected version and component;
- reproduction steps or a minimal proof of concept;
- the expected security impact;
- any suggested mitigation, if available.

You should receive an acknowledgement within three business days. We will
coordinate a fix and disclosure timeline with you after confirming the issue.
Please allow a reasonable remediation window before publishing details.

## Scope

Reports about the following are in scope:

- the `@npm-safe/core` engine and CLI;
- install-gate command construction or bypasses;
- unsafe package parsing, local file access, or credential exposure;
- desktop application IPC and update behavior;
- bundled AI-agent skill installation and configuration handling;
- GitHub Actions and npm publishing workflows.

## Security Model

Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before relying on a scan
result. npm-safe is a heuristic early-warning layer, not proof that a package
is safe. A high score must not replace code review, lockfiles, least-privilege
CI, vulnerability scanning, or runtime isolation.

The opt-in deep scanner never extracts or executes package contents. It
requires tarball URLs and redirects to remain on the configured registry
origin, verifies published integrity metadata when available, streams with a
compressed-size ceiling, and enforces decompressed, entry, file, and total-text
limits. Report parser bypasses, unsafe archive handling, integrity-validation
errors, or network-policy bypasses as security vulnerabilities.

## API Keys

Prefer provider-specific environment variables over persisted LLM keys. When a
key is saved, npm-safe stores it locally in `~/.npm-safe/llm.json` and attempts
to restrict the file to the current user (`0600` where supported). Never
include that file in a bug report. CLI diagnostic logs redact keys and other
credential-bearing arguments before writing them to
`~/.npm-safe/commands.jsonl`.

If you used `npm-safe llm set-key` with version 1.0.5 or earlier, inspect and
remove `~/.npm-safe/commands.jsonl`, then rotate that provider key. Those
versions could persist the expanded key value in the local diagnostic log.
