import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli/cli.ts', import.meta.url));

describe('CLI reasoning effort configuration', () => {
  let root: string;
  let profile: string;
  let configFile: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-safe-llm-effort-cli-'));
    profile = path.join(root, 'profile');
    configFile = path.join(profile, '.npm-safe/llm.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ enabled: false, provider: 'openai', model: 'fixture-model', apiKey: 'fixture-secret-only', maxTokens: 16384 }));
  });
  afterEach(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('npm-safe-llm-effort-cli-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, '--db', path.join(root, 'cache.db'), 'llm', ...args], {
      cwd: packageRoot, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: profile, USERPROFILE: profile, NODE_OPTIONS: '',
        APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
        OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' },
    });
    if (result.error) throw result.error;
    return result;
  }

  it('sets an explicit effort and shows it in masked JSON and text status', () => {
    const update = run(['set-reasoning-effort', 'none']);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /Reasoning effort set to none/);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(config.reasoningEffort, 'none');
    assert.equal(config.maxTokens, 16384);
    assert.equal(config.model, 'fixture-model');
    const json = run(['status', '--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).reasoningEffort, 'none');
    assert.doesNotMatch(json.stdout, /fixture-secret-only/);
    const text = run(['status']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Reasoning effort \(OpenAI-compatible\): none/);
  });

  it('restores the service default and rejects unsupported values without altering settings', () => {
    assert.equal(run(['set-reasoning-effort', 'high']).status, 0);
    const before = fs.readFileSync(configFile, 'utf8');
    const invalid = run(['set-reasoning-effort', 'medium']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown reasoning effort.*default \/ none \/ low \/ high \/ max/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    const cleared = run(['set-reasoning-effort', 'default']);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configFile, 'utf8')), 'reasoningEffort'), false);
    const text = run(['status']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Reasoning effort \(OpenAI-compatible\): service default/);
  });
});
