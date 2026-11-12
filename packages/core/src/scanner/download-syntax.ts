import { delimiterPairs, expressionEnd } from './network-flow-expression.js';
import { bindingNames, topLevelRanges, type BindingRange } from './source-binding-patterns.js';
import { globalReferenceCheck } from './source-bindings.js';
import type { SourceToken } from './source-tokens.js';

export type Range = BindingRange;
export interface LocalFunction { name: string; params: string[]; start: number; end: number; declaration: number }
export interface Call { start: number; open: number; close: number; name: string; method?: string; args: Range[] }
export interface DownloadSyntax {
  tokens: readonly SourceToken[];
  pairs: ReadonlyMap<number, number>;
  functions: LocalFunction[];
  modules: ReadonlyMap<string, string>;
  ambiguousValues: ReadonlySet<string>;
  call(index: number): Call | undefined;
  assignment(index: number): { name: string; value: Range } | undefined;
}

export function property(syntax: DownloadSyntax, range: Range | undefined, name: string): Range | undefined {
  if (!range || syntax.tokens[range.start]?.value !== '{' || syntax.pairs.get(range.start) !== range.end - 1) return;
  let found: Range | undefined;
  for (const member of topLevelRanges(syntax.tokens, syntax.pairs, range.start + 1, range.end - 1)) {
    const key = syntax.tokens[member.start];
    if (key?.value === '.') { found = undefined; continue; }
    if (!['identifier', 'string'].includes(key?.kind) || key.value !== name) continue;
    found = syntax.tokens[member.start + 1]?.value === ':' ? { start: member.start + 2, end: member.end }
      : member.end === member.start + 1 ? member : undefined;
  }
  return found;
}

/** Nested declarations are definitions, not effects of the enclosing helper. */
export function namedFunctionEnd(syntax: DownloadSyntax, index: number): number | undefined {
  if (syntax.tokens[index]?.value !== 'function' || syntax.tokens[index + 1]?.kind !== 'identifier') return;
  const close = syntax.pairs.get(index + 2);
  return close === undefined ? undefined : syntax.pairs.get(close + 1);
}

export function literal(syntax: DownloadSyntax, range: Range | undefined): string | undefined {
  if (range && range.end === range.start + 1 && syntax.tokens[range.start].kind === 'string') return syntax.tokens[range.start].value;
  return;
}

export function isSilentSpawn(syntax: DownloadSyntax, call: Call): boolean {
  const kind = syntax.modules.get(call.name);
  if (!(kind === 'spawn' && !call.method) && !(kind === 'process' && call.method === 'spawn')) return false;
  const detached = property(syntax, call.args[2], 'detached');
  return !!detached && detached.end === detached.start + 1 && syntax.tokens[detached.start].value === 'true' &&
    literal(syntax, property(syntax, call.args[2], 'stdio')) === 'ignore';
}

/** Only stable CommonJS bindings are recognized; ambiguous/reassigned names are excluded. */
export function downloadSyntax(content: string, tokens: readonly SourceToken[]): DownloadSyntax {
  const pairs = delimiterPairs(tokens);
  const reverse = new Map([...pairs].map(([start, end]) => [end, start]));
  const global = globalReferenceCheck(tokens, pairs);
  const functions: LocalFunction[] = [];
  const modules = new Map<string, string>();
  const declarations = new Map<string, number>();
  const writes = new Map<string, number>();
  const parameters = new Set<string>();
  const moduleKinds: Record<string, string> = { fs: 'fs', path: 'path', https: 'http', http: 'http', 'node-7z': 'seven', child_process: 'process' };
  const simpleName = (range: Range): string | undefined => range.end === range.start + 1 && tokens[range.start]?.kind === 'identifier' ? tokens[range.start].value : undefined;
  for (let index = 0; index < tokens.length; index++) {
    if (['function', 'catch'].includes(tokens[index].value)) {
      let open = index + 1;
      if (tokens[open]?.value === '*') open++;
      if (tokens[open]?.kind === 'identifier') open++;
      const close = pairs.get(open);
      if (tokens[open]?.value === '(' && close !== undefined) {
        for (const range of topLevelRanges(tokens, pairs, open + 1, close)) {
          for (const name of bindingNames(tokens, pairs, range.start, range.end)) parameters.add(name);
        }
      }
    }
    if (tokens[index + 1]?.value === '=' && tokens[index + 2]?.value === '>') {
      if (tokens[index].kind === 'identifier') parameters.add(tokens[index].value);
      const open = tokens[index].value === ')' ? reverse.get(index) : undefined;
      if (open !== undefined) for (const range of topLevelRanges(tokens, pairs, open + 1, index)) {
        for (const name of bindingNames(tokens, pairs, range.start, range.end)) parameters.add(name);
      }
    }
    if (tokens[index].value === '(' && tokens[index - 1]?.kind === 'identifier' &&
      !['if', 'while', 'for', 'switch', 'with'].includes(tokens[index - 1].value)) {
      const close = pairs.get(index);
      if (close !== undefined && tokens[close + 1]?.value === '{') {
        for (const range of topLevelRanges(tokens, pairs, index + 1, close)) {
          for (const name of bindingNames(tokens, pairs, range.start, range.end)) parameters.add(name);
        }
      }
    }
    if (tokens[index].value === 'function' && tokens[index + 1]?.kind === 'identifier' && tokens[index + 2]?.value === '(') {
      const close = pairs.get(index + 2), end = close === undefined ? undefined : pairs.get(close + 1);
      if (close !== undefined && end !== undefined && tokens[close + 1]?.value === '{' && end - close <= 12000) {
        const args = topLevelRanges(tokens, pairs, index + 3, close).filter(range => range.end > range.start);
        const params = args.map(simpleName);
        if (params.every((name): name is string => name !== undefined)) functions.push({ name: tokens[index + 1].value, params, start: close + 2, end, declaration: index });
      }
    }
    if (['const', 'let', 'var'].includes(tokens[index].value) && tokens[index + 1]?.kind === 'identifier') {
      const name = tokens[index + 1].value;
      declarations.set(name, (declarations.get(name) ?? 0) + 1);
    }
    if (tokens[index].kind === 'identifier' && tokens[index + 1]?.value === '=' && !['=', '>'].includes(tokens[index + 2]?.value)) {
      writes.set(tokens[index].value, (writes.get(tokens[index].value) ?? 0) + 1);
    }
    if (tokens[index].value !== 'require' || !global(index, 'require') || tokens[index + 1]?.value !== '(' || pairs.get(index + 1) !== index + 3) continue;
    const specifier = tokens[index + 2];
    const kind = specifier.kind === 'string' ? moduleKinds[specifier.value.replace(/^node:/, '')] : undefined;
    if (!kind || tokens[index - 1]?.value !== '=') continue;
    if (tokens[index - 2]?.kind === 'identifier') modules.set(tokens[index - 2].value, kind);
    if (kind === 'process' && tokens[index - 2]?.value === '}') {
      const open = reverse.get(index - 2);
      if (open === undefined) continue;
      for (const member of topLevelRanges(tokens, pairs, open + 1, index - 2)) {
        if (tokens[member.start]?.value !== 'spawn') continue;
        const local = tokens[member.start + 1]?.value === ':' ? tokens[member.start + 2] : tokens[member.start];
        if (local?.kind === 'identifier') modules.set(local.value, 'spawn');
      }
    }
  }
  for (const name of modules.keys()) {
    if ((writes.get(name) ?? 0) > 1 || (declarations.get(name) ?? 0) > 1 || parameters.has(name)) modules.delete(name);
  }
  // Duplicate local helpers are ambiguous and must not connect unrelated scopes.
  const counts = new Map<string, number>();
  for (const fn of functions) counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1);
  const uniqueFunctions = functions.filter(fn => counts.get(fn.name) === 1 && !writes.has(fn.name) && !parameters.has(fn.name));
  return {
    tokens, pairs, functions: uniqueFunctions, modules,
    ambiguousValues: new Set([...declarations].filter(([, count]) => count > 1).map(([name]) => name)),
    call(index) {
      const token = tokens[index];
      if (token?.kind !== 'identifier' || ['.', '?', 'function', 'class'].includes(tokens[index - 1]?.value)) return;
      const member = tokens[index + 1]?.value === '.' && tokens[index + 2]?.kind === 'identifier';
      const open = index + (member ? 3 : 1), close = pairs.get(open);
      if (tokens[open]?.value !== '(' || close === undefined || close - index > 12000 || tokens[close + 1]?.value === '{') return;
      return { start: index, open, close, name: token.value, method: member ? tokens[index + 2].value : undefined,
        args: topLevelRanges(tokens, pairs, open + 1, close).filter(range => range.end > range.start) };
    },
    assignment(index) {
      if (tokens[index]?.kind !== 'identifier' || ['.', '?'].includes(tokens[index - 1]?.value) || tokens[index + 1]?.value !== '=' || ['=', '>'].includes(tokens[index + 2]?.value)) return;
      const end = expressionEnd(tokens, index + 2, pairs, content);
      if (end !== undefined) return { name: tokens[index].value, value: { start: index + 2, end } };
      return { name: tokens[index].value, value: { start: index + 2, end: index + 2 } };
    },
  };
}
