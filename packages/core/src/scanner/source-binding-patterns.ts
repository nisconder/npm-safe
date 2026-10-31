import type { SourceToken } from './source-tokens.js';

export interface BindingRange { readonly start: number; readonly end: number }

/** Split syntax-level lists without entering nested expressions. */
export function topLevelRanges(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>, start: number, end: number): BindingRange[] {
  const ranges: BindingRange[] = [];
  let first = start;
  for (let index = start; index < end; index++) {
    if (tokens[index].kind !== 'punctuation') continue;
    const close = pairs.get(index);
    if (close !== undefined && close < end) index = close;
    else if (tokens[index].value === ',') { ranges.push({ start: first, end: index }); first = index + 1; }
  }
  ranges.push({ start: first, end });
  return ranges;
}

/** Resolve binding patterns only; never interpret default-value expressions. */
export function bindingNames(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>, start: number, end: number): string[] {
  const names: string[] = [];
  const pending: BindingRange[] = [{ start, end }];
  while (pending.length) {
    const range = pending.pop()!;
    let first = range.start;
    while (tokens[first]?.value === '.' && first < range.end) first++;
    if (first >= range.end) continue;
    const token = tokens[first];
    if (token.kind === 'identifier') { names.push(token.value); continue; }
    if (!['{', '['].includes(token.value)) continue;
    const close = pairs.get(first);
    if (close === undefined || close >= range.end) continue;
    for (const part of topLevelRanges(tokens, pairs, first + 1, close)) {
      let valueStart = part.start;
      if (token.value === '{') {
        for (let index = part.start; index < part.end; index++) {
          const nested = pairs.get(index);
          if (nested !== undefined && nested < part.end) index = nested;
          else if (tokens[index].value === ':') { valueStart = index + 1; break; }
          else if (tokens[index].value === '=') break;
        }
      }
      pending.push({ start: valueStart, end: part.end });
    }
  }
  return names;
}
