import type { SourceToken } from './source-tokens.js';
import { delimiterPairs } from './network-flow-expression.js';
import { topLevelRanges } from './source-binding-patterns.js';

const ENCODED_TEXT = /[A-Za-z0-9+/]{160,}={0,2}|(?:\\x[0-9a-fA-F]{2}){12,}|(?:\\u[0-9a-fA-F]{4}){8,}/;

function singleQuotedLiteral(raw: string): boolean {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return false;
  for (let index = 1; index < raw.length; index++) {
    if (raw[index] === '\\') index++;
    else if (raw[index] === quote) return index === raw.length - 1;
  }
  return false;
}

/** Cheap necessary-condition gate; only argument-local evidence can emit a finding. */
export function hasDynamicExecutionCandidate(content: string): boolean {
  return (content.includes('eval') || content.includes('Function')) &&
    (ENCODED_TEXT.test(content) || ['atob', 'fromCharCode', 'Buffer', '+', '\\'].some(part => content.includes(part)));
}

function encodedArgument(
  content: string,
  tokens: readonly SourceToken[],
  pairs: ReadonlyMap<number, number>,
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (token.kind === 'string' || token.kind === 'opaque') {
      // Folded literals may span comments. Inspect raw escapes only in a single
      // quoted literal; never count a comment, regex or template as payload data.
      const raw = content.slice(token.start, token.end);
      if ((token.kind === 'string' && /[A-Za-z0-9+/]{160,}={0,2}/.test(token.value)) ||
        (singleQuotedLiteral(raw) && ENCODED_TEXT.test(raw))) return true;
    }
    if (token.kind !== 'identifier' || ['.', '?'].includes(tokens[index - 1]?.value)) continue;
    if (token.value === 'atob' && tokens[index + 1]?.value === '(') return true;
    if (tokens[index + 1]?.value !== '.' || tokens[index + 3]?.value !== '(') continue;
    if (token.value === 'String' && tokens[index + 2]?.value === 'fromCharCode') return true;
    if (token.value !== 'Buffer' || tokens[index + 2]?.value !== 'from') continue;
    const close = pairs.get(index + 3);
    if (close === undefined || close >= end) continue;
    const args = topLevelRanges(tokens, pairs, index + 4, close);
    const encoding = args[1];
    if (encoding && encoding.end === encoding.start + 1 && tokens[encoding.start].kind === 'string' &&
      /^(?:base64|base64url|hex)$/i.test(tokens[encoding.start].value)) return true;
  }
  return false;
}

/**
 * Recognize encoded literals/decoder calls in eval's first or Function's last
 * argument. This bounded lexical heuristic does not follow variable bindings,
 * arbitrary transforms or runtime control flow, and does not prove execution.
 */
export function findDynamicExecution(
  content: string,
  tokens: readonly SourceToken[],
): { line: number; snippet: string } | null {
  const pairs = delimiterPairs(tokens);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier' || !['eval', 'Function'].includes(token.value)) continue;
    if (tokens[index + 1]?.value !== '(' || ['function', 'class', '.', '?'].includes(tokens[index - 1]?.value)) continue;
    const close = pairs.get(index + 1);
    if (close === undefined || close - index > 256) continue;
    // A newline may terminate a call before an independent statement block.
    if (tokens[close + 1]?.value === '{' &&
      !/[\r\n\u2028\u2029]/.test(content.slice(tokens[close].end, tokens[close + 1].start))) continue;
    const args = topLevelRanges(tokens, pairs, index + 2, close).filter(arg => arg.end > arg.start);
    const body = token.value === 'eval' ? args[0] : args.at(-1);
    if (!body || !encodedArgument(content, tokens, pairs, body.start, body.end)) continue;
    const lineStart = content.lastIndexOf('\n', token.start - 1) + 1;
    const lineEnd = content.indexOf('\n', token.end);
    return {
      line: content.slice(0, token.start).split(/\r?\n/).length,
      snippet: content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim().slice(0, 240),
    };
  }
  return null;
}
