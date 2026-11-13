/** Shell pipelines are executable evidence only when passed to a bound process API. */
import { findProcessCommand } from './content-network-signals.js';
import { delimiterPairs } from './network-flow-expression.js';
import { topLevelRanges, type BindingRange } from './source-binding-patterns.js';
import { tokenizeSource, type SourceToken } from './source-tokens.js';

export const REMOTE_SHELL_PATTERN =
  /(?:\b(?:curl|wget)\b[^\r\n]{0,400}(?:\||&&|;)\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|cmd)\b|(?:Invoke-WebRequest|DownloadString|WebClient)[^\r\n]{0,500}(?:Invoke-Expression|\biex\b|Start-Process))/i;

/** A necessary lexical gate, including statically concealed module/command strings. */
export function hasRemoteShellCandidate(content: string): boolean {
  return REMOTE_SHELL_PATTERN.test(content) || /[+\\]/.test(content);
}

export interface RemoteShellExecutionSignal {
  readonly start: number;
  readonly end: number;
}

/**
 * Bounded literal/alias command strings only. Regexes, comments and strings
 * used as data are not commands. This does not evaluate templates, arbitrary
 * expressions, dynamically loaded modules or interprocedural flows.
 */
export function findRemoteShellExecution(
  content: string,
  suppliedTokens?: readonly SourceToken[],
): RemoteShellExecutionSignal | undefined {
  const tokens = suppliedTokens ?? tokenizeSource(content);
  const pairs = delimiterPairs(tokens);
  return findProcessCommand(content, tokens, ({ method, args, constant, start, end }) => {
    const command = constant(args[0]);
    if (command === undefined) return;
    const signal = { start, end };
    if (['exec', 'execSync'].includes(method) && REMOTE_SHELL_PATTERN.test(command)) return signal;

    const array = args[1];
    const argv = array && tokens[array.start]?.value === '[' && pairs.get(array.start) === array.end - 1
      ? topLevelRanges(tokens, pairs, array.start + 1, array.end - 1).filter(range => range.end > range.start)
      : [];
    const shell = command.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
    const commandFlag = (flag: string | undefined) => {
      if (flag === undefined) return false;
      if (/^(?:sh|bash|zsh|dash)(?:\.exe)?$/.test(shell)) return /^-[a-z]*c[a-z]*$/i.test(flag);
      if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(shell)) return /^(?:-command|-c)$/i.test(flag);
      return /^(?:cmd)(?:\.exe)?$/.test(shell) && /^\/[ck]$/i.test(flag);
    };
    for (let index = 0; index + 1 < argv.length; index++) {
      const flag = constant(argv[index]);
      if (flag === undefined || flag === '--' || /^(?:-file|--file)$/i.test(flag)) break;
      if (commandFlag(flag)) {
        const source = constant(argv[index + 1]);
        if (source !== undefined && REMOTE_SHELL_PATTERN.test(source)) return signal;
        break;
      }
      // Once a script/file is selected, subsequent argv is data for that file.
      if (/^(?:sh|bash|zsh|dash)(?:\.exe)?$/.test(shell) && !flag.startsWith('-')) break;
      if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(shell)) {
        if (/^-(?:ExecutionPolicy|InputFormat|OutputFormat|WindowStyle|WorkingDirectory|Version)$/i.test(flag)) index++;
        else if (!/^-(?:NoProfile|NonInteractive|NoLogo|Sta|Mta)$/i.test(flag)) break;
      }
      if (/^cmd(?:\.exe)?$/.test(shell) && !flag.startsWith('/')) break;
    }

    // spawn/execFile execute a pipeline string only with an explicit shell.
    const options = argv.length || (array && tokens[array.start]?.value === '[') ? args[2] : args[1];
    const explicitShell = (range?: BindingRange): boolean => {
      if (!range || tokens[range.start]?.value !== '{' || pairs.get(range.start) !== range.end - 1) return false;
      let enabled = false;
      for (const property of topLevelRanges(tokens, pairs, range.start + 1, range.end - 1)) {
        let key = tokens[property.start], colon = property.start + 1;
        if (key?.value === '.') { enabled = false; continue; }
        if (key?.value === '[') {
          if (pairs.get(property.start) !== property.start + 2 || tokens[property.start + 1]?.kind !== 'string') {
            enabled = false;
            continue;
          }
          key = tokens[property.start + 1];
          colon = property.start + 3;
        }
        if (!['identifier', 'string'].includes(key?.kind) || key.value !== 'shell') continue;
        const value = tokens[colon + 1];
        enabled = tokens[colon]?.value === ':' && property.end === colon + 2 &&
          ((value.kind === 'identifier' && value.value === 'true') || (value.kind === 'string' && value.value.length > 0));
      }
      return enabled;
    };
    if (explicitShell(options)) {
      const argumentsText = argv.map(argument => constant(argument));
      if (argumentsText.every((value): value is string => value !== undefined)) {
        const source = [command, ...argumentsText].join(' ');
        if (source.length <= 4096 && REMOTE_SHELL_PATTERN.test(source)) return signal;
      }
    }
    return;
  });
}
