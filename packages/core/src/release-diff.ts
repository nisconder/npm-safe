import type { ScanFinding, StaticScanReport } from './scanner/types.js';

/** Registry manifest fields whose changes affect installation or runtime use. */
export const RELEASE_MANIFEST_FIELDS = [
  'scripts', 'dependencies', 'optionalDependencies', 'peerDependencies',
  'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies',
  'bin', 'main', 'module', 'types', 'typings', 'exports', 'imports', 'files',
  'engines', 'os', 'cpu', 'type', 'hasInstallScript',
] as const;

export interface ManifestChange {
  /** JSON Pointer into the registry's version-specific package manifest. */
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface ReleaseSnapshot {
  readonly version: string;
  readonly integrity?: string;
  readonly shasum?: string;
  readonly report: StaticScanReport;
}

export interface ReleaseDiffReport {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly generatedAt: string;
  /** Completeness within the bounded scanner's scope, never proof of safety. */
  readonly status: 'complete' | 'inconclusive';
  readonly before: ReleaseSnapshot;
  readonly after: ReleaseSnapshot;
  readonly manifestSource: 'registry-version-manifests';
  readonly manifestChanges: readonly ManifestChange[];
  readonly findings: {
    /** Only populated when both deep scans complete under the same rules. */
    readonly added: readonly ScanFinding[];
    readonly removed: readonly ScanFinding[];
    readonly persisting: readonly { before: ScanFinding; after: ScanFinding }[];
    /** Unmatched observations when absence on the opposite side is inconclusive. */
    readonly unverifiedBefore: readonly ScanFinding[];
    readonly unverifiedAfter: readonly ScanFinding[];
  };
  readonly limitations: readonly string[];
}

const OPERATIONAL_RULES = new Set(['content-scan-incomplete', 'content-scan-unavailable']);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertExactReleaseVersion(version: string): void {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`Release diff requires an exact version, not a tag or range: "${version}".`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preserve array order, but ignore JSON object key order. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Manifest nesting exceeds the release-diff limit (64).');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function diffReleaseManifests(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): ManifestChange[] {
  const changes: ManifestChange[] = [];
  const visit = (oldValue: unknown, newValue: unknown, pointer: string, depth: number): void => {
    if (depth > 64) throw new Error('Manifest nesting exceeds the release-diff limit (64).');
    if (canonical(oldValue) === canonical(newValue)) return;
    if (record(oldValue) && record(newValue)) {
      for (const key of [...new Set([...Object.keys(oldValue), ...Object.keys(newValue)])].sort()) {
        visit(Object.hasOwn(oldValue, key) ? oldValue[key] : undefined,
          Object.hasOwn(newValue, key) ? newValue[key] : undefined,
          `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
      }
    } else {
      changes.push({ path: pointer,
        kind: oldValue === undefined ? 'added' : newValue === undefined ? 'removed' : 'changed',
        ...(oldValue === undefined ? {} : { before: oldValue }),
        ...(newValue === undefined ? {} : { after: newValue }),
      });
    }
  };
  for (const field of RELEASE_MANIFEST_FIELDS) {
    visit(Object.hasOwn(before, field) ? before[field] : undefined,
      Object.hasOwn(after, field) ? after[field] : undefined, `/${field}`, 0);
  }
  return changes;
}

/** Line offsets may shift without changing the evidence. Match a multiset. */
function findingKey(finding: ScanFinding): string {
  return JSON.stringify([finding.ruleId, finding.filePath ?? '',
    finding.codeSnippet ?? finding.message]);
}

export function compareReleaseSnapshots(
  packageName: string,
  before: ReleaseSnapshot,
  after: ReleaseSnapshot,
  beforeManifest: Readonly<Record<string, unknown>>,
  afterManifest: Readonly<Record<string, unknown>>,
): ReleaseDiffReport {
  // Public callers can supply reports without going through the engine's
  // registry validation. Never infer a resolved/new signal across identities.
  for (const [snapshot, manifest] of [[before, beforeManifest], [after, afterManifest]] as const) {
    assertExactReleaseVersion(snapshot.version);
    if (!packageName || snapshot.report.packageName !== packageName
      || snapshot.report.version !== snapshot.version
      || manifest.name !== packageName || manifest.version !== snapshot.version) {
      throw new Error('Release snapshot, static report and manifest must identify the same package and exact version.');
    }
  }
  const complete = before.report.contentScan?.status === 'complete'
    && after.report.contentScan?.status === 'complete'
    && !!before.report.scannerFingerprint
    && before.report.scannerFingerprint === after.report.scannerFingerprint;
  const remaining = new Map<string, ScanFinding[]>();
  for (const finding of before.report.findings.filter(item => !OPERATIONAL_RULES.has(item.ruleId))) {
    const key = findingKey(finding);
    const group = remaining.get(key) ?? [];
    group.push(finding);
    remaining.set(key, group);
  }
  const added: ScanFinding[] = [];
  const persisting: { before: ScanFinding; after: ScanFinding }[] = [];
  for (const finding of after.report.findings.filter(item => !OPERATIONAL_RULES.has(item.ruleId))) {
    const previous = remaining.get(findingKey(finding))?.shift();
    if (previous) persisting.push({ before: previous, after: finding });
    else added.push(finding);
  }
  const removed = [...remaining.values()].flat();
  return {
    schemaVersion: 1, packageName, generatedAt: new Date().toISOString(),
    status: complete ? 'complete' : 'inconclusive', before, after,
    manifestSource: 'registry-version-manifests',
    manifestChanges: diffReleaseManifests(beforeManifest, afterManifest),
    findings: {
      added: complete ? added : [], removed: complete ? removed : [], persisting,
      unverifiedBefore: complete ? [] : removed, unverifiedAfter: complete ? [] : added,
    },
    limitations: [
      'Compares static signals in two exact releases; findings do not establish malicious intent or runtime behavior.',
      'Manifest changes use registry version manifests, not a byte-for-byte comparison of archived package.json.',
      'Package-level README and optional LLM analysis are excluded because they are not version-bound evidence.',
      'Findings match by rule, path and snippet (or message), ignoring line shifts. Renames or changed snippets may appear as removal plus addition.',
      'Complete means both bounded scans completed under the same rules; skipped file types are not semantically analyzed.',
      ...(!complete ? ['Unmatched findings are unverified observations, not confirmed additions or removals, because a scan is incomplete or rule identities differ.'] : []),
    ],
  };
}
