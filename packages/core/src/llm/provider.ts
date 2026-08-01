import {
  FindingCategory,
  Severity,
  type LlmScanReport,
  type ScanFinding,
} from "../scanner/types.js";

export interface LlmScanInput {
  readonly packageName: string;
  readonly version: string;
  readonly description: string;
  readonly readme: string;
  readonly packageJson?: Record<string, unknown>;
}

export interface LlmScanProvider {
  scan(input: LlmScanInput): Promise<LlmScanReport>;
  testConnection(): Promise<boolean>;
}

export interface OpenAICompatibleLlmOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxInputChars?: number;
}

export class LlmProviderError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "LlmProviderError";
  }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;

const SYSTEM_PROMPT = `You are an npm package security analyst. Analyze the supplied package metadata and README for semantic risks that static rules may miss. Return only a JSON object with this exact shape:
{"summary":"string","functionalMatch":true,"suspiciousScore":0,"findings":[{"ruleId":"llm-...","ruleName":"string","severity":"low|medium|high|critical","message":"string","recommendation":"string","category":"informational|known-malicious|suspicious-dependency|sensitive-exposure|code-obfuscation|binary-download|install-script|typosquatting|homograph-attack|registry-mismatch"}]}
suspiciousScore is 0-100, where higher means more suspicious. Do not invent evidence that is not present in the input. Use an empty findings array when no concern is found.`;

export class OpenAICompatibleLlmProvider implements LlmScanProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxInputChars: number;

  constructor(options: OpenAICompatibleLlmOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  }

  async scan(input: LlmScanInput): Promise<LlmScanReport> {
    if (!this.apiKey) {
      return {
        enabled: false,
        reason: "LLM provider is not configured.",
      };
    }

    const content = JSON.stringify({
      packageName: input.packageName,
      version: input.version,
      description: input.description,
      readme: input.readme.slice(0, this.maxInputChars),
      packageJson: input.packageJson,
    });
    const payload = await this.request({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    });
    const parsed = parseJsonObject(payload);
    return {
      enabled: true,
      summary: readOptionalString(parsed.summary),
      functionalMatch: readOptionalBoolean(parsed.functionalMatch),
      suspiciousScore: clampScore(readOptionalNumber(parsed.suspiciousScore) ?? 0),
      findings: parseFindings(parsed.findings),
      scannedAt: new Date().toISOString(),
    };
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    await this.request({
      model: this.model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 3,
    });
    return true;
  }

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

function readResponseContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = choices[0];
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content : undefined;
}

function parseJsonObject(content: string): Record<string, unknown> {
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

function parseFindings(value: unknown): readonly ScanFinding[] {
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

function readSeverity(value: unknown): Severity {
  return value === Severity.Critical || value === Severity.High ||
    value === Severity.Medium || value === Severity.Low
    ? value
    : Severity.Medium;
}

function readCategory(value: unknown): FindingCategory {
  return Object.values(FindingCategory).includes(value as FindingCategory)
    ? value as FindingCategory
    : FindingCategory.Informational;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
