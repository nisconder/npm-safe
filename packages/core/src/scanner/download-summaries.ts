import { literal, namedFunctionEnd, type Call, type DownloadSyntax, type Range, isSilentSpawn } from './download-syntax.js';

export interface DownloadHelper { kind: 'download'; url: number; destination: number }
export interface ExtractHelper { kind: 'extract'; archive: number; directory: number }
export interface LaunchHelper { kind: 'launch'; path: number }
export type Helper = DownloadHelper | ExtractHelper | LaunchHelper;
interface ParamValue { parameter: number; kind?: 'stream' | 'entries' | 'entry' }

function parameterValue(syntax: DownloadSyntax, range: Range | undefined, env: ReadonlyMap<string, ParamValue>, depth = 0): ParamValue | undefined {
  if (!range || range.end <= range.start || range.end - range.start > 256 || depth > 8) return;
  if (range.end === range.start + 1 && syntax.tokens[range.start].kind === 'identifier') {
    const name = syntax.tokens[range.start].value;
    return syntax.ambiguousValues.has(name) ? undefined : env.get(name);
  }
  const call = syntax.call(range.start);
  if (!call || call.close !== range.end - 1) return;
  const module = syntax.modules.get(call.name);
  if (module === 'path' && call.method === 'join') {
    const base = parameterValue(syntax, call.args[0], env, depth + 1);
    if (!base || base.kind) return;
    for (const arg of call.args.slice(1)) {
      const entry = parameterValue(syntax, arg, env, depth + 1), name = literal(syntax, arg);
      if (entry?.kind === 'entry' && entry.parameter === base.parameter) continue;
      if (name && !/[\\/]/.test(name) && !['.', '..'].includes(name)) continue;
      return;
    }
    return base;
  }
  if (module === 'fs' && call.method === 'createWriteStream') {
    const path = parameterValue(syntax, call.args[0], env, depth + 1);
    if (path && !path.kind) return { ...path, kind: 'stream' };
  }
  if (module === 'fs' && call.method === 'readdirSync') {
    const directory = parameterValue(syntax, call.args[0], env, depth + 1);
    if (directory && !directory.kind) return { ...directory, kind: 'entries' };
  }
  const receiver = env.get(call.name);
  if (receiver?.kind === 'entries' && call.method === 'find') return { ...receiver, kind: 'entry' };
  return;
}

function responseCallback(syntax: DownloadSyntax, range: Range | undefined): { name: string; start: number; end: number } | undefined {
  if (!range) return;
  const { tokens, pairs } = syntax;
  let open = range.start;
  if (tokens[open]?.value === 'function') open++;
  if (tokens[open]?.value === '(') {
    const close = pairs.get(open);
    if (close !== open + 2 || tokens[open + 1]?.kind !== 'identifier') return;
    let brace = close + 1;
    if (tokens[brace]?.value === '=' && tokens[brace + 1]?.value === '>') brace += 2;
    const end = pairs.get(brace);
    if (tokens[brace]?.value === '{' && end !== undefined && end < range.end) return { name: tokens[open + 1].value, start: brace + 1, end };
  } else if (tokens[open]?.kind === 'identifier' && tokens[open + 1]?.value === '=' && tokens[open + 2]?.value === '>') {
    const brace = open + 3, end = pairs.get(brace);
    if (tokens[brace]?.value === '{' && end !== undefined && end < range.end) return { name: tokens[open].value, start: brace + 1, end };
  }
  return;
}

function pipedDestination(syntax: DownloadSyntax, call: Call, env: ReadonlyMap<string, ParamValue>): number | undefined {
  const callback = responseCallback(syntax, call.args[1]);
  if (!callback) return;
  const local = new Map(env);
  local.delete(callback.name);
  for (let index = callback.start; index < callback.end; index++) {
    const nested = namedFunctionEnd(syntax, index);
    if (nested !== undefined) { index = nested; continue; }
    if (syntax.tokens[index].value === callback.name && syntax.tokens[index + 1]?.value === '=') return;
    const assignment = syntax.assignment(index);
    if (assignment) {
      const value = parameterValue(syntax, assignment.value, local);
      local.delete(assignment.name);
      if (value) local.set(assignment.name, value);
    }
    const pipe = syntax.call(index);
    if (!pipe || pipe.name !== callback.name || pipe.method !== 'pipe') continue;
    const target = parameterValue(syntax, pipe.args[0], local);
    if (target?.kind === 'stream') return target.parameter;
  }
  return;
}

/** Summarize recognized effects on formal parameters, not function names. */
export function downloadHelpers(syntax: DownloadSyntax): ReadonlyMap<string, Helper> {
  const summaries = new Map<string, Helper>();
  for (const fn of syntax.functions) {
    const env = new Map<string, ParamValue>(fn.params.map((name, parameter) => [name, { parameter }]));
    let summary: Helper | undefined;
    for (let index = fn.start; index < fn.end; index++) {
      const nested = namedFunctionEnd(syntax, index);
      if (nested !== undefined) { index = nested; continue; }
      const assignment = syntax.assignment(index);
      if (assignment) {
        const value = parameterValue(syntax, assignment.value, env);
        env.delete(assignment.name);
        if (value) env.set(assignment.name, value);
      }
      const call = syntax.call(index);
      if (!call) continue;
      const module = syntax.modules.get(call.name);
      if (module === 'http' && ['get', 'request'].includes(call.method ?? '')) {
        const url = parameterValue(syntax, call.args[0], env), destination = pipedDestination(syntax, call, env);
        if (url && !url.kind && destination !== undefined) summary = { kind: 'download', url: url.parameter, destination };
      }
      if (module === 'seven' && ['extractFull', 'extract'].includes(call.method ?? '')) {
        const archive = parameterValue(syntax, call.args[0], env), directory = parameterValue(syntax, call.args[1], env);
        if (archive && directory && !archive.kind && !directory.kind) summary = { kind: 'extract', archive: archive.parameter, directory: directory.parameter };
      }
      if (isSilentSpawn(syntax, call)) {
        const path = parameterValue(syntax, call.args[0], env);
        if (path && !path.kind) summary = { kind: 'launch', path: path.parameter };
      }
    }
    if (summary) summaries.set(fn.name, summary);
  }
  return summaries;
}

export interface PathValue { key: string; text?: string }

/** Stable local aliases and path construction only, no arbitrary function evaluation. */
export function pathValue(syntax: DownloadSyntax, range: Range | undefined, env: ReadonlyMap<string, PathValue>, depth = 0): PathValue | undefined {
  if (!range || range.end <= range.start || range.end - range.start > 256 || depth > 8) return;
  const first = syntax.tokens[range.start];
  if (range.end === range.start + 1) {
    if (first.kind === 'identifier') return syntax.ambiguousValues.has(first.value) ? undefined : env.get(first.value);
    if (first.kind === 'string') return { key: `literal:${first.value}`, text: first.value };
  }
  const call = syntax.call(range.start);
  if (call && call.close === range.end - 1 && syntax.modules.get(call.name) === 'path' && ['join', 'resolve'].includes(call.method ?? '')) {
    const parts = call.args.map(arg => pathValue(syntax, arg, env, depth + 1));
    if (parts.every((part): part is PathValue => part !== undefined)) return { key: `${call.method}:${JSON.stringify(parts.map(part => part.key))}` };
  }
  // Host temporary directories are path roots, not an exfiltration source.
  const values = syntax.tokens.slice(range.start, range.end).map(token => token.value);
  if (values.length === 5 && values[0] === 'process' && values[1] === '.' && values[2] === 'env' && values[3] === '.' && ['TEMP', 'TMP', 'TMPDIR'].includes(values[4])) {
    return { key: `environment:${values[4]}` };
  }
  return;
}
