/** Connected remote response -> process command shapes, not same-file capability overlap. */
import { bindingNames, topLevelRanges, type BindingRange } from './source-binding-patterns.js';
import { globalReferenceCheck } from './source-bindings.js';
import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { delimiterPairs, expressionEnd, flowValue, type FlowContext, type FlowTag } from './network-flow-expression.js';

export interface NetworkExecutionSignal {
  readonly start: number;
  readonly end: number;
  readonly kind: 'remote-response-command';
}
const PROCESS_METHODS = new Set(['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync']);

export interface ProcessCommandCall {
  readonly start: number;
  readonly end: number;
  readonly method: string;
  readonly args: readonly BindingRange[];
  readonly value: (range: BindingRange) => FlowTag | undefined;
  readonly constant: (range: BindingRange) => string | undefined;
}

function parameters(tokens: readonly SourceToken[], brace: number, pairs: ReadonlyMap<number, number>, reverse: ReadonlyMap<number, number>): string[] {
  let end = brace - 1;
  if (tokens[end]?.value === '>' && tokens[end - 1]?.value === '=') {
    end -= 2;
    if (tokens[end]?.kind === 'identifier') return [tokens[end].value];
  }
  if (tokens[end]?.value !== ')') return [];
  const open = reverse.get(end);
  if (open === undefined || end - open > 256) return [];
  const previous = tokens[open - 1];
  if (previous?.kind === 'identifier' && ['if', 'while', 'for', 'switch', 'with'].includes(previous.value)) return [];
  return topLevelRanges(tokens, pairs, open + 1, end).flatMap(range => bindingNames(tokens, pairs, range.start, range.end));
}

function imports(tokens: readonly SourceToken[], start: number, scope: Map<string, FlowTag>): void {
  let end = start + 1;
  for (; end < tokens.length && end < start + 64; end++) if (tokens[end].kind === 'string' || tokens[end].value === ';') break;
  if (tokens[end]?.kind !== 'string' || !/^(?:node:)?child_process$/.test(tokens[end].value)) return;
  if (tokens[start + 1]?.kind === 'identifier') scope.set(tokens[start + 1].value, 'module');
  for (let index = start + 1; index < end; index++) {
    if (tokens[index].value === 'as' && tokens[index - 1]?.value === '*' && tokens[index + 1]?.kind === 'identifier') scope.set(tokens[index + 1].value, 'module');
    if (tokens[index].kind !== 'identifier' || !PROCESS_METHODS.has(tokens[index].value)) continue;
    const local = tokens[index + 1]?.value === 'as' ? tokens[index + 2] : tokens[index];
    if (local?.kind === 'identifier') scope.set(local.value, tokens[index].value as FlowTag);
  }
}

/** Inspect bounded, locally bound child-process calls without treating source text as a command. */
export function findProcessCommand<T>(
  content: string,
  tokens: readonly SourceToken[],
  inspect: (call: ProcessCommandCall) => T | undefined,
): T | undefined {
  if (!tokens.some(token => token.kind === 'string' && /^(?:node:)?child_process$/.test(token.value))) return;
  if (!tokens.some(token => ['identifier', 'string'].includes(token.kind) && PROCESS_METHODS.has(token.value))) return;
  const pairs = delimiterPairs(tokens);
  const reverse = new Map([...pairs].map(([open, close]) => [close, open]));
  const global = globalReferenceCheck(tokens, pairs);
  const scopes: Map<string, FlowTag>[] = [new Map()];
  const constants: Map<string, string | undefined>[] = [new Map()];
  const functionScopes = [true];
  const expressionScopeEnds: (number | undefined)[] = [undefined];
  const functionBody = (index: number) => {
    const open = tokens[index - 1]?.value === ')' ? reverse.get(index - 1) : undefined;
    return (tokens[index - 1]?.value === '>' && tokens[index - 2]?.value === '=') ||
      (open !== undefined && !['if', 'while', 'for', 'switch', 'with', 'catch'].includes(tokens[open - 1]?.value));
  };
  const localVars = (start: number, end: number) => {
    const names = new Set<string>();
    for (let index = start; index < end; index++) {
      if (tokens[index].value === '{' && functionBody(index)) { index = pairs.get(index) ?? end; continue; }
      if (tokens[index].kind !== 'identifier' || tokens[index].value !== 'var') continue;
      const last = expressionEnd(tokens, index + 1, pairs, content) ?? index + 2;
      for (const name of bindingNames(tokens, pairs, index + 1, last)) names.add(name);
    }
    return [...names];
  };
  for (const name of localVars(0, tokens.length)) {
    scopes[0].set(name, 'blocked');
    constants[0].set(name, undefined);
  }
  const arrows = new Map<string, { start: number; end: number }[]>();
  const expressionFunctions = new Map<number, { end: number; names: string[] }>();
  for (let index = 1; index + 2 < tokens.length; index++) {
    if (tokens[index].value !== '=' || tokens[index + 1].value !== '>' || tokens[index + 2].value === '{') continue;
    const parameter = tokens[index - 1];
    const open = parameter.value === ')' ? reverse.get(index - 1) : undefined;
    const names = open !== undefined
      ? topLevelRanges(tokens, pairs, open + 1, index - 1).flatMap(range => bindingNames(tokens, pairs, range.start, range.end))
      : parameter.kind === 'identifier' ? [parameter.value] : [];
    const start = index + 2, end = expressionEnd(tokens, start, pairs, content) ?? tokens.length;
    expressionFunctions.set(start, { end, names });
    for (const name of names) {
      const intervals = arrows.get(name) ?? [];
      const previous = intervals.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else intervals.push({ start, end });
      arrows.set(name, intervals);
    }
  }
  let position = 0;
  const arrowParameter = (name: string) => {
    const intervals = arrows.get(name);
    if (!intervals) return false;
    let low = 0, high = intervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (intervals[middle].start <= position) low = middle + 1;
      else high = middle;
    }
    return low > 0 && position < intervals[low - 1].end;
  };
  const binding = (name: string): FlowTag | undefined => {
    if (arrowParameter(name)) return 'blocked';
    for (let index = scopes.length - 1, count = 0; index >= 0 && count < 32; index--, count++) {
      if (scopes[index].has(name)) return scopes[index].get(name);
    }
    return undefined;
  };
  const context: FlowContext = { pairs, binding, global };
  const value = (start: number, end: number) => flowValue(tokens, start, end, context);
  const assignmentScope = (name: string) => {
    for (let scope = scopes.length - 1; scope >= 0; scope--) {
      if (scopes[scope].has(name)) return scope;
      // Traversing a function definition does not execute its outer writes.
      if (functionScopes[scope]) break;
    }
    return scopes.length - 1;
  };
  const constant = (range: BindingRange, depth = 0): string | undefined => {
    let { start, end } = range;
    if (depth > 8 || end <= start || end - start > 256 || tokens[end - 1].end - tokens[start].start > 4096) return;
    while (tokens[start]?.value === '(' && pairs.get(start) === end - 1) { start++; end--; }
    if (end === start + 1) {
      if (tokens[start].kind === 'string') return tokens[start].value;
      if (tokens[start].kind !== 'identifier') return;
      if (arrowParameter(tokens[start].value)) return;
      for (let scope = constants.length - 1, count = 0; scope >= 0 && count < 32; scope--, count++) {
        if (constants[scope].has(tokens[start].value)) return constants[scope].get(tokens[start].value);
      }
      return;
    }
    for (let index = start; index < end; index++) {
      const close = pairs.get(index);
      if (close !== undefined && close < end) { index = close; continue; }
      if (tokens[index].kind !== 'punctuation' || tokens[index].value !== '+') continue;
      const left = constant({ start, end: index }, depth + 1);
      const right = constant({ start: index + 1, end }, depth + 1);
      return left !== undefined && right !== undefined && left.length + right.length <= 4096 ? left + right : undefined;
    }
    return;
  };
  for (let index = 0; index < tokens.length; index++) {
    position = index;
    while (expressionScopeEnds.at(-1) !== undefined && index >= expressionScopeEnds.at(-1)!) {
      scopes.pop(); constants.pop(); functionScopes.pop(); expressionScopeEnds.pop();
    }
    const expressionFunction = expressionFunctions.get(index);
    if (expressionFunction) {
      scopes.push(new Map(expressionFunction.names.map(name => [name, 'blocked' as const])));
      constants.push(new Map(expressionFunction.names.map(name => [name, undefined])));
      functionScopes.push(true);
      expressionScopeEnds.push(expressionFunction.end);
    }
    const token = tokens[index];
    const scope = scopes.at(-1)!;
    if (token.kind === 'punctuation' && token.value === '{') {
      const isFunction = functionBody(index);
      const names = [...parameters(tokens, index, pairs, reverse),
        ...(isFunction ? localVars(index + 1, pairs.get(index) ?? tokens.length) : [])];
      scopes.push(new Map(names.map(name => [name, 'blocked' as const])));
      constants.push(new Map(names.map(name => [name, undefined])));
      functionScopes.push(isFunction);
      expressionScopeEnds.push(undefined);
      continue;
    }
    if (token.kind === 'punctuation' && token.value === '}') {
      if (scopes.length > 1) { scopes.pop(); constants.pop(); functionScopes.pop(); expressionScopeEnds.pop(); }
      continue;
    }
    const computed = token.kind === 'string' && tokens[index - 1]?.value === '[' && tokens[index + 1]?.value === ']';
    if (token.kind !== 'identifier' && !computed) continue;
    if (token.value === 'import') { imports(tokens, index, scope); continue; }
    if (token.value === 'function' && tokens[index + 1]?.kind === 'identifier') {
      scope.set(tokens[index + 1].value, 'blocked');
      constants.at(-1)!.set(tokens[index + 1].value, undefined);
    }
    if (['const', 'let', 'var'].includes(token.value)) {
      const pattern = index + 1;
      let declaration = scopes.length - 1;
      if (token.value === 'var') while (declaration > 0 && !functionScopes[declaration]) declaration--;
      if (tokens[pattern]?.value === '{') {
        const close = pairs.get(pattern);
        if (close !== undefined) for (const name of bindingNames(tokens, pairs, pattern, close + 1)) {
          scopes[declaration].set(name, 'blocked');
          constants[declaration].set(name, undefined);
        }
        if (close !== undefined && tokens[close + 1]?.value === '=') {
          const end = expressionEnd(tokens, close + 2, pairs, content);
          if (end !== undefined && value(close + 2, end) === 'module') {
            for (const range of topLevelRanges(tokens, pairs, pattern + 1, close)) {
              const method = tokens[range.start];
              const local = tokens[range.start + 1]?.value === ':' ? tokens[range.start + 2] : method;
              if (method?.kind === 'identifier' && PROCESS_METHODS.has(method.value) && local?.kind === 'identifier') scopes[declaration].set(local.value, method.value as FlowTag);
            }
          }
        }
      } else if (tokens[pattern]?.kind === 'identifier') {
        scopes[declaration].set(tokens[pattern].value, 'blocked');
        constants[declaration].set(tokens[pattern].value, undefined);
      }
    }
    if (token.kind === 'identifier' && binding(token.value) === 'module') {
      const property = index + 1;
      const assignment = tokens[property]?.value === '.' ? property + 2
        : tokens[property]?.value === '[' ? (pairs.get(property) ?? property) + 1 : -1;
      if (assignment >= 0 && tokens[assignment]?.value === '=' && !['=', '>'].includes(tokens[assignment + 1]?.value)) {
        const target = assignmentScope(token.value);
        scopes[target].set(token.value, 'blocked');
        constants[target].set(token.value, undefined);
        continue;
      }
    }
    if (tokens[index + 1]?.value === '=' && !['=', '>'].includes(tokens[index + 2]?.value)) {
      const receiver = tokens[index - 2];
      if (tokens[index - 1]?.value === '.') {
        if (receiver?.kind === 'identifier' && binding(receiver.value) === 'module') {
          scopes[assignmentScope(receiver.value)].set(receiver.value, 'blocked');
        }
        // An object property is not a write to a same-named lexical binding.
        continue;
      }
      if (tokens[index - 1]?.value === '#' && tokens[index - 2]?.value === '.') continue;
      const end = expressionEnd(tokens, index + 2, pairs, content);
      const target = assignmentScope(token.value);
      const literal = end === undefined ? undefined : constant({ start: index + 2, end });
      scopes[target].set(token.value, end === undefined ? 'blocked' : value(index + 2, end) ?? 'blocked');
      constants[target].set(token.value, literal);
    }
    const open = index + (computed ? 2 : 1);
    if (tokens[open]?.value !== '(') continue;
    let method = binding(token.value);
    let start = index;
    if (computed || ['.', '?'].includes(tokens[index - 1]?.value)) {
      if ((!computed && tokens[index - 1]?.value !== '.') || !PROCESS_METHODS.has(token.value)) continue;
      let receiver = index - 2;
      if (tokens[receiver]?.value === ')') receiver = (reverse.get(receiver) ?? receiver) - 1;
      if (['.', '?'].includes(tokens[receiver - 1]?.value)) continue;
      if (value(receiver, index - 1) === 'module') { method = token.value as FlowTag; start = receiver; }
      else continue;
    }
    if (!method || !PROCESS_METHODS.has(method)) continue;
    const close = pairs.get(open);
    if (close === undefined || close - index > 256) continue;
    const args = topLevelRanges(tokens, pairs, open + 1, close);
    if (!args.length) continue;
    const result = inspect({ method, args, start: tokens[start].start, end: tokens[close].end,
      value: range => value(range.start, range.end), constant });
    if (result !== undefined) return result;
  }
}

/**
 * Deliberately narrow local flow: fetch response.text() into a bound child-process
 * shell command or shell -c argv. It does not prove runtime execution, handle
 * callbacks/custom download APIs, or follow downloads written to disk and run.
 */
export function findNetworkExecution(content: string, suppliedTokens?: readonly SourceToken[]): NetworkExecutionSignal | undefined {
  const tokens = suppliedTokens ?? tokenizeSource(content);
  const pairs = delimiterPairs(tokens);
  return findProcessCommand(content, tokens, ({ method, args, value, start, end }) => {
    let connected = ['exec', 'execSync'].includes(method) && value(args[0]) === 'body';
    if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method) && args.length >= 2) {
      const command = tokens[args[0].start];
      const array = args[1].start;
      if (args[0].end === args[0].start + 1 && command.kind === 'string' && /(?:^|[\\/])(?:sh|bash|zsh|dash)$/.test(command.value)
        && tokens[array]?.value === '[' && pairs.get(array) === args[1].end - 1) {
        const argv = topLevelRanges(tokens, pairs, array + 1, args[1].end - 1);
        connected = argv.length >= 2 && tokens[argv[0].start]?.kind === 'string' && tokens[argv[0].start].value === '-c'
          && value(argv[1]) === 'body';
      }
    }
    if (connected) return { start, end, kind: 'remote-response-command' as const };
    return;
  });
}
