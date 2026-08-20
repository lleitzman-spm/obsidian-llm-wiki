import * as nodeOs from 'node:os';

import type { CapacitySource, RuntimeCapacity } from './types';

function positiveCapacity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

/** Resolve a capacity source at dispatch time, so runtime changes are visible. */
export async function discoverCapacity(source?: CapacitySource): Promise<RuntimeCapacity> {
  if (source !== undefined) {
    const value = typeof source === 'function' ? await source() : source;
    return { capacity: positiveCapacity(value), source: 'configured' };
  }

  // availableParallelism is a runtime observation, not a scheduler ceiling.
  // It is deliberately queried for each discovery rather than cached globally.
  try {
    const availableParallelism = (nodeOs as typeof nodeOs & { availableParallelism?: () => number }).availableParallelism;
    if (!availableParallelism) throw new Error('availableParallelism unavailable');
    return { capacity: positiveCapacity(availableParallelism()), source: 'node.availableParallelism' };
  } catch {
    const hardwareConcurrency = (globalThis.navigator as Navigator | undefined)?.hardwareConcurrency;
    return {
      capacity: positiveCapacity(hardwareConcurrency ?? 1),
      source: hardwareConcurrency ? 'navigator.hardwareConcurrency' : 'fallback',
    };
  }
}

export function discoverCapacitySync(source?: number): RuntimeCapacity {
  if (source !== undefined) return { capacity: positiveCapacity(source), source: 'configured' };
  try {
    const availableParallelism = (nodeOs as typeof nodeOs & { availableParallelism?: () => number }).availableParallelism;
    if (!availableParallelism) throw new Error('availableParallelism unavailable');
    return { capacity: positiveCapacity(availableParallelism()), source: 'node.availableParallelism' };
  } catch {
    const hardwareConcurrency = (globalThis.navigator as Navigator | undefined)?.hardwareConcurrency;
    return {
      capacity: positiveCapacity(hardwareConcurrency ?? 1),
      source: hardwareConcurrency ? 'navigator.hardwareConcurrency' : 'fallback',
    };
  }
}

export const discoverRuntimeCapacity = discoverCapacity;
