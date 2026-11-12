import { createHash } from 'node:crypto';
import type { LlmScanProvider } from './provider.js';
import { FindingCategory, Severity, type ScanFinding } from '../scanner/types.js';
import { collectSourceBundle, SOURCE_BUNDLE_LIMITS } from './source/source-bundle.js';
import { collectSourceSupplement, combineSourceEvidence, sourceLineAt, SUPPLEMENT_LIMITS } from './source/source-supplement.js';
import { SYSTEM_PROMPT, REVIEW_PROMPT, validateReview } from './source/review-contract.js';
import type { SourceBundle, SourcePacket, SourceReview, SourceSupplement } from './source/types.js';
import { assertSourcePrompt, SOURCE_RESPONSE_BYTES } from './source-transport.js';

export const SOURCE_REVIEW_PROTOCOL_VERSION = 'npm-safe-source-review-v1';
const API_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  'and write the assigned request/result files.',
  'and return a JSON response. You have no tools, filesystem access or network access.',
);
const REQUEST_PROMPT = `Instead of a final review, you may return ONE optional source request:
{"schemaVersion":1,"caseId":"the supplied case ID","requests":[{"path":"exact sourceIndex path","startOffset":0,"endOffset":1000,"reason":"Missing behavior or connection"}]}
At most 4 ranges, 40000 UTF-16 characters total, and 24000 per file. Offsets refer to original source; endOffset is exclusive. Only paths from packet.sourceIndex are permitted. Do not read files or contact endpoints yourself. The coordinator returns the requested source as data in one final round. If the available evidence does not support a reliable decision, return unknown. Do not request a second supplement.`;
export const SOURCE_REVIEW_PROTOCOL_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  version: SOURCE_REVIEW_PROTOCOL_VERSION, system: API_SYSTEM_PROMPT, review: REVIEW_PROMPT,
  request: REQUEST_PROMPT, initialLimits: SOURCE_BUNDLE_LIMITS, supplementLimits: SUPPLEMENT_LIMITS,
})).digest('hex');

/** Independent model result; confidence is not a security score or a probability. */
export interface SourceReviewReport {
  readonly enabled: boolean;
  readonly status: 'complete' | 'failed' | 'skipped';
  readonly verdict: 'malicious' | 'benign' | 'unknown';
  readonly summary?: string;
  readonly reason?: string;
  readonly review?: SourceReview;
  readonly findings: readonly ScanFinding[];
  readonly coverage?: SourceBundle['coverage'];
  readonly calls: number;
  readonly initialChars: number;
  readonly supplementChars: number;
  readonly newlyCoveredChars: number;
  /** Includes the initial source repeated in the stateless second API request. */
  readonly sourceCharsSent: number;
  /** UTF-16 prompt characters sent, including system instructions and retransmits. */
  readonly promptCharsSent: number;
  /** Empty when no archive could be acquired. */
  readonly archiveSha256: string;
  readonly protocolVersion: string;
  readonly protocolFingerprint: string;
  readonly scannedAt: string;
}

export function unavailableSourceReview(reason: string, status: 'failed' | 'skipped' = 'failed'): SourceReviewReport {
  return {
    enabled: status !== 'skipped', status, verdict: 'unknown', reason: reason.slice(0, 1000), findings: [],
    calls: 0, initialChars: 0, supplementChars: 0, newlyCoveredChars: 0, sourceCharsSent: 0, promptCharsSent: 0,
    archiveSha256: '', protocolVersion: SOURCE_REVIEW_PROTOCOL_VERSION,
    protocolFingerprint: SOURCE_REVIEW_PROTOCOL_FINGERPRINT, scannedAt: new Date().toISOString(),
  };
}

function parseResponse(response: string): unknown {
  if (typeof response !== 'string' || Buffer.byteLength(response, 'utf8') > SOURCE_RESPONSE_BYTES) {
    throw new Error('Source-review response exceeds the byte budget.');
  }
  try { return JSON.parse(response) as unknown; }
  catch { throw new Error('Source-review response was not valid JSON.'); }
}

function findingsFor(review: SourceReview, evidence: SourcePacket): ScanFinding[] {
  return review.findings.map((finding, index) => {
    const first = finding.evidence[0];
    const span = evidence.files.find(file => file.path === first.path)?.excerpts.find(excerpt =>
      first.startOffset >= excerpt.startOffset && first.endOffset <= excerpt.endOffset);
    return {
      ruleId: `llm-source-${index + 1}`,
      ruleName: finding.kind,
      severity: finding.severity as Severity,
      message: finding.claim,
      category: FindingCategory.Informational,
      recommendation: finding.reasoning,
      filePath: first.path,
      lineNumber: span ? span.startLine + sourceLineAt(span.text, first.startOffset - span.startOffset) - 1 : undefined,
      codeSnippet: first.quote,
    };
  });
}

/** At most two model calls. All package bytes are inert data, never evaluated. */
export async function reviewPackageSource(
  archive: Buffer,
  manifest: Record<string, unknown>,
  provider: LlmScanProvider,
  signal?: AbortSignal,
): Promise<SourceReviewReport> {
  signal?.throwIfAborted();
  if (!provider.reviewSource) return unavailableSourceReview('The configured provider does not support source review.', 'skipped');
  if (!Buffer.isBuffer(archive) || archive.length > 20 * 1024 * 1024) return unavailableSourceReview('Source archive is missing or exceeds the compressed byte budget.');
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const caseId = `case-${archiveSha256.slice(0, 12)}`;
  let coverage: SourceBundle['coverage'] | undefined;
  let calls = 0, initialChars = 0, supplementChars = 0, newlyCoveredChars = 0, sourceCharsSent = 0, promptCharsSent = 0;
  let responseBytes = 0;
  const accounting = () => ({ archiveSha256, coverage, calls, initialChars, supplementChars, newlyCoveredChars, sourceCharsSent, promptCharsSent });
  try {
    const packet: SourcePacket = { ...collectSourceBundle(archive, manifest), caseId };
    coverage = packet.coverage;
    initialChars = coverage.shownChars;
    if (coverage.archiveInspection.status === 'failed') throw new Error(coverage.archiveInspection.reason ?? 'Source archive inspection failed.');
    if (!packet.files.some(file => file.shownChars > 0 &&
      !/(?:^|\/)(?:package\.json|readme(?:\.[^/]*)?)$/i.test(file.path) && !/\.d\.[cm]?ts$/i.test(file.path))) {
      throw new Error('No executable source was available in the selected evidence.');
    }
    const call = async (supplement?: SourceSupplement): Promise<unknown> => {
      signal?.throwIfAborted();
      const systemPrompt = `${API_SYSTEM_PROMPT}\n\n${REVIEW_PROMPT}\n\n${supplement
        ? 'The single allowed supplement is included. Return your final review now; further source requests are not permitted.'
        : REQUEST_PROMPT}`;
      const prompt = JSON.stringify({ caseId, packet, ...(supplement ? { supplement } : {}) });
      assertSourcePrompt({ systemPrompt, prompt, signal });
      calls++;
      sourceCharsSent += initialChars + (supplement?.coverage.transmittedChars ?? 0);
      promptCharsSent += systemPrompt.length + prompt.length;
      const response = await provider.reviewSource!({ systemPrompt, prompt, signal });
      signal?.throwIfAborted();
      responseBytes = typeof response === 'string' ? Buffer.byteLength(response, 'utf8') : Infinity;
      return parseResponse(response);
    };
    let parsed = await call();
    let evidence = packet;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'requests')) {
      if (responseBytes > SUPPLEMENT_LIMITS.requestBytes) throw new Error('Source request exceeds the byte budget.');
      if (createHash('sha256').update(archive).digest('hex') !== archiveSha256) throw new Error('Source archive changed during review.');
      const supplement = collectSourceSupplement(archive, packet, parsed, caseId);
      supplementChars = supplement.coverage.transmittedChars;
      newlyCoveredChars = supplement.coverage.newlyCoveredChars ?? 0;
      evidence = combineSourceEvidence(packet, supplement);
      parsed = await call(supplement);
    }
    const checked = validateReview(parsed, evidence, caseId);
    if (!checked.valid || !checked.normalized) throw new Error(`Invalid source review: ${checked.errors.join(' ')}`);
    if (createHash('sha256').update(archive).digest('hex') !== archiveSha256) throw new Error('Source archive changed during review.');
    return {
      ...unavailableSourceReview(''), ...accounting(), enabled: true, status: 'complete',
      verdict: checked.normalized.verdict, summary: checked.normalized.summary,
      reason: undefined, review: checked.normalized, findings: findingsFor(checked.normalized, evidence),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...unavailableSourceReview(error instanceof Error ? error.message : 'Source review failed.'), ...accounting() };
  }
}
