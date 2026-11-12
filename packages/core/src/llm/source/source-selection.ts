import type {ManifestContext, SourceCandidate, SourceSignals, RankedSource} from './types.js';
import { posix } from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|fish|ps1|cmd|bat|py|rb|pl)$/i;
const README = /(?:^|\/)readme(?:\.(?:md|txt|markdown))?$/i;
const DECLARATION = /\.d\.(?:[cm]?ts|tsx)$/i;
const SIGNALS: [string, RegExp][] = [
  ['lifecycle-or-entry', /"(?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly|main|module|exports|bin)"\s*:/g],
  ['network', /\b(?:fetch|https?|axios|request|Socket|WebSocket|resolveTxt|Resolver|sendBeacon|Logtail)\b/g],
  ['process', /\b(?:child_process|execSync|execFile|exec|spawn|fork|powershell|curl|wget|rundll32)\b/g],
  ['files-or-secrets', /\b(?:readFileSync|readFile|createReadStream|writeFile|unlinkSync|rmdirSync|rmSync|process\.env|privateKey|secretKey|mnemonic|credential|NPM_TOKEN|GITHUB_TOKEN)\b/g],
  ['encoded-or-dynamic', /\b(?:eval|Function|atob|fromCharCode|parseInt|base64)\b|(?:\\x[\da-f]{2}){4,}|(?:\\u[\da-f]{4}){4,}/gi],
];

// These locate informative source structures, not malicious verdicts. A normal
// compiler, worker or codec may contain them and still deserves context review.
const CONTEXT_SIGNALS: [string, RegExp][] = [
  ['dynamic-execution-context', /\b(?:eval|Function)\s*\(/g],
  ['worker-context', /\bnew\s+(?:Worker|WorkerThread)\s*\(/g],
  ['worker-evaluation-option', /(?:['"]eval['"]|\beval)\s*:\s*(?:true\b|!!\s*\[\s*\]|!0\b)/g],
  ['encoded-payload-context', /(?:[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]){8,}|(?:\\x[\da-f]{2}){32,}|(?:\\u[\da-f]{4}){32,}/giu],
  ['decoder-context', /\b(?:codePointAt|fromCodePoint|fromCharCode|atob)\s*\(/g],
  ['stream-transfer-context', /\.\s*(?:pipe|pipeTo)\s*\(/g],
];

const boundedMatches = (text: string, regex: RegExp): {start: number; end: number}[] => {
  regex.lastIndex = 0;
  const head: {start: number; end: number}[] = [], tail: {start: number; end: number}[] = [];
  let match, count = 0;
  while ((match = regex.exec(text))) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (count < 8) head.push(span);
    else { tail.push(span); if (tail.length > 8) tail.shift(); }
    count++;
  }
  return [...head, ...tail];
};

export const sourceCandidate = (path: string, data: Buffer): boolean => SOURCE.test(path) || README.test(path) ||
  (data.subarray(0, 128).toString('utf8').startsWith('#!') && /(?:node|sh|python|ruby|perl|pwsh)/i.test(data.subarray(0, 128).toString('utf8')));
export const isReadme = (path: string): boolean => README.test(path);
export const isDeclaration = (path: string): boolean => DECLARATION.test(path);

function strings(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value.slice(0, 2000)];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).slice(0, 64).flatMap(child => strings(child, depth + 1)).slice(0, 128);
}
export function manifestContext(manifest: Record<string, unknown>): ManifestContext {
  const scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([key, value]) => typeof value === 'string' && /^(?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly|start)$/.test(key)).slice(0, 12).map(([key, value]) => [key, (value as string).slice(0, 500)]));
  const context: ManifestContext = {
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 1000) : '',
    type: typeof manifest.type === 'string' && ['module', 'commonjs'].includes(manifest.type) ? manifest.type : undefined,
    declaredEntryPaths: [...new Set([manifest.main, manifest.module, ...strings(manifest.exports), ...strings(manifest.bin)].filter((value): value is string => typeof value === 'string'))].slice(0, 32).map(value => value.slice(0, 500)),
    lifecycleScripts: scripts,
    dependencyNames: [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])].sort().slice(0, 80).map(value => value.slice(0, 214)),
  };
  while (JSON.stringify(context).length > 6000 && context.dependencyNames.length) context.dependencyNames.pop();
  while (JSON.stringify(context).length > 6000 && context.declaredEntryPaths.length) context.declaredEntryPaths.pop();
  return context;
}

export function signalPositions(text: string): SourceSignals {
  const kinds: string[] = [], positions: number[] = [];
  for (const [kind, regex] of SIGNALS) {
    const spans = boundedMatches(text, regex);
    if (spans.length) kinds.push(kind);
    positions.push(...spans.map(span => span.start));
  }
  const contextKinds: string[] = [], priorityPositions: number[] = [];
  for (const [kind, regex] of CONTEXT_SIGNALS) {
    const spans = boundedMatches(text, regex);
    if (spans.length) contextKinds.push(kind);
    priorityPositions.push(...spans.flatMap(span => kind === 'encoded-payload-context'
      ? [span.start, span.end - 1] : [span.start]));
  }
  if (contextKinds.includes('worker-context') && contextKinds.includes('worker-evaluation-option')) contextKinds.push('dynamic-worker-context');
  return { kinds, positions: [...new Set(positions)].sort((a, b) => a - b), contextKinds,
    priorityPositions: [...new Set(priorityPositions)].sort((a, b) => a - b) };
}

export function rankSources(files: SourceCandidate[], manifest: Record<string, unknown>, archivePaths: string[]): {context: ManifestContext; ranked: RankedSource[]; declaredEntries: string[]; referencedFiles: number} {
  const context = manifestContext(manifest), byPath = new Map(files.map(file => [file.path, file]));
  const packageManifest = archivePaths.includes('package/package.json') ? 'package/package.json' : archivePaths.filter(path => /(?:^|\/)package\.json$/.test(path)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  const root = packageManifest ? posix.dirname(packageManifest) : 'package';
  const resolve = (from: string, request: string): string | undefined => {
    const path = posix.normalize(posix.join(from, request.replace(/\\/g, '/')));
    if (path.startsWith('../') || posix.isAbsolute(path) || (root !== '.' && path !== root && !path.startsWith(root + '/'))) return undefined;
    return [path, ...['.js', '.cjs', '.js', '.ts', '.tsx', '.jsx', '/index.js', '/index.cjs', '/index.js', '/index.ts', '/index.tsx'].map(ext => path + ext)].find(candidate => byPath.has(candidate));
  };
  const entryPaths = new Set<string>();
  for (const request of context.declaredEntryPaths) {
    const path = resolve(root, request);
    if (path) entryPaths.add(path);
  }
  for (const script of Object.values(context.lifecycleScripts)) {
    for (const match of script.matchAll(/(?:^|\s|["'])([\w./@-]+\.(?:[cm]?[jt]s|sh|bash|ps1|py))(?=$|\s|["';&])/g)) {
      const path = resolve(root, match[1]);
      if (path) entryPaths.add(path);
    }
  }
  if (!entryPaths.size) { const path = resolve(root, 'index'); if (path) entryPaths.add(path); }
  const reachable = new Set(entryPaths), queue = [...entryPaths].sort();
  for (let index = 0; index < queue.length && index < 512; index++) {
    const source = byPath.get(queue[index])!;
    let count = 0;
    for (const match of source.text.matchAll(/(?:\brequire\s*\(|\bimport\s*\(|\bimport\s+|\bfrom\s+)\s*['"](\.[^'"\r\n]{1,500})['"]/g)) {
      if (++count > 512) break;
      const path = resolve(posix.dirname(source.path), match[1]);
      if (path && !reachable.has(path)) { reachable.add(path); queue.push(path); }
    }
  }
  const ranked = files.map(file => {
    const signal = signalPositions(file.text);
    const reasons: string[] = [], declaration = isDeclaration(file.path);
    const structural = signal.contextKinds.some(kind => ['dynamic-execution-context', 'dynamic-worker-context', 'encoded-payload-context'].includes(kind));
    // Separate tiers prevent many ordinary capability categories from pushing
    // a runtime decoder or execution structure below dozens of HTTP utilities.
    // Types remain available as context, but cannot displace runtime evidence.
    let tier = declaration ? 100 : 400;
    if (entryPaths.has(file.path)) { tier = declaration ? 200 : 900; reasons.push('declared-entry-or-lifecycle'); }
    else if (reachable.has(file.path)) { tier = declaration ? 100 : structural ? 800 : 600; reasons.push('relative-source-reference'); }
    else if (!declaration && structural) tier = 700;
    if (declaration) reasons.push('type-declaration-context');
    if (!file.readme && signal.kinds.length) reasons.push(...signal.kinds);
    if (!file.readme && !declaration) reasons.push(...signal.contextKinds);
    if (file.readme) { tier = 0; reasons.push('documentation-context'); }
    if (file.manifest) { tier = 1000; reasons.push('archive-manifest'); }
    if (!reasons.length) reasons.push('deterministic-source-coverage');
    const priority = tier + (!file.readme && !declaration ? signal.kinds.length : 0);
    return { ...file, ...signal, declaration, priority, reasons };
  }).sort((a, b) => b.priority - a.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { context, ranked, declaredEntries: [...entryPaths].sort(), referencedFiles: reachable.size };
}
