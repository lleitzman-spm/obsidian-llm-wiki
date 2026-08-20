import { assertCompleteCost } from './cost';
import { calculateSlowestCandidateSpeedup, calculateSpeedup, median } from './statistics';
import { validateAlternatingTrials, trialsOfKind } from './protocol';
import { calculatePartitionSkew, summarizeReducerTail } from './topology';
import { summarizeProviderAttempts } from './provider';
import type {
  CanaryAssessment,
  CanaryAssessmentInput,
  CanaryTrial,
  CostSummary,
} from './types';

const ACCEPTANCE_SPEEDUP = 4;
const STRETCH_SPEEDUP = 6;
const SLOWEST_CANDIDATE_SPEEDUP = 3;
const ACCEPTANCE_SERIAL_FRACTION = 0.25;
const STRETCH_SERIAL_FRACTION = 1 / 6;
const MAX_PARTITION_SKEW = 4;
const MAX_REDUCER_P95_TO_MEDIAN = 4;
const MAX_RATE_LIMIT_RATE = 0.02;
const MAX_RETRY_RATE = 0.10;
const MAX_CANDIDATE_COST_MULTIPLIER = 1.25;

export const CANARY_THRESHOLDS = Object.freeze({
  acceptanceSpeedup: ACCEPTANCE_SPEEDUP,
  stretchSpeedup: STRETCH_SPEEDUP,
  slowestCandidateSpeedup: SLOWEST_CANDIDATE_SPEEDUP,
  acceptanceSerialFraction: ACCEPTANCE_SERIAL_FRACTION,
  stretchSerialFraction: STRETCH_SERIAL_FRACTION,
  maxPartitionSkew: MAX_PARTITION_SKEW,
  maxReducerP95ToMedian: MAX_REDUCER_P95_TO_MEDIAN,
  maxRateLimitRate: MAX_RATE_LIMIT_RATE,
  maxRetryRate: MAX_RETRY_RATE,
  maxCandidateCostMultiplier: MAX_CANDIDATE_COST_MULTIPLIER,
});

function completeCosts(costs: readonly CostSummary[], label: string): number[] {
  return costs.map((cost, index) => assertCompleteCost(cost, `${label}[${index}]`));
}

function correctnessPassed(trials: readonly CanaryTrial[]): boolean {
  return trials.length > 0 && trials.every((trial) => trial.correctnessPassed);
}

/**
 * Apply the ADR-0001 acceptance gates to already-recorded measurements. This
 * function only classifies evidence; it never runs providers or writes a
 * receipt.
 */
export function assessCanary(input: CanaryAssessmentInput): CanaryAssessment {
  const observedProtocol = validateAlternatingTrials(input.trials);
  const protocol = input.protocol === undefined ? observedProtocol : {
    valid: input.protocol.valid && observedProtocol.valid,
    issues: [...new Set([...input.protocol.issues, ...observedProtocol.issues])],
  };
  const nativeTrials = trialsOfKind(input.trials, 'native');
  const candidateTrials = trialsOfKind(input.trials, 'candidate');
  const nativeWallTimes = nativeTrials.map((trial) => trial.wallTimeMs);
  const candidateWallTimes = candidateTrials.map((trial) => trial.wallTimeMs);
  let speedup: number | undefined;
  let slowestCandidateSpeedup: number | undefined;
  const reasons: string[] = [];

  try {
    speedup = calculateSpeedup(nativeWallTimes, candidateWallTimes);
    slowestCandidateSpeedup = calculateSlowestCandidateSpeedup(nativeWallTimes, candidateWallTimes);
  } catch {
    reasons.push('native and candidate wall-time samples are incomplete or invalid');
  }

  const correctness = correctnessPassed(input.trials);
  if (!correctness) {
    reasons.push('correctness is an absolute gate: every trial must pass');
  }
  if (!protocol.valid) {
    reasons.push(...protocol.issues);
  }
  if (!Number.isFinite(input.serialFraction) || input.serialFraction < 0 || input.serialFraction > 1) {
    reasons.push('serial fraction must be between 0 and 1');
  } else if (input.serialFraction > ACCEPTANCE_SERIAL_FRACTION) {
    reasons.push('serial-only fraction exceeds the 25% 4x acceptance gate');
  }

  let partitionSkew: ReturnType<typeof calculatePartitionSkew> | undefined;
  let reducerTail: ReturnType<typeof summarizeReducerTail> | undefined;
  try {
    partitionSkew = calculatePartitionSkew(input.partitionLoads);
    reducerTail = summarizeReducerTail(input.reducerDurations);
  } catch {
    reasons.push('partition and reducer measurements are incomplete or invalid');
  }

  const provider = summarizeProviderAttempts(input.providerAttempts);
  let candidateCostMedian: number | undefined;
  let nativeCostMedian: number | undefined;
  try {
    candidateCostMedian = median(completeCosts(input.candidateCosts, 'candidate cost'));
    nativeCostMedian = median(completeCosts(input.nativeCosts, 'native cost'));
  } catch {
    reasons.push('all-in cost is incomplete: every billed bucket must be accounted for');
  }

  if (slowestCandidateSpeedup !== undefined && slowestCandidateSpeedup < SLOWEST_CANDIDATE_SPEEDUP) {
    reasons.push('slowest candidate trial is below the required 3x native median');
  }
  if (partitionSkew !== undefined && partitionSkew.maxToMean > MAX_PARTITION_SKEW) {
    reasons.push('partition skew exceeds the 4x max-to-mean gate');
  }
  if (reducerTail !== undefined && reducerTail.p95ToMedian > MAX_REDUCER_P95_TO_MEDIAN) {
    reasons.push('reducer p95 exceeds 4x reducer median');
  }
  if (provider.rateLimitRate > MAX_RATE_LIMIT_RATE) {
    reasons.push('429 attempts exceed the 2% gate');
  }
  if (provider.retryRate > MAX_RETRY_RATE) {
    reasons.push('retry attempts exceed the 10% gate');
  }
  if (provider.budgetExhaustions > 0) {
    reasons.push('one or more retry budgets were exhausted');
  }
  if (candidateCostMedian !== undefined && nativeCostMedian !== undefined &&
      candidateCostMedian > nativeCostMedian * MAX_CANDIDATE_COST_MULTIPLIER) {
    reasons.push('candidate all-in cost exceeds 1.25x native median');
  }
  if (speedup !== undefined && speedup < ACCEPTANCE_SPEEDUP) {
    reasons.push('median speedup is below the 4x acceptance target');
  } else if (speedup !== undefined && speedup >= STRETCH_SPEEDUP &&
      input.serialFraction > STRETCH_SERIAL_FRACTION &&
      input.serialFraction <= ACCEPTANCE_SERIAL_FRACTION) {
    reasons.push('serial-only fraction exceeds the 16.7% 6x stretch gate');
  }

  const structuralGates = protocol.valid && correctness && speedup !== undefined &&
    slowestCandidateSpeedup !== undefined && slowestCandidateSpeedup >= SLOWEST_CANDIDATE_SPEEDUP &&
    partitionSkew !== undefined && partitionSkew.maxToMean <= MAX_PARTITION_SKEW &&
    reducerTail !== undefined && reducerTail.p95ToMedian <= MAX_REDUCER_P95_TO_MEDIAN &&
    provider.rateLimitRate <= MAX_RATE_LIMIT_RATE && provider.retryRate <= MAX_RETRY_RATE &&
    provider.budgetExhaustions === 0 && candidateCostMedian !== undefined &&
    nativeCostMedian !== undefined && candidateCostMedian <= nativeCostMedian * MAX_CANDIDATE_COST_MULTIPLIER;
  const acceptance = structuralGates && speedup !== undefined && speedup >= ACCEPTANCE_SPEEDUP &&
    input.serialFraction <= ACCEPTANCE_SERIAL_FRACTION;
  const stretch = acceptance && speedup !== undefined && speedup >= STRETCH_SPEEDUP &&
    input.serialFraction <= STRETCH_SERIAL_FRACTION;

  if (correctness && !acceptance && reasons.length === 0) {
    reasons.push('performance evidence does not meet the 4x acceptance gates');
  }
  const decision = !correctness ? 'reject' : stretch ? 'stretch' : acceptance ? 'accept' : 'revise-and-repeat';
  return {
    decision,
    accepted: acceptance,
    stretch,
    correctnessPassed: correctness,
    speedup,
    slowestCandidateSpeedup,
    reasons,
  };
}
