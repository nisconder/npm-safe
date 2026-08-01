/**
 * Shared parse/validation helpers for LLM scan providers.
 *
 * This module extracts the JSON-parsing, finding-validation, and report-
 * assembly helpers that are common to every OpenAI-compatible LLM provider
 * (OpenAI, Gemini, Anthropic, …) so each provider can reuse them instead of
 * duplicating logic.
 */

import {
  FindingCategory,
  Severity,
  type LlmScanReport,
  type ScanFinding,
} from "../scanner/types.js";

/**
 * Error thrown when an LLM provider request or response is invalid.
 */
export class LlmProviderError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/**
 * System prompt instructing the model to act as an npm package security
 * analyst and return a JSON object with a fixed shape.
 */
export const SYSTEM_PROMPT = `You are an npm package security analyst. Analyze the supplied package metadata and README for semantic risks that static rules may miss. Return only a JSON object with this exact shape:
{"summary":"string","functionalMatch":true,"suspiciousScore":0,"findings":[{"ruleId":"llm-...","ruleName":"string","severity":"low|medium|high|critical","message":"string","recommendation":"string","category":"informational|known-malicious|suspicious-dependency|sensitive-exposure|code-obfuscation|binary-download|install-script|typosquatting|homograph-attack|registry-mismatch"}]}
suspiciousScore is 0-100, where higher means more suspicious. Do not invent evidence that is not present in the input. Use an empty findings array when no concern is found.`;

/**
 * Parse a raw LLM response string into a JSON object.
 *
 * Strips ```json fences, parses the content, and rejects non-object values
 * (arrays, primitives, or invalid JSON) by throwing {@link LlmProviderError}.
 *
 * @param content - Raw text returned by the LLM.
 * @returns The parsed JSON object.
 * @throws {LlmProviderError} When the content is not a valid JSON object.
 */
export function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = content.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new LlmProviderError(
      `LLM returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse an unknown value into a list of validated scan findings.
 *
 * Non-array inputs yield an empty array. Items that are not objects or that
 * lack a `message` field are dropped. Each surviving item is mapped to a
 * {@link ScanFinding} with normalized severity and category.
 *
 * @param value - The `findings` field of a parsed LLM response.
 * @returns A readonly array of validated findings.
 */
export function parseFindings(value: unknown): readonly ScanFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const finding = item as Record<string, unknown>;
    const message = readOptionalString(finding.message);
    if (!message) return [];
    return [{
      ruleId: readOptionalString(finding.ruleId) ?? `llm-finding-${index + 1}`,
      ruleName: readOptionalString(finding.ruleName) ?? "LLM security finding",
      severity: readSeverity(finding.severity),
      message,
      recommendation: readOptionalString(finding.recommendation),
      category: readCategory(finding.category),
    }];
  });
}

/**
 * Coerce an unknown value into a {@link Severity}, defaulting to Medium.
 *
 * @param value - The `severity` field of a finding.
 * @returns The validated severity, or `Severity.Medium` if invalid.
 */
export function readSeverity(value: unknown): Severity {
  return value === Severity.Critical || value === Severity.High ||
    value === Severity.Medium || value === Severity.Low
    ? value
    : Severity.Medium;
}

/**
 * Coerce an unknown value into a {@link FindingCategory}, defaulting to
 * Informational.
 *
 * @param value - The `category` field of a finding.
 * @returns The validated category, or `FindingCategory.Informational` if invalid.
 */
export function readCategory(value: unknown): FindingCategory {
  return Object.values(FindingCategory).includes(value as FindingCategory)
    ? value as FindingCategory
    : FindingCategory.Informational;
}

/**
 * Return the value if it is a string, otherwise `undefined`.
 *
 * @param value - An arbitrary unknown value.
 * @returns The string value, or `undefined`.
 */
export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Return the value if it is a boolean, otherwise `undefined`.
 *
 * @param value - An arbitrary unknown value.
 * @returns The boolean value, or `undefined`.
 */
export function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Return the value if it is a finite number, otherwise `undefined`.
 *
 * @param value - An arbitrary unknown value.
 * @returns The finite number, or `undefined`.
 */
export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Clamp a numeric score to the 0-100 range, rounding to the nearest integer.
 *
 * @param value - The raw numeric score.
 * @returns The clamped integer score between 0 and 100.
 */
export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Assemble the final {@link LlmScanReport} from a parsed LLM JSON object.
 *
 * @param parsed - The JSON object returned by {@link parseJsonObject}.
 * @param scannedAt - ISO 8601 timestamp marking when the scan ran.
 * @returns A populated LLM scan report with `enabled: true`.
 */
export function buildReport(
  parsed: Record<string, unknown>,
  scannedAt: string,
): LlmScanReport {
  return {
    enabled: true,
    summary: readOptionalString(parsed.summary),
    functionalMatch: readOptionalBoolean(parsed.functionalMatch),
    suspiciousScore: clampScore(readOptionalNumber(parsed.suspiciousScore) ?? 0),
    findings: parseFindings(parsed.findings),
    scannedAt,
  };
}