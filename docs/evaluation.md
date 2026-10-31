# Reproducible offline scanner evaluation

This repository has an evaluation harness, a
[six-version real-source pilot](evaluation/pilot-2026-10-31.md), a
[second-round repair and challenge report](evaluation/round2-2026-10-31.md), and a
[third-round precision and performance report](evaluation/round3-2026-10-31.md).
The pilot's two known misses are now regression cases. The second round keeps
those six versions separate from ten provisional benign challenge versions,
reports remaining false positives and incomplete scans, and is not a
representative final accuracy result. The third round keeps the same inputs,
reports the explicit coverage cost of narrower rules, remaining alerts,
incomplete scans, and a fresh serial timing comparison.
The existing rule tests and harness fixtures are synthetic. Do not describe
passing those tests as malware recall.

The pilot, second-round and third-round reports are frozen core 1.1.1
snapshots: their numeric scores, original levels and source fingerprints are
historical measurements. Current core 1.1.2 uses the shared security policy
described below; new runs must retain their own version and source identity.
The [post-merge core 1.1.2 check](evaluation/integration-2026-10-31.md) records
the current policy on the same frozen inputs without replacing old measurements.

Run with the existing development dependencies; the command does not install
anything, contact the network, extract an archive, import a package artifact,
or execute package/lifecycle code:

```powershell
node scripts/evaluate-scanner.mjs .\local-corpus\dataset.json --output .\evaluation-results.json
node --test scripts/evaluate-scanner.test.mjs
```

The `evaluate` and `evaluate:test` package scripts provide equivalent pnpm
aliases. Direct Node commands avoid package-manager startup behavior such as
automatic dependency synchronization in some pnpm environments.

The output directory must exist and the result file must be new. Exit code 0
means all requested scans completed, 2 means at least one scan was partial or
failed (the result file is still saved), and 1 means a dataset/command/output
error. Misclassifications are report data and do not change the exit code.
The runner loads current TypeScript scanner source through the existing
core-local `tsx`, records its file hashes and combined fingerprint, and does
not use potentially stale `dist` files. It uses default built-in rules with
no cache, user overrides, plugins, or LLM.

## Freeze the data before scanning

Store a manifest with exact versions, frozen registry manifests, frozen
README bytes, and original published `.tgz` bytes. Keep a trusted copy of the
dataset manifest: SHA-256 establishes byte identity against that manifest,
not the truth of a malicious/benign label. Keep artifacts local unless their
redistribution is permitted. The runner has no acquisition functionality.

Example schema (the placeholder hashes must be replaced with actual lowercase
SHA-256 values):

```json
{
  "schemaVersion": 1,
  "id": "npm-corpus-v1",
  "kind": "real",
  "samples": [{
    "id": "reviewed-example-1",
    "name": "example-package",
    "version": "1.2.3",
    "label": "benign",
    "family": "example-project",
    "split": "test",
    "provenance": {
      "sourceUrl": "https://registry.npmjs.org/example-package/1.2.3",
      "labelEvidence": "Independent review record or advisory URL; reviewer, date, rationale and limitations",
      "capturedAt": "2026-10-31T00:00:00Z"
    },
    "artifacts": {
      "manifest": {"path": "example/manifest.json", "sha256": "REPLACE_WITH_64_HEX_DIGITS"},
      "readme": {"path": "example/README.md", "sha256": "REPLACE_WITH_64_HEX_DIGITS"},
      "tarball": {"path": "example/package.tgz", "sha256": "REPLACE_WITH_64_HEX_DIGITS"}
    }
  }]
}
```

Paths are relative to the dataset file, use forward slashes, and must stay
inside its directory after resolving symlinks. The parsed manifest name and
version must match the sample. Preserve `dist.integrity`/`dist.shasum` in the
registry manifest: the source scanner validates these separately from the
evaluation harness's SHA-256. An empty README is a legitimate frozen artifact
and still requires a file and hash. Input caps are 8 MiB per manifest/README
and 20 MiB per tarball; scanner resource limits remain unchanged.

Use `kind: "synthetic"` for constructed examples, never mixed into a real
corpus. For real malicious labels, cite a primary advisory/research disclosure
that identifies the exact affected version, and independently inspect its
behavior. For benign labels, record the review basis and acknowledge that an
absence of advisories does not prove safety. Document artifact provenance,
acquisition failures, missing versions, and selection/exclusion decisions.
Publish the frozen manifest before examining final test results.

Start with a small balanced corpus, then expand deliberately. Include normal
native builds, legitimate downloaders and CLI process execution as controls.
Use `dev` to tune rules/thresholds and reserve `test` for final reporting.
Keep variants from the same malicious campaign or normal project in one
`family`; the runner rejects families crossing splits and duplicate package
versions. Family names are reviewed annotations: automatic checks cannot
discover aliases or shared code. Do not tune on the final set and then call it
held out; create a new version of the corpus after such inspection.

## Interpretation and failure accounting

Every sample produces one metadata row and one deep row. The output preserves
full findings, provenance, status, stage, error/reason, and timing, including
missing files, hash mismatches, parser failures and partial content scans.
Metadata needs its manifest/README only, so a missing tarball does not erase
its result. The output also embeds the complete input sample declarations and
the dataset file's SHA-256.

The summary reports `dev` and `test` separately, with two predeclared policies:

| Policy | Positive | Negative | Abstention |
| --- | --- | --- | --- |
| `highCritical` | At least one high/critical finding, excluding scan-availability/completeness notices | No such finding | Failed/partial scan |
| `productLevel` | `suspicious` or `dangerous` | `safe` | `unknown`, failed or partial scan |

Both matrices are about the independently labeled package, not whether a rule
correctly recognizes a benign capability. Current policy first marks any
Critical finding or score below 50 `dangerous`, even if inspection is
incomplete. Otherwise incomplete inspection or a non-finite score is
`unknown`; complete scores 80–100 are `safe`, and 50–79 are `suspicious`.
One high finding costs 15 points, so a complete score of 85 remains `safe`
when no Critical finding is present. Historical 1.1.1 reports used the prior
score bands, including `unknown` below 20; their saved output is not rewritten.
Retain findings and product outcome separately. The evaluation protocol still
excludes all failed/partial attempts from completed-scan matrices, including
ones with established danger; they never become TN. Such dangerous incomplete
reports remain blocking signals in the product and CI.

For each policy the report includes TP/FP/TN/FN, abstentions by true label,
precision, recall and FPR among evaluable rows, coverage, and end-to-end
recall `TP / all labeled malicious attempts`. Undefined rates are `null`.
Use the latter recall together with coverage so failures cannot inflate the
apparent result by disappearing from its denominator. Partial and failed
attempts also have their own counts and incomplete rate. Mode deltas count
added/lost TP and added/removed FP only on pairs evaluable in both modes and
report excluded pair counts. Do not compare differently filtered denominators.

`scanDurationMs` measures only the scanner call; `wallDurationMs` also includes
artifact reads, hashing and parsing. Each scan runs once, serially; summaries
give nearest-rank p50/p95 and the number of observations for both durations.
Scanner duration is null if input validation prevents calling it. Runtime
version/platform/architecture are recorded. Network acquisition time, process
startup and TypeScript loader startup are excluded. Tiny synthetic examples
and single-run timings are not stable performance benchmarks; use a separate
recorded repeated-run protocol for performance claims.

## Known limits and next report

Do not use the production engine cache to compare modes: reports are validated
against the current scanner/rule fingerprint and scanner cache epoch, but are
still stored by name/version, and a metadata request can reuse an earlier deep report.
The production engine also takes README text from package-level metadata,
which may differ from the pinned version. This harness uses the explicitly
frozen README for both modes and records its hash.

The content scanner combines regular-expression inspection, bounded lexical
checks, and explicitly supported local flow, not AST or complete data-flow
analysis. A complete parse does not mean every binary or unknown
file type was semantically inspected; review `filesSkipped`, inspected byte
counts and integrity status. Single-file co-occurrence can flag legitimate
code and miss cross-file, aliased or encoded behavior. Small, selected and
balanced corpora do not establish registry-wide precision or prevalence.

For the first real report, attach the frozen manifest and raw results, present
both mode matrices and coverage, and explain each FP/FN with the triggered or
missing behavior. Record which malicious behaviors metadata cannot see, what
deep scanning adds, and why each failure/partial scan occurred. Compare rules,
AST or LLM approaches only after fixing this protocol and labeling process.
