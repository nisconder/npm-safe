import { Command } from "commander";
import { createEngine } from "./shared.js";

interface WatchOptions {
  readonly db?: string;
}

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
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (options: WatchOptions) => {
      const engine = createEngine(options.db);
      try {
        const list = await engine.getWatchlist();
        if (list.length === 0) {
          console.log("No packages on the watchlist.");
          return;
        }
        console.log("Watched packages:");
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
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (packageName: string, options: WatchOptions) => {
      const engine = createEngine(options.db);
      try {
        // A watchlist entry references the packages table, so ensure the
        // package metadata is cached first.
        await engine.checkPackage(packageName);
        await engine.addToWatchlist(packageName);
        console.log(`Added "${packageName}" to the watchlist.`);
      } finally {
        engine.close();
      }
    });

  watch
    .command("remove <package-name>")
    .description("Remove a package from the watchlist")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .action(async (packageName: string, options: WatchOptions) => {
      const engine = createEngine(options.db);
      try {
        await engine.removeFromWatchlist(packageName);
        console.log(`Removed "${packageName}" from the watchlist.`);
      } finally {
        engine.close();
      }
    });
}
