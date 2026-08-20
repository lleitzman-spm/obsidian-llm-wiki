import { median, summarizeSamples } from './statistics';
import type { PartitionSkewSummary, ReducerTailSummary } from './types';

function assertLoads(loads: readonly number[]): void {
  if (loads.length === 0) {
    throw new RangeError('partition loads must contain at least one partition');
  }
  if (loads.some((load) => !Number.isFinite(load) || load < 0)) {
    throw new RangeError('partition loads must be finite and non-negative');
  }
}

/** max partition load / mean partition load. */
export function calculatePartitionSkew(loads: readonly number[]): PartitionSkewSummary {
  assertLoads(loads);
  const max = Math.max(...loads);
  const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
  return { max, mean, maxToMean: mean === 0 ? 0 : max / mean };
}

/** Reducer tail metrics used by the 4x acceptance gate. */
export function summarizeReducerTail(durations: readonly number[]): ReducerTailSummary {
  const summary = summarizeSamples(durations);
  const reducerMedian = median(durations);
  const p95ToMedian = reducerMedian === 0
    ? (summary.p95 === 0 ? 0 : Number.POSITIVE_INFINITY)
    : summary.p95 / reducerMedian;
  const p99ToMedian = reducerMedian === 0
    ? (summary.p99 === 0 ? 0 : Number.POSITIVE_INFINITY)
    : summary.p99 / reducerMedian;
  return {
    ...summary,
    p95ToMedian,
    p99ToMedian,
  };
}
