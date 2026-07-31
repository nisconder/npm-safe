import { Command } from "commander";
import { createEngine } from "./shared.js";

interface SettingsOptions {
  readonly db?: string;
}

/**
 * Register the `settings` command and its sub-commands.
 */
export function registerSettingsCommand(program: Command): void {
  const settings = program
    .command("settings")
    .description("Read and write engine settings");

  settings
    .command("get <key>")
    .description("Read a setting value")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (key: string, options: SettingsOptions) => {
      const engine = createEngine(options.db);
      try {
        const value = await engine.getSetting(key);
        if (value === null) {
          console.error(`Setting "${key}" is not set.`);
          process.exitCode = 1;
          return;
        }
        console.log(value);
      } finally {
        engine.close();
      }
    });

  settings
    .command("set <key> <value>")
    .description("Write a setting value")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (key: string, value: string, options: SettingsOptions) => {
      const engine = createEngine(options.db);
      try {
        await engine.setSetting(key, value);
        console.log(`Set "${key}" = "${value}".`);
      } finally {
        engine.close();
      }
    });
}
