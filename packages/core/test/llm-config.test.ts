import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LlmConfigManager } from '../src/llm/llm-config.js';
import { LlmProviderType } from '../src/llm/provider.js';
import type { LlmReasoningEffort } from '../src/llm/provider.js';
import { NpmSafeEngine } from '../src/index.js';

const envBackup = { ...process.env };
const originalFetch = globalThis.fetch;

function cleanEnv() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.GEMINI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.GEMINI_MODEL;
  delete process.env.ANTHROPIC_MODEL;
}

function restoreEnv() {
  process.env = { ...envBackup };
}

describe('LlmConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-llm-'));
    cleanEnv();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    restoreEnv();
    globalThis.fetch = originalFetch;
  });

  it('defaults to disabled with openai provider', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    const config = manager.getConfig();
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.sourceReview, false);
    assert.strictEqual(manager.getStatus().sourceReview, false);
    assert.strictEqual(config.provider, LlmProviderType.OpenAi);
    assert.strictEqual(config.apiKey, undefined);
    assert.strictEqual(config.maxTokens, 4096);
    assert.strictEqual(config.reasoningEffort, undefined);
    assert.strictEqual(manager.createProvider(), undefined);
  });

  it('returns masked status without exposing the full key', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ apiKey: 'sk-test-secret-key-1234', enabled: true });
    const status = manager.getStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.apiKey?.includes('secret'), false);
    assert.ok(status.apiKey?.startsWith('sk-t'));
    assert.ok(status.apiKey?.endsWith('1234'));
  });

  it('creates a provider when enabled and an api key is set', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ provider: LlmProviderType.OpenAi, apiKey: 'sk-openai', enabled: true });
    const provider = manager.createProvider();
    assert.ok(provider);
  });

  it('does not create a provider when disabled even with a key', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ apiKey: 'sk-openai', enabled: false });
    assert.strictEqual(manager.createProvider(), undefined);
  });

  it('falls back to environment variables for api key, base url, and model', () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENAI_BASE_URL = 'https://openai.example.com';
    process.env.OPENAI_MODEL = 'gpt-env';
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ enabled: true });
    const status = manager.getStatus();
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.baseUrl, 'https://openai.example.com');
    assert.strictEqual(status.model, 'gpt-env');
    const provider = manager.createProvider();
    assert.ok(provider);
  });

  it('prefers persisted config over environment variables', () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENAI_MODEL = 'gpt-env';
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ apiKey: 'persisted-key', model: 'gpt-persisted', enabled: true });
    const status = manager.getStatus();
    assert.strictEqual(status.configured, true);
    assert.ok(status.apiKey?.startsWith('pers'));
    assert.strictEqual(status.model, 'gpt-persisted');
  });

  it('ignores invalid provider values and falls back to openai', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ provider: 'unknown' as LlmProviderType });
    assert.strictEqual(manager.getConfig().provider, LlmProviderType.OpenAi);
  });

  it('persists and reloads configuration', () => {
    const file = path.join(tmpDir, 'llm.json');
    const first = new LlmConfigManager(file);
    first.setConfig({ enabled: true, sourceReview: true, provider: LlmProviderType.Gemini, apiKey: 'gemini-key' });

    const second = new LlmConfigManager(file);
    const config = second.getConfig();
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.sourceReview, true);
    assert.strictEqual(config.provider, LlmProviderType.Gemini);
    assert.strictEqual(config.apiKey, 'gemini-key');
  });

  it('uses provider-specific environment variables based on provider', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-env-key';
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ provider: LlmProviderType.Anthropic, enabled: true });
    assert.strictEqual(manager.getStatus().configured, true);
    assert.ok(manager.createProvider());
  });

  it('testConnection returns false when not configured', async () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    assert.strictEqual(await manager.testConnection(), false);
  });

  it('round-trips explicit reasoning effort, preserves omitted updates, and clears JSON null to service default', () => {
    const file = path.join(tmpDir, 'llm.json');
    const manager = new LlmConfigManager(file);
    for (const reasoningEffort of ['none', 'low', 'high', 'max'] as const) {
      manager.setConfig({ reasoningEffort });
      manager.setConfig({ maxTokens: 16384 });
      const reloaded = new LlmConfigManager(file);
      assert.strictEqual(reloaded.getConfig().reasoningEffort, reasoningEffort);
      assert.strictEqual(reloaded.getStatus().reasoningEffort, reasoningEffort);
    }
    manager.setConfig({ reasoningEffort: null });
    assert.strictEqual(manager.getStatus().reasoningEffort, undefined);
    assert.strictEqual(new LlmConfigManager(file).getConfig().reasoningEffort, undefined);
    assert.strictEqual(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'reasoningEffort'), false);
    manager.setConfig({ reasoningEffort: 'none' });
    manager.setConfig({ reasoningEffort: undefined });
    assert.strictEqual(manager.getConfig().reasoningEffort, 'none');
    assert.strictEqual(new LlmConfigManager(file).getConfig().reasoningEffort, 'none');
  });

  it('rejects invalid reasoning effort without changing memory or the saved configuration', () => {
    const file = path.join(tmpDir, 'llm.json');
    const manager = new LlmConfigManager(file);
    manager.setConfig({ reasoningEffort: 'none', model: 'preserved-model' });
    const before = readFileSync(file, 'utf8');
    for (const value of ['default', 'medium', 'minimal', '', 'NONE', true, 1, {}]) {
      assert.throws(() => manager.setConfig({ reasoningEffort: value as LlmReasoningEffort, model: 'must-not-change' }), /Invalid reasoning effort/);
      assert.strictEqual(manager.getConfig().reasoningEffort, 'none');
      assert.strictEqual(manager.getConfig().model, 'preserved-model');
      assert.strictEqual(readFileSync(file, 'utf8'), before);
    }
  });

  it('ignores only a malformed persisted effort while preserving the remaining provider configuration', () => {
    const file = path.join(tmpDir, 'llm.json');
    writeFileSync(file, JSON.stringify({ enabled: true, provider: 'openai', apiKey: 'fixture-key', model: 'configured-model', reasoningEffort: 'unsupported' }));
    const manager = new LlmConfigManager(file);
    assert.strictEqual(manager.getConfig().enabled, true);
    assert.strictEqual(manager.getConfig().model, 'configured-model');
    assert.strictEqual(manager.getConfig().reasoningEffort, undefined);
    assert.strictEqual(manager.getStatus().configured, true);
    assert.ok(manager.createProvider());
  });

  it('passes a persisted explicit effort to the OpenAI-compatible provider', async () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    manager.setConfig({ enabled: true, apiKey: 'fixture-key', reasoningEffort: 'none' });
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    }) as typeof fetch;
    await manager.createProvider()!.reviewSource!({ systemPrompt: 'Return JSON.', prompt: '{}' });
    assert.strictEqual(body?.reasoning_effort, 'none');
  });
});

describe('NpmSafeEngine LLM config', () => {
  let tmpDir: string;
  let engine: NpmSafeEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'npm-safe-engine-llm-'));
    cleanEnv();
    engine = new NpmSafeEngine({
      dbPath: path.join(tmpDir, 'test.db'),
      llmConfigPath: path.join(tmpDir, 'llm.json'),
    });
  });

  afterEach(() => {
    try {
      engine.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    restoreEnv();
  });

  it('exposes getLlmConfig, getLlmStatus, setLlmConfig, testLlmConnection', () => {
    assert.strictEqual(engine.getLlmConfig().enabled, false);
    assert.strictEqual(engine.getLlmConfig().maxTokens, 4096);
    assert.strictEqual(engine.getLlmStatus().configured, false);
    assert.strictEqual(typeof engine.testLlmConnection, 'function');
  });

  it('updates the provider at runtime via setLlmConfig', () => {
    engine.setLlmConfig({ enabled: true, apiKey: 'sk-test' });
    const status = engine.getLlmStatus();
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.configured, true);
  });

  it('does not break when setLlmConfig disables LLM', () => {
    engine.setLlmConfig({ enabled: true, apiKey: 'sk-test' });
    engine.setLlmConfig({ enabled: false });
    assert.strictEqual(engine.getLlmStatus().enabled, false);
    assert.strictEqual(engine.getLlmConfig().enabled, false);
  });

  it('returns masked key in status and raw key in config', () => {
    engine.setLlmConfig({ apiKey: 'sk-my-secret-key' });
    assert.strictEqual(engine.getLlmConfig().apiKey, 'sk-my-secret-key');
    assert.notStrictEqual(engine.getLlmStatus().apiKey, 'sk-my-secret-key');
  });
});
