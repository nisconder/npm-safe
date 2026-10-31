/** A bounded lexical view, not a JavaScript parser or evaluator. */
export interface SourceToken {
  readonly kind: 'identifier' | 'string' | 'punctuation' | 'number' | 'regexp' | 'opaque';
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly concealed?: boolean;
}

const MAX_SOURCE_CHARS = 1024 * 1024;
const MAX_TOKENS = 200_000;
const MAX_LITERAL_CHARS = 4096;
const identifierStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
const identifierPart = (code: number) => identifierStart(code) || (code >= 48 && code <= 57);
const numberPart = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102) || [46, 79, 88, 95, 111, 120].includes(code);
const lineBreak = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

function quoted(text: string, start: number): SourceToken {
  const quote = text[start];
  const firstClose = text.indexOf(quote, start + 1);
  if (firstClose >= 0) {
    const raw = text.slice(start + 1, firstClose);
    if (!raw.includes('\\') && !/[\r\n]/.test(raw)) {
      const valid = raw.length <= MAX_LITERAL_CHARS;
      return { kind: valid ? 'string' : 'opaque', value: valid ? raw : '', start, end: firstClose + 1, concealed: false };
    }
  }
  let value = '', index = start + 1, escaped = false, valid = true;
  while (index < text.length) {
    const char = text[index++];
    if (char === quote) return { kind: valid ? 'string' : 'opaque', value: valid ? value : '', start, end: index, concealed: escaped };
    if (char === '\n' || char === '\r') break;
    if (!valid) {
      if (char === '\\') {
        const escape = text[index++];
        if (escape === 'x' || escape === 'u' || (escape !== undefined && !/[1-9]/.test(escape) && !(escape === '0' && /\d/.test(text[index] ?? ''))
          && !(escape in ESCAPES) && !['\\', '"', "'", '\n', '\r'].includes(escape))) escaped = true;
        if (escape === '\r' && text[index] === '\n') index++;
      }
      continue;
    }
    if (char !== '\\') {
      if (value.length < MAX_LITERAL_CHARS) value += char;
      else valid = false;
      continue;
    }
    const escape = text[index++];
    if (escape === '\n') continue;
    if (escape === '\r') { if (text[index] === '\n') index++; continue; }
    if (escape === 'x' || escape === 'u') {
      escaped = true;
      const braced = escape === 'u' && text[index] === '{';
      const width = escape === 'x' ? 2 : 4;
      const close = braced ? text.indexOf('}', index + 1) : -1;
      const digits = braced ? text.slice(index + 1, close) : text.slice(index, index + width);
      const code = /^[0-9a-f]+$/i.test(digits) ? Number.parseInt(digits, 16) : -1;
      if ((braced ? close < 0 || digits.length > 6 : digits.length !== width) || code < 0 || code > 0x10ffff) {
        valid = false;
      } else {
        const decoded = String.fromCodePoint(code);
        if (value.length + decoded.length <= MAX_LITERAL_CHARS) value += decoded;
        else valid = false;
        index = braced ? close + 1 : index + width;
      }
    } else if (escape === undefined || /[1-9]/.test(escape) || (escape === '0' && /\d/.test(text[index] ?? ''))) {
      valid = false;
    } else {
      if (!(escape in ESCAPES) && !['\\', '"', "'"].includes(escape)) escaped = true;
      const decoded = ESCAPES[escape] ?? escape;
      if (value.length + decoded.length <= MAX_LITERAL_CHARS) value += decoded;
      else valid = false;
    }
    if (value.length > MAX_LITERAL_CHARS) valid = false;
  }
  return { kind: 'opaque', value: '', start, end: index };
}

function regexEnd(text: string, start: number): { end: number; closed: boolean } {
  let inClass = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (lineBreak(text.charCodeAt(index))) return { end: index, closed: false };
    if (char === '\\') { index++; continue; }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index++;
      while ((text.charCodeAt(index) >= 65 && text.charCodeAt(index) <= 90) || (text.charCodeAt(index) >= 97 && text.charCodeAt(index) <= 122)) index++;
      return { end: index, closed: true };
    }
  }
  return { end: text.length, closed: false };
}

function commentEnd(text: string, start: number): number {
  if (text[start + 1] === '/' || text[start] === '#') {
    let end = start + 2;
    while (end < text.length && !lineBreak(text.charCodeAt(end))) end++;
    return end;
  }
  const close = text.indexOf('*/', start + 2);
  return close < 0 ? text.length : close + 2;
}

/** Skip interpolations too: none of a template is treated as a constant string. */
function templateEnd(text: string, start: number, depth = 0): number {
  if (depth >= 16) return text.length;
  let index = start + 1, braces = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (!braces) {
      if (char === '`') return index + 1;
      if (char === '$' && text[index + 1] === '{') { braces = 1; index += 2; continue; }
    } else {
      if (char === '"' || char === "'") { index = quoted(text, index).end; continue; }
      if (char === '`') { index = templateEnd(text, index, depth + 1); continue; }
      if (char === '/' && ['/','*'].includes(text[index + 1])) { index = commentEnd(text, index); continue; }
      if (char === '/') { index = regexEnd(text, index).end; continue; }
      if (char === '{') braces++;
      else if (char === '}') braces--;
    }
    index++;
  }
  return text.length;
}

function canStartRegex(previous?: SourceToken, afterControlHead = false): boolean {
  if (!previous) return true;
  return afterControlHead || (previous.kind === 'punctuation' && '=(:,[!&|?{;~^+*-<>%}'.includes(previous.value)) ||
    (previous.kind === 'identifier' && ['return', 'throw', 'case', 'yield', 'await', 'void', 'typeof', 'delete', 'else', 'do', 'instanceof', 'in', 'of'].includes(previous.value));
}

export interface SourceTokenization {
  readonly tokens: readonly SourceToken[];
  /** Source/token budget exhaustion, distinct from deliberately opaque syntax. */
  readonly truncated: boolean;
}

/** Decode only quoted literals and their adjacent + chains; never evaluate code. */
export function tokenizeSourceDetailed(content: string): SourceTokenization {
  const text = content.slice(0, MAX_SOURCE_CHARS);
  const tokens: SourceToken[] = [];
  const controlHeads: boolean[] = [];
  let afterControlHead = false;
  let index = 0, rawTokenCount = 0;
  while (index < text.length && rawTokenCount < MAX_TOKENS) {
    const start = index, char = text[index], code = text.charCodeAt(index);
    if (code === 32 || (code >= 9 && code <= 13) || (code >= 128 && /\s/.test(char))) { index++; continue; }
    if (index === 0 && char === '#' && text[index + 1] === '!') {
      index = commentEnd(text, index);
      continue;
    }
    if (char === '/' && ['/', '*'].includes(text[index + 1])) {
      index = commentEnd(text, index);
      continue;
    }
    const regexPosition = char === '/' && canStartRegex(tokens.at(-1), afterControlHead);
    afterControlHead = false;
    let token: SourceToken;
    if (char === '"' || char === "'") {
      token = quoted(text, start);
      index = token.end;
    } else if (char === '`') {
      index = templateEnd(text, start);
      token = { kind: 'opaque', value: '', start, end: index };
    } else if (char === '/' && regexPosition) {
      const regex = regexEnd(text, start);
      index = regex.end;
      const raw = text.slice(start, index);
      const recognized = regex.closed && raw.length <= MAX_LITERAL_CHARS;
      token = { kind: recognized ? 'regexp' : 'opaque', value: recognized ? raw : '', start, end: index };
    } else if (identifierStart(code)) {
      index++;
      while (identifierPart(text.charCodeAt(index))) index++;
      token = { kind: 'identifier', value: text.slice(start, index), start, end: index };
    } else if (code >= 48 && code <= 57) {
      index++;
      while (numberPart(text.charCodeAt(index))) index++;
      token = { kind: 'number', value: text.slice(start, index), start, end: index };
    } else {
      if (char === '(') {
        const previous = tokens.at(-1);
        const head = previous?.value === 'await' && tokens.at(-2)?.value === 'for' ? tokens.at(-2) : previous;
        controlHeads.push(head?.kind === 'identifier' &&
          ['if', 'while', 'for', 'with', 'catch', 'switch'].includes(head.value) && tokens.at(-2)?.value !== '.');
      } else if (char === ')') afterControlHead = controlHeads.pop() ?? false;
      token = { kind: 'punctuation', value: char, start, end: ++index };
    }
    const operator = tokens[tokens.length - 1], previous = tokens[tokens.length - 2];
    if (token.kind === 'string' && operator?.value === '+' && previous?.kind === 'string'
      && previous.value.length + token.value.length <= MAX_LITERAL_CHARS) {
      tokens.pop();
      tokens[tokens.length - 1] = { ...previous, value: previous.value + token.value, end: token.end, concealed: true };
    } else tokens.push(token);
    rawTokenCount++;
  }
  return { tokens, truncated: content.length > text.length || index < text.length };
}

/** Convenience view; integration uses the detailed API to report budget limits. */
export function tokenizeSource(content: string): readonly SourceToken[] {
  return tokenizeSourceDetailed(content).tokens;
}
