import type { SecretBinding } from './secret-flow-syntax.js';
import type { SourceToken } from './source-tokens.js';

/** Property mutations invalidate object snapshots and helper method summaries. */
export function propertyMutationCheck(tokens: readonly SourceToken[], pairs: ReadonlyMap<number, number>,
  binding: (name: string, index: number) => SecretBinding | undefined,
  visible: (scope: number, index: number) => boolean,
  scopeAt: (index: number) => number): (name: string, index: number, property?: string) => boolean {
  const writes = new Map<SecretBinding, Array<{ at: number; scope: number; property: string }>>();
  const latest = (target: SecretBinding, index: number) => target.values.findLast(value => value.at < index && visible(value.scope, index));
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== 'identifier' || ['.', '?'].includes(tokens[index - 1]?.value)) continue;
    let cursor = index + 1, members = 0;
    while (members < 16) {
      if (tokens[cursor]?.value === '.' && tokens[cursor + 1]?.kind === 'identifier') cursor += 2;
      else if (tokens[cursor]?.value === '[' && pairs.has(cursor)) cursor = pairs.get(cursor)! + 1;
      else break;
      members++;
    }
    if (!members) continue;
    const property = tokens[index + 1]?.value === '.' ? tokens[index + 2].value
      : tokens[index + 2]?.kind === 'string' ? tokens[index + 2].value : '*';
    const operator = tokens.slice(cursor, cursor + 4).map(token => token.value).join('');
    if (!/^(?:=(?!=|>)|\+\+|--|(?:\+|-|\*\*?|\/|%|&{1,2}|\|{1,2}|\?\?|\^|<{2}|>{2,3})=)/.test(operator)) continue;
    let target = binding(tokens[index].value, index);
    for (let depth = 0; target && depth < 8; depth++) {
      const found = writes.get(target) ?? [];
      found.push({ at: index, scope: scopeAt(index), property }); writes.set(target, found);
      const assigned = latest(target, index);
      if (!assigned || assigned.end !== assigned.start + 1 || tokens[assigned.start]?.kind !== 'identifier') break;
      target = binding(tokens[assigned.start].value, assigned.start);
    }
  }
  const mutated = (target: SecretBinding | undefined, index: number, property?: string, depth = 0): boolean => {
    if (!target || depth > 8) return false;
    const assigned = latest(target, index);
    if (writes.get(target)?.some(write => write.at < index && write.at > (assigned?.at ?? -1) &&
      (!property || write.property === property || write.property === '*') && visible(write.scope, index))) return true;
    if (assigned && assigned.end === assigned.start + 1 && tokens[assigned.start]?.kind === 'identifier') {
      return mutated(binding(tokens[assigned.start].value, assigned.start), index, property, depth + 1);
    }
    return false;
  };
  return (name, index, property) => mutated(binding(name, index), index, property);
}
