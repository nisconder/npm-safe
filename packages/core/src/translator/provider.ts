/**
 * Translator provider interface and adapter skeletons for @npm-safe/core.
 *
 * This module defines the {@link TranslatorProvider} interface that all
 * translation backends must implement, together with skeleton adapters for
 * DeepL and OpenAI-compatible APIs. The skeletons are ready for Phase 5
 * integration — they validate credentials but throw
 * {@link ProviderNotConfigured} or {@link TranslationError} with a "not yet
 * implemented" message instead of making actual API calls.
 *
 * @module translator/provider
 */

import {
  TranslationResult,
  TranslatorConfig,
  TranslatorProviderType,
  ProviderNotConfigured,
  TranslationError,
} from './types.js';

/**
 * Interface that every translation provider adapter must implement.
 *
 * Adapters are stateless beyond their configuration (API key, base URL,
 * model) and may be shared across requests.
 */
export interface TranslatorProvider {
  /** Human-readable name of the provider (e.g. `'DeepL'`, `'OpenAI'`). */
  readonly name: string;

  /**
   * Translate text from a source language to a target language.
   *
   * @param text - The text to translate.
   * @param targetLang - Target language code (e.g. `'zh-CN'`, `'fr'`).
   * @param sourceLang - Optional source language code. When omitted the
   *   provider may auto-detect the source language.
   * @returns A promise resolving to the translation result.
   * @throws {ProviderNotConfigured} When the provider has no API key.
   * @throws {TranslationError} When the request fails at the network or
   *   provider level.
   */
  translate(
    text: string,
    targetLang: string,
    sourceLang?: string,
  ): Promise<TranslationResult>;

  /**
   * Verify that the provider is reachable and the configured credentials
   * are valid.
   *
   * @returns A promise resolving to `true` when the connection succeeds,
   *   `false` when the provider is not configured.
   * @throws {TranslationError} When the connection test fails at the
   *   network or provider level.
   */
  testConnection(): Promise<boolean>;
}

/**
 * Adapter for the DeepL translation API.
 *
 * This is a skeleton implementation for Phase 5. Construction requires an
 * optional `apiKey`; without one, both {@link DeepLAdapter.translate} and
 * {@link DeepLAdapter.testConnection} throw {@link ProviderNotConfigured}.
 * With a key they throw {@link TranslationError} with a "not yet implemented"
 * message.
 */
export class DeepLAdapter implements TranslatorProvider {
  readonly name = 'DeepL';
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  /**
   * @param config.apiKey - DeepL API key (optional; required at call time).
   * @param config.baseUrl - DeepL API base URL. Defaults to the free-tier
   *   endpoint `https://api-free.deepl.com`.
   */
  constructor(config: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api-free.deepl.com';
  }

  /**
   * Translate text via DeepL.
   *
   * Phase 5: This method will POST to `${this.baseUrl}/v2/translate` with
   * an `Authorization: DeepL-Auth-Key ${this.apiKey}` header.
   *
   * @param text - Text to translate.
   * @param targetLang - Target language code.
   * @param sourceLang - Optional source language code.
   * @throws {ProviderNotConfigured} When no API key has been provided.
   * @throws {TranslationError} Always — implementation is deferred to Phase 5.
   */
  async translate(
    text: string,
    targetLang: string,
    sourceLang?: string,
  ): Promise<TranslationResult> {
    if (!this.apiKey) {
      throw new ProviderNotConfigured(
        'DeepL',
        'No API key provided. Configure it in Settings.',
      );
    }
    // Phase 5: Implement actual API call
    // POST ${this.baseUrl}/v2/translate with Authorization: DeepL-Auth-Key ${this.apiKey}
    throw new TranslationError('DeepL translation not yet implemented', 'DeepL');
  }

  /**
   * Test the connection to the DeepL API.
   *
   * @returns `false` when no API key is configured (no test attempted).
   * @throws {TranslationError} Always when an API key is present —
   *   implementation is deferred to Phase 5.
   */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    // Phase 5: Implement actual connection test
    throw new TranslationError(
      'DeepL testConnection not yet implemented',
      'DeepL',
    );
  }
}

/**
 * Adapter for OpenAI-compatible chat completion APIs used for translation.
 *
 * This is a skeleton implementation for Phase 5. Construction requires an
 * optional `apiKey`; without one, both {@link OpenAIAdapter.translate} and
 * {@link OpenAIAdapter.testConnection} throw {@link ProviderNotConfigured}.
 * With a key they throw {@link TranslationError} with a "not yet implemented"
 * message.
 */
export class OpenAIAdapter implements TranslatorProvider {
  readonly name = 'OpenAI';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;

  /**
   * @param config.apiKey - OpenAI API key (optional; required at call time).
   * @param config.baseUrl - OpenAI API base URL. Defaults to
   *   `https://api.openai.com/v1`.
   * @param config.model - Model identifier for chat completions. Defaults to
   *   `gpt-4o-mini`.
   */
  constructor(config: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
  }

  /**
   * Translate text via an OpenAI-compatible chat completion API.
   *
   * Phase 5: This method will POST to `${this.baseUrl}/chat/completions`
   * with a system prompt instructing the model to translate, sending the
   * given text as the user message.
   *
   * @param text - Text to translate.
   * @param targetLang - Target language code.
   * @param sourceLang - Optional source language code (passed as context
   *   to the model; not used for auto-detection since LLMs do not return
   *   a detected language).
   * @throws {ProviderNotConfigured} When no API key has been provided.
   * @throws {TranslationError} Always — implementation is deferred to Phase 5.
   */
  async translate(
    text: string,
    targetLang: string,
    sourceLang?: string,
  ): Promise<TranslationResult> {
    if (!this.apiKey) {
      throw new ProviderNotConfigured(
        'OpenAI',
        'No API key provided. Configure it in Settings.',
      );
    }
    // Phase 5: Implement actual API call
    // POST ${this.baseUrl}/chat/completions with system prompt for translation
    throw new TranslationError(
      'OpenAI translation not yet implemented',
      'OpenAI',
    );
  }

  /**
   * Test the connection to the OpenAI API.
   *
   * @returns `false` when no API key is configured (no test attempted).
   * @throws {TranslationError} Always when an API key is present —
   *   implementation is deferred to Phase 5.
   */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    // Phase 5: Implement actual connection test
    throw new TranslationError(
      'OpenAI testConnection not yet implemented',
      'OpenAI',
    );
  }
}

/**
 * Create a translator provider instance from a configuration object.
 *
 * @param config - Complete translator configuration including the target
 *   provider type and any required credentials.
 * @returns A provider adapter instance matching the configured type.
 * @throws {TranslationError} When the requested provider type is
 *   `LibreTranslate` (not yet implemented).
 */
export function createTranslator(config: TranslatorConfig): TranslatorProvider {
  switch (config.provider) {
    case TranslatorProviderType.DeepL:
      return new DeepLAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
    case TranslatorProviderType.OpenAI:
      return new OpenAIAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    case TranslatorProviderType.LibreTranslate:
      throw new TranslationError(
        'LibreTranslate support not yet implemented',
        'LibreTranslate',
      );
  }
}
