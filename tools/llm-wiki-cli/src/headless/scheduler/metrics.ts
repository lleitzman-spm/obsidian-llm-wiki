import type { HealthWindowSnapshot, ProviderAttempt } from './types';

export function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) return 0;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentileRank));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function parseRetryAfter(value: string | number | undefined, now = Date.now()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const raw = value.trim();
  const seconds = /^\d+(?:\.\d+)?s$/i.exec(raw);
  if (seconds) return Math.max(0, Number.parseFloat(seconds[0].slice(0, -1)) * 1000);
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number.parseFloat(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isRateLimited(attempt: ProviderAttempt): boolean {
  return attempt.rateLimited === true || attempt.statusCode === 429;
}

export function isTimedOut(attempt: ProviderAttempt): boolean {
  return attempt.timedOut === true;
}

export interface ProviderAttemptSummary {
  readonly attempts: number;
  readonly retries: number;
  readonly rateLimits: number;
  readonly retryRate: number;
  readonly rateLimitRate: number;
  readonly budgetExhaustions: number;
}

export function summarizeProviderAttempts(attempts: readonly ProviderAttempt[]): ProviderAttemptSummary {
  const window = new HealthWindow();
  for (const attempt of attempts) window.recordProviderAttempt(attempt);
  const snapshot = window.snapshot();
  return {
    attempts: snapshot.providerAttempts,
    retries: snapshot.retryAttempts,
    rateLimits: snapshot.rateLimitAttempts,
    retryRate: snapshot.retryRate,
    rateLimitRate: snapshot.rateLimitRate,
    budgetExhaustions: snapshot.budgetExhaustions,
  };
}

export class HealthWindow {
  private terminalSources = 0;
  private providerAttempts = 0;
  private retryAttempts = 0;
  private rateLimitAttempts = 0;
  private timeoutAttempts = 0;
  private budgetExhaustions = 0;
  private readonly latencyMs: number[] = [];
  private headroomRatio = 1;

  public recordProviderAttempt(attempt: ProviderAttempt): void {
    this.providerAttempts += 1;
    if (attempt.retryAttempt) this.retryAttempts += 1;
    if (isRateLimited(attempt)) this.rateLimitAttempts += 1;
    if (isTimedOut(attempt)) this.timeoutAttempts += 1;
    if (attempt.budgetExhausted) this.budgetExhaustions += 1;
    if (attempt.latencyMs !== undefined && Number.isFinite(attempt.latencyMs)) this.latencyMs.push(Math.max(0, attempt.latencyMs));
  }

  public recordTerminal(headroomRatio?: number): void {
    this.terminalSources += 1;
    if (headroomRatio !== undefined && Number.isFinite(headroomRatio)) {
      this.headroomRatio = Math.max(0, Math.min(1, headroomRatio));
    }
  }

  public recordBudgetExhaustion(): void {
    this.budgetExhaustions += 1;
  }

  public snapshot(): HealthWindowSnapshot {
    const denominator = this.providerAttempts;
    return {
      terminalSources: this.terminalSources,
      providerAttempts: denominator,
      retryAttempts: this.retryAttempts,
      rateLimitAttempts: this.rateLimitAttempts,
      timeoutAttempts: this.timeoutAttempts,
      budgetExhaustions: this.budgetExhaustions,
      latencyMs: [...this.latencyMs],
      retryRate: denominator ? this.retryAttempts / denominator : 0,
      rateLimitRate: denominator ? this.rateLimitAttempts / denominator : 0,
      p95LatencyMs: percentile(this.latencyMs, 0.95),
      headroomRatio: this.headroomRatio,
    };
  }

  public reset(): void {
    this.terminalSources = 0;
    this.providerAttempts = 0;
    this.retryAttempts = 0;
    this.rateLimitAttempts = 0;
    this.timeoutAttempts = 0;
    this.budgetExhaustions = 0;
    this.latencyMs.length = 0;
    this.headroomRatio = 1;
  }
}

export interface CriticalPathInterval {
  readonly startMs: number;
  readonly endMs: number;
}

/** Union duration of serial-only intervals, counting overlap once. */
export function serialOnlyDuration(
  intervals: readonly CriticalPathInterval[],
  usefulIntervals: readonly CriticalPathInterval[] = [],
): number {
  const ordered = intervals
    .filter(interval => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs)
    .map(interval => ({ startMs: interval.startMs, endMs: interval.endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let current = ordered[0];
  if (!current) return 0;
  for (const interval of ordered.slice(1)) {
    if (interval.startMs <= current.endMs) {
      current = { startMs: current.startMs, endMs: Math.max(current.endMs, interval.endMs) };
    } else {
      total += current.endMs - current.startMs;
      current = interval;
    }
  }
  const serialUnion = total + current.endMs - current.startMs;
  if (usefulIntervals.length === 0) return serialUnion;
  const useful = usefulIntervals
    .filter(interval => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs)
    .map(interval => ({ startMs: interval.startMs, endMs: interval.endMs }))
    .sort((left, right) => left.startMs - right.startMs);
  // Useful intervals can overlap each other; subtracting each separately
  // would double-count. Recurse over their union against the serial union.
  const mergedUseful: CriticalPathInterval[] = [];
  for (const interval of useful) {
    const previous = mergedUseful[mergedUseful.length - 1];
    if (previous && interval.startMs <= previous.endMs) {
      mergedUseful[mergedUseful.length - 1] = { startMs: previous.startMs, endMs: Math.max(previous.endMs, interval.endMs) };
    } else mergedUseful.push(interval);
  }
  let overlap = 0;
  const mergedSerial: CriticalPathInterval[] = [];
  for (const interval of ordered) {
    const previous = mergedSerial[mergedSerial.length - 1];
    if (previous && interval.startMs <= previous.endMs) {
      mergedSerial[mergedSerial.length - 1] = { startMs: previous.startMs, endMs: Math.max(previous.endMs, interval.endMs) };
    } else mergedSerial.push(interval);
  }
  for (const usefulInterval of mergedUseful) {
    for (const serial of mergedSerial) {
      overlap += Math.max(0, Math.min(usefulInterval.endMs, serial.endMs) - Math.max(usefulInterval.startMs, serial.startMs));
    }
  }
  return Math.max(0, serialUnion - overlap);
}

export function serialFraction(
  intervals: readonly CriticalPathInterval[],
  endToEndWallTimeMs: number,
  usefulIntervals: readonly CriticalPathInterval[] = [],
): number {
  if (!Number.isFinite(endToEndWallTimeMs) || endToEndWallTimeMs <= 0) return 0;
  return Math.min(1, serialOnlyDuration(intervals, usefulIntervals) / endToEndWallTimeMs);
}

export const computeSerialFraction = serialFraction;

export const calculateSerialFraction = serialFraction;
