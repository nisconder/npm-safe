import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSourceReview } from '../src/cli/source-review-format.js';
import { getLocale, setLocale } from '../src/cli/i18n.js';
import type { SourceReviewReport } from '../src/llm/source-review.js';

function correctedReport(): SourceReviewReport {
  return { enabled: true, status: 'complete', verdict: 'malicious',
    summary: 'Validated source evidence.', findings: [], calls: 1, sourceCharsSent: 40000,
    initialChars: 40000, supplementChars: 0, newlyCoveredChars: 0, promptCharsSent: 41000,
    archiveSha256: 'fixture', protocolVersion: 'fixture', protocolFingerprint: 'fixture', scannedAt: '2026-11-14T00:00:00Z',
    evidenceOffsetCorrections: [
      { findingIndex: 0, evidenceIndex: 0, originalStartOffset: 987654, originalEndOffset: 987699, startOffset: 12, endOffset: 20 },
      { findingIndex: 0, evidenceIndex: 1, originalStartOffset: 876543, originalEndOffset: 876599, startOffset: 30, endOffset: 40 },
    ] };
}

describe('source-review coordinate correction notices', () => {
  it('shows only the count in English and Chinese without dumping audit coordinates', () => {
    const previousLocale = getLocale();
    try {
      const report = correctedReport();
      setLocale('en');
      const english = formatSourceReview(report);
      assert.match(english, /Corrected 2 evidence coordinates[\s\S]*full validation/);
      assert.doesNotMatch(english, /987654|originalStartOffset|findingIndex/);
      setLocale('zh');
      const chinese = formatSourceReview(report);
      assert.match(chinese, /唯一逐字引用校正 2 处坐标；引用仍经过完整校验/);
      assert.doesNotMatch(chinese, /987654|originalStartOffset|findingIndex/);
    } finally { setLocale(previousLocale); }
  });

  it('omits the notice for absent, empty, or malformed correction arrays', () => {
    for (const value of [undefined, [], { length: 5 }]) {
      const report = { ...correctedReport(), evidenceOffsetCorrections: value } as SourceReviewReport;
      assert.doesNotMatch(formatSourceReview(report), /Corrected|逐字引用校正/);
    }
  });

  it('preserves JSON audit entries, verdict, call accounting, and findings while formatting', () => {
    const report = correctedReport();
    const before = JSON.stringify(report);
    formatSourceReview(report);
    assert.equal(JSON.stringify(report), before);
    assert.deepEqual(JSON.parse(before).evidenceOffsetCorrections, report.evidenceOffsetCorrections);
    assert.equal(report.verdict, 'malicious');
    assert.equal(report.calls, 1);
    assert.equal(report.sourceCharsSent, 40000);
  });
});
