# Contributing to @npm-safe

Thanks for considering contributing to `@npm-safe/core`. This guide covers the
development workflow: environment setup, code conventions, testing, building
the desktop GUI, adding scan rules, and publishing a release.

For an overview of the project and its features, see [README.md](README.md).
For deeper design material, see [ARCHITECTURE.md](packages/core/ARCHITECTURE.md),
[API.md](packages/core/API.md), and
[SCANNER_RULES.md](packages/core/SCANNER_RULES.md).

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- [pnpm](https://pnpm.io/) 9 or later

### Install dependencies

```bash
pnpm install
```

### Typecheck

```bash
pnpm -F @npm-safe/core exec tsc --noEmit
```

The TypeScript compiler (`tsc`) is installed as a per-package devDependency
under pnpm's isolated store and is **not hoisted** to the workspace root.
Running `npx tsc` or `tsc` at the top level will therefore fail. The
`pnpm -F @npm-safe/core exec tsc --noEmit` workaround invokes the correct
binary via pnpm's filtered execution. The same pattern applies to any other
per-package CLI tool.

### Build

```bash
pnpm -F @npm-safe/core run build
```

### Link the CLI locally

```bash
pnpm -F @npm-safe/core run build
cd packages/core && npm link
```

> **Windows PATH note:** `npm link` installs `npm-safe` into the npm global
> bin directory (`%APPDATA%\npm`), which must be on your `PATH` for external
> terminals to find it. The official Node.js MSI adds it automatically; for
> custom installs (e.g. Node unpacked to a custom folder) add it yourself:
> `setx PATH "%APPDATA%\npm;%PATH%"`, then reopen the terminal. If anything
> looks off, run `npm-safe doctor` for a diagnosis.

## Project Structure

The repository is a pnpm workspace (`packages/*`):

- `packages/core/`: the engine, the CLI, and the `npm-safe-scan` AI skill.
  Source lives in `src/` with one directory per layer (`cli/`, `llm/`,
  `registry/`, `scanner/`, `scheduler/`, `store/`, `translator/`). See the
  [README Directory Structure](README.md#directory-structure) for the full
  tree.
- `packages/desktop/`: the Neutralinojs desktop GUI (see
  [Desktop GUI Build](#desktop-gui-build)).

## Code Conventions

- **Strict TypeScript, no `any`.** Every function and interface is fully
  typed. The project compiles with `--strict` and zero implicit `any`.
- **250-LOC ceiling per module.** Keep each file focused and reviewable. The
  facade (`index.ts`) is the only module that modestly exceeds this limit due
  to its composition responsibilities.
- **ESM-only with `.js` import specifiers.** The packages are
  `"type": "module"`; all imports must use `.js` specifiers as required by
  native ESM.
- **Formal documentation, zero emoji.** Keep code comments, READMEs, and other
  docs formal and professional.
- **Test new behavior.** Add or update tests alongside any change; test files
  live in `packages/core/test/` and mirror the module they cover.

The full set of design constraints is documented in the
[Key Design Decisions](README.md#key-design-decisions) table in the README.

## Testing

Run the core test suite:

```bash
pnpm -F @npm-safe/core test
```

The test suite covers every module: validators, published package metadata, the
static rules, the rate limiter, the store layer, the registry client (with
mocked fetch), the refresh scheduler, the engine integration surface, the LLM
providers, the LLM configuration manager, the rule plugin system, the CI
command, batch operations, report export, the telemetry manager, the shared
check history, the install gate, the doctor diagnostics, the structured
command log, and the CLI itself.

CI (`.github/workflows/ci.yml`) runs the test suite, type checks, and a
dependency security scan on every push and pull request.

## Adding a Scan Rule

Built-in rules live in `packages/core/src/scanner/static-rules.ts` and are
documented in [SCANNER_RULES.md](packages/core/SCANNER_RULES.md). Each rule
documents its category, severity, detection logic (regex patterns), and
mitigation recommendations.

Two ways to add a rule:

1. **As a built-in rule**: implement the `ScanRule` interface in
   `static-rules.ts`, register it, and cover it with tests in
   `packages/core/test/static-rules.test.ts`.
2. **As a plugin**: drop an ES module file (`*.mjs` / `*.js`) into
   `~/.npm-safe/rules/` on a user's machine. Plugin files are loaded at engine
   startup; each file may export `rule`, `rules`, or `default` holding one or
   more `ScanRule` objects. See the README
   [Rules and plugins](README.md#rules-and-plugins) section for an example.

The full rule API (`registerRule`, `unregisterRule`, `listRules`,
`setRuleEnabled`, `setRuleSeverity`) is exported from `@npm-safe/core`.

## Desktop GUI Build

The desktop GUI lives in `packages/desktop/` and is built with the
Neutralinojs CLI (`@neutralinojs/neu`, a devDependency).

From `packages/desktop/`:

```bash
neu update          # fetch the Neutralinojs binaries (required first)
neu build --release # produce the release bundle
```

The workspace scripts wrap these: `pnpm run build` runs
`build:core && neu build --release` (with `neu update` as its `prebuild`),
and `pnpm run run` starts the app in development mode (`build:core && neu
update && neu run`).

The release build produces a portable ZIP
(`packages/desktop/dist/npm-safe-release.zip`). This ZIP is the distribution
artifact: the `desktop-release.yml` workflow attaches it, along with the
auto-update manifest and `resources.neu` payload, to the GitHub Release for
each `v*` tag.

## Publishing

`@npm-safe/core` is published to the npm registry from GitHub Actions with
SLSA provenance attestation. To release a version:

1. Create an npm automation token and store it as the `NPM_TOKEN` GitHub
   secret on the repository.
2. Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Publish` workflow (`.github/workflows/publish.yml`) runs tests and
   the build, then runs `npm publish --provenance --access public`.

Publishing requires GitHub Actions OIDC, so `npm publish` run locally will
not attach provenance and is not the supported path.

The same `v*` tag triggers `desktop-release.yml`, which builds the desktop
GUI and attaches the portable ZIP and auto-update assets to the release.

### Verifying a published version

If a Huawei Cloud npm mirror is configured in a local `.npmrc`, `npm view`
may return stale or mirror-cached data. Verify against the official registry
instead:

```bash
npm view @npm-safe/core --registry https://registry.npmjs.org
```

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) license.
