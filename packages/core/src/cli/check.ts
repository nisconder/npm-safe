import { Command } from "commander";
import { createEngine } from "./shared.js";
import { t } from "./i18n.js";
import type { CheckResult } from "../index.js";

export interface RunCheckOptions {
  readonly json?: boolean;
  readonly refresh?: boolean;
  readonly db?: string;
}

/**
 * Format a single finding for terminal output.
 */
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
    lines.push(`    ${t("check.finding.recommendation")} ${f.recommendation}`);
  }
  if (f.codeSnippet) {
    lines.push(`    ${t("check.finding.snippet")} ${f.codeSnippet}`);
  }
  if (f.lineNumber !== undefined) {
    lines.push(`    ${t("check.finding.line")} ${f.lineNumber}`);
  }
  return lines.join("\n");
}

/**
 * Core check logic shared between the `check` command and the default
 * `npm-safe <package>` shorthand.
 */
export async function runCheck(packageName: string, options: RunCheckOptions): Promise<void> {
  const engine = createEngine(options.db);
  try {
    if (options.refresh) {
      await engine.refreshPackage(packageName);
    }
    const result = await engine.checkPackage(packageName);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!result.exists) {
      console.error(t("check.notFound", { name: packageName }));
      process.exitCode = 1;
      return;
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
        if (formatted) {
          lines.push(formatted);
        }
      }
    }

    console.log(lines.join("\n"));

    if (
      result.security.overallLevel === "dangerous" ||
      result.security.overallLevel === "unknown"
    ) {
      process.exitCode = 2;
    }
  } finally {
    engine.close();
  }
}

/**
 * Register the `check` command with the given Commander program.
 */
export function registerCheckCommand(program: Command): void {
  program
    .command("check <package-name>")
    .description("Check a package's security posture from the npm registry")
    .option("-j, --json", "Output raw JSON instead of human-readable text")
    .option("-r, --refresh", "Force a fresh registry fetch instead of using cache")
    .action(async (packageName: string, options: { json?: boolean; refresh?: boolean }) => {
      await runCheck(packageName, {
        db: program.opts<{ db?: string }>().db,
        json: options.json,
        refresh: options.refresh,
      });
    });
}
