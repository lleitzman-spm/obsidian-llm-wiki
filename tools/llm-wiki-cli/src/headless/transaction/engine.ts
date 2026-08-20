import * as nodePath from 'node:path';

import { NodeTransactionFileSystem } from './filesystem';
import {
  assertPlanHash,
  hashNullable,
} from './planner';
import {
  isTerminalJournalEvent,
  latestEventsByTransaction,
  pendingJournalEvents,
  TransactionJournal,
} from './journal';
import type {
  FenceToken,
  JournalEvent,
  ReadbackContext,
  ReadbackMismatch,
  ReadbackResult,
  RecoveryReceipt,
  TransactionEngineOptions,
  TransactionFaultContext,
  TransactionFileSystem,
  TransactionOperation,
  TransactionPlan,
  TransactionReceipt,
} from './types';
import {
  ReadbackMismatchError,
  MutationBoundaryError,
  RestoreFailureError,
  RestoreConflictError,
  StaleFenceError,
  StalePreconditionError,
  TransactionError,
  TransactionInterruptionError,
  WriterFrozenError,
} from './types';

const DEFAULT_JOURNAL_DIRECTORY = '.headless-transaction';
const DEFAULT_JOURNAL_FILE = 'journal.jsonl';

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function isInterruption(error: unknown): error is TransactionInterruptionError {
  return error instanceof TransactionInterruptionError ||
    (error instanceof TransactionError && error.code === 'INTERRUPTED');
}

function mismatchForOperation(
  operation: TransactionOperation,
  actualHash: string | null,
  expectedHash: string | null,
): ReadbackMismatch {
  return {
    path: operation.path,
    expectedHash,
    actualHash,
    scope: operation.scope,
  };
}

function asReadbackResult(
  value: ReadbackResult | boolean | void,
  fallbackMismatches: readonly ReadbackMismatch[],
): ReadbackResult {
  if (typeof value === 'boolean') {
    return value ? { ok: true } : { ok: false, mismatches: fallbackMismatches };
  }
  if (value === undefined) return { ok: fallbackMismatches.length === 0, mismatches: fallbackMismatches };
  const result = value as ReadbackResult;
  return {
    ...result,
    ok: result.ok && fallbackMismatches.length === 0,
    mismatches: result.mismatches ?? fallbackMismatches,
  };
}

/**
 * Single-writer transaction engine. Planning is pure and happens outside this
 * class; this class owns only the durable apply/rollback/recovery boundary.
 */
export class TransactionEngine {
  readonly rootDir: string;
  readonly journalPath: string;
  readonly journal: TransactionJournal;
  readonly fileSystem: TransactionFileSystem;
  private readonly options: TransactionEngineOptions;

  constructor(options: TransactionEngineOptions) {
    this.rootDir = nodePath.resolve(options.rootDir);
    this.journalPath = nodePath.resolve(
      options.journalPath ?? nodePath.join(this.rootDir, DEFAULT_JOURNAL_DIRECTORY, DEFAULT_JOURNAL_FILE),
    );
    this.journal = new TransactionJournal(this.journalPath);
    this.fileSystem = options.fileSystem ?? new NodeTransactionFileSystem(this.rootDir);
    this.options = options;
  }

  private async append(
    plan: TransactionPlan,
    kind: JournalEvent['kind'],
    extra: Omit<JournalEvent, 'version' | 'sequence' | 'at' | 'transactionId' | 'fence' | 'planHash' | 'kind'> = {},
  ): Promise<JournalEvent> {
    const event = await this.journal.append({
      version: 'transaction-journal/v1',
      transactionId: plan.transactionId,
      fence: plan.fence,
      planHash: plan.planHash,
      kind,
      ...extra,
    });
    await this.options.onJournalEvent?.(event);
    return event;
  }

  private context(plan: TransactionPlan, operation?: TransactionOperation, operationIndex?: number): TransactionFaultContext {
    return { plan, operation, operationIndex };
  }

  private async assertLease(plan: TransactionPlan): Promise<void> {
    try {
      await this.options.lease.assertFence(plan.fence);
    } catch (error) {
      if (error instanceof StaleFenceError) throw error;
      throw new StaleFenceError(
        `Writer fence ${String(plan.fence)} is no longer current${error instanceof Error ? `: ${error.message}` : ''}`,
        plan.transactionId,
      );
    }
  }

  private async readHash(path: string): Promise<string | null> {
    return hashNullable(await this.fileSystem.read(path));
  }

  private async withWriteFence<T>(plan: TransactionPlan, operation: () => Promise<T>): Promise<T> {
    await this.assertLease(plan);
    const guarded = this.options.lease.withWriteFence;
    return guarded === undefined ? operation() : await guarded(operation);
  }

  private async withFinalCommit<T>(plan: TransactionPlan, operation: () => Promise<T>): Promise<T> {
    await this.assertLease(plan);
    const guarded = this.options.lease.withFinalCommit;
    return guarded === undefined ? operation() : await guarded(operation);
  }

  /** Journal records are serialized under the lease's mutation lock whenever
   * the lease is still usable. A caller that has already lost its fence cannot
   * manufacture a valid guarded append; those failures are allowed to surface
   * and the caller decides whether to preserve a terminal failure marker. */
  private async appendUnderFence(
    plan: TransactionPlan,
    kind: JournalEvent['kind'],
    extra: Omit<JournalEvent, 'version' | 'sequence' | 'at' | 'transactionId' | 'fence' | 'planHash' | 'kind'> = {},
  ): Promise<JournalEvent> {
    return this.withWriteFence(plan, () => this.append(plan, kind, extra));
  }

  private async verifyExpectedState(
    plan: TransactionPlan,
    expected: 'before' | 'after',
    indexes: ReadonlySet<number> | undefined = undefined,
  ): Promise<ReadbackMismatch[]> {
    const mismatches: ReadbackMismatch[] = [];
    for (let index = 0; index < plan.operations.length; index += 1) {
      if (indexes !== undefined && !indexes.has(index)) continue;
      const operation = plan.operations[index];
      const actualHash = await this.readHash(operation.path);
      const expectedHash = operation[expected].hash;
      if (actualHash !== expectedHash) mismatches.push(mismatchForOperation(operation, actualHash, expectedHash));
    }
    return mismatches;
  }

  private async invokeReadback(plan: TransactionPlan): Promise<ReadbackResult> {
    const directMismatches = await this.verifyExpectedState(plan, 'after');
    const context: ReadbackContext = {
      read: (path) => this.fileSystem.read(path),
      hash: (path) => this.readHash(path),
    };
    const custom = this.options.readback === undefined ? undefined : await this.options.readback(plan, context);
    return asReadbackResult(custom, directMismatches);
  }

  private async applyOperation(
    plan: TransactionPlan,
    operation: TransactionOperation,
    operationIndex: number,
    markMutationVisible: () => void,
  ): Promise<void> {
    await this.withWriteFence(plan, async () => {
      await this.options.faults?.beforeCompareAndSwap?.(this.context(plan, operation, operationIndex));
      const actualHash = await this.readHash(operation.path);
      if (actualHash !== operation.preconditionHash) {
        throw new StalePreconditionError(operation.path, operation.preconditionHash, actualHash, plan.transactionId);
      }
      await this.append(plan, 'cas-checked', { operationIndex });

      try {
        if (operation.after.exists) {
          // The planner guarantees that an existing after-state carries bytes.
          if (operation.after.bytes === null) throw new Error(`Missing staged bytes for ${operation.path}`);
          // The rooted Node filesystem re-checks this precondition inside its
          // staging/rename boundary. Custom adapters may ignore the optional
          // third argument, retaining the original interface behavior.
          await this.fileSystem.write(operation.path, operation.after.bytes, operation.preconditionHash);
        } else {
          await this.fileSystem.remove(operation.path, operation.preconditionHash);
        }
      } catch (error) {
        // A post-rename/unlink identity check can fail after the filesystem
        // mutation has become visible. Keep that operation rollback-visible;
        // otherwise the engine would incorrectly restore only earlier files.
        if (error instanceof MutationBoundaryError && error.mutationVisible) markMutationVisible();
        throw error;
      }
      // Mark immediately after the filesystem mutation and before the WAL
      // `applied` append. If that append fails, rollback still knows this
      // operation changed the vault and must perform its post-state CAS.
      markMutationVisible();
      await this.append(plan, 'applied', { operationIndex });
    });
  }

  private async restoreOperation(
    plan: TransactionPlan,
    operation: TransactionOperation,
    operationIndex: number,
  ): Promise<'restored' | 'already-before'> {
    return this.withWriteFence(plan, async () => {
      await this.options.faults?.beforeRestore?.(this.context(plan, operation, operationIndex));
      const actualHash = await this.readHash(operation.path);
      if (actualHash === operation.before.hash) return 'already-before';
      if (actualHash !== operation.after.hash) {
        throw new RestoreConflictError(
          operation.path,
          operation.after.hash,
          actualHash,
          plan.transactionId,
        );
      }
      if (operation.before.exists) {
        if (operation.before.bytes === null) throw new Error(`Missing restoration bytes for ${operation.path}`);
        // Retain the post-apply state as an inner rollback CAS. The read above
        // proves that we are still looking at our own post-state, but a
        // foreign writer can edit the path before this mutation call starts.
        // The rooted filesystem must reject that edit rather than overwrite it.
        await this.fileSystem.write(operation.path, operation.before.bytes, operation.after.hash);
      } else {
        await this.fileSystem.remove(operation.path, operation.after.hash);
      }
      await this.options.faults?.afterRestore?.(this.context(plan, operation, operationIndex));
      return 'restored';
    });
  }

  /** Restore every operation in reverse order while retaining the same fence. */
  private async restore(
    plan: TransactionPlan,
    reason: string,
    indexes: ReadonlySet<number> | undefined = undefined,
  ): Promise<void> {
    await this.assertLease(plan);
    await this.options.lease.onRollbackStart?.(plan.fence, plan.transactionId);
    await this.appendUnderFence(plan, 'restore-started', { error: { name: 'Rollback', message: reason } });
    for (let index = plan.operations.length - 1; index >= 0; index -= 1) {
      if (indexes !== undefined && !indexes.has(index)) continue;
      await this.restoreOperation(plan, plan.operations[index], index);
    }
    const mismatches = await this.verifyExpectedState(plan, 'before', indexes);
    if (mismatches.length > 0) {
      throw new Error(`Restored snapshot does not match for ${mismatches.map((item) => item.path).join(', ')}`);
    }
    await this.options.lease.onRollbackComplete?.(plan.fence, plan.transactionId);
  }

  private async freeze(plan: TransactionPlan, error: unknown): Promise<RestoreFailureError> {
    const detail = error instanceof Error ? error.message : String(error);
    const restoreError = new RestoreFailureError(
      `Unable to restore transaction ${plan.transactionId}; writer acquisition is frozen: ${detail}`,
      error,
      plan.transactionId,
    );
    try {
      await this.appendUnderFence(plan, 'restore-failed', { error: describeError(error) });
    } catch {
      // If the lease is already stale, the durable freeze marker below is the
      // authoritative stop signal. Keep trying to preserve the terminal WAL
      // event rather than masking the restoration failure.
    }
    try {
      await this.options.lease.freeze?.(plan.fence, restoreError.message);
    } finally {
      // A real lease rejects writes after freeze; this final marker therefore
      // uses the journal's serialized append directly and remains recoverable.
      await this.append(plan, 'frozen', { error: describeError(restoreError) }).catch(() => undefined);
    }
    return restoreError;
  }

  private async rollbackOrFreeze(
    plan: TransactionPlan,
    error: unknown,
    indexes: ReadonlySet<number>,
  ): Promise<never> {
    try {
      await this.restore(plan, error instanceof Error ? error.message : String(error), indexes);
      await this.appendUnderFence(plan, 'restored', { error: describeError(error) });
    } catch (restoreError) {
      throw await this.freeze(plan, restoreError);
    }
    throw error;
  }

  private async journalState(): Promise<JournalEvent[]> {
    return this.journal.read();
  }

  private ensurePlanNotFrozen(events: readonly JournalEvent[], transactionId?: string): void {
    let frozen = false;
    for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
      if (event.kind === 'frozen') frozen = true;
      if (event.kind === 'recovered') frozen = false;
    }
    if (frozen) throw new WriterFrozenError('Writer acquisition is frozen until transaction recovery succeeds', transactionId);
  }

  /**
   * Apply a complete plan. Any ordinary failure after a mutation is rolled
   * back before the error is returned. Interruption is intentionally left
   * pending so `recover()` can prove crash recovery from the WAL.
   */
  async apply(plan: TransactionPlan): Promise<TransactionReceipt> {
    assertPlanHash(plan);
    const events = await this.journalState();
    this.ensurePlanNotFrozen(events, plan.transactionId);
    const latest = latestEventsByTransaction(events).get(plan.transactionId);
    if (latest !== undefined) {
      if (latest.planHash !== plan.planHash) {
        throw new TransactionError(`Transaction ID ${plan.transactionId} already names another plan`, 'TRANSACTION_ID_REUSE', { transactionId: plan.transactionId });
      }
      if (latest.kind === 'committed' || latest.kind === 'restored') {
        return {
          transactionId: plan.transactionId,
          fence: plan.fence,
          planHash: plan.planHash,
          journalPath: this.journalPath,
          status: latest.kind,
          restored: latest.kind === 'restored',
        };
      }
      if (!isTerminalJournalEvent(latest.kind)) {
        throw new TransactionError(`Transaction ${plan.transactionId} has pending WAL recovery`, 'JOURNAL_PENDING', { transactionId: plan.transactionId });
      }
    }
    const pending = pendingJournalEvents(events).filter((event) => event.transactionId !== plan.transactionId);
    if (pending.length > 0) {
      throw new TransactionError(`Transaction ${pending[0].transactionId} requires recovery before a new writer transaction`, 'JOURNAL_PENDING', { transactionId: plan.transactionId });
    }

    await this.appendUnderFence(plan, 'prepared', { plan });
    const appliedIndexes = new Set<number>();
    try {
      for (let index = 0; index < plan.operations.length; index += 1) {
        await this.applyOperation(plan, plan.operations[index], index, () => appliedIndexes.add(index));
        await this.options.faults?.afterWrite?.(this.context(plan, plan.operations[index], index));
      }
      return await this.withFinalCommit(plan, async () => {
        await this.options.faults?.beforeCommit?.(this.context(plan));
        const commitMismatches = await this.verifyExpectedState(plan, 'after');
        if (commitMismatches.length > 0) {
          await this.append(plan, 'commit-check-failed', { mismatches: commitMismatches });
          throw new TransactionError(
            `Final compare-and-swap failed for ${commitMismatches.map((item) => item.path).join(', ')}`,
            'COMMIT_CHECK_FAILED',
            { transactionId: plan.transactionId },
          );
        }
        const readback = await this.invokeReadback(plan);
        if (!readback.ok) {
          const mismatches = readback.mismatches ?? commitMismatches;
          await this.append(plan, 'readback-mismatch', { mismatches });
          throw new ReadbackMismatchError(mismatches, plan.transactionId);
        }
        await this.append(plan, 'committed');
        return {
          transactionId: plan.transactionId,
          fence: plan.fence,
          planHash: plan.planHash,
          journalPath: this.journalPath,
          status: 'committed' as const,
          restored: false,
        };
      });
    } catch (error) {
      if (isInterruption(error)) {
        await this.appendUnderFence(plan, 'interrupted', { error: describeError(error) }).catch(() => undefined);
        throw error;
      }
      await this.appendUnderFence(plan, 'apply-failed', { error: describeError(error) }).catch(() => undefined);
      return await this.rollbackOrFreeze(plan, error, appliedIndexes);
    }
  }

  /**
   * Restore the oldest pending transaction from its prepare record. Recovery
   * is permitted while globally frozen so the integration owner can clear a
   * freeze only after a verified restoration.
   */
  async recover(transactionId?: string): Promise<RecoveryReceipt> {
    const events = await this.journalState();
    const pending = pendingJournalEvents(events);
    const selected = transactionId === undefined
      ? pending[0]
      : pending.find((event) => event.transactionId === transactionId);
    if (selected === undefined) {
      if (pending.length === 0 && events.some((event) => event.kind === 'frozen')) {
        throw new WriterFrozenError('Writer is frozen and no recoverable transaction was found', transactionId);
      }
      return {
        transactionId: transactionId ?? '',
        fence: 0,
        planHash: '',
        journalPath: this.journalPath,
        status: 'nothing-to-recover',
        restored: false,
      };
    }
    const prepare = [...events]
      .filter((event) => event.transactionId === selected.transactionId && event.plan !== undefined)
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (prepare?.plan === undefined) {
      throw new TransactionError(`Pending transaction ${selected.transactionId} has no durable prepare plan`, 'JOURNAL_CORRUPT', { transactionId: selected.transactionId });
    }
    const plan = prepare.plan;
    assertPlanHash(plan);
    // Recovery must prove the original fence before it appends any recovery
    // event; a stale process cannot claim ownership of the WAL it is about to
    // mutate.
    await this.appendUnderFence(plan, 'recovery-started', { error: { name: 'Recovery', message: 'Restoring pending WAL transaction' } });
    try {
      await this.restore(plan, 'crash recovery');
      await this.appendUnderFence(plan, 'recovered');
      return {
        transactionId: plan.transactionId,
        fence: plan.fence,
        planHash: plan.planHash,
        journalPath: this.journalPath,
        status: 'recovered',
        restored: true,
      };
    } catch (error) {
      throw await this.freeze(plan, error);
    }
  }
}

export async function applyTransaction(
  options: TransactionEngineOptions,
  plan: TransactionPlan,
): Promise<TransactionReceipt> {
  return new TransactionEngine(options).apply(plan);
}

export async function recoverTransaction(
  options: TransactionEngineOptions,
  transactionId?: string,
): Promise<RecoveryReceipt> {
  return new TransactionEngine(options).recover(transactionId);
}
