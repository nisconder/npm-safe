import { createRequire } from "node:module";
import { validatePackageName } from "../registry/validator.js";

const semver = createRequire(import.meta.url)("semver") as {
  validRange(range: string): string | null;
};

export type PackageManager = "npm" | "pnpm" | "yarn";
export const NPM_INSTALL_ALIASES = ["in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"] as const;
export type InstallVerb = "install" | "add" | "i" | "ci" | typeof NPM_INSTALL_ALIASES[number];
export type PackageManagerOptionKind = "value" | "boolean" | "unknown";

export interface RegistryInstallTarget {
  readonly name: string;
  /** A semver version/range or registry dist-tag; absent means the default tag. */
  readonly version?: string;
}

export interface UnsupportedInstallTarget {
  readonly spec: string;
  readonly reason: string;
}

export interface ParsedInstallArguments {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly deep: boolean;
  readonly dir?: string;
  readonly threshold?: number;
  readonly pm?: PackageManager;
  readonly verb?: InstallVerb;
  readonly tag?: string;
  /** Package-manager arguments, including its own literal `--` separator. */
  readonly passthrough: string[];
  /** Supported registry specs, in their original spelling and argument order. */
  readonly packageNames: string[];
  /** Indices of supported specs in passthrough, for exact argument replacement. */
  readonly packageIndexes: number[];
  /** The enabled gate must reject these before running the package manager. */
  readonly unsupportedTargets: UnsupportedInstallTarget[];
}

export class InstallArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallArgumentError";
  }
}

/** Registry dist-tags may not themselves be valid semver ranges. */
function isRegistryTag(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value) && semver.validRange(value) === null;
}

/**
 * Parse only sources the registry scanner can inspect. A returned version is a
 * semver version/range or dist-tag, never a URL, local path, git ref, or npm alias.
 */
export function parseRegistryTarget(spec: string): RegistryInstallTarget {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new InstallArgumentError("An install target must not be empty.");
  }
  if (/\.(?:tgz|tar\.gz)$/i.test(spec)) {
    throw new InstallArgumentError("Local archives cannot be checked by the registry install gate.");
  }
  const separator = spec.lastIndexOf("@");
  const name = separator > 0 ? spec.slice(0, separator) : spec;
  const version = separator > 0 ? spec.slice(separator + 1) : undefined;
  const validation = validatePackageName(name);
  if (!validation.valid) {
    throw new InstallArgumentError(
      "Only npm registry package names, versions, ranges, and dist-tags can be checked; local paths, URLs, git sources, and aliases are unsupported.",
    );
  }
  if (version !== undefined && (version.length === 0 || (semver.validRange(version) === null && !isRegistryTag(version)))) {
    throw new InstallArgumentError(
      "Invalid registry version, range, or dist-tag. Non-registry sources cannot be checked.",
    );
  }
  return version === undefined ? { name } : { name, version };
}

// Options with a mandatory argument must consume that argument before positional
// specs are identified. Keep the spelling in passthrough for the actual manager.
const VALUE_OPTIONS = new Set([
  "--registry", "--tag", "--workspace", "-w", "--filter", "--filter-prod", "-F", "--location",
  "--prefix", "--cwd", "--dir", "-C", "--cache", "--cache-folder", "--global-folder",
  "--modules-folder", "--modules-dir", "--store-dir", "--virtual-store-dir",
  "--lockfile-dir", "--userconfig", "--globalconfig", "--config", "--config-file",
  "--reporter", "--loglevel", "--log-level", "--logs-dir", "--logs-max",
  "--save-prefix", "--save-workspace-protocol", "--save-catalog-name",
  "--access", "--otp", "--auth-type", "--scope", "--script-shell", "--shell",
  "--proxy", "--https-proxy", "--noproxy", "--cafile", "--cert", "--key",
  "--fetch-retries", "--fetch-retry-factor", "--fetch-retry-mintimeout",
  "--fetch-retry-maxtimeout", "--fetch-timeout", "--network-concurrency",
  "--network-timeout", "--child-concurrency", "--workspace-concurrency",
  "--package-import-method", "--node-linker", "--resolution-mode", "--lockfile-version",
  "--include", "--omit", "--only", "--os", "--cpu", "--libc", "--mode", "--install-strategy",
  "--link-workspace-packages", "--ignored-optional-dependencies", "--use-node-version",
]);

// npm accepts unknown configuration flags more permissively than pnpm/yarn.
// Treating a foreign flag as value-taking could hide an actual npm target.
const FOREIGN_NPM_VALUE_OPTIONS = new Set([
  "--filter", "--filter-prod", "-F", "--reporter", "--cache-folder", "--global-folder",
  "--modules-folder", "--modules-dir", "--store-dir", "--virtual-store-dir", "--lockfile-dir",
  "--config", "--config-file", "--log-level", "--save-workspace-protocol", "--save-catalog-name",
  "--shell", "--network-concurrency", "--network-timeout", "--child-concurrency",
  "--workspace-concurrency", "--package-import-method", "--node-linker", "--resolution-mode",
  "--mode", "--link-workspace-packages", "--ignored-optional-dependencies", "--use-node-version",
  "--cwd", "--dir", "-C",
]);

const BOOLEAN_OPTIONS = new Set([
  "--save", "--save-prod", "-P", "--save-dev", "-D", "--dev", "--prod",
  "--save-optional", "-O", "--optional", "--save-peer", "--peer", "--save-exact", "-E",
  "--save-bundle", "-B", "--no-save", "--global", "-g", "--location-global",
  "--ignore-scripts", "--foreground-scripts", "--ignore-engines", "--ignore-platform",
  "--force", "-f", "--legacy-peer-deps", "--strict-peer-deps", "--prefer-dedupe",
  "--package-lock", "--package-lock-only", "--shrinkwrap", "--lockfile-only",
  "--frozen-lockfile", "--pure-lockfile", "--no-lockfile", "--immutable",
  "--immutable-cache", "--check-cache", "--offline", "--prefer-offline", "--prefer-online",
  "--audit", "--fund", "--progress", "--silent", "-s", "--quiet", "-q", "--verbose",
  "--color", "--unicode", "--timing", "--workspaces", "--include-workspace-root",
  "--ignore-workspace-root-check", "-W", "--recursive", "-r", "--production",
  "--strict-ssl", "--bin-links", "--ignore-optional", "--check-files", "--flat",
  "--exact", "--tilde", "-T", "--interactive", "-i", "--help", "-h", "--version", "-v",
  "--ignore-scripts", "--ignore-dep-scripts", "--ignore-pnpmfile", "--fix-lockfile",
  "--no-frozen-lockfile", "--no-optional", "--no-audit", "--no-fund", "--no-progress",
  "--engine-strict", "--install-links", "--prefer-unplugged", "--cached", "--refresh-lockfile",
  "--update-checksums", "--skip-integrity-check", "--non-interactive", "--focus",
  "--workspace-root", "--json", "--dry-run", "--yes", "-y", "--lockfile",
]);

const YARN_VALUE_OPTIONS = new Set([
  "--registry", "--tag", "--cwd", "--cache-folder", "--global-folder", "--modules-folder",
  "--network-concurrency", "--network-timeout", "--proxy", "--https-proxy", "--cafile",
  "--cert", "--key", "--otp", "--access", "--mode",
]);

/** Classify a flag before deciding whether its next token is a command or value. */
export function packageManagerOptionKind(option: string, pm: PackageManager): PackageManagerOptionKind {
  const equals = option.indexOf("=");
  const name = equals > 0 ? option.slice(0, equals) : option;
  if (name === "-w" || name === "--workspace") {
    return pm === "npm" ? "value" : pm === "pnpm" ? "boolean" : "unknown";
  }
  if (/^--@[^:]+:registry$/.test(name)) return "value";
  if (VALUE_OPTIONS.has(name)) {
    if (pm === "npm" && FOREIGN_NPM_VALUE_OPTIONS.has(name)) return "unknown";
    if (pm === "yarn" && !YARN_VALUE_OPTIONS.has(name)) return "unknown";
    return "value";
  }
  if (name === "--save-catalog") return pm === "pnpm" ? "boolean" : "unknown";
  const positiveName = name.startsWith("--no-") ? `--${name.slice(5)}` : name;
  if (BOOLEAN_OPTIONS.has(name) || BOOLEAN_OPTIONS.has(positiveName) || /^-[DPOEfgsqrWBThv]+$/.test(name)) {
    return "boolean";
  }
  return "unknown";
}

/** Whether a known manager flag consumes a separate following token. */
export function packageManagerOptionTakesValue(option: string, pm: PackageManager): boolean {
  return packageManagerOptionKind(option, pm) === "value";
}

// These settings can change the registry, dependency rewrites, or working tree
// behind the gate's back. Recognizing their values alone is insufficient.
const UNSUPPORTED_CONFIGURATION_OPTIONS = new Set([
  "--prefix", "--cwd", "--dir", "-C", "--userconfig", "--globalconfig", "--config", "--config-file",
  "--modules-folder", "--modules-dir", "--lockfile-dir", "--use-node-version",
]);

function publicRegistry(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "registry.npmjs.org" &&
      (url.port === "" || url.port === "443") && url.pathname === "/" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Parse gate options and identify install specs without running a package manager. */
export function parseInstallArguments(args: readonly string[], defaultPm: PackageManager = "npm"): ParsedInstallArguments {
  let yes = false;
  let dryRun = false;
  let json = false;
  let deep = false;
  let dir: string | undefined;
  let threshold: number | undefined;
  let pm: PackageManager | undefined;
  let verb: InstallVerb | undefined;
  let tag: string | undefined;
  let gateOptions = true;
  let literal = false;
  const passthrough: string[] = [];
  const packageNames: string[] = [];
  const packageIndexes: number[] = [];
  const unsupportedTargets: UnsupportedInstallTarget[] = [];

  // Wrappers put --pm before the first --. Learn the manager before parsing
  // manager-specific short flags such as npm -w <workspace> versus pnpm -w.
  let effectivePm = defaultPm;
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    const candidate = arg === "--pm" ? args[index + 1] : arg.startsWith("--pm=") ? arg.slice(5) : undefined;
    if (candidate === "npm" || candidate === "pnpm" || candidate === "yarn") effectivePm = candidate;
  }

  function positional(spec: string): void {
    try {
      parseRegistryTarget(spec);
      packageNames.push(spec);
      packageIndexes.push(passthrough.length - 1);
    } catch (error) {
      unsupportedTargets.push({ spec, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal) {
      passthrough.push(arg);
      positional(arg);
      continue;
    }
    if (arg === "--") {
      if (gateOptions) {
        // The first separator protects the package-manager args from the gate.
        gateOptions = false;
      } else {
        literal = true;
        passthrough.push(arg);
      }
      continue;
    }
    const equals = arg.indexOf("=");
    let option = equals < 0 ? arg : arg.slice(0, equals);
    let inlineValue = equals < 0 ? undefined : arg.slice(equals + 1);

    function valueFor(name: string): string {
      const value = inlineValue ?? args[index + 1];
      if (value === undefined || value.length === 0 ||
          (inlineValue === undefined && value.startsWith("-"))) {
        throw new InstallArgumentError(`${name} requires a value.`);
      }
      if (inlineValue === undefined) index++;
      return value;
    }

    if (gateOptions && ["--yes", "-y", "--dry-run", "--json", "--deep"].includes(option)) {
      if (inlineValue !== undefined) {
        throw new InstallArgumentError(`${option} does not accept a value.`);
      }
      if (option === "--yes" || option === "-y") yes = true;
      else if (option === "--dry-run") dryRun = true;
      else if (option === "--json") json = true;
      else deep = true;
      continue;
    }
    if (gateOptions && option === "--dir") {
      dir = valueFor(option);
      if (!dir.trim()) throw new InstallArgumentError("--dir requires a non-empty directory.");
      continue;
    }
    if (gateOptions && option === "--threshold") {
      const value = valueFor(option);
      if (!/^\d+$/.test(value) || Number(value) > 100) {
        throw new InstallArgumentError("--threshold must be an integer between 0 and 100.");
      }
      threshold = Number(value);
      continue;
    }
    if (gateOptions && option === "--pm") {
      const value = valueFor(option);
      if (value !== "npm" && value !== "pnpm" && value !== "yarn") {
        throw new InstallArgumentError("--pm must be npm, pnpm, or yarn.");
      }
      pm = value;
      continue;
    }
    if (gateOptions && option === "--verb") {
      const value = valueFor(option);
      if (value !== "install" && value !== "add" && value !== "i" && value !== "ci" && !(NPM_INSTALL_ALIASES as readonly string[]).includes(value)) {
        throw new InstallArgumentError("--verb must be install, add, i, ci, or an npm install alias.");
      }
      verb = value as InstallVerb;
      continue;
    }

    // npm/pnpm allow short value flags such as -wweb and -Fapp.
    if (equals < 0 && (/^-[FC].+/.test(arg) || (effectivePm === "npm" && /^-w.+/.test(arg)))) {
      option = arg.slice(0, 2);
      inlineValue = arg.slice(2);
    }
    if (effectivePm === "pnpm" && (option === "-w" || option === "--workspace")) {
      passthrough.push(arg);
      if (option === "--workspace") {
        unsupportedTargets.push({ spec: arg, reason: "Workspace-local package sources cannot be checked by the registry install gate." });
      }
      continue;
    }
    if (VALUE_OPTIONS.has(option) || /^--@[^:]+:registry$/.test(option)) {
      const value = valueFor(option);
      passthrough.push(arg);
      if (inlineValue === undefined) passthrough.push(value);
      if (effectivePm === "npm" && FOREIGN_NPM_VALUE_OPTIONS.has(option)) {
        unsupportedTargets.push({ spec: arg, reason: `${option} is not a supported npm install option.` });
      }
      if (option === "--tag") {
        if (!isRegistryTag(value)) {
          throw new InstallArgumentError("--tag requires a registry dist-tag.");
        }
        tag = value;
      } else if ((option === "--registry" || option.endsWith(":registry")) && !publicRegistry(value)) {
        unsupportedTargets.push({ spec: arg, reason: "The install gate only scans packages from https://registry.npmjs.org/." });
      } else if (UNSUPPORTED_CONFIGURATION_OPTIONS.has(option)) {
        unsupportedTargets.push({ spec: arg, reason: `${option} changes installation configuration outside the gate; use the gate's --dir option where applicable.` });
      }
      continue;
    }
    if (option === "--save-catalog") {
      passthrough.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      const positiveOption = option.startsWith("--no-") ? `--${option.slice(5)}` : option;
      const shortBooleanBundle = /^-[DPOEfgsqrWBThv]+$/.test(option);
      if (!BOOLEAN_OPTIONS.has(option) && !BOOLEAN_OPTIONS.has(positiveOption) && !shortBooleanBundle) {
        unsupportedTargets.push({ spec: arg, reason: "Unrecognized package-manager option; the gate cannot safely determine its effect or arguments." });
      } else if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false" &&
          !(effectivePm === "npm" && positiveOption === "--color" && inlineValue === "always")) {
        throw new InstallArgumentError(`${option} accepts only true or false.`);
      }
      passthrough.push(arg);
      // npm's nopt consumes a following literal boolean for known boolean
      // options. Keep that configuration value out of the package scan while
      // retaining its position in the manager's original argument list.
      if (effectivePm === "npm" && inlineValue === undefined &&
          packageManagerOptionKind(option, effectivePm) === "boolean" &&
          (args[index + 1] === "true" || args[index + 1] === "false" ||
            (positiveOption === "--color" && args[index + 1] === "always"))) {
        passthrough.push(args[++index]);
      }
      continue;
    }
    passthrough.push(arg);
    positional(arg);
  }
  return { yes, dryRun, json, deep, dir, threshold, pm, verb, tag, passthrough, packageNames, packageIndexes, unsupportedTargets };
}
