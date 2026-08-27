import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  readonly engines?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly bin?: Readonly<Record<string, string>>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly provenance?: boolean;
  };
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
) as PackageManifest;

describe('published package metadata', () => {
  it('does not execute lifecycle hooks during installation', () => {
    assert.strictEqual(manifest.scripts?.preinstall, undefined);
    assert.strictEqual(manifest.scripts?.install, undefined);
    assert.strictEqual(manifest.scripts?.postinstall, undefined);
  });

  it('requires Node.js 20 or later', () => {
    assert.strictEqual(manifest.engines?.node, '>=20');
  });

  it('publishes only runtime, type, and explicit skill assets', () => {
    assert.deepStrictEqual(manifest.files, ['dist', 'skill']);
    assert.deepStrictEqual(manifest.bin, {
      'npm-safe': './dist/cli/cli.js',
    });
  });

  it('publishes publicly with provenance enabled', () => {
    assert.strictEqual(manifest.publishConfig?.access, 'public');
    assert.strictEqual(manifest.publishConfig?.provenance, true);
  });
});
