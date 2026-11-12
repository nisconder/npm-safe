#!/usr/bin/env node
/** Offline product-path replay. Frozen responses are NOT new model inference. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDataset } from './evaluate-scanner.mjs';
import { readArtifact, readBounded, readConfined } from './llm-source/evaluation-io.mjs';
import { summarizeReviews } from './llm-source/review-contract.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const MAX_PACKET = 512 * 1024, MAX_REVIEW = 256 * 1024;
const API_URL = 'https://llm.npm-safe.test/v1/chat/completions';
const REGISTRY = 'https://registry.npmjs.org';
const rebind = (object, caseId) => ({ ...structuredClone(object), caseId });

/** Historical source hashes deliberately need not match the evolving product. */
export async function readReplayRun(directory, reference) {
  const receipt = json(await readConfined(directory, 'receipt.json', 16384));
  const privateBytes = await readConfined(directory, 'private-run.json', 32 * 1024 * 1024);
  const protocolBytes = await readConfined(directory, 'protocol.json', 1024 * 1024);
  assert.equal(sha256(privateBytes), receipt.privateRunSha256, 'Frozen private record changed');
  assert.equal(sha256(protocolBytes), receipt.protocolSha256, 'Frozen protocol changed');
  const run = json(privateBytes), protocol = json(protocolBytes);
  assert.deepEqual(run.protocol, protocol);
  assert.equal(protocol.datasetSha256, receipt.datasetSha256);
  assert.equal(run.dataset.sha256, receipt.datasetSha256);
  const cohort = ['fresh', 'regression'].find(key => reference[key]?.dataset.sha256 === receipt.datasetSha256);
  if (!cohort) throw new Error('No matching frozen reference cohort');
  assert.deepEqual(reference[cohort].protocol, protocol, 'Protocol differs from published reference');
  if (typeof run.artifactDirectory !== 'string') throw new Error('Missing original artifact location');
  const artifactDirectory = path.resolve(directory, run.artifactDirectory);
  const datasetBytes = await readBounded(path.join(artifactDirectory,'dataset.json'),16*1024*1024);
  assert.equal(sha256(datasetBytes),receipt.datasetSha256,'Original dataset changed');
  const dataset = json(datasetBytes);
  validateDataset(dataset);
  assert.deepEqual(dataset.samples,run.dataset.samples);
  return { directory, run, cohort, reference: reference[cohort],
    artifactDirectory,
    identity: { cohort, privateRunSha256: receipt.privateRunSha256, protocolSha256: receipt.protocolSha256,
      datasetSha256: receipt.datasetSha256 } };
}

export async function readReplayCase(input, entry) {
  if (!/^case-[a-f0-9]{12}$/.test(entry.caseId)) throw new Error('Invalid original case ID');
  if (entry.status !== 'prepared') throw new Error(entry.error ?? 'Original preparation failed');
  const original = input.reference.rows.find(row => row.caseId === entry.caseId);
  if (!original || original.sampleId !== entry.sampleId || original.model.status !== 'complete') throw new Error('No complete frozen review for this case');
  const sample = input.run.dataset.samples.find(sample => sample.id === entry.sampleId);
  if (!sample) throw new Error('Case not found in original dataset');
  const manifest = json(await readArtifact(input.artifactDirectory, sample.artifacts.manifest, 8 * 1024 * 1024));
  const readme = (await readArtifact(input.artifactDirectory, sample.artifacts.readme, 8 * 1024 * 1024)).toString('utf8');
  const archive = await readArtifact(input.artifactDirectory, sample.artifacts.tarball, 20 * 1024 * 1024);
  assert.equal(manifest.name, sample.name); assert.equal(manifest.version, sample.version);
  const packetBytes = await readConfined(input.directory, `cases/${entry.caseId}.json`, MAX_PACKET);
  assert.equal(sha256(packetBytes), entry.packetSha256, 'Frozen source packet changed');
  assert.equal(entry.packetSha256, original.packetSha256);
  const reviewBytes = await readConfined(input.directory, `reviews/${entry.caseId}.json`, MAX_REVIEW);
  assert.equal(sha256(reviewBytes), original.reviewSha256, 'Frozen model response changed');
  const packet = json(packetBytes), review = json(reviewBytes);
  assert.equal(packet.caseId, entry.caseId); assert.equal(review.caseId, entry.caseId);
  const frozen = { sample, manifest, readme, archive, packet, review,
    reviewSha256: sha256(reviewBytes), packetSha256: entry.packetSha256 };
  if (original.supplement?.status === 'complete') {
    const receipt = json(await readConfined(input.directory, `supplement-receipts/${entry.caseId}.json`, 16384));
    const requestBytes = await readConfined(input.directory, `request-captures/${entry.caseId}.json`, 16384);
    const submitted = await readConfined(input.directory, `requests/${entry.caseId}.json`, 16384);
    const supplementBytes = await readConfined(input.directory, `supplements/${entry.caseId}.json`, MAX_PACKET);
    assert.equal(sha256(requestBytes), original.supplement.requestSha256);
    assert.equal(sha256(submitted), original.supplement.requestSha256);
    assert.equal(sha256(supplementBytes), original.supplement.packetSha256);
    assert.equal(receipt.requestSha256, original.supplement.requestSha256);
    assert.equal(receipt.packetSha256, original.supplement.packetSha256);
    assert.equal(receipt.initialPacketSha256, entry.packetSha256);
    const supplement = json(supplementBytes);
    const { initialPacketSha256, requestSha256, ...runtimeSupplement } = supplement;
    assert.equal(initialPacketSha256, entry.packetSha256);
    assert.equal(requestSha256, sha256(requestBytes));
    Object.assign(frozen, { request: json(requestBytes), supplement: runtimeSupplement,
      requestSha256: sha256(requestBytes), supplementSha256: sha256(supplementBytes) });
  } else if (original.supplement?.status !== 'not-requested') {
    throw new Error('Incomplete historical supplement cannot be replayed as a negative');
  }
  return frozen;
}

/** No fallback to real fetch: every unexpected URL/request is a hard failure. */
export function createReplayTransport(frozen, options = {}) {
  const manifest = { ...frozen.manifest, dist: { ...frozen.manifest.dist,
    tarball: `${REGISTRY}/-/offline-artifact/${sha256(frozen.archive)}.tgz` } };
  const metadata = { name: manifest.name, description: manifest.description ?? '', readme: frozen.readme,
    modified: '2026-11-12T00:00:00.000Z', 'dist-tags': { latest: manifest.version },
    versions: { [manifest.version]: manifest } };
  const state = { registryRequests: 0, archiveRequests: 0, modelCalls: 0, packets: [], errors: [] };
  const fetch = async (input, init = {}) => {
    try {
      const url = String(input);
      if (url === manifest.dist.tarball) {
        state.archiveRequests++;
        return new Response(frozen.archive, { headers: { 'content-length': String(frozen.archive.length) } });
      }
      if (url === `${REGISTRY}/${manifest.name.startsWith('@') ? '@' + encodeURIComponent(manifest.name.slice(1)) : encodeURIComponent(manifest.name)}` ||
          url === `${REGISTRY}/${encodeURIComponent(manifest.name)}`) {
        state.registryRequests++;
        return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
      }
      if (url !== API_URL) throw new Error('Unexpected network request was blocked');
      if (options.disabled) throw new Error('Source review disabled but model was called');
      const body = JSON.parse(init.body);
      assert.equal(body.messages?.length, 2, 'Expected dedicated source system/user messages');
      assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
      assert.equal(typeof body.messages[0].content, 'string');
      const inputPacket = JSON.parse(body.messages[1].content);
      const caseId = inputPacket.caseId;
      assert.match(caseId, /^case-[a-f0-9]{12}$/);
      assert.deepEqual(inputPacket.packet, rebind(frozen.packet, caseId), 'Production source selection differs from frozen evidence');
      state.modelCalls++;
      if (state.modelCalls > (frozen.request ? 2 : 1)) throw new Error('Unexpected additional model call');
      if (state.modelCalls === 1) {
        assert.equal(inputPacket.supplement, undefined);
      } else {
        assert.deepEqual(inputPacket.supplement, rebind(frozen.supplement, caseId), 'Production supplement differs from frozen evidence');
      }
      state.packets.push({ caseId, systemPrompt: body.messages[0].content, prompt: inputPacket });
      const response = frozen.request && state.modelCalls === 1 ? frozen.request : frozen.review;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rebind(response, caseId)) } }] }),
        { headers: { 'content-type': 'application/json' } });
    } catch (error) {
      // Engine error handling must not conceal an invalid replay from accounting.
      state.errors.push(error.message);
      throw error;
    }
  };
  return { fetch, state };
}

export async function loadProductionEngine() {
  const core = path.join(repository, 'packages/core');
  const require = createRequire(path.join(core, 'package.json'));
  const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  register();
  return (await import(pathToFileURL(path.join(core, 'src/index.ts')).href)).NpmSafeEngine;
}

/** Start new session reviews from actual production prompts, without old verdicts. */
export async function prepareReviewInbox(runDirectories, packetDirectory, sampleIds, directory) {
  const reference=json(await readBounded(path.join(repository,'docs/evaluation/source-llm-v2-2026-11-12.results.json'),32*1024*1024));
  const wanted=new Set(sampleIds), cases=[];
  for(const runDirectory of runDirectories){
    const input=await readReplayRun(path.resolve(runDirectory),reference);
    for(const entry of input.run.cases){
      if(!wanted.has(entry.sampleId))continue;
      const frozen=await readReplayCase(input,entry),caseId='case-'+sha256(frozen.archive).slice(0,12);
      const packetBytes=await readConfined(packetDirectory,`${caseId}.1.json`,1024*1024),packet=json(packetBytes);
      assert.deepEqual(packet.prompt.packet,rebind(frozen.packet,caseId));
      cases.push({caseId,sampleId:entry.sampleId,cohort:input.cohort,name:entry.name,version:entry.version,label:entry.label,
        originalCaseId:entry.caseId,runDirectory:path.relative(directory,path.resolve(runDirectory)),packetSha256:sha256(packetBytes),packetBytes});
    }
  }
  assert.equal(cases.length,wanted.size,'Selection did not identify each requested case exactly once');
  await mkdir(directory,{recursive:false});
  for(const name of ['cases','reviews','requests','attempts','captures','supplements','receipts'])await mkdir(path.join(directory,name));
  for(const entry of cases)await writeFile(path.join(directory,'cases',`${entry.caseId}.json`),entry.packetBytes,{flag:'wx'});
  const privateRecord={schemaVersion:1,createdAt:new Date().toISOString(),
    interpretation:'Previously observed packages, newly reviewed in isolated sessions using actual production source prompts. Not an unseen-package or paid API accuracy benchmark.',
    cases:cases.map(({packetBytes,...entry})=>entry)};
  await save(path.join(directory,'private.json'),privateRecord);
  await save(path.join(directory,'receipt.json'),{privateSha256:sha256(await readFile(path.join(directory,'private.json')))});
  return privateRecord;
}

async function readInbox(directory){
  const receipt=json(await readConfined(directory,'receipt.json',16384));
  const bytes=await readConfined(directory,'private.json',1024*1024);
  assert.equal(sha256(bytes),receipt.privateSha256,'New-review selection changed');
  return json(bytes);
}

/** Serve only one requested batch, with production limits and archived source. */
export async function serveReviewSupplement(directory,caseId){
  if(!/^case-[a-f0-9]{12}$/.test(caseId))throw new Error('Invalid case ID');
  const inbox=await readInbox(directory),entry=inbox.cases.find(row=>row.caseId===caseId);
  if(!entry)throw new Error('Case is not in new-review inbox');
  const packetBytes=await readConfined(directory,`cases/${caseId}.json`,1024*1024);
  assert.equal(sha256(packetBytes),entry.packetSha256);
  const attempt={caseId,createdAt:new Date().toISOString(),packetSha256:entry.packetSha256};
  await save(path.join(directory,'attempts',`${caseId}.json`),attempt);
  try{
    const requestBytes=await readConfined(directory,`requests/${caseId}.json`,16384);
    await writeFile(path.join(directory,'captures',`${caseId}.json`),requestBytes,{flag:'wx'});
    const reference=json(await readBounded(path.join(repository,'docs/evaluation/source-llm-v2-2026-11-12.results.json'),32*1024*1024));
    const input=await readReplayRun(path.resolve(directory,entry.runDirectory),reference);
    const frozen=await readReplayCase(input,input.run.cases.find(row=>row.caseId===entry.originalCaseId));
    await loadProductionEngine();
    const {collectSourceSupplement}=await import(pathToFileURL(path.join(repository,'packages/core/src/llm/source/source-supplement.ts')).href);
    const supplement=collectSourceSupplement(frozen.archive,json(packetBytes).prompt.packet,json(requestBytes),caseId);
    const supplementBytes=Buffer.from(JSON.stringify(supplement,null,2)+'\n');
    if(supplementBytes.length>MAX_PACKET)throw new Error('Supplement packet budget exceeded');
    await writeFile(path.join(directory,'supplements',`${caseId}.json`),supplementBytes,{flag:'wx'});
    Object.assign(attempt,{status:'complete',requestSha256:sha256(requestBytes),supplementSha256:sha256(supplementBytes)});
  }catch(error){Object.assign(attempt,{status:'failed',error:error.message});}
  await save(path.join(directory,'receipts',`${caseId}.json`),attempt);
  return attempt;
}

async function applyInboxReview(frozen,directory,entry){
  const caseId=entry.caseId,packetBytes=await readConfined(directory,`cases/${caseId}.json`,1024*1024);
  assert.equal(sha256(packetBytes),entry.packetSha256);
  assert.deepEqual(json(packetBytes).prompt.packet,rebind(frozen.packet,caseId));
  const reviewBytes=await readConfined(directory,`reviews/${caseId}.json`,MAX_REVIEW);
  const review=json(reviewBytes); assert.equal(review.caseId,caseId);
  const next={...frozen,review,reviewSha256:sha256(reviewBytes),request:undefined,supplement:undefined,requestSha256:undefined,supplementSha256:undefined};
  let requestBytes;
  try{requestBytes=await readConfined(directory,`requests/${caseId}.json`,16384);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(requestBytes){
    const receipt=json(await readConfined(directory,`receipts/${caseId}.json`,16384));
    if(receipt.status!=='complete')throw new Error('New source supplement failed or is pending');
    assert.equal(receipt.requestSha256,sha256(requestBytes));
    const captured=await readConfined(directory,`captures/${caseId}.json`,16384);
    assert.equal(sha256(captured),sha256(requestBytes));
    const supplementBytes=await readConfined(directory,`supplements/${caseId}.json`,MAX_PACKET);
    assert.equal(sha256(supplementBytes),receipt.supplementSha256);
    const {collectSourceSupplement}=await import(pathToFileURL(path.join(repository,'packages/core/src/llm/source/source-supplement.ts')).href);
    const expected=collectSourceSupplement(frozen.archive,rebind(frozen.packet,caseId),json(requestBytes),caseId);
    assert.deepEqual(json(supplementBytes),expected);
    Object.assign(next,{request:json(requestBytes),supplement:expected,requestSha256:sha256(requestBytes),supplementSha256:sha256(supplementBytes)});
  }else{
    // Removing a pending or failed request must never turn a case into a clean negative.
    try{await readConfined(directory,`attempts/${caseId}.json`,16384);throw new Error('Supplement attempt exists without submitted request');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return next;
}

async function sourceIdentity() {
  const files = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.ts')) files[path.relative(repository,file).replaceAll('\\','/')] = sha256(await readFile(file));
    }
  }
  await visit(path.join(repository, 'packages/core/src'));
  for(const file of ['scripts/evaluate-integrated-source.mjs','scripts/evaluate-scanner.mjs',
    'scripts/llm-source/evaluation-io.mjs','scripts/llm-source/review-contract.mjs'])
    files[file]=sha256(await readFile(path.join(repository,file)));
  return { sourceFiles: files, fingerprint: sha256(JSON.stringify(files)) };
}

export async function replayCase(frozen, Engine, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'npm-safe-source-replay-'));
  const originalFetch = globalThis.fetch;
  let engine;
  const transport = createReplayTransport(frozen, options);
  try {
    globalThis.fetch = transport.fetch;
    engine = new Engine({ dbPath: path.join(dir, 'cache.db'), rulesConfigPath: path.join(dir,'rules.json'),
      llmConfigPath: path.join(dir,'llm.json'), rulesDir:path.join(dir,'plugins'), proxy:'', registryUrl:REGISTRY,
      ...(options.disabled ? {} : { sourceReview: true,
        llm:{apiKey:'offline-fixture-key',baseUrl:'https://llm.npm-safe.test/v1',model:'frozen-v2-replay'} }) });
    const result = await engine.checkPackage(frozen.sample.name, { deep:true, version:frozen.sample.version });
    assert.deepEqual(transport.state.errors, [], 'Offline transport validation failed');
    assert.equal(result.exists,true);
    assert.equal(result.security.staticScan.contentScan.status,'complete');
    assert.equal(transport.state.archiveRequests,1,'Static/source scans must share one downloaded archive');
    assert.equal(transport.state.modelCalls, options.disabled ? 0 : frozen.request ? 2 : 1);
    if (options.disabled) assert.equal(result.security.sourceReview,undefined);
    else {
      const source = result.security.sourceReview;
      assert.equal(source?.status,'complete',source?.reason);
      assert.equal(source.verdict,frozen.review.verdict);
      assert.deepEqual(source.review,rebind(frozen.review,source.review.caseId));
      assert.equal(source.archiveSha256,sha256(frozen.archive));
    }
    return { result, transport:transport.state };
  } finally {
    engine?.close(); globalThis.fetch = originalFetch;
    // Only the exact temp directory created above is removed; no archive was extracted.
    await rm(dir,{recursive:true,force:true});
  }
}

export async function evaluateIntegratedSource(runDirectories, options = {}) {
  const referencePath = options.reference ?? path.join(repository,'docs/evaluation/source-llm-v2-2026-11-12.results.json');
  const referenceBytes = await readBounded(referencePath,32*1024*1024), reference=json(referenceBytes);
  const identity=await sourceIdentity(), Engine=await loadProductionEngine();
  const inbox=options.reviewInbox?await readInbox(options.reviewInbox):undefined;
  if (options.packets) await mkdir(options.packets,{recursive:false});
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),mode:'frozen-response-product-replay',
    interpretation:'All cases were previously observed. This replays frozen session judgments through the production engine/provider; it is not a new model inference run, blind accuracy estimate or paid API benchmark.',
    runtime:{node:process.version,platform:process.platform,arch:process.arch},source:identity,
    referenceSha256:sha256(referenceBytes),inputs:[],rows:[],transport:{registryRequests:0,archiveRequests:0,modelCalls:0},
    notes:['All network requests are intercepted without fallback; package code and payloads are never executed.',
      'The fixture changes only manifest dist.tarball to a same-origin offline route; package archive bytes and evidence remain unchanged.',
      'A replay succeeds only if the product sends the exact frozen source evidence and supplement, aside from the opaque case ID.',
      'Quoted evidence remains validated by the production contract; matching quotes do not prove sound reasoning or runtime behavior.']};
  if(inbox){report.mode='new-session-review-product-validation';report.interpretation=inbox.interpretation;
    report.notes.push('New isolated-session responses are passed through the production engine/provider with a local transport. No paid API call, exact model identifier, tokens or monetary cost is available.');}
  const seen=new Set();
  for(const directory of runDirectories){
    const input=await readReplayRun(path.resolve(directory),reference);
    report.inputs.push(input.identity);
    for(const entry of input.run.cases){
      const inboxEntry=inbox?.cases.find(row=>row.sampleId===entry.sampleId&&row.originalCaseId===entry.caseId);
      if(inbox&&!inboxEntry)continue;
      const coordinate=`${entry.name}@${entry.version}`;
      if(seen.has(coordinate))throw new Error('Duplicate package version in replay input');
      seen.add(coordinate);
      const row={cohort:input.cohort,id:entry.sampleId,name:entry.name,version:entry.version,label:entry.label,
        replayStatus:'failed',rule:{status:'failed',positive:false},model:{status:'failed',verdict:'unknown'}};
      try {
        let frozen=await readReplayCase(input,entry);
        if(inboxEntry)frozen=await applyInboxReview(frozen,options.reviewInbox,inboxEntry);
        const disabled=await replayCase(frozen,Engine,{disabled:true});
        const {result,transport}=await replayCase(frozen,Engine);
        const rule=result.security.staticScan, model=result.security.sourceReview;
        assert.equal(rule.score,disabled.result.security.staticScan.score,'Optional review changed the static score');
        assert.equal(rule.overallLevel,disabled.result.security.staticScan.overallLevel);
        assert.deepEqual(rule.findings,disabled.result.security.staticScan.findings,'Optional review changed static findings');
        Object.assign(row,{replayStatus:'complete',archiveSha256:sha256(frozen.archive),
          frozenPacketSha256:frozen.packetSha256,frozenReviewSha256:frozen.reviewSha256,
          frozenRequestSha256:frozen.requestSha256,frozenSupplementSha256:frozen.supplementSha256,
          rule:{status:rule.contentScan.status,positive:rule.findings.some(f=>['high','critical'].includes(f.severity)),
            score:rule.score,level:rule.overallLevel,findings:rule.findings.map(({ruleId,severity})=>({ruleId,severity}))},
          model:{status:model.status,verdict:model.verdict,findings:model.findings.map(({ruleId,severity,filePath,lineNumber})=>({ruleId,severity,filePath,lineNumber})),
            coverage:model.coverage,calls:model.calls,initialChars:model.initialChars,supplementChars:model.supplementChars,
            newlyCoveredChars:model.newlyCoveredChars,sourceCharsSent:model.sourceCharsSent,promptCharsSent:model.promptCharsSent},
          disabled:{level:disabled.result.security.overallLevel,score:disabled.result.security.overallScore,
            registryRequests:disabled.transport.registryRequests,archiveRequests:disabled.transport.archiveRequests,modelCalls:disabled.transport.modelCalls},
          product:{level:result.security.overallLevel,score:result.security.overallScore},
          requests:{registry:transport.registryRequests,archive:transport.archiveRequests,model:transport.modelCalls}});
        for(const key of Object.keys(report.transport))report.transport[key]+=transport[key];
        if(options.packets)for(const [index,packet] of transport.packets.entries())
          await save(path.join(options.packets,`${packet.caseId}.${index+1}.json`),packet);
        if(options.onProgress)options.onProgress({id:row.id,status:row.replayStatus,verdict:row.model.verdict});
      } catch(error){row.error=error.message;if(options.onProgress)options.onProgress({id:row.id,status:'failed',error:row.error});}
      report.rows.push(row);
    }
  }
  report.summary=summarizeReviews(report.rows);
  report.cohorts=Object.fromEntries([...new Set(report.rows.map(row=>row.cohort))].map(cohort=>[cohort,summarizeReviews(report.rows.filter(row=>row.cohort===cohort))]));
  report.failures=report.rows.filter(row=>row.replayStatus!=='complete').length;
  if(inbox)assert.equal(report.rows.length,inbox.cases.length,'Every selected new review must remain in the denominator');
  for(const [file,hash]of Object.entries(identity.sourceFiles))assert.equal(sha256(await readFile(path.join(repository,file))),hash,`Production source changed during replay: ${file}`);
  return report;
}

async function main(){
  const args=process.argv.slice(2), command=args.shift();
  const outputAt=args.indexOf('--output'), packetsAt=args.indexOf('--packets');
  if(command!=='replay'||outputAt<1||!args[outputAt+1]|| (packetsAt!==-1&&(packetsAt!==outputAt+2||!args[packetsAt+1])) || args.length!==(packetsAt===-1?outputAt+2:packetsAt+2))
    throw new Error('Usage: evaluate-integrated-source.mjs replay RUN_DIRECTORY [RUN_DIRECTORY...] --output NEW_REPORT.json [--packets NEW_LOCAL_DIRECTORY]');
  const report=await evaluateIntegratedSource(args.slice(0,outputAt),{packets:packetsAt===-1?undefined:path.resolve(args[packetsAt+1]),onProgress:value=>console.log(JSON.stringify(value))});
  await save(path.resolve(args[outputAt+1]),report);
  console.log(JSON.stringify({output:args[outputAt+1],failures:report.failures,summary:report.summary},null,2));
  if(report.failures)process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
