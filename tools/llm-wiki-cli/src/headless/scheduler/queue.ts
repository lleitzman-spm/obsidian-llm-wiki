import type { ReadySource } from './types';

interface QueuedSource extends ReadySource {
  readonly sequence: number;
}

function isReady(source: ReadySource): boolean {
  return source.dependenciesReady !== false;
}

/**
 * A deduplicating, oldest-first queue. A domain is selected from the oldest
 * eligible item and only that domain is drained during the dispatch turn;
 * this prevents a later domain from overtaking an active ordered domain.
 */
export class ReadySourceQueue {
  private readonly queued = new Map<string, QueuedSource>();
  private readonly active = new Set<string>();
  private sequence = 0;

  public enqueue(source: ReadySource): boolean {
    if (!source.id || this.queued.has(source.id) || this.active.has(source.id)) return false;
    this.queued.set(source.id, { ...source, sequence: this.sequence++ });
    return true;
  }

  public enqueueMany(sources: readonly ReadySource[]): number {
    let added = 0;
    for (const source of sources) if (this.enqueue(source)) added += 1;
    return added;
  }

  public get readyCount(): number {
    return [...this.queued.values()].filter(isReady).length;
  }

  public get activeCount(): number {
    return this.active.size;
  }

  public has(id: string): boolean {
    return this.queued.has(id) || this.active.has(id);
  }

  public get activeIds(): readonly string[] {
    return [...this.active];
  }

  public peek(): ReadySource | undefined {
    return this.orderedEligible()[0];
  }

  /** Take up to limit sources from the oldest ready domain and mark them active. */
  public take(limit: number, activeDomain?: string): ReadySource[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const eligible = this.orderedEligible();
    const domain = activeDomain ?? eligible[0]?.domain;
    const selected = eligible.filter(source => source.domain === domain).slice(0, limit);
    for (const source of selected) {
      this.queued.delete(source.id);
      this.active.add(source.id);
    }
    return selected;
  }

  public complete(id: string): boolean {
    return this.active.delete(id);
  }

  public fail(id: string, requeue = false): boolean {
    const wasActive = this.active.delete(id);
    if (wasActive && requeue) {
      // Requeueing receives a fresh sequence and is therefore fair to work
      // that has been ready longer than the failed attempt.
      this.enqueue({ id });
    }
    return wasActive;
  }

  public clear(): void {
    this.queued.clear();
    this.active.clear();
  }

  private orderedEligible(): QueuedSource[] {
    return [...this.queued.values()]
      .filter(isReady)
      .sort((left, right) => {
        const leftTime = left.readyAt ?? Number.NEGATIVE_INFINITY;
        const rightTime = right.readyAt ?? Number.NEGATIVE_INFINITY;
        return leftTime - rightTime || left.sequence - right.sequence;
      });
  }
}

export function oldestReady(queue: ReadySourceQueue): ReadySource | undefined {
  return queue.peek();
}

export const OldestReadyQueue = ReadySourceQueue;
