import { Command } from "commander";
import { createEngine } from "./shared.js";
import type { CheckResult } from "../index.js";

interface CheckOptions {
  readonly db?: string;
  readonly json?: boolean;
  readonly refresh?: boolean;
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
    lines.push(`    Recommendation: ${f.recommendation}`);
  }
  if (f.codeSnippet) {
    lines.push(`    Snippet: ${f.codeSnippet}`);
  }
  if (f.lineNumber !== undefined) {
    lines.push(`    Line: ${f.lineNumber}`);
  }
  return lines.join("\n");
}

/**
 * Register the `check` command with the given Commander program.
 */
export function registerCheckCommand(program: Command): void {
  program
    .command("check <package-name>")
    .description("Check a package's security posture from the npm registry")
    .option("-d, --db <path>", "Path to the SQLite cache database")
    .option("-j, --json", "Output raw JSON instead of human-readable text")
    .option("-r, --refresh", "Force a fresh registry fetch instead of using cache")
    .action(async (packageName: string, options: CheckOptions) => {
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
          console.error(`Package "${packageName}" was not found on the registry.`);
          process.exitCode = 1;
          return;
        }

        const report = result.security.staticScan;
        const findingCount = report?.findings.length ?? 0;
        const lines: string[] = [
          `Package: ${result.packageName}`,
          `Latest version: ${result.latestVersion}`,
          `Security level: ${result.security.overallLevel}`,
          `Score: ${result.security.overallScore}/100`,
          `Findings: ${findingCount}`,
        ];

        if (result.registryInfo?.description) {
          lines.push(`Description: ${result.registryInfo.description}`);
        }
        if (result.registryInfo?.homepage) {
          lines.push(`Homepage: ${result.registryInfo.homepage}`);
        }
        if (result.registryInfo?.repository) {
          lines.push(`Repository: ${result.registryInfo.repository}`);
        }
        if (result.cachedAt) {
          lines.push(`Cached at: ${result.cachedAt}`);
        }

        if (findingCount > 0) {
          lines.push("");
          lines.push("Findings:");
          for (let i = 0; i < findingCount; i++) {
            const formatted = formatFinding(result, i);
            if (formatted) {
              lines.push(formatted);
            }
          }
        }

        console.log(lines.join("\n"));

        // Exit with non-zero code when the package is dangerous or unknown.
        if (
          result.security.overallLevel === "dangerous" ||
          result.security.overallLevel === "unknown"
        ) {
          process.exitCode = 2;
        }
      } finally {
        engine.close();
      }
    });
}
