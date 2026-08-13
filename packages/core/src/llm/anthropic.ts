/**
 * Anthropic LLM scan provider.
 *
 * Talks to the Anthropic Messages API (`/v1/messages`). The Anthropic
 * request shape differs from the OpenAI-compatible surface in two ways:
 *   - `system` is a top-level string, not a `system` message role.
 *   - `max_tokens` is a required field on every request.
 * The response is an array of content blocks; the first block's `text`
 * field carries the model output.
 */

import type { LlmScanReport } from "../scanner/types.js";
import type { LlmScanInput, LlmScanProvider, LlmProviderOptions } from "./provider.js";
import {
  LlmProviderError,
  SYSTEM_PROMPT,
  buildReport,
  parseJsonObject,
} from "./parse.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;

/**
 * Anthropic Messages API LLM scan provider.
 *
 * @see {@link LlmScanProvider}
 */
export class AnthropicLlmProvider implements LlmScanProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxInputChars: number;

  /**
   * @param options - Provider configuration. Env-var fallbacks:
   *   `apiKey` defaults to `process.env.ANTHROPIC_API_KEY`.
   */
  constructor(options: LlmProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
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
      max_tokens: this.maxTokens,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });
    const parsed = parseJsonObject(payload);
    return buildReport(parsed, new Date().toISOString());
  }

  /** @inheritdoc */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    await this.request({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    return true;
  }

  /**
   * Issue a POST to `/v1/messages` with timeout and error normalization.
   *
   * @param body - The JSON request body.
   * @returns The `content[0].text` string from the response.
   * @throws {LlmProviderError} On network, timeout, HTTP, or shape errors.
   */
  private async request(body: Record<string, unknown>): Promise<string> {
    if (!this.apiKey) {
      throw new LlmProviderError("LLM provider is not configured.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
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
 * Extract the `content[0].text` string from an Anthropic-shaped Messages
 * response. Returns `undefined` when the shape does not match.
 *
 * @param value - The parsed JSON response body.
 * @returns The content string, or `undefined`.
 */
function readResponseContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const block = content[0];
  if (!block || typeof block !== "object") return undefined;
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}