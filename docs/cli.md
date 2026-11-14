# CLI reference

The `npm-safe` binary ships with `@npm-safe/core`. Requires Node.js 20.12+.

Global options:

- `-d, --db <path>` — custom SQLite database path (default `~/.npm-safe/npm-safe.db`)
- `-p, --proxy <url>` — HTTP proxy for registry requests
- `-j, --json` — JSON output
- `-v, --version` — print version

## Check and inspect

```bash
npm-safe <package>                  # shorthand for check
npm-safe check <package>            # check a package's security posture
npm-safe check <pkg1> <pkg2> ...    # batch check
npm-safe check --file deps.txt      # read package names from a file
npm-safe check -r <package>         # force re-fetch from registry (ignore cache)
npm-safe check --deep <package>     # verify and inspect the published tarball
npm-safe check detail 2             # full report of the 2nd package of the last batch
npm-safe diff <package> 1.0.0 1.1.0 # compare two exact releases (deep scan + manifest changes)
npm-safe search <query>             # search the npm registry
npm-safe search <query> -s 10       # limit the number of results
```

## Watch and refresh

```bash
npm-safe watch list                 # list watched packages
npm-safe watch add <package>        # add a package to the watchlist
npm-safe watch remove <package>     # remove a package from the watchlist
npm-safe refresh [package]          # refresh one (or all watched) packages
```

## Settings, language, rules

```bash
npm-safe settings get <key>         # read a setting
npm-safe settings set <key> <val>   # write a setting
npm-safe lang [en|zh]               # get or set the output language
npm-safe rules list                 # list scan rules with effective status
npm-safe rules enable <rule-id>     # enable a scan rule (persisted)
npm-safe rules disable <rule-id>    # disable a scan rule (persisted)
npm-safe rules severity <rule-id> <severity>  # override a rule's severity
```

## LLM (optional, off by default)

```bash
npm-safe llm status                 # show LLM provider status
npm-safe llm enable                 # enable LLM scanning
npm-safe llm disable                # disable LLM scanning
npm-safe llm enable-source          # opt into source review on deep checks
npm-safe llm disable-source         # disable source review (default)
npm-safe llm set-provider <openai|gemini|anthropic>
npm-safe llm set-key <api-key>      # set the LLM API key
npm-safe llm set-model <model>      # set the LLM model identifier
npm-safe llm set-base-url <url>     # set a custom LLM API base URL
npm-safe llm test-connection        # test the LLM connection
```

## CI

```bash
npm-safe ci                         # scan direct dependencies, fail on severe findings
npm-safe ci --lockfile              # scan every dependency (incl. transitive) in the lockfile
npm-safe ci --lockfile --deep       # also inspect each tarball; fail closed if incomplete
npm-safe ci --fail-level suspicious # stricter gate (default: dangerous)
npm-safe ci --prod                  # skip devDependencies
npm-safe ci --json                  # machine-readable report
npm-safe ci --rate-limit 50         # registry requests per second
```

Exit codes: `0` pass, `1` usage/config error, `2` a dependency reached the fail
level or the scan errored. Critical findings always block; unknown packages and
incomplete deep scans fail closed.

## Reports, telemetry, history

```bash
npm-safe report lodash express      # export security reports (JSON to stdout)
npm-safe report --format csv lodash express
npm-safe report --file deps.txt --format csv --output report.csv
npm-safe report --batch             # export the last batch check
npm-safe telemetry status           # show telemetry status (opt-in, local only)
npm-safe telemetry enable|disable|export|reset
```

## Install gate (opt-in)

```bash
npm-safe gate status                # show install gate status
npm-safe gate enable                # enable the gate + auto-install wrappers/shims
npm-safe gate disable               # turn the gate off
npm-safe gate set-threshold 90      # raise the bar (default 85)
npm-safe gate shell                 # refresh wrappers/shims; leave persistent PATH unchanged
npm-safe gate shell --user          # Windows: prepend shims to user PATH
npm-safe gate shell --machine       # Windows (admin): prepend shims to system PATH
npm-safe gate shell --remove        # remove wrappers/shims
npm-safe install axios              # install with the security gate (if enabled)
npm-safe install axios --yes        # auto-confirm
npm-safe install axios --dry-run    # check + prompt without installing
npm-safe doctor                     # diagnose PATH / gate / shim setup
```

Put package-manager options after `--` when they overlap gate options, e.g.
`npm-safe install -- lodash --dry-run`. The gate's own `--yes` must appear
before the separator.

## AI skill

```bash
npm-safe skill install              # install to ~/.agents/skills/npm-safe-scan/
npm-safe skill install --agent codex,claude-code   # specific agents
npm-safe skill status               # per-agent installation status
npm-safe skill uninstall            # remove (supports --agent)
npm-safe skill                      # interactive installation wizard
```

Supported agents: `codex`, `claude-code`, `opencode`, `trae`, `qoder`, `zcode`,
`gemini-cli`, plus the generic `~/.agents/skills/` directory. Installation is
always explicit; installing the npm package never writes agent configuration.

## Windows PATH note

The default npm global bin directory is `%APPDATA%\npm`; a custom npm prefix
uses its own directory. If it is missing from PATH, add only that directory via
**Environment Variables → User variables → Path → Edit → New**, keep existing
entries, reopen the terminal, then run `npm-safe doctor`.