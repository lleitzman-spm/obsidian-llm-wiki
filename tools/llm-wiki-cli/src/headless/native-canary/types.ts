import type { KeyRegistry, Signer, ContractSignature } from '../crypto';
import type { CopySnapshotManifest } from '../copy-snapshot';
import type { NativeMapClient, NativeMapIR, NativeMapPolicy } from '../native-map';
import type { NativeReductionPlan } from '../native-reducer';
import type { NativeReferenceInput, NativeReferenceResult } from '../native-reference';
import type { ExtractionPolicyPack, SettingsSignatureVerifier } from '../policy-pack';
import type { AdaptiveConcurrencyController } from '../scheduler';
import type { TransactionFaultHooks, TransactionPlan, TransactionReceipt } from '../transaction';
import type { FinalizationResult } from '../finalization';
import type { SemanticComparisonResult } from '../comparison';
import type { IndependentRunVerificationResult } from '../crypto';
import type { SourceInventory } from '../preflight/source-inventory';
import type { LLMClient } from '../../../../../src/types';

export const NATIVE_CANARY_VERSION = 'native-vs-candidate-canary/v1' as const;
export const LIVE_IDLE_OBSERVATION_VERSION = 'spm-brain/live-idle-observation/v1' as const;

export type NativeCanaryRefusalCode =
  | 'invalid-input'
  | 'unsupported-native-seam'
  | 'unsafe-root'
  | 'live-observation-invalid'
  | 'live-observation-stale'
  | 'live-drift'
  | 'source-manifest-mismatch'
  | 'settings-binding-mismatch'
  | 'policy-binding-mismatch'
  | 'native-rejected'
  | 'candidate-map-failed'
  | 'candidate-reduction-refused'
  | 'candidate-comparison-refused'
  | 'transaction-refused'
  | 'finalization-refused'
  | 'verification-refused';

export class NativeCanaryRefusal extends Error {
  readonly code: NativeCanaryRefusalCode;
  readonly details: readonly string[];

  constructor(code: NativeCanaryRefusalCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'NativeCanaryRefusal';
    this.code = code;
    this.details = [...details];
  }
}

/**
 * A signed observation supplied by the UI/controller host.  The coordinator
 * never treats a caller boolean as proof that Obsidian is idle.  The host must
 * produce a fresh observation immediately before each effect boundary.
 */
export interface LiveIdleObservation {
  readonly version: typeof LIVE_IDLE_OBSERVATION_VERSION;
  readonly runId: string;
  readonly windowId: string;
  readonly liveRoot: string;
  readonly observedAt: string;
  readonly idle: true;
  readonly mutationSurface: 'read-only';
  readonly statusDigest: string;
  readonly signedDigest: string;
  readonly signature: ContractSignature;
}

export interface NativeCanaryPolicyInput {
  /** Exact bytes of the copied Obsidian settings file. */
  readonly fullSettingsBytes: Uint8Array;
  /** The broader deny-listed settings projection used by native preflight. */
  readonly safeSettingsProjection: unknown;
  /** A separately signed, exact extraction policy/settings/vocabulary pack. */
  readonly policyPack: ExtractionPolicyPack;
  readonly verifySettingsSignature: SettingsSignatureVerifier;
  /** Settings shape consumed by the source-map contract. */
  readonly nativeMapSettings: NativeMapPolicy['settings'];
}

export interface NativeCanaryGlobalInput {
  readonly wikiFolder: string;
  readonly indexPath: string;
  readonly logPath: string;
  readonly schemaPath: string;
  readonly schemaContent?: string;
  /** Stable date; no coordinator wall-clock is used for generated pages. */
  readonly date: string;
  readonly slugCase?: 'lower' | 'preserve';
}

export interface NativeCanaryProvider {
  readonly provider: string;
  readonly model: string;
  /** Opaque grant reference; no credential is accepted here. */
  readonly authorizationRef: string;
  readonly createClient: () => LLMClient | Promise<LLMClient>;
  readonly mapClient: NativeMapClient;
}

export interface NativeReferenceRunner {
  readonly run: (input: NativeReferenceInput) => Promise<NativeReferenceResult>;
}

export interface NativeCanaryInput {
  readonly runId: string;
  readonly liveRoot: string;
  readonly nativeRoot: string;
  readonly candidateRoot: string;
  readonly artifactRoot: string;
  readonly syncRoots?: readonly string[];
  readonly sourceInventory: SourceInventory;
  readonly authority: {
    readonly repositoryUrl: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly windowId: string;
  /** Called before cloning and immediately before the candidate write. */
  readonly observeLive: () => Promise<LiveIdleObservation>;
  readonly policy: NativeCanaryPolicyInput;
  readonly provider: NativeCanaryProvider;
  readonly signer: Signer;
  readonly trustedRegistry: KeyRegistry;
  readonly nativeReference?: NativeReferenceRunner;
  readonly scheduler?: AdaptiveConcurrencyController;
  readonly schedulerCapacity?: number | (() => number | Promise<number>);
  readonly workerIds?: readonly string[];
  readonly global: NativeCanaryGlobalInput;
  readonly now?: () => number;
  readonly transactionFaults?: TransactionFaultHooks;
}

export interface NativeCanaryCopies {
  readonly live: CopySnapshotManifest;
  readonly native: CopySnapshotManifest;
  readonly candidate: CopySnapshotManifest;
}

export interface NativeCanaryResult {
  readonly version: typeof NATIVE_CANARY_VERSION;
  readonly runId: string;
  readonly observation: LiveIdleObservation;
  readonly copies: NativeCanaryCopies;
  readonly native: NativeReferenceResult;
  readonly nativeMapPolicy: NativeMapPolicy;
  readonly mapIR: readonly NativeMapIR[];
  readonly reduction: NativeReductionPlan;
  readonly transactionPlan: TransactionPlan;
  readonly transaction: TransactionReceipt;
  readonly comparison: SemanticComparisonResult;
  readonly finalization: FinalizationResult;
  readonly independentVerification: IndependentRunVerificationResult;
  readonly artifactDirectory: string;
}
