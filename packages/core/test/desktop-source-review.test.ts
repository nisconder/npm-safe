import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../desktop/resources/js/main.js', import.meta.url), 'utf8')
  .split('Neutralino.init();')[0];

function assessment(name = 'example', version = '1.2.3', sourceKind = 'npm') {
  return { packageKind: 'npm', packageName: name, version, sourceKind, sourceLabel: 'npm registry',
    sourceUrl: 'https://www.npmjs.com/package/example', riskLevel: 'low', safetyScore: 100,
    summary: '静态检查完成', checks: [], findings: [], safeInstallCommand: `npm install ${name}@${version}`,
    inspectedAt: '2026-11-13T12:00:00Z', integrityVerified: true };
}

function report(overrides: Record<string, unknown> = {}) {
  return { status: 'complete', verdict: 'benign', calls: 2, sourceCharsSent: 112309,
    summary: '未发现恶意证据', findings: [], coverage: { sourceCoverage: 'partial', shownFiles: 3,
      candidateFiles: 7, shownChars: 60000, decodedChars: 120000, caveat: '部分源码未覆盖。' }, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function page(options: { status?: Record<string, unknown>; review?: (data: any) => Promise<any> } = {}) {
  const status = { enabled: true, configured: true, sourceReview: true, provider: 'openai', timeoutMs: 240000, ...options.status };
  const calls: { method: string; data: any; options?: any }[] = [];
  const parts: Record<string, any> = {};
  let rootHtml = '';
  let settingsOpened = 0;
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function button() {
    return { disabled: false, listeners: new Map<string, any>(), addEventListener(name: string, fn: any) { this.listeners.set(name, fn); },
      click() { return this.disabled ? undefined : this.listeners.get('click')?.(); } };
  }
  const panel = {
    html: '', get innerHTML() { return this.html; }, set innerHTML(html: string) {
      this.html = html;
      parts['[data-source-review]'] = button();
      parts['[data-source-review]'].disabled = /data-source-review\s+disabled/.test(html);
      parts['[data-open-llm-settings]'] = html.includes('data-open-llm-settings') ? button() : null;
    },
  };
  const area = {
    get innerHTML() { return rootHtml; }, set innerHTML(html: string) {
      rootHtml = html;
      for (const key of Object.keys(parts)) delete parts[key];
      const classes = new Set(html.match(/class="install-risk-card ([^"]+)"/)?.[1].split(' ') ?? []);
      parts['[data-risk-card]'] = { classList: { toggle(name: string, on: boolean) { on ? classes.add(name) : classes.delete(name); }, contains: (name: string) => classes.has(name) } };
      parts['[data-risk-verdict]'] = { innerHTML: html.match(/data-risk-verdict>([\s\S]*?)<\/div>/)?.[1] ?? '' };
      if (html.includes('data-source-review-panel')) {
        parts['[data-source-review-panel]'] = panel;
        panel.innerHTML = html.match(/data-source-review-panel[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
      }
    }, querySelector(selector: string) { return parts[selector] ?? null; },
  };
  const elements: Record<string, any> = { 'check-result': area };
  for (const id of ['check-name', 'check-target-kind', 'check-btn', 'status-bar', 'llm-enabled', 'llm-source-review',
    'llm-status-text', 'llm-provider', 'llm-api-key', 'llm-api-key-hint', 'llm-model', 'llm-base-url',
    'llm-reasoning-effort', 'llm-max-tokens', 'llm-max-input-chars', 'llm-result', 'llm-save-btn', 'llm-test-btn']) {
    elements[id] = { value: '', textContent: '', innerHTML: '', dataset: {}, checked: false, disabled: false };
  }
  elements['check-name'].value = 'example';
  elements['check-target-kind'].value = 'auto';
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements[id],
      querySelector: () => ({ click: () => { settingsOpened++; } }),
      createElement: () => ({ textContent: '', get innerHTML() { return escape(this.textContent); } }) },
    testCallEngine: async (method: string, data: any, opts?: any) => {
      calls.push({ method, data: JSON.parse(JSON.stringify(data)), options: opts && JSON.parse(JSON.stringify(opts)) });
      if (method === 'getLlmStatus') return status;
      if (method === 'reviewPackageSource') return options.review ? options.review(data) : { packageName: data.name, latestVersion: data.version, security: { sourceReview: report() } };
      if (method === 'assessInstallRisk') return assessment(data.input);
      if (method === 'testLlmConnection') return true;
      if (method === 'setLlmConfig' || method === 'addHistory') return;
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('callEngine = testCallEngine', context);
  return { calls, elements, parts, panel, context, status,
    render(result = assessment()) { context.testAssessment = result; vm.runInContext('renderInstallRisk(testAssessment)', context); },
    review: () => vm.runInContext('handleSourceReview(activeRiskCard)', context) as Promise<void>,
    scan: () => vm.runInContext('handleCheck()', context) as Promise<void>,
    run: (code: string) => vm.runInContext(code, context),
    get settingsOpened() { return settingsOpened; } };
}

describe('desktop explicit LLM source review', () => {
  it('offers review only for npm cards and never sends a GitHub repository to the npm reviewer', async () => {
    const view = page();
    view.render();
    assert.match(view.elements['check-result'].innerHTML, /LLM 源码复核|静态安全分/);
    view.render(assessment('org/repo', 'abcdef', 'github'));
    assert.doesNotMatch(view.elements['check-result'].innerHTML, /data-source-review/);
    assert.equal(view.calls.length, 0);
    view.render(assessment('example', 'latest'));
    await view.review();
    assert.equal(view.parts['[data-source-review]'].disabled, true);
    assert.equal(view.calls.length, 0);
  });

  it('requires saved LLM, provider, and source-review opt-ins without silently writing config', async () => {
    for (const key of ['enabled', 'configured', 'sourceReview']) {
      const view = page({ status: { [key]: false } });
      view.render();
      await view.review();
      assert.deepEqual(view.calls.map(call => call.method), ['getLlmStatus']);
      assert.match(view.panel.innerHTML, /请在 LLM 设置中/);
      view.parts['[data-open-llm-settings]'].click();
      assert.equal(view.settingsOpened, 1);
    }
  });

  it('reviews the displayed exact version with a dedicated long timeout and suppresses duplicate clicks', async () => {
    const pending = deferred<any>();
    const started = deferred<void>();
    const view = page({ review: () => { started.resolve(); return pending.promise; } });
    view.render();
    view.elements['check-name'].value = 'other@latest';
    const first = view.review();
    await started.promise;
    assert.equal(view.parts['[data-source-review]'].disabled, true);
    await view.review();
    const requests = view.calls.filter(call => call.method === 'reviewPackageSource');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].data, { name: 'example', version: '1.2.3' });
    assert.equal(requests[0].options.timeoutMs, 610000);
    pending.resolve({ packageName: 'example', latestVersion: '1.2.3', security: { sourceReview: report() } });
    await first;
    assert.equal(view.parts['[data-source-review]'].disabled, false);
    assert.match(view.panel.innerHTML, /112,309|部分源码未覆盖/);
  });

  it('prominently marks malicious source evidence high risk while retaining the separate static score', async () => {
    const view = page({ review: async () => ({ packageName: 'example', latestVersion: '1.2.3', security: {
      sourceReview: report({ verdict: 'malicious', summary: '<script>bad()</script>', findings: [{ ruleName: '<unsafe>',
        message: 'Remote execution', filePath: 'index.js', lineNumber: 8, recommendation: 'Do not install' }] }),
    } }) });
    view.render();
    await view.review();
    assert.equal(view.parts['[data-risk-card]'].classList.contains('risk-source-malicious'), true);
    assert.match(view.parts['[data-risk-verdict]'].innerHTML, /总体风险[\s\S]*High/);
    assert.match(view.elements['check-result'].innerHTML, /静态安全分/);
    assert.match(view.panel.innerHTML, /发现恶意行为|index\.js:8|Do not install/);
    assert.match(view.panel.innerHTML, /&lt;script&gt;|&lt;unsafe&gt;/);
    assert.doesNotMatch(view.panel.innerHTML, /<script>|<unsafe>/);
  });

  it('keeps failed, skipped, and unknown outcomes distinct from a benign completed review', async () => {
    for (const outcome of [{ status: 'failed', verdict: 'unknown' }, { status: 'skipped', verdict: 'unknown' }, { status: 'complete', verdict: 'unknown' }]) {
      const view = page({ review: async () => ({ packageName: 'example', latestVersion: '1.2.3', security: {
        sourceReview: report({ ...outcome, summary: '', reason: 'output budget exhausted' }),
      } }) });
      view.render();
      await view.review();
      assert.match(view.panel.innerHTML, /未执行|失败|结论未知/);
      assert.match(view.panel.innerHTML, /output budget exhausted/);
      assert.doesNotMatch(view.panel.innerHTML, /本次证据未发现恶意行为|复核成功/);
    }
  });

  it('does not let an older review replace a newly displayed package or its verdict', async () => {
    const pending = deferred<any>();
    const started = deferred<void>();
    const view = page({ review: () => { started.resolve(); return pending.promise; } });
    view.render();
    const first = view.review();
    await started.promise;
    view.render(assessment('other', '2.0.0'));
    const before = view.panel.innerHTML;
    pending.resolve({ packageName: 'example', latestVersion: '1.2.3', security: { sourceReview: report({ verdict: 'malicious' }) } });
    await first;
    assert.equal(view.panel.innerHTML, before);
    assert.equal(view.parts['[data-risk-card]'].classList.contains('risk-source-malicious'), false);
    assert.match(view.parts['[data-risk-verdict]'].innerHTML, /Low/);
  });

  it('rejects a backend result for another version and restores the review button', async () => {
    const view = page({ review: async () => ({ packageName: 'example', latestVersion: '9.0.0', security: { sourceReview: report() } }) });
    view.render();
    await view.review();
    assert.match(view.panel.innerHTML, /包或版本与当前风险卡不一致/);
    assert.equal(view.parts['[data-source-review]'].disabled, false);
  });

  it('re-enables a rescanned version after the old task ends without copying its old result', async () => {
    const pending = deferred<any>();
    const started = deferred<void>();
    const view = page({ review: () => { started.resolve(); return pending.promise; } });
    view.render();
    const first = view.review();
    await started.promise;
    view.render();
    assert.equal(view.parts['[data-source-review]'].disabled, true);
    await view.review();
    assert.equal(view.calls.filter(call => call.method === 'reviewPackageSource').length, 1);
    pending.resolve({ packageName: 'example', latestVersion: '1.2.3', security: { sourceReview: report({ verdict: 'malicious' }) } });
    await first;
    assert.equal(view.parts['[data-source-review]'].disabled, false);
    assert.doesNotMatch(view.panel.innerHTML, /发现恶意行为|本次证据未发现恶意行为/);
    assert.equal(view.parts['[data-risk-card]'].classList.contains('risk-source-malicious'), false);
  });

  it('loads and persists the explicit source-review switch, including disabling it', async () => {
    const view = page();
    await view.run('renderLlmConfig()');
    assert.equal(view.elements['llm-source-review'].checked, true);
    view.elements['llm-source-review'].checked = false;
    await view.run('handleLlmSave()');
    assert.equal(view.calls.find(call => call.method === 'setLlmConfig')?.data.sourceReview, false);
    await view.run('handleLlmTest()');
    assert.equal(view.calls.filter(call => call.method === 'setLlmConfig').at(-1)?.data.sourceReview, true);
  });

  it('shows only the number of exact-quote coordinate corrections without changing the source verdict', async () => {
    const auditEntry = { findingIndex: 0, evidenceIndex: 0, originalStartOffset: 987654,
      originalEndOffset: 987699, startOffset: 12, endOffset: 20, extra: '<unsafe-audit-value>' };
    const result = { packageName: 'example', latestVersion: '1.2.3', security: {
      sourceReview: report({ verdict: 'malicious', evidenceOffsetCorrections: [auditEntry, auditEntry] }),
    } };
    const before = JSON.stringify(result);
    const view = page({ review: async () => result });
    view.render();
    await view.review();
    assert.match(view.panel.innerHTML, /唯一逐字引用校正 2 处坐标；引用仍经过完整校验/);
    assert.doesNotMatch(view.panel.innerHTML, /987654|originalStartOffset|unsafe-audit-value/);
    assert.match(view.parts['[data-risk-verdict]'].innerHTML, /High/);
    assert.equal(JSON.stringify(result), before);
  });

  it('omits correction notices for absent, empty, or malformed correction arrays', async () => {
    for (const value of [undefined, [], { length: 5 }]) {
      const view = page({ review: async () => ({ packageName: 'example', latestVersion: '1.2.3', security: {
        sourceReview: report({ evidenceOffsetCorrections: value }),
      } }) });
      view.render();
      await view.review();
      assert.doesNotMatch(view.panel.innerHTML, /逐字引用校正/);
    }
  });
});

describe('desktop optional reasoning effort', () => {
  it('loads each explicit effort and leaves the service default unset', async () => {
    for (const effort of [undefined, 'none', 'low', 'high', 'max']) {
      const view = page({ status: { reasoningEffort: effort } });
      await view.run('renderLlmConfig()');
      assert.equal(view.elements['llm-reasoning-effort'].value, effort ?? '');
      assert.equal(view.elements['llm-reasoning-effort'].disabled, false);
      assert.deepEqual(view.calls.map(call => call.method), ['getLlmStatus']);
    }
  });

  it('saves explicit efforts and reloads the saved value', async () => {
    for (const effort of ['none', 'low', 'high', 'max']) {
      const view = page();
      await view.run('renderLlmConfig()');
      view.elements['llm-reasoning-effort'].value = effort;
      await view.run('handleLlmSave()');
      const update = view.calls.find(call => call.method === 'setLlmConfig')!.data;
      assert.equal(update.reasoningEffort, effort);
      Object.assign(view.status, { reasoningEffort: update.reasoningEffort });
      await view.run('renderLlmConfig()');
      assert.equal(view.elements['llm-reasoning-effort'].value, effort);
    }
  });

  it('sends null to clear an explicit effort when the user selects the default', async () => {
    const view = page({ status: { reasoningEffort: 'high' } });
    await view.run('renderLlmConfig()');
    view.elements['llm-reasoning-effort'].value = '';
    await view.run('handleLlmSave()');
    assert.equal(view.calls.find(call => call.method === 'setLlmConfig')!.data.reasoningEffort, null);
    Object.assign(view.status, { reasoningEffort: undefined });
    await view.run('renderLlmConfig()');
    assert.equal(view.elements['llm-reasoning-effort'].value, '');
  });

  it('applies the selected effort to connection tests, including returning to the default', async () => {
    const view = page();
    await view.run('renderLlmConfig()');
    for (const effort of ['none', 'low', 'high', 'max', '']) {
      view.elements['llm-reasoning-effort'].value = effort;
      await view.run('handleLlmTest()');
      assert.equal(view.calls.filter(call => call.method === 'setLlmConfig').at(-1)!.data.reasoningEffort, effort || null);
    }
  });

  it('disables unsupported providers without clearing or writing the stored effort', async () => {
    for (const provider of ['gemini', 'anthropic']) {
      const view = page({ status: { provider, reasoningEffort: 'high' } });
      await view.run('renderLlmConfig()');
      assert.equal(view.elements['llm-reasoning-effort'].disabled, true);
      assert.equal(view.elements['llm-reasoning-effort'].value, 'high');
      await view.run('handleLlmSave()');
      await view.run('handleLlmTest()');
      for (const call of view.calls.filter(call => call.method === 'setLlmConfig')) {
        assert.equal(Object.hasOwn(call.data, 'reasoningEffort'), false);
      }
      view.elements['llm-provider'].value = 'openai';
      view.run('updateLlmReasoningAvailability()');
      assert.equal(view.elements['llm-reasoning-effort'].disabled, false);
      assert.equal(view.elements['llm-reasoning-effort'].value, 'high');
    }
  });
});

describe('desktop source-review IPC deadlines', () => {
  it('keeps ordinary IPC at 30 seconds while registering and resolving the longer review response', async () => {
    const timers = new Map<number, { fn: () => void; delay: number }>();
    const handlers = new Map<string, (event: any) => void>();
    const requests: any[] = [];
    let sequence = 0;
    const context = vm.createContext({ crypto: { randomUUID: () => `id-${++sequence}` },
      setTimeout: (fn: () => void, delay: number) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
      Neutralino: { events: { on: (name: string, fn: any) => handlers.set(name, fn) }, extensions: {
        dispatch: (_id: string, method: string, data: any) => { requests.push({ method, data }); return Promise.resolve(); },
      } },
    });
    vm.runInContext(source, context);
    vm.runInContext('registerEngineEvents()', context);
    const normal = vm.runInContext('callEngine("getLlmStatus", {}, {timeoutMs: 610000})', context) as Promise<any>;
    assert.equal([...timers.values()][0].delay, 30000);
    handlers.get('getLlmStatus:response')!({ detail: { requestId: requests[0].data._requestId, result: { enabled: true } } });
    await normal;
    const review = vm.runInContext('callEngine("reviewPackageSource", {}, {timeoutMs: sourceReviewTimeout({timeoutMs: 240000})})', context) as Promise<any>;
    assert.equal([...timers.values()][0].delay, 610000);
    handlers.get('reviewPackageSource:response')!({ detail: { requestId: requests[1].data._requestId, result: { reviewed: true } } });
    assert.equal((await review).reviewed, true);
    assert.equal(timers.size, 0);
    assert.equal(vm.runInContext('sourceReviewTimeout({})', context), 120000);
    assert.equal(vm.runInContext('sourceReviewTimeout({timeoutMs: 1200000})', context), 2530000);

    const failed = vm.runInContext('callEngine("reviewPackageSource", {})', context) as Promise<any>;
    const failure = assert.rejects(failed, /output budget exhausted/);
    handlers.get('reviewPackageSource:error')!({ detail: { requestId: requests[2].data._requestId, message: 'output budget exhausted' } });
    await failure;
    assert.equal(timers.size, 0);

    const timedOut = vm.runInContext('callEngine("reviewPackageSource", {})', context) as Promise<any>;
    const timeoutFailure = assert.rejects(timedOut, /LLM 源码复核等待超时/);
    const [timerId, timer] = [...timers.entries()][0];
    timers.delete(timerId);
    timer.fn();
    await timeoutFailure;
    assert.equal(vm.runInContext('pending.size', context), 0);
  });
});
