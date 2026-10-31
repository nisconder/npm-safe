import type { SourceToken } from './source-tokens.js';

/** Find a case-sensitive call in executable tokens, excluding quoted examples. */
export function findDynamicExecution(
  content: string,
  tokens: readonly SourceToken[],
): { line: number; snippet: string } | null {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier' || !['eval', 'Function'].includes(token.value)) continue;
    if (tokens[index + 1]?.value !== '(' || ['function', 'class'].includes(tokens[index - 1]?.value)) continue;
    const lineStart = content.lastIndexOf('\n', token.start - 1) + 1;
    const lineEnd = content.indexOf('\n', token.end);
    return {
      line: content.slice(0, token.start).split(/\r?\n/).length,
      snippet: content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim().slice(0, 240),
    };
  }
  return null;
}
