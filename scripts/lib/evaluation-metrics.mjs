/** Metrics keep incomplete attempts and product unknown results explicit. */
function prediction(row, policy) {
  if (row.status !== 'complete') return null;
  if (policy === 'highCritical') return row.highCriticalAlert;
  if (row.overallLevel === 'safe') return false;
  if (['suspicious', 'dangerous'].includes(row.overallLevel)) return true;
  return null; // Product `unknown` is an abstention, never a true negative.
}

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
export function confusion(rows, policy) {
  let tp = 0, fp = 0, tn = 0, fn = 0, abstainedMalicious = 0, abstainedBenign = 0;
  for (const row of rows) {
    const positive = prediction(row, policy);
    if (positive === null) {
      if (row.label === 'malicious') abstainedMalicious++;
      else abstainedBenign++;
    } else if (row.label === 'malicious') {
      if (positive) tp++; else fn++;
    } else if (positive) fp++;
    else tn++;
  }
  return {
    tp, fp, tn, fn, abstainedMalicious, abstainedBenign,
    precision: ratio(tp, tp + fp),
    recallAmongEvaluable: ratio(tp, tp + fn),
    falsePositiveRateAmongEvaluable: ratio(fp, fp + tn),
    endToEndRecall: ratio(tp, tp + fn + abstainedMalicious),
    coverage: ratio(tp + fp + tn + fn, rows.length),
  };
}

function timings(rows, field) {
  const values = rows.map((row) => row[field]).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (p) => values.length ? values[Math.ceil(p * values.length) - 1] : null;
  return { count: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export function summarize(rows) {
  const result = {};
  for (const split of ['dev', 'test']) {
    result[split] = {};
    for (const mode of ['metadata', 'deep']) {
      const selected = rows.filter((row) => row.split === split && row.mode === mode);
      const count = (status) => selected.filter((row) => row.status === status).length;
      result[split][mode] = {
        total: selected.length, complete: count('complete'), partial: count('partial'), failed: count('failed'),
        incompleteRate: ratio(count('partial') + count('failed'), selected.length),
        highCritical: confusion(selected, 'highCritical'), productLevel: confusion(selected, 'productLevel'),
        scannerTime: timings(selected, 'scanDurationMs'), wallTime: timings(selected, 'wallDurationMs'),
      };
    }
    const metadata = rows.filter((row) => row.split === split && row.mode === 'metadata');
    const deepById = new Map(rows.filter((row) => row.mode === 'deep').map((row) => [row.id, row]));
    result[split].deepDelta = {};
    for (const policy of ['highCritical', 'productLevel']) {
      const delta = { pairedEvaluable: 0, excludedPairs: 0, addedTruePositives: 0, lostTruePositives: 0, addedFalsePositives: 0, removedFalsePositives: 0 };
      for (const baseline of metadata) {
        const deep = deepById.get(baseline.id);
        const before = prediction(baseline, policy);
        const after = deep ? prediction(deep, policy) : null;
        if (before === null || after === null) { delta.excludedPairs++; continue; }
        delta.pairedEvaluable++;
        if (baseline.label === 'malicious') {
          if (!before && after) delta.addedTruePositives++;
          if (before && !after) delta.lostTruePositives++;
        } else {
          if (!before && after) delta.addedFalsePositives++;
          if (before && !after) delta.removedFalsePositives++;
        }
      }
      result[split].deepDelta[policy] = delta;
    }
  }
  return result;
}
