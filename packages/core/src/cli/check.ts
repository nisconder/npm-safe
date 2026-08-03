import { Command } from "commander";
import { readFileSync } from "node:fs";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";
import { loadLastBatch, saveLastBatch } from "./batch-history.js";
import { TelemetryManager } from "../telemetry/telemetry.js";
import type { CheckResult, BatchPackageResult } from "../index.js";

export interface RunCheckOptions {
  readonly json?: boolean;
  readonly refresh?: boolean;
  readonly db?: string;
  readonly proxy?: string;
  readonly concurrency?: number;
}

function formatFinding(result: CheckResult, idx: number): string {
  const report = result.security.staticScan;
  if (!report) return "";
  const f = report.findings[idx];
  if (!f) return "";

  const lines: string[] = [
    `  [${f.severity.toUpperCase()}] ${f.ruleId} — ${f.ruleName}`,
    `    ${f.message}`,
  ];
  if (f.recommendation) {
    lines.push(`    ${t("check.finding.recommendation")}: ${f.recommendation}`);
  }
  if (f.codeSnippet) {
    lines.push(`    ${t("check.finding.snippet")}: ${f.codeSnippet}`);
  }
  if (f.lineNumber !== undefined) {
    lines.push(`    ${t("check.finding.line")}: ${f.lineNumber}`);
  }
  return lines.join("\n");
}

/**
 * Print the detailed single-package report.
 *
 * @returns `true` when the package passed, `false` when it is missing or
 *   reached the dangerous/unknown threshold (used to set the exit code).
 */
function printSingleResult(result: CheckResult, packageName: string): boolean {
  if (!result.exists) {
    console.error(t("check.notFound", { name: packageName }));
    return false;
  }

  const report = result.security.staticScan;
  const findingCount = report?.findings.length ?? 0;
  const lines: string[] = [
    `${t("check.label.package")}: ${result.packageName}`,
    `${t("check.label.latestVersion")}: ${result.latestVersion}`,
    `${t("check.label.securityLevel")}: ${result.security.overallLevel}`,
    `${t("check.label.score")}: ${result.security.overallScore}/100`,
    `${t("check.label.findings")}: ${findingCount}`,
  ];

  if (result.registryInfo?.description) {
    lines.push(`${t("check.label.description")}: ${result.registryInfo.description}`);
  }
  if (result.registryInfo?.homepage) {
    lines.push(`${t("check.label.homepage")}: ${result.registryInfo.homepage}`);
  }
  if (result.registryInfo?.repository) {
    lines.push(`${t("check.label.repository")}: ${result.registryInfo.repository}`);
  }
  if (result.cachedAt) {
    lines.push(`${t("check.label.cachedAt")}: ${result.cachedAt}`);
  }

  if (findingCount > 0) {
    lines.push("");
    lines.push(`${t("check.label.findings")}:`);
    for (let i = 0; i < findingCount; i++) {
      const formatted = formatFinding(result, i);
      if (formatted) lines.push(formatted);
    }
  }

  console.log(lines.join("\n"));

  return (
    result.security.overallLevel !== "dangerous" &&
    result.security.overallLevel !== "unknown"
  );
}

export async function runCheck(packageNames: string[], options: RunCheckOptions): Promise<void> {
  const names = [...new Set(packageNames)].filter((n) => n.trim().length > 0);
  if (names.length === 0) return;
  const single = names.length === 1 && !options.refresh;
  const startedAt = Date.now();

  const engine = await createEngine(options.db, options.proxy);
  try {
    if (options.refresh && names.length > 0) {
      for (const name of names) {
        await engine.refreshPackage(name);
      }
    }

    if (single) {
      const name = names[0];
      const result = await engine.checkPackage(name);
      await engine.recordCheckHistory(result);
      recordTelemetry("check", [{ name, ok: true, result }], startedAt);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!printSingleResult(result, name)) process.exitCode = 1;
      return;
    }

    const results = await engine.checkPackages(names, {
      concurrency: options.concurrency,
    });
    saveLastBatch(results);
    for (const entry of results) {
      if (entry.ok && entry.result) {
        await engine.recordCheckHistory(entry.result);
      }
    }
    recordTelemetry("check", results, startedAt);

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    let failed = false;
    for (const entry of results) {
      if (!entry.ok) {
        failed = true;
        console.log(`  [error] ${entry.name} — ${entry.error}`);
        continue;
      }
      const r = entry.result!;
      if (!r.exists) {
        failed = true;
        console.log(`  [${t("check.notFoundShort")}] ${entry.name}`);
        continue;
      }
      const count = r.security.staticScan?.findings.length ?? 0;
      console.log(
        `  [${r.security.overallLevel}] ${r.packageName}@${r.latestVersion} — ${r.security.overallScore}/100 (${count} ${t("check.findings")})`,
      );
      if (
        r.security.overallLevel === "dangerous" ||
        r.security.overallLevel === "unknown"
      ) {
        failed = true;
      }
    }
    console.log(
      `${t("check.batchSummary", { count: String(names.length) })}${failed ? ` — ${t("check.batchFailed")}` : ""}`,
    );
    if (failed) process.exitCode = 2;
  } finally {
    engine.close();
  }
}

/**
 * Re-render the full report of the package at the given 1-based index of the
 * most recent batch check, without re-fetching from the registry.
 */
export async function runDetail(index: number, options: RunCheckOptions): Promise<void> {
  const batch = loadLastBatch();
  if (batch === null) {
    console.error(t("check.detailNone"));
    process.exitCode = 1;
    return;
  }
  if (index < 1 || index > batch.length) {
    console.error(t("check.detailOutOfRange", {
      index: String(index),
      count: String(batch.length),
    }));
    process.exitCode = 1;
    return;
  }

  const entry: BatchPackageResult = batch[index - 1];
  if (!entry.ok) {
    console.error(t("check.detailFailed", { name: entry.name, message: entry.error ?? "" }));
    process.exitCode = 1;
    return;
  }
  const result = entry.result!;
  if (!result.exists) {
    console.error(t("check.notFound", { name: entry.name }));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!printSingleResult(result, entry.name)) process.exitCode = 1;
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check [package-name...]")
    .description("Check one or more packages' security posture from the npm registry")
    .option("-j, --json", "Output raw JSON")
    .option("-r, --refresh", "Force a fresh registry fetch")
    .option("-f, --file <path>", "Read package names from a file (one per line)")
    .option("--concurrency <n>", "Max concurrent checks for batch mode (default: 5)")
    .action(async (packageName: string[] = [], options: { json?: boolean; refresh?: boolean; file?: string; concurrency?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
      const runOptions: RunCheckOptions = {
        db: opts.db,
        proxy: opts.proxy,
        json: options.json ?? opts.json,
        refresh: options.refresh,
        concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
      };

      // `check detail <n>` re-renders the n-th package of the last batch.
      if (packageName[0] === "detail") {
        if (packageName.length < 2) {
          console.error(t("check.detailMissingIndex"));
          process.exitCode = 1;
          return;
        }
        const index = Number(packageName[1]);
        if (!Number.isInteger(index) || index < 1) {
          console.error(t("check.detailInvalidIndex", { value: packageName[1] }));
          process.exitCode = 1;
          return;
        }
        await runDetail(index, runOptions);
        return;
      }

      let names = packageName;
      if (options.file) {
        try {
          const content = readFileSync(options.file, "utf8");
          const fromFile = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("#"));
          names = [...fromFile, ...names];
        } catch (err) {
          console.error(t("check.fileError", { path: options.file, message: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
          return;
        }
      }
      if (names.length === 0) {
        console.error(t("check.noPackages"));
        process.exitCode = 1;
        return;
      }
      const concurrency = options.concurrency ? parseInt(options.concurrency, 10) : undefined;
      if (concurrency !== undefined && (Number.isNaN(concurrency) || concurrency < 1)) {
        console.error(t("check.invalidConcurrency", { value: options.concurrency ?? "" }));
        process.exitCode = 1;
        return;
      }
      await runCheck(names, {
        db: opts.db,
        proxy: opts.proxy,
        json: options.json ?? opts.json,
        refresh: options.refresh,
        concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
      });
    });
}

/**
 * Record a check telemetry event (no-op unless telemetry is enabled).
 */
function recordTelemetry(
  event: string,
  results: readonly BatchPackageResult[],
  startedAt: number,
): void {
  try {
    const levels: Record<string, number> = {};
    let errors = 0;
    for (const entry of results) {
      if (!entry.ok || !entry.result?.exists) {
        errors++;
        continue;
      }
      const level = entry.result.security.overallLevel;
      levels[level] = (levels[level] ?? 0) + 1;
    }
    const telemetry = new TelemetryManager();
    telemetry.record({
      event,
      timestamp: new Date().toISOString(),
      packageCount: results.length,
      durationMs: Date.now() - startedAt,
      levels,
      error: errors > 0 ? `${errors} package(s) failed` : undefined,
    });
  } catch {
    // Telemetry must never break the command.
  }
}
