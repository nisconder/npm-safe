# Roadmap

npm-safe aims to become a transparent, local-first package firewall for npm.
This roadmap describes priorities, not promised release dates.

## Now: Metadata Guard + Bounded Content Scan

- Detect risky install-time lifecycle scripts with severity escalation.
- Keep scans local by default and make every rule inspectable and configurable.
- Provide CLI, CI, desktop, and AI-agent workflows from one engine.
- Document limitations and remove automatic setup behavior from package
  installation.
- Offer an opt-in `--deep` path that downloads same-origin tarballs with strict
  compressed/unpacked/file/count limits, verifies published integrity metadata,
  parses without disk extraction, and reports high-confidence content signals.

## Next: Semantic Package-Content Analysis

- Add AST-based rules for process execution, network access, credential access,
  dynamic evaluation, and obfuscation.
- Compare security-relevant behavior between package versions.
- Publish a reproducible benign/malicious benchmark with precision and recall
  measurements.

## Next: Developer Workflow Integrations

- Export SARIF for GitHub code scanning.
- Provide a versioned reusable GitHub Action.
- Add a machine-readable policy file for allowlists, thresholds, and rule
  configuration.
- Emit software bill of materials (SBOM) data for scanned projects.

## Later

- Integrate public malicious-package and advisory feeds with source attribution.
- Detect maintainer, provenance, and release-cadence anomalies.
- Support signed community rule packs.
- Evaluate additional package ecosystems after npm coverage is mature.

## Contributing

Issues and pull requests are welcome. Good first contributions include new test
fixtures, false-positive reductions, rule documentation, and benchmark cases.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting code.
