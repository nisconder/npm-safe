import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  readonly version?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
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
const desktopManifest = JSON.parse(
  fs.readFileSync(path.resolve(packageRoot, '..', 'desktop', 'package.json'), 'utf8'),
) as PackageManifest;
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const workspaceManifest = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
) as PackageManifest & { readonly packageManager?: string };
const ciWorkflow = fs.readFileSync(
  path.join(workspaceRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
);

describe('published package metadata', () => {
  it('does not execute lifecycle hooks during installation', () => {
    assert.strictEqual(manifest.scripts?.preinstall, undefined);
    assert.strictEqual(manifest.scripts?.install, undefined);
    assert.strictEqual(manifest.scripts?.postinstall, undefined);
  });

  it('declares the minimum runtime required by direct dependencies', () => {
    assert.strictEqual(manifest.engines?.node, '>=20.12.0');
    assert.match(
      manifest.dependencies?.undici ?? '',
      /^\^6\./,
      'undici 7+ requires a newer Node.js runtime than the advertised Node 20.12 floor',
    );
  });

  it('keeps the workspace package manager compatible with the Node 20 CI floor', () => {
    const match = workspaceManifest.packageManager?.match(/^pnpm@(\d+)\./);
    assert.ok(match, 'workspace packageManager must pin a pnpm major version');
    assert.ok(
      Number(match[1]) <= 10,
      'pnpm 11 requires Node >=22.13 and cannot bootstrap the Node 20.12 CI job',
    );
    assert.ok(
      !ciWorkflow.split(/\r?\n/).some((line) => /^\s+version:\s/.test(line)),
      'CI should resolve pnpm from packageManager instead of duplicating its version',
    );
  });

  it('keeps the core and desktop release versions aligned', () => {
    assert.strictEqual(desktopManifest.version, manifest.version);
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
