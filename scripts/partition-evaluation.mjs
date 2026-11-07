#!/usr/bin/env node
/** Freeze family-level splits before scanning; this never reads package artifacts. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from './evaluate-scanner.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function partitionDataset(dataset, { seed, testFraction = 0.25, observed = [] }) {
  validateDataset(dataset);
  if (typeof seed !== 'string' || !seed.trim() || seed.length > 128) throw new Error('seed must be 1–128 nonempty characters');
  if (!Number.isFinite(testFraction) || testFraction <= 0 || testFraction >= 1) throw new Error('testFraction must be between 0 and 1');
  const knownFamilies = new Set();
  const knownVersions = new Set();
  const knownTarballs = new Set();
  for (const previous of observed) {
    validateDataset(previous);
    for (const sample of previous.samples) {
      knownFamilies.add(sample.family);
      knownVersions.add(`${sample.name}@${sample.version}`);
      knownTarballs.add(sample.artifacts.tarball.sha256);
    }
  }
  const families = [...new Set(dataset.samples.map(sample => sample.family))].sort();
  if (families.length < 2) throw new Error('need at least two families to partition');
  const forcedDev = new Set(dataset.samples.filter(sample => knownFamilies.has(sample.family)
    || knownVersions.has(`${sample.name}@${sample.version}`)
    || knownTarballs.has(sample.artifacts.tarball.sha256)).map(sample => sample.family));
  // The same bytes under different family names cannot become a held-out sample.
  const hashFamilies = new Map();
  for (const sample of dataset.samples) {
    const owners = hashFamilies.get(sample.artifacts.tarball.sha256) ?? new Set();
    owners.add(sample.family);
    hashFamilies.set(sample.artifacts.tarball.sha256, owners);
  }
  for (const owners of hashFamilies.values()) {
    if (owners.size > 1) throw new Error('identical tarball assigned to different families; reconcile family annotations before splitting');
  }
  const eligible = families.filter(family => !forcedDev.has(family)).map(family => ({
    family, rank: hash(`${seed}\0${family}`),
  })).sort((a, b) => a.rank.localeCompare(b.rank, 'en'));
  if (!eligible.length) throw new Error('no unobserved families remain for test');
  const count = Math.min(eligible.length, families.length - 1, Math.max(1, Math.ceil(eligible.length * testFraction)));
  const test = new Set(eligible.slice(0, count).map(entry => entry.family));
  const result = {
    ...dataset,
    partition: {
      method: 'sha256-family-rank-v1', seed, testFraction,
      testFamilies: [...test].sort(), forcedDevFamilies: [...forcedDev].sort(),
      observedDatasetIds: observed.map(previous => previous.id),
      independence: 'Unverified: family annotations, previous exposure and label quality require human review. Synthetic fixtures never establish real-world accuracy.',
    },
    samples: dataset.samples.map(sample => ({ ...sample, split: test.has(sample.family) ? 'test' : 'dev' })),
  };
  validateDataset(result);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/partition-evaluation.mjs DATASET.json --output SPLIT.json --seed TEXT [--test-fraction 0.25] [--observed OLD.json ...]';
  if (args.length < 5 || args[1] !== '--output' || args[3] !== '--seed') throw new Error(usage);
  const input = path.resolve(args[0]);
  const output = path.resolve(args[2]);
  // Preserve all artifact paths without relocating or copying any artifacts.
  if (path.dirname(input) !== path.dirname(output)) throw new Error('output must be a new file beside the input dataset');
  const options = { seed: args[4], observed: [] };
  const observedInputs = [];
  for (let index = 5; index < args.length; index += 2) {
    if (args[index] === '--test-fraction' && args[index + 1]) options.testFraction = Number(args[index + 1]);
    else if (args[index] === '--observed' && args[index + 1]) observedInputs.push(path.resolve(args[index + 1]));
    else throw new Error(usage);
  }
  const source = await readFile(input);
  const observedSources = [];
  for (const file of observedInputs) {
    const bytes = await readFile(file);
    options.observed.push(JSON.parse(bytes));
    observedSources.push({ id: options.observed.at(-1).id, sha256: hash(bytes) });
  }
  const result = partitionDataset(JSON.parse(source), options);
  result.partition.sourceSha256 = hash(source);
  result.partition.observedSources = observedSources;
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output, partition: result.partition }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
