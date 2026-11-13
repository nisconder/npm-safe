import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { desktopLlmStatus, desktopSourceReviewBudgetMs, reviewDesktopPackageSource } from '../../desktop/resources/extensions/core/source-review.mjs';

function engineFixture(overrides: Record<string, unknown> = {}) {
  const checks: unknown[][] = [];
  const history: unknown[] = [];
  const logs: string[] = [];
  const result = {
    packageName: '@npm-safe/core', latestVersion: '2.0.1', exists: true,
    security: {
      overallScore: 92, overallLevel: 'safe',
      sourceReview: { status: 'complete', verdict: 'benign', calls: 2, sourceCharsSent: 62000,
        summary: 'MODEL_RESPONSE_MUST_NOT_BE_LOGGED', review: { source: 'SOURCE_MUST_NOT_BE_LOGGED' } },
    },
  };
  const engine = {
    getLlmStatus: () => ({ enabled: true, configured: true, sourceReview: true }),
    getLlmConfig: () => ({ timeoutMs: 240000, apiKey: 'SECRET_MUST_NOT_ESCAPE' }),
    checkPackage: async (...args: unknown[]) => { checks.push(args); return result; },
    recordCheckHistory: async (value: unknown) => { history.push(value); },
    ...overrides,
  };
  return { engine, result, checks, history, logs,
    run: (data: unknown = { name: '@npm-safe/core', version: '2.0.1' }) =>
      reviewDesktopPackageSource(engine, data, (line: string) => logs.push(line)) };
}

describe('desktop source-review backend', () => {
  it('uses the same engine deep-check path with the exact selected version and records its result', async () => {
    const test = engineFixture();
    assert.equal(await test.run(), test.result);
    assert.equal(test.checks.length, 1);
    const [name, options] = test.checks[0] as [string, { version: string; deep: boolean; forceRefresh: boolean; signal: AbortSignal }];
    assert.equal(name, '@npm-safe/core');
    assert.deepEqual({ ...options, signal: undefined }, { version: '2.0.1', deep: true, forceRefresh: true, signal: undefined });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(test.history, [test.result]);
    assert.equal(JSON.parse(test.logs[0]).status, 'started');
    const log = JSON.parse(test.logs.at(-1)!);
    assert.equal(log.status, 'complete');
    assert.equal(log.calls, 2);
    assert.equal(log.sourceCharsSent, 62000);
    assert.ok(log.elapsedMs >= 0);
    assert.equal(log.verdict, 'benign');
    assert.deepEqual(Object.keys(log).sort(), ['calls', 'elapsedMs', 'name', 'sourceCharsSent', 'status', 'verdict', 'version']);
    assert.doesNotMatch(test.logs.join(''), /SECRET|SOURCE_MUST|MODEL_RESPONSE/);
  });

  it('rejects non-registry names and non-exact versions before checking or reading configuration', async () => {
    const test = engineFixture({ getLlmStatus: () => { throw new Error('must not read status'); } });
    for (const name of [null, '', 'lodash@4.17.21', '../local', 'github:owner/repo', 'https://example.test/tool', '@scope/name/extra', 'pkg\n', 'a'.repeat(215)]) {
      await assert.rejects(test.run({ name, version: '1.2.3' }), /有效的 npm 包名/);
    }
    for (const version of [null, '', 'latest', '^1.2.3', '1.2', 'v1.2.3', '01.2.3', '1.2.3-01', '1.2.3\n', 'a'.repeat(257)]) {
      await assert.rejects(test.run({ name: 'lodash', version }), /固定的完整版本号/);
    }
    assert.equal(test.checks.length, 0);
    assert.equal(test.history.length, 0);
  });

  it('requires enabled, configured source review without altering user configuration', async () => {
    for (const status of [
      { enabled: false, configured: true, sourceReview: true },
      { enabled: true, configured: false, sourceReview: true },
      { enabled: true, configured: true, sourceReview: false },
      { enabled: true, configured: true },
    ]) {
      const test = engineFixture({ getLlmStatus: () => status, setLlmConfig: () => { throw new Error('must not change config'); } });
      await assert.rejects(test.run(), /源码复核|LLM/);
      assert.equal(test.checks.length, 0);
      assert.equal(test.history.length, 0);
    }
  });

  it('propagates check failures and rejects missing or mismatched results without recording success', async () => {
    const failure = engineFixture({ checkPackage: async () => { throw new Error('provider unavailable'); } });
    await assert.rejects(failure.run(), /provider unavailable/);
    assert.equal(failure.history.length, 0);
    assert.equal(JSON.parse(failure.logs.at(-1)!).status, 'failed');
    for (const result of [
      { exists: false },
      { exists: true, packageName: 'different', latestVersion: '2.0.1' },
      { exists: true, packageName: '@npm-safe/core', latestVersion: '2.0.0' },
      { exists: true, packageName: '@npm-safe/core', latestVersion: '2.0.1', security: {} },
    ]) {
      const test = engineFixture({ checkPackage: async () => result });
      await assert.rejects(test.run(), /引擎未返回/);
      assert.equal(test.history.length, 0);
    }
  });

  it('returns failed or skipped reviews honestly instead of manufacturing a completed verdict', async () => {
    for (const status of ['failed', 'skipped']) {
      const result = { packageName: '@npm-safe/core', latestVersion: '2.0.1', exists: true,
        security: { overallLevel: 'unknown', sourceReview: { status, verdict: 'unknown', reason: 'No final answer', calls: 1, sourceCharsSent: 12000 } } };
      const test = engineFixture({ checkPackage: async () => result });
      assert.equal(await test.run(), result);
      assert.equal(JSON.parse(test.logs.at(-1)!).status, status);
      assert.deepEqual(test.history, [result]);
    }
  });

  it('exposes only the masked status and numeric timeout rather than the raw configuration', () => {
    const test = engineFixture();
    const status = desktopLlmStatus(test.engine);
    assert.equal(status.timeoutMs, 240000);
    assert.doesNotMatch(JSON.stringify(status), /SECRET_MUST_NOT_ESCAPE|apiKey/);
    for (const timeoutMs of [undefined, null, -1, 0, NaN, Infinity, '30000', 2 ** 31]) {
      assert.equal(desktopLlmStatus({ ...test.engine, getLlmConfig: () => ({ timeoutMs }) }).timeoutMs, 30000);
    }
  });

  it('budgets two provider calls plus metadata time without exceeding native timer limits', () => {
    assert.equal(desktopSourceReviewBudgetMs(30000), 180000);
    assert.equal(desktopSourceReviewBudgetMs(240000), 600000);
    assert.equal(desktopSourceReviewBudgetMs(2147483647), 2147473647);
  });

  it('prevents concurrent requests for the same release and releases the guard after failure', async () => {
    let rejectCheck: (error: Error) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const test = engineFixture({ checkPackage: async () => {
      markStarted();
      return new Promise((_resolve, reject) => { rejectCheck = reject; });
    } });
    const first = test.run();
    await started;
    await assert.rejects(test.run(), /正在进行/);
    rejectCheck(new DOMException('Deadline reached', 'TimeoutError'));
    await assert.rejects(first, /Deadline reached/);
    assert.equal(test.history.length, 0);
    test.engine.checkPackage = async () => test.result;
    assert.equal(await test.run(), test.result);
  });

  it('does not record or return a completed result after the backend deadline has expired', async (context) => {
    const expired = AbortSignal.abort(new DOMException('Source-review deadline reached', 'TimeoutError'));
    context.mock.method(AbortSignal, 'timeout', (budget: number) => {
      assert.equal(budget, 600000);
      return expired;
    });
    const test = engineFixture();
    await assert.rejects(test.run(), /Source-review deadline reached/);
    assert.equal(test.history.length, 0);
    assert.equal(JSON.parse(test.logs.at(-1)!).status, 'failed');
  });
});
