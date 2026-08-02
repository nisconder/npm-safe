---
name: npm-safe-scan
description: Scan npm packages for supply-chain security risks using the local npm-safe engine. Use when the user wants to check a package for vulnerabilities, suspicious scripts, typosquatting, exposed secrets, or homograph attacks; search the npm registry; watch packages; or get a security score for lodash/react/express or any npm package name. Invoke the npm-safe CLI to check, search, watch, refresh, and configure.
---

# npm-safe-scan

This skill invokes the `npm-safe` CLI to statically and semantically analyze npm packages for supply-chain security risks. The engine inspects a package for known vulnerabilities, suspicious install and lifecycle scripts, typosquatting and homograph lookalikes, and exposed secrets, then assigns a security score and severity level. Results are cached in a local SQLite database (default `~/.npm-safe/npm-safe.db`), requests are rate-limited to respect the registry, and everything runs locally with no external server required.

## Prerequisites

- Node.js 18 or newer, and pnpm.
- Build the CLI first from the repository:

  ```
  pnpm -F @npm-safe/core run build
  ```

Two invocation paths are available:

1. **Global binary** (recommended for brevity): after running `cd packages/core && npm link` inside the repo, call `npm-safe ...` from anywhere.
2. **Direct from the repository** (no global install needed): from the repo at `C:\Users\huangshengting\npm-store`, call:

   ```
   node packages/core/dist/cli/cli.js ...
   ```

If the CLI is not found, locate the repository (or the global binary) before running commands. When the agent is running inside a different project directory, use the full repo path or the global binary.

## Commands reference

| Command | Description | Example |
| --- | --- | --- |
| `npm-safe <package>` | Shorthand for `check`. | `npm-safe lodash` |
| `npm-safe check <package>` | Check a package's security posture. | `npm-safe check react` |
| `npm-safe search <query>` | Search the npm registry. Add `-s/--size <n>` to set result count (default 20). | `npm-safe search aws-sdk -s 10` |
| `npm-safe watch list` | List watched packages. | `npm-safe watch list` |
| `npm-safe watch add <package>` | Add a package to the watchlist. | `npm-safe watch add express` |
| `npm-safe watch remove <package>` | Remove a package from the watchlist. | `npm-safe watch remove express` |
| `npm-safe refresh [package]` | Refresh one watched package, or all watched packages when omitted. | `npm-safe refresh` |
| `npm-safe settings get <key>` | Read a setting value. | `npm-safe settings get proxy` |
| `npm-safe settings set <key> <val>` | Persist a setting value. | `npm-safe settings set proxy http://127.0.0.1:7897` |
| `npm-safe lang [en\|zh]` | Set output language, or show the current one when omitted. | `npm-safe lang zh` |

Global options apply to every command: `-d/--db <path>` to override the database path (default `~/.npm-safe/npm-safe.db`), `-p/--proxy <url>` to route requests through a proxy for one invocation, `-j/--json` for machine-readable output, and `-v/--version` to print the version.

## Workflows

- **Check a package**

  ```
  npm-safe check <name>
  ```

  or the shorthand form:

  ```
  npm-safe <name>
  ```

- **Check with JSON output** (useful for scripting or further analysis)

  ```
  npm-safe check <name> -j
  ```

- **Search the registry**

  ```
  npm-safe search <query>
  ```

- **Watch a package, then refresh it**

  ```
  npm-safe watch add <name>
  npm-safe refresh
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
  - `category` — the finding category (for example, vulnerability, suspicious script, or secret).

Present `safe` packages as low risk, flag `suspicious` and `dangerous` packages with their findings and recommendations, and treat `unknown` as an inconclusive result worth a closer look.

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
