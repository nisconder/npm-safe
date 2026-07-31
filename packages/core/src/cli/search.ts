import { Command } from "commander";
import { createEngine } from "./shared.js";

interface SearchOptions {
  readonly db?: string;
  readonly json?: boolean;
  readonly size?: string;
}

/**
 * Register the `search` command with the given Commander program.
 */
export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search the npm registry for packages matching a query")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .option("-j, --json", "Output raw JSON instead of human-readable text")
    .option("-s, --size <number>", "Maximum number of results", "20")
    .action(async (query: string, options: SearchOptions) => {
      const engine = createEngine(options.db);
      try {
        const size = parseInt(options.size ?? "20", 10);
        const results = await engine.searchPackages(query, size);

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log("No packages found.");
          return;
        }

        for (const hit of results) {
          const pkg = hit.package;
          const line = [
            `${pkg.name}@${pkg.version}`,
            pkg.description ? ` — ${pkg.description}` : "",
            ` [searchScore ${hit.searchScore.toFixed(2)}]`,
          ].join("");
          console.log(line);
        }
      } finally {
        engine.close();
      }
    });
}
