/**
 * Type definitions for security scanning results.
 *
 * This module is foundational: it contains only TypeScript type definitions
 * (enums, interfaces, and JSDoc) and no runtime code, classes, or logic.
 */

/**
 * Overall security classification for a scanned package.
 *
 * Usable in `switch` statements as a string enum.
 */
export enum SecurityLevel {
  Safe = 'safe',
  Suspicious = 'suspicious',
  Dangerous = 'dangerous',
  Unknown = 'unknown',
}

/**
 * Severity of an individual scan finding.
 */
export enum Severity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

/**
 * The kind of scan that produced a report or finding.
 */
export enum ScanType {
  Static = 'static',
  Llm = 'llm',
}

/**
 * Categorization of what a finding represents.
 */
export enum FindingCategory {
  InstallScript = 'install-script',
  CodeObfuscation = 'code-obfuscation',
  BinaryDownload = 'binary-download',
  SensitiveExposure = 'sensitive-exposure',
  Typosquatting = 'typosquatting',
  SuspiciousDep = 'suspicious-dependency',
  HomographAttack = 'homograph-attack',
  RegistryMismatch = 'registry-mismatch',
  KnownMalicious = 'known-malicious',
  Informational = 'informational',
}

/**
 * A single issue discovered during a security scan.
 */
export interface ScanFinding {
  /** Stable identifier of the rule that produced this finding. */
  readonly ruleId: string;
  /** Human-readable name of the rule. */
  readonly ruleName: string;
  /** How severe this finding is. */
  readonly severity: Severity;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Optional code snippet that triggered the finding. */
  readonly codeSnippet?: string;
  /** Optional 1-based line number where the issue was detected. */
  readonly lineNumber?: number;
  /** Optional remediation guidance. */
  readonly recommendation?: string;
  /** Category classifying the nature of this finding. */
  readonly category: FindingCategory;
}

/**
 * A rule that inspects package metadata and README content to produce findings.
 */
export interface ScanRule {
  /** Stable unique identifier for the rule. */
  readonly id: string;
  /** Human-readable name of the rule. */
  readonly name: string;
  /** Description of what the rule detects. */
  readonly description: string;
  /** Default severity assigned to findings produced by this rule. */
  readonly severity: Severity;
  /** Category assigned to findings produced by this rule. */
  readonly category: FindingCategory;
  /** Whether the rule is enabled by default. */
  readonly enabled: boolean;
  /**
   * Inspect the given README and/or package.json and return any findings.
   *
   * @param readme - README content as a string.
   * @param packageJson - Parsed package.json as a plain object, if available.
   * @returns Findings produced by this rule.
   */
  match(readme: string, packageJson?: Record<string, unknown>): ScanFinding[];
}

/**
 * Report produced by a static (non-LLM) scan of a package.
 */
export interface StaticScanReport {
  /** Name of the scanned package. */
  readonly packageName: string;
  /** Version of the scanned package. */
  readonly version: string;
  /** Overall security level derived from static findings. */
  readonly overallLevel: SecurityLevel;
  /** Numeric score from 0 to 100 (higher is safer). */
  readonly score: number;
  /** Findings produced by the static scan. */
  readonly findings: readonly ScanFinding[];
  /** ISO 8601 timestamp of when the scan ran. */
  readonly scannedAt: string;
}

/**
 * Report produced by an LLM-based scan of a package.
 */
export interface LlmScanReport {
  /** Whether the LLM scan was actually performed. */
  readonly enabled: boolean;
  /** Reason the LLM scan was skipped or disabled, if applicable. */
  readonly reason?: string;
  /** Natural-language summary of the LLM analysis. */
  readonly summary?: string;
  /** Whether the package matches its declared functionality per the LLM. */
  readonly functionalMatch?: boolean;
  /** Suspiciousness score assigned by the LLM (0-100, higher is more suspicious). */
  readonly suspiciousScore?: number;
  /** Findings produced by the LLM scan. */
  readonly findings?: readonly ScanFinding[];
  /** ISO 8601 timestamp of when the LLM scan ran. */
  readonly scannedAt?: string;
}

/**
 * Combined report for a package, including static and optional LLM scans.
 */
export interface ScanReport {
  /** Name of the scanned package. */
  readonly packageName: string;
  /** Version of the scanned package. */
  readonly version: string;
  /** Results of the static scan. */
  readonly staticScan: StaticScanReport;
  /** Results of the LLM scan, if performed. */
  readonly llmScan?: LlmScanReport;
  /** Overall security level combining static and LLM results. */
  readonly overallLevel: SecurityLevel;
  /** Overall numeric score (0-100, higher is safer). */
  readonly overallScore: number;
  /** ISO 8601 timestamp of when the combined scan ran. */
  readonly scannedAt: string;
}

/**
 * Aggregated security summary for a package, suitable for storage and display.
 */
export interface SecuritySummary {
  /** Name of the package. */
  readonly packageName: string;
  /** Latest known version of the package. */
  readonly latestVersion: string;
  /** Overall security level for the package. */
  readonly overallLevel: SecurityLevel;
  /** Overall numeric score (0-100, higher is safer). */
  readonly overallScore: number;
  /** Total number of findings across all scans. */
  readonly findingCount: number;
  /** Number of findings with critical severity. */
  readonly criticalCount: number;
  /** Number of findings with high severity. */
  readonly highCount: number;
  /** Number of findings with medium severity. */
  readonly mediumCount: number;
  /** Number of findings with low severity. */
  readonly lowCount: number;
  /** ISO 8601 timestamp of the last scan, or null if never scanned. */
  readonly lastScanned: string | null;
  /** ISO 8601 timestamp of when this summary was cached. */
  readonly cachedAt: string;
}