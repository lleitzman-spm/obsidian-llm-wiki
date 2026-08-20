import type { BudgetSnapshot, GlobalSemaphore, TokenBudget } from './types';

type Waiter = { readonly weight: number; readonly resolve: (release: () => void) => void };

function integerWeight(weight: number | undefined, name: string): number {
  const value = weight ?? 1;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
/** FIFO process-wide semaphore. The scheduler may share one instance across runs. */
export class Semaphore implements GlobalSemaphore {
  public readonly capacity: number;
  private used = 0;
  private readonly waiters: Waiter[] = [];

  public constructor(capacity: number) {
    this.capacity = integerWeight(capacity, 'capacity');
  }

  public get available(): number {
    return this.capacity - this.used;
  }

  public tryAcquire(weight = 1): (() => void) | undefined {
    const requested = integerWeight(weight, 'weight');
    if (requested > this.available || this.waiters.length > 0) return undefined;
    this.used += requested;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= requested;
      this.drain();
    };
  }

  public acquire(weight = 1): Promise<() => void> {
    const requested = integerWeight(weight, 'weight');
    if (requested > this.capacity) return Promise.reject(new RangeError('weight exceeds semaphore capacity'));
    const immediate = this.tryAcquire(requested);
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => this.waiters.push({ weight: requested, resolve }));
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (next.weight > this.available) return;
      this.waiters.shift();
      this.used += next.weight;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.used -= next.weight;
        this.drain();
      });
    }
  }
}

/** FIFO token budget. Reservations are returned on release, which keeps this primitive reusable. */
export class TokenBucket implements TokenBudget {
  public readonly capacity: number;
  private used = 0;
  private readonly waiters: Waiter[] = [];

  public constructor(capacity: number) {
    this.capacity = integerWeight(capacity, 'capacity');
  }

  public get available(): number {
    return this.capacity - this.used;
  }

  public snapshot(): BudgetSnapshot {
    return { available: this.available, capacity: this.capacity, headroomRatio: this.available / this.capacity };
  }

  public tryReserve(tokens: number): (() => void) | undefined {
    const requested = integerWeight(tokens, 'tokens');
    if (requested > this.available || this.waiters.length > 0) return undefined;
    this.used += requested;
    return this.release(requested);
  }

  public reserve(tokens: number): Promise<() => void> {
    const requested = integerWeight(tokens, 'tokens');
    if (requested > this.capacity) return Promise.reject(new RangeError('tokens exceed budget capacity'));
    const immediate = this.tryReserve(requested);
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => this.waiters.push({ weight: requested, resolve }));
  }

  private release(requested: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= requested;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (next.weight > this.available) return;
      this.waiters.shift();
      this.used += next.weight;
      next.resolve(this.release(next.weight));
    }
  }
}

export function budgetHeadroomRatio(budget?: { readonly snapshot?: () => BudgetSnapshot; readonly available: number; readonly capacity: number }): number {
  if (!budget) return 1;
  const snapshot = budget.snapshot?.();
  if (snapshot?.headroomRatio !== undefined) return Math.max(0, Math.min(1, snapshot.headroomRatio));
  if (snapshot?.available !== undefined && snapshot.capacity) return Math.max(0, Math.min(1, snapshot.available / snapshot.capacity));
  return budget.capacity > 0 ? Math.max(0, Math.min(1, budget.available / budget.capacity)) : 0;
}
