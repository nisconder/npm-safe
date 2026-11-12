import { topLevelRanges } from './source-binding-patterns.js';
import { globalReferenceCheck } from './source-bindings.js';
import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { secretSyntax } from './secret-flow-syntax.js';
import { literalDestination, networkPayload, PRIVATE_MATERIAL, secretValue } from './secret-flow-value.js';

export interface SecretExfiltrationSignal {
  readonly start: number;
  readonly end: number;
  readonly sinkStart: number;
  readonly sinkEnd: number;
  readonly kind: 'private-material-network';
}

export function hasSecretFlowCandidate(content: string): boolean {
  // Folded property strings and string escapes are resolved by tokenization;
  // keep this cheap gate broader than the semantic detector.
  return /(?:fetch|\\[xu])/.test(content) && /(?:key|seed|mnemonic|\\[xu]|\+)/i.test(content);
}

/**
 * Bounded symbolic flow from private-key material into fetch body/headers sent to
 * a literal HTTP(S) endpoint. Summarizes same-file named functions/static methods
 * for three hops; no evaluation, imports, arbitrary transforms or cross-file flow.
 */
export function findSecretExfiltration(content: string, suppliedTokens?: readonly SourceToken[]): SecretExfiltrationSignal | undefined {
  const tokens = suppliedTokens ?? tokenizeSource(content);
  const syntax = secretSyntax(content, tokens);
  const global = globalReferenceCheck(tokens, syntax.pairs);
  const summaries = new Map<number, { mask: number; start: number; end: number }>();
  const calls: Array<{ index: number; close: number; key: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier' || tokens[index + 1]?.value !== '(') continue;
    const close = syntax.pairs.get(index + 1);
    if (close === undefined || close - index > 512) continue;
    const args = topLevelRanges(tokens, syntax.pairs, index + 2, close);
    const owner = syntax.owner(index);
    const receiver = tokens[index - 2];
    const qualified = tokens[index - 1]?.value === '.';
    const isFetch = token.value === 'fetch' && (qualified
      ? receiver?.kind === 'identifier' && ['window', 'globalThis'].includes(receiver.value) && global(index - 2, receiver.value)
      : global(index, 'fetch'));
    if (isFetch && args.length >= 2 && literalDestination(syntax, args[0].start, args[0].end)) {
      const value = networkPayload(syntax, args[1].start, args[1].end, owner);
      if (value & PRIVATE_MATERIAL) return { start: token.start, end: tokens[close].end, sinkStart: token.start, sinkEnd: tokens[close].end, kind: 'private-material-network' };
      if (value && owner !== undefined) {
        const previous = summaries.get(owner);
        summaries.set(owner, { mask: value | (previous?.mask ?? 0), start: token.start, end: tokens[close].end });
      }
    }
    if (tokens[close + 1]?.value === '{' || ['function', 'class', '?'].includes(tokens[index - 1]?.value)) continue;
    if (qualified && (receiver?.kind !== 'identifier' || ['.', '?'].includes(tokens[index - 3]?.value))) continue;
    calls.push({ index, close, key: qualified ? `${receiver.value}.${token.value}` : token.value });
  }
  for (let hop = 0; hop < 3; hop++) {
    let changed = false;
    const previousHop = new Map(summaries);
    for (const call of calls) {
      const fn = syntax.functionForCall(call.key, call.index);
      if (!fn || fn.nameIndex === call.index) continue;
      const summary = previousHop.get(fn.id);
      if (!summary) continue;
      const args = topLevelRanges(tokens, syntax.pairs, call.index + 2, call.close);
      const owner = syntax.owner(call.index);
      let value = 0;
      for (let position = 0; position < Math.min(args.length, 16); position++) {
        if (summary.mask & (1 << position)) value |= secretValue(syntax, args[position].start, args[position].end, owner);
      }
      if (value & PRIVATE_MATERIAL) return {
        start: tokens[call.index].start, end: tokens[call.close].end,
        sinkStart: summary.start, sinkEnd: summary.end, kind: 'private-material-network',
      };
      if (value && owner !== undefined) {
        const previous = summaries.get(owner);
        if ((value | (previous?.mask ?? 0)) !== previous?.mask) {
          summaries.set(owner, { mask: value | (previous?.mask ?? 0), start: summary.start, end: summary.end });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return undefined;
}
