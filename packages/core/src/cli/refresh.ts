import { Command } from "commander";
import { createEngine } from "./shared.js";

interface RefreshOptions {
  readonly db?: string;
}

/**
 * Register the `refresh` command with the given Commander program.
 */
export function registerRefreshCommand(program: Command): void {
  program
    .command("refresh [package-name]")
    .description("Refresh one or all watched packages from the registry")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (packageName: string | undefined, options: RefreshOptions) => {
      const engine = createEngine(options.db);
      try {
        if (packageName) {
          await engine.refreshPackage(packageName);
          console.log(`Refreshed "${packageName}".`);
        } else {
          await engine.refreshAll();
          console.log("Refreshed all watched packages.");
        }
      } finally {
        engine.close();
      }
    });
}
