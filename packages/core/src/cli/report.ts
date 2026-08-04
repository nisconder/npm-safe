import { Command } from "commander";
import fs from "node:fs";

import type { BatchPackageResult } from "../index.js";
import { createEngine } from "./shared.js";
import { loadLastBatch } from "./batch-history.js";
import { t } from "./i18n.js";

const CSV_HEADER = ["name", "version", "level", "score", "findingCount"];

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(results: readonly BatchPackageResult[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const entry of results) {
    if (!entry.ok) {
      lines.push([csvEscape(entry.name), "", "error", "", ""].join(","));
      continue;
    }
    const r = entry.result!;
    lines.push(
      [
        csvEscape(r.packageName),
        csvEscape(r.latestVersion),
        csvEscape(r.security.overallLevel),
        String(r.security.overallScore),
        String(r.security.staticScan?.findings.length ?? 0),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

interface ReportOptions {
  readonly json?: boolean;
  readonly format?: string;
  readonly output?: string;
  readonly concurrency?: number;
  readonly proxy?: string;
  readonly db?: string;
}

/**
 * Resolve the package set to export: explicit names first, then `--file`,
 * then the last batch check (`--batch`).
 */
function resolveNames(
  names: readonly string[],
  file?: string,
  batch?: boolean,
): string[] {
  if (names.length > 0) return [...names];
  if (file) {
    const content = fs.readFileSync(file, "utf8");
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }
  if (batch) {
    const last = loadLastBatch();
    return (last ?? []).map((e) => e.name);
  }
  return [];
}

export async function runReport(
  names: readonly string[],
  options: ReportOptions,
): Promise<void> {
  const format = (options.format ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    console.error(t("report.unsupportedFormat", { format }));
    process.exitCode = 1;
    return;
  }

  const engine = await createEngine(options.db, options.proxy);
  let results: BatchPackageResult[];
  try {
    results = await engine.checkPackages(names, {
      concurrency: options.concurrency,
    });
  } finally {
    engine.close();
  }

  let payload: string;
  if (format === "csv") {
    payload = toCsv(results);
  } else {
    payload = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: results.length,
        packages: results,
      },
      null,
      2,
    );
  }

  if (options.output) {
    try {
      fs.writeFileSync(options.output, payload);
      console.log(t("report.exported", { path: options.output }));
    } catch (err) {
      console.error(t("report.exportFailed", { message: err instanceof Error ? err.message : String(err) }));
      process.exitCode = 1;
    }
    return;
  }
  process.stdout.write(payload);
}

export function registerReportCommand(program: Command): void {
  program
    .command("report [package-name...]")
    .description("Export security reports for packages (JSON or CSV)")
    .option("-f, --file <path>", "Read package names from a file (one per line)")
    .option("-b, --batch", "Export the most recent batch check results")
    .option("--format <format>", "Output format: json or csv (default: json)")
    .option("-o, --output <path>", "Write to a file instead of stdout")
    .option("--concurrency <n>", "Max concurrent checks (default: 5)")
    .action(async (packageName: string[] = [], options: { file?: string; batch?: boolean; format?: string; output?: string; concurrency?: string }) => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      let names = packageName;
      try {
        names = resolveNames(packageName, options.file, options.batch);
      } catch (err) {
        console.error(t("report.exportFailed", { message: err instanceof Error ? err.message : String(err) }));
        process.exitCode = 1;
        return;
      }
      if (names.length === 0) {
        console.error(t("report.noPackages"));
        process.exitCode = 1;
        return;
      }
      const concurrency = options.concurrency ? parseInt(options.concurrency, 10) : undefined;
      if (concurrency !== undefined && (Number.isNaN(concurrency) || concurrency < 1)) {
        console.error(t("check.invalidConcurrency", { value: options.concurrency ?? "" }));
        process.exitCode = 1;
        return;
      }
      await runReport(names, {
        db: opts.db,
        proxy: opts.proxy,
        format: options.format,
        output: options.output,
        concurrency,
      });
    });
}
