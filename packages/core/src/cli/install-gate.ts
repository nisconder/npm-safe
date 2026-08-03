import { Command } from "commander";
import { spawnSync } from "node:child_process";
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

  program
    .command("install [args...]")
    .description("Install npm packages with an opt-in security gate (wraps `npm install`)")
    .option("-y, --yes", "Skip the confirmation prompt (auto-continue)")
    .option("--dry-run", "Check and prompt without actually installing")
    .option("--threshold <n>", "Override the score threshold for this run")
    .action(async (args: string[], options: { yes?: boolean; dryRun?: boolean; threshold?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();

      // Resolve the effective gate config (per-run threshold override wins).
      const config = await readGateConfig(opts.db, opts.proxy);
      let threshold = config.threshold;
      if (options.threshold !== undefined) {
        const parsed = parseInt(options.threshold, 10);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
          console.error(t("gate.invalidThreshold", { value: options.threshold }));
          process.exitCode = 1;
          return;
        }
        threshold = parsed;
      }

      // Package names are the positional args that do not start with a dash.
      const packageNames = args.filter((a) => !a.startsWith("-"));

      if (!config.enabled || packageNames.length === 0) {
        if (options.dryRun) {
          console.log(t("install.dryRun", { command: `npm install ${args.join(" ")}`.trim() }));
          return;
        }
        const result = spawnSync("npm", ["install", ...args], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        process.exitCode = result.status ?? 1;
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
          console.error(`  [${p.level}] ${p.name} — ${p.score}/100`);
        }
        if (!options.yes) {
          const ok = await confirm(t("install.confirm"));
          if (!ok) {
            console.log(t("install.aborted"));
            process.exitCode = 3;
            return;
          }
        }
      }

      if (options.dryRun) {
        console.log(t("install.dryRun", { command: `npm install ${args.join(" ")}`.trim() }));
        return;
      }
      const result = spawnSync("npm", ["install", ...args], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      process.exitCode = result.status ?? 1;
    });
}
