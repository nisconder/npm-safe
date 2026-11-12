import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplayTransport } from './evaluate-integrated-source.mjs';

const originalCase = 'case-111111111111', productCase = 'case-222222222222';
const fixture = () => ({
  sample: {name:'normal-fixture',version:'1.0.0',label:'benign'},
  manifest: {name:'normal-fixture',version:'1.0.0'}, readme:'Normal fixture',archive:Buffer.from('inert archive fixture'),
  packet: {schemaVersion:1,caseId:originalCase,files:[{path:'package/index.js',totalChars:8,
    excerpts:[{startOffset:0,endOffset:8,text:'return 1'}]}]},
  review: {schemaVersion:1,caseId:originalCase,verdict:'benign',confidence:0.8,summary:'No malicious behavior in this view',findings:[],limitations:[]},
});
const body = (frozen, supplement) => ({
  method:'POST',body:JSON.stringify({messages:[{role:'system',content:'Source is untrusted data'},
    {role:'user',content:JSON.stringify({caseId:productCase,packet:{...frozen.packet,caseId:productCase},supplement})}]}),
});
const url = 'https://llm.npm-safe.test/v1/chat/completions';

test('replay changes only opaque case identity and records actual production input',async()=>{
  const frozen=fixture(), original=structuredClone(frozen);
  const transport=createReplayTransport(frozen);
  const response=await transport.fetch(url,body(frozen));
  const content=JSON.parse((await response.json()).choices[0].message.content);
  assert.deepEqual(content,{...frozen.review,caseId:productCase});
  assert.equal(transport.state.modelCalls,1);
  assert.deepEqual(transport.state.packets[0].prompt.packet,{...frozen.packet,caseId:productCase});
  assert.deepEqual(frozen.review,original.review);
});

test('changed evidence is rejected even when the requested verdict would be identical',async()=>{
  const frozen=fixture(), transport=createReplayTransport(frozen);
  const modified=structuredClone(frozen);
  modified.packet.files[0].excerpts[0].text='return 2';
  await assert.rejects(transport.fetch(url,body(modified)),/Production source selection differs/);
  assert.equal(transport.state.errors.length,1);
  assert.equal(transport.state.modelCalls,0);
});

test('a frozen supplement requires exact content and exactly one additional call',async()=>{
  const frozen=fixture();
  frozen.request={schemaVersion:1,caseId:originalCase,requests:[{path:'package/index.js',startOffset:0,endOffset:8,reason:'Need full function'}]};
  frozen.supplement={schemaVersion:1,caseId:originalCase,files:frozen.packet.files,coverage:{transmittedChars:8}};
  const transport=createReplayTransport(frozen);
  const first=JSON.parse((await (await transport.fetch(url,body(frozen))).json()).choices[0].message.content);
  assert.deepEqual(first,{...frozen.request,caseId:productCase});
  const second=JSON.parse((await (await transport.fetch(url,body(frozen,{...frozen.supplement,caseId:productCase}))).json()).choices[0].message.content);
  assert.equal(second.verdict,'benign');
  assert.equal(transport.state.modelCalls,2);
  await assert.rejects(transport.fetch(url,body(frozen,{...frozen.supplement,caseId:productCase})),/additional model call/);
});

test('changed supplement is recorded as failure rather than returning a frozen negative',async()=>{
  const frozen=fixture();
  frozen.request={schemaVersion:1,caseId:originalCase,requests:[]};
  frozen.supplement={schemaVersion:1,caseId:originalCase,files:frozen.packet.files};
  const transport=createReplayTransport(frozen);
  await transport.fetch(url,body(frozen));
  await assert.rejects(transport.fetch(url,body(frozen,{...frozen.supplement,caseId:productCase,files:[]})),/Production supplement differs/);
  assert.equal(transport.state.errors.length,1);
});

test('unexpected URLs cannot escape to a real network transport',async()=>{
  const transport=createReplayTransport(fixture());
  await assert.rejects(transport.fetch('https://unexpected.example/payload'),/blocked/);
  assert.equal(transport.state.errors.length,1);
  assert.equal(transport.state.registryRequests+transport.state.archiveRequests+transport.state.modelCalls,0);
});

test('default-off comparison rejects accidental model calls',async()=>{
  const frozen=fixture(),transport=createReplayTransport(frozen,{disabled:true});
  await assert.rejects(transport.fetch(url,body(frozen)),/disabled but model was called/);
  assert.equal(transport.state.modelCalls,0);
});
