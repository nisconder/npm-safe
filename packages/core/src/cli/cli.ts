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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

program
  .name("npm-safe")
  .description("CLI for the @npm-safe/core local npm security engine")
  .version(packageJson.version, "-v, --version")
  .option("-d, --db <path>", "Path to the SQLite cache database")
  .option("-p, --proxy <url>", "HTTP proxy URL for registry requests")
  .option("-j, --json", "Output raw JSON")
  .argument("[package-name]", "Check a package (shorthand for `check`)")
  .action(async (packageName: string | undefined) => {
    if (!packageName) return;
    const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
    await runCheck(packageName, opts);
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

program.parse();

if (!process.argv.slice(2).length) {
  program.help();
}
