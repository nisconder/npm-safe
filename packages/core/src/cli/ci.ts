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

/**
 * Read every package (including transitive dependencies) from a
 * `package-lock.json` (npm lockfile v2/v3 `packages` map, with a fallback to
 * the v1 `dependencies` tree). Direct deps can be filtered to those also
 * present in `package.json` when `includeDev` is set accordingly.
 */
function readLockfileDependencies(
  dir: string,
  includeDev: boolean,
): Dependency[] {
  const lockPath = path.join(dir, "package-lock.json");
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(t("ci.noLockfile", { dir }));
  }

  const names = new Set<string>();
  const packages = lock.packages;
  if (packages && typeof packages === "object") {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      if (key === "") continue; // root project entry
      // "node_modules/a" -> "a"; "node_modules/@scope/c" -> "@scope/c";
      // "node_modules/a/node_modules/d" -> "d" (the innermost package).
      const stripped = key.replace(/^node_modules\//, "");
      const parts = stripped.split("/node_modules/");
      const name = parts[parts.length - 1];
      if (name.length > 0) names.add(name);
    }
  }

  // npm lockfile v1 fallback: nested dependencies tree.
  const collect = (section: unknown): void => {
    if (!section || typeof section !== "object") return;
    for (const [name, entry] of Object.entries(section as Record<string, unknown>)) {
      if (name === "optionalDependencies") continue;
      names.add(name);
      if (entry && typeof entry === "object") {
        collect((entry as Record<string, unknown>).dependencies);
      }
    }
  };
  collect(lock.dependencies);

  if (!includeDev) {
    // --prod: restrict to the direct dependencies declared in package.json.
    const manifestPath = path.join(dir, "package.json");
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      const prod = new Set<string>(
        Object.keys((manifest.dependencies as Record<string, unknown>) ?? {}),
      );
      return [...names].filter((name) => prod.has(name)).map((name) => ({ name }));
    } catch {
      // No package.json — fall through to the full lockfile set.
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
    .option("--lockfile", "Scan every dependency in package-lock.json (including transitive)")
    .option("--fail-level <level>", `Fail when any dependency reaches this level (${LEVEL_ORDER.join(" / ")}, default: dangerous)`)
    .option("--rate-limit <n>", "Registry requests per second (default: 20)")
    .action(async (options: { dir?: string; json?: boolean; prod?: boolean; lockfile?: boolean; failLevel?: string; rateLimit?: string }) => {
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
        deps = options.lockfile
          ? readLockfileDependencies(dir, !options.prod)
          : readDependencies(dir, !options.prod);
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
            await engine.recordCheckHistory(result);
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

      try {
        const { TelemetryManager } = await import("../telemetry/telemetry.js");
        const telemetry = new TelemetryManager();
        telemetry.record({
          event: "ci",
          timestamp: new Date().toISOString(),
          packageCount: deps.length,
          levels: {
            safe: summary.safe,
            suspicious: summary.suspicious,
            dangerous: summary.dangerous,
            unknown: summary.unknown,
          },
          error: summary.errors > 0 ? `${summary.errors} package(s) failed` : undefined,
        });
      } catch {
        // Telemetry must never break the command.
      }

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
