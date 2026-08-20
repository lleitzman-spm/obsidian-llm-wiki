import { lstat, mkdir, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { TransactionFileSystem } from './types';
import { hashNullable, normalizeRelativePath } from './planner';
import { MutationBoundaryError, StalePreconditionError } from './types';

interface PathIdentity {
  readonly path: string;
  readonly exists: boolean;
  readonly isDirectory?: boolean;
  readonly canonical?: string;
  /** Device + file index. Unlike timestamps, this is not changed by writes. */
  readonly fileId?: string;
}

interface TraversalSnapshot {
  readonly target: string;
  readonly entries: readonly PathIdentity[];
}

function isReparsePoint(metadata: Awaited<ReturnType<typeof lstat>>): boolean {
  const candidate = metadata as typeof metadata & {
    isReparsePoint?: () => boolean;
    reparsePoint?: boolean;
  };
  return candidate.isSymbolicLink() || candidate.isReparsePoint?.() === true || candidate.reparsePoint === true;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = nodePath.resolve(left);
  const normalizedRight = nodePath.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function fileId(metadata: Awaited<ReturnType<typeof lstat>>, path: string): string {
  const device = metadata.dev;
  const inode = metadata.ino;
  // Node exposes the Windows volume serial/file index through dev/ino on the
  // supported runtimes. If a runtime cannot provide either half, continuing
  // would turn the identity check into a path-only check, so fail closed.
  if (!Number.isFinite(device) || !Number.isFinite(inode) || (device === 0 && inode === 0)) {
    throw new Error(`Unable to establish stable filesystem identity for ${path}`);
  }
  return `${String(device)}:${String(inode)}`;
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  if (left.path !== right.path || left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return left.isDirectory === right.isDirectory &&
    left.canonical !== undefined && right.canonical !== undefined &&
    sameCanonicalPath(left.canonical, right.canonical) &&
    left.fileId !== undefined && right.fileId !== undefined &&
    left.fileId === right.fileId;
}

/** Compare an inode/file-index across a same-directory rename. */
function sameFileIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.exists && right.exists &&
    left.isDirectory === right.isDirectory &&
    left.fileId !== undefined && right.fileId !== undefined &&
    left.fileId === right.fileId;
}

function leaf(snapshot: TraversalSnapshot): PathIdentity {
  return snapshot.entries[snapshot.entries.length - 1];
}

/**
 * Small rooted filesystem adapter used by the writer. It intentionally does
 * not expose arbitrary absolute paths to the transaction implementation.
 */
export class NodeTransactionFileSystem implements TransactionFileSystem {
  readonly rootDir: string;
  private rootSafetyCheck: Promise<void> | undefined;
  private static readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(rootDir: string) {
    this.rootDir = nodePath.resolve(rootDir);
  }

  private resolve(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const resolved = nodePath.resolve(this.rootDir, ...normalized.split('/'));
    const relative = nodePath.relative(this.rootDir, resolved);
    if (relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
      throw new Error(`Transaction path escapes root: ${relativePath}`);
    }
    return resolved;
  }

  private async establishRootSafety(): Promise<void> {
    // The supplied root is the trust boundary. Do not probe ancestors above
    // it: on managed Windows hosts those parent directories may deny
    // realpath/lstat even though the temporary vault itself is safe.
    let rootMetadata: Awaited<ReturnType<typeof lstat>>;
    try {
      rootMetadata = await lstat(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (isReparsePoint(rootMetadata)) {
      throw new Error(`Refusing symlink/junction/reparse root: ${this.rootDir}`);
    }
    try {
      const canonicalRoot = await realpath(this.rootDir);
      if (!sameCanonicalPath(canonicalRoot, this.rootDir)) throw new Error(`Refusing reparse root: ${this.rootDir}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing reparse root:')) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async readIdentity(path: string): Promise<PathIdentity> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false };
      throw error;
    }

    if (isReparsePoint(metadata)) throw new Error(`Refusing symlink/junction/reparse traversal: ${path}`);
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      // A path that existed for lstat but disappeared before realpath is not
      // safely classifiable. Treat it as a race, never as a harmless miss.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Filesystem path changed while checking: ${path}`);
      }
      throw error;
    }
    if (!sameCanonicalPath(canonical, path)) throw new Error(`Refusing reparse traversal: ${path}`);

    return {
      path,
      exists: true,
      isDirectory: metadata.isDirectory(),
      canonical,
      fileId: fileId(metadata, path),
    };
  }

  /** Capture every existing component, without following any reparse point. */
  private async inspectTraversal(target: string): Promise<TraversalSnapshot> {
    if (this.rootSafetyCheck === undefined) this.rootSafetyCheck = this.establishRootSafety();
    await this.rootSafetyCheck;

    const relativeTarget = nodePath.relative(this.rootDir, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relativeTarget)) {
      throw new Error(`Transaction path escapes root: ${target}`);
    }

    const entries: PathIdentity[] = [];
    let current = this.rootDir;
    const root = await this.readIdentity(current);
    entries.push(root);
    if (!root.exists) return { target, entries };
    if (!root.isDirectory) throw new Error(`Transaction root is not a directory: ${this.rootDir}`);

    const components = relativeTarget.split(nodePath.sep).filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      current = nodePath.join(current, component);
      const entry = await this.readIdentity(current);
      entries.push(entry);
      if (!entry.exists) break;
      if (index < components.length - 1 && !entry.isDirectory) {
        throw new Error(`Transaction path component is not a directory: ${current}`);
      }
    }
    return { target, entries };
  }

  /**
   * Compare the stable identities captured before a mutation with a fresh
   * traversal. Directory contents are intentionally not part of identity, so
   * creating the requested missing parent directories does not look like a
   * replacement of an existing ancestor.
   */
  private assertExistingEntriesStable(before: TraversalSnapshot, after: TraversalSnapshot, label: string): void {
    for (const prior of before.entries) {
      if (!prior.exists) continue;
      const current = after.entries.find((entry) => entry.path === prior.path);
      if (current === undefined || !sameIdentity(prior, current)) {
        throw new MutationBoundaryError(
          label,
          `Filesystem path identity changed during transaction: ${label}`,
          false,
        );
      }
    }
  }

  private async assertSnapshotStable(snapshot: TraversalSnapshot, label: string): Promise<TraversalSnapshot> {
    const current = await this.inspectTraversal(snapshot.target);
    if (snapshot.entries.length !== current.entries.length || snapshot.entries.some((entry, index) => !sameIdentity(entry, current.entries[index]))) {
      throw new MutationBoundaryError(
        label,
        `Filesystem path identity changed during transaction: ${label}`,
        false,
      );
    }
    return current;
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queueKey = process.platform === 'win32' ? this.rootDir.toLowerCase() : this.rootDir;
    const previous = NodeTransactionFileSystem.mutationQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => slot);
    NodeTransactionFileSystem.mutationQueues.set(queueKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (NodeTransactionFileSystem.mutationQueues.get(queueKey) === current) {
        NodeTransactionFileSystem.mutationQueues.delete(queueKey);
      }
    }
  }

  private async readStableAbsolute(target: string, snapshot: TraversalSnapshot): Promise<Uint8Array | null> {
    const targetEntry = leaf(snapshot);
    if (!targetEntry.exists) return null;
    const handle = await open(target, 'r');
    try {
      const handleMetadata = await handle.stat();
      const handleId = fileId(handleMetadata, target);
      if (targetEntry.fileId !== handleId || targetEntry.isDirectory !== handleMetadata.isDirectory()) {
        throw new Error(`Filesystem path identity changed while opening: ${target}`);
      }
      await this.assertSnapshotStable(snapshot, target);
      const bytes = new Uint8Array(await handle.readFile());
      const after = await this.inspectTraversal(target);
      if (!sameIdentity(targetEntry, leaf(after))) {
        throw new Error(`Filesystem path identity changed while reading: ${target}`);
      }
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async assertPrecondition(
    relativePath: string,
    target: string,
    expectedHash: string | null | undefined,
  ): Promise<void> {
    if (expectedHash === undefined) return;
    const snapshot = await this.inspectTraversal(target);
    const actualHash = hashNullable(await this.readStableAbsolute(target, snapshot));
    if (actualHash !== expectedHash) throw new StalePreconditionError(relativePath, expectedHash, actualHash);
  }

  private async cleanupTemporary(
    temporary: string,
    parentSnapshot: TraversalSnapshot | undefined,
    temporaryIdentity: PathIdentity | undefined,
  ): Promise<void> {
    // Never clean up by blindly following the name after a traversal race. A
    // leftover temp file is safer than unlinking through a newly installed
    // junction; the caller's failure remains the authoritative result.
    if (parentSnapshot === undefined || temporaryIdentity === undefined) return;
    try {
      await this.assertSnapshotStable(parentSnapshot, parentSnapshot.target);
      const current = await this.inspectTraversal(temporary);
      if (!sameIdentity(temporaryIdentity, leaf(current))) return;
      await unlink(temporary);
    } catch {
      // Preserve the original failure and refuse unsafe cleanup.
    }
  }

  async read(relativePath: string): Promise<Uint8Array | null> {
    const target = this.resolve(relativePath);
    const snapshot = await this.inspectTraversal(target);
    return this.readStableAbsolute(target, snapshot);
  }

  async write(relativePath: string, bytes: Uint8Array, preconditionHash?: string | null): Promise<void> {
    return this.withMutation(async () => {
      const target = this.resolve(relativePath);
      const parent = nodePath.dirname(target);
      const beforeParent = await this.inspectTraversal(parent);
      if (!beforeParent.entries[0]?.exists) throw new Error(`Transaction root does not exist: ${this.rootDir}`);

      await mkdir(parent, { recursive: true });
      const parentSnapshot = await this.inspectTraversal(parent);
      this.assertExistingEntriesStable(beforeParent, parentSnapshot, parent);

      const targetSnapshot = await this.inspectTraversal(target);
      const targetBefore = leaf(targetSnapshot);
      await this.assertPrecondition(relativePath, target, preconditionHash);
      await this.assertSnapshotStable(parentSnapshot, parent);

      // Rename within the target directory gives the writer an atomic file
      // replacement boundary. wx avoids a reused staging name replacing a
      // file from an interrupted or concurrent run.
      const temporary = `${target}.transaction-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let temporaryIdentity: PathIdentity | undefined;
      let renamed = false;
      try {
        const handle = await open(temporary, 'wx');
        try {
          const opened = await this.inspectTraversal(temporary);
          temporaryIdentity = leaf(opened);
          const handleId = fileId(await handle.stat(), temporary);
          if (temporaryIdentity.fileId !== handleId) {
            throw new MutationBoundaryError(relativePath, `Temporary file identity changed: ${relativePath}`, true);
          }
          this.assertExistingEntriesStable(parentSnapshot, opened, parent);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }

        await this.assertSnapshotStable(parentSnapshot, parent);
        const currentTarget = await this.inspectTraversal(target);
        if (!sameIdentity(targetBefore, leaf(currentTarget))) {
          throw new MutationBoundaryError(relativePath, `Target identity changed before rename: ${relativePath}`, false);
        }
        await this.assertPrecondition(relativePath, target, preconditionHash);
        const currentTemporary = await this.inspectTraversal(temporary);
        if (!sameIdentity(temporaryIdentity, leaf(currentTemporary))) {
          throw new MutationBoundaryError(relativePath, `Temporary file identity changed before rename: ${relativePath}`, false);
        }

        await rename(temporary, target);
        renamed = true;

        const afterParent = await this.inspectTraversal(parent);
        if (!sameIdentity(leaf(parentSnapshot), leaf(afterParent))) {
          throw new MutationBoundaryError(relativePath, `Parent identity changed after rename: ${relativePath}`, true);
        }
        const afterTarget = await this.inspectTraversal(target);
        if (!sameFileIdentity(temporaryIdentity, leaf(afterTarget))) {
          throw new MutationBoundaryError(relativePath, `Target identity changed after rename: ${relativePath}`, true);
        }
      } catch (error) {
        if (!renamed) await this.cleanupTemporary(temporary, parentSnapshot, temporaryIdentity);
        throw error;
      }
    });
  }

  async remove(relativePath: string, preconditionHash?: string | null): Promise<void> {
    return this.withMutation(async () => {
      const target = this.resolve(relativePath);
      const parent = nodePath.dirname(target);
      const parentSnapshot = await this.inspectTraversal(parent);
      if (!parentSnapshot.entries[0]?.exists) throw new Error(`Transaction root does not exist: ${this.rootDir}`);
      const targetSnapshot = await this.inspectTraversal(target);
      const targetBefore = leaf(targetSnapshot);
      if (!targetBefore.exists) {
        if (preconditionHash === null) return;
        throw new StalePreconditionError(relativePath, preconditionHash ?? null, null);
      }
      await this.assertPrecondition(relativePath, target, preconditionHash);
      this.assertExistingEntriesStable(parentSnapshot, targetSnapshot, parent);

      let unlinked = false;
      try {
        await unlink(target);
        unlinked = true;
        const afterParent = await this.inspectTraversal(parent);
        if (!sameIdentity(leaf(parentSnapshot), leaf(afterParent))) {
          throw new MutationBoundaryError(relativePath, `Parent identity changed after unlink: ${relativePath}`, true);
        }
        const afterTarget = await this.inspectTraversal(target);
        if (leaf(afterTarget).exists) {
          throw new MutationBoundaryError(relativePath, `Target still exists after unlink: ${relativePath}`, true);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !unlinked) {
          throw new MutationBoundaryError(relativePath, `Target disappeared before unlink: ${relativePath}`, false);
        }
        throw error;
      }
    });
  }
}

/** Read the hash without allowing a missing path to become an exception. */
export async function readFileHash(
  fileSystem: TransactionFileSystem,
  relativePath: string,
  hash: (bytes: Uint8Array) => string,
): Promise<string | null> {
  const bytes = await fileSystem.read(relativePath);
  return bytes === null ? null : hash(bytes);
}

/** Useful for tests and integrations that want a clean rooted target. */
export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

/**
 * The adapter itself never reads or writes the journal. Keeping this helper
 * separate makes it possible to use a test filesystem while retaining the
 * durable journal implementation.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(nodePath.dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
