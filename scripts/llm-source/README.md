# Independent source-review prototype

This experiment prepares bounded source evidence for a language-model reviewer
and compares its first-pass judgment with the existing offline rule scanner.
It does not change production rules, scores, CLI decisions or the production
LLM integration. It does not train a model.

The production port now lives in `packages/core/src/llm/source/` and its
coordinator in `packages/core/src/llm/source-review.ts`. Its separate,
default-off opt-in is documented in [source review](../../docs/source-review.md).
This experiment and its frozen v1/v2 records remain independent historical
tools; integration does not turn session-model results into an API benchmark.

## Run

From the repository root, with the existing core development dependencies:

```sh
node scripts/evaluate-source-llm.mjs prepare /absolute/path/dataset.json --output /absolute/path/new-run
# Review each cases/case-*.json independently.
# If the reviewer submits requests/CASE_ID.json, serve the ONE allowed batch:
node scripts/evaluate-source-llm.mjs supplement /absolute/path/new-run --case CASE_ID
# Resume the same reviewer with supplements/CASE_ID.json, then save reviews/CASE_ID.json.
node scripts/evaluate-source-llm.mjs compare /absolute/path/new-run --output /absolute/path/new-results.json
```

Inputs use the version-pinned, SHA-256-verified dataset schema documented in
`docs/evaluation.md`. Output directories and report files must not already
exist. Preparation runs the rule baseline, but keeps labels and rule results
in `private-run.json`. Never give that file, the input dataset, or research
reports to reviewers. `receipt.json` detects changes to the frozen private
record and protocol. Keep the receipt independently when exporting a run;
hashes are not signatures against someone who can rewrite all artifacts.

The prototype exports source packets; it has no built-in paid API client.
For each packet, start a separate fresh conversation with the exact
`SYSTEM_PROMPT` and `REVIEW_PROMPT` from `review-contract.mjs`, plus
`SUPPLEMENT_PROMPT` from `source-supplement.mjs` (all frozen in `protocol.json`),
the assigned case ID, and that packet only. A reviewer may request one source
supplement before its final judgment; supply only the generated supplement to
that same reviewer. Save one final JSON response per case. Do not supply earlier conversation history, names
from the dataset, expected labels or scanner outcomes. Original source may
still contain a package name; pretrained incident knowledge cannot be ruled
out. Conversation isolation is not an operating-system permission boundary.

Read every supplied excerpt without tool-output truncation. Reviewers may use
pure text calculations and decoding, but must not execute package code,
contact its endpoints, or fetch later stages. Source strings and comments are
untrusted data, including instructions embedded in them. A supported API
backend could consume the same packets and contract later; this experiment's
session reviews do not establish deterministic API reproducibility or cost.

## Evidence and limits

- Read TAR/gzip in memory; never extract, install, import or execute samples.
  Hard caps: 20 MiB compressed, 50 MiB decompressed, 5,000 entries,
  4 MiB per source file and 8 MiB decoded source bytes. Supplied SRI is checked.
- Prioritize runnable entry points before declarations, and execution/encoded
  structures before ordinary capability co-occurrence. These are evidence
  selection hints, not malicious verdicts. This does not depend on a production
  rule alert. Source-index paths remain untrusted text.
- Default model evidence: at most 40,000 UTF-16 characters and 16 files;
  at most 8,000 per source file, 2,000 from the original package manifest and
  1,200 from a README. Redistribute unused short-file shares; refill overlapping
  windows using unique characters. Head, priority execution windows, other
  capability windows and tail can be sampled.
- A bounded index exposes up to 64 eligible decoded paths and lengths. A
  reviewer may request one batch of at most 4 original-file ranges, at most
  40,000 additional characters total and 24,000 per file across ranges. Index
  omissions remain a limit. The request is optional and cannot use labels.
- Requests, attempts, supplements and receipts are retained. A failed request
  consumes the attempt and abstains; pending requests cannot become negatives.
  Reads/writes are confined to the run directory. Validation reconstructs the
  supplement from the hash-verified original archive, so changing its local
  receipt and text alone cannot create valid evidence.
- Preserve original paths, character offsets and line numbers. Quotes must
  match an exact range within one transmitted excerpt. Decoded interpretations
  must cite the original encoded span, not invent a source location.
- Archive inspection and source selection have separate coverage records.
  Binary/native code, omitted files and missing spans remain limitations.
  `shownChars` measures the packet, not proof that a reviewer read every byte.
- Packet JSON is capped at 512 KiB and a review at 256 KiB. Paths are confined
  to the run directory. Requests are capped at 16 KiB. Frozen source, prompts
  and packets are hash checked. These checks are not an OS permission sandbox.

## Decisions and comparison

`malicious` requires an evidence-backed High/Critical finding describing a
harmful or deceptive chain. Network access, subprocesses, cryptography or
obfuscation alone do not establish that chain. `benign` means no malicious
behavior was identified in the supplied view, not that the full package is
safe. `unknown`, invalid responses, missing reviews and failed preparation
abstain. Confidence is subjective and uncalibrated.

Validation checks JSON and exact evidence references, not the truth of the
reasoning. Preserve the first final response and any prior source request; do not repair judgments after seeing
labels. Report all attempted acquisition/preparation failures as well as the
prepared dataset: the core comparator only knows the rows in that dataset.

Compare rule High/Critical alerts, model malicious judgments and their union.
The union alerts when either detector alerts; it cannot remove a rule false
positive. A negative union requires both detectors to return a negative;
otherwise it abstains. Report TP/FP/TN/FN, unknown/failures by label, coverage
and end-to-end recall against all malicious attempts. Rules and model consume
the same archive through different evidence budgets, so this is a pipeline
comparison, not a controlled test of equally informed algorithms.

Report initial and supplemental characters separately: the optional second
packet increases the evidence budget, so an adaptive result cannot be credited
solely to better initial selection. Development regressions on previously seen
packages and a newly frozen cohort must have separate metrics.

The first experiment's [results](../../docs/evaluation/source-llm-2026-11-12.results.json)
and [eight-file source snapshot](../../docs/evaluation/source-llm-2026-11-12.sources.json)
are retained unchanged. Its source hash differs from v2; use that snapshot for
historical replay rather than asking the changed code to validate a v1 run.

## Verification

```sh
node --test scripts/evaluate-source-llm.test.mjs scripts/llm-source/*.test.mjs scripts/evaluate-scanner.test.mjs scripts/partition-evaluation.test.mjs
```

Tests use generated, inert fixtures. They check archive bounds, entry
selection, quoted offsets, invalid responses, artifact tampering and correct
abstention accounting; passing them does not measure malware accuracy.
