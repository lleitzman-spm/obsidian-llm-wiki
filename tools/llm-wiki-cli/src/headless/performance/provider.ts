import type { ProviderAttemptMeasurement, ProviderAttemptSummary } from './types';

/**
 * Attempt-level rates: recovered retries remain in the denominator, and a
 * 429 is counted by status or by an explicit adapter marker.
 */
export function summarizeProviderAttempts(
  attempts: readonly ProviderAttemptMeasurement[],
): ProviderAttemptSummary {
  const retries = attempts.filter((attempt) => attempt.retryAttempt === true).length;
  const rateLimits = attempts.filter((attempt) => attempt.statusCode === 429 || attempt.rateLimited === true).length;
  const budgetExhaustions = attempts.filter((attempt) => attempt.budgetExhausted === true).length;
  const denominator = attempts.length;
  return {
    attempts: denominator,
    retries,
    rateLimits,
    retryRate: denominator === 0 ? 0 : retries / denominator,
    rateLimitRate: denominator === 0 ? 0 : rateLimits / denominator,
    budgetExhaustions,
  };
}
