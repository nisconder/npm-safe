import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

/**
 * Register the `refresh` command with the given Commander program.
 */
export function registerRefreshCommand(program: Command): void {
  program
    .command("refresh [package-name]")
    .description("Refresh one or all watched packages from the registry")
    .action(async (packageName: string | undefined) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
      try {
        if (packageName) {
          await engine.refreshPackage(packageName);
          console.log(t("refresh.single", { name: packageName }));
        } else {
          await engine.refreshAll();
          console.log(t("refresh.all"));
        }
      } finally {
        engine.close();
      }
    });
}
