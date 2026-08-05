#!/usr/bin/env node
import { program } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCheckCommand, runCheck } from "./check.js";
import { registerSearchCommand } from "./search.js";
import { registerWatchCommand } from "./watch.js";
import { registerRefreshCommand } from "./refresh.js";
import { registerSettingsCommand } from "./settings.js";
import { registerLangCommand } from "./lang.js";
import { registerRulesCommand } from "./rules.js";
import { registerLlmCommand } from "./llm.js";
import { registerCiCommand } from "./ci.js";
import { registerTelemetryCommand } from "./telemetry.js";
import { registerReportCommand } from "./report.js";
import { registerInstallGateCommands } from "./install-gate.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerSkillCommand } from "./skill.js";
import { logCommand } from "./command-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

program
  .name("npm-safe")
  .description("CLI for the @npm-safe/core local npm security engine")
  .version(packageJson.version, "-v, --version")
  .enablePositionalOptions()
  .option("-d, --db <path>", "Path to the SQLite cache database")
  .option("-p, --proxy <url>", "HTTP proxy URL for registry requests")
  .option("-j, --json", "Output raw JSON")
  .argument("[package-name]", "Check a package (shorthand for `check`)")
  .action(async (packageName: string | undefined) => {
    if (!packageName) return;
    const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
    await runCheck([packageName], opts);
    process.exit(process.exitCode ?? 0);
  });

registerCheckCommand(program);
registerSearchCommand(program);
registerWatchCommand(program);
registerRefreshCommand(program);
registerSettingsCommand(program);
registerLangCommand(program);
registerRulesCommand(program);
registerLlmCommand(program);
registerCiCommand(program);
registerTelemetryCommand(program);
registerReportCommand(program);
registerInstallGateCommands(program);
registerDoctorCommand(program);
registerSkillCommand(program);

const startedAt = Date.now();
process.on("exit", (code) => {
  logCommand({
    timestamp: new Date().toISOString(),
    command: program.args[0] ?? "(help)",
    argv: process.argv.slice(2),
    exitCode: code,
    durationMs: Date.now() - startedAt,
  });
});

program.parse();

if (!process.argv.slice(2).length) {
  program.help();
}
