import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { downloadSyntax, isSilentSpawn, namedFunctionEnd, type DownloadSyntax, type LocalFunction, type Range } from './download-syntax.js';
import { downloadHelpers, pathValue, type PathValue } from './download-summaries.js';
import { FindingCategory, Severity, type ScanFinding } from './types.js';

export function hasDownloadExecutionCandidate(content: string): boolean {
  return content.includes('require') && (/[+\\]/.test(content) ||
    ['createWriteStream', 'pipe', 'spawn', 'detached', 'stdio'].every(part => content.includes(part)));
}

function helperVisible(syntax: DownloadSyntax, name: string, index: number): boolean {
  const definition = syntax.functions.find(fn => fn.name === name);
  if (!definition) return false;
  return syntax.functions.every(outer => outer === definition || !(outer.start <= definition.declaration && definition.declaration < outer.end) ||
    (outer.start <= index && index < outer.end));
}

/**
 * Connected, bounded local helpers: HTTP response -> write stream -> optional
 * node-7z extraction -> detached, silent process. This reports a dangerous
 * capability, not confirmed malware; it does not execute code or prove control
 * flow. Custom download APIs, indirect callbacks and arbitrary transforms are
 * outside the recognized shapes. Ordinary download/build use is insufficient.
 */
export function scanDownloadExecution(content: string, filePath: string, suppliedTokens?: readonly SourceToken[]): ScanFinding[] {
  if (!hasDownloadExecutionCandidate(content)) return [];
  const syntax = downloadSyntax(content, suppliedTokens ?? tokenizeSource(content));
  const summaries = downloadHelpers(syntax);
  if (![...summaries.values()].some(summary => summary.kind === 'download')) return [];
  const globalValues = new Map<string, PathValue>();
  const scopes: (LocalFunction | undefined)[] = [undefined, ...syntax.functions];
  for (const scope of scopes) {
    const values = scope ? new Map(globalValues) : globalValues;
    for (const name of scope?.params ?? []) values.delete(name);
    const downloaded = new Set<string>(), extracted = new Set<string>();
    const get = (range?: Range) => pathValue(syntax, range, values);
    for (let index = scope?.start ?? 0; index < (scope?.end ?? syntax.tokens.length); index++) {
      const nested = namedFunctionEnd(syntax, index);
      if (nested !== undefined) { index = nested; continue; }
      const assignment = syntax.assignment(index);
      if (assignment) {
        const value = get(assignment.value);
        values.delete(assignment.name);
        if (value) values.set(assignment.name, value);
      }
      const call = syntax.call(index);
      if (!call) continue;
      const known = !call.method ? summaries.get(call.name) : undefined;
      const summary = known && helperVisible(syntax, call.name, index) ? known : undefined;
      if (summary?.kind === 'download') {
        const url = get(call.args[summary.url]), destination = get(call.args[summary.destination]);
        if (url?.text && /^https?:\/\//i.test(url.text) && destination) downloaded.add(destination.key);
      }
      if (summary?.kind === 'extract') {
        const archive = get(call.args[summary.archive]), directory = get(call.args[summary.directory]);
        if (archive && directory && downloaded.has(archive.key)) extracted.add(directory.key);
      }
      if (syntax.modules.get(call.name) === 'seven' && ['extractFull', 'extract'].includes(call.method ?? '')) {
        const archive = get(call.args[0]), directory = get(call.args[1]);
        if (archive && directory && downloaded.has(archive.key)) extracted.add(directory.key);
      }
      const executable = summary?.kind === 'launch' ? get(call.args[summary.path]) : isSilentSpawn(syntax, call) ? get(call.args[0]) : undefined;
      if (!executable || (!downloaded.has(executable.key) && !extracted.has(executable.key))) continue;
      const token = syntax.tokens[index];
      return [{
        ruleId: 'content-download-exec', ruleName: 'Downloaded content launched silently',
        severity: Severity.High, category: FindingCategory.BinaryDownload,
        message: `A local HTTP download is connected to a detached process with ignored stdio${extracted.has(executable.key) ? ' after archive extraction' : ''} in ${filePath}.`,
        filePath, lineNumber: content.slice(0, token.start).split(/\r?\n/).length,
        codeSnippet: content.slice(token.start, syntax.tokens[call.close].end).slice(0, 240),
        recommendation: 'Review the downloaded artifact, provenance, integrity verification and silent execution before installation.',
      }];
    }
  }
  return [];
}
