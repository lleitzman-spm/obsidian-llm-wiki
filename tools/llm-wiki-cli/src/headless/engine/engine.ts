import { buildArtifactPartitions, canonicalPartitionKey, orderReadyPartitions, partitionKeyString } from './partition';
import type {
  ArtifactData,
  CandidatePartition,
  CandidatePlan,
  MapJob,
  MapReduceInput,
  MapResult,
  PartitionPlan,
  SourceRecord,
} from './types';

export class DuplicateSourceError extends Error {
  public constructor(sourceId: string) {
    super(`duplicate source id: ${sourceId}`);
    this.name = 'DuplicateSourceError';
  }
}

export class DuplicateLaneError extends Error {
  public constructor(laneId: string) {
    super(`duplicate lane id: ${laneId}`);
    this.name = 'DuplicateLaneError';
  }
}

export class ArtifactScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactScopeError';
  }
}

export class IncompleteMapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IncompleteMapError';
  }
}

export class ReducerCollisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReducerCollisionError';
  }
}

function freezeSource(source: SourceRecord): Readonly<SourceRecord> {
  return Object.freeze({ ...source });
}

function assertUniqueSources(sources: readonly SourceRecord[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.sourceId)) throw new DuplicateSourceError(source.sourceId);
    seen.add(source.sourceId);
  }
}

function assertUniqueLanes(input: MapReduceInput): void {
  const lanes = input.laneIds;
  if (lanes === undefined) {
    const seen = new Set<string>();
    for (const source of input.sources) {
      if (source.laneId === undefined) continue;
      if (seen.has(source.laneId)) throw new DuplicateLaneError(source.laneId);
      seen.add(source.laneId);
    }
    return;
  }
  if (lanes.length !== input.sources.length) throw new Error('lane ids must match source count');
  const seen = new Set<string>();
  for (const laneId of lanes) {
    if (seen.has(laneId)) throw new DuplicateLaneError(laneId);
    seen.add(laneId);
  }
}

function normalizeArtifact(
  source: Readonly<SourceRecord>,
  runId: string,
  artifact: ArtifactData,
): ArtifactData {
  if (artifact.sourceId !== source.sourceId) {
    throw new ArtifactScopeError(`artifact ${artifact.artifactId} escaped source ${source.sourceId}`);
  }
  if (artifact.runId !== undefined && artifact.runId !== runId) {
    throw new ArtifactScopeError(`artifact ${artifact.artifactId} escaped map run ${runId}`);
  }
  const key = canonicalPartitionKey(artifact.pageType, artifact.label);
  return Object.freeze({
    ...artifact,
    pageType: key[0],
    normalizedLabel: key[1],
    runId,
    data: Object.freeze({ ...artifact.data }),
  });
}

async function mapOneSource(
  source: Readonly<SourceRecord>,
  input: MapReduceInput,
  runId: string,
  runState: { ran: boolean },
): Promise<MapResult> {
  if (runState.ran) throw new Error(`source ${source.sourceId} was scheduled more than once`);
  runState.ran = true;
  input.contracts.assertSource(source);
  const sourceProvenance = input.provenance.sourceRef(source);
  const produced = await input.provider.map(source);
  const artifactIds = new Set<string>();
  const artifacts = produced.map(raw => {
    const normalized = normalizeArtifact(source, runId, raw);
    if (!normalized.artifactId) throw new ArtifactScopeError('artifact id must not be empty');
    if (artifactIds.has(normalized.artifactId)) {
      throw new ReducerCollisionError(`duplicate artifact id in source ${source.sourceId}: ${normalized.artifactId}`);
    }
    artifactIds.add(normalized.artifactId);
    const withProvenance = Object.freeze({
      ...normalized,
      provenance: Object.freeze({
        source: sourceProvenance,
        artifact: input.provenance.artifactRef(normalized),
      }),
    });
    input.contracts.assertArtifact(withProvenance);
    return withProvenance;
  });
  return Object.freeze({
    sourceId: source.sourceId,
    runId,
    artifacts: Object.freeze(artifacts),
  });
}

function assertMapResults(
  sources: readonly Readonly<SourceRecord>[],
  runIds: ReadonlyMap<string, string>,
  results: readonly MapResult[],
): void {
  const sourceIds = new Set(sources.map(source => source.sourceId));
  const seenSources = new Set<string>();
  const seenArtifacts = new Set<string>();
  for (const result of results) {
    if (!sourceIds.has(result.sourceId)) {
      throw new IncompleteMapError(`map result references unknown source: ${result.sourceId}`);
    }
    if (seenSources.has(result.sourceId)) {
      throw new IncompleteMapError(`duplicate map result: ${result.sourceId}`);
    }
    const expectedRunId = runIds.get(result.sourceId);
    if (expectedRunId !== result.runId) {
      throw new ArtifactScopeError(`map result for ${result.sourceId} escaped map run`);
    }
    seenSources.add(result.sourceId);
    for (const artifact of result.artifacts) {
      if (artifact.sourceId !== result.sourceId || artifact.runId !== result.runId) {
        throw new ArtifactScopeError(`artifact ${artifact.artifactId} escaped map result ${result.sourceId}`);
      }
      if (seenArtifacts.has(artifact.artifactId)) {
        throw new ReducerCollisionError(`duplicate artifact id: ${artifact.artifactId}`);
      }
      seenArtifacts.add(artifact.artifactId);
    }
  }
  for (const source of sources) {
    if (!seenSources.has(source.sourceId)) throw new IncompleteMapError(`missing map result for source: ${source.sourceId}`);
  }
}

function reduce(
  partitions: readonly PartitionPlan[],
  results: readonly MapResult[],
  receipt: CandidatePlan['receipt'],
): CandidatePlan {
  const artifactsById = new Map<string, ArtifactData>();
  for (const result of results) {
    for (const artifact of result.artifacts) artifactsById.set(artifact.artifactId, artifact);
  }
  const artifacts: ArtifactData[] = [];
  const candidates: CandidatePartition[] = partitions.map(partition => {
    const partitionArtifacts = partition.artifactIds.map(artifactId => {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) throw new IncompleteMapError(`missing artifact for partition ${partition.keyString}: ${artifactId}`);
      if (partitionKeyString(canonicalPartitionKey(artifact.pageType, artifact.normalizedLabel ?? artifact.label)) !== partition.keyString) {
        throw new ReducerCollisionError(`artifact ${artifactId} crossed reducer fence`);
      }
      return artifact;
    }).sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.artifactId.localeCompare(right.artifactId),
    );
    artifacts.push(...partitionArtifacts);
    return Object.freeze({
      key: partition.key,
      keyString: partition.keyString,
      ownerId: partition.ownerId,
      fence: partition.fence,
      sourceIds: partition.sourceIds,
      artifactIds: Object.freeze(partitionArtifacts.map(artifact => artifact.artifactId)),
    });
  });
  return Object.freeze({
    complete: true,
    partitions: Object.freeze(candidates),
    artifacts: Object.freeze(artifacts),
    receipt,
  });
}

export async function executeMapReduce(input: MapReduceInput): Promise<CandidatePlan> {
  assertUniqueSources(input.sources);
  assertUniqueLanes(input);
  const sources = input.sources.map(freezeSource);
  const runIds = new Map<string, string>();
  const jobs: MapJob[] = [...sources]
    .sort((left, right) =>
      (left.readyAt ?? 0) - (right.readyAt ?? 0) || left.sourceId.localeCompare(right.sourceId),
    )
    .map(source => {
      const runId = `${source.sourceId}:map:1`;
      runIds.set(source.sourceId, runId);
      const runState = { ran: false };
      return Object.freeze({
        source,
        runId,
        run: () => mapOneSource(source, input, runId, runState),
      });
    });
  // The scheduler controls concurrency but receives a deterministic oldest-ready
  // order and cannot change the one-source job boundary.
  const results = await input.scheduler.schedule(Object.freeze(jobs));
  assertMapResults(sources, runIds, results);

  const sourceReadyAt = new Map(sources.map(source => [source.sourceId, source.readyAt ?? 0]));
  const shuffled = results.flatMap(result => result.artifacts.map(artifact => ({
    sourceId: result.sourceId,
    artifactId: artifact.artifactId,
    pageType: artifact.pageType,
    normalizedLabel: artifact.normalizedLabel ?? normalizeArtifact(
      sources.find(source => source.sourceId === result.sourceId) as Readonly<SourceRecord>,
      result.runId,
      artifact,
    ).normalizedLabel as string,
    readyAt: sourceReadyAt.get(result.sourceId) ?? 0,
  })));
  const { partitions, receipt } = buildArtifactPartitions(shuffled, input.workerIds);
  const orderedPartitions = orderReadyPartitions(partitions);
  const plan = reduce(orderedPartitions, results, receipt);
  input.contracts.assertPlan(plan);
  return plan;
}
