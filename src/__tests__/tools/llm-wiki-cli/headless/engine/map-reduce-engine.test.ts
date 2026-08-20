import { describe, expect, it, vi } from 'vitest';

import {
  DuplicateLaneError,
  ArtifactScopeError,
  DuplicateSourceError,
  executeMapReduce,
  IncompleteMapError,
  ReducerCollisionError,
  type ArtifactData,
  type ContractPort,
  type ProvenancePort,
  type ProviderPort,
  type SchedulerPort,
  type SourceRecord,
} from '../../../../../../tools/llm-wiki-cli/src/headless/engine';

const source = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  sourceId: 'source-a',
  pageType: 'Property',
  label: '  Akin   Quay  ',
  content: 'immutable source content',
  readyAt: 100,
  ...overrides,
});

const artifact = (input: SourceRecord, overrides: Partial<ArtifactData> = {}): ArtifactData => ({
  artifactId: `${input.sourceId}:artifact`,
  sourceId: input.sourceId,
  pageType: input.pageType,
  label: input.label,
  data: { value: input.content },
  ...overrides,
});

function ports(
  provider: ProviderPort,
  scheduler?: SchedulerPort,
): {
  contracts: ContractPort;
  provenance: ProvenancePort;
  provider: ProviderPort;
  scheduler: SchedulerPort;
} {
  return {
    contracts: {
      assertSource: vi.fn(),
      assertArtifact: vi.fn(),
      assertPlan: vi.fn(),
    },
    provenance: {
      sourceRef: vi.fn(input => ({ sourceId: input.sourceId })),
      artifactRef: vi.fn(input => ({ artifactId: input.artifactId, sourceId: input.sourceId })),
    },
    provider,
    scheduler: scheduler ?? {
      schedule: async jobs => Promise.all(jobs.map(job => job.run())),
    },
  };
}

describe('provider-neutral headless map/partition/reduce engine', () => {
  it('maps one frozen source into artifact data and reduces a complete candidate plan without writing', async () => {
    const input = source();
    const provider: ProviderPort = {
      map: vi.fn(async received => {
        expect(Object.isFrozen(received)).toBe(true);
        expect(Reflect.set(received, 'content', 'mutated')).toBe(false);
        return [artifact(received)];
      }),
    };
    const p = ports(provider);

    const plan = await executeMapReduce({
      sources: [input],
      workerIds: ['worker-b', 'worker-a'],
      ...p,
    });

    expect(provider.map).toHaveBeenCalledTimes(1);
    expect(provider.map).toHaveBeenCalledWith(expect.objectContaining({ sourceId: input.sourceId }));
    expect(p.provenance.sourceRef).toHaveBeenCalledTimes(1);
    expect(p.provenance.artifactRef).toHaveBeenCalledTimes(1);
    expect(p.contracts.assertPlan).toHaveBeenCalledTimes(1);
    expect(plan.complete).toBe(true);
    expect(plan.artifacts).toHaveLength(1);
    expect(plan.partitions).toHaveLength(1);
    expect(plan.partitions[0]?.artifactIds).toEqual([`${input.sourceId}:artifact`]);
    expect(plan).not.toHaveProperty('write');
  });

  it('refuses duplicate source ids before the provider or scheduler can run', async () => {
    const provider: ProviderPort = { map: vi.fn() };
    const scheduler: SchedulerPort = { schedule: vi.fn() };

    await expect(executeMapReduce({
      sources: [source(), source({ content: 'same id, second record' })],
      workerIds: ['worker-a'],
      ...ports(provider, scheduler),
    })).rejects.toBeInstanceOf(DuplicateSourceError);
    expect(provider.map).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('refuses duplicate lane ownership rather than allowing one lane to process two sources', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [artifact(input)]),
    };

    await expect(executeMapReduce({
      sources: [
        source({ sourceId: 'source-a', label: 'Alpha', readyAt: 1 }),
        source({ sourceId: 'source-b', label: 'Beta', readyAt: 2 }),
      ],
      workerIds: ['worker-a'],
      laneIds: ['lane-a', 'lane-a'],
      ...ports(provider),
    })).rejects.toBeInstanceOf(DuplicateLaneError);
    expect(provider.map).not.toHaveBeenCalled();
  });

  it('keeps identical labels separated by page type and gives each partition one deterministic owner and fence', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [artifact(input)]),
    };
    const result = await executeMapReduce({
      sources: [
        source({ sourceId: 'property-1', pageType: 'Property', label: 'Same Label' }),
        source({ sourceId: 'vendor-1', pageType: 'Vendor', label: 'same label' }),
      ],
      workerIds: ['worker-a', 'worker-b', 'worker-c'],
      ...ports(provider),
    });

    expect(result.partitions).toHaveLength(2);
    expect(result.partitions.map(partition => partition.key)).toEqual([
      ['Property', 'same label'],
      ['Vendor', 'same label'],
    ]);
    expect(new Set(result.partitions.map(partition => partition.ownerId)).size).toBeGreaterThanOrEqual(1);
    expect(result.partitions.every(partition => partition.fence.length > 0)).toBe(true);
    expect(result.receipt.digest).toBeTruthy();
    expect(result.receipt).toEqual((await executeMapReduce({
      sources: [
        source({ sourceId: 'vendor-1', pageType: 'Vendor', label: 'same label' }),
        source({ sourceId: 'property-1', pageType: 'Property', label: 'Same Label' }),
      ],
      workerIds: ['worker-a', 'worker-b', 'worker-c'],
      ...ports(provider),
    })).receipt);
  });

  it('schedules oldest-ready work first and gives the reducer every partition, including empty outputs', async () => {
    const order: string[] = [];
    const provider: ProviderPort = {
      map: vi.fn(async input => {
        order.push(input.sourceId);
        return input.sourceId === 'old' ? [artifact(input)] : [];
      }),
    };
    const scheduler: SchedulerPort = {
      schedule: async jobs => {
        for (const job of jobs) order.push(`scheduled:${job.source.sourceId}`);
        return Promise.all(jobs.map(job => job.run()));
      },
    };

    const result = await executeMapReduce({
      sources: [
        source({ sourceId: 'new', label: 'New', readyAt: 20 }),
        source({ sourceId: 'old', label: 'Old', readyAt: 10 }),
      ],
      workerIds: ['worker-a'],
      ...ports(provider, scheduler),
    });

    expect(order.slice(0, 2)).toEqual(['scheduled:old', 'scheduled:new']);
    expect(result.partitions).toHaveLength(1);
    expect(result.partitions.find(item => item.key[1] === 'new')).toBeUndefined();
    expect(result.complete).toBe(true);
  });

  it('maps one source to multiple typed keys, then shuffles each artifact to its own reducer', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [
        artifact(input, { artifactId: 'property:akin', pageType: 'Property', label: 'Akin Quay' }),
        artifact(input, { artifactId: 'vendor:atlas', pageType: 'Vendor', label: 'Atlas HVAC' }),
      ]),
    };
    const result = await executeMapReduce({
      sources: [source()],
      workerIds: ['worker-a', 'worker-b'],
      ...ports(provider),
    });

    expect(result.partitions.map(item => item.key)).toEqual([
      ['Property', 'akin quay'],
      ['Vendor', 'atlas hvac'],
    ]);
    expect(result.partitions.map(item => item.artifactIds)).toEqual([
      ['property:akin'],
      ['vendor:atlas'],
    ]);
  });

  it('shuffles artifacts from multiple sources into one shared typed key in stable source/artifact order', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [artifact(input, {
        artifactId: `${input.sourceId}:shared`,
        pageType: 'Concept',
        label: 'Shared Label',
      })]),
    };
    const result = await executeMapReduce({
      sources: [
        source({ sourceId: 'source-b', label: 'different source label', readyAt: 2 }),
        source({ sourceId: 'source-a', label: 'another source label', readyAt: 1 }),
      ],
      workerIds: ['worker-a', 'worker-b'],
      ...ports(provider),
    });

    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0]?.sourceIds).toEqual(['source-a', 'source-b']);
    expect(result.partitions[0]?.artifactIds).toEqual(['source-a:shared', 'source-b:shared']);
    expect(result.artifacts.map(item => item.artifactId)).toEqual(['source-a:shared', 'source-b:shared']);
  });

  it('refuses an artifact that claims another source', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [artifact(input, { sourceId: 'other-source' })]),
    };

    await expect(executeMapReduce({
      sources: [source()],
      workerIds: ['worker-a'],
      ...ports(provider),
    })).rejects.toBeInstanceOf(ArtifactScopeError);
  });

  it('refuses duplicate artifacts within a source and across sources', async () => {
    const duplicateWithinSource: ProviderPort = {
      map: vi.fn(async input => [artifact(input), artifact(input)]),
    };
    await expect(executeMapReduce({
      sources: [source()],
      workerIds: ['worker-a'],
      ...ports(duplicateWithinSource),
    })).rejects.toBeInstanceOf(ReducerCollisionError);

    const duplicateAcrossSources: ProviderPort = {
      map: vi.fn(async input => [artifact(input, { artifactId: 'same-artifact', pageType: 'Concept', label: 'Same' })]),
    };
    await expect(executeMapReduce({
      sources: [source({ sourceId: 'source-a' }), source({ sourceId: 'source-b' })],
      workerIds: ['worker-a'],
      ...ports(duplicateAcrossSources),
    })).rejects.toBeInstanceOf(ReducerCollisionError);
  });

  it('refuses incomplete reducer input when a scheduler drops a source result', async () => {
    const provider: ProviderPort = { map: vi.fn(async input => [artifact(input)]) };
    const scheduler: SchedulerPort = {
      schedule: async jobs => [await jobs[0]!.run()],
    };

    await expect(executeMapReduce({
      sources: [source({ sourceId: 'source-a' }), source({ sourceId: 'source-b' })],
      workerIds: ['worker-a'],
      ...ports(provider, scheduler),
    })).rejects.toBeInstanceOf(IncompleteMapError);
  });

  it('keeps same labels separate when their page types differ', async () => {
    const provider: ProviderPort = {
      map: vi.fn(async input => [artifact(input, {
        artifactId: `${input.sourceId}:typed`,
        pageType: input.sourceId === 'property' ? 'Property' : 'Vendor',
        label: 'Same Label',
      })]),
    };
    const result = await executeMapReduce({
      sources: [source({ sourceId: 'property' }), source({ sourceId: 'vendor' })],
      workerIds: ['worker-a'],
      ...ports(provider),
    });
    expect(result.partitions.map(item => item.key)).toEqual([
      ['Property', 'same label'],
      ['Vendor', 'same label'],
    ]);
  });
});
