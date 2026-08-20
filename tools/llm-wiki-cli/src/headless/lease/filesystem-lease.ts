import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';

import {
  LeaseBusyError,
  LeaseFrozenError,
  LeaseError,
  StaleLeaseError,
} from './errors';
import type { FreezeMarker, LeaseHandle, LeaseIdentity, LeaseOptions, LeaseRecord } from './types';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_DIRECTORY_NAME = '.spm-headless-lease';
const PROTOCOL = 'spm-headless-filesystem-lease/v1' as const;
const FREEZE_PROTOCOL = 'spm-headless-filesystem-freeze/v1' as const;

interface FenceCounter {
  protocol: typeof PROTOCOL;
  lastFence: number;
}

interface LockRecord {
  token: string;
  pid: number;
  host: string;
  acquiredAt: number;
}

interface InternalLeaseHandle extends LeaseHandle {
  readonly manager: FilesystemLease;
}

function asErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function comparisonPath(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrWithin(path: string, root: string): boolean {
  const target = comparisonPath(path);
  const base = comparisonPath(root);
  const child = relative(base, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertPathString(value: string, label: string): string {
  if (!value.trim() || value.includes('\0')) {
    throw new LeaseError('LEASE_INVALID', `${label} must be non-empty and NUL-free.`);
  }
  return resolve(value);
}

function isReparsePoint(value: Awaited<ReturnType<typeof lstat>>): boolean {
  const candidate = value as typeof value & {
    isReparsePoint?: () => boolean;
    reparsePoint?: boolean;
  };
  return candidate.isSymbolicLink() || candidate.isReparsePoint?.() === true || candidate.reparsePoint === true;
}

/**
 * Validate the trust boundary without following links. This also supports a
 * not-yet-created metadata root by checking every existing ancestor.
 */
async function assertSafeDirectory(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (asErrorCode(error) === 'ENOENT') break;
      throw error;
    }
    if (isReparsePoint(metadata)) {
      throw new LeaseError('LEASE_INVALID', `${label} contains a symlink/junction/reparse point: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new LeaseError('LEASE_INVALID', `${label} component is not a directory: ${current}`);
    }
    // lstat is intentionally the boundary check here. On managed Windows
    // hosts, realpath of an otherwise ordinary ancestor (for example the
    // user-profile directory) may be denied even though the requested vault
    // is accessible. lstat does not follow a junction/symlink and therefore
    // detects the redirection without needing to canonicalize every parent.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseIdentity(identity: LeaseIdentity): LeaseIdentity {
  if (!isObject(identity) || typeof identity.ownerId !== 'string' || !identity.ownerId.trim()) {
    throw new LeaseError('LEASE_INVALID', 'ownerId must be a non-empty string.');
  }
  if (typeof identity.runId !== 'string' || !identity.runId.trim()) {
    throw new LeaseError('LEASE_INVALID', 'runId must be a non-empty string.');
  }
  return { ownerId: identity.ownerId, runId: identity.runId };
}

function parseLease(value: unknown): LeaseRecord | null {
  if (value === undefined) return null;
  const fence = isObject(value) ? value.fence : undefined;
  const acquiredAt = isObject(value) ? value.acquiredAt : undefined;
  const heartbeatAt = isObject(value) ? value.heartbeatAt : undefined;
  const expiresAt = isObject(value) ? value.expiresAt : undefined;
  if (!isObject(value)
    || value.protocol !== PROTOCOL
    || typeof value.ownerId !== 'string'
    || typeof value.runId !== 'string'
    || !Number.isSafeInteger(fence)
    || (fence as number) < 1
    || !Number.isFinite(acquiredAt)
    || !Number.isFinite(heartbeatAt)
    || !Number.isFinite(expiresAt)) {
    throw new LeaseError('LEASE_INVALID', 'Lease metadata is malformed; refusing acquisition or writes.');
  }
  return {
    protocol: PROTOCOL,
    ownerId: value.ownerId,
    runId: value.runId,
    fence: fence as number,
    acquiredAt: acquiredAt as number,
    heartbeatAt: heartbeatAt as number,
    expiresAt: expiresAt as number,
  };
}

function parseFreeze(value: unknown): FreezeMarker | null {
  if (value === undefined) return null;
  const fence = isObject(value) ? value.fence : undefined;
  const frozenAt = isObject(value) ? value.frozenAt : undefined;
  if (!isObject(value)
    || value.protocol !== FREEZE_PROTOCOL
    || typeof value.ownerId !== 'string'
    || typeof value.runId !== 'string'
    || !Number.isSafeInteger(fence)
    || (fence as number) < 0
    || !Number.isFinite(frozenAt)
    || typeof value.reason !== 'string'
    || !value.reason.trim()) {
    throw new LeaseFrozenError('Freeze metadata is malformed; refusing writer acquisition.');
  }
  return {
    protocol: FREEZE_PROTOCOL,
    ownerId: value.ownerId,
    runId: value.runId,
    fence: fence as number,
    frozenAt: frozenAt as number,
    reason: value.reason,
  };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (asErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Replace a small JSON metadata file without ever exposing a partially-written
 * JSON document. POSIX rename is atomic. Windows does not replace an existing
 * destination with rename, so the destination is moved to a same-directory
 * backup under the already-held mutation lock, then the fully flushed temp
 * file is moved into place; a failed second move restores the backup.
 */
async function replaceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const suffix = `${process.pid}.${randomUUID()}`;
  const temporary = `${path}.${suffix}.tmp`;
  const backup = `${path}.${suffix}.bak`;
  const payload = `${JSON.stringify(value)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = asErrorCode(error);
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
    }

    let movedExisting = false;
    try {
      await rename(path, backup);
      movedExisting = true;
      await rename(temporary, path);
    } catch (error) {
      if (movedExisting) {
        try {
          await rename(backup, path);
        } catch {
          // Preserve the original failure. The backup remains available for
          // operator recovery if Windows refused the restoration move too.
        }
      }
      throw error;
    }
    await unlink(backup).catch(error => {
      if (asErrorCode(error) !== 'ENOENT') throw error;
    });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(error => {
      if (asErrorCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (asErrorCode(error) !== 'ENOENT') throw error;
  });
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return asErrorCode(error) === 'EPERM';
  }
}

export class FilesystemLease {
  readonly root: string;
  readonly metadataRoot: string;
  readonly metadataDirectory: string;
  private readonly leasePath: string;
  private readonly counterPath: string;
  private readonly freezePath: string;
  private readonly lockPath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(root: string, options: LeaseOptions = {}) {
    this.root = assertPathString(root, 'Lease root');
    const directoryName = options.directoryName ?? DEFAULT_DIRECTORY_NAME;
    if (!directoryName.trim()
      || directoryName === '.'
      || directoryName === '..'
      || basename(directoryName) !== directoryName) {
      throw new LeaseError('LEASE_INVALID', 'directoryName must be a single path component.');
    }
    this.metadataRoot = assertPathString(options.metadataRoot ?? this.root, 'metadataRoot');
    this.metadataDirectory = join(this.metadataRoot, directoryName);
    if (options.metadataRoot !== undefined && isSameOrWithin(this.metadataDirectory, this.root)) {
      throw new LeaseError(
        'LEASE_INVALID',
        'metadataRoot must resolve outside the protected lease root.',
      );
    }
    this.leasePath = join(this.metadataDirectory, 'lease.json');
    this.counterPath = join(this.metadataDirectory, 'fence.json');
    this.freezePath = join(this.metadataDirectory, 'freeze.json');
    this.lockPath = join(this.metadataDirectory, '.mutation.lock');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new LeaseError('LEASE_INVALID', 'ttlMs must be a positive safe integer.');
    }
  }

  async acquire(identity: LeaseIdentity): Promise<LeaseHandle> {
    const parsedIdentity = parseIdentity(identity);
    return this.withMutationLock(async () => {
      const freeze = await this.readFreeze();
      if (freeze) throw new LeaseFrozenError(`Writer acquisition is frozen: ${freeze.reason}`);

      const previous = await this.readLease();
      const now = this.now();
      if (previous && previous.expiresAt > now) {
        throw new LeaseBusyError(
          `Writer lease is held by owner ${previous.ownerId} for run ${previous.runId}.`,
        );
      }

      const counter = await readJson<FenceCounter>(this.counterPath);
      if (counter !== undefined
        && (counter.protocol !== PROTOCOL || !Number.isSafeInteger(counter.lastFence) || counter.lastFence < 0)) {
        throw new LeaseError('LEASE_INVALID', 'Fence counter is malformed; refusing acquisition.');
      }
      const lastFence = counter?.lastFence ?? 0;
      const fence = Math.max(lastFence, previous?.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) {
        throw new LeaseError('LEASE_INVALID', 'Fence counter exhausted safe integer range.');
      }
      const record: LeaseRecord = {
        protocol: PROTOCOL,
        ...parsedIdentity,
        fence,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      await replaceJson(this.counterPath, { protocol: PROTOCOL, lastFence: fence });
      await replaceJson(this.leasePath, record);
      return this.handle(record);
    });
  }

  async current(): Promise<LeaseRecord | null> {
    return this.readLease();
  }

  async isFrozen(): Promise<boolean> {
    return (await this.readFreeze()) !== null;
  }

  async clearFreeze(): Promise<void> {
    await this.withMutationLock(async () => {
      await removeIfPresent(this.freezePath);
    });
  }

  async freeze(reason: string, identity: LeaseIdentity = { ownerId: 'operator', runId: 'operator' }): Promise<FreezeMarker> {
    if (!reason.trim()) throw new LeaseError('LEASE_INVALID', 'Freeze reason must be non-empty.');
    const parsedIdentity = parseIdentity(identity);
    return this.withMutationLock(async () => {
      const existing = await this.readFreeze();
      if (existing) return existing;
      const current = await this.readLease();
      const marker: FreezeMarker = {
        protocol: FREEZE_PROTOCOL,
        ...parsedIdentity,
        fence: current?.fence ?? 0,
        frozenAt: this.now(),
        reason: reason.trim(),
      };
      await replaceJson(this.freezePath, marker);
      return marker;
    });
  }

  private handle(record: LeaseRecord): LeaseHandle {
    const manager = this;
    let released = false;
    const handle: InternalLeaseHandle = {
      manager,
      record,
      heartbeat: async () => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        const renewed = await manager.withMutationLock(async () => {
          await manager.assertRecord(record, true);
          const now = manager.now();
          const next: LeaseRecord = {
            ...record,
            heartbeatAt: now,
            expiresAt: now + manager.ttlMs,
          };
          await replaceJson(manager.leasePath, next);
          return next;
        });
        record.heartbeatAt = renewed.heartbeatAt;
        record.expiresAt = renewed.expiresAt;
        return renewed;
      },
      assertFence: async (fence: number | string) => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        const suppliedFence = typeof fence === 'number' ? fence : Number(fence);
        if (!Number.isSafeInteger(suppliedFence) || suppliedFence !== record.fence) {
          throw new StaleLeaseError(`Fence ${String(fence)} is not current for this lease.`);
        }
        await manager.withMutationLock(() => manager.assertRecord(record, true));
      },
      checkBeforeWrite: async () => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        return manager.withMutationLock(() => manager.assertRecord(record, true));
      },
      checkBeforeFinalCommit: async () => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        return manager.withMutationLock(() => manager.assertRecord(record, true));
      },
      withWriteFence: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        return manager.withMutationLock(async () => {
          await manager.assertRecord(record, true);
          return operation();
        });
      },
      withFinalCommit: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        return manager.withMutationLock(async () => {
          await manager.assertRecord(record, true);
          return operation();
        });
      },
      freeze: async (fenceOrReason: number | string, maybeReason?: string) => {
        if (released) throw new StaleLeaseError('This lease handle has already been released.');
        const expectedFence = maybeReason === undefined ? record.fence : Number(fenceOrReason);
        const reason = maybeReason ?? String(fenceOrReason);
        if (!Number.isSafeInteger(expectedFence) || expectedFence !== record.fence) {
          throw new StaleLeaseError(`Fence ${String(fenceOrReason)} is not current for this lease.`);
        }
        return manager.withMutationLock(async () => {
          await manager.assertRecord(record, true);
          return manager.freezeLocked(reason, record);
        });
      },
      release: async () => {
        if (released) return;
        await manager.withMutationLock(async () => {
          await manager.assertRecord(record, true);
          await removeIfPresent(manager.leasePath);
        });
        released = true;
      },
    };
    return handle;
  }

  private async freezeLocked(reason: string, identity: LeaseIdentity & { fence: number }): Promise<FreezeMarker> {
    if (!reason.trim()) throw new LeaseError('LEASE_INVALID', 'Freeze reason must be non-empty.');
    const existing = await this.readFreeze();
    if (existing) return existing;
    const marker: FreezeMarker = {
      protocol: FREEZE_PROTOCOL,
      ownerId: identity.ownerId,
      runId: identity.runId,
      fence: identity.fence,
      frozenAt: this.now(),
      reason: reason.trim(),
    };
    await replaceJson(this.freezePath, marker);
    return marker;
  }

  private async readLease(): Promise<LeaseRecord | null> {
    return parseLease(await readJson(this.leasePath));
  }

  private async readFreeze(): Promise<FreezeMarker | null> {
    return parseFreeze(await readJson(this.freezePath));
  }

  private async assertRecord(expected: LeaseRecord, rejectExpired: boolean): Promise<LeaseRecord> {
    const freeze = await this.readFreeze();
    if (freeze) throw new LeaseFrozenError(`Writer is frozen: ${freeze.reason}`);
    const current = await this.readLease();
    if (!current
      || current.ownerId !== expected.ownerId
      || current.runId !== expected.runId
      || current.fence !== expected.fence
      || (rejectExpired && current.expiresAt <= this.now())) {
      throw new StaleLeaseError(
        `Stale writer lease for owner ${expected.ownerId}, run ${expected.runId}, fence ${expected.fence}.`,
      );
    }
    return current;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await assertSafeDirectory(this.root, 'Lease root');
    await assertSafeDirectory(this.metadataRoot, 'metadataRoot');
    await mkdir(this.metadataDirectory, { recursive: true });
    await assertSafeDirectory(this.root, 'Lease root');
    await assertSafeDirectory(this.metadataRoot, 'metadataRoot');
    if (isSameOrWithin(this.metadataDirectory, this.root)) {
      // This is allowed for the backwards-compatible default location, but
      // must never happen when an explicit external metadataRoot was asked
      // for. The constructor catches the normal case; this guards a path
      // replacement/race before metadata is written.
      const metadataIsExplicit = this.metadataRoot !== this.root;
      if (metadataIsExplicit) {
        throw new LeaseError('LEASE_INVALID', 'metadataRoot resolves inside the protected lease root.');
      }
    }
    const token = randomUUID();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (;;) {
      try {
        handle = await open(this.lockPath, 'wx');
        const lock: LockRecord = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: this.now(),
        };
        await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        break;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = undefined;
        }
        if (asErrorCode(error) !== 'EEXIST') throw error;
        const existing = await readJson<LockRecord>(this.lockPath);
        if (!existing) {
          // The creator owns the exclusive file from the instant open('wx')
          // succeeds, but metadata is flushed in a second operation. Never
          // delete a lock merely because a concurrent reader caught that tiny
          // window. A malformed/partial lock is recoverable only after the
          // stale interval, which also handles a process dying before it could
          // write its metadata.
          let ageMs = 0;
          try {
            ageMs = Date.now() - (await stat(this.lockPath)).mtimeMs;
          } catch (statError) {
            if (asErrorCode(statError) === 'ENOENT') continue;
            throw statError;
          }
          if (ageMs > 5 * 60 * 1_000) {
            await removeIfPresent(this.lockPath);
            continue;
          }
          throw new LeaseBusyError('Lease metadata is being changed by another process.');
        }
        if (!(await isProcessAlive(existing.pid))) {
          await removeIfPresent(this.lockPath);
          continue;
        }
        throw new LeaseBusyError('Lease metadata is being changed by another process.');
      }
    }

    try {
      return await operation();
    } finally {
      const existing = await readJson<LockRecord>(this.lockPath);
      if (existing?.token === token) await removeIfPresent(this.lockPath);
    }
  }
}

export const ExclusiveFilesystemLease = FilesystemLease;
