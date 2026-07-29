/**
 * Type definitions for the translator provider system.
 *
 * This module defines the provider enumeration, configuration schemas,
 * result types, and typed error classes used by the translator adapters
 * defined in {@link ./provider.ts}.
 *
 * @module translator/types
 */

/**
 * Supported translation provider backends.
 *
 * Each enum member corresponds to a concrete adapter implementation in
 * {@link ../translator/provider.ts}.
 */
export enum TranslatorProviderType {
  /** DeepL translation API (api-free.deepl.com or api.deepl.com). */
  DeepL = 'deepL',
  /** OpenAI-compatible chat completion API for translation. */
  OpenAI = 'openAI',
  /** Self-hosted LibreTranslate instance. */
  LibreTranslate = 'libreTranslate',
}

/**
 * Result of a translation request.
 */
export interface TranslationResult {
  /** The translated text in the target language. */
  readonly translatedText: string;
  /**
   * Language code of the source text as detected by the provider, if the
   * provider supports automatic source-language detection.
   */
  readonly detectedSourceLang?: string;
  /** Usage metering information, if reported by the provider. */
  readonly usage?: {
    /** Number of characters billed for the request. */
    readonly characters: number;
  };
}

/**
 * Configuration for initialising a translator provider adapter.
 */
export interface TranslatorConfig {
  /** Which backend provider to use. */
  readonly provider: TranslatorProviderType;
  /** API key for the provider. May be omitted if the provider is configured
   *  elsewhere (e.g. environment variables) or does not require one. */
  readonly apiKey?: string;
  /** Base URL of the provider's API endpoint. Defaults are specific to each
   *  adapter. */
  readonly baseUrl?: string;
  /** Model identifier, used only by OpenAI-compatible providers. */
  readonly model?: string;
  /** Default target language code (e.g. `'zh-CN'`, `'fr'`). */
  readonly targetLang: string;
}

/**
 * Error thrown when a translator provider was selected but not configured
 * with the required credentials.
 */
export class ProviderNotConfigured extends Error {
  /**
   * @param provider - Human-readable provider name (e.g. `'DeepL'`).
   * @param reason - Explanation of what configuration is missing.
   */
  constructor(provider: string, reason: string) {
    super(`Translator provider "${provider}" is not configured: ${reason}`);
    this.name = 'ProviderNotConfigured';
  }
}

/**
 * Error thrown when a translation request fails at the network or provider
 * level (timeout, non-2xx response, malformed reply, etc.).
 */
export class TranslationError extends Error {
  /**
   * @param message - Human-readable error description.
   * @param provider - Name of the provider that produced the error.
   * @param statusCode - HTTP status code from the provider, if applicable.
   */
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}
