import type { CanaryTrial, TrialKind, TrialProtocolValidation } from './types';

const EXPECTED_TRIALS_PER_KIND = 3;

/**
 * Validate the sealed alternating native/candidate protocol without running
 * either engine. A protocol receipt is useful even when the canary is refused.
 */
export function validateAlternatingTrials(
  trials: readonly CanaryTrial[],
  expectedPerKind = EXPECTED_TRIALS_PER_KIND,
): TrialProtocolValidation {
  if (!Number.isInteger(expectedPerKind) || expectedPerKind < 1) {
    throw new RangeError('expectedPerKind must be a positive integer');
  }

  const issues: string[] = [];
  const nativeCount = trials.filter((trial) => trial.kind === 'native').length;
  const candidateCount = trials.filter((trial) => trial.kind === 'candidate').length;
  if (nativeCount !== expectedPerKind || candidateCount !== expectedPerKind) {
    issues.push(`expected exactly ${expectedPerKind} native trials and ${expectedPerKind} candidate trials`);
  }

  const alternating = trials.every((trial, index) => index === 0 || trial.kind !== trials[index - 1].kind);
  if (!alternating) {
    issues.push('trial kinds must alternate between native and candidate');
  }

  const ids = new Set<string>();
  if (trials.some((trial) => {
    if (ids.has(trial.id)) {
      return true;
    }
    ids.add(trial.id);
    return false;
  })) {
    issues.push('trial ids must be unique');
  }

  if (trials.some((trial) => !Number.isFinite(trial.wallTimeMs) || trial.wallTimeMs < 0)) {
    issues.push('trial wall times must be finite and non-negative');
  }
  if (trials.some((trial) => trial.kind !== 'native' && trial.kind !== 'candidate')) {
    issues.push('trial kind must be native or candidate');
  }
  if (trials.some((trial) => !trial.correctnessPassed)) {
    issues.push('one or more trials failed correctness');
  }

  return { valid: issues.length === 0, issues };
}

export function trialsOfKind(
  trials: readonly CanaryTrial[],
  kind: TrialKind,
): CanaryTrial[] {
  return trials.filter((trial) => trial.kind === kind);
}
