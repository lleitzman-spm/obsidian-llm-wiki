import { describe, expect, it } from 'vitest';

import {
  assessCanary,
  calculatePartitionSkew,
  calculateSerialFraction,
  calculateSpeedup,
  summarizeAllInCost,
  summarizeReducerTail,
  summarizeProviderAttempts,
  summarizeSamples,
  unionDuration,
  validateAlternatingTrials,
} from '../../../../../tools/llm-wiki-cli/src/headless/performance';

describe('headless performance measurement helpers', () => {
  it('summarizes median, p50, p95, and p99 with sorted, immutable samples', () => {
    const samples = [40, 10, 30, 20];

    expect(summarizeSamples(samples)).toEqual({
      count: 4,
      median: 25,
      p50: 25,
      p95: 38.5,
      p99: 39.7,
      min: 10,
      max: 40,
    });
    expect(samples).toEqual([40, 10, 30, 20]);
  });

  it('validates exactly three native and three candidate trials in alternating order', () => {
    const valid = validateAlternatingTrials([
      { id: 'n1', kind: 'native', wallTimeMs: 100, correctnessPassed: true },
      { id: 'c1', kind: 'candidate', wallTimeMs: 20, correctnessPassed: true },
      { id: 'n2', kind: 'native', wallTimeMs: 110, correctnessPassed: true },
      { id: 'c2', kind: 'candidate', wallTimeMs: 22, correctnessPassed: true },
      { id: 'n3', kind: 'native', wallTimeMs: 90, correctnessPassed: true },
      { id: 'c3', kind: 'candidate', wallTimeMs: 18, correctnessPassed: true },
    ]);

    expect(valid).toEqual({ valid: true, issues: [] });
  });

  it('reports protocol violations and correctness failures instead of silently accepting them', () => {
    const result = validateAlternatingTrials([
      { id: 'n1', kind: 'native', wallTimeMs: 100, correctnessPassed: true },
      { id: 'n2', kind: 'native', wallTimeMs: 100, correctnessPassed: false },
      { id: 'c1', kind: 'candidate', wallTimeMs: 20, correctnessPassed: true },
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'expected exactly 3 native trials and 3 candidate trials',
      'trial kinds must alternate between native and candidate',
      'one or more trials failed correctness',
    ]));
  });

  it('calculates speedup as native median divided by candidate median', () => {
    expect(calculateSpeedup([100, 120, 80], [20, 30, 10])).toBe(5);
  });

  it('unions serial-only intervals and excludes useful parallel overlap', () => {
    expect(unionDuration([
      { startMs: 0, endMs: 10 },
      { startMs: 5, endMs: 20 },
      { startMs: 30, endMs: 35 },
    ])).toBe(25);
    expect(calculateSerialFraction(
      [{ startMs: 0, endMs: 10 }, { startMs: 15, endMs: 25 }],
      40,
      [{ startMs: 5, endMs: 20 }],
    )).toBe(0.25);
  });

  it('measures partition skew and reducer p95/p99 tails', () => {
    expect(calculatePartitionSkew([10, 20, 30])).toEqual({
      max: 30,
      mean: 20,
      maxToMean: 1.5,
    });
    expect(summarizeReducerTail([10, 20, 30, 40])).toMatchObject({
      median: 25,
      p95: 38.5,
      p99: 39.7,
      p95ToMedian: 1.54,
    });
  });

  it('uses all provider attempts as retry and 429 denominators', () => {
    expect(summarizeProviderAttempts([
      { statusCode: 200 },
      { statusCode: 429, retryAttempt: true },
      { statusCode: 200, retryAttempt: true },
      { rateLimited: true },
    ])).toEqual({
      attempts: 4,
      retries: 2,
      rateLimits: 2,
      retryRate: 0.5,
      rateLimitRate: 0.5,
      budgetExhaustions: 0,
    });
  });

  it('fails closed when any all-in cost bucket is unknown', () => {
    expect(summarizeAllInCost([
      { bucket: 'input', amount: 10 },
      { bucket: 'output', amount: 5 },
      { bucket: 'tool', amount: undefined },
    ])).toEqual({
      complete: false,
      amount: undefined,
      byBucket: { input: 10, output: 5 },
      unknownBuckets: ['tool'],
    });
    expect(summarizeAllInCost([
      { bucket: 'input', amount: 10 },
      { bucket: 'output', amount: 5 },
    ])).toEqual({
      complete: true,
      amount: 15,
      byBucket: { input: 10, output: 5 },
      unknownBuckets: [],
    });
  });

  it('keeps correctness absolute while distinguishing acceptance and stretch targets', () => {
    const trials = [
      { id: 'n1', kind: 'native' as const, wallTimeMs: 100, correctnessPassed: true, cost: 10 },
      { id: 'c1', kind: 'candidate' as const, wallTimeMs: 15, correctnessPassed: true, cost: 11 },
      { id: 'n2', kind: 'native' as const, wallTimeMs: 110, correctnessPassed: true, cost: 10 },
      { id: 'c2', kind: 'candidate' as const, wallTimeMs: 14, correctnessPassed: true, cost: 11 },
      { id: 'n3', kind: 'native' as const, wallTimeMs: 90, correctnessPassed: true, cost: 10 },
      { id: 'c3', kind: 'candidate' as const, wallTimeMs: 16, correctnessPassed: true, cost: 11 },
    ];
    const base = {
      trials,
      serialFraction: 0.1,
      partitionLoads: [10, 10, 10],
      reducerDurations: [10, 10, 10],
      providerAttempts: [],
      candidateCosts: trials.filter((trial) => trial.kind === 'candidate').map((trial) => ({ complete: true, amount: trial.cost, byBucket: {}, unknownBuckets: [] })),
      nativeCosts: trials.filter((trial) => trial.kind === 'native').map((trial) => ({ complete: true, amount: trial.cost, byBucket: {}, unknownBuckets: [] })),
    };

    expect(assessCanary(base)).toMatchObject({ decision: 'stretch', accepted: true, stretch: true });
    expect(assessCanary({
      ...base,
      trials: trials.map((trial) => ({ ...trial, wallTimeMs: trial.kind === 'candidate' ? 20 : trial.wallTimeMs })),
      serialFraction: 0.2,
    })).toMatchObject({ decision: 'accept', accepted: true, stretch: false });
    expect(assessCanary({ ...base, trials: trials.map((trial) => ({ ...trial, correctnessPassed: trial.id !== 'c2' })) })).toMatchObject({
      decision: 'reject',
      accepted: false,
      correctnessPassed: false,
    });
    expect(assessCanary({
      ...base,
      candidateCosts: [{ complete: false, amount: undefined, byBucket: { input: 1 }, unknownBuckets: ['tool'] }],
    })).toMatchObject({ decision: 'revise-and-repeat', accepted: false });
  });
});
