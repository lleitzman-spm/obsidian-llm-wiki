import type {
  CandidatePlan,
  PreflightCapture,
  Receipt,
  RunManifest,
  SemanticProjection,
  SourceInventory,
  TerminalRoot as ContractTerminalRoot,
  WorkerArtifact,
} from '../contracts';
import type {
  KeyRegistry,
  TerminalRoot as CryptoTerminalRoot,
} from '../crypto';
import type { JournalEvent } from '../transaction';

/** A single fail-closed reason emitted by the independent verifier. */
export interface VerificationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Verification errors deliberately carry a stable code and artifact path.
 * Callers should treat any instance as a hard stop; there is no partial
 * acceptance result.
 */
export class RunArtifactVerificationError extends Error {
  readonly code: string;
  readonly issues: readonly VerificationIssue[];

  constructor(message: string, issue: VerificationIssue | readonly VerificationIssue[]) {
    super(message);
    this.name = 'RunArtifactVerificationError';
    this.code = 'RUN_ARTIFACT_INVALID';
    this.issues = Array.isArray(issue) ? issue : [issue];
  }
}

export interface VerifyRunArtifactsOptions {
  /** Content-addressed run-artifact directory. It is never written. */
  readonly directory: string;
  /** Independently pinned trusted roots and verified delegations. */
  readonly registry: KeyRegistry;
  readonly expectedRunId?: string;
  readonly initialReplayCheckpointSha256?: string;
  readonly priorReplayTuples?: Iterable<string>;
  readonly terminalRootPath?: string;
  readonly replayLedgerPath?: string;
  readonly journalPath?: string;
  /** Contract v1 currently uses the receipt domain for candidate plans. */
  readonly candidatePlanDomain?: 'candidate-receipt-signature';
  readonly requiredScopes?: Partial<{
    preflight: string;
    manifest: string;
    worker: string;
    candidatePlan: string;
    candidateReceipt: string;
    replay: string;
    terminal: string;
  }>;
  /** Verify the directory Merkle tree as well as each named contract. */
  readonly verifyTerminalTree?: boolean;
}

export interface VerifiedJournal {
  readonly path: string;
  readonly sha256: string;
  readonly events: readonly JournalEvent[];
  readonly transactionId: string;
  readonly fence: number | string;
  readonly planHash: string;
  readonly terminalKind: JournalEvent['kind'];
}

export interface VerifiedReplay {
  readonly path: string;
  readonly sha256: string;
  readonly rootSha256: string;
  readonly entryCount: number;
  readonly firstPreviousHash: string;
  readonly lastRunId: string;
  readonly lastFence: number | string;
}

export interface RunArtifactVerificationResult {
  readonly ok: true;
  readonly runId: string;
  readonly directory: string;
  readonly manifest: RunManifest;
  readonly sourceInventory: SourceInventory;
  readonly workerArtifacts: readonly WorkerArtifact[];
  readonly candidatePlan: CandidatePlan;
  readonly receipt: Receipt;
  readonly sourceProjection: SemanticProjection;
  readonly candidateProjection: SemanticProjection;
  readonly preflightCapture: PreflightCapture;
  readonly journal: VerifiedJournal;
  readonly replay: VerifiedReplay;
  readonly terminalRoot: ContractTerminalRoot | CryptoTerminalRoot;
  readonly terminalRootContract?: ContractTerminalRoot;
  readonly terminalRootCrypto?: CryptoTerminalRoot;
  readonly projectionSha256: string;
  readonly manifestSha256: string;
}

export type TerminalRunRootContract = ContractTerminalRoot;
