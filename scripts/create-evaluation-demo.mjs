#!/usr/bin/env node
/** Generate inert synthetic archives. Source strings are never imported or run. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function archive(files) {
  const blocks = [];
  for (const [filename, contents] of Object.entries(files)) {
    const data = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(filename, 0, 100);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    }
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    header.write(`${header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export async function createEvaluationDemo(directory) {
  await mkdir(directory); // Refuse to overwrite an existing corpus.
  const samples = [];
  for (const [index, id] of ['alpha-control', 'beta-control', 'gamma-signal', 'delta-signal'].entries()) {
    const name = `synthetic-eval-${id}`;
    const manifest = { name, version: '1.0.0', description: 'Synthetic workflow fixture; never a published npm package.' };
    // The constructed alert uses an encoded payload consisting only of `void 0;`.
    // Even that harmless payload is never executed by corpus generation or evaluation.
    const payload = Buffer.from('void 0;'.repeat(40 + index)).toString('base64');
    const source = index < 2 ? `export const value = ${index + 40};\n`
      : `const payload = "${payload}";\neval(Buffer.from(payload, "base64").toString());\n`;
    const tarball = archive({ 'package/package.json': JSON.stringify(manifest), 'package/index.js': source });
    const readme = `# ${name}\nSynthetic demonstration only. Package source is data and must not be run.\n`;
    manifest.dist = { tarball: `https://example.invalid/${name}.tgz`,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` };
    const contents = { manifest: Buffer.from(JSON.stringify(manifest)), readme: Buffer.from(readme), tarball };
    const artifacts = {};
    for (const [kind, bytes] of Object.entries(contents)) {
      const filename = `${id}.${kind === 'tarball' ? 'tgz' : kind === 'manifest' ? 'json' : 'md'}`;
      await writeFile(path.join(directory, filename), bytes, { flag: 'wx' });
      artifacts[kind] = { path: filename, sha256: hash(bytes) };
    }
    samples.push({ id, name, version: '1.0.0', family: id, split: 'dev',
      label: index < 2 ? 'benign' : 'malicious',
      provenance: { sourceUrl: 'https://github.com/nisconder/npm-safe/blob/main/scripts/create-evaluation-demo.mjs',
        capturedAt: '2026-11-07T00:00:00Z',
        labelEvidence: index < 2 ? 'Synthetic inert negative control, not independently reviewed real-world benign software.'
          : 'Synthetic alert-positive fixture; schema label malicious denotes the constructed encoded-execution signal. Payload is only void 0, not real malware.' }, artifacts });
  }
  const dataset = { schemaVersion: 1, id: 'synthetic-split-workflow-v1', kind: 'synthetic', samples };
  await writeFile(path.join(directory, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
  return dataset;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/create-evaluation-demo.mjs NEW_DIRECTORY'); process.exitCode = 1; }
  else createEvaluationDemo(path.resolve(process.argv[2])).then(() => console.log('Created synthetic workflow corpus; not real-world accuracy evidence.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
