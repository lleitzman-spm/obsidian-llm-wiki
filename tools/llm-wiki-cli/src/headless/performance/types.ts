/** Pure measurement contracts for the headless performance canary. */

export type TrialKind = 'native' | 'candidate';

export interface TrialInterval {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ProviderAttemptMeasurement {
  readonly statusCode?: number;
  readonly rateLimited?: boolean;
  readonly retryAttempt?: boolean;
  readonly budgetExhausted?: boolean;
}

export interface CostBucketMeasurement {
  /** Provider billing bucket, for example input, output, or tool. */
  readonly bucket: string;
  /** Undefined means the provider exposed the bucket but not its cost. */
  readonly amount?: number | null;
}

export interface CostSummary {
  readonly complete: boolean;
  readonly amount: number | undefined;
  readonly byBucket: Readonly<Record<string, number>>;
  readonly unknownBuckets: readonly string[];
}

export interface CanaryTrial {
  readonly id: string;
  readonly kind: TrialKind;
  readonly wallTimeMs: number;
  readonly correctnessPassed: boolean;
  readonly cost?: number | CostSummary;
}

export interface TrialProtocolValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface SampleSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface PartitionSkewSummary {
  readonly max: number;
  readonly mean: number;
  readonly maxToMean: number;
}

export interface ReducerTailSummary extends SampleSummary {
  readonly p95ToMedian: number;
  readonly p99ToMedian: number;
}

export interface ProviderAttemptSummary {
  readonly attempts: number;
  readonly retries: number;
  readonly rateLimits: number;
  readonly retryRate: number;
  readonly rateLimitRate: number;
  readonly budgetExhaustions: number;
}

export interface CanaryAssessmentInput {
  readonly trials: readonly CanaryTrial[];
  readonly serialFraction: number;
  readonly partitionLoads: readonly number[];
  readonly reducerDurations: readonly number[];
  readonly providerAttempts: readonly ProviderAttemptMeasurement[];
  readonly candidateCosts: readonly CostSummary[];
  readonly nativeCosts: readonly CostSummary[];
  readonly protocol?: TrialProtocolValidation;
}

export type CanaryDecision = 'accept' | 'stretch' | 'revise-and-repeat' | 'reject';

export interface CanaryAssessment {
  readonly decision: CanaryDecision;
  readonly accepted: boolean;
  readonly stretch: boolean;
  readonly correctnessPassed: boolean;
  readonly speedup: number | undefined;
  readonly slowestCandidateSpeedup: number | undefined;
  readonly reasons: readonly string[];
}
