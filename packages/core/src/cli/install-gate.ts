import { Command } from "commander";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { createEngine } from "./shared.js";
import { t } from "./i18n.js";
import { parseInstallArguments, parseRegistryTarget } from "./install-arguments.js";
import {
  runPackageManagerProcess, shimDirectory, windowsShimContent,
  shimHelperContent, bashWrapperBlock, powershellWrapperBlock,
} from "./install-gate-shell.js";
import { assertPublicInstallRegistry } from "./install-registry.js";

const GATE_ENABLED_KEY = "installGate.enabled";
const GATE_THRESHOLD_KEY = "installGate.threshold";
const DEFAULT_THRESHOLD = 85;

interface GateConfig {
  readonly enabled: boolean;
  readonly threshold: number;
}

export async function readGateConfig(db?: string, proxy?: string): Promise<GateConfig> {
  const engine = await createEngine(db, proxy);
  try {
    const enabled = (await engine.getSetting(GATE_ENABLED_KEY)) === "true";
    const thresholdRaw = await engine.getSetting(GATE_THRESHOLD_KEY);
    const threshold = thresholdRaw && /^\d+$/.test(thresholdRaw) ? Number(thresholdRaw) : NaN;
    return { enabled, threshold: Number.isInteger(threshold) && threshold >= 0 && threshold <= 100 ? threshold : DEFAULT_THRESHOLD };
  } finally {
    engine.close();
  }
}

async function writeGateConfig(
  update: Partial<GateConfig>,
  db?: string,
  proxy?: string,
): Promise<void> {
  const engine = await createEngine(db, proxy);
  try {
    if (update.enabled !== undefined) {
      await engine.setSetting(GATE_ENABLED_KEY, update.enabled ? "true" : "false");
    }
    if (update.threshold !== undefined) {
      await engine.setSetting(GATE_THRESHOLD_KEY, String(update.threshold));
    }
  } finally {
    engine.close();
  }
}

/** Ask the user to confirm, returning `true` when they do. */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
    const answer = (await Promise.race([rl.question(`${message} [y/n] `), closed])).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export function registerInstallGateCommands(program: Command): void {
  const gate = program
    .command("gate")
    .description("Manage the opt-in install-time security gate");

  gate
    .command("status")
    .description("Show whether the install gate is enabled and its threshold")
    .option("-j, --json", "Output raw JSON")
    .action(async (options: { json?: boolean }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const config = await readGateConfig(opts.db, opts.proxy);
      if (options.json ?? opts.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      console.log(`${t("gate.status.enabled")}: ${config.enabled ? t("llm.yes") : t("llm.no")}`);
      console.log(`${t("gate.status.threshold")}: ${config.threshold}`);
    });

  gate
    .command("enable")
    .description("Enable the install gate (checks before every install)")
    .option("--shell-file <path>", "Install shell wrappers into a specific config file")
    .option("--no-shell", "Skip the automatic shell wrapper installation")
    .action(async (options: { shellFile?: string; shell?: boolean }) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      await writeGateConfig({ enabled: true }, opts.db, opts.proxy);
      console.log(t("gate.enabled"));

      // Automatically install the shell wrappers and PATH shims so npm/pnpm/
      // yarn add go through the gate without any further step.
      if (options.shell !== false) {
        try {
          installShims();
          if (process.platform === "win32") console.log(t("gate.shell.shimsInstalled", { path: getShimDir() }));
        } catch (err) {
          console.error(t("gate.shell.installFailed", { message: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
        }
        const target = options.shellFile ?? detectShellConfig();
        if (target) {
          try {
            const result = installShellBlock(target);
            if (result === "created") {
              console.log(t("gate.shell.installed", { path: target }));
            } else if (result === "updated") {
              console.log(t("gate.shell.updated", { path: target }));
            } else {
              console.log(t("gate.shell.already", { path: target }));
            }
            console.log(t("gate.enableHint"));
          } catch (err) {
            console.error(t("gate.shell.installFailed", { message: err instanceof Error ? err.message : String(err) }));
            process.exitCode = 1;
          }
        } else {
          console.log(t("gate.shell.noConfig"));
        }
      }
    });

  gate
    .command("disable")
    .description("Disable the install gate")
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      await writeGateConfig({ enabled: false }, opts.db, opts.proxy);
      console.log(t("gate.disabled"));
    });

  gate
    .command("set-threshold <n>")
    .description("Set the minimum score required to install without confirmation (0-100)")
    .action(async (threshold: string) => {
      const value = /^\d+$/.test(threshold) ? Number(threshold) : NaN;
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        console.error(t("gate.invalidThreshold", { value: threshold }));
        process.exitCode = 1;
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string }>();
      await writeGateConfig({ threshold: value }, opts.db, opts.proxy);
      console.log(t("gate.thresholdSet", { threshold: String(value) }));
    });

  gate
    .command("shell")
    .description("Install shell wrappers + PATH shims so npm/pnpm/yarn go through the gate automatically")
    .option("--file <path>", "Target a specific shell config file (default: auto-detected)")
    .option("--remove", "Remove the previously installed wrappers and shims")
    .option("--machine", "Windows: prepend the shim dir to the system PATH (run as administrator)")
    .action(async (options: { file?: string; remove?: boolean; machine?: boolean }) => {
      if (options.machine) {
        if (process.platform !== "win32") {
          console.error(t("gate.shell.machineWinOnly"));
          process.exitCode = 1;
          return;
        }
        try {
          if (!options.remove) installShims();
          const dir = getShimDir();
          const encodedDir = Buffer.from(dir, "utf8").toString("base64");
          const script =
            `$ErrorActionPreference = 'Stop'; ` +
            `$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDir}')); ` +
            `$m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); ` +
            `$rest = @(($m -split ';') | Where-Object { $_ -and $_.Trim('"').TrimEnd('\\') -ine $s.TrimEnd('\\') }); ` +
            (options.remove
              ? `[Environment]::SetEnvironmentVariable('Path', ($rest -join ';'), 'Machine'); 'removed'`
              : `$next = (@($s) + $rest) -join ';'; if ($next -ceq $m) { 'already' } else { ` +
                `[Environment]::SetEnvironmentVariable('Path', $next, 'Machine'); 'ok' }`);
          const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
            encoding: "utf8",
          }).trim();
          if (options.remove) {
            removeShims();
            console.log(t("gate.shell.shimsRemoved", { path: dir }));
          } else if (out === "already") {
            console.log(t("gate.shell.machineAlready", { path: dir }));
          } else {
            console.log(t("gate.shell.machineInstalled", { path: dir }));
          }
        } catch (err) {
          console.error(
            t("gate.shell.machineFailed", {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
          process.exitCode = 1;
        }
        return;
      }
      if (options.remove) {
        let anything = false;
        const target = options.file ?? detectShellConfig();
        if (target) {
          const removed = removeShellBlock(target);
          if (removed) {
            console.log(t("gate.shell.removed", { path: target }));
            anything = true;
          } else {
            console.log(t("gate.shell.notInstalled", { path: target }));
          }
        }
        if (options.file === undefined) {
          const shimsRemoved = removeShims();
          if (shimsRemoved) {
            console.log(t("gate.shell.shimsRemoved", { path: getShimDir() }));
            anything = true;
          }
        }
        if (!anything) process.exitCode = 1;
        return;
      }

      let printed = false;
      if (options.file === undefined) {
        // Install the PATH shims (works in every shell, including cmd.exe).
        try {
          installShims();
          if (process.platform === "win32") {
            console.log(t("gate.shell.shimsInstalled", { path: getShimDir() }));
            printed = true;
          }
        } catch (err) {
          console.error(t("gate.shell.installFailed", { message: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
        }
      }

      const target = options.file ?? detectShellConfig();
      if (target) {
        const written = installShellBlock(target);
        if (written === "updated") {
          console.log(t("gate.shell.updated", { path: target }));
        } else if (written === "created") {
          console.log(t("gate.shell.installed", { path: target }));
        } else {
          console.log(t("gate.shell.already", { path: target }));
        }
        printed = true;
      } else {
        console.log(t("gate.shell.noConfig"));
      }
      if (printed) console.log(t("gate.enableHint"));
    });

  program
    .command("install [args...]")
    .description("Install npm packages with an opt-in security gate (wraps npm/pnpm/yarn add)")
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption(true)
    .action(async (args: string[]) => {
      if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
        program.commands.find((command) => command.name() === "install")!.outputHelp();
        return;
      }
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      let parsed;
      try {
        // Resolve --dir before manager-specific flags such as pnpm's -w.
        let directory = process.cwd();
        for (let index = 0; index < args.length && args[index] !== "--"; index++) {
          if (args[index] === "--dir") directory = args[++index] ?? directory;
          else if (args[index].startsWith("--dir=")) directory = args[index].slice(6);
        }
        parsed = parseInstallArguments(args, detectPackageManager(directory));
      } catch (error) {
        console.error(`[npm-safe] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      const { yes, dryRun, deep, passthrough, packageNames } = parsed;
      const json = parsed.json || opts.json === true;
      const config = await readGateConfig(opts.db, opts.proxy);
      const threshold = parsed.threshold ?? config.threshold;
      const installDir = path.resolve(parsed.dir ?? process.cwd());
      const pm = parsed.pm ?? detectPackageManager(installDir);
      const verb = parsed.verb ?? pmVerb(pm);
      const installCommand = `${pm} ${verb}`;
      if (config.enabled && parsed.unsupportedTargets.length > 0) {
        for (const target of parsed.unsupportedTargets) {
          console.error(`[npm-safe] Cannot check "${target.spec}": ${target.reason}`);
        }
        process.exitCode = 1;
        return;
      }
      if (!config.enabled) {
        if (dryRun) {
          if (json) {
            console.log(JSON.stringify({ threshold, packages: [] }, null, 2));
          } else {
            console.log(t("install.dryRun", { command: `${installCommand} ${passthrough.join(" ")}`.trim() }));
          }
          return;
        }
        process.exitCode = runPackageManager(pm, verb, passthrough, installDir, json);
        return;
      }
      try {
        assertPublicInstallRegistry(installDir);
      } catch (error) {
        console.error(`[npm-safe] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }

      // Bare install keeps its verb. Without a manager-specific resolved plan,
      // direct manifest scans are advisory and always require confirmation.
      const unresolvedInstall = packageNames.length === 0;
      let targets = packageNames;
      if (targets.length === 0) {
        try {
          targets = readProjectTargets(installDir);
        } catch (error) {
          console.error(`[npm-safe] ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
          return;
        }
      }

      // Gate enabled: check every target package.
      interface CheckedPackage {
        readonly name: string;
        readonly version: string;
        readonly level: string;
        readonly score: number;
        readonly findings: number;
        readonly deepScanStatus?: "complete" | "partial" | "failed";
        readonly belowThreshold: boolean;
        readonly requiresConfirmation: boolean;
      }
      const engine = await createEngine(opts.db, opts.proxy);
      const checked: CheckedPackage[] = [];
      try {
        for (const name of targets) {
          try {
            const target = parseRegistryTarget(name);
            const result = await engine.checkPackage(target.name, { deep, version: target.version ?? parsed.tag });
            if (!result.exists) {
              console.error(t("install.notFound", { name }));
              process.exitCode = 1;
              return;
            }
            const score = result.security.overallScore;
            const deepScanStatus = result.security.staticScan?.contentScan?.status;
            const belowThreshold = score < threshold;
            const entry: CheckedPackage = {
              name,
              version: result.latestVersion,
              level: result.security.overallLevel,
              score,
              findings: result.security.staticScan?.findings.length ?? 0,
              deepScanStatus,
              belowThreshold,
              requiresConfirmation: belowThreshold || (deep && deepScanStatus !== "complete"),
            };
            checked.push(entry);
            if (!json) {
              console.log(
                t("install.summary", {
                  name: target.name,
                  version: entry.version,
                  level: entry.level,
                  score: String(score),
                  findings: String(entry.findings),
                }),
              );
            }
          } catch (err) {
            console.error(t("install.checkFailed", { name, message: err instanceof Error ? err.message : String(err) }));
            process.exitCode = 1;
            return;
          }
        }
      } finally {
        engine.close();
      }

      // Keep the installed artifact bound to the inspected published version.
      for (let index = 0; index < packageNames.length; index++) {
        const target = parseRegistryTarget(packageNames[index]);
        passthrough[parsed.packageIndexes[index]] = `${target.name}@${checked[index].version}`;
      }

      if (json) {
        console.log(JSON.stringify({ threshold, packages: checked, unresolvedInstall }, null, 2));
      }

      const below = checked.filter((c) => c.belowThreshold);
      if (below.length > 0) {
        console.error(t("install.belowThreshold", { threshold: String(threshold) }));
        for (const p of below) {
          console.error(`  [${p.level}] ${p.name} — ${p.score}/100`);
        }
      }
      const incomplete = checked.filter(
        (item) => deep && item.deepScanStatus !== "complete",
      );
      if (incomplete.length > 0) {
        console.error(t("install.deepIncomplete"));
        for (const item of incomplete) {
          console.error(`  [${item.deepScanStatus ?? "missing"}] ${item.name}`);
        }
      }
      if (unresolvedInstall) console.error(t("install.unresolvedPlan"));
      if ((unresolvedInstall || checked.some((item) => item.requiresConfirmation)) && !yes) {
        // EOF must never leave a risky install looking successful.
        process.exitCode = 3;
        const ok = await confirm(t("install.confirm"));
        if (!ok) {
          console.error(t("install.aborted"));
          process.exitCode = 3;
          return;
        }
        process.exitCode = 0;
      }

      if (dryRun) {
        if (!json) {
          console.log(t("install.dryRun", { command: `${installCommand} ${passthrough.join(" ")}`.trim() }));
        }
        return;
      }
      process.exitCode = runPackageManager(pm, verb, passthrough, installDir, json);
    });
}

/**
 * Detect the package manager used by the current project by walking up from
 * `cwd` to the filesystem root: `packageManager` field first, then lockfiles.
 */
function detectPackageManager(cwd = process.cwd()): "npm" | "pnpm" | "yarn" {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as { packageManager?: string };
      if (manifest.packageManager) {
        const name = manifest.packageManager.split("@")[0];
        if (name === "npm" || name === "pnpm" || name === "yarn") return name;
      }
    } catch {
      // No package.json in this directory — keep walking.
    }
    try {
      if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
      if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
      if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npm";
}

/** The subcommand used to add a new dependency for a package manager. */
function pmVerb(pm: "npm" | "pnpm" | "yarn"): "add" | "install" {
  return pm === "npm" ? "install" : "add";
}

function readProjectTargets(directory: string): string[] {
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const targets = new Map<string, string>();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new Error(`Invalid ${section} in ${manifestPath}.`);
    }
    for (const [name, requested] of Object.entries(dependencies)) {
      if (typeof requested !== "string") throw new Error(`Invalid dependency version for "${name}".`);
      parseRegistryTarget(`${name}@${requested}`);
      targets.set(name, `${name}@${requested}`);
    }
  }
  return [...targets.values()];
}

/**
 * Run the package manager without a shell. On Windows the binaries are
 * `.cmd` shims, so we go through `cmd.exe` with each argument quoted and
 * escaped explicitly (avoiding the deprecated shell=true arg concatenation).
 *
 * When the caller is one of our own PATH shims it sets NPMSAFE_REAL_NPM /
 * NPMSAFE_REAL_PNPM / NPMSAFE_REAL_YARN to the real binary, which we honour
 * to avoid the shim calling itself recursively.
 */
function runPackageManager(
  pm: "npm" | "pnpm" | "yarn",
  verb: string,
  args: string[],
  cwd: string,
  json = false,
): number {
  return runPackageManagerProcess(pm, [verb, ...args], cwd, json);
}

// ---------------------------------------------------------------------------
// Shell wrappers: route npm/pnpm/yarn add through the gate automatically
// ---------------------------------------------------------------------------

const SHELL_BLOCK_START = "# >>> npm-safe gate >>>";
const SHELL_BLOCK_END = "# <<< npm-safe gate <<<";

function bashWrappers(): string {
  return bashWrapperBlock();
}

function powershellWrappers(): string {
  return powershellWrapperBlock();
}

/**
 * Detect the shell configuration file for the current user:
 * PowerShell profile on Windows, ~/.zshrc or ~/.bashrc otherwise.
 */
export function detectShellConfig(): string | null {
  const shell = process.env.SHELL ?? "";
  const home = process.platform === "win32" ? process.env.USERPROFILE ?? process.env.HOME : process.env.HOME;
  if (!home) return null;
  if (/(?:^|[\\/])zsh(?:\.exe)?$/i.test(shell)) return path.join(home, ".zshrc");
  if (/(?:^|[\\/])bash(?:\.exe)?$/i.test(shell)) return path.join(home, ".bashrc");
  if (process.platform === "win32") {
    const candidates = [
      path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ];
    if (/WindowsPowerShell[\\/]/i.test(shell) || /(?:^|[\\/])powershell(?:\.exe)?$/i.test(shell)) return candidates[1];
    if (/(?:^|[\\/])pwsh(?:\.exe)?$/i.test(shell)) return candidates[0];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }
  return path.join(home, ".bashrc");
}

function shellBlockRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const markers = /^# (?:>>> npm-safe gate >>>|<<< npm-safe gate <<<)\r?$/gm;
  let start: number | undefined;
  for (const marker of content.matchAll(markers)) {
    if (marker[0].startsWith(SHELL_BLOCK_START)) {
      if (start !== undefined) throw new Error("Incomplete npm-safe gate block in shell configuration");
      start = marker.index;
    } else {
      if (start === undefined) throw new Error("Incomplete npm-safe gate block in shell configuration");
      ranges.push({ start, end: marker.index + marker[0].replace(/\r$/, "").length });
      start = undefined;
    }
  }
  if (start !== undefined) throw new Error("Incomplete npm-safe gate block in shell configuration");
  return ranges;
}

/** True when the file already contains the gate wrapper block. */
export function hasShellBlock(file: string): boolean {
  try {
    const content = fs.readFileSync(file, "utf8");
    return shellBlockRanges(content).length > 0;
  } catch {
    return false;
  }
}

/** Install (or refresh) the wrapper block, returning "created" | "updated" | "existing". */
export function installShellBlock(file: string): "created" | "updated" | "existing" {
  let content = "";
  if (fs.existsSync(file)) {
    content = fs.readFileSync(file, "utf8");
  }
  const ranges = shellBlockRanges(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const block = (file.toLowerCase().endsWith(".ps1") ? powershellWrappers() : bashWrappers()).replace(/\r?\n/g, newline);
  if (ranges.length === 1 && content.slice(ranges[0].start, ranges[0].end) === block) return "existing";
  if (ranges.length > 0) {
    for (let index = ranges.length - 1; index >= 0; index--) {
      const range = ranges[index];
      content = content.slice(0, range.start) + (index === 0 ? block : "") + content.slice(range.end);
    }
  } else {
    content += `${content.length === 0 ? "" : content.endsWith("\n") ? newline : newline + newline}${block}${newline}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return ranges.length > 0 ? "updated" : "created";
}

/** Remove the wrapper block. Returns `true` when something was removed. */
export function removeShellBlock(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    let content = fs.readFileSync(file, "utf8");
    const ranges = shellBlockRanges(content);
    if (ranges.length === 0) return false;
    for (const range of ranges.reverse()) {
      const suffix = content.slice(range.end).replace(/^\r?\n/, "");
      content = content.slice(0, range.start) + suffix;
    }
    fs.writeFileSync(file, content);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PATH shims: intercept npm/pnpm/yarn in EVERY shell (cmd, PowerShell, bash)
// ---------------------------------------------------------------------------

/** Directory holding the npm-safe command shims. */
export function getShimDir(): string {
  return shimDirectory();
}

/**
 * Generate a Windows .cmd shim that routes install/add/i through
 * `npm-safe install` and forwards every other command straight to the real
 * package manager.
 */
function shimContent(pm: "npm" | "pnpm" | "yarn"): string {
  return windowsShimContent(pm);
}

/** Write the three shims into the shim directory (idempotent). */
function installShims(): void {
  if (process.platform !== "win32") return;
  const dir = getShimDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gate-shim.mjs"), shimHelperContent());
  for (const pm of ["npm", "pnpm", "yarn"] as const) {
    fs.writeFileSync(path.join(dir, `${pm}.cmd`), shimContent(pm));
  }
}

/** Remove the shims. Returns `true` when any file was removed. */
function removeShims(): boolean {
  const dir = getShimDir();
  let removed = false;
  for (const name of ["npm.cmd", "pnpm.cmd", "yarn.cmd", "gate-shim.mjs"]) {
    const file = path.join(dir, name);
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        removed = true;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}


