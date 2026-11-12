import type {SourceExcerpt} from './types.js';
type Interval = [number, number];
/** Character offsets are half-open UTF-16 offsets into the original decoded file. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') { starts.push(i + 2); i++; }
    else if (/[\r\n\u2028\u2029]/.test(text[i])) starts.push(i + 1);
  }
  return starts;
}
function lineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length;
  while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle; else high = middle; }
  return low + 1;
}
function mergeIntervals(intervals: Interval[]): Interval[] {
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}
function points(values: number[], head: number, end: number): number[] {
  return [...new Set(values.filter(value => Number.isSafeInteger(value) && value >= head && value < end))].sort((a, b) => a - b);
}
function seedWindows(intervals: Interval[], candidates: number[], budget: number, length: number): void {
  const count = Math.min(6, candidates.length, budget);
  let remaining = budget;
  for (let i = 0; i < count; i++) {
    const position = candidates[Math.floor(i * (candidates.length - 1) / Math.max(1, count - 1))];
    const width = Math.floor(remaining / (count - i));
    const start = Math.max(0, Math.min(length - width, position - Math.floor(width / 3)));
    intervals.push([start, start + width]);
    remaining -= width;
  }
}
/** Grow existing evidence windows using only uncovered characters. */
function refill(intervals: Interval[], target: number, length: number): Interval[] {
  let merged = mergeIntervals(intervals);
  let remaining = target - merged.reduce((sum, [start, end]) => sum + end - start, 0);
  while (remaining > 0) {
    const share = Math.max(1, Math.floor(remaining / (merged.length * 2)));
    for (let i = 0; i < merged.length && remaining; i++) {
      const left = Math.min(share, remaining, merged[i][0] - (i ? merged[i - 1][1] : 0));
      merged[i][0] -= left; remaining -= left;
      const right = Math.min(share, remaining, (i + 1 < merged.length ? merged[i + 1][0] : length) - merged[i][1]);
      merged[i][1] += right; remaining -= right;
    }
    merged = mergeIntervals(merged);
  }
  return merged;
}
export function excerptsFor(text: string, budget: number, positions: number[] = [], priorityPositions: number[] = []): {totalLines: number; excerpts: SourceExcerpt[]} {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Source excerpt budget must be a nonnegative safe integer');
  const starts = lineStarts(text), length = text.length, target = Math.min(length, budget);
  if (!target) return { totalLines: starts.length, excerpts: [] };
  let merged: Interval[];
  if (length <= target) merged = [[0, length]];
  else {
    const head = Math.max(1, Math.floor(target * 0.25)), tail = Math.floor(target * 0.2);
    const intervals: Interval[] = [[0, head]];
    if (tail) intervals.push([length - tail, length]);
    const priority = points(priorityPositions, head, length - tail);
    const ordinary = points(positions, head, length - tail).filter(position => !priority.includes(position));
    if (!priority.length && !ordinary.length) ordinary.push(Math.floor(length / 2));
    const body = target - head - tail;
    const priorityBudget = priority.length ? (ordinary.length ? Math.ceil(body * 2 / 3) : body) : 0;
    seedWindows(intervals, priority, priorityBudget, length);
    seedWindows(intervals, ordinary, body - priorityBudget, length);
    // Overlapping signal windows consume one span only. Spend the reclaimed
    // budget around the evidence already selected rather than silently losing it.
    merged = refill(intervals, target, length);
  }
  return {
    totalLines: starts.length,
    excerpts: merged.map(([startOffset, endOffset]) => ({ startOffset, endOffset, startLine: lineAt(starts, startOffset), endLine: lineAt(starts, Math.max(startOffset, endOffset - 1)), text: text.slice(startOffset, endOffset) })),
  };
}
