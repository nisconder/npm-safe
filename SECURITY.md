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

## API Keys

Prefer provider-specific environment variables over persisted LLM keys. When a
key is saved, npm-safe stores it locally in `~/.npm-safe/llm.json` and attempts
to restrict the file to the current user (`0600` where supported). Never
include that file in a bug report.
