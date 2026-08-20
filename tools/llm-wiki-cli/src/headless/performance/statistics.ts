import type { SampleSummary } from './types';

function assertSamples(values: readonly number[], label: string): void {
  if (values.length === 0) {
    throw new RangeError(`${label} must contain at least one sample`);
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${label} must contain finite, non-negative samples`);
  }
}

/** Return a sorted copy, leaving the caller's timing trace untouched. */
export function sortedSamples(values: readonly number[], label = 'samples'): number[] {
  assertSamples(values, label);
  return [...values].sort((left, right) => left - right);
}

/** Linear-interpolated quantile, with p in the inclusive [0, 1] range. */
export function percentile(values: readonly number[], p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError('percentile must be between 0 and 1');
  }
  const sorted = sortedSamples(values);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = position - lower;
  // Timing metrics are reported in milliseconds. Remove IEEE-754 noise from
  // otherwise exact decimal interpolation (for example 39.699999999999996).
  const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
  return Math.round(interpolated * 1e12) / 1e12;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export function summarizeSamples(values: readonly number[]): SampleSummary {
  const sorted = sortedSamples(values);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: percentile(sorted, 0.5),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/** Native median divided by candidate median, as defined by ADR-0001. */
export function calculateSpeedup(
  nativeWallTimes: readonly number[],
  candidateWallTimes: readonly number[],
): number {
  const candidateMedian = median(candidateWallTimes);
  if (candidateMedian === 0) {
    throw new RangeError('candidate median wall time must be greater than zero');
  }
  return median(nativeWallTimes) / candidateMedian;
}

/** Compare the slowest candidate trial against the native median. */
export function calculateSlowestCandidateSpeedup(
  nativeWallTimes: readonly number[],
  candidateWallTimes: readonly number[],
): number {
  const slowestCandidate = Math.max(...sortedSamples(candidateWallTimes, 'candidate wall times'));
  if (slowestCandidate === 0) {
    throw new RangeError('slowest candidate wall time must be greater than zero');
  }
  return median(nativeWallTimes) / slowestCandidate;
}
