# Compare two published releases

`npm-safe diff` answers **which static signals changed between these two exact
versions?** It always downloads and deep-scans both tarballs, using the existing
same-origin download policy, integrity checks, archive limits and rule engine.
It does not install a package or execute its contents.

```sh
npm-safe diff lodash 4.17.20 4.17.21
npm-safe diff @scope/package 1.0.0 1.1.0 --json
```

Both versions must be exact canonical semver strings. `latest`, ranges, partial
versions and `v` prefixes are rejected before network access. Scoped package
names are supported. Global `--db` and `--proxy` options work as with `check`.
The command is available from a build of this source; the change does not itself
publish a new npm package.

The report contains:

- The two selected versions, declared integrity/shasum values and full static
  reports, including scores, integrity verification, skipped files and reasons
  for partial/failed inspection.
- Changes to scripts, dependency declarations, entrypoints, exports/imports,
  package files, engines, platforms and module type. Paths are JSON Pointers;
  `/dependencies/@scope~1package` refers to dependency `@scope/package`. Object
  key order is ignored; array order remains significant.
- Added, removed and persisting findings, retaining paths, line numbers,
  snippets, severity and recommendations. A persisted finding retains both
  before and after evidence, so line or severity changes remain visible.

Matching uses a multiset of `(ruleId, filePath, codeSnippet-or-message)`, ignoring
line offsets. A moved line can persist; a renamed file or changed snippet can
appear as removal plus addition. This is **signal comparison, not AST-level
semantic equivalence**.

## Incomplete comparisons

If either scan is partial/failed, or scanner fingerprints do not match, the
comparison is `inconclusive`. Matched observations can still persist, but
unmatched findings go into `unverifiedBefore` / `unverifiedAfter`. They are
never asserted to be new or resolved. Operational incomplete/unavailable
notices remain in the full reports rather than becoming behavioral changes.

Exit codes are identical for text and JSON:

| Code | Meaning |
| --- | --- |
| `0` | Comparison completed within the scanner's scope, regardless of findings |
| `1` | Invalid input, missing version/manifest, metadata or configuration error |
| `2` | Comparison is inconclusive, including partial or failed deep scans |

**Exit 0 is not an approval to install.** Inspect the target report and findings,
or use the existing CI/install policy for enforcement.

## Evidence boundary

One fresh package metadata snapshot supplies both version manifests. The diff
does not resolve `latest`, reuse cached security reports, include package-level
README evidence, or invoke the optional LLM. README text commonly describes a
different version, so including it would misrepresent a release-specific change.
The current configured static rules apply to both versions. Custom rule plugins
retain the engine's existing trusted-local-code behavior.

Manifest changes describe **registry version manifests**, not proof that those
fields match the tarball's `package.json`. This MVP does not compare transitive
dependency trees, execute code, track cross-file behavior, accept local archives
or verify source-repository reproducibility. Complete inspection still skips
unsupported file types; integrity verification is reported separately. A lost
signal is not proof that a capability or risk was removed.

JSON and text may contain package snippets or manifest values. Review exports
before sharing them. Terminal control characters are escaped in the text view.

## API

```ts
const engine = new NpmSafeEngine();
try {
  const report = await engine.comparePackageVersions('lodash', '4.17.20', '4.17.21', {
    signal: abortController.signal,
  });
  console.log(report.findings.added, report.manifestChanges);
} finally {
  engine.close();
}
```

`ReleaseDiffReport`, `ReleaseSnapshot`, `ManifestChange`,
`compareReleaseSnapshots` and `diffReleaseManifests` are exported. The pure
comparison function can also compare caller-supplied static snapshots, and
marks missing/different scanner identities inconclusive.
