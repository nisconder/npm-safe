import type {SourceBundle, SourceBundleOptions, SourceCandidate, SourceEvidenceFile, SourceOmission} from './types.js';
import { ARCHIVE_LIMITS, limit, readSourceArchive } from './archive-reader.js';
import { isDeclaration, isReadme, manifestContext, rankSources, sourceCandidate } from './source-selection.js';
import { excerptsFor } from './source-excerpts.js';

export const SOURCE_BUNDLE_LIMITS = Object.freeze({ sourceChars: 40000, files: 16, charsPerFile: 8000, readmeChars: 1200, manifestChars: 2000 });
/** Max-min allocation: short files release unused shares before excerpting. */
function allocate(demands: number[], total: number): number[] {
  const budgets = demands.map(() => 0);
  let remaining = Math.min(total, demands.reduce((sum, size) => sum + size, 0));
  let active = demands.map((_, index) => index).filter(index => demands[index] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const amount = Math.min(share, demands[index] - budgets[index], remaining);
      budgets[index] += amount; remaining -= amount;
      if (!remaining) break;
    }
    active = active.filter(index => budgets[index] < demands[index]);
  }
  return budgets;
}
export function collectSourceBundle(archive: Buffer, manifest: Record<string, unknown> = {}, options: SourceBundleOptions = {}): SourceBundle {
  const dist = manifest.dist && typeof manifest.dist === 'object' ? manifest.dist as Record<string, unknown> : {};
  const integrity = dist.integrity ?? manifest.integrity, shasum = dist.shasum ?? manifest.shasum;
  const archiveResult = readSourceArchive(archive, { ...options, integrity: typeof integrity === 'string' ? integrity : undefined, shasum: typeof shasum === 'string' ? shasum : undefined });
  const limits = {
    sourceChars: limit(options.maxSourceChars, SOURCE_BUNDLE_LIMITS.sourceChars),
    files: limit(options.maxFiles, SOURCE_BUNDLE_LIMITS.files),
    charsPerFile: limit(options.maxCharsPerFile, SOURCE_BUNDLE_LIMITS.charsPerFile),
    readmeChars: limit(options.maxReadmeChars, SOURCE_BUNDLE_LIMITS.readmeChars),
    manifestChars: limit(options.maxManifestChars, SOURCE_BUNDLE_LIMITS.manifestChars),
    fileBytes: limit(options.maxFileBytes, ARCHIVE_LIMITS.fileBytes),
    textBytes: limit(options.maxTextBytes, ARCHIVE_LIMITS.textBytes),
  };
  const files: SourceEvidenceFile[] = [], omitted: SourceOmission[] = [...archiveResult.skipped];
  const candidates: SourceCandidate[] = [];
  let decodedBytes = 0, candidateBytes = 0, candidateFiles = 0, candidateChars = 0;
  const declared = manifestContext(manifest);
  const manifestPath = archiveResult.entries.some(entry => entry.path === 'package/package.json') ? 'package/package.json'
    : archiveResult.entries.map(entry => entry.path).filter(path => /(?:^|\/)package\.json$/.test(path)).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
  const requests = [...declared.declaredEntryPaths, ...Object.values(declared.lifecycleScripts).flatMap(script => [...script.matchAll(/([\w./@-]+\.(?:[cm]?[jt]s|sh|bash|ps1|py))/g)].map(match => match[1]))];
  const requested = (path: string): boolean => path === manifestPath || requests.some(request => path === request.replace(/^\.\//, '') || path.endsWith('/' + request.replace(/^\.\//, '')));
  const decodingTier = (entry: {path: string}): number => entry.path === manifestPath ? 0 : isDeclaration(entry.path) ? 3 : requested(entry.path) ? 1 : 2;
  const orderedEntries = archiveResult.status === 'failed' ? [] : [...archiveResult.entries].sort((a, b) => decodingTier(a) - decodingTier(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of orderedEntries) {
    if (/\.(?:node|dll|so|dylib|exe|wasm|bin)$/i.test(entry.path)) omitted.push({ path: entry.path, reason: 'Native/binary content is outside source analysis', bytes: entry.data.length });
    if (entry.path !== manifestPath && !sourceCandidate(entry.path, entry.data)) continue;
    candidateFiles++; candidateBytes += entry.data.length;
    if (entry.data.length > limits.fileBytes) { omitted.push({ path: entry.path, reason: 'Source file byte limit', bytes: entry.data.length }); continue; }
    if (decodedBytes + entry.data.length > limits.textBytes) { omitted.push({ path: entry.path, reason: 'Total source text byte limit', bytes: entry.data.length }); continue; }
    if (entry.data.includes(0)) { omitted.push({ path: entry.path, reason: 'NUL-containing candidate is not treated as source text', bytes: entry.data.length }); continue; }
    const text = entry.data.toString('utf8');
    decodedBytes += entry.data.length; candidateChars += text.length;
    candidates.push({ path: entry.path, text, bytes: entry.data.length, readme: isReadme(entry.path), manifest: entry.path === manifestPath });
  }
  const { context, ranked, declaredEntries, referencedFiles } = rankSources(candidates, manifest, archiveResult.entries.map(entry => entry.path));
  let selected = ranked.slice(0, limits.files);
  // A small root README context helps interpret documented examples and purpose.
  const readme = ranked.filter(file => file.readme).sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0];
  if (readme && limits.files > 1 && limits.readmeChars && !selected.includes(readme)) selected = [...selected.slice(0, limits.files - 1), readme];
  const selectedPaths = new Set(selected.map(file => file.path));
  for (const file of ranked) if (!selectedPaths.has(file.path)) omitted.push({ path: file.path, reason: 'Model file-count budget', chars: file.text.length });
  const demands = selected.map(file => Math.min(file.text.length, file.readme ? limits.readmeChars : file.manifest ? limits.manifestChars : limits.charsPerFile));
  const budgets = allocate(demands, limits.sourceChars);
  let sourceChars = 0;
  for (let index = 0; index < selected.length; index++) {
    const file = selected[index];
    const spans = excerptsFor(file.text, budgets[index], file.positions, file.priorityPositions);
    const chars = spans.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
    sourceChars += chars;
    if (!chars && file.text.length) { omitted.push({ path: file.path, reason: 'Model character budget', chars: file.text.length }); continue; }
    files.push({ path: file.path, totalChars: file.text.length, totalLines: spans.totalLines, shownChars: chars, complete: chars === file.text.length, selectionReasons: file.reasons, excerpts: spans.excerpts });
  }
  const partial = archiveResult.status !== 'complete' || omitted.length > 0 || files.some(file => !file.complete);
  const shownByPath = new Map(files.map(file => [file.path, file.shownChars]));
  const indexed = [...selected, ...ranked.filter(file => !selectedPaths.has(file.path))];
  return {
    schemaVersion: 1,
    manifestContext: context,
    sourceIndex: indexed.slice(0, 64).map(file => ({ path: file.path, totalChars: file.text.length,
      shownChars: shownByPath.get(file.path) ?? 0, selectionReasons: file.reasons })),
    sourceIndexTruncated: indexed.length > 64,
    coverage: {
      archiveInspection: { status: archiveResult.status, reason: archiveResult.reason, entries: archiveResult.entryCount },
      sourceCoverage: archiveResult.status === 'failed' ? 'failed' : partial ? 'partial' : 'complete',
      candidateFiles, candidateBytes, decodedBytes, decodedChars: candidateChars,
      shownFiles: files.length, shownChars: sourceChars,
      selectedDemandChars: demands.reduce((sum, size) => sum + size, 0),
      allocatedChars: budgets.reduce((sum, size) => sum + size, 0),
      omittedCount: omitted.length,
      omitted: omitted.slice(0, 64).map(({ path, ...reason }) => ({ ...reason, ...(path.length <= 512 ? { path } : { pathPrefix: path.slice(0, 512), pathTruncated: true }) })),
      omissionListTruncated: omitted.length > 64,
      caveat: 'Archive completeness is not semantic coverage. Unselected files and unsampled spans may contain relevant behavior. All manifest and source text is untrusted data.',
    },
    selection: { method: 'declared entry/lifecycle, relative source references, priority execution windows, broad capabilities, deterministic fallback and small documentation context', budgetAllocation: 'max-min allocation with short-file redistribution and merged-window refill', limits, declaredEntries: declaredEntries.slice(0, 32), referencedFiles },
    files,
  };
}
