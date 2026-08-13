import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LlmConfigManager } from '../src/llm/llm-config.js';
import { LlmProviderType } from '../src/llm/provider.js';
import { NpmSafeEngine } from '../src/index.js';

const envBackup = { ...process.env };

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
  });

  it('defaults to disabled with openai provider', () => {
    const manager = new LlmConfigManager(path.join(tmpDir, 'llm.json'));
    const config = manager.getConfig();
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.provider, LlmProviderType.OpenAi);
    assert.strictEqual(config.apiKey, undefined);
    assert.strictEqual(config.maxTokens, 4096);
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
    first.setConfig({ enabled: true, provider: LlmProviderType.Gemini, apiKey: 'gemini-key' });

    const second = new LlmConfigManager(file);
    const config = second.getConfig();
    assert.strictEqual(config.enabled, true);
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
