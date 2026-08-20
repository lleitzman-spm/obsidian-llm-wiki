import {
  AdaptiveConcurrencyController,
  HealthWindow,
  ReadySourceQueue,
  Semaphore,
  TokenBucket,
  serialFraction,
} from '../../../../../tools/llm-wiki-cli/src/headless/scheduler';

describe('headless adaptive scheduler', () => {
  it('starts at min(4, ready, discovered capacity) and grows additively after eight healthy terminals', () => {
    const scheduler = new AdaptiveConcurrencyController({ capacity: 20, initialReadySources: 100, calibrationP95Ms: 100 });
    expect(scheduler.currentConcurrency).toBe(4);
    for (let index = 0; index < 8; index += 1) {
      scheduler.recordProviderAttempt({ sourceId: `source-${index}`, latencyMs: 100 });
      expect(scheduler.recordTerminalSource({ sourceId: `source-${index}`, headroomRatio: 0.5 })).toBe(index === 7);
    }
    expect(scheduler.currentConcurrency).toBe(5);
  });

  it('uses all provider-call attempts as the retry denominator, including repeated calls', () => {
    const window = new HealthWindow();
    for (let index = 0; index < 19; index += 1) window.recordProviderAttempt({ latencyMs: 10 });
    window.recordProviderAttempt({ latencyMs: 10, retryAttempt: true });
    const snapshot = window.snapshot();
    expect(snapshot.providerAttempts).toBe(20);
    expect(snapshot.retryAttempts).toBe(1);
    expect(snapshot.retryRate).toBe(0.05);
    expect(snapshot.rateLimitRate).toBe(0);
  });

  it('halves immediately on 429, pauses, and honors Retry-After', () => {
    let now = 1_000;
    const scheduler = new AdaptiveConcurrencyController({ capacity: 12, initialReadySources: 12, clock: () => now });
    scheduler.recordProviderAttempt({ statusCode: 429, retryAfter: '3' });
    expect(scheduler.currentConcurrency).toBe(2);
    expect(scheduler.canDispatch()).toBe(false);
    expect(scheduler.snapshot().cooldownUntil).toBe(4_000);
    now = 4_000;
    expect(scheduler.canDispatch()).toBe(true);
  });

  it('keeps ready sources oldest-first, within one active domain, without duplicate lanes', () => {
    const queue = new ReadySourceQueue();
    expect(queue.enqueue({ id: 'new-domain', domain: 'b', readyAt: 1 })).toBe(true);
    expect(queue.enqueue({ id: 'old-2', domain: 'a', readyAt: 3 })).toBe(true);
    expect(queue.enqueue({ id: 'old-1', domain: 'a', readyAt: 2 })).toBe(true);
    expect(queue.enqueue({ id: 'old-1', domain: 'a', readyAt: 2 })).toBe(false);
    expect(queue.take(2).map(source => source.id)).toEqual(['new-domain']);
    expect(queue.take(2, 'a').map(source => source.id)).toEqual(['old-1', 'old-2']);
  });

  it('provides shared semaphore and token-budget backpressure', async () => {
    const semaphore = new Semaphore(1);
    const first = semaphore.tryAcquire();
    expect(first).toBeDefined();
    expect(semaphore.tryAcquire()).toBeUndefined();
    first?.();
    const tokenBudget = new TokenBucket(100);
    const release = await tokenBudget.reserve(70);
    expect(tokenBudget.snapshot().headroomRatio).toBeCloseTo(0.3);
    release();
    expect(tokenBudget.available).toBe(100);
  });

  it('counts overlapping serial intervals once and computes the bounded fraction', () => {
    expect(serialFraction([
      { startMs: 0, endMs: 10 },
      { startMs: 5, endMs: 20 },
      { startMs: 30, endMs: 40 },
    ], 100)).toBe(0.3);
  });
});
import { describe, expect, it } from 'vitest';
