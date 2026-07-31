import { Command } from "commander";
import { createEngine } from "./shared.js";

export function registerSettingsCommand(program: Command): void {
  const settings = program.command("settings").description("Read and write engine settings");

  settings
    .command("get <key>")
    .description("Read a setting value")
    .action(async (key: string) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
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
    .action(async (key: string, value: string) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
      try {
        await engine.setSetting(key, value);
        console.log(`Set "${key}" = "${value}".`);
      } finally {
        engine.close();
      }
    });
}
