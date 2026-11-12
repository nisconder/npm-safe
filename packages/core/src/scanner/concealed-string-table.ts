/** Recover literal lookup tables and their pure numeric wrappers, not arbitrary code. */
import { constantExpression, type Constant, type ConstantContext } from './concealed-expression.js';
import { delimiterPairs } from './network-flow-expression.js';
import { topLevelRanges } from './source-binding-patterns.js';
import type { SourceToken } from './source-tokens.js';

interface FunctionShape { name?: string; parameters: string[]; start: number; open: number; close: number }
interface Table { strings: string[]; rotation: number; resolved: boolean }
interface Lookup { table: Table; offset: number }

function functions(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>): FunctionShape[] {
  const result: FunctionShape[] = [];
  for (let index = 0; index < tokens.length && result.length < 2048; index++) {
    if (tokens[index].kind !== 'identifier' || tokens[index].value !== 'function') continue;
    let parameter = index + 1;
    const name = tokens[parameter]?.kind === 'identifier' ? tokens[parameter++].value : undefined;
    const end = pairs.get(parameter);
    if (tokens[parameter]?.value !== '(' || end === undefined || end - parameter > 24) continue;
    const open = end + 1, close = pairs.get(open);
    if (tokens[open]?.value !== '{' || close === undefined) continue;
    const parameters = topLevelRanges(tokens, pairs, parameter + 1, end).filter(range => range.end > range.start);
    if (parameters.some(range => range.end !== range.start + 1 || tokens[range.start].kind !== 'identifier')) continue;
    result.push({ name, parameters: parameters.map(range => tokens[range.start].value), start: index, open, close });
  }
  return result;
}

/** Returns literals from a uniquely inferred checksum orientation, with work caps. */
export function concealedConstants(tokens: readonly SourceToken[]): {
  pairs: ReadonlyMap<number, number>; value: (start: number, end: number) => Constant | undefined; recovered: number;
} {
  const pairs = delimiterPairs(tokens), shapes = functions(tokens, pairs);
  if (shapes.length >= 2048) return { pairs, value: () => undefined, recovered: 0 };
  const assignments = new Map<string, number>();
  for (let index = 0; index < tokens.length; index++) if (tokens[index].kind === 'identifier' && tokens[index + 1]?.value === '=') {
    assignments.set(tokens[index].value, (assignments.get(tokens[index].value) ?? 0) + 1);
  }
  const named = new Map<string, FunctionShape>();
  const duplicates = new Set<string>();
  for (const shape of shapes) if (shape.name) {
    if (named.has(shape.name)) duplicates.add(shape.name);
    named.set(shape.name, shape);
  }
  for (const name of duplicates) named.delete(name);
  // Parameters that shadow a helper make cross-scope resolution ambiguous.
  for (const shape of shapes) for (const parameter of shape.parameters) named.delete(parameter);
  if (shapes.some(shape => shape.parameters.includes('parseInt')) || tokens.some((token, index) =>
    token.kind === 'identifier' && token.value === 'parseInt' &&
    (tokens[index + 1]?.value === '=' || ['function', 'const', 'let', 'var'].includes(tokens[index - 1]?.value)))) {
    return { pairs, value: () => undefined, recovered: 0 };
  }
  const tables = new Map<string, Table>(), lookups = new Map<string, Lookup>();
  const wrappers = new Map<string, FunctionShape>();
  const context: ConstantContext = {
    tokens, pairs, remaining: 2_000_000,
    call(name, args, depth) {
      if (depth > 24) return;
      const lookup = lookups.get(name);
      if (lookup) {
        const index = Number(args[0]) - lookup.offset;
        if (!Number.isInteger(index) || index < 0 || index >= lookup.table.strings.length) return;
        return lookup.table.strings[(index + lookup.table.rotation) % lookup.table.strings.length];
      }
      const wrapper = wrappers.get(name);
      if (!wrapper || args.length !== wrapper.parameters.length) return;
      return constantExpression(context, wrapper.open + 2, wrapper.close - 1,
        new Map(wrapper.parameters.map((parameter, index) => [parameter, args[index]])), depth + 1);
    },
  };
  const value = (start: number, end: number) => constantExpression(context, start, end);
  // A literal array inside a zero-argument factory is data, not executable source.
  for (const [name, shape] of named) {
    if (tokens[shape.open + 1]?.value === 'return' && tokens[shape.close - 1]?.value === ';' &&
      !assignments.has(name)) wrappers.set(name, shape);
    if (shape.parameters.length) continue;
    if (assignments.get(name) !== 1 || tables.size >= 32) continue;
    const begin = shape.open + 4;
    if (!['const', 'let', 'var'].includes(tokens[shape.open + 1]?.value) || tokens[shape.open + 3]?.value !== '=' || tokens[begin]?.value !== '[') continue;
    const close = pairs.get(begin);
    if (close === undefined || close >= shape.close) continue;
    const entries = topLevelRanges(tokens, pairs, begin + 1, close);
    if (entries.length < 8 || entries.length > 2048 || entries.some(range => range.end !== range.start + 1 || tokens[range.start].kind !== 'string')) continue;
    const alias = tokens[shape.open + 2]?.value;
    const expected = [';', name, '=', 'function', '(', ')', '{', 'return', alias, ';', '}', ';', 'return', name, '(', ')', ';'];
    if (close + 1 + expected.length !== shape.close || expected.some((token, index) => tokens[close + 1 + index]?.value !== token)) continue;
    tables.set(name, { strings: entries.map(range => tokens[range.start].value), rotation: 0, resolved: false });
  }
  // Recognize the common self-replacing lookup: alias=factory(); n=n-offset; alias[n].
  for (const [name, shape] of named) {
    if (assignments.get(name) !== 1) continue;
    const first = shape.open + 1;
    if (!['const', 'let', 'var'].includes(tokens[first]?.value) || tokens[first + 2]?.value !== '=' || tokens[first + 4]?.value !== '(' || tokens[first + 5]?.value !== ')') continue;
    const table = tables.get(tokens[first + 3].value), alias = tokens[first + 1]?.value;
    if (!table) continue;
    const nested = shapes.find(candidate => !candidate.name && candidate.start > first && candidate.close < shape.close && tokens[candidate.start - 1]?.value === '=' && tokens[candidate.start - 2]?.value === name);
    if (!nested || !nested.parameters.length) continue;
    if (tokens[first + 6]?.value !== ';' || tokens[first + 7]?.value !== 'return' || first + 10 !== nested.start) continue;
    const tail = [',', name, '('];
    shape.parameters.forEach((parameter, index) => { if (index) tail.push(','); tail.push(parameter); });
    tail.push(')', ';');
    if (nested.close + 1 + tail.length !== shape.close || tail.some((token, index) => tokens[nested.close + 1 + index]?.value !== token)) continue;
    const parameter = nested.parameters[0], assignment = nested.open + 1;
    if (tokens[assignment]?.value !== parameter || tokens[assignment + 1]?.value !== '=' || tokens[assignment + 2]?.value !== parameter || tokens[assignment + 3]?.value !== '-') continue;
    let end = assignment + 4;
    while (end < nested.close && end - assignment < 128 && tokens[end].value !== ';') end++;
    const offset = value(assignment + 4, end);
    if (typeof offset !== 'number' || !Number.isFinite(offset)) continue;
    if (!['let', 'const', 'var'].includes(tokens[end + 1]?.value) || tokens[end + 3]?.value !== '=' || tokens[end + 4]?.value !== alias || tokens[end + 5]?.value !== '[' || tokens[end + 6]?.value !== parameter || tokens[end + 7]?.value !== ']') continue;
    if (tokens[end + 8]?.value !== ';' || tokens[end + 9]?.value !== 'return' || tokens[end + 10]?.value !== tokens[end + 2]?.value || tokens[end + 11]?.value !== ';' || end + 12 !== nested.close) continue;
    lookups.set(name, { table, offset });
  }
  // Derive a rotation only from the table's startup checksum, never from desired
  // module names or threat indicators. Enumeration is finite and side-effect free.
  for (const shape of shapes) {
    if (shape.name || shape.parameters.length !== 2 || tokens[shape.close + 1]?.value !== '(') continue;
    const callClose = pairs.get(shape.close + 1);
    if (callClose === undefined) continue;
    const args = topLevelRanges(tokens, pairs, shape.close + 2, callClose);
    if (args.length !== 2 || args[0].end !== args[0].start + 1) continue;
    const table = tables.get(tokens[args[0].start].value), target = value(args[1].start, args[1].end);
    if (!table || typeof target !== 'number' || !Number.isFinite(target)) continue;
    let array: string | undefined;
    // The array being rotated must come from this IIFE's factory parameter.
    for (let cursor = shape.open + 1; cursor < shape.close; cursor++) {
      if (['const', 'let', 'var'].includes(tokens[cursor].value) && tokens[cursor + 2]?.value === '=' &&
        tokens[cursor + 3]?.value === shape.parameters[0] && tokens[cursor + 4]?.value === '(' && tokens[cursor + 5]?.value === ')') {
        array = tokens[cursor + 1]?.value; break;
      }
      const close = pairs.get(cursor);
      if (close !== undefined) cursor = close;
    }
    if (!array) continue;
    const loops: { start: number; end: number }[] = [];
    for (let cursor = shape.open + 1; cursor < shape.close; cursor++) {
      if (tokens[cursor].value !== 'while') continue;
      const expected = ['(', '!', '!', '[', ']', ')', '{'];
      if (expected.some((token, offset) => tokens[cursor + 1 + offset]?.value !== token)) continue;
      const end = pairs.get(cursor + 7);
      if (end !== undefined) loops.push({ start: cursor + 7, end });
    }
    for (let index = shape.open + 1; index < shape.close; index++) {
      if (tokens[index].value !== 'if' || tokens[index + 1]?.value !== '(' || tokens[index + 3]?.value !== '=' || tokens[index + 4]?.value !== '=' || tokens[index + 5]?.value !== '=' || tokens[index + 6]?.value !== shape.parameters[1] || tokens[index + 8]?.value !== 'break') continue;
      if (!loops.some(loop => index > loop.start && index < loop.end)) continue;
      if (tokens[index + 9]?.value !== ';' || tokens[index + 10]?.value !== 'else') continue;
      let branch = index + 11;
      if (tokens[branch]?.value === '{') branch++;
      const rotate = [array, '[', 'push', ']', '(', array, '[', 'shift', ']', '(', ')', ')', ';'];
      if (rotate.some((token, offset) => tokens[branch + offset]?.value !== token)) continue;
      const check = tokens[index + 2]?.value;
      let start = index - 1;
      for (; start > shape.open && index - start < 2048; start--) if (tokens[start].value === check && tokens[start + 1]?.value === '=') break;
      if (start <= shape.open || tokens[index - 1]?.value !== ';' || !['const', 'let', 'var'].includes(tokens[start - 1]?.value)) continue;
      const matches: number[] = [];
      for (let rotation = 0; rotation < table.strings.length && context.remaining > 0; rotation++) {
        table.rotation = rotation;
        if (value(start + 2, index - 1) === target) matches.push(rotation);
      }
      if (context.remaining > 0 && matches.length === 1) { table.rotation = matches[0]; table.resolved = true; }
      break;
    }
  }
  for (const [name, lookup] of lookups) if (!lookup.table.resolved) lookups.delete(name);
  return { pairs, value, recovered: lookups.size };
}
