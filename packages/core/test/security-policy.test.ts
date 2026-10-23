import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySecurity, SECURITY_LEVEL_RANK, shouldFailCi } from '../src/scanner/security-policy.js';
import { StaticAnalyzer } from '../src/scanner/static-rules.js';
import { FindingCategory, SecurityLevel, Severity, type ScanFinding } from '../src/scanner/types.js';

function critical(index = 0): ScanFinding {
  return {
    ruleId: `critical-${index}`, ruleName: 'Critical fixture', severity: Severity.Critical,
    message: 'Constructed finding for security policy regression.', category: FindingCategory.InstallScript,
  };
}

describe('shared security classification and CI policy', () => {
  it('retains the dangerous classification below the previous 20-point boundary', () => {
    for (const score of [0, 1, 19, 20, 25, 49]) {
      assert.equal(classifySecurity(score), SecurityLevel.Dangerous, `score ${score}`);
    }
    assert.equal(classifySecurity(50), SecurityLevel.Suspicious);
    assert.equal(classifySecurity(79), SecurityLevel.Suspicious);
    assert.equal(classifySecurity(80), SecurityLevel.Safe);
    assert.equal(classifySecurity(100), SecurityLevel.Safe);
  });

  it('never reduces risk or releases the default CI gate as scores fall', () => {
    let previousRank = SECURITY_LEVEL_RANK[SecurityLevel.Safe];
    let previouslyBlocked = false;
    for (let score = 100; score >= 0; score--) {
      const level = classifySecurity(score);
      assert.ok(SECURITY_LEVEL_RANK[level] <= previousRank);
      const blocked = shouldFailCi(level);
      assert.ok(!previouslyBlocked || blocked, `CI released at score ${score}`);
      previousRank = SECURITY_LEVEL_RANK[level];
      previouslyBlocked = blocked;
    }
  });

  it('critical evidence is dangerous even with a high score or an incomplete scan', () => {
    assert.equal(classifySecurity(100, [critical()]), SecurityLevel.Dangerous);
    assert.equal(classifySecurity(100, [critical()], false), SecurityLevel.Dangerous);
    assert.equal(classifySecurity(Number.NaN, [critical()], false), SecurityLevel.Dangerous);
    assert.equal(classifySecurity(25, [], false), SecurityLevel.Dangerous);
  });

  it('incomplete scans without established danger remain unknown and fail closed', () => {
    for (const score of [50, 79, 80, 100]) {
      const level = classifySecurity(score, [], false);
      assert.equal(level, SecurityLevel.Unknown);
      assert.equal(shouldFailCi(level), true);
    }
    assert.equal(classifySecurity(Number.NaN), SecurityLevel.Unknown);
    assert.equal(classifySecurity(Number.POSITIVE_INFINITY), SecurityLevel.Unknown);
  });

  it('honors each configured threshold while retaining fail-closed unknown results', () => {
    const levels = [SecurityLevel.Unknown, SecurityLevel.Dangerous, SecurityLevel.Suspicious, SecurityLevel.Safe];
    const expectations = [
      [true, false, false, false],
      [true, true, false, false],
      [true, true, true, false],
      [true, true, true, true],
    ];
    for (let index = 0; index < levels.length; index++) {
      assert.deepEqual(levels.map((level) => shouldFailCi(level, levels[index])), expectations[index]);
    }
  });

  it('blocks critical findings even when a persisted classification or threshold would pass', () => {
    assert.equal(shouldFailCi(SecurityLevel.Safe, SecurityLevel.Dangerous, [critical()]), true);
    assert.equal(shouldFailCi(SecurityLevel.Safe, SecurityLevel.Unknown, [critical()]), true);
  });

  it('rejects unknown runtime values including inherited object properties', () => {
    for (const value of ['invalid', 'constructor', '__proto__', 'toString']) {
      assert.equal(shouldFailCi(value as SecurityLevel), true, `level ${value}`);
      assert.equal(shouldFailCi(SecurityLevel.Safe, value as SecurityLevel), true, `threshold ${value}`);
    }
  });

  it('keeps actual scanner reports blocked from three critical findings through score saturation', () => {
    const analyzer = new StaticAnalyzer([]);
    for (let count = 1; count <= 8; count++) {
      const report = analyzer.analyze('', undefined, Array.from({ length: count }, (_, index) => critical(index)));
      assert.equal(report.score, Math.max(0, 100 - count * 25));
      assert.equal(report.overallLevel, SecurityLevel.Dangerous);
      assert.equal(shouldFailCi(report.overallLevel, SecurityLevel.Dangerous, report.findings), true);
    }
  });
});
