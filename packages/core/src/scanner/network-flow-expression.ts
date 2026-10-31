/** Small, bounded expression shapes; no execution, general JS parser or full taint engine. */
import type { SourceToken } from './source-tokens.js';

export type FlowTag = 'response' | 'body' | 'module' | 'exec' | 'execSync' | 'spawn' | 'spawnSync' | 'blocked';
export interface FlowContext {
  readonly pairs: ReadonlyMap<number, number>;
  readonly binding: (name: string) => FlowTag | undefined;
  readonly global: (index: number, name: string) => boolean;
}
const METHODS = new Set(['exec', 'execSync', 'spawn', 'spawnSync']);
const MAX_EXPRESSION_TOKENS = 256;

export function delimiterPairs(tokens: readonly SourceToken[]): ReadonlyMap<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const opening: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'punctuation') continue;
    if (['(', '[', '{'].includes(token.value)) stack.push(index);
    else if (opening[token.value]) {
      const start = stack.pop();
      if (start !== undefined && tokens[start].value === opening[token.value]) pairs.set(start, index);
      else stack.length = 0;
    }
  }
  return pairs;
}

/** Statement/list boundary, including conservative automatic-semicolon boundaries. */
export function expressionEnd(tokens: readonly SourceToken[], start: number, pairs: ReadonlyMap<number, number>, content: string): number | undefined {
  const limit = Math.min(tokens.length, start + MAX_EXPRESSION_TOKENS);
  for (let index = start; index < limit; index++) {
    const token = tokens[index];
    if (token.kind === 'punctuation' && [';', ',', ')', ']', '}'].includes(token.value)) return index;
    if (index > start && token.kind === 'identifier' && !['in', 'instanceof', 'await'].includes(token.value)
      && !['await', 'new', '.', '+', '-', '=', '?', ':', '(', '[', '{', ','].includes(tokens[index - 1].value)
      && /[\r\n\u2028\u2029]/.test(content.slice(tokens[index - 1].end, token.start))) return index;
    const close = pairs.get(index);
    if (close !== undefined) {
      if (close >= limit) return;
      index = close;
    }
  }
  return limit === tokens.length ? limit : undefined;
}

/** Recognize response.text(), copies and literal concatenations, not arbitrary transforms. */
export function flowValue(tokens: readonly SourceToken[], start: number, end: number, context: FlowContext, depth = 0): FlowTag | undefined {
  if (depth > 8 || end <= start || end - start > MAX_EXPRESSION_TOKENS || tokens[end - 1].end - tokens[start].start > 4096) return;
  const { pairs } = context;
  while (tokens[start]?.value === 'await') start++;
  if (start >= end) return;
  // Concatenation may transport command text, but unrelated unknown values do not.
  for (let index = start; index < end; index++) {
    const close = pairs.get(index);
    if (close !== undefined && close < end) { index = close; continue; }
    if (tokens[index].kind !== 'punctuation' || tokens[index].value !== '+') continue;
    const left = flowValue(tokens, start, index, context, depth + 1);
    const right = flowValue(tokens, index + 1, end, context, depth + 1);
    const literal = (first: number, last: number) => last === first + 1 && tokens[first]?.kind === 'string';
    if ((left === 'body' && (right === 'body' || literal(index + 1, end))) || (right === 'body' && literal(start, index))) return 'body';
    return;
  }
  let cursor = start + 1;
  let value: FlowTag | undefined;
  if (tokens[start].value === '(') {
    const close = pairs.get(start);
    if (close === undefined || close >= end) return;
    value = flowValue(tokens, start + 1, close, context, depth + 1);
    cursor = close + 1;
  } else if (tokens[start].kind === 'identifier') {
    const name = tokens[start].value;
    if (name === 'require' && context.binding('require') === undefined && context.global(start, 'require') && tokens[cursor]?.value === '(') {
      const close = pairs.get(cursor);
      if (close !== cursor + 2 || tokens[cursor + 1]?.kind !== 'string' || !/^(?:node:)?child_process$/.test(tokens[cursor + 1].value)) return;
      value = 'module'; cursor = close + 1;
    } else if (name === 'fetch' && context.global(start, 'fetch') && tokens[cursor]?.value === '(') {
      const close = pairs.get(cursor);
      if (close === undefined || close >= end) return;
      value = 'response'; cursor = close + 1;
    } else if (['window', 'globalThis'].includes(name) && context.global(start, name)
      && tokens[cursor]?.value === '.' && tokens[cursor + 1]?.value === 'fetch' && tokens[cursor + 2]?.value === '(') {
      const close = pairs.get(cursor + 2);
      if (close === undefined || close >= end) return;
      value = 'response'; cursor = close + 1;
    } else value = context.binding(name);
  } else return;
  while (cursor < end) {
    let property: string;
    if (tokens[cursor]?.value === '.' && tokens[cursor + 1]?.kind === 'identifier') {
      property = tokens[cursor + 1].value; cursor += 2;
    } else if (tokens[cursor]?.value === '[' && tokens[cursor + 1]?.kind === 'string' && tokens[cursor + 2]?.value === ']') {
      property = tokens[cursor + 1].value; cursor += 3;
    } else return;
    if (value === 'module' && METHODS.has(property)) value = property as FlowTag;
    else if ((value === 'response' && property === 'text') || (value === 'body' && property === 'toString')) {
      if (tokens[cursor]?.value !== '(' || pairs.get(cursor) !== cursor + 1) return;
      value = 'body'; cursor += 2;
    } else return;
  }
  return value;
}
