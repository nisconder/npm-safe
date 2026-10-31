import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanBrowserContent } from '../src/scanner/browser-signals.js';
import { Severity } from '../src/scanner/types.js';

const addressChecks = String.raw`
const ethereumAddress = /\b0x[a-fA-F0-9]{40}\b/g;
const bitcoinAddress = /\bbc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}\b/g;
`;
const fetchRewrite = `
const savedFetch = fetch;
fetch = async function(input) {
  const response = await savedFetch(input);
  return new Response(transform(await response.text()));
};`;
const xhrPatch = `XMLHttpRequest.prototype.send = function(body) { return savedSend.call(this, body); };`;
const scan = (source: string) => scanBrowserContent(source, 'package/browser.js');

describe('browser interception signals', () => {
  it('reports combined response reconstruction, XHR patching and multiple address formats', () => {
    const findings = scan(addressChecks + fetchRewrite + xhrPatch);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'content-browser-interception');
    assert.equal(findings[0].severity, Severity.Critical);
    assert.equal(findings[0].lineNumber, 6);
    assert.match(findings[0].codeSnippet!, /^fetch = async function/);
  });

  it('recognizes computed XHR member replacements without decoding string tables', () => {
    const source = addressChecks + fetchRewrite + `
      XMLHttpRequest[lookup(12)][lookup(30)] = function(body) { return previous.call(this, body); };
    `;
    assert.equal(scan(source).length, 1);
  });

  it('accepts qualified global fetch and arrow function reconstruction', () => {
    const source = addressChecks + `
      globalThis.fetch = async (input) => { return new globalThis.Response(await oldFetch(input)); };
      window.XMLHttpRequest.prototype.open = function(method, url) { return oldOpen(method, url); };
    `;
    assert.equal(scan(source).length, 1);
  });

  it('does not flag wallet connectors and multiple address validators', () => {
    const source = addressChecks + `
      export async function pay(provider, transaction) {
        if (!ethereumAddress.test(transaction.to)) throw new Error('invalid recipient');
        await window.ethereum.request({ method: 'eth_sendTransaction', params: [transaction] });
        return fetch('/receipt', { method: 'POST', body: JSON.stringify(transaction) });
      }
    `;
    assert.deepEqual(scan(source), []);
  });

  it('does not flag telemetry wrappers that return original responses', () => {
    const source = addressChecks + `
      fetch = async function(input) { const result = await oldFetch(input); trace(result); return result; };
    ` + xhrPatch;
    assert.deepEqual(scan(source), []);
  });

  it('does not flag dual HTTP polyfills without payment address matching', () => {
    assert.deepEqual(scan(fetchRewrite + xhrPatch), []);
  });

  it('requires both interception surfaces and two address format families', () => {
    assert.deepEqual(scan(addressChecks + fetchRewrite), []);
    assert.deepEqual(scan(addressChecks + xhrPatch), []);
    assert.deepEqual(scan(addressChecks.split('const bitcoinAddress')[0] + fetchRewrite + xhrPatch), []);
  });

  it('ignores code examples in comments, strings, templates and regex bodies', () => {
    const example = addressChecks + fetchRewrite + xhrPatch;
    assert.deepEqual(scan(`/* ${example} */`), []);
    assert.deepEqual(scan(`const guide = ${JSON.stringify(example)};`), []);
    assert.deepEqual(scan('const guide = `fetch = function(){ new Response(1) }; XMLHttpRequest.prototype.send = function(){};`;'), []);
    assert.deepEqual(scan(addressChecks + `const text = /fetch=function\(\)\{new Response\(1\)\}/;` + xhrPatch), []);
  });

  it('does not mistake locally declared or parameter-bound fetch functions for global replacement', () => {
    assert.deepEqual(scan(addressChecks + `const fetch = function(input) { return new Response(input); };` + xhrPatch), []);
    assert.deepEqual(scan(addressChecks + `function wrap(fetch) { fetch = function(input) { return new Response(input); }; }` + xhrPatch), []);
    assert.deepEqual(scan(addressChecks + `(fetch) => { fetch = function(input) { return new Response(input); }; };` + xhrPatch), []);
  });

  it('does not match arbitrary object methods named fetch or equality comparisons', () => {
    assert.deepEqual(scan(addressChecks + `client.fetch = function(input) { return new Response(input); };` + xhrPatch), []);
    assert.deepEqual(scan(addressChecks + `fetch === function(input) { return new Response(input); };` + xhrPatch), []);
  });

  it('handles deeply nested unrelated expressions without recursive parsing', () => {
    const nested = `const unrelated = ${'('.repeat(8_000)}1${')'.repeat(8_000)};`;
    assert.equal(scan(nested + addressChecks + fetchRewrite + xhrPatch).length, 1);
  });

  it('does not confuse local browser mocks with global interception', () => {
    const mocks = `function install(window, XMLHttpRequest, Response) {
      window.fetch = async function(input) { return new Response(input); };
      XMLHttpRequest.prototype.send = function(input) {};
    }`;
    assert.deepEqual(scan(addressChecks + mocks), []);
    assert.deepEqual(scan(addressChecks + `const XMLHttpRequest = fakeXHR;` + fetchRewrite + xhrPatch), []);
    assert.deepEqual(scan(addressChecks + `function install(Response) {` + fetchRewrite + xhrPatch + '}'), []);
    assert.deepEqual(scan(addressChecks + `class Harness { install(window, XMLHttpRequest, Response) { window.fetch = async function(input) { return new Response(input); };` + xhrPatch + '} }'), []);
    assert.deepEqual(scan(addressChecks + `const harness = { install(window, XMLHttpRequest, Response) { window.fetch = async function(input) { return new Response(input); };` + xhrPatch + '} };'), []);
  });

  it('keeps unrelated helper parameters from hiding real global assignments', () => {
    assert.equal(scan(addressChecks + `function helper(fetch, window, XMLHttpRequest, Response) { return fetch; }` + fetchRewrite + xhrPatch).length, 1);
    assert.equal(scan(addressChecks + `(fetch) => fetch;` + fetchRewrite + xhrPatch).length, 1);
  });

  it('distinguishes destructured mock bindings from default-value references', () => {
    const body = fetchRewrite + xhrPatch;
    assert.deepEqual(scan(addressChecks + `function install({window, XMLHttpRequest, Response}) { window.fetch = async function(input) { return new Response(input); };` + xhrPatch + '}'), []);
    assert.equal(scan(addressChecks + `function install(value = window) {` + body + '}').length, 1);
  });

  it('does not turn control-flow regular expressions into executable patches', () => {
    const expression = String.raw`/fetch = function(x){new Response(1)}; XMLHttpRequest.prototype.send = function(x){};/`;
    assert.deepEqual(scan(addressChecks + `if (ready) ${expression}.test(text);`), []);
    assert.deepEqual(scan(addressChecks + `const matcher = () => ${expression}.test(text);`), []);
  });
});
