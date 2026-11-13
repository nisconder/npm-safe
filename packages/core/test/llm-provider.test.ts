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

describe("OpenAI-compatible completion diagnostics", () => {
  const sourceInput = { systemPrompt: "Return only a JSON review.", prompt: "{}" };
  const provider = () => new OpenAICompatibleLlmProvider({
    apiKey: "fixture-key-must-not-appear", baseUrl: "https://example.invalid", model: "deepseek-flash", maxTokens: 4096,
  });

  function respond(content: unknown, finishReason: unknown = "stop", reasoning?: string): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{
        finish_reason: finishReason,
        message: { content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) },
      }] }));
    }) as typeof fetch;
    return () => calls;
  }

  it("identifies reasoning-only output exhaustion without retrying or leaking response text", async () => {
    const reason = "private-reasoning-must-not-appear";
    let calls = 0;
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: null, reasoning_content: reason } }] }));
    }) as typeof fetch;
    await assert.rejects(provider().reviewSource(sourceInput), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.match(error.message, /finish_reason=length.*max_tokens=4096/);
      assert.match(error.message, /Only reasoning content.*final answer is empty/);
      assert.match(error.message, /Increase max output tokens or reduce the request/);
      assert.doesNotMatch(error.message, /private-reasoning|fixture-key|network|HTTP/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(request?.max_tokens, 4096);
    assert.equal(request?.thinking, undefined);
    assert.equal(request?.reasoning_effort, undefined);
  });

  it("rejects length-limited content even when the partial response happens to parse as JSON", async () => {
    const calls = respond('{"verdict":"benign"}', "length");
    await assert.rejects(provider().reviewSource(sourceInput), /output budget.*finish_reason=length/);
    await assert.rejects(provider().testConnection(), /output budget.*finish_reason=length/);
    assert.equal(calls(), 2);
  });

  it("does not accept reasoning as a final source review or a successful connection", async () => {
    respond("", "stop", "private-reasoning-must-not-appear");
    for (const invoke of [() => provider().reviewSource(sourceInput), () => provider().testConnection()]) {
      await assert.rejects(invoke(), (error: unknown) => {
        assert.ok(error instanceof LlmProviderError);
        assert.match(error.message, /reasoning content but no final answer/);
        assert.doesNotMatch(error.message, /private-reasoning/);
        return true;
      });
    }
  });

  it("diagnoses JSON-mode whitespace separately and rejects blank connection responses", async () => {
    respond(" \n\t ");
    await assert.rejects(provider().reviewSource(sourceInput), /only whitespace in JSON mode/);
    await assert.rejects(provider().testConnection(), /only whitespace and no usable final answer/);
  });

  for (const [state, diagnostic] of [
    ["content_filter", /content filter.*finish_reason=content_filter/],
    ["insufficient_system_resource", /provider resource limits.*finish_reason=insufficient_system_resource/],
    ["aborted", /aborted by the provider.*finish_reason=aborted/],
    ["tool_calls", /tool call instead of a final answer/],
    ["unexpected-private-state", /unsupported completion state/],
  ] as const) {
    it(`rejects the ${state} completion state without accepting its content`, async () => {
      respond('{"verdict":"benign"}', state);
      await assert.rejects(provider().reviewSource(sourceInput), (error: unknown) => {
        assert.ok(error instanceof LlmProviderError);
        assert.match(error.message, diagnostic);
        assert.doesNotMatch(error.message, /unexpected-private-state|HTTP|request failed/);
        return true;
      });
    });
  }

  it("accepts a completed final answer while keeping reasoning separate", async () => {
    const result = '{"verdict":"unknown"}';
    respond(result, "stop", "private reasoning");
    assert.equal(await provider().reviewSource(sourceInput), result);
    respond("OK");
    assert.equal(await provider().testConnection(), true);
  });

  it("preserves HTTP status and timeout diagnostics", async () => {
    globalThis.fetch = (async () => new Response("redacted", { status: 401 })) as typeof fetch;
    await assert.rejects(provider().reviewSource(sourceInput), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, "LLM request failed with HTTP 401.");
      return true;
    });
    globalThis.fetch = (async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const timed = new OpenAICompatibleLlmProvider({ apiKey: "fixture", timeoutMs: 5 });
    await assert.rejects(timed.reviewSource(sourceInput), { message: "LLM request timed out." });
  });
});
