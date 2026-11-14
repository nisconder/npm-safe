import { validateReview } from './review-contract.js';
import type { SourceEvidenceFile, SourceExcerpt, SourcePacket, SourceReview } from './types.js';

export const EVIDENCE_OFFSET_POLICY = 'unique-exact-quote-v1';

/** Coordinates only: never retain or echo rejected model text in the audit. */
export interface SourceEvidenceOffsetCorrection {
  readonly findingIndex: number;
  readonly evidenceIndex: number;
  readonly originalStartOffset: number;
  readonly originalEndOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const verdicts = new Set<unknown>(['malicious', 'benign', 'unknown']);
const severities = new Set<unknown>(['low', 'medium', 'high', 'critical']);

/** Keep all schema constraints except the coordinate/quote-length agreement. */
function hasBasicShape(value: unknown): value is SourceReview {
  if (!object(value) || !only(value, ['schemaVersion', 'caseId', 'verdict', 'confidence', 'summary', 'findings', 'limitations']) ||
      value.schemaVersion !== 1 || !text(value.caseId, 200) || !verdicts.has(value.verdict) ||
      typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
      !text(value.summary, 4000) || !Array.isArray(value.limitations) || value.limitations.length > 24 ||
      Array.from(value.limitations).some(item => !text(item, 2000)) || !Array.isArray(value.findings) || value.findings.length > 12) return false;
  return Array.from(value.findings).every(finding => object(finding) &&
    only(finding, ['kind', 'severity', 'claim', 'evidence', 'reasoning']) &&
    text(finding.kind, 200) && severities.has(finding.severity) && text(finding.claim, 4000) && text(finding.reasoning, 6000) &&
    Array.isArray(finding.evidence) && finding.evidence.length > 0 && finding.evidence.length <= 12 &&
    Array.from(finding.evidence).every(evidence => object(evidence) && only(evidence, ['path', 'startOffset', 'endOffset', 'quote']) &&
      text(evidence.path, 4096) && text(evidence.quote, 2000) &&
      typeof evidence.startOffset === 'number' && Number.isSafeInteger(evidence.startOffset) && evidence.startOffset >= 0 &&
      typeof evidence.endOffset === 'number' && Number.isSafeInteger(evidence.endOffset) && evidence.endOffset > evidence.startOffset));
}

function suppliedExcerpts(file: SourceEvidenceFile): SourceExcerpt[] {
  if (!Number.isSafeInteger(file.totalChars) || file.totalChars < 0 || !Array.isArray(file.excerpts)) return [];
  return file.excerpts.filter(excerpt => object(excerpt) &&
    Number.isSafeInteger(excerpt.startOffset) && Number.isSafeInteger(excerpt.endOffset) &&
    excerpt.startOffset >= 0 && excerpt.endOffset > excerpt.startOffset && excerpt.endOffset <= file.totalChars &&
    typeof excerpt.text === 'string' && excerpt.text.length === excerpt.endOffset - excerpt.startOffset);
}

/** All absolute positions of the quote, including overlapping literal matches. */
function quoteOffsets(excerpts: readonly SourceExcerpt[], quote: string): number[] {
  const offsets = new Set<number>();
  for (const excerpt of excerpts) {
    let relative = excerpt.text.indexOf(quote);
    while (relative !== -1) {
      offsets.add(excerpt.startOffset + relative);
      // Advancing by quote.length would miss ambiguous overlapping matches.
      relative = excerpt.text.indexOf(quote, relative + 1);
    }
  }
  return [...offsets].sort((a, b) => a - b);
}

/**
 * A repeated quote stays ambiguous unless the model's own start offset matches
 * exactly one literal occurrence. That keeps drifted coordinates near repeated
 * fragments (e.g. `});`) resolvable without ever guessing between occurrences.
 */
function disambiguatedQuoteOffset(offsets: readonly number[], originalStartOffset: number): number | undefined {
  if (offsets.length === 1) return offsets[0];
  return offsets.length > 1 && offsets.includes(originalStartOffset) ? originalStartOffset : undefined;
}

/**
 * Relocate only an exact quote within its already supplied file excerpts, using
 * a unique literal match or the model's exact original start to disambiguate.
 * This never resolves a path, reads source, changes quote text, or drops findings.
 * The transaction is accepted only if the original strict validator accepts it.
 */
export function normalizeReviewEvidenceOffsets(
  review: unknown,
  bundle: SourcePacket,
): { review: unknown; corrections: SourceEvidenceOffsetCorrection[] } {
  const unchanged = { review, corrections: [] as SourceEvidenceOffsetCorrection[] };
  if (!hasBasicShape(review) || !Array.isArray(bundle?.files)) return unchanged;
  const byPath = new Map<string, SourceEvidenceFile | null>();
  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string') continue;
    byPath.set(file.path, byPath.has(file.path) ? null : file);
  }
  const candidate = structuredClone(review);
  const corrections: SourceEvidenceOffsetCorrection[] = [];
  for (const [findingIndex, finding] of candidate.findings.entries()) {
    for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
      const file = byPath.get(evidence.path);
      if (!file) return unchanged;
      const excerpts = suppliedExcerpts(file);
      const exact = evidence.endOffset - evidence.startOffset === evidence.quote.length && excerpts.some(excerpt =>
        evidence.startOffset >= excerpt.startOffset && evidence.endOffset <= excerpt.endOffset &&
        excerpt.text.slice(evidence.startOffset - excerpt.startOffset, evidence.endOffset - excerpt.startOffset) === evidence.quote);
      if (exact) continue;
      const startOffset = disambiguatedQuoteOffset(quoteOffsets(excerpts, evidence.quote), evidence.startOffset);
      if (startOffset === undefined) return unchanged;
      const endOffset = startOffset + evidence.quote.length;
      corrections.push({ findingIndex, evidenceIndex, originalStartOffset: evidence.startOffset,
        originalEndOffset: evidence.endOffset, startOffset, endOffset });
      evidence.startOffset = startOffset;
      evidence.endOffset = endOffset;
    }
  }
  // The trusted packet identity and every existing schema/verdict rule still apply.
  if (!validateReview(candidate, bundle, bundle.caseId).valid) return unchanged;
  return { review: candidate, corrections };
}
