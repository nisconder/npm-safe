# Threat Model

This document explains what npm-safe currently protects, what it trusts, and
how to interpret its output.

## Assets

npm supply-chain attacks can expose developer and CI assets including npm
tokens, source-control credentials, cloud keys, SSH keys, environment
variables, source code, and workstation files.

## Adversaries and Scenarios

npm-safe is designed to surface early warning signals from:

- typosquatting and Unicode homograph packages;
- packages with install-time lifecycle scripts;
- lifecycle scripts that download or execute remote payloads;
- suspicious or obfuscated snippets exposed in package metadata or README
  content;
- leaked secrets and direct binary download links in published metadata;
- registry metadata inconsistencies;
- compromised maintainers publishing a suspicious new version.

## Current Inspection Boundary

The default scan inspects public registry metadata, the selected version's
manifest, and its README. With `--deep`, npm-safe additionally downloads a
same-origin tarball, verifies npm integrity metadata when present, and parses
the archive in memory. It applies bounded high-confidence text and archive
rules to JavaScript, TypeScript, shell scripts, native files, and binaries.

Deep scanning does **not** extract files to disk, build a complete AST, execute
the package, follow runtime imports, or observe runtime behavior. Its default
limits are 20 MiB compressed, 50 MiB unpacked, 5,000 entries, 1 MiB per text
file, and 8 MiB total inspected text. A limit produces a visible partial scan;
CI deep mode treats partial or failed scans as a failed gate.

Optional LLM analysis receives a bounded subset of the same README and manifest
data. It is disabled by default and only runs after the user configures a
provider.

## Trust Assumptions

- Registry responses and network transport are trusted to represent the
  requested package metadata and tarball. Integrity checks detect byte-level
  mismatch when the registry publishes an SRI value or legacy shasum.
- The local machine, SQLite database, and npm-safe installation are assumed not
  to be compromised already.
- Configured LLM providers are trusted with the data sent to them.
- Custom rule plugins are trusted local code and run with the CLI's privileges.

## Out of Scope

The current scanner does not guarantee detection of:

- malicious code hidden through semantics that the bounded content rules do
  not recognize;
- dependency vulnerabilities identified by CVE or OSV advisories;
- behavior that appears only after package execution;
- attacks against a compromised registry, network, operating system, or
  package manager;
- every possible typosquat, because the offline popular-package reference set
  is intentionally bounded;
- malicious behavior intentionally concealed from heuristic or LLM analysis.

Use `npm audit`, OSV-Scanner, or another vulnerability database alongside
npm-safe. Run untrusted builds with minimal credentials and privileges.

## Score Interpretation

The score is a triage aid. It is calculated from weighted rule findings and is
not a probability, certification, or guarantee of safety. Review every finding
and treat a clean result as "no configured signal detected," not "safe to
execute."

## Data Flow

By default, npm-safe contacts the configured npm registry for metadata. Deep
mode also fetches the selected tarball from that same origin. Results are
stored locally in `~/.npm-safe/`. It sends no telemetry unless the user
explicitly enables local telemetry collection; that telemetry is still not
transmitted. Enabling an LLM provider sends bounded scan input to that
provider's configured endpoint.
