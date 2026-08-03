import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

import { SecurityLevel } from "../scanner/types.js";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

/**
 * Severity ordering used for the failure gate: lower rank = more severe.
 */
const LEVEL_RANK: Readonly<Record<string, number>> = {
  [SecurityLevel.Dangerous]: 1,
  [SecurityLevel.Unknown]: 2,
  [SecurityLevel.Suspicious]: 3,
  [SecurityLevel.Safe]: 4,
};

const LEVEL_ORDER: readonly string[] = [
  SecurityLevel.Safe,
  SecurityLevel.Suspicious,
  SecurityLevel.Dangerous,
  SecurityLevel.Unknown,
];

interface Dependency {
  readonly name: string;
}

interface PackageResult {
  readonly name: string;
  readonly exists: boolean;
  readonly version: string;
  readonly level: string;
  readonly score: number;
  readonly findingCount: number;
  readonly error?: string;
}

interface CiReport {
  readonly dir: string;
  readonly scannedAt: string;
  readonly dependencyCount: number;
  readonly failLevel: string;
  readonly failed: boolean;
  readonly summary: Readonly<Record<string, number>>;
  readonly packages: readonly PackageResult[];
}

/** Read direct dependencies (and optionally devDependencies) from a manifest. */
function readDependencies(
  dir: string,
  includeDev: boolean,
): Dependency[] {
  const manifestPath = path.join(dir, "package.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(t("ci.noManifest", { dir }));
  }
  const names = new Set<string>();
  for (const key of ["dependencies", ...(includeDev ? ["devDependencies"] : [])]) {
    const section = manifest[key];
    if (section && typeof section === "object") {
      for (const name of Object.keys(section as Record<string, unknown>)) {
        if (name !== "optionalDependencies") names.add(name);
      }
    }
  }
  return [...names].map((name) => ({ name }));
}

export function registerCiCommand(program: Command): void {
  program
    .command("ci")
    .description("Scan a project's dependencies and fail the build on severe findings")
    .option("-d, --dir <path>", "Project directory containing package.json (default: current directory)")
    .option("-j, --json", "Output raw JSON report")
    .option("--prod", "Only scan `dependencies` (skip devDependencies)")
    .option("--fail-level <level>", `Fail when any dependency reaches this level (${LEVEL_ORDER.join(" / ")}, default: dangerous)`)
    .option("--rate-limit <n>", "Registry requests per second (default: 20)")
    .action(async (options: { dir?: string; json?: boolean; prod?: boolean; failLevel?: string; rateLimit?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const dir = options.dir ?? process.cwd();
      const failLevel = options.failLevel ?? SecurityLevel.Dangerous;
      if (!LEVEL_RANK[failLevel]) {
        console.error(t("ci.unknownLevel", { level: failLevel, supported: LEVEL_ORDER.join(" / ") }));
        process.exitCode = 1;
        return;
      }
      const rateLimit = options.rateLimit ? parseInt(options.rateLimit, 10) : 20;
      if (Number.isNaN(rateLimit) || rateLimit < 1) {
        console.error(t("ci.invalidRateLimit", { value: options.rateLimit ?? "" }));
        process.exitCode = 1;
        return;
      }

      let deps: Dependency[];
      try {
        deps = readDependencies(dir, !options.prod);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      if (deps.length === 0) {
        const report: CiReport = {
          dir,
          scannedAt: new Date().toISOString(),
          dependencyCount: 0,
          failLevel,
          failed: false,
          summary: { safe: 0, suspicious: 0, dangerous: 0, unknown: 0, errors: 0 },
          packages: [],
        };
        if (options.json ?? opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(t("ci.noDependencies"));
        }
        return;
      }

      const engine = await createEngine(opts.db, opts.proxy, { rateLimit });
      const results: PackageResult[] = [];
      const summary: Record<string, number> = {
        safe: 0,
        suspicious: 0,
        dangerous: 0,
        unknown: 0,
        errors: 0,
      };

      try {
        for (const dep of deps) {
          try {
            const result = await engine.checkPackage(dep.name);
            if (!result.exists) {
              results.push({
                name: dep.name,
                exists: false,
                version: "",
                level: SecurityLevel.Unknown,
                score: 0,
                findingCount: 0,
                error: t("ci.notFound"),
              });
              summary.unknown++;
              continue;
            }
            const level = result.security.overallLevel;
            results.push({
              name: dep.name,
              exists: true,
              version: result.latestVersion,
              level,
              score: result.security.overallScore,
              findingCount: result.security.staticScan?.findings.length ?? 0,
            });
            summary[level] = (summary[level] ?? 0) + 1;
          } catch (err) {
            results.push({
              name: dep.name,
              exists: false,
              version: "",
              level: SecurityLevel.Unknown,
              score: 0,
              findingCount: 0,
              error: err instanceof Error ? err.message : String(err),
            });
            summary.errors++;
          }
        }
      } finally {
        engine.close();
      }

      const failRank = LEVEL_RANK[failLevel];
      const failed =
        summary.errors > 0 ||
        results.some(
          (r) => r.exists && LEVEL_RANK[r.level] !== undefined && LEVEL_RANK[r.level] <= failRank,
        );

      const report: CiReport = {
        dir,
        scannedAt: new Date().toISOString(),
        dependencyCount: deps.length,
        failLevel,
        failed,
        summary,
        packages: results,
      };

      if (options.json ?? opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(t("ci.summary", { count: String(deps.length), dir }));
        for (const r of results) {
          if (r.error) {
            console.log(`  [error] ${r.name} — ${r.error}`);
          } else if (!r.exists) {
            console.log(`  [${r.level}] ${r.name} — ${t("ci.notFound")}`);
          } else {
            console.log(
              `  [${r.level}] ${r.name}@${r.version} — ${r.score}/100 (${r.findingCount} ${t("ci.findings")})`,
            );
          }
        }
        const summaryLine = Object.entries(summary)
          .filter(([, count]) => count > 0)
          .map(([level, count]) => `${level}: ${count}`)
          .join(", ");
        console.log(summaryLine ? `  ${summaryLine}` : "");
        if (failed) {
          console.error(t("ci.failed", { level: failLevel }));
        } else {
          console.log(t("ci.passed", { level: failLevel }));
        }
      }

      process.exitCode = failed ? 2 : 0;
    });
}
