/**
 * Gemini LLM scan provider.
 *
 * Talks to the Google Generative Language API
 * (`generativelanguage.googleapis.com/v1beta`) using the
 * `models/<model>:generateContent` surface. Mirrors the structure of
 * {@link OpenAICompatibleLlmProvider} but adapts the request body, auth
 * header, and response shape to Gemini's conventions.
 */

import type { LlmScanReport } from "../scanner/types.js";
import type { LlmScanInput, LlmScanProvider, LlmProviderOptions } from "./provider.js";
import {
  LlmProviderError,
  SYSTEM_PROMPT,
  buildReport,
  parseJsonObject,
} from "./parse.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;

/**
 * Gemini LLM scan provider.
 *
 * @see {@link LlmScanProvider}
 */
export class GeminiLlmProvider implements LlmScanProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxInputChars: number;

  /**
   * @param options - Provider configuration. Env-var fallbacks:
   *   `apiKey` defaults to `process.env.GEMINI_API_KEY`.
   */
  constructor(options: LlmProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
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
    const payload = await this.request(
      {
        contents: [{ role: "user", parts: [{ text: content }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      },
      input.signal,
    );
    const parsed = parseJsonObject(payload);
    return buildReport(parsed, new Date().toISOString());
  }

  /** @inheritdoc */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    await this.request({
      contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
    });
    return true;
  }

  /**
   * Issue a POST to `models/<model>:generateContent` with timeout and
   * error normalization.
   *
   * @param body - The JSON request body.
   * @param signal - Optional external abort signal combined with the owned
   *   timeout controller via `AbortSignal.any`. An external abort propagates
   *   as `DOMException('The operation was aborted.', 'AbortError')`.
   * @returns The `candidates[0].content.parts[0].text` string from the
   *   response.
   * @throws {LlmProviderError} On network, timeout, HTTP, or shape errors.
   * @throws {DOMException} With name `AbortError` when `signal` is aborted.
   */
  private async request(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (!this.apiKey) {
      throw new LlmProviderError("LLM provider is not configured.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Combine the owned timeout controller with the external abort signal
    // so either one aborts the fetch. When no external signal is supplied
    // the owned controller is used directly.
    const combinedSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
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
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (error instanceof LlmProviderError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        // An external abort must propagate as AbortError (cooperative
        // cancellation); the owned timeout is wrapped as LlmProviderError.
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
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
 * Extract the `candidates[0].content.parts[0].text` string from a Gemini-
 * shaped `generateContent` response. Returns `undefined` when the shape
 * does not match.
 *
 * @param value - The parsed JSON response body.
 * @returns The content string, or `undefined`.
 */
function readResponseContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== "object") return undefined;
  const content = (candidate as { content?: { parts?: unknown } }).content;
  if (!content || typeof content !== "object") return undefined;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const part = parts[0];
  if (!part || typeof part !== "object") return undefined;
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}
