import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { excerptsFor } from './source-excerpts.mjs';
import { collectSourceBundle } from './source-bundle.mjs';

function tarball(entries) {
  const chunks = [];
  for (const [path, source] of entries) {
    const data = Buffer.from(source), header = Buffer.alloc(512);
    header.write(path, 0, 100); header.write('0000644\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function checkSpans(source, result, expected) {
  let previousEnd = -1, shown = 0;
  for (const span of result.excerpts) {
    assert.ok(span.startOffset > previousEnd);
    assert.ok(span.endOffset > span.startOffset);
    assert.equal(span.text, source.slice(span.startOffset, span.endOffset));
    assert.equal(span.text.length, span.endOffset - span.startOffset);
    previousEnd = span.endOffset;
    shown += span.text.length;
  }
  assert.equal(shown, expected);
}

test('overlapping signal windows spend the unique-character budget exactly', () => {
  const source = '0123456789'.repeat(1000);
  const positions = [1, 2, 3000, 3001, 3002, 3003, 8000, 8001, 9999];
  for (const budget of [0, 1, 2, 3, 7, 59, 800, 4000, 9999, 10000, 20000]) {
    checkSpans(source, excerptsFor(source, budget, positions, [3001, 3002]), Math.min(budget, source.length));
  }
});

test('high-information positions survive many ordinary signals with surrounding context', () => {
  const prefix = 'ordinary();\n'.repeat(600);
  const statement = 'const worker = new Worker(sourceText, { eval: true });';
  const source = prefix + statement + '\n' + 'ordinary();\n'.repeat(600);
  const ordinary = Array.from({length: 200}, (_, index) => index * 50);
  const result = excerptsFor(source, 1200, ordinary, [prefix.length]);
  checkSpans(source, result, 1200);
  assert.ok(result.excerpts.some(span => span.text.includes(statement)));
  assert.equal(result.excerpts[0].startOffset, 0);
  assert.equal(result.excerpts.at(-1).endOffset, source.length);
});

test('budget refill preserves original UTF-16 offsets and mixed-newline line positions', () => {
  const source = 'head\r\n' + '😀\u2028'.repeat(200) + 'target();\n' + 'tail\r'.repeat(200);
  const target = source.indexOf('target();');
  const result = excerptsFor(source, 300, [target - 1, target, target + 1], [target]);
  checkSpans(source, result, 300);
  assert.ok(result.excerpts.some(span => span.startOffset <= target && span.endOffset >= target + 9));
  for (const span of result.excerpts) {
    const before = source.slice(0, span.startOffset);
    assert.equal(span.startLine, 1 + (before.match(/\r\n|[\r\n\u2028\u2029]/g) ?? []).length);
  }
});

test('short-file unused shares complete an earlier entry when total demand fits', () => {
  const main = 'const value = 1;\n'.repeat(280);
  const manifest = { main: 'main.js' };
  const entries = [['package/package.json', JSON.stringify(manifest)], ['package/main.js', main],
    ...Array.from({length: 14}, (_, index) => [`package/helper-${index}.js`, 'export const value = 1;'])];
  const bundle = collectSourceBundle(tarball(entries), manifest);
  const entry = bundle.files.find(file => file.path === 'package/main.js');
  assert.equal(entry.complete, true);
  assert.equal(entry.excerpts.length, 1);
  assert.equal(entry.excerpts[0].text, main);
  assert.equal(bundle.coverage.shownChars, entries.reduce((sum, [, text]) => sum + text.length, 0));
  assert.equal(bundle.coverage.sourceCoverage, 'complete');
});

test('mixed size files fill the total budget without exceeding individual or documentation caps', () => {
  const manifest = { main: 'main.js' };
  const entries = [['package/package.json', JSON.stringify(manifest)], ['package/readme.md', 'Documentation. '.repeat(500)],
    ['package/main.js', 'ordinary();'.repeat(2000)],
    ...Array.from({length: 10}, (_, index) => [`package/source-${index}.js`, 'ordinary();'.repeat(index < 2 ? 10 : 2000)])];
  const bundle = collectSourceBundle(tarball(entries), manifest);
  assert.equal(bundle.coverage.shownChars, 40000);
  assert.equal(bundle.coverage.allocatedChars, 40000);
  assert.equal(bundle.coverage.sourceCoverage, 'partial');
  for (const file of bundle.files) {
    const maximum = file.path.endsWith('readme.md') ? 1200 : file.path.endsWith('package.json') ? 2000 : 8000;
    assert.ok(file.shownChars <= maximum);
    const source = entries.find(([path]) => path === file.path)[1];
    checkSpans(source, file, file.shownChars);
  }
});

test('small total budgets preserve limits and record unshown files as omissions', () => {
  const archive = tarball(Array.from({length: 12}, (_, index) => [`package/source-${index}.js`, 'ordinary();'.repeat(20)]));
  for (const budget of [0, 1, 5, 17]) {
    const bundle = collectSourceBundle(archive, {}, {maxSourceChars: budget});
    assert.equal(bundle.coverage.shownChars, budget);
    assert.equal(bundle.coverage.allocatedChars, budget);
    assert.equal(bundle.coverage.sourceCoverage, 'partial');
    assert.equal(bundle.files.length + bundle.coverage.omittedCount, 12);
  }
});

test('bounded source index retains selected files and exposes only decoded candidates', () => {
  const entries = Array.from({length: 80}, (_, index) => [`package/source-${index}.js`, 'ordinary();']);
  entries.push(['package/readme.md', 'Documentation.'], ['package/native.node', 'binary'], ['package/too-large.js', 'x'.repeat(201)]);
  const bundle = collectSourceBundle(tarball(entries), {}, {maxFiles: 2, maxFileBytes: 200});
  assert.equal(bundle.sourceIndex.length, 64);
  assert.equal(bundle.sourceIndexTruncated, true);
  for (const file of bundle.files) assert.ok(bundle.sourceIndex.some(entry => entry.path === file.path && entry.shownChars === file.shownChars));
  assert.ok(!bundle.sourceIndex.some(entry => entry.path.endsWith('native.node') || entry.path.endsWith('too-large.js')));
  assert.ok(bundle.sourceIndex.some(entry => entry.shownChars === 0));
  for (const entry of bundle.sourceIndex) assert.deepEqual(Object.keys(entry).sort(), ['path', 'selectionReasons', 'shownChars', 'totalChars']);
});

test('a declaration entry cannot consume the decode budget before the runtime entry', () => {
  const runtime = 'export const ready = true;'.repeat(3);
  const manifest = {exports: {types: './a.d.ts', default: './z.js'}};
  const bundle = collectSourceBundle(tarball([['package/a.d.ts', ' '.repeat(180)], ['package/z.js', runtime]]), manifest, {maxTextBytes: 200});
  assert.equal(bundle.files.find(file => file.path === 'package/z.js').excerpts[0].text, runtime);
  assert.ok(!bundle.sourceIndex.some(file => file.path === 'package/a.d.ts'));
  assert.equal(bundle.coverage.sourceCoverage, 'partial');
});
