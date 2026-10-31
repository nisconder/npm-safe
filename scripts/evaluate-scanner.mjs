#!/usr/bin/env node
/** Offline evaluation: package artifacts are read as data, never imported or run. */
import { createHash } from 'node:crypto';
import { realpath as realpathCallback } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { summarize } from './lib/evaluation-metrics.mjs';
export { confusion, summarize } from './lib/evaluation-metrics.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The callback implementation resolves links without Windows' restricted native
// GetFinalPathNameByHandle API, which fs.promises.realpath uses in some sandboxes.
const realpath = promisify(realpathCallback);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OPERATIONAL_RULES = new Set(['content-scan-incomplete', 'content-scan-unavailable']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be nonempty text`);
};

export function validateDataset(dataset) {
  if (dataset?.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  requireText(dataset.id, 'id');
  if (!['real', 'synthetic'].includes(dataset.kind)) throw new Error('kind must be real or synthetic');
  if (!Array.isArray(dataset.samples) || !dataset.samples.length) throw new Error('samples must be nonempty');
  const ids = new Set();
  const families = new Map();
  const versions = new Map();
  for (const sample of dataset.samples) {
    for (const field of ['id', 'name', 'version', 'family']) requireText(sample?.[field], field);
    if (ids.has(sample.id)) throw new Error(`duplicate sample id: ${sample.id}`);
    ids.add(sample.id);
    if (!EXACT_VERSION.test(sample.version)) throw new Error(`${sample.id}: version must be an exact semver`);
    if (!['benign', 'malicious'].includes(sample.label)) throw new Error(`${sample.id}: invalid label`);
    if (!['dev', 'test'].includes(sample.split)) throw new Error(`${sample.id}: invalid split`);
    if (families.has(sample.family) && families.get(sample.family) !== sample.split) {
      throw new Error(`family ${sample.family} crosses dev/test splits`);
    }
    families.set(sample.family, sample.split);
    const packageVersion = `${sample.name}@${sample.version}`;
    if (versions.has(packageVersion)) throw new Error(`duplicate package version: ${packageVersion}`);
    versions.set(packageVersion, sample.split);
    for (const field of ['sourceUrl', 'labelEvidence', 'capturedAt']) {
      requireText(sample.provenance?.[field], `${sample.id}.provenance.${field}`);
    }
    const source = new URL(sample.provenance.sourceUrl);
    if (!['http:', 'https:'].includes(source.protocol)) throw new Error(`${sample.id}: sourceUrl must be HTTP(S)`);
    if (!Number.isFinite(Date.parse(sample.provenance.capturedAt))) throw new Error(`${sample.id}: invalid capturedAt`);
    for (const artifact of ['manifest', 'readme', 'tarball']) {
      const descriptor = sample.artifacts?.[artifact];
      requireText(descriptor?.path, `${sample.id}.${artifact}.path`);
      if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error(`${sample.id}.${artifact}: invalid SHA256`);
      if (path.isAbsolute(descriptor.path) || /^[A-Za-z]:/.test(descriptor.path) || descriptor.path.includes('\\')) {
        throw new Error(`${sample.id}.${artifact}: use a relative path with forward slashes`);
      }
    }
  }
}

async function readArtifact(directory, descriptor, maxBytes) {
  const root = await realpath(directory);
  const artifact = await realpath(path.resolve(root, descriptor.path));
  const relative = path.relative(root, artifact);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`artifact escapes dataset directory: ${descriptor.path}`);
  }
  const info = await stat(artifact);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes or is not a file: ${descriptor.path}`);
  const bytes = await readFile(artifact);
  if (bytes.length > maxBytes || sha256(bytes) !== descriptor.sha256) throw new Error(`SHA256 mismatch or oversized artifact: ${descriptor.path}`);
  return bytes;
}

/** Load current TypeScript source, never potentially stale dist output. */
export async function loadScanner() {
  const coreRoot = path.join(repositoryRoot, 'packages/core');
  const localRequire = createRequire(path.join(coreRoot, 'package.json'));
  const { register } = await import(pathToFileURL(localRequire.resolve('tsx/esm/api')).href);
  register();
  const [{ StaticAnalyzer }, { analyzePackageTarball }] = await Promise.all([
    import(pathToFileURL(path.join(coreRoot, 'src/scanner/static-rules.ts')).href),
    import(pathToFileURL(path.join(coreRoot, 'src/scanner/package-content.ts')).href),
  ]);
  const analyzer = new StaticAnalyzer();
  const sourceFiles = {};
  for (const entry of (await readdir(path.join(coreRoot, 'src/scanner'))).sort()) {
    if (entry.endsWith('.ts')) {
      const relative = `packages/core/src/scanner/${entry}`;
      sourceFiles[relative] = sha256(await readFile(path.join(repositoryRoot, relative)));
    }
  }
  return {
    metadata: (readme, manifest) => analyzer.analyze(readme, manifest),
    deep: (readme, manifest, archive) => {
      const content = analyzePackageTarball(archive, {
        integrity: manifest.dist?.integrity ?? manifest.integrity,
        shasum: manifest.dist?.shasum ?? manifest.shasum,
      });
      return analyzer.analyze(readme, manifest, content.findings, content.summary);
    },
    identity: {
      entrypoint: 'TypeScript source via existing core-local tsx; default built-in rules; no LLM/config/cache',
      sourceFiles,
      sourceFingerprint: sha256(JSON.stringify(sourceFiles)),
      coreVersion: JSON.parse(await readFile(path.join(coreRoot, 'package.json'), 'utf8')).version,
      tsxVersion: localRequire('tsx/package.json').version,
    },
  };
}

/** Dependency injection exists for accounting tests; CLI always uses real source. */
export async function evaluateDataset(datasetPath, scanner) {
  const datasetBytes = await readFile(datasetPath);
  const dataset = JSON.parse(datasetBytes.toString('utf8'));
  validateDataset(dataset);
  scanner ??= await loadScanner();
  const rows = [];
  for (const sample of dataset.samples) {
    for (const mode of ['metadata', 'deep']) {
      const row = {
        id: sample.id, name: sample.name, version: sample.version, label: sample.label,
        family: sample.family, split: sample.split, mode, provenance: sample.provenance,
        status: 'failed', scanDurationMs: null, stage: 'input',
      };
      const start = performance.now();
      try {
        const directory = path.dirname(datasetPath);
        const manifest = JSON.parse((await readArtifact(directory, sample.artifacts.manifest, 8 * 1024 * 1024)).toString('utf8'));
        const readme = (await readArtifact(directory, sample.artifacts.readme, 8 * 1024 * 1024)).toString('utf8');
        if (manifest.name !== sample.name || manifest.version !== sample.version) throw new Error('manifest name/version differs from fixed sample');
        const archive = mode === 'deep' ? await readArtifact(directory, sample.artifacts.tarball, 20 * 1024 * 1024) : null;
        row.stage = 'scan';
        const scanStart = performance.now();
        let report;
        try {
          report = mode === 'metadata' ? await scanner.metadata(readme, manifest) : await scanner.deep(readme, manifest, archive);
        } finally {
          row.scanDurationMs = performance.now() - scanStart;
        }
        row.status = mode === 'metadata' ? 'complete' : report.contentScan?.status ?? 'failed';
        row.overallLevel = report.overallLevel;
        row.score = report.score;
        row.highCriticalAlert = report.findings.some((finding) =>
          ['high', 'critical'].includes(finding.severity) && !OPERATIONAL_RULES.has(finding.ruleId));
        row.report = report;
        if (row.status !== 'complete') row.error = report.contentScan?.reason ?? 'Content inspection did not complete';
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
      }
      row.wallDurationMs = performance.now() - start;
      rows.push(row);
    }
  }
  return {
    schemaVersion: 1, dataset: { id: dataset.id, kind: dataset.kind, sha256: sha256(datasetBytes), samples: dataset.samples },
    generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
    scanner: scanner.identity,
    interpretation: dataset.kind === 'synthetic' ? 'Harness demonstration only; not measured real-world malware detection accuracy.' : 'Results apply only to these frozen, independently labeled artifacts.',
    summary: summarize(rows), rows,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== '--output') {
    console.error('Usage: node scripts/evaluate-scanner.mjs DATASET.json --output RESULTS.json');
    process.exitCode = 1;
    return;
  }
  const input = path.resolve(args[0]);
  const output = path.resolve(args[2]);
  if (input === output) throw new Error('output must differ from dataset');
  const report = await evaluateDataset(input);
  // Never overwrite any declared artifact, including through symlinks.
  let outputResolved = output;
  try { outputResolved = await realpath(output); } catch { /* New result file. */ }
  for (const sample of report.dataset.samples) {
    for (const artifact of Object.values(sample.artifacts)) {
      const artifactPath = path.resolve(path.dirname(input), artifact.path);
      let artifactResolved = artifactPath;
      try { artifactResolved = await realpath(artifactPath); } catch { /* Missing artifact is represented in rows. */ }
      if (outputResolved === artifactResolved) throw new Error('output must not overwrite an input artifact');
    }
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output, dataset: report.dataset.id, kind: report.dataset.kind, summary: report.summary }, null, 2));
  // Incomplete scans are a reproducibility failure; misclassifications remain report data.
  if (report.rows.some((row) => row.status !== 'complete')) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
