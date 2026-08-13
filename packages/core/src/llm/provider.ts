/**
 * Multi-provider LLM scan core.
 *
 * This module hosts the unified {@link LlmProviderOptions} interface, the
 * {@link LlmProviderType} enum, and the {@link createLlmProvider} factory
 * that dispatches to a concrete provider implementation. The OpenAI-
 * compatible provider ({@link OpenAICompatibleLlmProvider}) lives here as
 * the reference implementation; Gemini and Anthropic providers live in
 * sibling modules and are wired up through the factory.
 *
 * Shared parsing/validation helpers and the {@link LlmProviderError} class
 * are imported from {@link ./parse.js} so every provider reuses the same
 * logic instead of duplicating it.
 */

import type { LlmScanReport } from "../scanner/types.js";

import {
  LlmProviderError,
  SYSTEM_PROMPT,
  buildReport,
  parseJsonObject,
} from "./parse.js";
import { GeminiLlmProvider } from "./gemini.js";
import { AnthropicLlmProvider } from "./anthropic.js";

// Re-export LlmProviderError for backward compatibility: index.ts and the
// existing test suite import it from this module.
export { LlmProviderError } from "./parse.js";
// Re-export the concrete provider classes so tests and consumers can import
// them from this barrel module alongside the factory and shared types.
export { GeminiLlmProvider } from "./gemini.js";
export { AnthropicLlmProvider } from "./anthropic.js";

/**
 * Input passed to an LLM scan provider.
 */
export interface LlmScanInput {
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly readme: string;
  readonly packageJson?: Record<string, unknown>;
}

/**
 * Contract every LLM scan provider implements.
 */
export interface LlmScanProvider {
  scan(input: LlmScanInput): Promise<LlmScanReport>;
  testConnection(): Promise<boolean>;
}

/**
 * Supported LLM provider backends.
 */
export enum LlmProviderType {
  OpenAi = "openai",
  Gemini = "gemini",
  Anthropic = "anthropic",
}

/**
 * Unified options accepted by {@link createLlmProvider} and every concrete
 * provider constructor. Fields not relevant to a given backend are ignored
 * by that backend.
 */
export interface LlmProviderOptions {
  /** Backend to instantiate. @default {@link LlmProviderType.OpenAi} */
  readonly provider?: LlmProviderType;
  /** API key. Falls back to a backend-specific env var when omitted. */
  readonly apiKey?: string;
  /** Base URL of the LLM API endpoint. */
  readonly baseUrl?: string;
  /** Model identifier to use for completions. */
  readonly model?: string;
  /** Request timeout in milliseconds. @default 30000 */
  readonly timeoutMs?: number;
  /** Maximum README characters to send to the model. @default 12000 */
  readonly maxInputChars?: number;
  /** Maximum response tokens. @default 4096 */
  readonly maxTokens?: number;
}

/**
 * Deprecated alias for {@link LlmProviderOptions}.
 * @deprecated Use {@link LlmProviderOptions} instead.
 */
export type OpenAICompatibleLlmOptions = LlmProviderOptions;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Construct an {@link LlmScanProvider} for the backend selected via
 * {@link LlmProviderOptions.provider}. Defaults to the OpenAI-compatible
 * provider.
 *
 * @param options - Provider configuration. When omitted, an OpenAI-
 * compatible provider is constructed with environment-derived defaults.
 * @returns A concrete {@link LlmScanProvider} instance.
 */
export function createLlmProvider(options?: LlmProviderOptions): LlmScanProvider {
  switch (options?.provider ?? LlmProviderType.OpenAi) {
    case LlmProviderType.Gemini:
      return new GeminiLlmProvider(options);
    case LlmProviderType.Anthropic:
      return new AnthropicLlmProvider(options);
    default:
      return new OpenAICompatibleLlmProvider(options);
  }
}

/**
 * OpenAI-compatible chat completions LLM scan provider.
 *
 * Talks to any endpoint that implements the `/chat/completions` surface
 * (OpenAI, Azure OpenAI, local LM Studio / Ollama OpenAI shims, etc.).
 */
export class OpenAICompatibleLlmProvider implements LlmScanProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxInputChars: number;
  private readonly maxTokens: number;

  /**
   * @param options - Provider configuration. Env-var fallbacks:
   *   `apiKey` defaults to `process.env.OPENAI_API_KEY`.
   */
  constructor(options: LlmProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** @inheritdoc */
  async scan(input: LlmScanInput): Promise<LlmScanReport> {
    if (!this.apiKey) {
      return {
        enabled: false,
        reason: "LLM provider is not configured.",
      };
    }

    const packageJsonBudget = Math.floor(this.maxInputChars / 3);
    const packageJsonStr = input.packageJson
      ? JSON.stringify(input.packageJson).slice(0, packageJsonBudget)
      : undefined;
    const content = JSON.stringify({
      packageName: input.packageName,
      version: input.version,
      description: input.description,
      readme: input.readme.slice(0, this.maxInputChars),
      packageJson: packageJsonStr,
    });
    const payload = await this.request({
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    });
    const parsed = parseJsonObject(payload);
    return buildReport(parsed, new Date().toISOString());
  }

  /** @inheritdoc */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    await this.request({
      model: this.model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: this.maxTokens,
    });
    return true;
  }

  /**
   * Issue a POST to `/chat/completions` with timeout and error normalization.
   *
   * @param body - The JSON request body.
   * @returns The `choices[0].message.content` string from the response.
   * @throws {LlmProviderError} On network, timeout, HTTP, or shape errors.
   */
  private async request(body: Record<string, unknown>): Promise<string> {
    if (!this.apiKey) {
      throw new LlmProviderError("LLM provider is not configured.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LlmProviderError(
          `LLM request failed with HTTP ${response.status}.`,
          response.status,
        );
      }
      const json = (await response.json()) as unknown;
      const content = readResponseContent(json);
      if (!content) throw new LlmProviderError("LLM response contained no content.");
      return content;
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new LlmProviderError("LLM request timed out.");
      }
      throw new LlmProviderError(
        `LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract the `choices[0].message.content` string from an OpenAI-shaped
 * chat completion response. Returns `undefined` when the shape does not
 * match.
 *
 * @param value - The parsed JSON response body.
 * @returns The content string, or `undefined`.
 */
function readResponseContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = choices[0];
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content : undefined;
}