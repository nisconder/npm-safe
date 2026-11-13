# Optional LLM source review

Available in `@npm-safe/core` 2.0.0 and later. Source review is disabled by
default, including for existing LLM configurations after an upgrade.
It requires an enabled/configured LLM provider and a separate source switch.
It runs on explicit deep checks (`check --deep`, `ci --deep`, or
`engine.checkPackage(name, {deep: true})`). Ordinary checks and background
refresh retain the existing metadata-only behavior.

To upgrade the global CLI to this release, run
`npm install -g @npm-safe/core@2.0.2`. Confirm `npm-safe --version` and
`npm-safe llm status` before opting in. Upgrading alone does not enable source
review or send source to a model. The [2.0.0 upgrade notes](../CHANGELOG.md#200---2026-11-12)
also describe the new High-finding severity floor and CI implications.

```sh
npm-safe llm set-provider openai   # or gemini / anthropic
npm-safe llm set-model <model>
# Supply the provider key via its environment variable or llm set-key.
npm-safe llm enable
npm-safe llm enable-source
npm-safe check lodash --deep --json
npm-safe llm disable-source
```

`llm status` displays the source switch separately. `llm disable` disables the
provider entirely. An enabled source switch with a missing/disabled provider
produces a skipped, unknown source report on deep checks. No source is sent in
that state, and the check cannot be mistaken for a completed clean review.

## Processing and transmission

The engine downloads one tarball under the existing registry-origin and size
policy, then uses those same bytes for static scanning and source selection.
Published integrity/shasum is verified when available. Package code is never
extracted, imported or executed. No model tools are enabled. Source comments,
README, paths and strings are untrusted data, not reviewer instructions.

The initial view contains at most 40,000 UTF-16 source characters from up to
16 files: 8,000 per source file, 2,000 manifest and 1,200 README, plus bounded
manifest context and a source index. The model may request one batch of up to
four indexed ranges, at most 40,000 extra characters and 24,000 per file.
The second call includes the initial evidence again: total source transmission
can reach 120,000 characters across two calls. Prompt JSON and instructions
together are capped at 512 KiB per call; model JSON responses at 256 KiB;
HTTP response envelopes at 1 MiB before parsing.

Selected source goes to the configured service. This increases latency and
API use and can send secrets embedded in a package to that service; there is
no automatic source redaction. Configured response-token and timeout limits
apply per call. `maxInputChars` controls the legacy metadata review; source
evidence uses the fixed bounds above.

Source review replaces the metadata model call for that deep check. Reviews
are not cached: each enabled deep check performs a new review, even when
metadata is cached. Changing the model, endpoint or switch cannot reuse a
previous source judgment.

## Results and uncertainty

`security.staticScan` remains the original static report.
`security.sourceReview` includes status, verdict, exact quotes and offsets,
coverage/omissions, limitations, archive hash, protocol identity, call count
and character accounting. Characters are not tokens or costs;
`sourceCharsSent` includes retransmitted initial evidence.

| Source outcome | Combined behavior |
| --- | --- |
| `malicious` with validated High/Critical evidence | Adds findings to level classification; retains static findings and numeric score. |
| `benign` | Cannot clear static alerts or raise the score; applies only to the supplied view. |
| `unknown`, invalid response, failure or skipped requested review | An otherwise safe result becomes unknown; established static suspicious/dangerous results remain. |

Static completeness policy still applies: incomplete scans remain unknown
unless danger is established. A score of 100 can accompany a source-based
suspicious/dangerous result because the score describes static findings.
Review level and evidence together. CI fails on unknown; use
`--fail-level suspicious` to fail on High findings too.

Exact quote validation rejects invented locations and altered snippets. It
does not prove the reasoning correct. Omitted files, native code, dependencies
and runtime payloads remain limitations. Confidence is subjective. Both misses
and false positives remain possible; the union cannot remove static false
positives.

If a final review miscounts offsets but its exact quote occurs uniquely in
the already supplied excerpts for the same path, the engine can correct the
coordinates before full validation. It does not use fuzzy matching, search
unprovided source, or change the quote or path. Ambiguous or unverifiable
evidence remains invalid.

When corrections occur, `security.sourceReview.evidenceOffsetCorrections`
records `findingIndex`, `evidenceIndex`, `originalStartOffset`,
`originalEndOffset`, `startOffset`, and `endOffset` in JSON for auditing. The
CLI and desktop show only the correction count. This local correction sends
no additional source and adds no model call or retry; it does not rewrite the
model's verdict or the static score. All evidence still undergoes full
validation, and an invalid final review remains failed/unknown.

## Programmatic use

```ts
const engine = new NpmSafeEngine({
  llm: { provider: LlmProviderType.OpenAi, apiKey: process.env.OPENAI_API_KEY },
  sourceReview: true,
});
try {
  const result = await engine.checkPackage('lodash', { deep: true });
  console.log(result.security.sourceReview);
} finally { engine.close(); }
```

Persisted configuration uses `setLlmConfig({sourceReview: true})`. Custom
providers can implement optional `reviewSource({systemPrompt, prompt, signal})`,
returning raw JSON text. Exported `reviewPackageSource(archive, manifest,
provider, signal?)` runs the same bounded coordinator. Providers without that
method return skipped/unknown. External cancellation propagates.
