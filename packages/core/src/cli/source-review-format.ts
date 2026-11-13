import type { SourceReviewReport } from '../llm/source-review.js';
import { t } from './i18n.js';

/** Model output and source quotes are untrusted terminal text. */
const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function formatSourceReview(report: SourceReviewReport): string {
  const lines = [`${t('check.label.sourceReview')}: ${t('check.sourceSummary', {
    status: report.status, verdict: report.verdict, calls: String(report.calls), chars: String(report.sourceCharsSent),
  })}`];
  lines.push(t('check.sourceScoreNote'));
  const correctionCount = Array.isArray(report.evidenceOffsetCorrections) ? report.evidenceOffsetCorrections.length : 0;
  if (correctionCount > 0) lines.push(t('check.sourceOffsetCorrections', { count: String(correctionCount) }));
  if (report.summary) lines.push(report.summary);
  if (report.reason) lines.push(report.reason);
  for (const finding of report.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.ruleId} — ${finding.message}`);
    if (finding.filePath) lines.push(`    ${finding.filePath}:${finding.lineNumber ?? '?'}`);
    if (finding.codeSnippet) lines.push(`    ${finding.codeSnippet}`);
  }
  if (report.review?.limitations.length) {
    lines.push(`${t('check.sourceLimits')}:`, ...report.review.limitations.map(limit => `  ${limit}`));
  }
  return lines.map(clean).join('\n');
}
