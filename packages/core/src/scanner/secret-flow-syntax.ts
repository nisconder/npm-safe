import { delimiterPairs, expressionEnd } from './network-flow-expression.js';
import { bindingNames, topLevelRanges, type BindingRange } from './source-binding-patterns.js';
import type { SourceToken } from './source-tokens.js';
import { propertyMutationCheck } from './secret-flow-writes.js';

export interface SecretFunction {
  readonly id: number;
  readonly key?: string;
  readonly nameIndex: number;
  readonly parentScope: number;
  readonly scope: number;
  readonly start: number;
  readonly end: number;
  readonly parameters: readonly string[];
  readonly blockedParameters: readonly string[];
}
interface Scope { parent: number; start: number; end: number; owner?: number }
export interface SecretBinding {
  readonly scope: number;
  readonly parameter?: { functionId: number; position: number };
  readonly values: Array<BindingRange & { at: number; scope: number }>;
}
export interface SecretSyntax {
  readonly content: string;
  readonly tokens: readonly SourceToken[];
  readonly pairs: ReadonlyMap<number, number>;
  readonly functions: readonly SecretFunction[];
  readonly owner: (index: number) => number | undefined;
  readonly binding: (name: string, index: number) => SecretBinding | undefined;
  readonly visible: (scope: number, index: number) => boolean;
  readonly mutated: (name: string, index: number, property?: string) => boolean;
  readonly functionForCall: (key: string, index: number) => SecretFunction | undefined;
}

/** Lexical scope/assignment index, not a parser; unsupported bindings stay unknown. */
export function secretSyntax(content: string, tokens: readonly SourceToken[]): SecretSyntax {
  const pairs = delimiterPairs(tokens);
  const scopes: Scope[] = [{ parent: -1, start: 0, end: tokens.length }];
  const at = new Uint32Array(tokens.length);
  const braces = new Map<number, number>();
  const stack = [0];
  for (let index = 0; index < tokens.length; index++) {
    while (stack.length > 1 && index > scopes[stack.at(-1)!].end) stack.pop();
    if (tokens[index].kind === 'punctuation' && tokens[index].value === '{' && pairs.has(index)) {
      const id = scopes.length;
      scopes.push({ parent: stack.at(-1)!, start: index, end: pairs.get(index)! });
      braces.set(index, id); stack.push(id);
    }
    at[index] = stack.at(-1)!;
  }
  const classes = new Map<number, string>();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'class' || tokens[index + 1]?.kind !== 'identifier') continue;
    for (let cursor = index + 2; cursor < Math.min(tokens.length, index + 32); cursor++) {
      if (tokens[cursor].value !== '{') continue;
      const scope = braces.get(cursor);
      if (scope !== undefined) classes.set(scope, tokens[index + 1].value);
      break;
    }
  }
  const functions: SecretFunction[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== '(' || tokens[index].kind !== 'punctuation') continue;
    const close = pairs.get(index);
    if (close === undefined || close - index > 128) continue;
    const arrow = tokens[close + 1]?.value === '=' && tokens[close + 2]?.value === '>';
    const body = close + (arrow ? 3 : 1);
    const scope = braces.get(body);
    const previous = tokens[index - 1];
    if (scope === undefined || !previous || ['if', 'while', 'for', 'switch', 'with'].includes(previous.value)) continue;
    const declaration = tokens[index - 2]?.value === 'function';
    const anonymous = previous.value === 'function' || arrow || previous.value === 'catch';
    const className = classes.get(at[index]);
    const method = className && tokens[index - 2]?.value === 'static';
    // Ordinary object methods are still scopes, but cannot form global helper summaries.
    if (!anonymous && previous.kind !== 'identifier') continue;
    const ranges = topLevelRanges(tokens, pairs, index + 1, close);
    const params = ranges.map(range =>
      tokens[range.start]?.kind === 'identifier' ? tokens[range.start].value : '');
    if (params.length > 16) continue;
    const fn: SecretFunction = {
      id: functions.length, nameIndex: index - 1, parentScope: method ? scopes[at[index]].parent : scopes[scope].parent, scope,
      start: body, end: pairs.get(body)!, parameters: params,
      blockedParameters: ranges.flatMap((range, position) => params[position] ? [] : bindingNames(tokens, pairs, range.start, range.end)),
      key: declaration ? previous.value : method ? `${className}.${previous.value}` : undefined,
    };
    functions.push(fn); scopes[scope].owner = fn.id;
  }
  // Arrow callbacks without a block still introduce lexical parameter scopes.
  // Index them as anonymous functions so an outer secret cannot leak through a
  // same-named callback parameter merely because its body is an expression.
  const opening = new Map([...pairs].map(([start, end]) => [end, start]));
  for (let index = 1; index < tokens.length - 2; index++) {
    if (tokens[index].value !== '=' || tokens[index + 1].value !== '>') continue;
    const body = index + 2;
    let scope = braces.get(body);
    if (scope !== undefined && scopes[scope].owner !== undefined) continue;
    const previous = tokens[index - 1];
    const first = previous.value === ')' ? opening.get(index - 1) : index - 1;
    if (first === undefined || (previous.value !== ')' && previous.kind !== 'identifier')) continue;
    const ranges = previous.value === ')' ? topLevelRanges(tokens, pairs, first + 1, index - 1) : [{ start: first, end: index }];
    const parameters = ranges.map(range => tokens[range.start]?.kind === 'identifier' ? tokens[range.start].value : '');
    const end = scope === undefined ? expressionEnd(tokens, body, pairs, content) : scopes[scope].end + 1;
    if (end === undefined || parameters.length > 16) continue;
    if (scope === undefined) {
      const parent = at[body]; scope = scopes.length;
      scopes.push({ parent, start: body, end: end - 1 });
      for (let cursor = body; cursor < end; cursor++) {
        if (at[cursor] === parent) at[cursor] = scope;
        else if (scopes[at[cursor]].parent === parent) scopes[at[cursor]].parent = scope;
      }
    }
    const fn: SecretFunction = { id: functions.length, nameIndex: first, parentScope: scopes[scope].parent,
      scope, start: body, end: end - 1, parameters,
      blockedParameters: ranges.flatMap((range, position) => parameters[position] ? [] : bindingNames(tokens, pairs, range.start, range.end)) };
    functions.push(fn); scopes[scope].owner = fn.id;
  }
  const owner = (index: number): number | undefined => {
    for (let scope = at[index] ?? 0, count = 0; scope >= 0 && count < 64; scope = scopes[scope].parent, count++) {
      if (scopes[scope].owner !== undefined) return scopes[scope].owner;
    }
    return undefined;
  };
  const visible = (scope: number, index: number) => {
    for (let current = at[index] ?? 0, count = 0; current >= 0 && count < 64; current = scopes[current].parent, count++) {
      if (current === scope) return true;
    }
    return false;
  };
  const bindings = scopes.map(() => new Map<string, SecretBinding>());
  const binding = (name: string, index: number): SecretBinding | undefined => {
    for (let scope = at[index] ?? 0, count = 0; scope >= 0 && count < 64; scope = scopes[scope].parent, count++) {
      const found = bindings[scope].get(name);
      if (found) return found;
    }
    return undefined;
  };
  for (const fn of functions) {
    fn.parameters.forEach((name, position) => {
      if (name) bindings[fn.scope].set(name, { scope: fn.scope, parameter: { functionId: fn.id, position }, values: [] });
    });
    for (const name of fn.blockedParameters) bindings[fn.scope].set(name, { scope: fn.scope, values: [] });
  }
  for (let index = 0; index < tokens.length; index++) {
    if (!['const', 'let', 'var', 'class', 'function', 'import'].includes(tokens[index].value)) continue;
    const next = tokens[index + 1];
    if (!next) continue;
    let scope = at[index];
    if (tokens[index].value === 'var') while (scopes[scope].owner === undefined && scopes[scope].parent >= 0) scope = scopes[scope].parent;
    if (!['const', 'let', 'var'].includes(tokens[index].value)) {
      if (next.kind === 'identifier') bindings[scope].set(next.value, { scope, values: [] });
      continue;
    }
    for (let cursor = index + 1, count = 0; count < 32; count++) {
      const end = expressionEnd(tokens, cursor, pairs, content);
      for (const name of bindingNames(tokens, pairs, cursor, end ?? (pairs.get(cursor) ?? cursor) + 1)) {
        if (!bindings[scope].has(name)) bindings[scope].set(name, { scope, values: [] });
      }
      if (end === undefined || tokens[end]?.value !== ',') break;
      cursor = end + 1;
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier' || ['.', '?'].includes(tokens[index - 1]?.value)) continue;
    const direct = tokens[index + 1]?.value === '=' && !['=', '>'].includes(tokens[index + 2]?.value);
    const operator = tokens.slice(index + 1, index + 5).map(part => part.value).join('');
    const compound = /^(?:\+\+|--|(?:\+|-|\*\*?|\/|%|&{1,2}|\|{1,2}|\?\?|\^|<{2}|>{2,3})=)/.test(operator);
    if (!direct && !compound) continue;
    const start = index + 2;
    const end = direct ? expressionEnd(tokens, start, pairs, content) : undefined;
    const target = binding(token.value, index);
    // An unsupported/oversized write kills old evidence rather than retaining a
    // stale secret tag. Compound assignments are deliberately unknown as well.
    if (target) target.values.push({ start, end: end ?? start, at: index, scope: at[index] });
  }
  const mutated = propertyMutationCheck(tokens, pairs, binding, visible, index => at[index]);
  const namedFunctions = new Map<string, SecretFunction[]>();
  for (const fn of functions) {
    if (!fn.key) continue;
    const named = namedFunctions.get(fn.key) ?? [];
    named.push(fn); namedFunctions.set(fn.key, named);
  }
  const functionForCall = (key: string, index: number): SecretFunction | undefined => {
    const candidates = (namedFunctions.get(key) ?? []).filter(fn => visible(fn.parentScope, index));
    if (candidates.length !== 1) return undefined;
    const fn = candidates[0];
    // A local variable or parameter with the same callee name blocks the summary.
    const root = key.split('.')[0];
    if (mutated(root, index, key.split('.')[1])) return undefined;
    const declared = binding(root, index);
    if (declared?.parameter || (declared && declared.scope !== fn.parentScope) || declared?.values.some(value => value.at < index && visible(value.scope, index))) return undefined;
    return fn;
  };
  return { content, tokens, pairs, functions, owner, binding, visible, mutated, functionForCall };
}
