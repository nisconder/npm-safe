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
limits are 20 MiB compressed, 50 MiB unpacked, 5,000 entries, 4 MiB per text
file, and 8 MiB total inspected text. A limit produces a visible partial scan;
CI deep mode treats partial or failed scans as a failed gate.

For JavaScript, `content-obfuscated-exec` looks for encoded quoted literals or
recognized decoder calls inside `eval`'s first argument or `Function`'s body
argument, within a 256-token call boundary. Unrelated encoded assets, comments,
and global-object probes do not establish this signal. This is a lexical
heuristic, not data-flow proof: values passed through bindings, arbitrary
transforms, aliases, templates or larger expressions may be missed; shadowed
names and incidental decoder calls inside arguments may still cause alerts.
Other text formats retain their broader same-file heuristic.

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
not a probability, certification, or guarantee of safety. Critical findings
or scores below 50 produce `dangerous`; otherwise incomplete scans or invalid
scores produce `unknown`. A High finding makes a complete scan at least
`suspicious`, regardless of its score. Remaining scores of 80 or more produce
`safe`, and 50–79 produce `suspicious`.

`safe` can still include Medium and Low findings. One High finding deducts
15 points: its 85/100 result is `suspicious`, not `safe`.
Review the evidence for every finding. A completed scan with no findings means
"no configured signal detected" within the selected inspection boundary;
even that does not establish runtime safety.

False positives and missed detections are possible. Automated tests verify
the behaviors covered by their cases; passing them does not establish
real-world detection accuracy. See the [evaluation protocol and reports](evaluation.md)
for sample coverage and remaining limitations.

## Data Flow

By default, npm-safe contacts the configured npm registry for metadata. Deep
mode also fetches the selected tarball from that same origin. Results are
stored locally in `~/.npm-safe/`. It sends no telemetry unless the user
explicitly enables local telemetry collection; that telemetry is still not
transmitted. Enabling an LLM provider sends bounded scan input to that
provider's configured endpoint.
