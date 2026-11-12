import { topLevelRanges, type BindingRange } from './source-binding-patterns.js';
import type { SecretSyntax } from './secret-flow-syntax.js';

export const PRIVATE_MATERIAL = 1 << 16;
const KEY_NAME = /^_?(?:privateKey|secretKey|mnemonic)$/i;
const COPIES = new Set(['slice', 'substring', 'substr', 'subarray', 'split', 'reverse', 'join', 'toString']);

export function assignedValue(syntax: SecretSyntax, name: string, index: number): BindingRange | undefined {
  const binding = syntax.binding(name, index);
  if (!binding) return;
  for (let offset = binding.values.length - 1; offset >= 0; offset--) {
    const value = binding.values[offset];
    if (value.at < index && syntax.visible(value.scope, index)) return value;
  }
}

function sourceCall(syntax: SecretSyntax, path: string, at: number): boolean {
  const name = path.split('.').at(-1);
  if (['generatePrivateKey', 'randomPrivateKey', 'generateMnemonic', 'mnemonicToSeed', 'mnemonicToSeedSync'].includes(name ?? '')) return true;
  if (name !== 'generateSeed') return false;
  // Generic random-number seeds are not key material. Recognize a seed generator
  // only when its receiver is bound to a known cryptographic seed API module.
  const assignment = assignedValue(syntax, path.split('.')[0], at);
  return !!assignment && syntax.tokens.slice(assignment.start, assignment.end).some(token =>
    token.kind === 'string' && /(?:^|\/)(?:ripple-keypairs|bip39)(?:\/|$)/.test(token.value));
}

interface ObjectFields {
  /** Undefined retains an overwrite whose runtime value cannot be inferred. */
  readonly fields: ReadonlyMap<string, BindingRange | undefined>;
  /** An unknown spread/computed key can overwrite any earlier property. */
  readonly unknown: boolean;
}

/** Resolve final data properties in source order without evaluating object code. */
function objectFields(syntax: SecretSyntax, range: BindingRange | undefined, depth = 0): ObjectFields | undefined {
  if (!range || depth > 8 || range.end - range.start > 512) return;
  const { tokens, pairs } = syntax;
  if (range.end === range.start + 1 && tokens[range.start]?.kind === 'identifier') {
    const name = tokens[range.start].value;
    if (syntax.mutated(name, range.start)) return;
    return objectFields(syntax, assignedValue(syntax, name, range.start), depth + 1);
  }
  if (tokens[range.start]?.value !== '{' || pairs.get(range.start) !== range.end - 1) return;
  const fields = new Map<string, BindingRange | undefined>();
  let unknown = false;
  for (const field of topLevelRanges(tokens, pairs, range.start + 1, range.end - 1)) {
    if (field.start === field.end) continue;
    if (tokens[field.start]?.value === '.' && tokens[field.start + 1]?.value === '.' && tokens[field.start + 2]?.value === '.') {
      const spread = objectFields(syntax, { start: field.start + 3, end: field.end }, depth + 1);
      if (!spread || spread.unknown) { fields.clear(); unknown = true; }
      for (const [name, value] of spread?.fields ?? []) fields.set(name, value);
      continue;
    }
    let keyIndex = field.start;
    // Accessors and methods overwrite earlier data fields but their bodies are
    // not object values. Recognize their keys only to invalidate stale evidence.
    if (['get', 'set', 'async'].includes(tokens[keyIndex]?.value) && tokens[keyIndex + 1]?.value !== ':' &&
      tokens[keyIndex + 1]?.value !== '(' && field.end > keyIndex + 1) keyIndex++;
    let name: string | undefined, next = keyIndex + 1;
    if (['identifier', 'string', 'number'].includes(tokens[keyIndex]?.kind)) name = tokens[keyIndex].value;
    else if (tokens[keyIndex]?.value === '[' && pairs.get(keyIndex) === keyIndex + 2 &&
      ['string', 'number'].includes(tokens[keyIndex + 1]?.kind)) {
      name = tokens[keyIndex + 1].value; next = keyIndex + 3;
    }
    if (name === undefined) { fields.clear(); unknown = true; continue; }
    if (tokens[next]?.value === ':') fields.set(name, { start: next + 1, end: field.end });
    else if (keyIndex === field.start && field.end === next) fields.set(name, field);
    else fields.set(name, undefined);
  }
  return { fields, unknown };
}

function knownProperty(syntax: SecretSyntax, range: BindingRange | undefined, name: string): { known: boolean; value?: BindingRange } {
  const object = objectFields(syntax, range);
  return object ? { known: true, value: object.fields.get(name) } : { known: false };
}

/** Only copies/reversible encodings propagate secret bytes; signatures/hashes do not. */
export function secretValue(syntax: SecretSyntax, start: number, end: number, owner?: number, depth = 0): number {
  if (depth > 12 || start >= end || end - start > 512) return 0;
  const { tokens, pairs } = syntax;
  while (tokens[start]?.value === 'await') start++;
  if (start >= end) return 0;
  // Concatenations transport bytes; comparisons, logical tests and arithmetic do not.
  for (let index = start; index < end; index++) {
    const close = pairs.get(index);
    if (close !== undefined && close < end) { index = close; continue; }
    if (tokens[index].kind !== 'punctuation') continue;
    if (tokens[index].value === '+') return secretValue(syntax, start, index, owner, depth + 1) | secretValue(syntax, index + 1, end, owner, depth + 1);
    if (['=', '?', '&', '|', '<', '>'].includes(tokens[index].value)) return 0;
  }
  let cursor = start + 1, value = 0, path = '';
  let shape: BindingRange | undefined;
  let mutatedObject = false;
  const first = tokens[start];
  if (first.value === '{' || first.value === '[') {
    const close = pairs.get(start);
    if (close !== end - 1) return 0;
    if (first.value === '{') {
      const fields = objectFields(syntax, { start, end }, depth);
      return fields ? [...fields.fields.values()].reduce((result, range) => result |
        (range ? secretValue(syntax, range.start, range.end, owner, depth + 1) : 0), 0) : 0;
    }
    return topLevelRanges(tokens, pairs, start + 1, close).reduce((result, range) => result |
      secretValue(syntax, range.start, range.end, owner, depth + 1), 0);
  }
  if (first.value === '(') {
    const close = pairs.get(start);
    if (close === undefined || close >= end) return 0;
    // Preserve the callee in transpiled `(0, module.method)(...)` calls.
    const parts = topLevelRanges(tokens, pairs, start + 1, close);
    const last = parts.at(-1)!;
    value = secretValue(syntax, last.start, last.end, owner, depth + 1);
    path = tokens.slice(last.start, last.end).map(token => token.value).join('');
    cursor = close + 1;
  } else if (first.kind === 'identifier') {
    path = first.value;
    const binding = syntax.binding(first.value, start);
    const assigned = assignedValue(syntax, first.value, start);
    shape = assigned;
    mutatedObject = syntax.mutated(first.value, start);
    if (assigned) value = secretValue(syntax, assigned.start, assigned.end, owner, depth + 1);
    else if (binding?.parameter) {
      if (binding.parameter.functionId === owner) value = 1 << binding.parameter.position;
      if (KEY_NAME.test(first.value)) value |= PRIVATE_MATERIAL;
    } else if (!binding && KEY_NAME.test(first.value)) value = PRIVATE_MATERIAL;
    if (mutatedObject) value = 0;
  } else if (first.kind !== 'string' && first.kind !== 'number') return 0;
  while (cursor < end) {
    const token = tokens[cursor];
    if (token.value === '.' && tokens[cursor + 1]?.kind === 'identifier') {
      const property = tokens[cursor + 1].value;
      path += `.${property}`;
      const field = knownProperty(syntax, shape, property);
      shape = field.value;
      if (mutatedObject) value = 0;
      else if (field.known) value = field.value ? secretValue(syntax, field.value.start, field.value.end, owner, depth + 1) : 0;
      else if (KEY_NAME.test(property)) value = PRIVATE_MATERIAL;
      else if (['publicKey', '_publicKey', 'length', 'byteLength'].includes(property)) value = 0;
      else if (tokens[cursor + 2]?.value !== '(' && property !== 'default') value = 0;
      cursor += 2;
    } else if (token.value === '[' && tokens[cursor + 1]?.kind === 'string' && tokens[cursor + 2]?.value === ']') {
      const property = tokens[cursor + 1].value;
      const field = knownProperty(syntax, shape, property);
      shape = field.value;
      value = mutatedObject ? 0 : field.known ? (field.value ? secretValue(syntax, field.value.start, field.value.end, owner, depth + 1) : 0)
        : KEY_NAME.test(property) ? PRIVATE_MATERIAL : 0;
      path += `.${property}`; cursor += 3;
    } else if (token.value === '(') {
      const close = pairs.get(cursor);
      if (close === undefined || close >= end) return 0;
      const args = topLevelRanges(tokens, pairs, cursor + 1, close);
      const method = path.split('.').at(-1)!;
      shape = undefined;
      if (sourceCall(syntax, path, start)) value = PRIVATE_MATERIAL;
      else if (COPIES.has(method)) { /* Reversible operations retain receiver bytes. */ }
      else if (['JSON.stringify', 'Buffer.from', 'Array.from', 'Uint8Array.from', 'String', 'toBuffer', 'encodeURIComponent', 'btoa'].includes(path) ||
        (method === 'encode' && /(?:^|\.)(?:bs58(?:__default)?|base58|base64)(?:\.|$)/i.test(path))) {
        value = args.length ? secretValue(syntax, args[0].start, args[0].end, owner, depth + 1) : 0;
      } else value = 0;
      cursor = close + 1;
    } else return 0;
  }
  return value;
}

/** Inspect only transmitted fetch options, not incidental secrets in other fields. */
export function networkPayload(syntax: SecretSyntax, start: number, end: number, owner?: number, depth = 0): number {
  const fields = objectFields(syntax, { start, end }, depth);
  if (!fields) return 0;
  let result = 0;
  for (const name of ['body', 'headers']) {
    const range = fields.fields.get(name);
    if (range) result |= secretValue(syntax, range.start, range.end, owner);
  }
  return result;
}

export function literalDestination(syntax: SecretSyntax, start: number, end: number, depth = 0): boolean {
  if (depth > 8 || end !== start + 1) return false;
  const token = syntax.tokens[start];
  if (token?.kind === 'string') return /^https?:\/\//i.test(token.value);
  if (token?.kind !== 'identifier') return false;
  const assigned = assignedValue(syntax, token.value, start);
  return !!assigned && literalDestination(syntax, assigned.start, assigned.end, depth + 1);
}
