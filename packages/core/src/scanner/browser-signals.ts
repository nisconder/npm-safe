/** Bounded lexical evidence of browser response interception and payment matching. */
import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { globalReferenceCheck } from './source-bindings.js';
import { FindingCategory, Severity, type ScanFinding } from './types.js';

interface TokenRange { readonly start: number; readonly end: number }
type Delimiters = ReadonlyMap<number, number>;

function pairDelimiters(tokens: readonly SourceToken[]): Delimiters {
  const pairs = new Map<number, number>();
  const stack: { index: number; value: string }[] = [];
  const opening: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'punctuation') continue;
    if (['(', '[', '{'].includes(token.value)) stack.push({ index, value: token.value });
    else if (opening[token.value]) {
      const start = stack.pop();
      if (start?.value === opening[token.value]) pairs.set(start.index, index);
      else stack.length = 0;
    }
  }
  return pairs;
}

function memberEnd(tokens: readonly SourceToken[], start: number, pairs: Delimiters): { end: number; count: number } {
  let end = start + 1;
  let count = 0;
  while (count < 8) {
    if (tokens[end]?.value === '.' && tokens[end + 1]?.kind === 'identifier') {
      end += 2;
    } else if (tokens[end]?.value === '[') {
      const close = pairs.get(end);
      if (close === undefined) break;
      end = close + 1;
    } else break;
    count++;
  }
  return { end, count };
}

function assignedBody(tokens: readonly SourceToken[], equal: number, pairs: Delimiters): TokenRange | null {
  if (tokens[equal]?.value !== '=') return null;
  let index = equal + 1;
  if (tokens[index]?.value === 'async') index++;
  const isFunction = tokens[index]?.kind === 'identifier' && tokens[index]?.value === 'function';
  if (isFunction) {
    index++;
    if (tokens[index]?.kind === 'identifier') index++;
  }
  if (tokens[index]?.value === '(') {
    const close = pairs.get(index);
    if (close === undefined) return null;
    index = close + 1;
  } else if (!isFunction && tokens[index]?.kind === 'identifier') index++;
  else return null;
  if (!isFunction) {
    if (tokens[index]?.value !== '=' || tokens[index + 1]?.value !== '>') return null;
    index += 2;
  }
  if (tokens[index]?.value !== '{') return null;
  const end = pairs.get(index);
  return end === undefined ? null : { start: index, end };
}

function prefixCounts(tokens: readonly SourceToken[], matches: (token: SourceToken, index: number) => boolean): Uint32Array {
  const counts = new Uint32Array(tokens.length + 1);
  for (let index = 0; index < tokens.length; index++) {
    counts[index + 1] = counts[index] + Number(matches(tokens[index], index));
  }
  return counts;
}

function responseCounts(tokens: readonly SourceToken[], isGlobal: (index: number, name: string) => boolean): Uint32Array {
  return prefixCounts(tokens, (token, index) => {
    if (token.kind !== 'identifier' || token.value !== 'new') return false;
    let next = index + 1;
    const qualified = ['window', 'globalThis'].includes(tokens[next]?.value) && tokens[next + 1]?.value === '.';
    if (qualified) {
      if (!isGlobal(next, tokens[next].value)) return false;
      next += 2;
    }
    return tokens[next]?.kind === 'identifier' && tokens[next]?.value === 'Response' && tokens[next + 1]?.value === '('
      && (qualified || isGlobal(next, 'Response'));
  });
}

function addressFamilies(tokens: readonly SourceToken[]): number {
  let ethereum = false;
  let bitcoin = false;
  for (const token of tokens) {
    if (token.kind !== 'regexp') continue;
    // Match executable regular-expression literals, not address examples in text.
    ethereum ||= /0x\[(?=[^\]]*(?:a-f|A-F))(?=[^\]]*(?:0-9|\\d))[^\]]+\]\{40\}/.test(token.value);
    bitcoin ||= /bc1\[[^\]]+\]\{\d{2,}(?:,\d+)?\}/i.test(token.value)
      || /[13]\[[^\]]*(?:a-k|A-H)[^\]]+\]\{2[5-9],3[0-9]\}/.test(token.value);
  }
  return Number(ethereum) + Number(bitcoin);
}

/** A capability conjunction requiring review; this is not data-flow proof of theft. */
export function scanBrowserContent(content: string, filePath: string, tokens: readonly SourceToken[] = tokenizeSource(content)): ScanFinding[] {
  if (addressFamilies(tokens) < 2) return [];
  const pairs = pairDelimiters(tokens);
  const isGlobal = globalReferenceCheck(tokens, pairs);
  const responses = responseCounts(tokens, isGlobal);
  let fetchReplacement: SourceToken | undefined;
  let xhrReplacement = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier') continue;
    const qualified = ['window', 'globalThis'].includes(token.value) && tokens[index + 1]?.value === '.';
    if (qualified && !isGlobal(index, token.value)) continue;
    const target = qualified ? index + 2 : index;
    if (tokens[target]?.kind !== 'identifier') continue;
    if (!qualified && ['.', '?'].includes(tokens[index - 1]?.value)) continue;
    if (tokens[target].value === 'fetch' && (qualified || isGlobal(target, 'fetch'))) {
      const body = assignedBody(tokens, target + 1, pairs);
      if (body && responses[body.end] > responses[body.start]) fetchReplacement = token;
    }
    if (tokens[target].value === 'XMLHttpRequest' && (qualified || isGlobal(target, 'XMLHttpRequest'))) {
      const member = memberEnd(tokens, target, pairs);
      if (member.count >= 2 && assignedBody(tokens, member.end, pairs)) xhrReplacement = true;
    }
  }
  if (!fetchReplacement || !xhrReplacement) return [];
  const offset = fetchReplacement.start;
  return [{
    ruleId: 'content-browser-interception',
    ruleName: 'Browser response interception with payment-address matching',
    severity: Severity.Critical,
    category: FindingCategory.SuspiciousDep,
    message: `Source replaces fetch with a response-reconstructing function, replaces XMLHttpRequest methods, and matches multiple cryptocurrency address formats in ${filePath}.`,
    filePath,
    lineNumber: content.slice(0, offset).split(/\r?\n/).length,
    codeSnippet: content.slice(offset).split(/\r?\n/, 1)[0].slice(0, 240),
    recommendation: 'Review response rewriting and payment-address transformations before installation; this static conjunction does not establish data flow or confirmed theft.',
  }];
}
