/** Restricted constant arithmetic/string expressions; never evaluates JavaScript. */
import { topLevelRanges } from './source-binding-patterns.js';
import type { SourceToken } from './source-tokens.js';

export type Constant = string | number;
export interface ConstantContext {
  readonly tokens: readonly SourceToken[];
  readonly pairs: ReadonlyMap<number, number>;
  readonly call: (name: string, args: readonly Constant[], depth: number) => Constant | undefined;
  remaining: number;
}

export function constantExpression(
  context: ConstantContext, start: number, end: number,
  bindings: ReadonlyMap<string, Constant> = new Map(), depth = 0,
): Constant | undefined {
  if (depth > 24 || end <= start || end - start > 1024 || context.remaining-- <= 0) return;
  const { tokens, pairs } = context;
  let cursor = start;
  const precedence: Readonly<Record<string, number>> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  const atom = (): Constant | undefined => {
    if (cursor >= end || context.remaining-- <= 0) return;
    const token = tokens[cursor++];
    if (token.kind === 'punctuation' && ['+', '-'].includes(token.value)) {
      const value = atom();
      return value === undefined ? undefined : token.value === '+' ? Number(value) : -Number(value);
    }
    if (token.value === '(' && token.kind === 'punctuation') {
      const close = pairs.get(cursor - 1);
      if (close === undefined || close >= end) return;
      const value = constantExpression(context, cursor, close, bindings, depth + 1);
      cursor = close + 1; return value;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') {
      const value = Number(token.value);
      return Number.isFinite(value) ? value : undefined;
    }
    if (token.kind !== 'identifier') return;
    if (tokens[cursor]?.value !== '(') return bindings.get(token.value);
    const close = pairs.get(cursor);
    if (close === undefined || close >= end) return;
    const ranges = topLevelRanges(tokens, pairs, cursor + 1, close).filter(range => range.end > range.start);
    if (ranges.length > 8) return;
    const args = ranges.map(range => constantExpression(context, range.start, range.end, bindings, depth + 1));
    if (args.some(value => value === undefined)) return;
    cursor = close + 1;
    if (token.value === 'parseInt' && args.length === 1) return Number.parseInt(String(args[0]));
    return context.call(token.value, args as Constant[], depth + 1);
  };
  const binary = (minimum: number): Constant | undefined => {
    let left = atom();
    while (left !== undefined && cursor < end) {
      const token = tokens[cursor];
      const rank = token.kind === 'punctuation' ? precedence[token.value] : undefined;
      if (rank === undefined || rank < minimum) break;
      cursor++;
      const right = binary(rank + 1);
      if (right === undefined) return;
      if (token.value === '+') left = typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : left + right;
      else if (token.value === '-') left = Number(left) - Number(right);
      else if (token.value === '*') left = Number(left) * Number(right);
      else if (token.value === '/') left = Number(left) / Number(right);
      else left = Number(left) % Number(right);
      if (typeof left === 'string' && left.length > 4096) return;
    }
    return left;
  };
  const result = binary(0);
  return cursor === end ? result : undefined;
}
