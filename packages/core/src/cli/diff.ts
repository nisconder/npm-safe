import { Command } from 'commander';
import { createEngine } from './shared.js';
import { assertExactReleaseVersion } from '../release-diff.js';
import type { ReleaseDiffReport } from '../release-diff.js';
import type { ScanFinding } from '../scanner/types.js';
import type { NpmSafeEngine } from '../index.js';

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatReleaseDiff(report: ReleaseDiffReport): string {
  const lines = [
    `${report.packageName}: ${report.before.version} -> ${report.after.version}`,
    `Comparison: ${report.status} (static observations, not a safety guarantee)`,
    `Before: ${report.before.report.overallLevel}, ${report.before.report.score}/100, deep ${report.before.report.contentScan?.status ?? 'unavailable'}`,
    `After: ${report.after.report.overallLevel}, ${report.after.report.score}/100, deep ${report.after.report.contentScan?.status ?? 'unavailable'}`,
    '', 'Registry manifest changes:',
  ];
  for (const change of report.manifestChanges) {
    lines.push(`  [${change.kind}] ${change.path}: ${JSON.stringify(change.before) ?? '(absent)'} -> ${JSON.stringify(change.after) ?? '(absent)'}`);
  }
  if (!report.manifestChanges.length) lines.push('  None in the compared fields.');
  const findings = (label: string, entries: readonly ScanFinding[]): void => {
    lines.push('', `${label}: ${entries.length}`);
    for (const finding of entries) {
      lines.push(`  [${finding.severity}] ${finding.ruleId} ${finding.filePath ?? '(manifest)'}${finding.lineNumber ? `:${finding.lineNumber}` : ''}`,
        `    ${finding.message}`);
      if (finding.codeSnippet) lines.push(`    ${finding.codeSnippet}`);
    }
  };
  findings('Added signals', report.findings.added);
  findings('Removed signals', report.findings.removed);
  findings('Persisting signals', report.findings.persisting.map(pair => pair.after));
  if (report.status !== 'complete') {
    findings('Unverified before-only observations', report.findings.unverifiedBefore);
    findings('Unverified after-only observations', report.findings.unverifiedAfter);
  }
  lines.push('', ...report.limitations.map(limit => `Note: ${limit}`));
  return lines.map(clean).join('\n');
}

type DiffEngineFactory = (db?: string, proxy?: string) => Promise<Pick<NpmSafeEngine, 'comparePackageVersions' | 'close'>>;

export function registerDiffCommand(program: Command, engineFactory: DiffEngineFactory = createEngine): void {
  program.command('diff <package> <from-version> <to-version>')
    .description('Compare static signals in two exact published releases (always deep-scans both)')
    .option('-j, --json', 'Output structured evidence and both complete scan reports')
    .action(async (name: string, from: string, to: string, options: { json?: boolean }) => {
      try {
        // Reject floating inputs before creating a database or making requests.
        assertExactReleaseVersion(from);
        assertExactReleaseVersion(to);
        const global = program.opts<{ db?: string; proxy?: string; json?: boolean }>();
        const engine = await engineFactory(global.db, global.proxy);
        try {
          const report = await engine.comparePackageVersions(name, from, to);
          console.log(options.json || global.json ? JSON.stringify(report, null, 2) : formatReleaseDiff(report));
          if (report.status !== 'complete') process.exitCode = 2;
        } finally {
          engine.close();
        }
      } catch (error) {
        console.error(clean(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}
