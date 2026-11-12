#!/usr/bin/env node
/** Independent source-review experiment. Does not change production decisions. */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDataset, loadScanner, validateDataset } from './evaluate-scanner.mjs';
import { collectSourceBundle } from './llm-source/source-bundle.mjs';
import { SYSTEM_PROMPT, REVIEW_PROMPT, validateReview, summarizeReviews } from './llm-source/review-contract.mjs';
import { readArtifact, readBounded, readConfined, sha256, prototypeIdentity, assertUnchanged } from './llm-source/evaluation-io.mjs';
import { SUPPLEMENT_LIMITS, SUPPLEMENT_PROMPT, combineSourceEvidence } from './llm-source/source-supplement.mjs';
import { readFrozenRun, loadSupplement, supplementSourceEvaluation } from './llm-source/source-round.mjs';
export { supplementSourceEvaluation } from './llm-source/source-round.mjs';

const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const MAX_PACKET_BYTES = 512 * 1024, MAX_REVIEW_BYTES = 256 * 1024;
const usable = bundle => bundle.coverage?.archiveInspection?.status !== 'failed' && bundle.coverage?.sourceCoverage !== 'failed' &&
  Array.isArray(bundle.files) && bundle.files.some(file => file.excerpts?.some(excerpt => typeof excerpt.text === 'string' && excerpt.text.length > 0));
export async function prepareSourceEvaluation(datasetPath, outputDirectory) {
  const datasetBytes = await readBounded(datasetPath, 16 * 1024 * 1024), dataset = JSON.parse(datasetBytes);
  validateDataset(dataset);
  await mkdir(outputDirectory, { recursive: false });
  await mkdir(path.join(outputDirectory, 'cases'));
  await mkdir(path.join(outputDirectory, 'reviews'));
  for (const name of ['requests','source-attempts','request-captures','supplements','supplement-receipts']) await mkdir(path.join(outputDirectory, name));
  const scanner = await loadScanner(), prototype = await prototypeIdentity();
  const protocol = {
    schemaVersion: 2, frozenAt: new Date().toISOString(), datasetSha256: sha256(datasetBytes), prototype,
    scanner: scanner.identity, prompts: { system: SYSTEM_PROMPT, review: REVIEW_PROMPT, supplement: SUPPLEMENT_PROMPT },
    promptSha256: sha256(SYSTEM_PROMPT + '\n' + REVIEW_PROMPT + '\n' + SUPPLEMENT_PROMPT),
    supplementLimits: SUPPLEMENT_LIMITS,
    modelBackend: 'isolated-conversation-review', modelIdentifier: 'inherited-session-model; exact identifier unavailable',
    temperature: null, apiTokenUsage: null, monetaryCost: null,
    transportLimits: { maxPacketBytes: MAX_PACKET_BYTES, maxReviewBytes: MAX_REVIEW_BYTES },
    modelLimits: 'Source evidence only; no labels, rule outcomes, research reports, internet, package execution or prior chat. Separate fresh reviewer for each case. Source may retain package identity within code; pretrained knowledge cannot be ruled out.',
    scoring: 'Only validated malicious evidence counts positive; benign is negative within provided evidence; unknown/invalid/failed abstain. Evidence quote validation is structural, not proof of semantic correctness.',
  };
  await save(path.join(outputDirectory, 'protocol.json'), protocol);
  const seed = randomBytes(32).toString('hex'), cases = [];
  for (const sample of dataset.samples) {
    const caseId = 'case-' + createHmac('sha256', seed).update(sample.id).digest('hex').slice(0, 12);
    const row = { caseId, sampleId: sample.id, label: sample.label, name: sample.name, version: sample.version };
    try {
      const directory = path.dirname(datasetPath);
      const manifest = JSON.parse(await readArtifact(directory, sample.artifacts.manifest, 8 * 1024 * 1024));
      if (manifest.name !== sample.name || manifest.version !== sample.version) throw new Error('Manifest coordinate mismatch');
      const archive = await readArtifact(directory, sample.artifacts.tarball, 20 * 1024 * 1024);
      const bundle = collectSourceBundle(archive, manifest);
      row.coverage = bundle.coverage;
      if (!usable(bundle)) throw new Error('Failed archive inspection or no usable source evidence; model abstains');
      const packet = { ...bundle, caseId };
      const bytes = Buffer.from(JSON.stringify(packet, null, 2) + '\n');
      if (bytes.length > MAX_PACKET_BYTES) throw new Error('Source packet JSON budget exceeded; model abstains');
      await writeFile(path.join(outputDirectory, 'cases', `${caseId}.json`), bytes, { flag: 'wx' });
      Object.assign(row, { status: 'prepared', packetSha256: sha256(bytes), coverage: bundle.coverage });
    } catch (error) { Object.assign(row, { status: 'failed', error: error.message }); }
    cases.push(row);
  }
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const rules = await evaluateDataset(datasetPath, scanner);
  await assertUnchanged({ ...protocol.scanner.sourceFiles, ...prototype.sourceFiles });
  if (sha256(await readFile(datasetPath)) !== protocol.datasetSha256) throw new Error('Dataset changed during preparation');
  await save(path.join(outputDirectory, 'private-run.json'), { protocol, seed, artifactDirectory: path.relative(outputDirectory, path.dirname(datasetPath)), dataset: rules.dataset, cases, rules });
  await save(path.join(outputDirectory, 'receipt.json'), {
    privateRunSha256: sha256(await readFile(path.join(outputDirectory, 'private-run.json'))),
    protocolSha256: sha256(await readFile(path.join(outputDirectory, 'protocol.json'))),
    datasetSha256: protocol.datasetSha256,
  });
  return { outputDirectory, cases: cases.map(({caseId,status,error}) => ({caseId,status,error})), prototypeFingerprint: prototype.fingerprint, scannerFingerprint: scanner.identity.sourceFingerprint };
}

export async function compareSourceEvaluation(directory, output) {
  const run = await readFrozenRun(directory);
  const rows = [];
  for (const entry of run.cases) {
    const rule = run.rules.rows.find(row => row.id === entry.sampleId && row.mode === 'deep');
    const model = { status: 'not-run', verdict: 'unknown' };
    let review, reviewSha256, validation, supplement;
    try {
      if (entry.status !== 'prepared') throw new Error(entry.error ?? 'Source preparation failed');
      const packetBytes = await readConfined(directory, `cases/${entry.caseId}.json`, MAX_PACKET_BYTES);
      if (sha256(packetBytes) !== entry.packetSha256) throw new Error('Frozen review packet changed');
      let bundle = JSON.parse(packetBytes);
      if (!usable(bundle)) throw new Error('No usable source evidence; model abstains');
      const round = await loadSupplement(directory, run, entry, bundle);
      const { packet, ...roundMetadata } = round;
      supplement = roundMetadata;
      if (round.status === 'failed') throw new Error('Source supplement failed: ' + round.error);
      if (packet) bundle = combineSourceEvidence(bundle, packet);
      const reviewBytes = await readConfined(directory, `reviews/${entry.caseId}.json`, MAX_REVIEW_BYTES);
      reviewSha256 = sha256(reviewBytes);
      review = JSON.parse(reviewBytes);
      validation = validateReview(review, bundle, entry.caseId);
      model.status = validation.valid ? 'complete' : 'invalid';
      if (validation.valid) model.verdict = review.verdict;
      else model.errors = validation.errors;
    } catch (error) { model.status = error.code === 'ENOENT' ? 'not-run' : 'failed'; model.error = error.message; }
    rows.push({ ...entry, rule: { status: rule?.status ?? 'failed', positive: rule?.highCriticalAlert ?? false,
      level: rule?.overallLevel, score: rule?.score, findings: rule?.report?.findings }, model, review, reviewSha256, validation, supplement });
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), protocol: run.protocol,
    dataset: run.dataset, rows, summary: summarizeReviews(rows),
    notes: ['No paid API was invoked. Session token billing and exact model configuration are not exposed.',
      'Independent risk judgments, not product integration. Union means either detector alerts; it can introduce false positives.',
      'Current rule results inspect the bounded tarball; model results inspect selected source evidence with a separate visible coverage budget.'] };
  await save(output, report);
  return report;
}

async function main() {
  const [command, input, flag, output] = process.argv.slice(2);
  if (!['prepare','compare','supplement'].includes(command) || !input || flag !== (command === 'supplement' ? '--case' : '--output') || !output || process.argv.length !== 6) {
    throw new Error('Usage: evaluate-source-llm.mjs prepare DATASET --output NEW_DIRECTORY | compare RUN_DIRECTORY --output NEW_REPORT.json | supplement RUN_DIRECTORY --case CASE_ID');
  }
  const result = command === 'prepare' ? await prepareSourceEvaluation(path.resolve(input), path.resolve(output))
    : command === 'supplement' ? await supplementSourceEvaluation(path.resolve(input), output) : await compareSourceEvaluation(path.resolve(input), path.resolve(output));
  console.log(JSON.stringify(command !== 'compare' ? result : { output, summary: result.summary }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
