import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../desktop/resources/js/main.js', import.meta.url), 'utf8')
  .split('Neutralino.init();')[0];

function assessment(packageKind = 'npm') {
  const isPlugin = packageKind === 'dsh-plugin';
  return {
    packageKind,
    packageName: isPlugin ? '@example/dsh-plugin' : 'lodash',
    version: '1.2.3',
    sourceKind: 'npm',
    sourceLabel: 'npm registry',
    sourceUrl: 'https://www.npmjs.com/package/lodash',
    riskLevel: 'low',
    safetyScore: 100,
    summary: '检查完成',
    checks: [],
    findings: [],
    safeInstallCommand: isPlugin ? 'dsh plugin --profile web add @example/dsh-plugin@1.2.3' : 'npm install lodash@1.2.3',
    inspectedAt: '2026-11-13T12:00:00Z',
    integrityVerified: true,
  };
}

function form(targetKind = 'auto', result = assessment(), failure?: Error) {
  const calls: { method: string; data: any }[] = [];
  const elements: Record<string, any> = {
    'check-name': { value: result.packageName, disabled: false },
    'check-target-kind': { value: targetKind, disabled: false },
    'check-btn': { textContent: '生成风险卡', dataset: {}, disabled: false },
    'check-result': { innerHTML: '', querySelector: () => null },
    'status-bar': { textContent: '', className: '' },
  };
  const context = vm.createContext({
    document: {
      getElementById: (id: string) => elements[id],
      createElement: () => ({
        textContent: '',
        get innerHTML() {
          return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      }),
    },
    testResult: result,
    testCallEngine: async (method: string, data: unknown) => {
      calls.push({ method, data: JSON.parse(JSON.stringify(data)) });
      if (method === 'assessInstallRisk') {
        assert.equal(elements['check-target-kind'].disabled, true);
        assert.equal(elements['check-name'].disabled, true);
        if (failure) throw failure;
        return result;
      }
      assert.equal(method, 'addHistory');
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('callEngine = testCallEngine', context);
  return {
    elements,
    calls,
    render: () => vm.runInContext('renderInstallRisk(testResult)', context),
    scan: () => vm.runInContext('handleCheck()', context) as Promise<void>,
  };
}

describe('desktop package-type preflight', () => {
  it('labels ordinary npm packages without a DSH installation contract', () => {
    const page = form();
    page.render();
    const html = page.elements['check-result'].innerHTML;
    assert.match(html, /npm 安装检查/);
    assert.match(html, /npm install lodash@1\.2\.3/);
    assert.doesNotMatch(html, /DSH 安装契约|DSH 插件/);
  });

  it('keeps the DSH contract and command for a plugin', () => {
    const page = form('auto', assessment('dsh-plugin'));
    page.render();
    const html = page.elements['check-result'].innerHTML;
    assert.match(html, /DSH 插件/);
    assert.match(html, /DSH 安装契约/);
    assert.match(html, /dsh plugin --profile web add/);
  });

  it('sends the chosen classification mode to the engine and records its result', async () => {
    for (const targetKind of ['auto', 'npm', 'dsh-plugin']) {
      const result = assessment(targetKind === 'dsh-plugin' ? 'dsh-plugin' : 'npm');
      const page = form(targetKind, result);
      await page.scan();
      assert.deepEqual(page.calls[0], {
        method: 'assessInstallRisk',
        data: { input: result.packageName, profile: 'web', targetKind },
      });
      assert.equal(page.calls[1].method, 'addHistory');
      assert.equal(page.calls[1].data.level, 'safe');
      assert.equal(page.elements['check-target-kind'].disabled, false);
      assert.equal(page.elements['check-name'].disabled, false);
      assert.equal(page.elements['check-btn'].disabled, false);
    }
  });

  it('restores the form after a failed scan without recording a result', async () => {
    const page = form('auto', assessment(), new Error('网络请求失败'));
    await page.scan();
    assert.equal(page.calls.length, 1);
    assert.match(page.elements['check-result'].innerHTML, /网络请求失败/);
    assert.equal(page.elements['check-target-kind'].disabled, false);
    assert.equal(page.elements['check-name'].disabled, false);
    assert.equal(page.elements['check-btn'].disabled, false);
  });
});
