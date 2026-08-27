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

The static engine inspects the public npm registry metadata, the selected
version's package manifest, and its README. It does **not yet download or parse
the package tarball**, build an AST of the shipped source, execute the package,
or observe runtime behavior. Deep tarball inspection is tracked in
[ROADMAP.md](../ROADMAP.md).

Optional LLM analysis receives a bounded subset of the same README and manifest
data. It is disabled by default and only runs after the user configures a
provider.

## Trust Assumptions

- Registry responses and network transport are trusted to represent the
  requested package metadata.
- The local machine, SQLite database, and npm-safe installation are assumed not
  to be compromised already.
- Configured LLM providers are trusted with the data sent to them.
- Custom rule plugins are trusted local code and run with the CLI's privileges.

## Out of Scope

The current scanner does not guarantee detection of:

- malicious code hidden only inside the package tarball;
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

By default, npm-safe contacts the configured npm registry and stores scan
results locally in `~/.npm-safe/`. It sends no telemetry unless the user
explicitly enables local telemetry collection; that telemetry is still not
transmitted. Enabling an LLM provider sends bounded scan input to that
provider's configured endpoint.
