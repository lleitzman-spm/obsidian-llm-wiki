import type { CostBucketMeasurement, CostSummary } from './types';

/**
 * Sum every exposed billing bucket. An omitted/unknown amount keeps the
 * bucket in the report but makes the all-in total incomplete (fail closed).
 */
export function summarizeAllInCost(
  buckets: readonly CostBucketMeasurement[] | Readonly<Record<string, number | null | undefined>>,
): CostSummary {
  const entries: readonly CostBucketMeasurement[] = Array.isArray(buckets)
    ? buckets
    : Object.entries(buckets).map(([bucket, amount]) => ({ bucket, amount }));
  const byBucket: Record<string, number> = {};
  const unknownBuckets: string[] = [];
  for (const entry of entries) {
    if (entry.amount === undefined || entry.amount === null) {
      if (!unknownBuckets.includes(entry.bucket)) {
        unknownBuckets.push(entry.bucket);
      }
      continue;
    }
    if (!Number.isFinite(entry.amount) || entry.amount < 0) {
      throw new RangeError(`cost amount for ${entry.bucket} must be finite and non-negative`);
    }
    byBucket[entry.bucket] = (byBucket[entry.bucket] ?? 0) + entry.amount;
  }
  if (unknownBuckets.length > 0) {
    return { complete: false, amount: undefined, byBucket, unknownBuckets };
  }
  const amount = Object.values(byBucket).reduce((sum, value) => sum + value, 0);
  return { complete: true, amount, byBucket, unknownBuckets };
}

export function assertCompleteCost(cost: CostSummary, label = 'cost'): number {
  if (!cost.complete || cost.amount === undefined || cost.unknownBuckets.length > 0) {
    throw new RangeError(`${label} is incomplete: unknown billed bucket`);
  }
  if (!Number.isFinite(cost.amount) || cost.amount < 0) {
    throw new RangeError(`${label} amount must be finite and non-negative`);
  }
  return cost.amount;
}
