/** A fencing token is intentionally opaque to the transaction writer. */
export type FenceToken = string | number;

export type FileScope = 'page' | 'global';

export type MaybePromise<T> = T | Promise<T>;

/** Values accepted by the planner are copied before they enter a plan. */
export type ByteInput = Uint8Array | string;

export interface StagedFile {
  /** Vault-relative path, using either slash style. */
  path: string;
  /** `null` stages a deletion; any other value is the replacement bytes. */
  bytes: ByteInput | null;
  scope?: FileScope;
  /** Explicitly bind this path to a hash (or to absence with `null`). */
  preconditionHash?: string | null;
}

export interface SnapshotFile {
  /** Vault-relative path, using either slash style. */
  path: string;
  /** `null` means the path is absent in the captured snapshot. */
  bytes: ByteInput | null;
  scope?: FileScope;
}

export interface TransactionPlanInput {
  fence: FenceToken;
  /** Supplying an ID makes retries and journal lookup deterministic. */
  transactionId?: string;
  /** The complete captured state for targeted paths. */
  current: Iterable<SnapshotFile> | ReadonlyMap<string, ByteInput | null>;
  /** Desired state for targeted paths. A null entry is a delete. */
  desired: Iterable<StagedFile> | ReadonlyMap<string, ByteInput | null>;
}

export interface FileState {
  exists: boolean;
  hash: string | null;
  /** Restoration bytes are retained in the plan and WAL. */
  bytes: Uint8Array | null;
}

export type TransactionOperationKind = 'create' | 'replace' | 'delete';

export interface TransactionOperation {
  kind: TransactionOperationKind;
  path: string;
  scope: FileScope;
  /** The hash observed while planning, and checked before every write. */
  preconditionHash: string | null;
  before: FileState;
  /** Staged bytes and their hash. A delete has an absent after state. */
  after: FileState;
}

export interface TransactionPlan {
  version: 'transaction-plan/v1';
  transactionId: string;
  fence: FenceToken;
  operations: readonly TransactionOperation[];
  planHash: string;
}

export interface TransactionFileSystem {
  read(path: string): Promise<Uint8Array | null>;
  /**
   * The optional precondition is checked again inside the filesystem mutation
   * boundary.  The engine already performs a CAS read, but passing the value
   * through lets a rooted implementation close the read-to-mutate gap as far
   * as its platform primitives allow.
   */
  write(path: string, bytes: Uint8Array, preconditionHash?: string | null): Promise<void>;
  remove(path: string, preconditionHash?: string | null): Promise<void>;
}

/**
 * Deliberately small lease surface. The writer never acquires or releases a
 * lease and never invents a new fence during rollback. The integration layer
 * owns those lifecycle decisions; it only proves the supplied fence remains
 * current before each mutation and on every rollback mutation.
 */
export interface TransactionLease {
  assertFence(fence: FenceToken): MaybePromise<void>;
  /** Optional integration lock; the handle remains fenced for the mutation. */
  withWriteFence?<T>(operation: () => Promise<T>): Promise<T>;
  /** Optional integration lock held across final CAS and independent readback. */
  withFinalCommit?<T>(operation: () => Promise<T>): Promise<T>;
  onRollbackStart?(fence: FenceToken, transactionId: string): MaybePromise<void>;
  onRollbackComplete?(fence: FenceToken, transactionId: string): MaybePromise<void>;
  /** Freeze writer acquisition after restoration itself cannot be verified. */
  freeze?(fence: FenceToken, reason: string): MaybePromise<void>;
}

export interface ReadbackMismatch {
  path: string;
  expectedHash: string | null;
  actualHash: string | null;
  scope: FileScope;
}

export interface ReadbackResult {
  ok: boolean;
  mismatches?: readonly ReadbackMismatch[];
  detail?: string;
}

export interface ReadbackContext {
  read(path: string): Promise<Uint8Array | null>;
  hash(path: string): Promise<string | null>;
}

export type ReadbackVerifier = (
  plan: TransactionPlan,
  context: ReadbackContext,
) => MaybePromise<ReadbackResult | boolean | void>;

export interface TransactionFaultContext {
  plan: TransactionPlan;
  operation?: TransactionOperation;
  operationIndex?: number;
}

/** Testable seams for stale-CAS, interruption, and restoration-failure tests. */
export interface TransactionFaultHooks {
  beforeCompareAndSwap?(context: TransactionFaultContext): MaybePromise<void>;
  afterWrite?(context: TransactionFaultContext): MaybePromise<void>;
  beforeCommit?(context: TransactionFaultContext): MaybePromise<void>;
  beforeRestore?(context: TransactionFaultContext): MaybePromise<void>;
  afterRestore?(context: TransactionFaultContext): MaybePromise<void>;
}

export interface TransactionEngineOptions {
  rootDir: string;
  /** JSONL WAL path. Defaults to a private transaction directory under root. */
  journalPath?: string;
  lease: TransactionLease;
  fileSystem?: TransactionFileSystem;
  readback?: ReadbackVerifier;
  faults?: TransactionFaultHooks;
  onJournalEvent?(event: JournalEvent): MaybePromise<void>;
}

export type JournalEventKind =
  | 'prepared'
  | 'cas-checked'
  | 'applied'
  | 'apply-failed'
  | 'interrupted'
  | 'readback-mismatch'
  | 'commit-check-failed'
  | 'committed'
  | 'restore-started'
  | 'restore-failed'
  | 'restored'
  | 'recovery-started'
  | 'recovered'
  | 'frozen';

export interface JournalEvent {
  version: 'transaction-journal/v1';
  sequence: number;
  at: string;
  transactionId: string;
  fence: FenceToken;
  planHash: string;
  kind: JournalEventKind;
  /** Present on prepare so a crash can restore without any external state. */
  plan?: TransactionPlan;
  operationIndex?: number;
  error?: { name: string; message: string };
  mismatches?: readonly ReadbackMismatch[];
}

export type TransactionTerminalStatus = 'committed' | 'restored' | 'frozen';

export interface TransactionReceipt {
  transactionId: string;
  fence: FenceToken;
  planHash: string;
  journalPath: string;
  status: TransactionTerminalStatus;
  reason?: 'readback-mismatch' | 'stale-precondition' | 'stale-fence' | 'interrupted' | 'failure';
  restored: boolean;
}

export interface RecoveryReceipt {
  transactionId: string;
  fence: FenceToken;
  planHash: string;
  journalPath: string;
  status: 'recovered' | 'frozen' | 'nothing-to-recover';
  restored: boolean;
}

export class TransactionError extends Error {
  readonly code: string;
  readonly transactionId?: string;
  readonly restored: boolean;

  constructor(message: string, code: string, options: { transactionId?: string; restored?: boolean } = {}) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.transactionId = options.transactionId;
    this.restored = options.restored ?? false;
  }
}

export class StaleFenceError extends TransactionError {
  constructor(message: string, transactionId?: string) {
    super(message, 'STALE_FENCE', { transactionId });
    this.name = 'StaleFenceError';
  }
}

export class StalePreconditionError extends TransactionError {
  readonly path: string;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;

  constructor(path: string, expectedHash: string | null, actualHash: string | null, transactionId?: string) {
    super(
      `Stale precondition for ${path}: expected ${expectedHash ?? '<absent>'}, found ${actualHash ?? '<absent>'}`,
      'STALE_PRECONDITION',
      { transactionId },
    );
    this.name = 'StalePreconditionError';
    this.path = path;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * A rooted filesystem discovered that its path identity changed at a mutation
 * boundary.  `mutationVisible` is deliberately explicit: a post-rename or
 * post-unlink verification failure must make the engine include that
 * operation in rollback even though the filesystem method threw.
 */
export class MutationBoundaryError extends TransactionError {
  readonly path: string;
  readonly mutationVisible: boolean;

  constructor(path: string, message: string, mutationVisible: boolean, transactionId?: string) {
    super(message, 'MUTATION_BOUNDARY', { transactionId });
    this.name = 'MutationBoundaryError';
    this.path = path;
    this.mutationVisible = mutationVisible;
  }
}

export class ReadbackMismatchError extends TransactionError {
  readonly mismatches: readonly ReadbackMismatch[];

  constructor(mismatches: readonly ReadbackMismatch[], transactionId?: string, restored = false) {
    super(
      `Independent readback mismatch for ${mismatches.map((item) => item.path).join(', ') || 'transaction'}`,
      'READBACK_MISMATCH',
      { transactionId, restored },
    );
    this.name = 'ReadbackMismatchError';
    this.mismatches = mismatches;
  }
}

export class TransactionInterruptionError extends TransactionError {
  constructor(message = 'Transaction interrupted; recovery is required', transactionId?: string) {
    super(message, 'INTERRUPTED', { transactionId });
    this.name = 'TransactionInterruptionError';
  }
}

export class RestoreFailureError extends TransactionError {
  readonly causeError: unknown;

  constructor(message: string, causeError: unknown, transactionId?: string) {
    super(message, 'RESTORE_FAILED', { transactionId });
    this.name = 'RestoreFailureError';
    this.causeError = causeError;
  }
}

export class RestoreConflictError extends TransactionError {
  readonly path: string;
  readonly expectedPostApplyHash: string | null;
  readonly actualHash: string | null;

  constructor(
    path: string,
    expectedPostApplyHash: string | null,
    actualHash: string | null,
    transactionId?: string,
  ) {
    super(
      `Rollback CAS failed for ${path}: expected post-apply ${expectedPostApplyHash ?? '<absent>'}, ` +
      `found ${actualHash ?? '<absent>'}; refusing to overwrite a foreign edit`,
      'RESTORE_CONFLICT',
      { transactionId },
    );
    this.name = 'RestoreConflictError';
    this.path = path;
    this.expectedPostApplyHash = expectedPostApplyHash;
    this.actualHash = actualHash;
  }
}

export class WriterFrozenError extends TransactionError {
  constructor(message: string, transactionId?: string) {
    super(message, 'WRITER_FROZEN', { transactionId });
    this.name = 'WriterFrozenError';
  }
}
