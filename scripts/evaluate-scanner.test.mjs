import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { confusion, evaluateDataset, summarize, validateDataset } from './evaluate-scanner.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function row(label, status, overallLevel, highCriticalAlert, overrides = {}) {
  return { id: 'sample', split: 'test', mode: 'deep', label, status, overallLevel, highCriticalAlert, ...overrides };
}

test('incomplete and unknown outcomes abstain instead of becoming true negatives', () => {
  const rows = [
    row('malicious', 'complete', 'suspicious', true),
    row('malicious', 'failed', 'safe', false),
    row('malicious', 'partial', 'safe', false),
    row('malicious', 'complete', 'unknown', true),
    row('benign', 'complete', 'safe', false),
    row('benign', 'failed', 'safe', false),
  ];
  const product = confusion(rows, 'productLevel');
  assert.deepEqual([product.tp, product.fp, product.tn, product.fn], [1, 0, 1, 0]);
  assert.equal(product.abstainedMalicious, 3);
  assert.equal(product.abstainedBenign, 1);
  assert.equal(product.recallAmongEvaluable, 1);
  assert.equal(product.endToEndRecall, 0.25);
  assert.equal(confusion(rows, 'highCritical').tp, 2);
});

test('a high alert at product score 85 is counted separately from a product-level detection', () => {
  const rows = [row('malicious', 'complete', 'safe', true)];
  assert.equal(confusion(rows, 'highCritical').tp, 1);
  assert.equal(confusion(rows, 'productLevel').fn, 1);
});

test('mode deltas exclude incomplete pairs and distinguish added TP from added FP', () => {
  const rows = [
    row('malicious', 'complete', 'safe', false, { id: 'a', mode: 'metadata' }),
    row('malicious', 'complete', 'suspicious', true, { id: 'a' }),
    row('benign', 'complete', 'safe', false, { id: 'b', mode: 'metadata' }),
    row('benign', 'complete', 'safe', true, { id: 'b' }),
    row('malicious', 'complete', 'safe', false, { id: 'c', mode: 'metadata' }),
    row('malicious', 'failed', 'safe', false, { id: 'c' }),
  ];
  const summary = summarize(rows).test;
  assert.deepEqual(summary.deepDelta.highCritical, {
    pairedEvaluable: 2, excludedPairs: 1, addedTruePositives: 1, lostTruePositives: 0,
    addedFalsePositives: 1, removedFalsePositives: 0,
  });
  assert.equal(summary.deep.total, 3);
  assert.equal(summary.deep.failed, 1);
  assert.equal(summary.deep.incompleteRate, 1 / 3);
});

async function fixture(t) {
  // Workspace-local temp data also works under Windows virtualized TEMP paths.
  const directory = await mkdtemp(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.evaluation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = { manifest: JSON.stringify({ name: 'synthetic-eval-example', version: '1.0.0' }), readme: '# Synthetic harness data', tarball: 'not executed' };
  const artifacts = {};
  for (const [key, bytes] of Object.entries(contents)) {
    await writeFile(path.join(directory, key), bytes);
    artifacts[key] = { path: key, sha256: hash(bytes) };
  }
  const sample = {
    id: 'fixture', name: 'synthetic-eval-example', version: '1.0.0', label: 'benign', family: 'synthetic-example', split: 'test',
    provenance: { sourceUrl: 'https://example.invalid/synthetic', labelEvidence: 'Synthetic harness-only fixture, not a real npm package', capturedAt: '2026-10-31T00:00:00Z' }, artifacts,
  };
  const dataset = { schemaVersion: 1, id: 'synthetic-harness', kind: 'synthetic', samples: [sample] };
  const datasetPath = path.join(directory, 'dataset.json');
  await writeFile(datasetPath, JSON.stringify(dataset));
  return { directory, sample, dataset, datasetPath };
}

const fakeScanner = {
  metadata: () => ({ overallLevel: 'safe', score: 100, findings: [] }),
  deep: () => ({ overallLevel: 'safe', score: 100, findings: [], contentScan: { status: 'complete' } }),
  identity: { sourceFingerprint: 'accounting-test-only' },
};

test('an unavailable tarball preserves successful metadata row and failed deep row', async (t) => {
  const { directory, datasetPath } = await fixture(t);
  await rm(path.join(directory, 'tarball'));
  const report = await evaluateDataset(datasetPath, fakeScanner);
  assert.deepEqual(report.rows.map((item) => item.status), ['complete', 'failed']);
  assert.equal(report.rows[1].stage, 'input');
  assert.equal(report.summary.test.deep.highCritical.tn, 0);
  assert.equal(report.summary.test.deep.highCritical.abstainedBenign, 1);
  assert.match(report.interpretation, /not measured real-world/);
});

test('modified artifact bytes fail validation and remain in the evaluation denominator', async (t) => {
  const { directory, datasetPath } = await fixture(t);
  await writeFile(path.join(directory, 'readme'), 'tampered bytes');
  const report = await evaluateDataset(datasetPath, fakeScanner);
  assert.deepEqual(report.rows.map((item) => item.status), ['failed', 'failed']);
  assert.match(report.rows[0].error, /SHA256/);
  assert.equal(report.summary.test.metadata.total, 1);
  assert.equal(report.summary.test.metadata.highCritical.coverage, 0);
});

test('family leakage and floating versions are rejected before evaluation', async (t) => {
  const { dataset, sample } = await fixture(t);
  assert.throws(() => validateDataset({ ...dataset, samples: [{ ...sample, version: '^1.0.0' }] }), /exact semver/);
  assert.throws(() => validateDataset({ ...dataset, samples: [sample, { ...sample, id: 'second', version: '1.0.1', split: 'dev' }] }), /crosses dev\/test/);
});

test('actual TypeScript scanner source is used and malformed archive is inconclusive', async (t) => {
  const { datasetPath } = await fixture(t);
  const report = await evaluateDataset(datasetPath);
  assert.deepEqual(report.rows.map((item) => item.status), ['complete', 'failed']);
  assert.ok(report.rows[1].report.findings.some((item) => item.ruleId === 'content-archive-invalid'));
  assert.match(report.scanner.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Object.keys(report.scanner.sourceFiles).includes('packages/core/src/scanner/package-content.ts'));
  assert.equal(report.summary.test.deep.highCritical.tn, 0);
});
