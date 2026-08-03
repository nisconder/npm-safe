import { Command } from "commander";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

const GATE_ENABLED_KEY = "installGate.enabled";
const GATE_THRESHOLD_KEY = "installGate.threshold";
const DEFAULT_THRESHOLD = 85;

interface GateConfig {
  readonly enabled: boolean;
  readonly threshold: number;
}

async function readGateConfig(db?: string, proxy?: string): Promise<GateConfig> {
  const engine = await createEngine(db, proxy);
  try {
    const enabled = (await engine.getSetting(GATE_ENABLED_KEY)) === "true";
    const thresholdRaw = await engine.getSetting(GATE_THRESHOLD_KEY);
    const threshold = thresholdRaw ? parseInt(thresholdRaw, 10) : DEFAULT_THRESHOLD;
    return { enabled, threshold: Number.isNaN(threshold) ? DEFAULT_THRESHOLD : threshold };
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
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
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      await writeGateConfig({ enabled: true }, opts.db, opts.proxy);
      console.log(t("gate.enabled"));
      console.log(t("gate.enableHint"));
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
      const value = parseInt(threshold, 10);
      if (Number.isNaN(value) || value < 0 || value > 100) {
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
    .description("Install shell wrappers so npm/pnpm/yarn add go through the gate automatically")
    .option("--file <path>", "Target a specific shell config file (default: auto-detected)")
    .option("--remove", "Remove the previously installed wrappers")
    .action(async (options: { file?: string; remove?: boolean }) => {
      const target = options.file ?? detectShellConfig();
      if (!target) {
        console.error(t("gate.shell.noConfig"));
        process.exitCode = 1;
        return;
      }
      if (options.remove) {
        const removed = removeShellBlock(target);
        if (removed) {
          console.log(t("gate.shell.removed", { path: target }));
        } else {
          console.log(t("gate.shell.notInstalled", { path: target }));
        }
        return;
      }
      const written = installShellBlock(target);
      if (written === "updated") {
        console.log(t("gate.shell.updated", { path: target }));
      } else if (written === "created") {
        console.log(t("gate.shell.installed", { path: target }));
      } else {
        console.log(t("gate.shell.already", { path: target }));
      }
    });

  program
    .command("install [args...]")
    .description("Install npm packages with an opt-in security gate (wraps npm/pnpm/yarn add)")
    .passThroughOptions()
    .allowUnknownOption(true)
    .action(async (args: string[]) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();

      // --yes / --dry-run / --threshold / --dir are consumed here; everything
      // else is passed through to the package manager (e.g. -D, --save-dev).
      let yes = false;
      let dryRun = false;
      let dir: string | undefined;
      let thresholdRaw: string | undefined;
      const passthrough: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--yes" || arg === "-y") {
          yes = true;
        } else if (arg === "--dry-run") {
          dryRun = true;
        } else if (arg === "--dir") {
          dir = args[++i];
        } else if (arg.startsWith("--dir=")) {
          dir = arg.slice("--dir=".length);
        } else if (arg === "--threshold") {
          thresholdRaw = args[++i];
        } else if (arg.startsWith("--threshold=")) {
          thresholdRaw = arg.slice("--threshold=".length);
        } else {
          passthrough.push(arg);
        }
      }
      let thresholdOverride: number | undefined;
      if (thresholdRaw !== undefined) {
        const parsed = parseInt(thresholdRaw, 10);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
          console.error(t("gate.invalidThreshold", { value: thresholdRaw }));
          process.exitCode = 1;
          return;
        }
        thresholdOverride = parsed;
      }
      const threshold = thresholdOverride ?? (await readGateConfig(opts.db, opts.proxy)).threshold;

      const installDir = dir ?? process.cwd();
      const pm = detectPackageManager(installDir);
      const installCommand = `${pm} ${pmVerb(pm)}`;

      // Package names are the passthrough args that do not start with a dash.
      const packageNames = passthrough.filter((a) => !a.startsWith("-"));

      const config = await readGateConfig(opts.db, opts.proxy);
      if (!config.enabled || packageNames.length === 0) {
        if (dryRun) {
          console.log(t("install.dryRun", { command: `${installCommand} ${passthrough.join(" ")}`.trim() }));
          return;
        }
        process.exitCode = runPackageManager(pm, pmVerb(pm), passthrough, installDir);
        return;
      }

      // Gate enabled: check every target package.
      const engine = await createEngine(opts.db, opts.proxy);
      const below: Array<{ name: string; score: number; level: string }> = [];
      try {
        for (const name of packageNames) {
          try {
            const result = await engine.checkPackage(name);
            if (!result.exists) {
              console.error(t("install.notFound", { name }));
              process.exitCode = 1;
              return;
            }
            if (result.security.overallScore < threshold) {
              below.push({
                name,
                score: result.security.overallScore,
                level: result.security.overallLevel,
              });
            } else {
              console.log(t("install.safe", { name, score: String(result.security.overallScore) }));
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

      if (below.length > 0) {
        console.error(t("install.belowThreshold", { threshold: String(threshold) }));
        for (const p of below) {
          console.error(`  [${p.level}] ${p.name} 鈥?${p.score}/100`);
        }
        if (!yes) {
          const ok = await confirm(t("install.confirm"));
          if (!ok) {
            console.log(t("install.aborted"));
            process.exitCode = 3;
            return;
          }
        }
      }

      if (dryRun) {
        console.log(t("install.dryRun", { command: `${installCommand} ${passthrough.join(" ")}`.trim() }));
        return;
      }
      process.exitCode = runPackageManager(pm, pmVerb(pm), passthrough, installDir);
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
        if (name === "pnpm" || name === "yarn") return name;
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

/**
 * Run the package manager without a shell. On Windows the binaries are
 * `.cmd` shims, so we go through `cmd.exe` with each argument quoted and
 * escaped explicitly (avoiding the deprecated shell=true arg concatenation).
 */
function runPackageManager(
  pm: "npm" | "pnpm" | "yarn",
  verb: string,
  args: string[],
  cwd: string,
): number {
  const binary = `${pm}.cmd`;
  if (process.platform !== "win32") {
    const result = spawnSync(pm, [verb, ...args], { stdio: "inherit", cwd });
    return result.status ?? 1;
  }
  const quoted = [verb, ...args].map(quoteWinArg).join(" ");
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `${binary} ${quoted}`],
    { stdio: "inherit", cwd },
  );
  return result.status ?? 1;
}

/** Quote a single argument for cmd.exe; safe tokens are left unquoted. */
function quoteWinArg(arg: string): string {
  if (/^[A-Za-z0-9@./:_-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

// ---------------------------------------------------------------------------
// Shell wrappers: route npm/pnpm/yarn add through the gate automatically
// ---------------------------------------------------------------------------

const SHELL_BLOCK_START = "# >>> npm-safe gate >>>";
const SHELL_BLOCK_END = "# <<< npm-safe gate <<<";

function bashWrappers(): string {
  return `${SHELL_BLOCK_START}
npm() {
  if [ "$1" = "install" ] || [ "$1" = "add" ] || [ "$1" = "i" ]; then
    npm-safe install "\${@:2}"
    [ $? -eq 0 ] || return $?
  else
    command npm "$@"
  fi
}
pnpm() {
  if [ "$1" = "install" ] || [ "$1" = "add" ] || [ "$1" = "i" ]; then
    npm-safe install "\${@:2}"
    [ $? -eq 0 ] || return $?
  else
    command pnpm "$@"
  fi
}
yarn() {
  if [ "$1" = "add" ]; then
    npm-safe install "\${@:2}"
    [ $? -eq 0 ] || return $?
  else
    command yarn "$@"
  fi
}
${SHELL_BLOCK_END}`;
}

function powershellWrappers(): string {
  return `${SHELL_BLOCK_START}
function npm {
  if ($args.Count -gt 0 -and $args[0] -in @('install', 'add', 'i')) {
    & npm-safe install @($args[1..($args.Count - 1)])
    if ($LASTEXITCODE -ne 0) { return }
  } else {
    & (Get-Command npm.cmd -ErrorAction Stop).Source @args
  }
}
function pnpm {
  if ($args.Count -gt 0 -and $args[0] -in @('install', 'add', 'i')) {
    & npm-safe install @($args[1..($args.Count - 1)])
    if ($LASTEXITCODE -ne 0) { return }
  } else {
    & (Get-Command pnpm.cmd -ErrorAction Stop).Source @args
  }
}
function yarn {
  if ($args.Count -gt 0 -and $args[0] -eq 'add') {
    & npm-safe install @($args[1..($args.Count - 1)])
    if ($LASTEXITCODE -ne 0) { return }
  } else {
    & (Get-Command yarn.cmd -ErrorAction Stop).Source @args
  }
}
${SHELL_BLOCK_END}`;
}

/**
 * Detect the shell configuration file for the current user:
 * PowerShell profile on Windows, ~/.zshrc or ~/.bashrc otherwise.
 */
function detectShellConfig(): string | null {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (!home) return null;
    const candidates = [
      path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }
  const shell = process.env.SHELL ?? "";
  const home = process.env.HOME;
  if (!home) return null;
  if (shell.includes("zsh")) return path.join(home, ".zshrc");
  if (shell.includes("bash")) return path.join(home, ".bashrc");
  return path.join(home, ".bashrc");
}

/** True when the file already contains the gate wrapper block. */
function hasShellBlock(file: string): boolean {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.includes(SHELL_BLOCK_START);
  } catch {
    return false;
  }
}

/** Install (or refresh) the wrapper block, returning "created" | "updated" | "existing". */
function installShellBlock(file: string): "created" | "updated" | "existing" {
  const block = file.endsWith(".ps1") ? powershellWrappers() : bashWrappers();
  const existed = hasShellBlock(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let content = "";
    if (fs.existsSync(file)) {
      content = fs.readFileSync(file, "utf8");
    }
    if (existed) {
      // Replace the previous block in place.
      const start = content.indexOf(SHELL_BLOCK_START);
      const end = content.indexOf(SHELL_BLOCK_END);
      if (start >= 0 && end >= 0) {
        content = content.slice(0, start) + block + content.slice(end + SHELL_BLOCK_END.length);
      } else {
        content = `${content.trimEnd()}\n\n${block}\n`;
      }
    } else {
      content = `${content.trimEnd()}\n\n${block}\n`;
    }
    fs.writeFileSync(file, content);
    return existed ? "updated" : "created";
  } catch {
    return "existing";
  }
}

/** Remove the wrapper block. Returns `true` when something was removed. */
function removeShellBlock(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const content = fs.readFileSync(file, "utf8");
    const start = content.indexOf(SHELL_BLOCK_START);
    const end = content.indexOf(SHELL_BLOCK_END);
    if (start < 0 || end < 0) return false;
    const next = content.slice(end + SHELL_BLOCK_END.length).replace(/^\n+/, "");
    fs.writeFileSync(file, content.slice(0, start).trimEnd() + "\n" + next);
    return true;
  } catch {
    return false;
  }
}

