import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeclaration, isReadme, rankSources, signalPositions } from './source-selection.mjs';

const source = (path, text) => ({ path, text, bytes: Buffer.byteLength(text), readme: isReadme(path), manifest: path === 'package/package.json' });
const rank = (files, manifest) => rankSources(files, manifest, files.map(file => file.path));

describe('source evidence prioritization', () => {
  it('retains reachable execution/encoded structures ahead of many ordinary capability files', () => {
    const ordinary = Array.from({ length: 70 }, (_, i) => source(`package/lib/http-${i}.js`,
      'export const network = "fetch https request"; export const files = "readFile process.env"; export const process = "spawn exec";'));
    const structured = source('package/lib/decoder.js', 'const bytes = "' + '\u{E0100}'.repeat(16) + '"; eval("void 0");');
    const files = [source('package/package.json', '{"main":"index.js"}'),
      source('package/index.js', [...ordinary, structured].map(file => `require("./${file.path.slice('package/'.length)}");`).join('\n')),
      ...ordinary, structured];
    const result = rank(files, { main: 'index.js' });
    assert.equal(result.ranked[0].path, 'package/package.json');
    assert.equal(result.ranked[1].path, 'package/index.js');
    assert.equal(result.ranked[2].path, structured.path);
    assert.ok(result.ranked[2].reasons.includes('relative-source-reference'));
    assert.ok(result.ranked[2].reasons.includes('encoded-payload-context'));
    assert.ok(ordinary.every(file => result.ranked.find(item => item.path === file.path).priority < result.ranked[2].priority));
    assert.deepEqual(rank([...files].reverse(), { main: 'index.js' }).ranked, result.ranked);
  });

  it('keeps type entries available but puts runnable evidence before declarations', () => {
    const types = Array.from({ length: 25 }, (_, i) => source(`package/types-${i}.d.ts`, 'export declare function example(): void;'));
    const runtime = Array.from({ length: 4 }, (_, i) => source(`package/runtime-${i}.js`, 'export const sum = (a, b) => a + b;'));
    const manifest = { main: 'index.js', exports: { types: types.map(file => './' + file.path.slice(8)), default: './index.js' } };
    const files = [source('package/index.js', runtime.map(file => `import "./${file.path.slice(8)}";`).join('\n')), ...types, ...runtime];
    const result = rank(files, manifest);
    const firstDeclaration = result.ranked.findIndex(file => file.declaration);
    assert.equal(firstDeclaration, runtime.length + 1);
    assert.ok(result.declaredEntries.includes('package/types-0.d.ts'));
    assert.ok(result.ranked.find(file => file.path === 'package/types-0.d.ts').reasons.includes('type-declaration-context'));
    for (const extension of ['.d.ts', '.d.mts', '.d.cts']) assert.equal(isDeclaration('types' + extension), true);
    assert.equal(isDeclaration('runtime.ts'), false);
  });

  it('provides worker evaluation and stream-transfer anchors without a verdict', () => {
    const text = 'const source = "void 0"; new Worker(source, {"eval": !![]}); body.pipe(request);';
    const signals = signalPositions(text);
    assert.ok(signals.contextKinds.includes('dynamic-worker-context'));
    for (const needle of ['new Worker', '"eval"', '.pipe']) assert.ok(signals.priorityPositions.includes(text.indexOf(needle)));
    assert.equal(Object.hasOwn(signals, 'verdict'), false);
    assert.equal(Object.hasOwn(signals, 'malicious'), false);
    const normalWorker = signalPositions('new Worker(new URL("./worker.js", import.meta.url));');
    assert.ok(normalWorker.contextKinds.includes('worker-context'));
    assert.ok(!normalWorker.contextKinds.includes('dynamic-worker-context'));
  });

  it('preserves original UTF-16 offsets for astral encoded payload spans', () => {
    const prefix = '// 🌐 inert fixture\nconst encoded = "';
    const encoded = '\u{E0100}'.repeat(9);
    const text = prefix + encoded + '";';
    const signals = signalPositions(text);
    assert.ok(signals.contextKinds.includes('encoded-payload-context'));
    assert.ok(signals.priorityPositions.includes(prefix.length));
    assert.ok(signals.priorityPositions.includes(prefix.length + encoded.length - 1));
    assert.equal(text.slice(prefix.length, prefix.length + encoded.length), encoded);
  });

  it('keeps a bounded head and tail of anchors independently of repeat count', () => {
    const text = 'eval("void 0");\n'.repeat(5000);
    const first = signalPositions(text);
    assert.equal(first.priorityPositions.length, 16);
    assert.equal(first.priorityPositions[0], 0);
    assert.equal(first.priorityPositions.at(-1), text.lastIndexOf('eval'));
    assert.ok(first.positions.length <= 80);
    assert.deepEqual(signalPositions(text), first);
  });

  it('resolves side-effect imports and alternative archive roots without escaping the package', () => {
    const files = [source('custom/package.json', '{"main":"index.js"}'),
      source('custom/index.js', 'import "./lib/helper"; require("../outside");'),
      source('custom/lib/helper.ts', 'export const answer = 42;'),
      source('outside.js', 'export const unrelated = true;')];
    const result = rank(files, { main: 'index.js' });
    assert.ok(result.ranked.find(file => file.path === 'custom/lib/helper.ts').reasons.includes('relative-source-reference'));
    assert.ok(!result.ranked.find(file => file.path === 'outside.js').reasons.includes('relative-source-reference'));
  });

  it('selects ordinary source entry points with no structural or rule signal', () => {
    const files = [source('package/b.js', 'export const two = 2;'), source('package/a.js', 'export const one = 1;')];
    const result = rank(files, { main: 'b.js' });
    assert.equal(result.ranked[0].path, 'package/b.js');
    assert.deepEqual(result.ranked[0].contextKinds, []);
    assert.deepEqual(result.ranked[0].priorityPositions, []);
    assert.ok(!Object.hasOwn(result, 'findings'));
  });

  it('resolves a package manifest directly at the archive root', () => {
    const files = [source('package.json', '{"main":"entry.js"}'),
      source('entry.js', 'require("./lib/helper");'), source('lib/helper.js', 'export const value = 1;')];
    const result = rank(files, { main: 'entry.js' });
    assert.deepEqual(result.declaredEntries, ['entry.js']);
    assert.ok(result.ranked.find(file => file.path === 'lib/helper.js').reasons.includes('relative-source-reference'));
  });
});
