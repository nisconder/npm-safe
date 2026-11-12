import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CheckResult } from '../src/index.js';
import { makeTarball } from './helpers/package-tarball.js';

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(packageDirectory, 'src/cli/cli.ts');
const name = 'source-review-cli-fixture';
type Run = (args: string[], verdict?: string) => {stdout: string; stderr: string; status: number | null};

/** Real CLI/provider flow with HTTP replaced; fixture package code is never run. */
function withCli(test: (run: Run, configure: (enabled: boolean) => void) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-source-cli-'));
  const config = path.join(home, '.npm-safe', 'llm.json');
  try {
    mkdirSync(path.dirname(config));
    writeFileSync(config, JSON.stringify({enabled: false}));
    const archive = makeTarball([{path: 'package/index.js', content: 'export const answer=42;\n'}]);
    const fixture = path.join(home, 'fixture.json'), preload = path.join(home, 'fetch.mjs');
    const tarball = `https://registry.npmjs.org/${name}/fixture.tgz`;
    writeFileSync(fixture, JSON.stringify({name, tarball, archive: archive.toString('base64'), metadata: {
      name, modified: '2026-01-01T00:00:00Z', readme: '', 'dist-tags': {latest: '1.0.0'},
      versions: {'1.0.0': {name, version: '1.0.0', main: 'index.js',
        dist: {tarball, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64')},
      }},
    }}));
    writeFileSync(preload, `
      import {readFileSync} from 'node:fs';
      const fixture = JSON.parse(readFileSync(process.env.NPM_SAFE_SOURCE_FIXTURE, 'utf8'));
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === fixture.tarball) return new Response(Buffer.from(fixture.archive, 'base64'));
        if (url === 'https://registry.npmjs.org/' + fixture.name) return new Response(JSON.stringify(fixture.metadata));
        if (url !== 'https://source-review-model.invalid/v1/chat/completions') throw new Error('Unexpected offline request: ' + url);
        const body = JSON.parse(init.body), evidence = JSON.parse(body.messages[1].content);
        if (!evidence.packet) throw new Error('Source-mode test unexpectedly invoked metadata inference');
        const verdict = process.env.NPM_SAFE_SOURCE_VERDICT || 'benign';
        if (verdict === 'failure') return new Response('Fixture failure', {status: 503});
        const file = evidence.packet.files[0], excerpt = file.excerpts[0];
        const review = {schemaVersion: 1, caseId: evidence.caseId, verdict, confidence: 0.5,
          summary: 'Synthetic CLI response.', limitations: ['Inert fixture; no real malware judgment.'],
          findings: verdict === 'malicious' ? [{kind: 'CLI fixture', severity: 'critical', claim: 'Synthetic aggregation finding.',
            reasoning: 'Validates CLI evidence rendering only.', evidence: [{path: file.path, startOffset: excerpt.startOffset,
              endOffset: excerpt.endOffset, quote: excerpt.text}]}] : []};
        return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(review)}}]}));
      };
    `);
    const configure = (enabled: boolean) => {
      const previous = JSON.parse(readFileSync(config, 'utf8'));
      writeFileSync(config, JSON.stringify({...previous, enabled, apiKey: 'inert-fixture-key',
        baseUrl: 'https://source-review-model.invalid/v1', model: 'fixture-model'}));
    };
    test((args, verdict = 'benign') => {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--import', 'tsx', cli,
        '--db', path.join(home, 'cache.db'), ...args], {
        cwd: packageDirectory, encoding: 'utf8', timeout: 30_000,
        env: {...process.env, HOME: home, USERPROFILE: home,
          OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '',
          NPM_SAFE_SOURCE_FIXTURE: fixture, NPM_SAFE_SOURCE_VERDICT: verdict},
      });
      if (result.error) throw result.error;
      return {stdout: result.stdout, stderr: result.stderr, status: result.status};
    }, configure);
  } finally { rmSync(home, {recursive: true, force: true}); }
}

describe('source-review CLI configuration and results', () => {
  it('persists the independent default-off toggle and reports it without enabling the provider', () => {
    withCli(run => {
      const initial = JSON.parse(run(['llm', 'status', '--json']).stdout);
      assert.equal(initial.sourceReview, false); assert.equal(initial.enabled, false);
      const enable = run(['llm', 'enable-source']);
      assert.equal(enable.status, 0, enable.stderr);
      assert.match(enable.stdout, /Selected source is sent/);
      const enabled = JSON.parse(run(['llm', 'status', '--json']).stdout);
      assert.equal(enabled.sourceReview, true); assert.equal(enabled.enabled, false);
      assert.match(run(['llm', 'status']).stdout, /Source review on deep checks: yes/);
      assert.equal(run(['llm', 'disable-source']).status, 0);
      assert.equal(JSON.parse(run(['llm', 'status', '--json']).stdout).sourceReview, false);
    });
  });

  for (const outcome of [
    {verdict: 'benign', level: 'safe', status: 0, reviewStatus: 'complete'},
    {verdict: 'malicious', level: 'dangerous', status: 1, reviewStatus: 'complete'},
    {verdict: 'unknown', level: 'unknown', status: 1, reviewStatus: 'complete'},
    {verdict: 'failure', level: 'unknown', status: 1, reviewStatus: 'failed'},
  ]) it(`keeps JSON/text result and exit semantics aligned for ${outcome.verdict}`, () => {
    withCli((run, configure) => {
      configure(true); assert.equal(run(['llm', 'enable-source']).status, 0);
      const args = ['check', name, '--deep'];
      const json = run([...args, '--json'], outcome.verdict);
      assert.equal(json.status, outcome.status, json.stderr);
      const result = JSON.parse(json.stdout) as CheckResult;
      assert.equal(result.security.overallLevel, outcome.level);
      assert.equal(result.security.staticScan?.overallLevel, 'safe');
      assert.equal(result.security.sourceReview?.status, outcome.reviewStatus);
      assert.equal(result.security.sourceReview?.calls, 1);
      const text = run(args, outcome.verdict);
      assert.equal(text.status, outcome.status, text.stderr);
      assert.match(text.stdout, /LLM source review:/);
      assert.ok(text.stdout.includes(outcome.reviewStatus));
      assert.ok(text.stdout.includes(`Security level: ${outcome.level}`));
      if (outcome.verdict === 'malicious') {
        assert.match(text.stdout, /llm-source-1/);
        assert.match(text.stdout, /package\/index\.js/);
        assert.match(text.stdout, /export const answer=42/);
      }
      if (outcome.reviewStatus === 'complete') assert.match(text.stdout, /Inert fixture/);
    });
  });

  it('shows an explicitly requested but unconfigured source review as skipped and unknown', () => {
    withCli(run => {
      assert.equal(run(['llm', 'enable-source']).status, 0);
      const result = run(['check', name, '--deep', '--json']);
      const report = JSON.parse(result.stdout) as CheckResult;
      assert.equal(result.status, 1, result.stderr);
      assert.equal(report.security.sourceReview?.status, 'skipped');
      assert.equal(report.security.sourceReview?.calls, 0);
      assert.equal(report.security.overallLevel, 'unknown');
      const text = run(['check', name, '--deep']);
      assert.equal(text.status, 1); assert.match(text.stdout, /skipped/);
      assert.match(text.stdout, /enabled, configured LLM provider/);
    });
  });
});
