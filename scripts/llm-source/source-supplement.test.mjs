import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSourceRequest, combineSourceEvidence, sourceLineAt } from './source-supplement.mjs';
import { validateReview } from './review-contract.mjs';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeConfinedExclusive } from './evaluation-io.mjs';

const caseId = 'case-0123456789ab';
const index = { caseId, sourceIndex: [{path:'package/main.js',totalChars:100000},{path:'package/other.js',totalChars:100000}] };
const request = spans => ({schemaVersion:1,caseId,requests:spans.map(([path,startOffset,endOffset])=>({path,startOffset,endOffset,reason:'Need connecting code'}))});
test('supplement requests are indexed ranges with per-file, total and count bounds', () => {
  assert.equal(validateSourceRequest(request([['package/main.js',0,24000],['package/other.js',0,16000]]),index,caseId).requestedChars,40000);
  for (const spans of [[['../secret',0,1]],[['package/main.js',-1,10]],[['package/main.js',0,24001]],
    [['package/main.js',0,13000],['package/main.js',20000,33000]],
    [['package/main.js',0,24000],['package/other.js',0,16001]],
    Array.from({length:5},(_,i)=>['package/main.js',i,i+1])]) assert.throws(()=>validateSourceRequest(request(spans),index,caseId));
  assert.throws(()=>validateSourceRequest({...request([['package/main.js',0,1]]),caseId:'wrong'},index,caseId));
});
test('supplements preserve UTF-16 positions and cannot fill unprovided source gaps', () => {
  const span = (startOffset,text) => ({startOffset,endOffset:startOffset+text.length,startLine:1,endLine:1,text});
  const initial = {caseId,files:[{path:'package/a.js',totalChars:12,excerpts:[span(0,'a😀b'),span(10,'yz')]}]};
  const additional = {caseId,files:[{path:'package/a.js',totalChars:12,excerpts:[span(3,'bcde')]}]};
  const merged = combineSourceEvidence(initial,additional);
  assert.deepEqual(merged.files[0].excerpts.map(e=>[e.startOffset,e.endOffset,e.text]),[[0,7,'a😀bcde'],[10,12,'yz']]);
  assert.equal(merged.files[0].shownChars,9);
  const review = {schemaVersion:1,caseId,verdict:'unknown',confidence:.5,summary:'Inert reference test',limitations:[],findings:[{kind:'fixture',severity:'medium',claim:'Reference only',reasoning:'Synthetic text',evidence:[{path:'package/a.js',startOffset:3,endOffset:7,quote:'bcde'}]}]};
  assert.equal(validateReview(review,merged,caseId).valid,true);
  review.findings[0].evidence[0] = {path:'package/a.js',startOffset:6,endOffset:11,quote:'e???y'};
  assert.equal(validateReview(review,merged,caseId).valid,false);
  assert.throws(()=>combineSourceEvidence(initial,{...additional,caseId:'wrong'}));
  assert.throws(()=>combineSourceEvidence(initial,{caseId,files:[{path:'package/a.js',totalChars:12,excerpts:[span(3,'WRONG')]}]}),/overlap/);
});

test('supplement line numbers handle CRLF interiors and dense bounded source without match arrays', () => {
  const text='😀\r\nx\ry\nz\u2028w\u2029';
  assert.equal(sourceLineAt(text,3),1); assert.equal(sourceLineAt(text,4),2);
  assert.equal(sourceLineAt(text,text.length),6);
  assert.equal(sourceLineAt('\n'.repeat(4*1024*1024),4*1024*1024),4*1024*1024+1);
});
test('supplement writer rejects a child directory redirected outside its run', async t => {
  const base=await mkdtemp(path.join(os.tmpdir(),'npm-safe-round-path-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const run=path.join(base,'run'), outside=path.join(base,'outside');
  await mkdir(run); await mkdir(outside);
  try { await symlink(outside,path.join(run,'supplements'),process.platform==='win32'?'junction':'dir'); }
  catch(error) { if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.skip('Environment does not allow directory links'); return; } throw error; }
  await assert.rejects(writeConfinedExclusive(run,'supplements/case.json','{}'),/escapes/);
});
test('supplement writer rejects ordinary parent traversal before writing', async t => {
  const base=await mkdtemp(path.join(os.tmpdir(),'npm-safe-round-parent-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  await mkdir(path.join(base,'run')); await mkdir(path.join(base,'outside'));
  await assert.rejects(writeConfinedExclusive(path.join(base,'run'),'../outside/case.json','{}'),/escapes/);
});
