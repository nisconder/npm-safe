---
name: npm-safe-scan
description: Automatically scan any npm package for supply-chain security risks BEFORE the user installs it. Trigger this skill whenever the user asks to install, add, or upgrade an npm package or dependency (e.g. "npm install X", "install X", "add X as a dependency", "yarn add X", "pnpm add X", "upgrade X"), or wants to check/search/watch npm packages, scan a project's dependencies, or get a security score for any package name. Invoke the npm-safe CLI to check, search, watch, refresh, configure rules/LLM, run CI scans, and export reports.
---

# npm-safe-scan

This skill invokes the `npm-safe` CLI to statically and semantically analyze npm packages for supply-chain security risks. The engine inspects a package for suspicious install and lifecycle scripts, obfuscation, typosquatting and homograph lookalikes, exposed secrets, malicious binary downloads, and registry mismatches, then assigns a security score and severity level. Results are cached in a local SQLite database (default `~/.npm-safe/npm-safe.db`), requests are rate-limited to respect the registry, and everything runs locally with no external server required.

## Core rule: check before you install

Whenever the user wants to install, add, or upgrade an npm package (including transitive dependencies of something they install), run a security check FIRST:

1. Identify the package name and version.
2. Run `npm-safe check <name>` (add `--refresh` if a cached result may be stale).
3. Interpret the result:
   - **safe** — proceed with the install normally.
   - **suspicious** — mention the findings and recommendations; install only with user consent.
   - **dangerous** or **unknown** — do not install silently. Report the findings (rule, message, recommendation) and ask the user whether to continue.
4. After installing a package the user picked, you may record it: `npm-safe watch add <name>` if they want ongoing monitoring.

For a project-wide safety gate (e.g. before committing a lockfile change), run `npm-safe ci --lockfile` and act on the exit code (0 = pass, 2 = dependency reached the fail threshold).

## Prerequisites

- Node.js 18 or newer, and pnpm.
- Build the CLI first from the repository:

  ```
  pnpm -F @npm-safe/core run build
  ```

Two invocation paths are available:

1. **Global binary** (recommended for brevity): after running `cd packages/core && npm link` inside the repo, call `npm-safe ...` from anywhere.
2. **Direct from the repository** (no global install needed): from the repo root, call:

   ```
   node packages/core/dist/cli/cli.js ...
   ```

If the CLI is not found, locate the repository (or the global binary) before running commands. When the agent is running inside a different project directory, use the full repo path or the global binary.

## Commands reference

| Command | Description | Example |
| --- | --- | --- |
| `npm-safe check <package>` | Check a package's security posture (cache-first). | `npm-safe check react` |
| `npm-safe check <pkg1> <pkg2> ...` | Batch check multiple packages at once. | `npm-safe check lodash express axios` |
| `npm-safe check --file deps.txt` | Read package names from a file (one per line, `#` comments). | `npm-safe check --file deps.txt` |
| `npm-safe check detail <n>` | Re-render the full report of the n-th package of the last batch. | `npm-safe check detail 2` |
| `npm-safe <package>` | Shorthand for `check`. | `npm-safe lodash` |
| `npm-safe search <query>` | Search the npm registry. Add `-s/--size <n>` to set result count (default 20). | `npm-safe search aws-sdk -s 10` |
| `npm-safe watch list` | List watched packages. | `npm-safe watch list` |
| `npm-safe watch add <package>` | Add a package to the watchlist. | `npm-safe watch add express` |
| `npm-safe watch remove <package>` | Remove a package from the watchlist. | `npm-safe watch remove express` |
| `npm-safe refresh [package]` | Refresh one watched package, or all watched packages when omitted. | `npm-safe refresh` |
| `npm-safe ci` | Scan a project's direct dependencies; fail the build on severe findings. | `npm-safe ci --fail-level dangerous` |
| `npm-safe ci --lockfile` | Scan every dependency (incl. transitive) in `package-lock.json`. | `npm-safe ci --lockfile` |
| `npm-safe report <pkg...>` | Export reports as JSON/CSV (`--format`, `--output`, `--file`, `--batch`). | `npm-safe report lodash --format csv` |
| `npm-safe rules list` | List scan rules with effective status. | `npm-safe rules list` |
| `npm-safe rules enable/disable <rule-id>` | Enable or disable a rule (persisted). | `npm-safe rules disable install-script` |
| `npm-safe rules severity <rule-id> <severity>` | Override a rule's severity. | `npm-safe rules severity typosquatting critical` |
| `npm-safe llm status` | Show LLM provider status (optional semantic scan). | `npm-safe llm status` |
| `npm-safe llm enable` | Enable optional LLM scanning. | `npm-safe llm enable` |
| `npm-safe llm set-provider <openai\|gemini\|anthropic>` | Select the LLM provider. | `npm-safe llm set-provider openai` |
| `npm-safe llm set-key <api-key>` | Set the LLM API key. | `npm-safe llm set-key $OPENAI_API_KEY` |
| `npm-safe llm set-model <model>` | Set the LLM model. | `npm-safe llm set-model gpt-4o-mini` |
| `npm-safe llm test-connection` | Verify the LLM provider works. | `npm-safe llm test-connection` |
| `npm-safe settings get <key>` | Read a setting value. | `npm-safe settings get proxy` |
| `npm-safe settings set <key> <val>` | Persist a setting value. | `npm-safe settings set proxy http://127.0.0.1:7897` |
| `npm-safe lang [en\|zh]` | Set output language, or show the current one when omitted. | `npm-safe lang zh` |
| `npm-safe telemetry status` | Show opt-in local telemetry stats. | `npm-safe telemetry status` |

Global options apply to every command: `-d/--db <path>` to override the database path (default `~/.npm-safe/npm-safe.db`), `-p/--proxy <url>` to route requests through a proxy for one invocation, `-j/--json` for machine-readable output, and `-v/--version` to print the version.

## Workflows

- **Check a package before installing it** (the primary workflow)

  ```
  npm-safe check <name>
  ```

  or the shorthand form:

  ```
  npm-safe <name>
  ```

- **Check multiple packages in one pass**

  ```
  npm-safe check <name1> <name2> <name3>
  ```

  then drill into one of them:

  ```
  npm-safe check detail 2
  ```

- **Audit a project's dependencies (CI gate)**

  ```
  npm-safe ci --dir <project-dir>
  npm-safe ci --lockfile --fail-level dangerous
  ```

  Exit code 2 means at least one dependency reached the fail level — report it and treat the change as blocked.

- **Search the registry to find the right package name**

  ```
  npm-safe search <query>
  ```

- **Watch a package, then refresh it**

  ```
  npm-safe watch add <name>
  npm-safe refresh
  ```

- **Enable optional LLM semantic scanning** (requires an API key)

  ```
  npm-safe llm enable
  npm-safe llm set-provider openai
  npm-safe llm set-key <api-key>
  npm-safe llm test-connection
  ```

- **Export a report for an audit**

  ```
  npm-safe report lodash express --format csv --output report.csv
  ```

- **Read and write settings**

  ```
  npm-safe settings get <key>
  npm-safe settings set proxy http://127.0.0.1:7897
  ```

- **Switch output language**

  ```
  npm-safe lang zh
  ```

## Output interpretation

A `check` result reports:

- **Security level**: one of `safe`, `suspicious`, `dangerous`, or `unknown`.
- **Score**: 0 to 100, where higher is safer.
- **Findings count**: the number of issues raised against the package.

In JSON mode (`-j`), the relevant fields are:

- `security.overallLevel` — the overall severity level.
- `security.overallScore` — the numeric score (0-100).
- `security.staticScan.findings` — an array of findings; each finding contains:
  - `ruleId` — the rule identifier that fired.
  - `ruleName` — the human-readable rule name.
  - `severity` — the severity of the finding.
  - `message` — what was detected.
  - `recommendation` — how to address it.
  - `category` — the finding category (for example, suspicious script, obfuscation, typosquatting, or secret).
- `security.llmScan` — optional semantic analysis when an LLM provider is configured.

Present `safe` packages as low risk, flag `suspicious` and `dangerous` packages with their findings and recommendations, and treat `unknown` as an inconclusive result worth a closer look. Before installing a package, use the result as a go/no-go signal: only `safe` (or explicit user consent for others) should proceed.

Every check is persisted to the shared `~/.npm-safe/npm-safe.db` (check history + metadata + reports), so the desktop GUI and later CLI runs pick it up without re-fetching.

## Error handling

- **Registry 404**: the package does not exist in the registry. Verify the package name (including scope and case) and suggest the correct name, or a near-match from `npm-safe search`.
- **Network failure**: the registry or metadata fetch failed. Suggest retrying with a proxy:

  ```
  npm-safe check <name> -p http://127.0.0.1:7897
  ```

- **Non-zero exit code**: the command failed. Read the error message on stderr, and consider checking the database path (`-d`) if a local storage error is reported.

## Proxy guidance

On restricted networks, pass the proxy for a single invocation:

```
npm-safe check <name> -p http://127.0.0.1:7897
```

or persist it as a setting so every command uses it:

```
npm-safe settings set proxy http://127.0.0.1:7897
```

Verify the persisted value with `npm-safe settings get proxy`.
