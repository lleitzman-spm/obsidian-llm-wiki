import type { PartitionPlan, PartitionReceipt } from './types';

const SEPARATOR = '\u001f';

export interface PartitionInput {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly pageType: string;
  readonly normalizedLabel: string;
  readonly readyAt: number;
}

export function normalizeLabel(label: string): string {
  return label.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function canonicalPartitionKey(pageType: string, label: string): readonly [string, string] {
  // `page_type` is a typed discriminator, not a display label. Preserve its
  // canonical casing while applying the same Unicode/whitespace cleanup used
  // for stable input identity; only the label is case-folded.
  const type = pageType.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const normalizedLabel = normalizeLabel(label);
  if (!type) throw new Error('page type must not be empty');
  if (!normalizedLabel) throw new Error('partition label must not be empty');
  return [type, normalizedLabel];
}

export function partitionKeyString(key: readonly [string, string]): string {
  return `${key[0]}${SEPARATOR}${key[1]}`;
}

/** Small stable hash; avoids provider/runtime-specific hash implementations. */
function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.length !== new Set(values).size) throw new Error(`${label} must be unique`);
}

/**
 * Shuffle mapped artifacts into typed partitions. The input is intentionally
 * artifact-shaped: a source may contribute zero, one, or many keys, and many
 * sources may contribute to one key.
 */
export function buildArtifactPartitions(
  artifacts: readonly PartitionInput[],
  workerIds: readonly string[],
): { readonly partitions: readonly PartitionPlan[]; readonly receipt: PartitionReceipt } {
  if (workerIds.length === 0) throw new Error('at least one worker is required');
  assertUnique(workerIds, 'worker ids');

  const byKey = new Map<string, {
    readonly key: readonly [string, string];
    readonly sourceIds: Set<string>;
    readonly artifactIds: string[];
    readyAt: number;
  }>();
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.artifactId)) throw new Error(`duplicate artifact id: ${artifact.artifactId}`);
    artifactIds.add(artifact.artifactId);
    const key = canonicalPartitionKey(artifact.pageType, artifact.normalizedLabel);
    const keyString = partitionKeyString(key);
    const current = byKey.get(keyString);
    if (current) {
      current.sourceIds.add(artifact.sourceId);
      current.artifactIds.push(artifact.artifactId);
      current.readyAt = Math.min(current.readyAt, artifact.readyAt);
    } else {
      byKey.set(keyString, {
        key,
        sourceIds: new Set([artifact.sourceId]),
        artifactIds: [artifact.artifactId],
        readyAt: artifact.readyAt,
      });
    }
  }

  const partitions = [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyString, item]) => {
      const ownerId = workerIds[Number.parseInt(stableHash(keyString), 16) % workerIds.length];
      if (ownerId === undefined) throw new Error('partition owner resolution failed');
      return Object.freeze({
        key: item.key,
        keyString,
        sourceIds: Object.freeze([...item.sourceIds].sort()),
        artifactIds: Object.freeze([...item.artifactIds].sort()),
        ownerId,
        // Fence identity is key/owner scoped, so adding another mapped
        // artifact cannot silently create a second owner for the same key.
        fence: stableHash(`${keyString}${SEPARATOR}${ownerId}`),
        readyAt: item.readyAt,
      });
    });

  const ownerByPartition: Record<string, string> = {};
  const fenceByPartition: Record<string, string> = {};
  for (const partition of partitions) {
    ownerByPartition[partition.keyString] = partition.ownerId;
    fenceByPartition[partition.keyString] = partition.fence;
  }
  const partitionKeys = partitions.map(partition => partition.keyString);
  const digest = stableHash(partitionKeys.map(key =>
    `${key}${SEPARATOR}${ownerByPartition[key]}${SEPARATOR}${fenceByPartition[key]}`,
  ).join('\n'));
  const receipt = Object.freeze({
    version: 1 as const,
    digest,
    partitionKeys: Object.freeze(partitionKeys),
    ownerByPartition: Object.freeze(ownerByPartition),
    fenceByPartition: Object.freeze(fenceByPartition),
  });
  return { partitions: Object.freeze(partitions), receipt };
}

// Kept as a concise generic name for callers that already speak in terms of
// partitions; unlike the old implementation it always consumes shuffled data.
export const buildPartitions = buildArtifactPartitions;

export function orderReadyPartitions(partitions: readonly PartitionPlan[]): readonly PartitionPlan[] {
  return [...partitions].sort((left, right) =>
    left.readyAt - right.readyAt || left.keyString.localeCompare(right.keyString),
  );
}
