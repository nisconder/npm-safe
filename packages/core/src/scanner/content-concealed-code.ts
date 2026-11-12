import { concealedConstants } from './concealed-string-table.js';
import { globalReferenceCheck } from './source-bindings.js';
import { topLevelRanges } from './source-binding-patterns.js';
import { tokenizeSource, type SourceToken } from './source-tokens.js';
import { FindingCategory, Severity, type ScanFinding } from './types.js';

const PROCESS_METHODS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const FILE_METHODS = new Set(['readFile', 'readFileSync', 'createReadStream']);
const NETWORK_MODULES = new Set(['request', 'http', 'https', 'axios', 'node:http', 'node:https']);
const NETWORK_METHODS = new Set(['post', 'put', 'request', 'get']);
interface ModuleBinding { name: string; module: string; method?: string; concealed: boolean; declaration: number }

/** Necessary conditions for the supported rotated literal-table shape. */
export function hasConcealedCodeCandidate(content: string): boolean {
  return content.includes('require') && content.includes('function') &&
    (/[+\\]/.test(content) || (content.includes('push') && content.includes('shift')));
}

/** Refuse aliases that are assigned again or rebound as parameters anywhere. */
function conflictingBinding(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>, binding: ModuleBinding): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind === 'identifier' && tokens[index].value === binding.name && index !== binding.declaration) {
      if (['const', 'let', 'var', 'function', 'class'].includes(tokens[index - 1]?.value) ||
        tokens[index + 1]?.value === '=') return true;
    }
    if (tokens[index].kind !== 'punctuation' || tokens[index].value !== '(') continue;
    if (['if', 'while', 'for', 'switch', 'with'].includes(tokens[index - 1]?.value)) continue;
    const close = pairs.get(index);
    if (close === undefined || close - index > 128) continue;
    if (tokens[close + 1]?.value !== '{' && !(tokens[close + 1]?.value === '=' && tokens[close + 2]?.value === '>')) continue;
    if (tokens.slice(index + 1, close).some(token => token.kind === 'identifier' && token.value === binding.name)) return true;
  }
  return false;
}

/**
 * A string table alone is not a finding. Require statically recovered process
 * execution AND actual file-reading AND network calls through imported modules.
 * Literal-table rotation and arithmetic wrappers are parsed as data; source is
 * never executed, imported, or passed to eval/Function.
 */
export function scanConcealedContent(content: string, filePath: string, suppliedTokens?: readonly SourceToken[]): ScanFinding[] {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filePath) || !hasConcealedCodeCandidate(content)) return [];
  const tokens = suppliedTokens ?? tokenizeSource(content);
  const constants = concealedConstants(tokens);
  if (!constants.recovered) return [];
  const { pairs, value } = constants;
  const isGlobal = globalReferenceCheck(tokens, pairs);
  const property = (start: number): { name: string; next: number; concealed: boolean } | undefined => {
    if (tokens[start]?.value === '.' && tokens[start + 1]?.kind === 'identifier') {
      return { name: tokens[start + 1].value, next: start + 2, concealed: false };
    }
    const close = pairs.get(start);
    if (tokens[start]?.value !== '[' || close === undefined) return;
    const name = value(start + 1, close);
    if (typeof name !== 'string') return;
    return { name, next: close + 1, concealed: close - start > 2 || !!tokens[start + 1].concealed };
  };
  const bindings = new Map<string, ModuleBinding>();
  let candidates = 0, declarationBudget = 1_000_000;
  // Only simple const bindings, including comma-separated declarations.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== 'identifier' || tokens[index].value !== 'const') continue;
    let end = index + 1;
    while (end < tokens.length && tokens[end].value !== ';') {
      if (--declarationBudget <= 0) return [];
      const close = pairs.get(end);
      end = close === undefined ? end + 1 : close + 1;
    }
    for (const range of topLevelRanges(tokens, pairs, index + 1, end)) {
      const start = range.start, required = start + 2;
      if (tokens[start]?.kind !== 'identifier' || tokens[start + 1]?.value !== '=' || tokens[required]?.value !== 'require' ||
        tokens[required + 1]?.value !== '(' || !isGlobal(required, 'require')) continue;
      const close = pairs.get(required + 1);
      if (close === undefined) continue;
      const module = value(required + 2, close), method = property(close + 1);
      if (typeof module !== 'string' || (method?.next ?? close + 1) !== range.end) continue;
      if (++candidates > 64) return [];
      const binding: ModuleBinding = {
        name: tokens[start].value, module, method: method?.name, declaration: start,
        concealed: close - required > 3 || tokens[required + 2].concealed || !!method?.concealed,
      };
      if (!conflictingBinding(tokens, pairs, binding)) bindings.set(binding.name, binding);
    }
  }
  let execution: { token: SourceToken; method: string } | undefined;
  let fileRead: string | undefined, network: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], binding = token.kind === 'identifier' ? bindings.get(token.value) : undefined;
    if (!binding || ['.', '?'].includes(tokens[index - 1]?.value) || index === binding.declaration) continue;
    const method = binding.method ? { name: binding.method, next: index + 1, concealed: binding.concealed } : property(index + 1);
    if (!method || tokens[method.next]?.value !== '(') continue;
    if (/^(?:node:)?child_process$/.test(binding.module) && PROCESS_METHODS.has(method.name) && (binding.concealed || method.concealed)) execution ??= { token, method: method.name };
    if (/^(?:node:)?fs$/.test(binding.module) && FILE_METHODS.has(method.name)) fileRead ??= `fs.${method.name}`;
    if (NETWORK_MODULES.has(binding.module) && NETWORK_METHODS.has(method.name)) network ??= `${binding.module}.${method.name}`;
  }
  if (!execution || !fileRead || !network) return [];
  return [{
    ruleId: 'content-concealed-capabilities',
    ruleName: 'Concealed process, file and network capabilities',
    severity: Severity.High,
    category: FindingCategory.CodeObfuscation,
    message: `A statically resolved string table conceals child_process.${execution.method} alongside ${fileRead} and ${network} calls in ${filePath}.`,
    recommendation: 'Review the concealed command, file access and network destinations before installation; this signal does not prove malicious execution.',
    filePath, lineNumber: content.slice(0, execution.token.start).split(/\r?\n/).length,
    codeSnippet: content.slice(execution.token.start, execution.token.start + 240),
  }];
}
