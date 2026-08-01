import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAICompatibleLlmProvider,
  LlmProviderError,
} from "../src/llm/provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAICompatibleLlmProvider", () => {
  it("returns a validated LLM report from a chat completion", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "The package behavior matches its description.",
              functionalMatch: true,
              suspiciousScore: 12,
              findings: [{
                ruleId: "llm-network",
                ruleName: "Unexpected network behavior",
                severity: "high",
                message: "The README requests an unexplained remote script.",
                recommendation: "Verify the remote script source.",
                category: "informational",
              }],
            }),
          },
        }],
      }), { status: 200 });
    }) as typeof fetch;

    const provider = new OpenAICompatibleLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
    });
    const report = await provider.scan({
      packageName: "demo",
      version: "1.0.0",
      description: "Demo package",
      readme: "README",
    });

    assert.strictEqual(report.enabled, true);
    assert.strictEqual(report.suspiciousScore, 12);
    assert.strictEqual(report.findings?.[0]?.severity, "high");
    assert.strictEqual((requestBody?.model), "gpt-4o-mini");
  });

  it("is disabled without an API key", async () => {
    const provider = new OpenAICompatibleLlmProvider({ apiKey: "" });
    const report = await provider.scan({
      packageName: "demo",
      version: "1.0.0",
      description: "",
      readme: "",
    });
    assert.deepStrictEqual(report, {
      enabled: false,
      reason: "LLM provider is not configured.",
    });
  });

  it("rejects malformed model responses", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not json" } }],
    }), { status: 200 })) as typeof fetch;
    const provider = new OpenAICompatibleLlmProvider({ apiKey: "test-key" });
    await assert.rejects(
      provider.scan({
        packageName: "demo",
        version: "1.0.0",
        description: "",
        readme: "",
      }),
      (error: unknown) => error instanceof LlmProviderError &&
        error.message.includes("invalid JSON"),
    );
  });
});
