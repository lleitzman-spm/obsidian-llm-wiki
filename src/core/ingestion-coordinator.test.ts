import { describe, expect, it, vi } from 'vitest';
import {
  getIngestionLeaseSnapshot,
  INGESTION_LEASE_MAX_ACTIVE,
  withIngestionLease,
} from './ingestion-coordinator';
import type { IngestionLeaseContext } from './ingestion-coordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

describe('withIngestionLease', () => {
  it('runs concurrent calls FIFO and never exceeds the observable active limit', async () => {
    const key = {};
    const first = deferred();
    const order: string[] = [];
    let observedMaximum = 0;

    const observe = () => {
      observedMaximum = Math.max(observedMaximum, getIngestionLeaseSnapshot(key).activeCount);
    };
    const run1 = withIngestionLease(key, async () => {
      order.push('first');
      observe();
      await first.promise;
      return 1;
    });
    const run2 = withIngestionLease(key, async () => {
      order.push('second');
      observe();
      return 2;
    });
    const run3 = withIngestionLease(key, async () => {
      order.push('third');
      observe();
      return 3;
    });

    await vi.waitFor(() => expect(getIngestionLeaseSnapshot(key)).toMatchObject({
      activeCount: 1,
      queuedCount: 2,
      maxActive: INGESTION_LEASE_MAX_ACTIVE,
    }));
    first.resolve();
    await expect(Promise.all([run1, run2, run3])).resolves.toEqual([1, 2, 3]);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(observedMaximum).toBe(1);
    expect(getIngestionLeaseSnapshot(key)).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });

  it('cancels a queued ticket without allowing later work to overtake the holder', async () => {
    const key = {};
    const first = deferred();
    const order: string[] = [];
    const run1 = withIngestionLease(key, async () => {
      order.push('first');
      await first.promise;
    });
    await vi.waitFor(() => expect(getIngestionLeaseSnapshot(key).activeCount).toBe(1));

    const controller = new AbortController();
    const cancelled = withIngestionLease(key, async () => {
      order.push('cancelled');
    }, { signal: controller.signal });
    const later = withIngestionLease(key, async () => {
      order.push('later');
    });
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(order).toEqual(['first']);
    first.resolve();
    await Promise.all([run1, later]);
    expect(order).toEqual(['first', 'later']);
  });

  it('releases after rejection and rejects synchronous non-reentrant nesting', async () => {
    const key = {};
    await expect(withIngestionLease(key, async () => {
      throw new Error('failed ingest');
    })).rejects.toThrow('failed ingest');

    await expect(withIngestionLease(key, async () =>
      withIngestionLease(key, async () => 'nested'),
    )).rejects.toThrow('non-reentrant');

    await expect(withIngestionLease(key, async () => 'after failure')).resolves.toBe('after failure');
    expect(getIngestionLeaseSnapshot(key)).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });

  it('rejects re-entry after an await when the owner carries its context token', async () => {
    const key = {};
    await expect(withIngestionLease(key, async (_signal, context) => {
      await Promise.resolve();
      await withIngestionLease(key, async () => 'nested', { context });
    })).rejects.toThrow('non-reentrant');

    await expect(withIngestionLease(key, async () => 'released')).resolves.toBe('released');
  });

  it('rejects released and structurally forged contexts before they can enqueue', async () => {
    const key = {};
    let releasedContext!: IngestionLeaseContext;
    await withIngestionLease(key, async (_signal, context) => {
      releasedContext = context!;
    });

    const forgedContext = {
      engineKey: key,
      token: releasedContext.token,
    } as typeof releasedContext;

    await expect(withIngestionLease(key, async () => 'stale', { context: releasedContext }))
      .rejects.toThrow('stale, forged, or not active');
    await expect(withIngestionLease(key, async () => 'forged', { context: forgedContext }))
      .rejects.toThrow('stale, forged, or not active');
    expect(getIngestionLeaseSnapshot(key)).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });

  it('revokes an active context as soon as its lease signal is cancelled', async () => {
    const key = {};
    const controller = new AbortController();
    const entered = deferred();
    const blocker = deferred();
    let context!: IngestionLeaseContext;
    const run = withIngestionLease(key, async (_signal, ownerContext) => {
      context = ownerContext!;
      entered.resolve();
      await blocker.promise;
    }, { signal: controller.signal });
    await entered.promise;

    controller.abort();
    await expect(withIngestionLease(key, async () => 'stale', { context }))
      .rejects.toThrow('stale, forged, or not active');

    blocker.resolve();
    await run;
  });
});
