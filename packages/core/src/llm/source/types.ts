/** Bounded source evidence. Offsets count UTF-16 code units, never bytes. */
export type SourceCoverageStatus = 'complete' | 'partial' | 'failed';
export interface SourceArchiveOptions {
  integrity?: string;
  shasum?: string;
  maxArchiveBytes?: number;
  maxUnpackedBytes?: number;
  maxEntries?: number;
}
export interface SourceBundleOptions extends SourceArchiveOptions {
  maxSourceChars?: number;
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxReadmeChars?: number;
  maxManifestChars?: number;
  maxFileBytes?: number;
  maxTextBytes?: number;
}
export interface SourceOmission {
  path: string;
  reason: string;
  bytes?: number;
  chars?: number;
}
export interface SourceArchive {
  status: SourceCoverageStatus;
  reason?: string;
  archiveBytes: number;
  unpackedBytes: number;
  entryCount: number;
  entries: {path: string; data: Buffer}[];
  skipped: SourceOmission[];
  reasons: string[];
}
export interface ManifestContext {
  description: string;
  type?: string;
  declaredEntryPaths: string[];
  lifecycleScripts: Record<string, string>;
  dependencyNames: string[];
}
export interface SourceCandidate {
  path: string;
  text: string;
  bytes: number;
  readme: boolean;
  manifest: boolean;
}
export interface SourceSignals {
  kinds: string[];
  positions: number[];
  contextKinds: string[];
  priorityPositions: number[];
}
export interface RankedSource extends SourceCandidate, SourceSignals {
  declaration: boolean;
  priority: number;
  reasons: string[];
}
export interface SourceExcerpt {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  text: string;
}
export interface SourceEvidenceFile {
  path: string;
  totalChars: number;
  totalLines: number;
  shownChars: number;
  complete?: boolean;
  selectionReasons?: string[];
  excerpts: SourceExcerpt[];
}
export interface SourceBundle {
  schemaVersion: 1;
  manifestContext: ManifestContext;
  sourceIndex: {path: string; totalChars: number; shownChars: number; selectionReasons: string[]}[];
  sourceIndexTruncated: boolean;
  coverage: {
    archiveInspection: {status: SourceCoverageStatus; reason?: string; entries: number};
    sourceCoverage: SourceCoverageStatus;
    candidateFiles: number;
    candidateBytes: number;
    decodedBytes: number;
    decodedChars: number;
    shownFiles: number;
    shownChars: number;
    selectedDemandChars: number;
    allocatedChars: number;
    omittedCount: number;
    omitted: {path?: string; pathPrefix?: string; pathTruncated?: boolean; reason: string; bytes?: number; chars?: number}[];
    omissionListTruncated: boolean;
    caveat: string;
  };
  selection: {
    method: string;
    budgetAllocation: string;
    limits: {sourceChars: number; files: number; charsPerFile: number; readmeChars: number; manifestChars: number; fileBytes: number; textBytes: number};
    declaredEntries: string[];
    referencedFiles: number;
  };
  files: SourceEvidenceFile[];
}
export interface SourcePacket extends SourceBundle { caseId: string; }
export interface SourceRequest {
  schemaVersion: 1;
  caseId: string;
  requests: {path: string; startOffset: number; endOffset: number; reason: string}[];
}
export interface SourceSupplement {
  schemaVersion: 1;
  caseId: string;
  limits: {rounds: number; requests: number; sourceChars: number; charsPerFile: number; requestBytes: number};
  coverage: {requestedChars: number; requestedFiles: number; transmittedChars: number; newlyCoveredChars?: number};
  files: SourceEvidenceFile[];
}
export interface SourceEvidence { path: string; startOffset: number; endOffset: number; quote: string; }
export interface SourceReview {
  schemaVersion: 1;
  caseId: string;
  verdict: 'malicious' | 'benign' | 'unknown';
  confidence: number;
  summary: string;
  findings: {kind: string; severity: 'low' | 'medium' | 'high' | 'critical'; claim: string; evidence: SourceEvidence[]; reasoning: string}[];
  limitations: string[];
}
export interface SourceReviewValidation { valid: boolean; errors: string[]; normalized?: SourceReview; }
