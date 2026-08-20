import type { JsonValue } from '../crypto';
import type { DomainName, Signer, TerminalRoot } from '../crypto';

/** A file which will become part of the immutable evidence directory. */
export interface FinalizationFile {
  /** Evidence-root relative path. Paths are normalized and cannot escape. */
  readonly path: string;
  /** The exact bytes which must be present at `path`. */
  readonly bytes: Uint8Array | string;
}

export interface ReplayIntent {
  /** Stable nonce used to make retries idempotent in the replay store. */
  readonly nonce: string;
  /** Evidence-root relative path of the durable replay ledger. */
  readonly artifactPath: string;
  /** Optional public, non-secret payload bound by the replay implementation. */
  readonly payload?: JsonValue;
}

/**
 * A replay appender must be idempotent for one intent. In particular, a retry
 * after a process died after appending but before recording the result must
 * return the original append result rather than creating a second tuple.
 */
export interface ReplayAppender {
  ensureAppended(intent: ReplayIntent): Promise<ReplayAppendResult>;
}

export interface ReplayAppendResult {
  readonly entryHash: string;
  readonly ledgerRootHash: string;
  /** Optional path override; when supplied it must equal the intent path. */
  readonly artifactPath?: string;
  /** Optional independent bytes hash for the ledger file. */
  readonly artifactSha256?: string;
}

export type TransactionObservation =
  | { readonly status: 'committed'; readonly transactionId: string; readonly planHash: string; readonly fence: number | string }
  | { readonly status: 'in-progress'; readonly transactionId: string; readonly planHash: string; readonly fence: number | string }
  | { readonly status: 'no-commit'; readonly transactionId: string; readonly planHash: string; readonly fence: number | string; readonly reason?: string }
  | { readonly status: 'unknown'; readonly transactionId: string; readonly planHash: string; readonly fence: number | string; readonly reason: string };

export interface TransactionProbe {
  observe(): Promise<TransactionObservation>;
}

export interface FinalizationIdentity {
  readonly runId: string;
  readonly transactionId: string;
  readonly planHash: string;
  readonly fence: number | string;
}

export interface PrepareFinalizationInput extends FinalizationIdentity {
  /** A fresh run-specific directory outside the vault and sync roots. */
  readonly artifactRoot: string;
  /** Durable state lives outside the evidence root to avoid Merkle cycles. */
  readonly stateRoot: string;
  /** Roots which evidence/state may not overlap or reside below. */
  readonly forbiddenRoots?: readonly string[];
  readonly files: readonly FinalizationFile[];
  readonly replay: ReplayIntent;
  readonly signer: Signer;
  readonly manifestHash?: string;
  readonly now?: () => number;
}

export interface FinalizeRunInput extends PrepareFinalizationInput {
  readonly transaction: TransactionProbe | TransactionObservation;
  readonly replayAppender: ReplayAppender;
}

export type FinalizationState = 'pending' | 'committed-unreceipted' | 'terminal' | 'failed' | 'frozen' | 'in-progress' | 'no-commit';

export interface FinalizationResult extends FinalizationIdentity {
  readonly state: FinalizationState;
  readonly artifactRoot: string;
  readonly stateRoot: string;
  readonly terminalRoot?: TerminalRoot;
  readonly ledgerRootHash?: string;
  readonly reason?: string;
}

export interface RecoveryInput extends FinalizationIdentity {
  readonly artifactRoot: string;
  readonly stateRoot: string;
  readonly signer: Signer;
  readonly transaction: TransactionProbe | TransactionObservation;
  readonly replayAppender: ReplayAppender;
  readonly forbiddenRoots?: readonly string[];
  readonly now?: () => number;
}

export interface PendingPayload extends FinalizationIdentity {
  readonly version: 'spm-brain/finalization-pending/v1';
  readonly artifactRoot: string;
  readonly stateRoot: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes_base64: string;
  }[];
  readonly replay: ReplayIntent;
  readonly manifestHash?: string;
  readonly preparedAt: string;
}

export interface FinalizationStatusPayload extends FinalizationIdentity {
  readonly version: 'spm-brain/finalization-status/v1';
  readonly state: 'committed-unreceipted' | 'terminal' | 'failed' | 'frozen';
  readonly recordedAt: string;
  readonly reason?: string;
  readonly terminalRootHash?: string;
  readonly receiptSha256?: string;
  readonly ledgerRootHash?: string;
}

export interface FinalizationStatusEnvelope {
  readonly version: 'spm-brain/signed/v1';
  readonly domain: DomainName;
  readonly keyId: string;
  readonly digest: string;
  readonly signature: string;
  readonly payload: FinalizationStatusPayload;
}

export interface FinalizationInspection {
  readonly state: 'missing' | 'pending' | 'committed-unreceipted' | 'terminal' | 'failed' | 'frozen';
  readonly pending?: PendingPayload;
  readonly status?: FinalizationStatusPayload;
}

export interface PendingEnvelope {
  readonly version: 'spm-brain/signed/v1';
  readonly domain: DomainName;
  readonly keyId: string;
  readonly digest: string;
  readonly signature: string;
  readonly payload: PendingPayload;
}
