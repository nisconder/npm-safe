import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readSourceArchive } from '../src/llm/source/archive-reader.js';
import { collectSourceBundle } from '../src/llm/source/source-bundle.js';
import { collectSourceSupplement, combineSourceEvidence, validateSourceRequest } from '../src/llm/source/source-supplement.js';
import { validateReview } from '../src/llm/source/review-contract.js';
import type { SourcePacket, SourceReview, SourceRequest } from '../src/llm/source/types.js';

/** Inert archive fixtures are read as bytes only, never installed or evaluated. */
function tarball(entries: {path: string; text?: string; type?: string; link?: string}[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? ''), header = Buffer.alloc(512);
    header.write(entry.path, 0, 100); header.write('0000644\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const packet = (archive: Buffer, budget = 40000): SourcePacket => ({
  ...collectSourceBundle(archive, {main: 'index.js'}, {maxSourceChars: budget}), caseId: 'case-inert-fixture',
});
const review = (input: SourcePacket): SourceReview => ({schemaVersion: 1, caseId: input.caseId,
  verdict: 'benign', confidence: 0.5, summary: 'No harmful behavior in this supplied fixture.', findings: [],
  limitations: ['Only supplied source was reviewed.'],
});

describe('production source evidence runtime', () => {
  it('rejects archive traversal, escaping links, duplicate paths and checksum/trailer corruption', () => {
    for (const entries of [
      [{path: '../escape.js'}], [{path: '/absolute.js'}], [{path: 'C:/drive.js'}],
      [{path: 'package/link', type: '2', link: '../../escape'}],
      [{path: 'package/a.js'}, {path: 'package/a.js'}],
    ]) assert.equal(readSourceArchive(tarball(entries)).status, 'failed');
    const original = gunzipSync(tarball([{path: 'package/index.js', text: 'const x=1;'}]));
    const header = Buffer.from(original); header[0] ^= 1;
    const tail = Buffer.from(original); tail[tail.length - 1] = 1;
    for (const malformed of [header, tail]) {
      const bundle = collectSourceBundle(gzipSync(malformed));
      assert.equal(bundle.coverage.archiveInspection.status, 'failed');
      assert.equal(bundle.files.length, 0);
    }
  });

  it('checks strongest supplied integrity and manifest-level fallback before providing source', () => {
    const archive = tarball([{path: 'package/index.js', text: 'const value=1;'}]);
    const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
    assert.equal(collectSourceBundle(archive, {dist: {integrity}}).coverage.archiveInspection.status, 'complete');
    assert.equal(collectSourceBundle(archive, {integrity}).coverage.archiveInspection.status, 'complete');
    assert.equal(collectSourceBundle(archive, {dist: {integrity: 'sha512-AAAA'}}).coverage.archiveInspection.status, 'failed');
    assert.equal(collectSourceBundle(archive, {shasum: '0'.repeat(40)}).coverage.archiveInspection.status, 'failed');
    const weak = 'sha1-' + createHash('sha1').update(archive).digest('base64');
    assert.equal(readSourceArchive(archive, {integrity: weak + ' sha512-AAAA'}).status, 'failed');
  });

  it('keeps decompression, member and source budgets visible and cannot raise hard caps', () => {
    const archive = tarball([{path: 'package/index.js', text: ' '.repeat(100000)}]);
    assert.equal(readSourceArchive(archive, {maxUnpackedBytes: 1024}).status, 'partial');
    assert.equal(readSourceArchive(archive, {maxArchiveBytes: 1}).status, 'partial');
    assert.equal(readSourceArchive(archive, {maxEntries: 0}).status, 'partial');
    assert.equal(collectSourceBundle(archive, {}, {maxFileBytes: 64}).coverage.sourceCoverage, 'partial');
    const tooLarge = tarball([{path: 'package/index.js', text: ' '.repeat(4 * 1024 * 1024 + 1)}]);
    const bundle = collectSourceBundle(tooLarge, {}, {maxFileBytes: 16 * 1024 * 1024});
    assert.equal(bundle.coverage.sourceCoverage, 'partial'); assert.equal(bundle.files.length, 0);
    assert.throws(() => collectSourceBundle(archive, {}, {maxSourceChars: -1}), /nonnegative/);
    assert.equal(collectSourceBundle(tarball([{path: 'package/addon.node', text: 'inert binary placeholder'}])).coverage.sourceCoverage, 'partial');
  });

  it('prioritizes runtime entries and reachable execution context ahead of type declarations', () => {
    const entries = [{path: 'package/package.json', text: '{"main":"index.js"}'},
      {path: 'package/index.js', text: 'require("./decoder");'},
      {path: 'package/decoder.js', text: 'const encoded="' + '\u{E0100}'.repeat(12) + '"; eval("void 0");'},
      ...Array.from({length: 25}, (_, index) => ({path: `package/types-${index}.d.ts`, text: 'export declare function fetch(): void;'})),
      ...Array.from({length: 20}, (_, index) => ({path: `package/http-${index}.js`, text: 'const examples="fetch https readFile process.env spawn exec";'}))];
    const manifest = {main: 'index.js', exports: {types: entries.filter(entry => entry.path.endsWith('.d.ts')).map(entry => './' + entry.path.slice(8))}};
    const bundle = collectSourceBundle(tarball(entries), manifest);
    assert.deepEqual(bundle.files.slice(0, 3).map(file => file.path), ['package/package.json', 'package/index.js', 'package/decoder.js']);
    assert.deepEqual(bundle, collectSourceBundle(tarball([...entries].reverse()), manifest));
    assert.ok(!Object.hasOwn(bundle, 'verdict'));
  });

  it('supports root manifests and redistributes budgets while retaining original UTF-16 spans', () => {
    const long = '// 🌐\r\n' + 'const value=1;\n'.repeat(800);
    const archive = tarball([{path: 'package.json', text: '{"main":"index.js"}'},
      {path: 'index.js', text: 'require("./large");'}, {path: 'large.js', text: long}]);
    const bundle = collectSourceBundle(archive, {main: 'index.js'}, {maxSourceChars: 1000});
    assert.deepEqual(bundle.selection.declaredEntries, ['index.js']);
    assert.equal(bundle.coverage.shownChars, 1000);
    const file = bundle.files.find(file => file.path === 'large.js')!;
    assert.ok(file.shownChars > 900);
    for (const excerpt of file.excerpts) assert.equal(long.slice(excerpt.startOffset, excerpt.endOffset), excerpt.text);
    assert.equal(file.excerpts[0].startLine, 1);
    assert.equal(file.excerpts.at(-1)!.endOffset, long.length);
  });

  it('rejects fabricated paths, wrong quotes, hidden gaps and contradictory review schemas', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(8);
    const input = packet(tarball([{path: 'package/index.js', text}]), 12);
    assert.equal(validateReview(review(input), input, input.caseId).valid, true);
    assert.equal(validateReview({...review(input), verdict: 'malicious'}, input, input.caseId).valid, false);
    assert.equal(validateReview({...review(input), confidence: '1'}, input, input.caseId).valid, false);
    assert.equal(validateReview({...review(input), unexpected: 'injected'}, input, input.caseId).valid, false);
    assert.equal(validateReview(review(input), input, 'different-case').valid, false);
    const quoted = input.files[0].excerpts[0];
    const finding = {kind: 'test', severity: 'high' as const, claim: 'Schema-only test claim.', reasoning: 'Validation checks exact references, not semantic truth.',
      evidence: [{path: input.files[0].path, startOffset: quoted.startOffset, endOffset: quoted.endOffset, quote: quoted.text}]};
    const positive = {...review(input), verdict: 'malicious' as const, findings: [finding]};
    assert.equal(validateReview(positive, input, input.caseId).valid, true);
    assert.equal(validateReview({...positive, verdict: 'benign'}, input, input.caseId).valid, false);
    for (const evidence of [
      {...finding.evidence[0], path: '../../external-file'},
      {...finding.evidence[0], quote: 'x'.repeat(quoted.text.length)},
      {path: input.files[0].path, startOffset: 10, endOffset: 15, quote: text.slice(10, 15)},
    ]) assert.equal(validateReview({...positive, findings: [{...finding, evidence: [evidence]}]}, input, input.caseId).valid, false);
  });

  it('accepts only indexed supplementary ranges and enforces case, count and byte-independent character bounds', () => {
    const archive = tarball([{path: 'package/index.js', text: 'x'.repeat(50000)}]);
    const initial = packet(archive, 100);
    const request: SourceRequest = {schemaVersion: 1, caseId: initial.caseId,
      requests: [{path: 'package/index.js', startOffset: 100, endOffset: 110, reason: 'Inspect an omitted original span.'}]};
    assert.equal(validateSourceRequest(request, initial, initial.caseId).requestedChars, 10);
    assert.throws(() => validateSourceRequest({...request, caseId: 'wrong'}, initial, initial.caseId), /identity/);
    assert.throws(() => validateSourceRequest({...request, requests: Array(5).fill(request.requests[0])}, initial, initial.caseId), /schema/);
    for (const change of [{path: '../index.js'}, {endOffset: 50001}, {endOffset: 24101}, {startOffset: -1}, {startOffset: 1.5}]) {
      assert.throws(() => validateSourceRequest({...request, requests: [{...request.requests[0], ...change}]}, initial, initial.caseId));
    }
    const supplement = collectSourceSupplement(archive, initial, request, initial.caseId);
    assert.equal(supplement.coverage.transmittedChars, 10);
    assert.equal(supplement.coverage.newlyCoveredChars, 10);
    const combined = combineSourceEvidence(initial, supplement);
    assert.equal(combined.files[0].shownChars, initial.files[0].shownChars + 10);
    assert.throws(() => combineSourceEvidence(initial, {...supplement, caseId: 'wrong'}), /mismatch/);
  });

  it('refuses corrupt supplemental archives and conflicting overlapping evidence without changing the initial packet', () => {
    const archive = tarball([{path: 'package/index.js', text: 'const value=1;'}]);
    const initial = packet(archive), snapshot = structuredClone(initial);
    const request: SourceRequest = {schemaVersion: 1, caseId: initial.caseId,
      requests: [{path: 'package/index.js', startOffset: 0, endOffset: 5, reason: 'Recheck original prefix.'}]};
    const supplement = collectSourceSupplement(archive, initial, request, initial.caseId);
    assert.equal(supplement.coverage.newlyCoveredChars, 0);
    supplement.files[0].excerpts[0].text = 'XXXXX';
    assert.throws(() => combineSourceEvidence(initial, supplement), /Conflicting/);
    assert.throws(() => collectSourceSupplement(Buffer.from('invalid gzip'), initial, request, initial.caseId), /complete archive/);
    assert.deepEqual(initial, snapshot);
  });
});
