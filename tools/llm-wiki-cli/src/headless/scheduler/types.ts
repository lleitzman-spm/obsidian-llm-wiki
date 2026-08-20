/** Provider-neutral contracts used by the headless map scheduler. */

export type CapacitySource = number | (() => number | Promise<number>);

export interface RuntimeCapacity {
  /** Number of useful concurrent lanes currently available to this run. */
  readonly capacity: number;
  /** Where the value came from, useful for diagnostics and receipts. */
  readonly source?: string;
}

export interface ReadySource {
  readonly id: string;
  /** Lower values are older. Omitted values retain enqueue order. */
  readonly readyAt?: number;
  /** Sources in a domain are kept together for ordered-domain fairness. */
  readonly domain?: string;
  /** A coordinator may make a source ineligible without removing it. */
  readonly dependenciesReady?: boolean;
}

export interface ProviderAttempt {
  readonly sourceId?: string;
  readonly provider?: string;
  readonly statusCode?: number;
  readonly timedOut?: boolean;
  readonly retryAttempt?: boolean;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly billedTokens?: number;
  readonly retryAfterMs?: number;
  readonly retryAfter?: string | number;
  readonly budgetExhausted?: boolean;
  /** Optional explicit marker for adapters that do not expose a status code. */
  readonly rateLimited?: boolean;
}

export interface TerminalSource {
  readonly sourceId: string;
  readonly success?: boolean;
  readonly status?: 'success' | 'failed' | 'cancelled';
  /** Headroom measured after the source became terminal. */
  readonly headroomRatio?: number;
}

export interface BudgetSnapshot {
  readonly available?: number;
  readonly capacity?: number;
  /** A direct ratio is useful for token buckets with multiple dimensions. */
  readonly headroomRatio?: number;
}

export interface GlobalSemaphore {
  readonly capacity: number;
  readonly available: number;
  tryAcquire(weight?: number): (() => void) | undefined;
  acquire(weight?: number): Promise<() => void>;
}

export interface TokenBudget {
  readonly capacity: number;
  readonly available: number;
  tryReserve(tokens: number): (() => void) | undefined;
  reserve(tokens: number): Promise<() => void>;
  snapshot(): BudgetSnapshot;
}

export interface SchedulerBudgets {
  readonly semaphore?: GlobalSemaphore;
  readonly tokenBudget?: TokenBudget;
}

export interface AdaptiveConcurrencyOptions {
  /** A number or a runtime-discovered callback; no ceiling is baked in. */
  readonly capacity?: CapacitySource;
  readonly initialReadySources?: number;
  readonly initialConcurrency?: number;
  readonly calibrationP95Ms?: number;
  readonly clock?: () => number;
  readonly cooldownBaseMs?: number;
  readonly cooldownCapMs?: number;
  readonly budgets?: SchedulerBudgets;
}

export interface SchedulerSnapshot {
  readonly capacity: number;
  readonly concurrency: number;
  readonly readySources: number;
  readonly activeLanes: number;
  readonly paused: boolean;
  readonly cooldownUntil: number;
  readonly window: HealthWindowSnapshot;
}

export interface HealthWindowSnapshot {
  readonly terminalSources: number;
  readonly providerAttempts: number;
  readonly retryAttempts: number;
  readonly rateLimitAttempts: number;
  readonly timeoutAttempts: number;
  readonly budgetExhaustions: number;
  readonly latencyMs: readonly number[];
  readonly retryRate: number;
  readonly rateLimitRate: number;
  readonly p95LatencyMs: number;
  readonly headroomRatio: number;
}
