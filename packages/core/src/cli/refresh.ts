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
          const succeeded = await engine.refreshPackage(packageName);
          if (succeeded) {
            console.log(t("refresh.single", { name: packageName }));
          } else {
            console.error(t("refresh.failed", { name: packageName }));
            process.exitCode = 1;
          }
        } else {
          // Refresh every package on the watchlist (not just stale cache
          // entries), matching the command description. Iterate using the
          // public API so a watched-but-never-checked package is refreshed.
          const watchlist = await engine.getWatchlist();
          let allSucceeded = true;
          for (const name of watchlist) {
            const succeeded = await engine.refreshPackage(name);
            allSucceeded = allSucceeded && succeeded;
          }
          if (allSucceeded) {
            console.log(t("refresh.all"));
          } else {
            console.error(t("refresh.failedAll"));
            process.exitCode = 1;
          }
        }
      } finally {
        engine.close();
      }
    });
}
