import type { LLMClient, IngestReport } from '../../../../../src/types';
import type { Receipt } from '../contracts';
import type { ContractSemanticProjection } from '../provenance/types';
import type { Signer } from '../crypto';
import type { CopySnapshotManifest } from '../copy-snapshot';
import type { SourceInventory, SourceInventoryEntry } from '../preflight/source-inventory';
import type { SafeCopyRoots } from '../preflight/roots';
import type { VaultWriteRecord } from '../../vault';

/** The native/reference runner is intentionally versioned independently of the headless reducer. */
export const NATIVE_REFERENCE_VERSION = 'native-reference/v1' as const;
export const NATIVE_REFERENCE_BINDING_VERSION = 'native-reference-binding/v1' as const;
export const NATIVE_REFERENCE_SIGNING_SCOPE = 'spm-brain-native-reference-sign' as const;

export type NativeReferenceMode = 'ingest' | 'lint';

/**
 * A refusal is part of the runner's public API.  Callers can decide whether a
 * canary is blocked without parsing an English error message, and the runner
 * never turns an unverified native execution into an accepted receipt.
 */
export type NativeReferenceRefusalCode =
  | 'invalid-run-id'
  | 'unsafe-copy-root'
  | 'invalid-artifact-root'
  | 'invalid-source-inventory'
  | 'source-drift'
  | 'source-not-found'
  | 'settings-unavailable'
  | 'settings-mismatch'
  | 'unsafe-wiki-folder'
  | 'provider-identity-missing'
  | 'provider-settings-mismatch'
  | 'provider-client-missing'
  | 'signer-scope-missing'
  | 'lint-smart-fix-enabled'
  | 'lint-native-seam-unavailable'
  | 'artifact-directory-not-empty'
  | 'artifact-write-failed'
  | 'native-execution-failed';

export class NativeReferenceRefusal extends Error {
  readonly code: NativeReferenceRefusalCode;
  readonly details: readonly string[];

  constructor(code: NativeReferenceRefusalCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'NativeReferenceRefusal';
    this.code = code;
    this.details = [...details];
  }
}

/**
 * The runner accepts an already-authorized client.  It deliberately does not
 * accept an API key and never looks in Obsidian SecretStorage, data.json's
 * legacy apiKey field, environment variables, or an OS keychain.
 */
export interface AuthorizedProviderIdentity {
  readonly provider: string;
  readonly model: string;
  /** An opaque authorization/grant identifier, never a credential. */
  readonly authorizationRef: string;
  readonly createClient: () => LLMClient | Promise<LLMClient>;
}

/** Exact settings hashes captured from the source/live settings surface. */
export interface NativeReferenceSettingsBinding {
  readonly fullSha256: string;
  readonly safeProjectionSha256: string;
}

export interface NativeReferenceInput {
  readonly runId: string;
  readonly mode: NativeReferenceMode;
  /** Only inspected for root containment; never opened or written. */
  readonly liveRoot: string;
  /** The only vault root the native engine is allowed to read or write. */
  readonly copiedVaultRoot: string;
  /** Receipts live outside both the live vault and copied vault. */
  readonly artifactRoot: string;
  readonly syncRoots?: readonly string[];
  readonly sourceInventory: SourceInventory;
  readonly settings: NativeReferenceSettingsBinding;
  readonly provider: AuthorizedProviderIdentity;
  readonly signer: Signer;
  /** Defaults to all inventory sources. Paths must be inventory members. */
  readonly sourcePaths?: readonly string[];
  /** Native ingest's duplicate gate is bypassed by default for a fresh canary copy. */
  readonly forceReingest?: boolean;
  readonly now?: () => number;
}

export interface NativeReferencePreflight {
  readonly roots: SafeCopyRoots;
  readonly copiedVaultRoot: string;
  readonly artifactRoot: string;
  readonly sourceInventory: SourceInventory;
  readonly selectedSources: readonly SourceInventoryEntry[];
  readonly settings: NativeReferenceSettingsBinding;
  readonly effectiveSettings: Record<string, unknown>;
  readonly beforeSnapshot: CopySnapshotManifest;
}

export interface NativeReferenceBinding {
  readonly version: typeof NATIVE_REFERENCE_BINDING_VERSION;
  readonly runId: string;
  readonly mode: NativeReferenceMode;
  readonly liveRoot: string;
  readonly copiedVaultRoot: string;
  readonly artifactRoot: string;
  readonly sourceInventorySha256: string;
  readonly sourceIdentities: readonly string[];
  readonly settings: NativeReferenceSettingsBinding;
  readonly provider: {
    provider: string;
    model: string;
    authorizationRefSha256: string;
  };
  readonly beforeSnapshotTreeSha256: string;
  readonly afterSnapshotTreeSha256: string;
  readonly projectionSha256: string;
  readonly receiptSha256: string;
}

export interface NativeReferenceResult {
  readonly version: typeof NATIVE_REFERENCE_VERSION;
  readonly runId: string;
  readonly mode: NativeReferenceMode;
  readonly status: 'accepted' | 'rejected';
  readonly preflight: NativeReferencePreflight;
  readonly beforeSnapshot: CopySnapshotManifest;
  readonly afterSnapshot: CopySnapshotManifest;
  readonly projection: ContractSemanticProjection;
  readonly receipt: Receipt;
  readonly binding: NativeReferenceBinding;
  readonly artifactDirectory: string;
  readonly reports: readonly IngestReport[];
  readonly writes: readonly VaultWriteRecord[];
  readonly errorMessage?: string;
}
