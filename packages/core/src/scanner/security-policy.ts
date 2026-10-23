import { SecurityLevel, Severity, type ScanFinding } from './types.js';

/** Shared by live scans, persisted reports, the engine and CI. */
export function classifySecurity(
  score: number,
  findings: readonly ScanFinding[] = [],
  complete = true,
): SecurityLevel {
  if (findings.some((finding) => finding.severity === Severity.Critical) || score < 50) {
    return SecurityLevel.Dangerous;
  }
  if (!complete || !Number.isFinite(score)) return SecurityLevel.Unknown;
  return score >= 80 ? SecurityLevel.Safe : SecurityLevel.Suspicious;
}

export const SECURITY_LEVEL_RANK: Readonly<Record<SecurityLevel, number>> = {
  [SecurityLevel.Unknown]: 0,
  [SecurityLevel.Dangerous]: 1,
  [SecurityLevel.Suspicious]: 2,
  [SecurityLevel.Safe]: 3,
};

/** Inconclusive checks fail closed; critical findings always block. */
export function shouldFailCi(
  level: SecurityLevel,
  failLevel: SecurityLevel = SecurityLevel.Dangerous,
  findings: readonly ScanFinding[] = [],
): boolean {
  return findings.some((finding) => finding.severity === Severity.Critical) ||
    !Object.hasOwn(SECURITY_LEVEL_RANK, level) ||
    !Object.hasOwn(SECURITY_LEVEL_RANK, failLevel) ||
    SECURITY_LEVEL_RANK[level] <= SECURITY_LEVEL_RANK[failLevel];
}
