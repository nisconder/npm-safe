import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { FindingCategory, Severity, type ScanFinding } from './types.js';

const PROCESS_METHODS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const JAVASCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

function processModule(tokens: readonly SourceToken[], index: number): SourceToken | undefined {
  if (tokens[index]?.kind !== 'identifier' || tokens[index].value !== 'require' || tokens[index - 1]?.value === '.') return;
  if (tokens[index + 1]?.value !== '(' || tokens[index + 3]?.value !== ')') return;
  const module = tokens[index + 2];
  if (module?.kind === 'string' && /^(?:node:)?child_process$/.test(module.value)) return module;
}

function methodAt(tokens: readonly SourceToken[], index: number): { token: SourceToken; next: number } | undefined {
  if (tokens[index]?.value === '.' && tokens[index + 1]?.kind === 'identifier') {
    return { token: tokens[index + 1], next: index + 2 };
  }
  if (tokens[index]?.value === '[' && tokens[index + 1]?.kind === 'string' && tokens[index + 2]?.value === ']') {
    return { token: tokens[index + 1], next: index + 3 };
  }
}

function requireParameter(tokens: readonly SourceToken[], brace: number): boolean {
  let end = brace - 1;
  const arrow = tokens[end]?.value === '>' && tokens[end - 1]?.value === '=';
  if (arrow) end -= 2;
  if (arrow && tokens[end]?.kind === 'identifier') return tokens[end].value === 'require';
  if (tokens[end]?.value !== ')') return false;
  let depth = 1, open = end - 1;
  for (; open >= Math.max(0, end - 256); open--) {
    if (tokens[open].value === ')') depth++;
    if (tokens[open].value === '(' && --depth === 0) break;
  }
  if (open < 0 || depth !== 0) return false;
  if (!arrow && tokens[open - 1]?.value !== 'function' && tokens[open - 2]?.value !== 'function') return false;
  depth = 0;
  for (let index = open + 1; index < end; index++) {
    const token = tokens[index];
    if (depth === 0 && token.kind === 'identifier' && token.value === 'require' &&
      ['(', ','].includes(tokens[index - 1]?.value) && [')', ',', '='].includes(tokens[index + 1]?.value)) return true;
    if (['(', '[', '{'].includes(token.value)) depth++;
    else if ([')', ']', '}'].includes(token.value)) depth--;
  }
  return false;
}

/** First argv element only; path.join(...) is allowed without evaluating it. */
function dllEntrypoint(tokens: readonly SourceToken[], start: number): boolean {
  if (tokens[start]?.value !== '[') return false;
  const strings: string[] = [];
  const delimiters = ['['];
  for (let index = start + 1; index < tokens.length && index < start + 128; index++) {
    const token = tokens[index];
    if (token.start - tokens[start].start > 4096) return false;
    if (delimiters.length === 1 && [',', ']'].includes(token.value)) {
      return strings.some((value) => /\.dll(?:,[A-Za-z_?@#$][\w?@#$]*)?$/i.test(value)) &&
        strings.some((value) => /(?:\.dll|^),[A-Za-z_?@#$][\w?@#$]*/i.test(value));
    }
    if (token.kind === 'opaque' || token.kind === 'regexp') return false;
    if (token.kind === 'string') strings.push(token.value);
    if (['(', '[', '{'].includes(token.value)) delimiters.push(token.value);
    if ([')', ']', '}'].includes(token.value)) {
      const expected = { ')': '(', ']': '[', '}': '{' }[token.value];
      if (delimiters.pop() !== expected) return false;
    }
  }
  return false;
}

/**
 * Narrow signal: concealed process binding/method/command plus a constant native
 * loader call with a DLL entrypoint. No variable values or template expressions
 * are evaluated. Const module aliases are followed only within their own block.
 */
export function scanProcessContent(
  content: string,
  filePath: string,
  suppliedTokens?: readonly SourceToken[],
): ScanFinding[] {
  if (!JAVASCRIPT_FILE.test(filePath)) return [];
  const tokens = suppliedTokens ?? tokenizeSource(content);
  // Both decoded literals are required by every supported native-loader shape.
  if (!tokens.some(token => token.kind === 'string' && /^(?:node:)?child_process$/.test(token.value)) ||
    !tokens.some(token => token.kind === 'string' && /(?:^|[\\/])rundll32(?:\.exe)?$/i.test(token.value))) return [];
  const scopes: { aliases: Map<string, SourceToken>; requireShadowed: boolean }[] = [{ aliases: new Map(), requireShadowed: false }];
  for (let index = 0; index < tokens.length; index++) {
    const current = tokens[index];
    if (current.kind === 'punctuation' && current.value === '{') {
      scopes.push({ aliases: new Map(), requireShadowed: scopes.at(-1)!.requireShadowed || requireParameter(tokens, index) });
      continue;
    }
    if (current.kind === 'punctuation' && current.value === '}') { if (scopes.length > 1) scopes.pop(); continue; }
    const scope = scopes.at(-1)!;
    if (current.kind === 'identifier' && current.value === 'require' && (
      ['const', 'let', 'var', 'function', 'class'].includes(tokens[index - 1]?.value) || tokens[index + 1]?.value === '='
    )) scope.requireShadowed = true;
    const module = scope.requireShadowed ? undefined : processModule(tokens, index);
    if (module && tokens[index - 1]?.value === '=' && tokens[index - 2]?.kind === 'identifier' && tokens[index - 3]?.value === 'const') {
      const following = tokens[index + 4];
      const newline = /[\n\r\u2028\u2029]/.test(content.slice(tokens[index + 3].end, following?.start));
      if (!following || following.value === ';' || following.value === '}' || (newline && following.kind === 'identifier' && !['in', 'instanceof'].includes(following.value))) {
        scope.aliases.set(tokens[index - 2].value, module);
      }
    }
    const receiver = module ?? (current.kind === 'identifier' ? scope.aliases.get(current.value) : undefined);
    if (!receiver) continue;
    const property = methodAt(tokens, index + (module ? 4 : 1));
    if (!property || !PROCESS_METHODS.has(property.token.value) || tokens[property.next]?.value !== '(') continue;
    const command = tokens[property.next + 1];
    if (command?.kind !== 'string' || tokens[property.next + 2]?.value !== ',') continue;
    if (!/(?:^|[\\/])rundll32(?:\.exe)?$/i.test(command.value)) continue;
    if (!receiver.concealed && !property.token.concealed && !command.concealed) continue;
    if (!dllEntrypoint(tokens, property.next + 3)) continue;
    const lineNumber = content.slice(0, current.start).split(/\r?\n/).length;
    return [{
      ruleId: 'content-concealed-native-exec',
      ruleName: 'Concealed native-library execution',
      severity: Severity.High,
      category: FindingCategory.CodeObfuscation,
      message: `Published source conceals a child-process native-loader invocation with a DLL entrypoint in ${filePath}.`,
      recommendation: 'Review the reconstructed process call and native library before installation.',
      filePath, lineNumber,
      codeSnippet: content.slice(current.start, Math.min(tokens[property.next + 3].end, current.start + 240)),
    }];
  }
  return [];
}
