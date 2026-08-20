/** Provider-neutral data contracts for the headless map/partition/reduce core. */

export interface SourceRecord {
  readonly sourceId: string;
  readonly pageType: string;
  readonly label: string;
  readonly content: string;
  readonly readyAt?: number;
  readonly laneId?: string;
}

export interface ArtifactData {
  readonly artifactId: string;
  readonly sourceId: string;
  readonly pageType: string;
  readonly label: string;
  readonly normalizedLabel?: string;
  /** Optional provider echo; when present it must match the map run. */
  readonly runId?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly provenance?: unknown;
}

export interface SourceProvenance {
  readonly sourceId: string;
  readonly [key: string]: unknown;
}

export interface ArtifactProvenance {
  readonly artifactId: string;
  readonly sourceId: string;
  readonly [key: string]: unknown;
}

/** Validation hooks stay outside the engine so contracts can evolve independently. */
export interface ContractPort {
  readonly assertSource: (source: Readonly<SourceRecord>) => void;
  readonly assertArtifact: (artifact: Readonly<ArtifactData>) => void;
  readonly assertPlan: (plan: Readonly<CandidatePlan>) => void;
}

/** Provenance is descriptive only; this port intentionally has no persistence method. */
export interface ProvenancePort {
  readonly sourceRef: (source: Readonly<SourceRecord>) => SourceProvenance;
  readonly artifactRef: (artifact: Readonly<ArtifactData>) => ArtifactProvenance;
}

/** A provider can only inspect one immutable source per map invocation. */
export interface ProviderPort {
  readonly map: (source: Readonly<SourceRecord>) => Promise<readonly ArtifactData[]>;
}

export interface PartitionReceipt {
  readonly version: 1;
  readonly digest: string;
  readonly partitionKeys: readonly string[];
  readonly ownerByPartition: Readonly<Record<string, string>>;
  readonly fenceByPartition: Readonly<Record<string, string>>;
}

export interface PartitionPlan {
  readonly key: readonly [pageType: string, normalizedLabel: string];
  readonly keyString: string;
  readonly sourceIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly ownerId: string;
  readonly fence: string;
  readonly readyAt: number;
}

export interface MapJob {
  readonly source: Readonly<SourceRecord>;
  readonly runId: string;
  readonly run: () => Promise<MapResult>;
}

export interface MapResult {
  readonly sourceId: string;
  readonly runId: string;
  readonly artifacts: readonly ArtifactData[];
}

/** Scheduling is injected to keep provider/runtime concerns out of this module. */
export interface SchedulerPort {
  readonly schedule: (jobs: readonly MapJob[]) => Promise<readonly MapResult[]>;
}

// Descriptive aliases keep the boundary vocabulary readable at call sites
// while retaining the explicit Port names for dependency-injection tooling.
export type Contracts = ContractPort;
export type Provenance = ProvenancePort;
export type Provider = ProviderPort;
export type Scheduler = SchedulerPort;

export interface CandidatePartition {
  readonly key: readonly [pageType: string, normalizedLabel: string];
  readonly keyString: string;
  readonly ownerId: string;
  readonly fence: string;
  readonly sourceIds: readonly string[];
  readonly artifactIds: readonly string[];
}

export interface CandidatePlan {
  readonly complete: true;
  readonly partitions: readonly CandidatePartition[];
  readonly artifacts: readonly ArtifactData[];
  readonly receipt: PartitionReceipt;
}

export interface MapReduceInput {
  readonly sources: readonly SourceRecord[];
  readonly workerIds: readonly string[];
  /** Optional external lane labels; duplicate labels are refused before scheduling. */
  readonly laneIds?: readonly string[];
  readonly contracts: ContractPort;
  readonly provenance: ProvenancePort;
  readonly provider: ProviderPort;
  readonly scheduler: SchedulerPort;
}
