import type { TrialInterval } from './types';

function validateIntervals(intervals: readonly TrialInterval[]): void {
  for (const interval of intervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)) {
      throw new RangeError('interval bounds must be finite');
    }
    if (interval.startMs < 0 || interval.endMs < interval.startMs) {
      throw new RangeError('intervals must be non-negative and end at or after start');
    }
  }
}

/** Duration of the union of half-open intervals; overlap is counted once. */
export function unionDuration(intervals: readonly TrialInterval[]): number {
  validateIntervals(intervals);
  const ordered = intervals
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  for (const interval of ordered) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else if (interval.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMs);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    }
  }
  if (currentStart !== undefined && currentEnd !== undefined) {
    total += currentEnd - currentStart;
  }
  return total;
}

function intersectIntervals(
  left: readonly TrialInterval[],
  right: readonly TrialInterval[],
): TrialInterval[] {
  const intersections: TrialInterval[] = [];
  for (const a of left) {
    for (const b of right) {
      const startMs = Math.max(a.startMs, b.startMs);
      const endMs = Math.min(a.endMs, b.endMs);
      if (endMs > startMs) {
        intersections.push({ startMs, endMs });
      }
    }
  }
  return intersections;
}

/**
 * Union of coordinator-only intervals, excluding portions overlapping useful
 * map/reducer work. This is the serial-only numerator from ADR-0001.
 */
export function serialOnlyUnionDuration(
  serialIntervals: readonly TrialInterval[],
  usefulParallelIntervals: readonly TrialInterval[] = [],
): number {
  validateIntervals(serialIntervals);
  validateIntervals(usefulParallelIntervals);
  return Math.max(0, unionDuration(serialIntervals) - unionDuration(
    intersectIntervals(serialIntervals, usefulParallelIntervals),
  ));
}

export function calculateSerialFraction(
  serialIntervals: readonly TrialInterval[],
  endToEndWallTimeMs: number,
  usefulParallelIntervals: readonly TrialInterval[] = [],
): number {
  if (!Number.isFinite(endToEndWallTimeMs) || endToEndWallTimeMs <= 0) {
    throw new RangeError('end-to-end wall time must be greater than zero');
  }
  const serialOnlyMs = serialOnlyUnionDuration(serialIntervals, usefulParallelIntervals);
  if (serialOnlyMs > endToEndWallTimeMs) {
    throw new RangeError('serial-only duration cannot exceed end-to-end wall time');
  }
  return serialOnlyMs / endToEndWallTimeMs;
}
