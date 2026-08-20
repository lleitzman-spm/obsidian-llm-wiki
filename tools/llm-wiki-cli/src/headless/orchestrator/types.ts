import type { KeyRegistry, Signer, SignedEnvelope, TerminalRoot, IndependentRunVerificationResult } from '../crypto';
import type { SourceInventory } from '../preflight/source-inventory';
import type { PreflightManifest } from '../preflight/manifest';
import type { ContractSemanticProjection } from '../provenance/types';
import type { ArtifactData, CandidatePlan as EngineCandidatePlan, ProviderPort, SchedulerPort, SourceRecord } from '../engine';
import type { CandidatePlan, Receipt, RunManifest, SourceInventory as ContractSourceInventory, WorkerArtifact, PreflightCapture } from '../contracts';
import type { TransactionFaultHooks, TransactionPlan, TransactionReceipt } from '../transaction';

/** A source descriptor contains only public, authority-bound source facts. */
export interface CanarySourceDescriptor {
  readonly pageType: 'entity' | 'concept';
  readonly label: string;
}

export interface CanaryAuthority {
  readonly repositoryUrl: string;
  readonly commit: string;
  readonly tree: string;
}

export interface CanaryRuntime {
  readonly engineVersion: string;
  readonly bundleSha256: string;
  readonly schemaSha256: string;
  readonly vocabularySha256: string;
  readonly policyPackSha256: string;
  readonly promptVersion: string;
}

export interface CanarySettings {
  /** Exact bytes are hashed only; they are never written to a receipt. */
  readonly fullSettingsBytes: Uint8Array;
  /** Settings are projected through the secret-deny-list before hashing. */
  readonly value: unknown;
}

/**
 * The coordinator deliberately has an explicit activation mode.  The only
 * executable mode in this migration slice is the synthetic fixture mode; it
 * cannot be mistaken for a native Obsidian compatibility claim.
 */
export type HeadlessActivationMode = 'synthetic-scaffold-only' | 'native-compatible';

/** Generic ports reserved for the native/reference integration boundary. */
export interface SnapshotPortContext {
  readonly runId: string;
  readonly root: string;
  readonly vaultIdentity: string;
}

export interface SnapshotPort<TSnapshot = unknown> {
  readonly capture: (context: SnapshotPortContext) => Promise<TSnapshot>;
}

export interface ComparisonPortInput<TNativeSnapshot = unknown, TCandidateSnapshot = unknown> {
  readonly runId: string;
  readonly native: TNativeSnapshot;
  readonly candidate: TCandidateSnapshot;
}

export interface ComparisonPort<
  TNativeSnapshot = unknown,
  TCandidateSnapshot = unknown,
  TComparison = unknown,
> {
  readonly compare: (input: ComparisonPortInput<TNativeSnapshot, TCandidateSnapshot>) => Promise<TComparison>;
}

export interface HeadlessCanaryInput {
  /** Must be explicit; native-compatible execution is fail-closed until its ports are wired. */
  readonly activationMode: HeadlessActivationMode;
  readonly runId: string;
  readonly jobId: string;
  readonly windowId: string;
  readonly vaultIdentity: string;
  /** The live root is inspected for overlap only and is never written. */
  readonly liveRoot: string;
  readonly nativeRoot: string;
  readonly candidateRoot: string;
  /** Evidence/receipts live here, outside every vault and sync root. */
  readonly artifactRoot: string;
  readonly syncRoots?: readonly string[];
  /** The live UI/runtime must have been independently observed idle. */
  readonly idle: boolean;
  readonly authority: CanaryAuthority;
  readonly sourceInventory: SourceInventory;
  readonly sourceContents: ReadonlyMap<string, string | Uint8Array>;
  readonly sourceDescriptors?: ReadonlyMap<string, CanarySourceDescriptor>;
  readonly runtime: CanaryRuntime;
  readonly settings: CanarySettings;
  readonly providerName: string;
  readonly model: string;
  readonly workerIds: readonly string[];
  readonly provider: ProviderPort;
  /** The caller owns capacity/concurrency policy; there is no implicit Promise.all scheduler. */
  readonly scheduler: SchedulerPort;
  /** Pinned authority registry containing the signer or an attenuated delegation. */
  readonly trustedRegistry: KeyRegistry;
  readonly nativeSnapshot?: SnapshotPort;
  readonly candidateSnapshot?: SnapshotPort;
  readonly comparison?: ComparisonPort;
  readonly signer: Signer;
  readonly now?: () => number;
  readonly transactionFaults?: TransactionFaultHooks;
}

export interface CorrectnessCensus {
  readonly sourceStatementIds: readonly string[];
  readonly candidateStatementIds: readonly string[];
  readonly matchedStatementIds: readonly string[];
  readonly missingStatementIds: readonly string[];
  readonly extraStatementIds: readonly string[];
  readonly sourceClaimCount: number;
  readonly candidateClaimCount: number;
  readonly semanticEquivalent: boolean;
}

export interface HeadlessCanaryResult {
  readonly activationMode: HeadlessActivationMode;
  readonly runId: string;
  readonly preflight: PreflightManifest;
  readonly preflightCapture: PreflightCapture;
  readonly contractSourceInventory: ContractSourceInventory;
  readonly runManifest: RunManifest;
  readonly sources: readonly SourceRecord[];
  readonly enginePlan: EngineCandidatePlan;
  readonly workerArtifacts: readonly WorkerArtifact[];
  readonly sourceProjection: ContractSemanticProjection;
  readonly candidateProjection: ContractSemanticProjection;
  readonly correctness: CorrectnessCensus;
  readonly candidatePlan: CandidatePlan;
  readonly transactionPlan: TransactionPlan;
  readonly transactionReceipt: TransactionReceipt;
  readonly receipt: Receipt;
  readonly receiptEnvelope: SignedEnvelope;
  readonly terminalRoot: TerminalRoot;
  readonly independentVerification: IndependentRunVerificationResult;
  readonly artifactDirectory: string;
}

export interface OrchestratorContracts {
  readonly sourceInventory: ContractSourceInventory;
  readonly runManifest: RunManifest;
  readonly candidatePlan: CandidatePlan;
  readonly receipt: Receipt;
}

/** Raised before a candidate write whenever semantic output differs from input. */
export class SemanticMismatchError extends Error {
  readonly census: CorrectnessCensus;

  public constructor(census: CorrectnessCensus) {
    super(`Semantic projection mismatch: ${census.missingStatementIds.length} missing and ${census.extraStatementIds.length} extra statements`);
    this.name = 'SemanticMismatchError';
    this.census = census;
  }
}

export type { ArtifactData };
