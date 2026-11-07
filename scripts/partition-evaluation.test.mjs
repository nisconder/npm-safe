import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createEvaluationDemo } from './create-evaluation-demo.mjs';
import { partitionDataset } from './partition-evaluation.mjs';
import { evaluateDataset, validateDataset } from './evaluate-scanner.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.split-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'corpus');
  return { directory, dataset: await createEvaluationDemo(directory) };
}

test('partitioning is deterministic, family-separated, and independent of input order', async t => {
  const { dataset } = await fixture(t);
  const first = partitionDataset(dataset, { seed: 'reviewed-before-scanning', testFraction: 0.5 });
  const second = partitionDataset({ ...dataset, samples: [...dataset.samples].reverse() },
    { seed: 'reviewed-before-scanning', testFraction: 0.5 });
  assert.deepEqual(first.partition, second.partition);
  assert.equal(first.samples.filter(sample => sample.split === 'test').length, 2);
  assert.equal(first.samples.filter(sample => sample.split === 'dev').length, 2);
});

test('observed families, exact versions and copied tarballs cannot enter the test split', async t => {
  const { dataset } = await fixture(t);
  const prior = { ...dataset, id: 'prior-observed', samples: [dataset.samples[0]] };
  const split = partitionDataset(dataset, { seed: 'holdout', observed: [prior] });
  assert.equal(split.samples[0].split, 'dev');
  assert.deepEqual(split.partition.forcedDevFamilies, [dataset.samples[0].family]);
  const relabeled = { ...prior, samples: [{ ...prior.samples[0], family: 'different-family', name: 'different-name' }] };
  assert.equal(partitionDataset(dataset, { seed: 'holdout', observed: [relabeled] }).samples[0].split, 'dev');
  assert.throws(() => partitionDataset(dataset, { seed: 'holdout', observed: [dataset] }), /no unobserved/);
});

test('duplicate archive bytes across splits or conflicting family annotations are rejected', async t => {
  const { dataset } = await fixture(t);
  const duplicate = { ...dataset.samples[1], artifacts: dataset.samples[0].artifacts };
  assert.throws(() => validateDataset({ ...dataset, samples: [dataset.samples[0], { ...duplicate, split: 'test' }] }), /identical tarball/);
  assert.throws(() => partitionDataset({ ...dataset, samples: [dataset.samples[0], duplicate] }, { seed: 'test' }), /different families/);
});

test('split-only evaluation does not open excluded artifacts, while retaining the frozen manifest', async t => {
  const { directory, dataset } = await fixture(t);
  const split = partitionDataset(dataset, { seed: 'protocol-demo', testFraction: 0.5 });
  const datasetPath = path.join(directory, 'split.json');
  await writeFile(datasetPath, JSON.stringify(split));
  for (const sample of split.samples.filter(item => item.split === 'test')) {
    for (const descriptor of Object.values(sample.artifacts)) await rm(path.join(directory, descriptor.path));
  }
  const report = await evaluateDataset(datasetPath, undefined, { split: 'dev' });
  assert.equal(report.selection.selectedCount, 2);
  assert.equal(report.selection.excludedCount, 2);
  assert.equal(report.rows.length, 4);
  assert.ok(report.rows.every(row => row.split === 'dev' && row.status === 'complete'));
  assert.equal(report.dataset.samples.length, 4);
  assert.match(report.interpretation, /not measured real-world/);
  const withheld = await evaluateDataset(datasetPath, undefined, { split: 'test' });
  assert.ok(withheld.rows.every(row => row.status === 'failed'));
  assert.equal(withheld.summary.test.deep.highCritical.coverage, 0);
});

test('real scanner processes generated harmless controls and encoded no-op fixtures offline', async t => {
  const { directory, dataset } = await fixture(t);
  const split = partitionDataset(dataset, { seed: 'protocol-demo', testFraction: 0.5 });
  const datasetPath = path.join(directory, 'split.json');
  await writeFile(datasetPath, JSON.stringify(split));
  const report = await evaluateDataset(datasetPath, undefined, { split: 'test' });
  assert.ok(report.rows.every(row => row.status === 'complete'));
  assert.ok(report.rows.filter(row => row.mode === 'deep').every(row => row.report.contentScan.integrityVerified));
  const full = await evaluateDataset(datasetPath);
  const positive = full.rows.filter(row => row.label === 'malicious' && row.mode === 'deep');
  assert.equal(positive.length, 2);
  assert.ok(positive.every(row => row.report.findings.some(finding => finding.ruleId === 'content-obfuscated-exec')));
});
