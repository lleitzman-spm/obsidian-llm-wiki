import { budgetHeadroomRatio } from './budgets';
import { discoverCapacitySync, discoverCapacity } from './capacity';
import { HealthWindow, parseRetryAfter } from './metrics';
import type {
  AdaptiveConcurrencyOptions,
  CapacitySource,
  ProviderAttempt,
  ReadySource,
  SchedulerSnapshot,
  TerminalSource,
} from './types';
import type { ReadySourceQueue } from './queue';

const START_CONCURRENCY = 4;
const HEALTH_WINDOW_SIZE = 8;
const HEALTHY_RETRY_RATE = 0.05;
const HEALTHY_HEADROOM = 0.2;
const DEFAULT_COOLDOWN_MS = 1_000;
const COOLDOWN_CAP_MS = 60_000;

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Provider-neutral AIMD controller for source-isolated map work. */
export class AdaptiveConcurrencyController {
  private capacity: number;
  private readonly capacitySource?: CapacitySource;
  private readonly clock: () => number;
  private readonly calibrationP95Ms: number;
  private readonly cooldownBaseMs: number;
  private readonly cooldownCapMs: number;
  private readonly budgets: NonNullable<AdaptiveConcurrencyOptions['budgets']>;
  private concurrency = 0;
  private readySources = 0;
  private cooldownUntil = 0;
  private pressureStreak = 0;
  private readonly activeSources = new Set<string>();
  private readonly laneReleases = new Map<string, () => void>();
  private readonly health = new HealthWindow();
  private windowPressureApplied = false;
  private started = false;

  public constructor(options: AdaptiveConcurrencyOptions = {}) {
    this.capacitySource = options.capacity;
    let initialCapacity: number | undefined;
    if (typeof options.capacity === 'number') initialCapacity = options.capacity;
    else if (typeof options.capacity === 'function') {
      const observed = options.capacity();
      if (typeof observed === 'number') initialCapacity = observed;
    }
    this.capacity = discoverCapacitySync(initialCapacity).capacity;
    this.clock = options.clock ?? (() => Date.now());
    this.calibrationP95Ms = options.calibrationP95Ms !== undefined && options.calibrationP95Ms > 0
      ? options.calibrationP95Ms
      : Number.POSITIVE_INFINITY;
    this.cooldownBaseMs = Math.max(0, options.cooldownBaseMs ?? DEFAULT_COOLDOWN_MS);
    this.cooldownCapMs = Math.min(COOLDOWN_CAP_MS, Math.max(0, options.cooldownCapMs ?? COOLDOWN_CAP_MS));
    this.budgets = options.budgets ?? {};
    this.readySources = positiveInteger(options.initialReadySources ?? 0, 0);
    this.concurrency = this.initialConcurrency(options.initialConcurrency);
  }

  private initialConcurrency(initial?: number): number {
    if (initial !== undefined) return Math.min(this.capacity, this.readySources, Math.max(0, Math.floor(initial)));
    return Math.min(START_CONCURRENCY, this.readySources, this.capacity);
  }

  /** Refresh runtime capacity before a dispatch turn. */
  public async refreshCapacity(): Promise<number> {
    const discovered = await discoverCapacity(this.capacitySource);
    this.capacity = discovered.capacity;
    this.concurrency = Math.min(this.concurrency, this.capacity, this.readySources);
    return this.capacity;
  }

  public setReadySources(readySources: number): number {
    const wasStarted = this.started;
    this.readySources = positiveInteger(readySources, 0);
    if (!wasStarted && this.readySources > 0) {
      this.concurrency = this.initialConcurrency();
      this.started = true;
    } else {
      this.concurrency = Math.min(this.concurrency, this.readySources, this.capacity);
    }
    return this.concurrency;
  }

  public start(readySources: number): number {
    this.started = true;
    this.readySources = positiveInteger(readySources, 0);
    this.concurrency = this.initialConcurrency();
    return this.concurrency;
  }

  public get currentConcurrency(): number {
    return this.concurrency;
  }

  public get discoveredCapacity(): number {
    return this.capacity;
  }

  public get isCoolingDown(): boolean {
    return this.clock() < this.cooldownUntil;
  }

  public get activeLaneIds(): readonly string[] {
    return [...this.activeSources];
  }

  public snapshot(): SchedulerSnapshot {
    return {
      capacity: this.capacity,
      concurrency: this.concurrency,
      readySources: this.readySources,
      activeLanes: this.activeSources.size,
      paused: this.isCoolingDown,
      cooldownUntil: this.cooldownUntil,
      window: this.health.snapshot(),
    };
  }

  public canDispatch(): boolean {
    return !this.isCoolingDown && this.concurrency > this.activeSources.size && this.readySources > this.activeSources.size;
  }

  /** Number of lanes that can be started now, bounded by observed capacity. */
  public dispatchSlots(): number {
    if (!this.canDispatch()) return 0;
    const semaphoreAvailable = this.budgets.semaphore?.available ?? this.capacity;
    return Math.max(0, Math.min(
      this.concurrency - this.activeSources.size,
      this.capacity - this.activeSources.size,
      this.readySources - this.activeSources.size,
      semaphoreAvailable,
    ));
  }

  /** Reserve one globally-semaphored lane; duplicate source IDs are rejected. */
  public tryStartLane(sourceId: string): (() => void) | undefined {
    if (!sourceId || this.activeSources.has(sourceId) || this.dispatchSlots() <= 0) return undefined;
    const releaseSemaphore = this.budgets.semaphore?.tryAcquire();
    if (this.budgets.semaphore && !releaseSemaphore) return undefined;
    this.activeSources.add(sourceId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseSemaphore?.();
      this.activeSources.delete(sourceId);
    };
    this.laneReleases.set(sourceId, release);
    return release;
  }

  public completeLane(sourceId: string): boolean {
    const release = this.laneReleases.get(sourceId);
    if (release) release();
    else return this.activeSources.delete(sourceId);
    this.laneReleases.delete(sourceId);
    return true;
  }

  /**
   * Dispatch one oldest-ready turn. The queue itself prevents duplicate IDs;
   * this controller additionally guards active IDs for callers using custom queues.
   */
  public async dispatch<T>(queue: ReadySourceQueue, worker: (source: ReadySource) => Promise<T> | T): Promise<PromiseSettledResult<T>[]> {
    const sources = queue.take(this.dispatchSlots());
    const runs = sources.map(async source => {
      const release = this.tryStartLane(source.id);
      if (!release) {
        queue.fail(source.id, true);
        throw new Error(`lane unavailable for source ${source.id}`);
      }
      try {
        return await worker(source);
      } finally {
        this.completeLane(source.id);
        queue.complete(source.id);
      }
    });
    return Promise.allSettled(runs);
  }

  /** Record every network call, including typed-output calls and recovered retries. */
  public recordProviderAttempt(attempt: ProviderAttempt): void {
    this.health.recordProviderAttempt(attempt);
    if (attempt.rateLimited || attempt.statusCode === 429 || attempt.timedOut || attempt.budgetExhausted) {
      const retryAfter = parseRetryAfter(attempt.retryAfterMs ?? attempt.retryAfter, this.clock());
      this.applyPressure(retryAfter);
    }
  }

  public onProviderAttempt(attempt: ProviderAttempt): void {
    this.recordProviderAttempt(attempt);
  }

  public recordBudgetExhaustion(retryAfter?: string | number): void {
    this.health.recordBudgetExhaustion();
    this.applyPressure(parseRetryAfter(retryAfter, this.clock()));
  }

  /** Mark one source terminal; the eighth source closes and evaluates a window. */
  public recordTerminalSource(source: TerminalSource): boolean {
    this.completeLane(source.sourceId);
    const headroom = source.headroomRatio ?? budgetHeadroomRatio(this.budgets.tokenBudget);
    this.health.recordTerminal(headroom);
    if (this.health.snapshot().terminalSources < HEALTH_WINDOW_SIZE) return false;
    this.evaluateWindow();
    return true;
  }

  public recordSourceTerminal(source: TerminalSource): boolean {
    return this.recordTerminalSource(source);
  }

  public onTerminalSource(source: TerminalSource): boolean {
    return this.recordTerminalSource(source);
  }

  private applyPressure(retryAfterMs?: number): void {
    this.windowPressureApplied = true;
    this.pressureStreak += 1;
    this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
    const exponential = this.cooldownBaseMs * (2 ** Math.max(0, this.pressureStreak - 1));
    const delay = Math.min(this.cooldownCapMs, Math.max(exponential, retryAfterMs ?? 0));
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + delay);
  }

  private evaluateWindow(): void {
    const snapshot = this.health.snapshot();
    const p95 = snapshot.p95LatencyMs;
    const pressure = snapshot.budgetExhaustions > 0
      || snapshot.rateLimitAttempts > 0
      || snapshot.timeoutAttempts > 0
      || (Number.isFinite(this.calibrationP95Ms) && p95 > this.calibrationP95Ms * 2);
    const healthy = !pressure
      && snapshot.retryRate <= HEALTHY_RETRY_RATE
      && (!Number.isFinite(this.calibrationP95Ms) || p95 <= this.calibrationP95Ms * 1.5)
      && snapshot.headroomRatio >= HEALTHY_HEADROOM;
    if (pressure) {
      if (!this.windowPressureApplied) this.applyPressure();
    } else if (healthy) {
      this.concurrency = Math.min(this.capacity, this.readySources || this.concurrency, this.concurrency + Math.max(1, Math.floor(this.concurrency / 4)));
      this.pressureStreak = 0;
    }
    this.health.reset();
    this.windowPressureApplied = false;
  }
}

export { HEALTHY_HEADROOM, HEALTHY_RETRY_RATE, HEALTH_WINDOW_SIZE, START_CONCURRENCY };
export const AdaptiveScheduler = AdaptiveConcurrencyController;
