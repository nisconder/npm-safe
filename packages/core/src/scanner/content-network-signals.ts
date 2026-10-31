/** Connected remote response -> process command shapes, not same-file capability overlap. */
import { bindingNames, topLevelRanges } from './source-binding-patterns.js';
import { globalReferenceCheck } from './source-bindings.js';
import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { delimiterPairs, expressionEnd, flowValue, type FlowContext, type FlowTag } from './network-flow-expression.js';

export interface NetworkExecutionSignal {
  readonly start: number;
  readonly end: number;
  readonly kind: 'remote-response-command';
}
const PROCESS_METHODS = new Set(['exec', 'execSync', 'spawn', 'spawnSync']);

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

/**
 * Deliberately narrow local flow: fetch response.text() into a bound child-process
 * shell command or shell -c argv. It does not prove runtime execution, handle
 * callbacks/custom download APIs, or follow downloads written to disk and run.
 */
export function findNetworkExecution(content: string, suppliedTokens?: readonly SourceToken[]): NetworkExecutionSignal | undefined {
  const tokens = suppliedTokens ?? tokenizeSource(content);
  if (!tokens.some(token => token.kind === 'string' && /^(?:node:)?child_process$/.test(token.value))) return;
  if (!tokens.some(token => token.kind === 'identifier' && PROCESS_METHODS.has(token.value))) return;
  const pairs = delimiterPairs(tokens);
  const reverse = new Map([...pairs].map(([open, close]) => [close, open]));
  const global = globalReferenceCheck(tokens, pairs);
  const scopes: Map<string, FlowTag>[] = [new Map()];
  const binding = (name: string): FlowTag | undefined => {
    for (let index = scopes.length - 1, count = 0; index >= 0 && count < 32; index--, count++) {
      if (scopes[index].has(name)) return scopes[index].get(name);
    }
    return undefined;
  };
  const context: FlowContext = { pairs, binding, global };
  const value = (start: number, end: number) => flowValue(tokens, start, end, context);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const scope = scopes.at(-1)!;
    if (token.kind === 'punctuation' && token.value === '{') {
      scopes.push(new Map(parameters(tokens, index, pairs, reverse).map(name => [name, 'blocked' as const])));
      continue;
    }
    if (token.kind === 'punctuation' && token.value === '}') { if (scopes.length > 1) scopes.pop(); continue; }
    if (token.kind !== 'identifier') continue;
    if (token.value === 'import') { imports(tokens, index, scope); continue; }
    if (token.value === 'function' && tokens[index + 1]?.kind === 'identifier') scope.set(tokens[index + 1].value, 'blocked');
    if (['const', 'let', 'var'].includes(token.value)) {
      const pattern = index + 1;
      if (tokens[pattern]?.value === '{') {
        const close = pairs.get(pattern);
        if (close !== undefined) for (const name of bindingNames(tokens, pairs, pattern, close + 1)) scope.set(name, 'blocked');
        if (close !== undefined && tokens[close + 1]?.value === '=') {
          const end = expressionEnd(tokens, close + 2, pairs, content);
          if (end !== undefined && value(close + 2, end) === 'module') {
            for (const range of topLevelRanges(tokens, pairs, pattern + 1, close)) {
              const method = tokens[range.start];
              const local = tokens[range.start + 1]?.value === ':' ? tokens[range.start + 2] : method;
              if (method?.kind === 'identifier' && PROCESS_METHODS.has(method.value) && local?.kind === 'identifier') scope.set(local.value, method.value as FlowTag);
            }
          }
        }
      } else if (tokens[pattern]?.kind === 'identifier') scope.set(tokens[pattern].value, 'blocked');
    }
    if (tokens[index + 1]?.value === '=' && !['=', '>'].includes(tokens[index + 2]?.value)) {
      const receiver = tokens[index - 2];
      if (tokens[index - 1]?.value === '.' && receiver?.kind === 'identifier' && binding(receiver.value) === 'module') {
        scope.set(receiver.value, 'blocked');
        continue;
      }
      const end = expressionEnd(tokens, index + 2, pairs, content);
      scope.set(token.value, end === undefined ? 'blocked' : value(index + 2, end) ?? 'blocked');
    }
    if (tokens[index + 1]?.value !== '(') continue;
    let method = binding(token.value);
    let start = index;
    if (['.', '?'].includes(tokens[index - 1]?.value)) {
      if (tokens[index - 1]?.value !== '.' || !PROCESS_METHODS.has(token.value)) continue;
      let receiver = index - 2;
      if (tokens[receiver]?.value === ')') receiver = (reverse.get(receiver) ?? receiver) - 1;
      if (['.', '?'].includes(tokens[receiver - 1]?.value)) continue;
      if (value(receiver, index - 1) === 'module') { method = token.value as FlowTag; start = receiver; }
      else continue;
    }
    if (!method || !PROCESS_METHODS.has(method)) continue;
    const close = pairs.get(index + 1);
    if (close === undefined || close - index > 256) continue;
    const args = topLevelRanges(tokens, pairs, index + 2, close);
    if (!args.length) continue;
    let connected = ['exec', 'execSync'].includes(method) && value(args[0].start, args[0].end) === 'body';
    if (['spawn', 'spawnSync'].includes(method) && args.length >= 2) {
      const command = tokens[args[0].start];
      const array = args[1].start;
      if (args[0].end === args[0].start + 1 && command.kind === 'string' && /(?:^|[\\/])(?:sh|bash|zsh|dash)$/.test(command.value)
        && tokens[array]?.value === '[' && pairs.get(array) === args[1].end - 1) {
        const argv = topLevelRanges(tokens, pairs, array + 1, args[1].end - 1);
        connected = argv.length >= 2 && tokens[argv[0].start]?.kind === 'string' && tokens[argv[0].start].value === '-c'
          && value(argv[1].start, argv[1].end) === 'body';
      }
    }
    if (connected) return { start: tokens[start].start, end: tokens[close].end, kind: 'remote-response-command' };
  }
}
