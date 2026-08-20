import { createHash, randomUUID } from 'node:crypto';
import * as nodePath from 'node:path';

import type {
  ByteInput,
  FileScope,
  FileState,
  SnapshotFile,
  StagedFile,
  TransactionOperation,
  TransactionPlan,
  TransactionPlanInput,
} from './types';
import { StalePreconditionError } from './types';

export const TRANSACTION_PLAN_VERSION = 'transaction-plan/v1' as const;

/** Make a private copy so a caller cannot mutate staged or restoration bytes. */
export function toBytes(value: ByteInput): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashNullable(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : hashBytes(bytes);
}

export function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Canonicalise a vault-relative path. A plan must never be able to escape the
 * supplied vault root, and slash style should not create duplicate operations
 * for the same file on Windows.
 */
export function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('Transaction path must be a non-empty relative path');
  }
  const slashPath = value.replaceAll('\\', '/');
  // A drive-relative path such as `D:notes.md` is not absolute, but Windows
  // resolves it against the process' current D: drive directory. Colons in
  // any target component also enable NTFS alternate-data-stream syntax
  // (`note.md::$DATA`), so the generic transaction contract rejects them.
  if (slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath) || slashPath.includes(':')) {
    throw new Error(`Transaction path must be relative: ${value}`);
  }
  const normalized = nodePath.posix.normalize(slashPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Transaction path escapes the vault: ${value}`);
  }
  return normalized;
}

function state(bytes: Uint8Array | null): FileState {
  const copied = bytes === null ? null : new Uint8Array(bytes);
  return {
    exists: copied !== null,
    hash: hashNullable(copied),
    bytes: copied,
  };
}

interface NormalizedSnapshot {
  path: string;
  bytes: Uint8Array | null;
  scope: FileScope;
}

interface NormalizedDesired extends Omit<NormalizedSnapshot, 'scope'> {
  scope?: FileScope;
  hasPrecondition: boolean;
  preconditionHash?: string | null;
}

function mapEntries(
  input: Iterable<SnapshotFile> | ReadonlyMap<string, ByteInput | null>,
): Array<SnapshotFile | StagedFile> {
  if (input instanceof Map) {
    return [...input.entries()].map(([path, bytes]) => ({ path, bytes }));
  }
  return [...input] as Array<SnapshotFile | StagedFile>;
}

function normalizeCurrent(input: TransactionPlanInput['current']): Map<string, NormalizedSnapshot> {
  const result = new Map<string, NormalizedSnapshot>();
  for (const entry of mapEntries(input)) {
    const path = normalizeRelativePath(entry.path);
    if (result.has(path)) throw new Error(`Duplicate current snapshot path: ${path}`);
    result.set(path, {
      path,
      bytes: entry.bytes === null ? null : toBytes(entry.bytes),
      scope: entry.scope ?? 'page',
    });
  }
  return result;
}

function normalizeDesired(input: TransactionPlanInput['desired']): Map<string, NormalizedDesired> {
  const result = new Map<string, NormalizedDesired>();
  for (const raw of mapEntries(input)) {
    const entry = raw as StagedFile;
    const path = normalizeRelativePath(entry.path);
    if (result.has(path)) throw new Error(`Duplicate desired path: ${path}`);
    result.set(path, {
      path,
      bytes: entry.bytes === null ? null : toBytes(entry.bytes),
      scope: entry.scope,
      hasPrecondition: Object.prototype.hasOwnProperty.call(entry, 'preconditionHash'),
      preconditionHash: entry.preconditionHash,
    });
  }
  return result;
}

function canonicalPlanData(
  transactionId: string,
  fence: TransactionPlanInput['fence'],
  operations: readonly TransactionOperation[],
): string {
  const serializable = {
    version: TRANSACTION_PLAN_VERSION,
    transactionId,
    fence,
    operations: operations.map((operation) => ({
      kind: operation.kind,
      path: operation.path,
      scope: operation.scope,
      preconditionHash: operation.preconditionHash,
      before: {
        exists: operation.before.exists,
        hash: operation.before.hash,
        bytes: operation.before.bytes === null ? null : Buffer.from(operation.before.bytes).toString('base64'),
      },
      after: {
        exists: operation.after.exists,
        hash: operation.after.hash,
        bytes: operation.after.bytes === null ? null : Buffer.from(operation.after.bytes).toString('base64'),
      },
    })),
  };
  return JSON.stringify(serializable);
}

/** Stable plan digest used by the WAL and later receipts. */
export function computePlanHash(plan: Pick<TransactionPlan, 'transactionId' | 'fence' | 'operations'>): string {
  return hashBytes(new TextEncoder().encode(canonicalPlanData(plan.transactionId, plan.fence, plan.operations)));
}

/**
 * Build a complete deterministic create/replace/delete plan from a captured
 * target snapshot and staged desired state. Unchanged files are omitted, but
 * every emitted operation carries both the old bytes and staged bytes.
 */
export function createTransactionPlan(input: TransactionPlanInput): TransactionPlan {
  const current = normalizeCurrent(input.current);
  const desired = normalizeDesired(input.desired);
  const transactionId = input.transactionId?.trim() || `tx-${randomUUID()}`;
  if (!transactionId) throw new Error('Transaction ID must not be empty');

  const operations: TransactionOperation[] = [];
  for (const target of desired.values()) {
    const before = current.get(target.path);
    const beforeBytes = before?.bytes ?? null;
    const beforeState = state(beforeBytes);
    const expectedHash = target.hasPrecondition ? target.preconditionHash ?? null : beforeState.hash;

    // A caller-provided precondition is checked against the captured snapshot
    // here as well as immediately before apply. This catches an already stale
    // manifest without weakening the later compare-and-swap boundary.
    if (target.hasPrecondition && expectedHash !== beforeState.hash) {
      throw new StalePreconditionError(target.path, expectedHash, beforeState.hash, transactionId);
    }

    const afterState = state(target.bytes);
    if (bytesEqual(beforeBytes, target.bytes)) continue;

    const kind = beforeState.exists ? (afterState.exists ? 'replace' : 'delete') : 'create';
    operations.push({
      kind,
      path: target.path,
      scope: target.scope ?? before?.scope ?? 'page',
      preconditionHash: expectedHash,
      before: beforeState,
      after: afterState,
    });
  }

  operations.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const plan: TransactionPlan = {
    version: TRANSACTION_PLAN_VERSION,
    transactionId,
    fence: input.fence,
    operations,
    planHash: '',
  };
  plan.planHash = computePlanHash(plan);
  return plan;
}

/** Readable alias for integration callers that prefer the verb `plan`. */
export const planTransaction = createTransactionPlan;
export const buildTransactionPlan = createTransactionPlan;

/** Serialize a plan for a journal without exposing mutable Uint8Arrays. */
export function serializePlan(plan: TransactionPlan): TransactionPlan {
  return {
    ...plan,
    operations: plan.operations.map((operation) => ({
      ...operation,
      before: { ...operation.before, bytes: operation.before.bytes === null ? null : new Uint8Array(operation.before.bytes) },
      after: { ...operation.after, bytes: operation.after.bytes === null ? null : new Uint8Array(operation.after.bytes) },
    })),
  };
}

/** Validate a plan digest after parsing a WAL or crossing an integration seam. */
export function assertPlanHash(plan: TransactionPlan): void {
  const computed = computePlanHash(plan);
  if (computed !== plan.planHash) throw new Error(`Transaction plan hash mismatch for ${plan.transactionId}`);
}
