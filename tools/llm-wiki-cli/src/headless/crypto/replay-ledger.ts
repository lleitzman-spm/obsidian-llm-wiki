import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  DOMAINS,
  digestFromHex,
  digestHex,
  hashCanonical,
} from './domains';
import {
  CryptoVerificationError,
  KeyRegistry,
  signDigest,
  verifyDigest,
  type Signer,
} from './signing';
import type { JsonValue } from './canonical-json';

export interface ReplayEntryInput {
  readonly keyId?: string;
  readonly runId: string;
  readonly nonce: string;
  readonly fence: number | string;
  readonly timestamp?: string;
  readonly payload?: JsonValue;
}

export interface ReplayEntry {
  readonly version: 'spm-brain/replay-entry/v1';
  readonly keyId: string;
  readonly runId: string;
  readonly nonce: string;
  readonly fence: number | string;
  readonly previousHash: string;
  readonly timestamp?: string;
  readonly payload?: JsonValue;
  readonly hash: string;
  readonly signature: string;
}

export interface ReplayLedgerOptions {
  readonly registry?: KeyRegistry;
  readonly initialCheckpointHash?: string;
  readonly requiredScope?: string;
  readonly priorTuples?: Iterable<string>;
  /** Shared atomic lock file required for every append. */
  readonly lockPath?: string;
  /** How long an append waits for another process to release lockPath. */
  readonly lockTimeoutMs?: number;
  /** Poll interval while waiting for lockPath. */
  readonly lockRetryMs?: number;
}

export interface ReplayLedgerVerification {
  readonly ok: true;
  readonly entryCount: number;
  readonly rootHash: string;
  readonly entries: readonly ReplayEntry[];
}

const ZERO_CHECKPOINT = '0'.repeat(64);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;

function assertFence(value: unknown): asserts value is number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Replay ledger fence must be a non-negative safe integer');
    }
    return;
  }
  if (typeof value === 'string' && value.length > 0) return;
  throw new TypeError('Replay ledger fence must be a non-empty string or non-negative safe integer');
}

function assertDuration(value: number | undefined, fallback: number, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return actual;
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

interface LedgerLockHandle {
  readonly path: string;
  readonly token: string;
  readonly fd: number;
}

/**
 * Acquire an explicit cross-process lock using O_EXCL creation.  A stale lock
 * is deliberately not removed automatically: deleting it could allow a
 * still-running writer to fork the signed hash chain.
 */
function acquireLedgerLock(path: string, timeoutMs: number, retryMs: number): LedgerLockHandle {
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      const metadata = Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
      let offset = 0;
      while (offset < metadata.length) {
        offset += writeSync(fd, metadata, offset, metadata.length - offset, null);
      }
      fsyncSync(fd);
      return { path, token, fd };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original error */ }
        try { unlinkSync(path); } catch { /* preserve the original error */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new CryptoVerificationError('ledger-lock-held', `Replay ledger lock is held: ${path}`);
      }
      sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseLedgerLock(lock: LedgerLockHandle): void {
  try {
    closeSync(lock.fd);
  } finally {
    // The lock file is only removed after this process closes its descriptor.
    // A different writer cannot acquire it before unlink completes.
    unlinkSync(lock.path);
  }
}

function appendDurably(filePath: string, line: string): void {
  const fd = openSync(filePath, 'a', 0o600);
  try {
    const bytes = Buffer.from(line, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    }
    // The append is not considered complete until the signed line reaches
    // stable storage.  A reader can therefore observe either the old chain or
    // the complete new entry, never an intentionally successful partial write.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tupleKey(entry: Pick<ReplayEntry, 'keyId' | 'runId' | 'nonce' | 'fence'>): string {
  return JSON.stringify([entry.keyId, entry.runId, entry.nonce, entry.fence]);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CryptoVerificationError('invalid-ledger', `${label} must be lowercase 64-character hexadecimal`);
  }
}

function assertEntryShape(value: unknown): ReplayEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger line must be a JSON object');
  }
  const entry = value as Record<string, unknown>;
  const allowed = new Set(['version', 'keyId', 'runId', 'nonce', 'fence', 'previousHash', 'timestamp', 'payload', 'hash', 'signature']);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) throw new CryptoVerificationError('invalid-ledger', `Unknown replay ledger field: ${key}`);
  }
  if (entry.version !== 'spm-brain/replay-entry/v1') throw new CryptoVerificationError('invalid-ledger', 'Wrong replay ledger version');
  for (const key of ['keyId', 'runId', 'nonce', 'previousHash', 'hash', 'signature'] as const) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new CryptoVerificationError('invalid-ledger', `Replay ledger ${key} must be a non-empty string`);
    }
  }
  assertHash(entry.previousHash, 'Replay ledger previousHash');
  assertHash(entry.hash, 'Replay ledger hash');
  if (typeof entry.fence !== 'number' && typeof entry.fence !== 'string') {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger fence must be a number or string');
  }
  if (typeof entry.fence === 'number' && (!Number.isSafeInteger(entry.fence) || entry.fence < 0)) {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger numeric fence must be a non-negative safe integer');
  }
  if (typeof entry.fence === 'string' && entry.fence.length === 0) {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger fence must not be empty');
  }
  if (entry.timestamp !== undefined && typeof entry.timestamp !== 'string') {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger timestamp must be a string');
  }
  return entry as unknown as ReplayEntry;
}

function entryCore(entry: Pick<ReplayEntry, 'keyId' | 'runId' | 'nonce' | 'fence' | 'previousHash' | 'timestamp' | 'payload'>): JsonValue {
  return {
    version: 'spm-brain/replay-entry/v1',
    keyId: entry.keyId,
    runId: entry.runId,
    nonce: entry.nonce,
    fence: entry.fence,
    previousHash: entry.previousHash,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
  };
}

function readLedger(filePath: string): ReplayEntry[] {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (contents.length === 0) return [];
  const lines = contents.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.some(line => line.trim() === '')) {
    throw new CryptoVerificationError('invalid-ledger', 'Replay ledger contains a blank line');
  }
  return lines.map(line => {
    try {
      return assertEntryShape(JSON.parse(line));
    } catch (error) {
      if (error instanceof CryptoVerificationError) throw error;
      throw new CryptoVerificationError('invalid-ledger', `Invalid replay ledger JSON: ${(error as Error).message}`);
    }
  });
}

function validateSignerScope(signer: Signer, requiredScope: string | undefined): void {
  if (requiredScope !== undefined && !signer.scopes.includes(requiredScope)) {
    throw new CryptoVerificationError('scope-denied', `Signer ${signer.keyId} lacks scope ${requiredScope}`);
  }
}

export class ReplayLedger {
  readonly filePath: string;
  private readonly options: ReplayLedgerOptions;
  private readonly checkpointHash: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(filePath: string, options: ReplayLedgerOptions = {}) {
    this.filePath = filePath;
    this.options = options;
    this.checkpointHash = options.initialCheckpointHash ?? ZERO_CHECKPOINT;
    assertHash(this.checkpointHash, 'Replay ledger initial checkpoint');
    this.lockTimeoutMs = assertDuration(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'Replay ledger lock timeout');
    this.lockRetryMs = assertDuration(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, 'Replay ledger lock retry interval');
    if (options.lockPath !== undefined) {
      if (options.lockPath.length === 0) throw new TypeError('Replay ledger lockPath must be non-empty');
      if (resolve(options.lockPath) === resolve(filePath)) {
        throw new TypeError('Replay ledger lockPath must differ from the ledger file');
      }
    }
  }

  entries(): readonly ReplayEntry[] {
    return readLedger(this.filePath);
  }

  verify(): ReplayLedgerVerification {
    const entries = readLedger(this.filePath);
    let previousHash = this.checkpointHash;
    const tuples = new Set(this.options.priorTuples ?? []);
    for (const entry of entries) {
      if (entry.previousHash !== previousHash) {
        throw new CryptoVerificationError('chain-mismatch', `Replay ledger chain mismatch at ${entry.nonce}`);
      }
      const tuple = tupleKey(entry);
      if (tuples.has(tuple)) throw new CryptoVerificationError('replay', `Replay or duplicate ledger tuple: ${tuple}`);
      tuples.add(tuple);
      const expectedHash = digestHex(hashCanonical(DOMAINS.REPLAY_ENTRY, entryCore(entry)));
      if (entry.hash !== expectedHash) {
        throw new CryptoVerificationError('hash-mismatch', `Replay ledger hash mismatch at ${entry.nonce}`);
      }
      if (this.options.registry) {
        const record = this.options.registry.require(entry.keyId, {
          requiredScope: this.options.requiredScope,
          runId: entry.runId,
          fence: entry.fence,
        });
        if (!verifyDigest(DOMAINS.REPLAY_ENTRY, digestFromHex(entry.hash), entry.signature, record.publicKey)) {
          throw new CryptoVerificationError('invalid-signature', `Replay ledger signature is invalid at ${entry.nonce}`);
        }
      }
      previousHash = entry.hash;
    }
    return { ok: true, entryCount: entries.length, rootHash: previousHash, entries };
  }

  append(input: ReplayEntryInput, signer: Signer): ReplayEntry {
    if (this.options.lockPath === undefined) {
      throw new CryptoVerificationError(
        'ledger-lock-required',
        'Replay ledger append requires an explicit lockPath (or a coordinated lease lock)',
      );
    }
    validateSignerScope(signer, this.options.requiredScope);
    if (input.keyId !== undefined && input.keyId !== signer.keyId) {
      throw new CryptoVerificationError('key-id-mismatch', 'Replay entry key ID does not match signer');
    }
    if (typeof input.runId !== 'string' || input.runId.length === 0 || typeof input.nonce !== 'string' || input.nonce.length === 0) {
      throw new TypeError('Replay entries require non-empty runId and nonce');
    }
    assertFence(input.fence);
    if (input.timestamp !== undefined && typeof input.timestamp !== 'string') {
      throw new TypeError('Replay entry timestamp must be a string');
    }
    if (this.options.registry) {
      this.options.registry.require(signer.keyId, {
        requiredScope: this.options.requiredScope,
        runId: input.runId,
        fence: input.fence,
      });
    }

    const lock = acquireLedgerLock(this.options.lockPath, this.lockTimeoutMs, this.lockRetryMs);
    try {
      // The chain head and duplicate check must be read while the same lock is
      // held as the durable append; otherwise two processes can sign the same
      // previousHash and create a fork.
      const current = this.verify();
      const core: ReplayEntry = {
        version: 'spm-brain/replay-entry/v1',
        keyId: signer.keyId,
        runId: input.runId,
        nonce: input.nonce,
        fence: input.fence,
        previousHash: current.rootHash,
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        hash: '',
        signature: '',
      };
      const tuple = tupleKey(core);
      const priorTuples = new Set(this.options.priorTuples ?? []);
      if (current.entries.some(entry => tupleKey(entry) === tuple) || priorTuples.has(tuple)) {
        throw new CryptoVerificationError('replay', `Replay or duplicate ledger tuple: ${tuple}`);
      }
      const hash = digestHex(hashCanonical(DOMAINS.REPLAY_ENTRY, entryCore(core)));
      const entry: ReplayEntry = {
        ...core,
        hash,
        signature: signDigest(DOMAINS.REPLAY_ENTRY, digestFromHex(hash), signer.privateKey),
      };
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendDurably(this.filePath, `${JSON.stringify(entry)}\n`);
      return entry;
    } finally {
      releaseLedgerLock(lock);
    }
  }

  rootHash(): string {
    return this.verify().rootHash;
  }
}

export function verifyReplayLedgerFile(filePath: string, options: ReplayLedgerOptions = {}): ReplayLedgerVerification {
  return new ReplayLedger(filePath, options).verify();
}

export const ReplayLedgerStore = ReplayLedger;
