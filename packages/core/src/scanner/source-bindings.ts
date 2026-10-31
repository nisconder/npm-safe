/** Conservative lexical bindings for the browser globals inspected by content rules. */
import { bindingNames, topLevelRanges } from './source-binding-patterns.js';
import type { SourceToken } from './source-tokens.js';

interface Scope { start: number; end: number; parent: number; isFunction: boolean }
interface Interval { start: number; end: number }
const GLOBAL_NAMES = ['fetch', 'window', 'globalThis', 'XMLHttpRequest', 'Response', 'require'] as const;

export function globalReferenceCheck(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>): (index: number, name: string) => boolean {
  const scopes: Scope[] = [{ start: 0, end: tokens.length, parent: -1, isFunction: true }];
  const scopeAt = new Uint32Array(tokens.length);
  const bodyScopes = new Map<number, number>();
  const stack = [0];
  for (let index = 0; index < tokens.length; index++) {
    while (stack.length > 1 && index > scopes[stack[stack.length - 1]].end) stack.pop();
    if (tokens[index].kind === 'punctuation' && tokens[index].value === '{' && pairs.has(index)) {
      scopes.push({ start: index, end: pairs.get(index)!, parent: stack[stack.length - 1], isFunction: false });
      stack.push(scopes.length - 1);
      bodyScopes.set(index, scopes.length - 1);
    }
    scopeAt[index] = stack[stack.length - 1];
  }
  const intervals = new Map<string, Interval[]>(GLOBAL_NAMES.map(name => [name, []]));
  const bind = (names: readonly string[], scope: Interval) => {
    for (const name of names) intervals.get(name)?.push(scope);
  };
  const reverse = new Map([...pairs].map(([open, close]) => [close, open]));
  const expressionEnds = new Uint32Array(tokens.length + 1);
  expressionEnds[tokens.length] = tokens.length;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const delimiter = tokens[index].kind === 'punctuation' && [',', ';', ')', ']', '}'].includes(tokens[index].value);
    const close = pairs.get(index);
    expressionEnds[index] = delimiter ? index : expressionEnds[close === undefined ? index + 1 : close + 1];
  }
  const bodyRange = (start: number): Interval => {
    const closing = pairs.get(start);
    if (tokens[start]?.value === '{' && closing !== undefined) {
      const scope = bodyScopes.get(start);
      if (scope !== undefined) scopes[scope].isFunction = true;
      return { start, end: closing };
    }
    return { start, end: expressionEnds[start] ?? tokens.length };
  };
  // Function/catch parameters are confined to their body, including arrow expressions.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== 'identifier') continue;
    if (tokens[index].value === 'function' || tokens[index].value === 'catch') {
      let parameter = index + 1;
      if (tokens[parameter]?.value === '*') parameter++;
      const name = tokens[parameter]?.kind === 'identifier' ? tokens[parameter++] : undefined;
      const close = pairs.get(parameter);
      if (tokens[parameter]?.value !== '(' || close === undefined) continue;
      const body = bodyRange(close + 1);
      for (const range of topLevelRanges(tokens, pairs, parameter + 1, close)) bind(bindingNames(tokens, pairs, range.start, range.end), body);
      if (name) {
        const expression = ['=', ':', '(', ',', 'return'].includes(tokens[index - 1]?.value);
        bind([name.value], expression ? body : scopes[scopeAt[index]]);
      }
    }
  }
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index + 1].value !== '=' || tokens[index + 2].value !== '>') continue;
    const body = bodyRange(index + 3);
    if (tokens[index].value === ')') {
      const open = reverse.get(index);
      if (open !== undefined) for (const range of topLevelRanges(tokens, pairs, open + 1, index)) bind(bindingNames(tokens, pairs, range.start, range.end), body);
    } else if (tokens[index].kind === 'identifier') bind([tokens[index].value], body);
  }
  // Object/class methods have parameter lists without a function keyword.
  for (let index = 1; index < tokens.length; index++) {
    if (tokens[index].kind !== 'punctuation' || tokens[index].value !== '(') continue;
    const close = pairs.get(index);
    const previous = tokens[index - 1];
    if (close === undefined || tokens[close + 1]?.value !== '{') continue;
    if (!['identifier', 'string'].includes(previous.kind) && previous.value !== ']') continue;
    if (['if', 'while', 'for', 'with', 'switch', 'catch', 'function'].includes(previous.value)) continue;
    const body = bodyRange(close + 1);
    for (const range of topLevelRanges(tokens, pairs, index + 1, close)) bind(bindingNames(tokens, pairs, range.start, range.end), body);
  }
  // Declarations use lexical blocks; var binds the nearest recognized function body.
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier') continue;
    let scope = scopeAt[index];
    if (['const', 'let', 'var'].includes(token.value)) {
      if (token.value === 'var') while (!scopes[scope].isFunction && scopes[scope].parent >= 0) scope = scopes[scope].parent;
      let end = index + 1;
      while (end < tokens.length) {
        if ([';', 'in', 'of', ')'].includes(tokens[end].value)) break;
        const close = pairs.get(end);
        end = close === undefined ? end + 1 : close + 1;
      }
      for (const range of topLevelRanges(tokens, pairs, index + 1, end)) bind(bindingNames(tokens, pairs, range.start, range.end), scopes[scope]);
    } else if (token.value === 'class' && tokens[index + 1]?.kind === 'identifier') {
      bind([tokens[index + 1].value], scopes[scope]);
    } else if (token.value === 'import' && tokens[index + 1]?.value !== '(') {
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        const imported = tokens[cursor];
        if (imported.kind === 'string' || imported.value === ';' || imported.value === 'from') break;
        if (imported.kind === 'identifier' && imported.value !== 'as' && tokens[cursor + 1]?.value !== 'as') bind([imported.value], scopes[scope]);
      }
    }
  }
  const masks = new Uint8Array(tokens.length);
  GLOBAL_NAMES.forEach((name, bit) => {
    const differences = new Int32Array(tokens.length + 1);
    for (const interval of intervals.get(name)!) {
      differences[interval.start]++;
      differences[Math.min(interval.end + 1, tokens.length)]--;
    }
    let active = 0;
    for (let index = 0; index < tokens.length; index++) {
      active += differences[index];
      if (active > 0) masks[index] |= 1 << bit;
    }
  });
  return (index, name) => {
    const bit = GLOBAL_NAMES.findIndex(candidate => candidate === name);
    return bit < 0 || !(masks[index] & (1 << bit));
  };
}
