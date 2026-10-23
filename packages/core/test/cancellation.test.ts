import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NpmSafeEngine } from '../src/index.js';
import { NpmRegistryClient } from '../src/registry/client.js';
import { TokenBucket } from '../src/scheduler/rate-limiter.js';
import {
  OpenAICompatibleLlmProvider, GeminiLlmProvider, AnthropicLlmProvider,
} from '../src/llm/provider.js';

const originalFetch = globalThis.fetch;
const engines: NpmSafeEngine[] = [];
const limiters: TokenBucket[] = [];
const directories: string[] = [];
const metadata = {
  name: 'cancel-pkg', modified: '2026-01-01T00:00:00.000Z',
  'dist-tags': { latest: '1.0.0' }, readme: '',
  versions: {
    '1.0.0': {
      name: 'cancel-pkg', version: '1.0.0', scripts: {},
      dist: { tarball: 'https://registry.npmjs.org/cancel-pkg/-/cancel-pkg-1.0.0.tgz' },
    },
  },
};

function createEngine(options: { cacheTtlMs?: number } = {}): NpmSafeEngine {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-safe-abort-'));
  directories.push(dir);
  const engine = new NpmSafeEngine({
    ...options, dbPath: ':memory:', rateLimit: 100, rateLimitBurst: 100,
    rulesConfigPath: path.join(dir, 'rules.json'),
    llmConfigPath: path.join(dir, 'llm.json'), rulesDir: path.join(dir, 'rules'),
  });
  engines.push(engine);
  return engine;
}

/** The request resolves only when its actual fetch signal is aborted. */
function blockingFetch() {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const fetch = ((_url: unknown, init?: RequestInit) => {
    calls++;
    started();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }) as typeof globalThis.fetch;
  return { fetch, entered, get calls() { return calls; } };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const engine of engines.splice(0)) engine.close();
  for (const limiter of limiters.splice(0)) limiter.dispose();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cooperative cancellation', () => {
  it('aborts an in-flight registry fetch without retrying, including custom abort reasons', async () => {
    const controller = new AbortController();
    const blocked = blockingFetch();
    globalThis.fetch = blocked.fetch;
    const pending = new NpmRegistryClient().getPackageMetadata('cancel-pkg', { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await blocked.entered;
    controller.abort('user cancelled');
    await rejected;
    assert.equal(blocked.calls, 1);
  });

  it('cancels during registry retry backoff before a second fetch is attempted', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('', { status: 503 });
    }) as typeof fetch;
    const start = Date.now();
    const pending = new NpmRegistryClient().getPackageMetadata('cancel-pkg', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(pending, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    assert.equal(calls, 1);
    assert.ok(Date.now() - start < 900, 'abort should interrupt the one-second retry delay');
  });

  it('removes a cancelled rate-limit waiter and rejects promptly', async () => {
    const limiter = new TokenBucket(0.001, 1);
    limiters.push(limiter);
    await limiter.consume();
    const controller = new AbortController();
    const pending = limiter.consume(1, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    // Disposing after cancellation must not create a second rejection.
    limiter.dispose();
  });

  it('does not turn an interrupted deep download into an incomplete successful result', async () => {
    const engine = createEngine();
    const controller = new AbortController();
    const blocked = blockingFetch();
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      url.endsWith('.tgz') ? blocked.fetch(url, init) :
        Promise.resolve(new Response(JSON.stringify(metadata)))) as typeof fetch;
    const pending = engine.checkPackage('cancel-pkg', { deep: true, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await blocked.entered;
    controller.abort();
    await rejected;
  });

  it('rejects a cancelled batch instead of converting cancellation into package errors', async () => {
    const engine = createEngine();
    const controller = new AbortController();
    const blocked = blockingFetch();
    globalThis.fetch = blocked.fetch;
    const pending = engine.checkPackages(['cancel-pkg', 'remaining'], { concurrency: 1, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await blocked.entered;
    controller.abort();
    await rejected;
    assert.equal(blocked.calls, 1);
  });

  it('propagates cancellation from a refresh and from the stale-package refresh batch', async () => {
    const engine = createEngine({ cacheTtlMs: 0 });
    globalThis.fetch = (async () => new Response(JSON.stringify(metadata))) as typeof fetch;
    await engine.checkPackage('cancel-pkg');
    await new Promise(resolve => setTimeout(resolve, 10));
    for (const refresh of [
      (signal: AbortSignal) => engine.refreshPackage('cancel-pkg', { signal }),
      (signal: AbortSignal) => engine.refreshAll({ signal }),
    ]) {
      const controller = new AbortController();
      const blocked = blockingFetch();
      globalThis.fetch = blocked.fetch;
      const pending = refresh(controller.signal);
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      await blocked.entered;
      controller.abort();
      await rejected;
      assert.equal(blocked.calls, 1);
    }
  });

  for (const Provider of [OpenAICompatibleLlmProvider, GeminiLlmProvider, AnthropicLlmProvider]) {
    it(`${Provider.name} forwards an abort without normalizing it to a scan failure`, async () => {
      const controller = new AbortController();
      const blocked = blockingFetch();
      globalThis.fetch = blocked.fetch;
      const provider = new Provider({ apiKey: 'test-key' });
      const pending = provider.scan({
        packageName: 'cancel-pkg', version: '1.0.0', description: '', readme: '',
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      await blocked.entered;
      controller.abort('user cancelled');
      await rejected;
    });
  }
});
