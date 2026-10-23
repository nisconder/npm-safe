import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CacheManager, DatabaseManager, FindingCategory, NpmSafeEngine, SecurityLevel, Severity,
} from '../src/index.js';
import type { PackageMetadata } from '../src/registry/types.js';

describe('plugin rules and cached reports', () => {
  let dir: string;
  let originalFetch: typeof fetch;
  let requests: number;
  let meta: PackageMetadata;
  const engines = new Set<NpmSafeEngine>();
  const gates: Array<{ key: string; release: () => void }> = [];
  const name = 'plugin-cache-fixture-library';
  const pluginRule = `export const rule = {
    id: 'closure-fixture', name: 'Closure fixture', description: '',
    severity: 'critical', category: 'known-malicious', enabled: true,
    match() { return flag ? [{ ruleId: 'closure-fixture', ruleName: 'Closure fixture',
      severity: 'critical', category: 'known-malicious', message: 'fixture' }] : []; }
  };`;

  const open = (rulesDir: string, db = 'cache.db'): NpmSafeEngine => {
    const engine = new NpmSafeEngine({
      dbPath: path.join(dir, db), rulesDir,
      rulesConfigPath: path.join(dir, 'rules.json'),
      llmConfigPath: path.join(dir, 'llm.json'),
    });
    engines.add(engine);
    return engine;
  };
  const close = (engine: NpmSafeEngine): void => {
    engine.close();
    engines.delete(engine);
  };
  const writePlugin = (folder: string, prefix: string): string => {
    const rulesDir = path.join(dir, folder);
    mkdirSync(rulesDir);
    writeFileSync(path.join(rulesDir, 'fixture.mjs'), `${prefix}\n${pluginRule}`);
    return rulesDir;
  };
  const seedWatchlist = async (): Promise<void> => {
    const database = new DatabaseManager(path.join(dir, 'cache.db'));
    try {
      const cache = new CacheManager(database);
      await cache.setPackage(meta);
      await cache.addToWatchlist(name);
    } finally { database.close(); }
  };
  const readReport = async () => {
    const database = new DatabaseManager(path.join(dir, 'cache.db'));
    try { return await new CacheManager(database).getSecurityReport(name, '1.0.0'); }
    finally { database.close(); }
  };
  const delayedPlugin = () => {
    const key = `npm-safe-plugin-gate-${path.basename(dir)}`;
    let release!: () => void;
    let loaded!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { loaded = resolve; });
    Object.defineProperty(globalThis, key, { value: { wait, loaded }, configurable: true });
    gates.push({ key, release });
    const rulesDir = writePlugin('delayed', `await globalThis[${JSON.stringify(key)}].wait;
      globalThis[${JSON.stringify(key)}].loaded();
      const flag = true;`);
    return { rulesDir, release, ready };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-plugin-cache-'));
    requests = 0;
    originalFetch = globalThis.fetch;
    meta = {
      name, modified: '2026-01-01', 'dist-tags': { latest: '1.0.0' }, readme: '',
      versions: { '1.0.0': { name, version: '1.0.0' } },
    };
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify(meta));
    }) as typeof fetch;
  });
  afterEach(async () => {
    for (const engine of engines) engine.stopAutoRefresh();
    for (const gate of gates) gate.release();
    await nextTurn();
    for (const engine of engines) engine.close();
    engines.clear();
    for (const gate of gates) Reflect.deleteProperty(globalThis, gate.key);
    gates.length = 0;
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-evaluates cached reports across engines when a plugin closure changes', async () => {
    // Only the external constant changes. match.toString() and all rule
    // descriptor fields remain identical, as with a changed imported helper.
    const before = open(writePlugin('before', 'const flag = false;'));
    assert.equal((await before.checkPackage(name)).security.overallLevel, SecurityLevel.Safe);
    close(before);
    const after = open(writePlugin('after', 'const flag = true;'));
    const result = await after.checkPackage(name);
    assert.equal(result.security.overallLevel, SecurityLevel.Dangerous);
    assert.equal(result.security.staticScan?.findings[0]?.ruleId, 'closure-fixture');
    assert.equal(requests, 1, 're-evaluating rules should still reuse fresh metadata');
  });

  it('re-evaluates a runtime rule when its closure changes within one engine', async () => {
    const engine = open(path.join(dir, 'no-plugins'));
    let detected = false;
    engine.registerRule({
      id: 'runtime-closure', name: 'Runtime closure', description: '', enabled: true,
      severity: Severity.Critical, category: FindingCategory.KnownMalicious,
      match: () => detected ? [{
        ruleId: 'runtime-closure', ruleName: 'Runtime closure', severity: Severity.Critical,
        category: FindingCategory.KnownMalicious, message: 'fixture',
      }] : [],
    });
    assert.equal((await engine.checkPackage(name)).security.overallLevel, SecurityLevel.Safe);
    detected = true;
    assert.equal((await engine.checkPackage(name)).security.overallLevel, SecurityLevel.Dangerous);
    assert.equal(requests, 1);
  });

  it('waits for plugin initialization before auto-refresh can persist a report', async () => {
    await seedWatchlist();
    const plugin = delayedPlugin();
    const engine = open(plugin.rulesDir);
    engine.startAutoRefresh(60_000);
    await nextTurn();
    assert.equal(requests, 0, 'auto-refresh must not fetch before configured rules are ready');
    plugin.release();
    await plugin.ready;
    const deadline = Date.now() + 2_000;
    let report = await readReport();
    while (!report && Date.now() < deadline) {
      await delay(10);
      report = await readReport();
    }
    engine.stopAutoRefresh();
    assert.ok(report, 'auto-refresh should persist a report once plugins are ready');
    assert.equal(report.overallLevel, SecurityLevel.Dangerous);
    assert.equal(report.findings[0]?.ruleId, 'closure-fixture');
    assert.equal(requests, 1);
  });

  it('does not restart auto-refresh after stop while plugin initialization is pending', async () => {
    await seedWatchlist();
    const plugin = delayedPlugin();
    const engine = open(plugin.rulesDir);
    engine.startAutoRefresh(60_000);
    engine.stopAutoRefresh();
    plugin.release();
    await plugin.ready;
    await nextTurn();
    assert.equal(requests, 0);
    assert.equal(await readReport(), null);
  });
});
