import { Command } from "commander";
import { createEngine } from "./shared.js";

export function registerRefreshCommand(program: Command): void {
  program
    .command("refresh [package-name]")
    .description("Refresh one or all watched packages from the registry")
    .action(async (packageName: string | undefined) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
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
