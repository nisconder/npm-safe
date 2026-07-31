import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

export function registerRefreshCommand(program: Command): void {
  program
    .command("refresh [package-name]")
    .description("Refresh one or all watched packages from the registry")
    .action(async (packageName: string | undefined) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const engine = await createEngine(opts.db, opts.proxy);
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
