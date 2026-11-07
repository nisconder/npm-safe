# Freeze a new evaluation split before tuning

The existing 2026-10-31 reports are engineering regression evidence on observed
inputs. Reassigning their `split` values cannot make them independently held out.
This workflow provides reproducible partitioning and selective execution; it
does **not** establish new real-world precision or recall measurements.

## Protocol for a real held-out report

1. Collect new exact-version artifacts following [the evaluation protocol](evaluation.md).
   Independently review labels, retain primary evidence and hashes, and group
   related campaigns/projects into families. Include ordinary process execution,
   installers, bundlers and large packages as controls. Record sampling and
   acquisition failures before observing scanner outcomes.
2. Inventory **every previously observed dataset**, including manual inspection,
   rule development and earlier evaluations. Review aliases/shared code by hand.
   The partitioner recognizes only declared family, exact package/version and
   identical tarball hashes; it cannot discover undisclosed exposure or related
   code in different bytes. Previously observed groups must remain development
   or regression evidence.
3. Fix the seed and fraction once, then publish/commit the split manifest's hash
   before tuning. Keep the entire manifest immutable. Do not try multiple seeds
   after seeing outcomes. A family-only random partition does not ensure class
   balance; report the resulting composition without retrospectively selecting
   an easier test set.
4. Tune only with `--split dev`. Freeze scanner source, rule configuration and
   reporting policy before running `--split test`. Ideally a separate reviewer
   holds test artifacts and performs the final run. The full manifest stays in
   each result, but excluded artifacts are never opened by a split-only run.
5. Report both policies, confusion matrices, coverage, failures/partial scans,
   end-to-end recall, and per-case explanations. Once test outcomes influence
   rule changes, those inputs become regression/development data. Acquire a new
   independent test cohort; don't relabel the old one as held out.

## Deterministic family partitioning

The input is a valid existing-schema dataset, with new samples initially marked
`dev`. The command reads manifests only, not the package artifacts. Output must
be a new file in the input directory so artifact paths continue to resolve.

```sh
node scripts/partition-evaluation.mjs local-corpus/dataset.json --output local-corpus/frozen-split.json --seed predeclared-v1 --test-fraction 0.25 --observed docs/evaluation/pilot-2026-10-31.dataset.json --observed docs/evaluation/round2-2026-10-31.controls.dataset.json
node scripts/evaluate-scanner.mjs local-corpus/frozen-split.json --output local-corpus/dev-results.json --split dev
# Only after freezing the scanner and review protocol:
node scripts/evaluate-scanner.mjs local-corpus/frozen-split.json --output local-corpus/test-results.json --split test
```

Families matching any observed family, package/version or tarball hash are
forced into `dev`. Remaining families are ranked by SHA-256 of `seed + NUL +
family`; the first `ceil(eligible-family-count * testFraction)` enter `test`,
while retaining at least one development family. The fraction is therefore a
family target, not an exact proportion of packages. Output records the source
and observed-manifest hashes, seed, method, test families and exclusions.
Identical tarballs attributed to different families are rejected for review.

The evaluator validates the entire frozen manifest, even in split-only mode.
Cross-split families and identical tarball hashes are rejected. `--split all`
preserves the previous behavior; **use `--split dev` during tuning**. Empty or
unknown split selections fail explicitly. Partial/failed selected scans retain
their denominator and produce exit code 2 as before.

## Runnable synthetic workflow demonstration

With existing development dependencies installed, run these commands from the
repository root. No dependency installation or network request is needed:

```sh
node scripts/create-evaluation-demo.mjs .evaluation-demo
node scripts/partition-evaluation.mjs .evaluation-demo/dataset.json --output .evaluation-demo/frozen-split.json --seed protocol-demo --test-fraction 0.5
node scripts/evaluate-scanner.mjs .evaluation-demo/frozen-split.json --output .evaluation-demo/dev-results.json --split dev
node scripts/evaluate-scanner.mjs .evaluation-demo/frozen-split.json --output .evaluation-demo/test-results.json --split test
node --test scripts/evaluate-scanner.test.mjs scripts/partition-evaluation.test.mjs
```

The generator creates four deterministic, integrity-hashed local archives:
two inert export controls and two encoded **no-op** signal fixtures. The
encoded source payload consists only of `void 0;`; generation and evaluation
never execute even that payload. For compatibility with the binary-label
evaluation schema, alert-positive fixtures carry `label: malicious` with an
explicit synthetic explanation. They are not real malware or independently
reviewed real packages. The complete dataset is `kind: synthetic`, and results
carry the harness-only interpretation.

The demo verifies family separation, fixed inputs, selective execution and
failure accounting against the actual scanner. Its test partition is a
**workflow simulation, not an independent held-out accuracy benchmark**.
The fixtures and expectations are visible during development. Passing them
must not be advertised as real malware recall or real-world zero false positives.
Existing historical report values are unchanged.
