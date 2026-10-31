/** Narrow literal decoder-to-interpreter checks; never execute decoded bytes. */
interface ShellToken { readonly value: string; readonly quoted: boolean; readonly operator: boolean }
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby']);
const commandName = (token?: ShellToken): string => token?.value.replace(/^.*[\\/]/, '') ?? '';

function shellTokens(text: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < text.length && tokens.length < 1024) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] === '#' && (!index || /\s/.test(text[index - 1]))) return tokens;
    const start = index, quote = text[index];
    if (quote === "'" || quote === '"') {
      index++;
      let value = '', closed = false;
      while (index < text.length) {
        const char = text[index++];
        if (char === quote) { closed = true; break; }
        // Preserve shell substitutions as inert text for one known wrapper shape.
        if (char === '\\' && quote === '"' && ['"', '\\'].includes(text[index] ?? '')) value += text[index++];
        else value += char;
      }
      if (!closed) return [];
      tokens.push({ value, quoted: true, operator: false });
    } else if ('|;&<>'.includes(quote)) {
      index++;
      while (index < text.length && text[index] === quote && index - start < 3) index++;
      tokens.push({ value: text.slice(start, index), quoted: false, operator: true });
    } else {
      while (index < text.length && !/[\s'"|;&<>]/.test(text[index])) index++;
      tokens.push({ value: text.slice(start, index), quoted: false, operator: false });
    }
  }
  return index < text.length ? [] : tokens;
}

function base64Literal(value: string): boolean {
  if (value.length < 40 || value.length > 65_536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return false;
  return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === unpadded;
}

function decoder(segment: readonly ShellToken[]): boolean {
  const words = segment.map((token) => token.value);
  words[0] = commandName(segment[0]);
  const openssl = words[0] === 'openssl' && ['base64', 'enc'].includes(words[1]);
  if (words[0] !== 'base64' && !openssl) return false;
  if (words[0] === 'openssl' && words[1] === 'enc' && !words.includes('-base64') && !words.includes('-a')) return false;
  for (let index = openssl ? 2 : 1; index < segment.length; index++) {
    const token = segment[index];
    if (token.operator && token.value === '<<<' && base64Literal(segment[index + 1]?.value ?? '') && index + 2 === segment.length) break;
    if (token.operator || !/^(?:--decode|--ignore-garbage|-[idDA]+|-base64|-a)$/.test(token.value)) return false;
  }
  return words.some((value) => value === '--decode' || /^-[idD]+$/.test(value));
}

function literalInput(segment: readonly ShellToken[]): boolean {
  const command = commandName(segment[0]);
  if (command === 'printf' && /^-v/.test(segment[1]?.value ?? '')) return false;
  return !segment.some((token) => token.operator) && ['echo', 'printf'].includes(command) &&
    segment.slice(1).some((token) => !token.operator && base64Literal(token.value));
}

function interpreter(segment: readonly ShellToken[]): boolean {
  if (segment.some((token) => token.operator)) return false;
  const command = commandName(segment[0]);
  const args = segment.slice(1).map((token) => token.value);
  if (SHELLS.has(command)) {
    const stop = args.findIndex((value) => value === '--' || !value.startsWith('-'));
    const options = stop < 0 ? args : args.slice(0, stop);
    if (options.some((value) => /^-[^-]*c/.test(value))) return false;
    return !args.length || options.some((value) => /^-[^-]*s/.test(value)) || args.every((value) => /^-[a-z]+$/i.test(value));
  }
  return INTERPRETERS.has(command) && (!args.length || (args.length === 1 && args[0] === '-'));
}

function pipelineSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (token.operator && token.value === '|') segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments;
}

function hasLiteralDecode(tokens: readonly ShellToken[]): boolean {
  const segments = pipelineSegments(tokens);
  if (segments.length === 2 && literalInput(segments[0]) && decoder(segments[1])) return true;
  return segments.length === 1 && decoder(segments[0]) && segments[0].some((token, index) =>
    token.operator && token.value === '<<<' && base64Literal(segments[0][index + 1]?.value ?? ''));
}

function executesTokens(tokens: readonly ShellToken[]): boolean {
  if (!tokens.length) return false;
  const words = tokens.map((token) => token.value);
  words[0] = commandName(tokens[0]);
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(words[0])) {
    return tokens.some((token, index) => !token.quoted && /^-(?:encodedcommand|enc|e)$/i.test(token.value) &&
      base64Literal(tokens[index + 1]?.value ?? ''));
  }
  const segments = pipelineSegments(tokens);
  for (let index = 1; index < segments.length; index++) {
    if (interpreter(segments[index]) && hasLiteralDecode(segments.slice(0, index).flatMap((segment, part) =>
      part ? [{ value: '|', quoted: false, operator: true }, ...segment] : segment))) return true;
  }
  const argument = tokens[SHELLS.has(words[0]) && words[1] === '-c' ? 2 : words[0] === 'eval' ? 1 : -1];
  if (argument?.quoted && argument.value.startsWith('$(') && argument.value.endsWith(')')) {
    return hasLiteralDecode(shellTokens(argument.value.slice(2, -1)));
  }
  return false;
}

function executesEncodedCommand(command: string): boolean {
  const tokens = shellTokens(command);
  let statement: ShellToken[] = [];
  for (const token of tokens) {
    if (token.operator && [';', '&&', '||', '&'].includes(token.value)) {
      if (executesTokens(statement)) return true;
      statement = [];
    } else statement.push(token);
  }
  return executesTokens(statement);
}

/** Real install commands in fenced code remain eligible; Markdown is not trusted code. */
export function findEncodedShell(readme: string): { line: number; snippet: string } | null {
  if (!/base64|(?:powershell|pwsh)(?:\.exe)?\s[^\n]{0,200}-(?:encodedcommand|enc|e)\b/i.test(readme)) return null;
  const lines = readme.split(/\r\n|[\n\r\u2028\u2029]/);
  let htmlComment = false;
  for (let index = 0; index < lines.length; index++) {
    let line = '', position = 0;
    while (position < lines[index].length) {
      if (htmlComment) {
        const close = lines[index].indexOf('-->', position);
        if (close < 0) break;
        position = close + 3;
        htmlComment = false;
      } else {
        const open = lines[index].indexOf('<!--', position);
        if (open < 0) { line += lines[index].slice(position); break; }
        line += lines[index].slice(position, open);
        position = open + 4;
        htmlComment = true;
      }
    }
    const start = index;
    // Shell backslash or pipe continuations have a local, bounded association.
    while (/[\\|]\s*$/.test(line) && index + 1 < lines.length && index - start < 7) {
      line = line.replace(/\\\s*$/, '') + ' ' + lines[++index];
    }
    if (line.length > 65_536 || /^\s*(?:```|~~~)/.test(line)) continue;
    const candidates = [line.trim().replace(/^(?:\$|PS>)\s+/, ''), ...Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1])];
    if (candidates.some(executesEncodedCommand)) return { line: start + 1, snippet: lines.slice(start, index + 1).join('\n').trim().slice(0, 240) };
  }
  return null;
}
