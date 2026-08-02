import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search the npm registry for packages matching a query")
    .option("-j, --json", "Output raw JSON")
    .option("-s, --size <number>", "Maximum number of results", "20")
    .action(async (query: string, options: { json?: boolean; size?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const engine = await createEngine(opts.db, opts.proxy);
      try {
        const size = Math.max(1, Math.min(250, parseInt(options.size ?? "20", 10) || 20));
        const results = await engine.searchPackages(query, size);

        if (options.json ?? opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(t("search.noResults"));
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
