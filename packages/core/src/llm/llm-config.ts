/**
 * LLM provider configuration persistence and runtime resolution.
 *
 * {@link LlmConfigManager} reads/writes the `~/.npm-safe/llm.json` file. The
 * configuration is optional: when no API key is configured and no supported
 * environment variable is present, LLM scanning is silently disabled and the
 * rest of the engine keeps working normally.
 *
 * API keys are stored in plain text at the configured path. The file is created
 * with `0o600` permissions when possible (best effort on Windows).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLlmProvider, LlmProviderType } from './provider.js';
import type { LlmProviderOptions, LlmScanProvider } from './provider.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const DEFAULT_MAX_TOKENS = 4096;

const ENV_KEY_MAP: Readonly<Record<LlmProviderType, string>> = {
  [LlmProviderType.OpenAi]: 'OPENAI_API_KEY',
  [LlmProviderType.Gemini]: 'GEMINI_API_KEY',
  [LlmProviderType.Anthropic]: 'ANTHROPIC_API_KEY',
};

const ENV_BASE_URL_MAP: Readonly<Record<LlmProviderType, string>> = {
  [LlmProviderType.OpenAi]: 'OPENAI_BASE_URL',
  [LlmProviderType.Gemini]: 'GEMINI_BASE_URL',
  [LlmProviderType.Anthropic]: 'ANTHROPIC_BASE_URL',
};

const ENV_MODEL_MAP: Readonly<Record<LlmProviderType, string>> = {
  [LlmProviderType.OpenAi]: 'OPENAI_MODEL',
  [LlmProviderType.Gemini]: 'GEMINI_MODEL',
  [LlmProviderType.Anthropic]: 'ANTHROPIC_MODEL',
};

/** Persisted LLM configuration. */
export interface LlmConfig {
  /** Whether LLM scanning is enabled. */
  readonly enabled: boolean;
  /** Backend provider. */
  readonly provider: LlmProviderType;
  /** API key (optional; environment variable fallback is supported). */
  readonly apiKey?: string;
  /** Base URL of the LLM API endpoint. */
  readonly baseUrl?: string;
  /** Model identifier to use. */
  readonly model?: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Maximum README characters to send to the model. */
  readonly maxInputChars?: number;
  /** Anthropic maximum response tokens. */
  readonly maxTokens?: number;
}

/** Runtime status of the LLM integration, safe to display. */
export interface LlmStatus {
  /** Whether LLM scanning is enabled. */
  readonly enabled: boolean;
  /** Backend provider. */
  readonly provider: LlmProviderType;
  /** Whether an API key is available (from config or env). */
  readonly configured: boolean;
  /** Model identifier in use, if any. */
  readonly model?: string;
  /** Base URL in use, if any. */
  readonly baseUrl?: string;
  /** Masked API key (e.g. `"sk-****1234"`), or `undefined`. */
  readonly apiKey?: string;
  /** Maximum response tokens, if set. */
  readonly maxTokens?: number;
  /** Maximum input characters, if set. */
  readonly maxInputChars?: number;
}

/** Returns the default path for the LLM configuration file. */
export function getDefaultLlmConfigPath(): string {
  return path.join(os.homedir(), '.npm-safe', 'llm.json');
}

/** Masks an API key for display: keeps the first 4 and last 4 characters. */
function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

/**
 * Loads, mutates, and persists LLM provider configuration.
 *
 * Thread-safe per instance; concurrent instances may race on the file, which is
 * acceptable for a single-user desktop tool.
 */
export class LlmConfigManager {
  private readonly filePath: string;
  private config: LlmConfig;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultLlmConfigPath();
    this.config = this.load();
  }

  /** Load (or initialize) the config file. */
  private load(): LlmConfig {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      return this.normalize(parsed);
    } catch {
      return this.normalize({});
    }
  }

  /** Persist the current configuration to disk. */
  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Ignore platforms/filesystems where chmod is unsupported.
      }
    } catch {
      // Best-effort persistence; in-memory config remains valid.
    }
  }

  /** Normalize a partial config into a full config with defaults. */
  private normalize(input: Partial<LlmConfig>): LlmConfig {
    const provider =
      input.provider && Object.values(LlmProviderType).includes(input.provider)
        ? input.provider
        : LlmProviderType.OpenAi;
    return {
      enabled: input.enabled ?? false,
      provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxInputChars: input.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  /** Returns the current persisted config, including the raw API key. */
  getConfig(): LlmConfig {
    return this.config;
  }

  /** Returns a masked status view suitable for display. */
  getStatus(): LlmStatus {
    const resolved = this.resolveApiKey();
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      configured: !!resolved,
      model: this.resolveModel(),
      baseUrl: this.resolveBaseUrl(),
      apiKey: maskApiKey(resolved),
      maxTokens: this.config.maxTokens,
      maxInputChars: this.config.maxInputChars,
    };
  }

  /** Update the persisted config. */
  setConfig(update: Partial<LlmConfig>): void {
    const nextApiKey = update.apiKey !== undefined ? update.apiKey : this.config.apiKey;
    const next: LlmConfig = {
      enabled: update.enabled ?? this.config.enabled,
      provider: update.provider && Object.values(LlmProviderType).includes(update.provider)
        ? update.provider
        : this.config.provider,
      apiKey: nextApiKey,
      baseUrl: update.baseUrl !== undefined ? update.baseUrl : this.config.baseUrl,
      model: update.model !== undefined ? update.model : this.config.model,
      timeoutMs: update.timeoutMs ?? this.config.timeoutMs,
      maxInputChars: update.maxInputChars ?? this.config.maxInputChars,
      maxTokens: update.maxTokens ?? this.config.maxTokens,
    };
    this.config = next;
    this.save();
  }

  /**
   * Resolve the effective API key, preferring the persisted config and falling
   * back to a provider-specific environment variable.
   */
  private resolveApiKey(): string | undefined {
    if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
      return this.config.apiKey.trim();
    }
    const envKey = ENV_KEY_MAP[this.config.provider];
    return process.env[envKey]?.trim() || undefined;
  }

  /** Resolve the effective base URL. */
  private resolveBaseUrl(): string | undefined {
    return this.config.baseUrl?.trim() || process.env[ENV_BASE_URL_MAP[this.config.provider]]?.trim() || undefined;
  }

  /** Resolve the effective model. */
  private resolveModel(): string | undefined {
    return this.config.model?.trim() || process.env[ENV_MODEL_MAP[this.config.provider]]?.trim() || undefined;
  }

  /**
   * Create a configured {@link LlmScanProvider} if LLM scanning is enabled and
   * an API key is available; otherwise return `undefined`.
   */
  createProvider(): LlmScanProvider | undefined {
    const apiKey = this.resolveApiKey();
    if (!this.config.enabled || !apiKey) return undefined;

    const options: LlmProviderOptions = {
      provider: this.config.provider,
      apiKey,
      baseUrl: this.resolveBaseUrl(),
      model: this.resolveModel(),
      timeoutMs: this.config.timeoutMs,
      maxInputChars: this.config.maxInputChars,
      maxTokens: this.config.maxTokens,
    };
    return createLlmProvider(options);
  }

  /**
   * Test whether the current configuration can connect to the provider.
   *
   * Returns `false` when the provider is not configured or disabled.
   */
  async testConnection(): Promise<boolean> {
    const provider = this.createProvider();
    if (!provider) return false;
    return provider.testConnection();
  }
}
