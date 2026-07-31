import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

/**
 * Register the `watch` command and its sub-commands.
 */
export function registerWatchCommand(program: Command): void {
  const watch = program
    .command("watch")
    .description("Manage the package watchlist");

  watch
    .command("list")
    .description("List all watched packages")
    .action(async () => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
      try {
        const list = await engine.getWatchlist();
        if (list.length === 0) {
          console.log(t("watch.list.empty"));
          return;
        }
        console.log(`${t("watch.list.header")}:`);
        for (const name of list) {
          console.log(`  - ${name}`);
        }
      } finally {
        engine.close();
      }
    });

  watch
    .command("add <package-name>")
    .description("Add a package to the watchlist")
    .action(async (packageName: string) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
      try {
        await engine.checkPackage(packageName);
        await engine.addToWatchlist(packageName);
        console.log(t("watch.add.added", { name: packageName }));
      } finally {
        engine.close();
      }
    });

  watch
    .command("remove <package-name>")
    .description("Remove a package from the watchlist")
    .action(async (packageName: string) => {
      const engine = createEngine(program.opts<{ db?: string }>().db);
      try {
        await engine.removeFromWatchlist(packageName);
        console.log(t("watch.remove.removed", { name: packageName }));
      } finally {
        engine.close();
      }
    });
}
