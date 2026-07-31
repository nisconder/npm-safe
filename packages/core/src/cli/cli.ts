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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

program
  .name("npm-safe")
  .description("CLI for the @npm-safe/core local npm security engine")
  .version(packageJson.version, "-v, --version")
  .option("-d, --db <path>", "Path to the SQLite cache database");

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
