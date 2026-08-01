import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicLlmProvider,
  LlmProviderError,
} from "../src/llm/provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AnthropicLlmProvider", () => {
  it("returns a validated LLM report from a messages call", async () => {
    let requestUrl: URL | undefined;
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url, init) => {
      requestUrl = new URL(String(url));
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: "OK",
            functionalMatch: true,
            suspiciousScore: 7,
            findings: [{
              ruleId: "llm-y",
              ruleName: "Y",
              severity: "medium",
              message: "M",
              category: "suspicious-dependency",
            }],
          }),
        }],
        model: "claude-3-5-sonnet-latest",
        role: "assistant",
        stop_reason: "end_turn",
      }), { status: 200 });
    }) as typeof fetch;

    const provider = new AnthropicLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const report = await provider.scan({
      packageName: "demo",
      version: "1.0.0",
      description: "Demo package",
      readme: "README",
    });

    assert.strictEqual(report.enabled, true);
    assert.strictEqual(report.suspiciousScore, 7);
    assert.strictEqual(report.findings?.[0]?.severity, "medium");

    assert.ok(
      requestUrl?.href.endsWith("/v1/messages"),
      `expected URL ending with /v1/messages, got ${requestUrl?.href}`,
    );
    assert.strictEqual(requestHeaders?.get("x-api-key"), "test-key");
    assert.strictEqual(requestHeaders?.get("anthropic-version"), "2023-06-01");

    assert.strictEqual(requestBody?.model, "claude-3-5-sonnet-latest");
    assert.strictEqual(typeof requestBody?.max_tokens, "number");
    assert.strictEqual(requestBody?.max_tokens, 2000);
    assert.strictEqual(requestBody?.temperature, 0);
    assert.strictEqual(typeof requestBody?.system, "string");
    assert.ok(
      String(requestBody?.system).includes("npm package security analyst"),
      "system prompt should mention 'npm package security analyst'",
    );
    const messages = requestBody?.messages as { role: string; content: string }[] | undefined;
    assert.strictEqual(messages?.[0]?.role, "user");
    assert.strictEqual(typeof messages?.[0]?.content, "string");
    const content = JSON.parse(String(messages?.[0]?.content)) as Record<string, unknown>;
    assert.strictEqual(content.packageName, "demo");
    assert.strictEqual(content.version, "1.0.0");
    assert.strictEqual(content.description, "Demo package");
    assert.strictEqual(content.readme, "README");
  });

  it("is disabled without an API key", async () => {
    const provider = new AnthropicLlmProvider({ apiKey: "" });
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
      content: [{ type: "text", text: "not json" }],
    }), { status: 200 })) as typeof fetch;
    const provider = new AnthropicLlmProvider({ apiKey: "test-key" });
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

  it("throws when response has no content", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [],
    }), { status: 200 })) as typeof fetch;
    const provider = new AnthropicLlmProvider({ apiKey: "test-key" });
    await assert.rejects(
      provider.scan({
        packageName: "demo",
        version: "1.0.0",
        description: "",
        readme: "",
      }),
      (error: unknown) => error instanceof LlmProviderError &&
        error.message.includes("no content"),
    );
  });
});