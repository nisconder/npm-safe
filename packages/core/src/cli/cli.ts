#!/usr/bin/env node
/**
 * Command-line interface for @npm-safe/core.
 *
 * Provides terminal access to the engine's core operations:
 * check, search, watch, refresh, and settings.
 */

import { program } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCheckCommand } from "./check.js";
import { registerSearchCommand } from "./search.js";
import { registerWatchCommand } from "./watch.js";
import { registerRefreshCommand } from "./refresh.js";
import { registerSettingsCommand } from "./settings.js";
import { setLocale, autoDetectLocale, type Locale, t } from "./i18n.js";
import { createEngine } from "./shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

// Determine locale: --lang flag > env auto-detect > 'en' default.
(function initLocale(): void {
  const langIdx = process.argv.indexOf("--lang");
  if (langIdx !== -1 && langIdx + 1 < process.argv.length) {
    const val = process.argv[langIdx + 1] as Locale;
    if (val === "zh") setLocale("zh");
    return;
  }
  const shortIdx = process.argv.indexOf("-l");
  if (shortIdx !== -1 && shortIdx + 1 < process.argv.length) {
    const val = process.argv[shortIdx + 1] as Locale;
    if (val === "zh") setLocale("zh");
    return;
  }
  autoDetectLocale();
})();

program
  .name("npm-safe")
  .description("CLI for the @npm-safe/core local npm security engine")
  .version(packageJson.version, "-v, --version")
  .option("-d, --db <path>", "Path to the SQLite cache database")
  .option("-l, --lang <locale>", "Locale for output messages (en, zh)")
  .option("-j, --json", "Output raw JSON")
  .argument("[package-name]", "Check a package (shorthand for `check`)")
  .action(async (packageName: string | undefined) => {
    if (!packageName) return;
    const { runCheck } = await import("./check.js");
    await runCheck(packageName, program.opts<{ db?: string; json?: boolean }>());
    process.exit(process.exitCode ?? 0);
  });

registerCheckCommand(program);
registerSearchCommand(program);
registerWatchCommand(program);
registerRefreshCommand(program);
registerSettingsCommand(program);

program.parse();

// If no command is supplied, print help.
if (!process.argv.slice(2).length) {
  program.help();
}
