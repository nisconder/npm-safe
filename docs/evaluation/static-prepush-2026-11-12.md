# Static patch pre-push recheck — 2026-11-12

Review before pushing found another false-positive boundary in the new
private-material flow detector: a later duplicate field or object spread could
replace a private key with a redacted value, but the detector retained the old
value. The fix resolves final data properties in source order, including nested
serialized objects and bounded local-object spreads. Accessor/method overrides
retain an unknown-value marker when spread, so they also erase stale evidence.
Unknown spreads or computed keys invalidate earlier evidence; later explicit
fields can still establish a signal. Package code is never evaluated.

Four regression test groups cover 31 positive and negative assertions. They
exercise duplicate fields, body/headers, nested JSON, computed literal keys,
local aliases, unknown overwrites and accessors/methods inside spreads.

The [repair cohort](repairs-2026-11-12.md) and the subsequent
[fresh-package cohort](fresh-2026-11-12.md) were both rerun with the fix. Their
original reports and source fingerprints remain unchanged. This recheck uses
all **46 observed package versions: 16 malicious and 30 normal controls**, with
the same verified artifact and dataset hashes. It is development regression
data, not a fresh independent accuracy measurement.

| Cohort | Malicious alerts | Normal-control alerts | Complete deep scans |
| --- | ---: | ---: | ---: |
| Earlier repairs | 8/8 | 0/18 | 26/26 |
| Previously fresh cohort | 0/8 | 2/12 | 20/20 |
| Combined | 8/16 | 2/30 | 46/46 |

All 92 metadata/deep outcomes retain their previous scores, levels, completion
status and rule/severity findings. There are **no newly introduced alerts or
misses in these cohorts**; the eight known misses and two known false positives
remain. Passing these checks does not establish general detection accuracy.

[Machine-readable results](static-prepush-2026-11-12.results.json) record the
new scanner source identity, dataset hashes, compact per-package outcomes and
an empty change list. Original artifact provenance is retained in the two
linked cohort reports. Local raw archives and validation logs are not committed.

Validation on Windows x64 / Node 24.22.1: TypeScript checking and build passed;
the full core suite passed 686 tests with 2 skips and no failures; evaluation
and partition harnesses passed 12 tests. The final secret-flow and archive
integration subset passed all 36 tests. Tests requiring network access and
Git Bash were run outside the restricted process environment.
