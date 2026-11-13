import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeTarball } from './helpers/package-tarball.js';
import { collectSourceBundle } from '../src/llm/source/source-bundle.js';
import { validateReview } from '../src/llm/source/review-contract.js';
import { EVIDENCE_OFFSET_POLICY, normalizeReviewEvidenceOffsets } from '../src/llm/source/normalize-evidence.js';
import type { SourcePacket, SourceReview } from '../src/llm/source/types.js';

const FILE = 'package/index.js';
function packet(source: string, ranges?: [number, number][]): SourcePacket {
  const input: SourcePacket = { ...collectSourceBundle(makeTarball([{ path: FILE, content: source }]), { main: 'index.js' }), caseId: 'case-normalization' };
  if (ranges) {
    const file = input.files.find(item => item.path === FILE)!;
    file.excerpts = ranges.map(([startOffset, endOffset]) => ({ startOffset, endOffset, startLine: 1, endLine: 1, text: source.slice(startOffset, endOffset) }));
    file.shownChars = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    file.complete = file.shownChars === source.length;
  }
  return input;
}
function review(input: SourcePacket, quote: string, startOffset: number, endOffset = startOffset + quote.length): SourceReview {
  return { schemaVersion: 1, caseId: input.caseId, verdict: 'malicious', confidence: 0.7,
    summary: 'Controlled schema fixture; no claim about real code.', limitations: ['Only supplied excerpts are evidence.'],
    findings: [{ kind: 'fixture', severity: 'high', claim: 'Controlled claim.', reasoning: 'Controlled reasoning.',
      evidence: [{ path: FILE, startOffset, endOffset, quote }] }] };
}
function semantics(value: SourceReview) {
  return { ...value, findings: value.findings.map(finding => ({ ...finding,
    evidence: finding.evidence.map(({ startOffset: _start, endOffset: _end, ...evidence }) => evidence) })) };
}
function normalize(value: unknown, input: SourcePacket) {
  const original = structuredClone(value), originalPacket = structuredClone(input);
  const result = normalizeReviewEvidenceOffsets(value, input);
  assert.deepEqual(value, original, 'model response must not be mutated');
  assert.deepEqual(input, originalPacket, 'supplied source packet must not be mutated');
  return result;
}
function reject(value: unknown, input: SourcePacket) {
  const result = normalize(value, input);
  assert.strictEqual(result.review, value, 'failed correction is an all-or-nothing transaction');
  assert.deepEqual(result.corrections, []);
  assert.equal(validateReview(result.review, input, input.caseId).valid, false);
}

describe('strict unique source quote offset normalization', () => {
  it('exports a stable policy and preserves an already exact citation even when the quote repeats', () => {
    assert.equal(EVIDENCE_OFFSET_POLICY, 'unique-exact-quote-v1');
    const input = packet('run();\nrun();\n');
    const raw = review(input, 'run()', 7);
    const result = normalize(raw, input);
    assert.deepEqual(result.review, raw);
    assert.notStrictEqual(result.review, raw);
    assert.deepEqual(result.corrections, []);
  });

  it('corrects only an incorrect end when the original start and unique verbatim quote are exact', () => {
    const source = '// prefix\nrunPayload();\n', quote = 'runPayload()';
    const input = packet(source), start = source.indexOf(quote);
    const raw = review(input, quote, start, start + quote.length + 5);
    assert.equal(validateReview(raw, input, input.caseId).valid, false);
    const result = normalize(raw, input), corrected = result.review as SourceReview;
    assert.equal(validateReview(corrected, input, input.caseId).valid, true);
    assert.deepEqual(semantics(corrected), semantics(raw));
    assert.deepEqual(result.corrections, [{ findingIndex: 0, evidenceIndex: 0,
      originalStartOffset: start, originalEndOffset: start + quote.length + 5, startOffset: start, endOffset: start + quote.length }]);
    assert.doesNotMatch(JSON.stringify(result.corrections), /quote|path|runPayload/);
  });

  it('relocates a unique quote from incorrect coordinates without changing its verdict or finding', () => {
    const source = '// prefix\nrunPayload();\n', quote = 'runPayload()';
    const input = packet(source), raw = review(input, quote, 0);
    const result = normalize(raw, input), corrected = result.review as SourceReview;
    assert.equal(corrected.findings[0].evidence[0].startOffset, source.indexOf(quote));
    assert.equal(corrected.findings[0].evidence[0].endOffset, source.indexOf(quote) + quote.length);
    assert.deepEqual(semantics(corrected), semantics(raw));
    assert.equal(corrected.verdict, 'malicious');
    assert.equal(corrected.findings[0].severity, 'high');
  });

  it('uses absolute UTF-16 coordinates with astral characters and CRLF intact', () => {
    const source = '😀前缀\r\n' + 'run("𝄞");\r\n', quote = 'run("𝄞")';
    const input = packet(source), raw = review(input, quote, 1, 2);
    const result = normalize(raw, input), evidence = (result.review as SourceReview).findings[0].evidence[0];
    assert.equal(evidence.startOffset, source.indexOf(quote));
    assert.equal(evidence.endOffset - evidence.startOffset, quote.length);
    assert.notEqual(evidence.startOffset, [...source.slice(0, source.indexOf(quote))].length);
    assert.equal(validateReview(result.review, input, input.caseId).valid, true);
  });

  it('rejects multiple absolute matches, including overlapping ones', () => {
    for (const [source, quote] of [['run(); run();', 'run()'], ['aaaa', 'aaa']]) {
      const input = packet(source);
      reject(review(input, quote, source.length + 1), input);
    }
  });

  it('deduplicates the same absolute match exposed by overlapping supplied excerpts', () => {
    const source = 'xxneedlezz', input = packet(source, [[0, 8], [2, 10]]);
    const result = normalize(review(input, 'needle', 0), input);
    assert.equal(result.corrections.length, 1);
    assert.equal((result.review as SourceReview).findings[0].evidence[0].startOffset, 2);
  });

  it('does not join excerpts across hidden gaps or inspect text omitted from them', () => {
    const source = 'abcHIDDENdef', input = packet(source, [[0, 3], [9, 12]]);
    reject(review(input, 'cdef', 0), input);
    reject(review(input, 'HIDDEN', 3), input);
  });

  it('never guesses a path, searches a different file, or treats an indexed-only file as evidence', () => {
    const input = packet('uniqueCall();');
    for (const path of ['index.js', 'PACKAGE/index.js', '../index.js', 'package/other.js']) {
      const raw = review(input, 'uniqueCall()', 1);
      raw.findings[0].evidence[0].path = path;
      input.sourceIndex.push({ path, totalChars: 13, shownChars: 0, selectionReasons: [] });
      reject(raw, input);
    }
    input.files.push({ ...structuredClone(input.files[0]), path: FILE });
    reject(review(input, 'uniqueCall()', 1), input);
  });

  it('does not normalize case, whitespace, Unicode composition, or line endings in quotes', () => {
    const input = packet('run("é");\r\nnext();');
    for (const quote of ['RUN("é")', 'run( "é" )', 'run("e\u0301")', ');\nnext()']) reject(review(input, quote, 0), input);
  });

  it('keeps malformed coordinate types, empty/reversed ranges, and oversized quotes rejected', () => {
    const input = packet('run();');
    for (const patch of [{ startOffset: -1 }, { startOffset: 0.5 }, { startOffset: '0' },
      { endOffset: 0 }, { endOffset: NaN }, { endOffset: Infinity }, { endOffset: Number.MAX_SAFE_INTEGER + 1 },
      { quote: '' }, { quote: ' ' }, { quote: 'x'.repeat(2001) }, { unexpected: true }]) {
      const raw = review(input, 'run()', 0);
      Object.assign(raw.findings[0].evidence[0], patch);
      reject(raw, input);
    }
  });

  it('preserves all other schema, trusted identity, and verdict constraints', () => {
    const input = packet('run();');
    for (const patch of [{ caseId: 'wrong-case' }, { unexpected: true }, { verdict: 'safe' },
      { verdict: 'benign' }, { confidence: 2 }, { limitations: null }, { summary: '' }]) {
      reject(Object.assign(review(input, 'run()', 1), patch), input);
    }
    const malicious = review(input, 'run()', 1);
    malicious.findings[0].severity = 'medium';
    reject(malicious, input);
    const benign = review(input, 'run()', 1);
    benign.verdict = 'benign';
    benign.findings[0].severity = 'medium';
    const corrected = normalize(benign, input).review as SourceReview;
    assert.equal(corrected.verdict, 'benign');
    assert.equal(corrected.findings[0].severity, 'medium');
  });

  it('does not partially accept a repair when another finding has fabricated evidence', () => {
    const input = packet('run();'), raw = review(input, 'run()', 1);
    raw.findings.push({ ...structuredClone(raw.findings[0]), evidence: [{ path: FILE, startOffset: 0, endOffset: 4, quote: 'evil' }] });
    reject(raw, input);
  });

  it('rejects excessive or sparse finding/evidence arrays without attempting partial corrections', () => {
    const input = packet('run();'), raw = review(input, 'run()', 1);
    const many = structuredClone(raw);
    many.findings = Array.from({ length: 13 }, () => structuredClone(raw.findings[0]));
    reject(many, input);
    const tooManyEvidence = structuredClone(raw);
    tooManyEvidence.findings[0].evidence = Array.from({ length: 13 }, () => structuredClone(raw.findings[0].evidence[0]));
    reject(tooManyEvidence, input);
    const sparse = structuredClone(raw);
    sparse.findings = Array(1);
    reject(sparse, input);
    const sparseEvidence = structuredClone(raw);
    sparseEvidence.findings[0].evidence = Array(1);
    reject(sparseEvidence, input);
    const sparseLimitations = structuredClone(raw);
    sparseLimitations.limitations = Array(1);
    const result = normalize(sparseLimitations, input);
    assert.strictEqual(result.review, sparseLimitations);
    assert.deepEqual(result.corrections, []);
  });
});
