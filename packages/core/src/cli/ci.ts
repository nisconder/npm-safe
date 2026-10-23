import { Command } from "commander";
import { readProjectDependencies, type ProjectDependency } from "../project-dependencies.js";
import { SECURITY_LEVEL_RANK, shouldFailCi } from "../scanner/security-policy.js";

import { SecurityLevel, Severity } from "../scanner/types.js";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";

/**
 * Severity ordering used for the failure gate: lower rank = more severe.
 */
const LEVEL_RANK = SECURITY_LEVEL_RANK;

const LEVEL_ORDER: readonly string[] = [
  SecurityLevel.Safe,
  SecurityLevel.Suspicious,
  SecurityLevel.Dangerous,
  SecurityLevel.Unknown,
];

interface PackageResult {
  readonly name: string;
  readonly exists: boolean;
  readonly version: string;
  readonly level: string;
  readonly score: number;
  readonly findingCount: number;
  readonly deepScanStatus?: "complete" | "partial" | "failed";
  readonly error?: string;
}

interface CiReport {
  readonly dir: string;
  readonly scannedAt: string;
  readonly dependencyCount: number;
  readonly failLevel: string;
  readonly deep: boolean;
  readonly failed: boolean;
  readonly summary: Readonly<Record<string, number>>;
  readonly packages: readonly PackageResult[];
}

export function registerCiCommand(program: Command): void {
  program
    .command("ci")
    .description("Scan a project's dependencies and fail the build on severe findings")
    .option("-d, --dir <path>", "Project directory containing package.json (default: current directory)")
    .option("-j, --json", "Output raw JSON report")
    .option("--prod", "Scan production dependencies (including their transitive tree with --lockfile)")
    .option("--lockfile", "Scan every dependency in package-lock.json (including transitive)")
    .option("--deep", "Download and inspect each published package tarball")
    .option("--fail-level <level>", `Fail when any dependency reaches this level (${LEVEL_ORDER.join(" / ")}, default: dangerous)`)
    .option("--rate-limit <n>", "Registry requests per second (default: 20)")
    .action(async (options: { dir?: string; json?: boolean; prod?: boolean; lockfile?: boolean; deep?: boolean; failLevel?: string; rateLimit?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const dir = options.dir ?? process.cwd();
      const failLevel = (options.failLevel ?? SecurityLevel.Dangerous) as SecurityLevel;
      if (!Object.hasOwn(LEVEL_RANK, failLevel)) {
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

      let deps: ProjectDependency[];
      try {
        deps = readProjectDependencies(dir, { lockfile: options.lockfile, prod: options.prod });
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
          deep: options.deep ?? false,
          failed: false,
          summary: { safe: 0, suspicious: 0, dangerous: 0, unknown: 0, errors: 0, deepIncomplete: 0 },
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
      let criticalDetected = false;
      const summary: Record<string, number> = {
        safe: 0,
        suspicious: 0,
        dangerous: 0,
        unknown: 0,
        errors: 0,
        deepIncomplete: 0,
      };

      try {
        for (const dep of deps) {
          try {
            const result = await engine.checkPackage(dep.name, { version: dep.version, deep: options.deep });
            if (!result.exists) {
              results.push({
                name: dep.name,
                exists: false,
                version: dep.version ?? "",
                level: SecurityLevel.Unknown,
                score: 0,
                findingCount: 0,
                error: t("ci.notFound"),
              });
              summary.unknown++;
              continue;
            }
            if (dep.version && result.latestVersion !== dep.version) {
              throw new Error(`Version mismatch: requested ${dep.name}@${dep.version}, scanned ${result.latestVersion}.`);
            }
            const level = result.security.overallLevel;
            criticalDetected ||= [
              ...(result.security.staticScan?.findings ?? []),
              ...(result.security.llmScan?.enabled ? result.security.llmScan.findings ?? [] : []),
            ].some((finding) => finding.severity === Severity.Critical);
            const deepScanStatus = result.security.staticScan?.contentScan?.status;
            results.push({
              name: dep.name,
              exists: true,
              version: result.latestVersion,
              level,
              score: result.security.overallScore,
              findingCount: result.security.staticScan?.findings.length ?? 0,
              deepScanStatus,
            });
            summary[level] = (summary[level] ?? 0) + 1;
            if (options.deep && deepScanStatus !== "complete") summary.deepIncomplete++;
            await engine.recordCheckHistory(result);
          } catch (err) {
            results.push({
              name: dep.name,
              exists: false,
              version: dep.version ?? "",
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

      const failed =
        criticalDetected ||
        summary.errors > 0 ||
        summary.deepIncomplete > 0 ||
        results.some(
          (r) => !r.exists || shouldFailCi(r.level as SecurityLevel, failLevel),
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
        deep: options.deep ?? false,
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
              `  [${r.level}] ${r.name}@${r.version} — ${r.score}/100 (${r.findingCount} ${t("ci.findings")})${r.deepScanStatus ? ` [${t("ci.deepStatus", { status: r.deepScanStatus })}]` : ""}`,
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
