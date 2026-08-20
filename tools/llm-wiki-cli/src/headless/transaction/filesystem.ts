import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { TransactionFileSystem } from './types';
import { normalizeRelativePath } from './planner';

/**
 * Small rooted filesystem adapter used by the writer. It intentionally does
 * not expose arbitrary absolute paths to the transaction implementation.
 */
export class NodeTransactionFileSystem implements TransactionFileSystem {
  readonly rootDir: string;
  private rootSafetyCheck: Promise<void> | undefined;

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
    const rootCandidate = rootMetadata as typeof rootMetadata & {
      isReparsePoint?: () => boolean;
      reparsePoint?: boolean;
    };
    if (rootCandidate.isSymbolicLink() || rootCandidate.isReparsePoint?.() === true || rootCandidate.reparsePoint === true) {
      throw new Error(`Refusing symlink/junction/reparse root: ${this.rootDir}`);
    }
    try {
      const canonicalRoot = await realpath(this.rootDir);
      const sameRoot = process.platform === 'win32'
        ? nodePath.resolve(canonicalRoot).toLowerCase() === nodePath.resolve(this.rootDir).toLowerCase()
        : nodePath.resolve(canonicalRoot) === nodePath.resolve(this.rootDir);
      if (!sameRoot) throw new Error(`Refusing reparse root: ${this.rootDir}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing reparse root:')) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async assertSafeTraversal(target: string): Promise<void> {
    if (this.rootSafetyCheck === undefined) this.rootSafetyCheck = this.establishRootSafety();
    await this.rootSafetyCheck;

    // Re-check the root itself on each operation so a root replaced after the
    // one-time canonicalization cannot turn into a trusted junction later.
    let rootMetadata: Awaited<ReturnType<typeof lstat>>;
    try {
      rootMetadata = await lstat(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const rootCandidate = rootMetadata as typeof rootMetadata & {
      isReparsePoint?: () => boolean;
      reparsePoint?: boolean;
    };
    if (rootCandidate.isSymbolicLink() || rootCandidate.isReparsePoint?.() === true || rootCandidate.reparsePoint === true) {
      throw new Error(`Refusing symlink/junction/reparse root: ${this.rootDir}`);
    }

    const relativeTarget = nodePath.relative(this.rootDir, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relativeTarget)) {
      throw new Error(`Transaction path escapes root: ${target}`);
    }
    let current = this.rootDir;
    const components = relativeTarget.split(nodePath.sep).filter(Boolean);
    for (const component of components) {
      current = nodePath.join(current, component);
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }

      const candidate = metadata as typeof metadata & {
        isReparsePoint?: () => boolean;
        reparsePoint?: boolean;
      };
      const reparse = candidate.isSymbolicLink() ||
        candidate.isReparsePoint?.() === true ||
        candidate.reparsePoint === true;
      if (reparse) throw new Error(`Refusing symlink/junction/reparse traversal: ${current}`);

      // Some Windows reparse types do not expose a symbolic-link bit through
      // lstat(). realpath() is a second guard: any redirection is rejected,
      // even when it remains inside the vault root.
      try {
        const canonical = await realpath(current);
        const same = process.platform === 'win32'
          ? nodePath.resolve(canonical).toLowerCase() === nodePath.resolve(current).toLowerCase()
          : nodePath.resolve(canonical) === nodePath.resolve(current);
        if (!same) throw new Error(`Refusing reparse traversal: ${current}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Refusing reparse traversal:')) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  async read(relativePath: string): Promise<Uint8Array | null> {
    const target = this.resolve(relativePath);
    await this.assertSafeTraversal(target);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(relativePath: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(relativePath);
    const parent = nodePath.dirname(target);
    await this.assertSafeTraversal(parent);
    await mkdir(parent, { recursive: true });
    await this.assertSafeTraversal(target);
    // Rename within the target directory gives the writer an atomic file
    // replacement boundary. The random suffix prevents concurrent test runs
    // or an interrupted process from sharing a staging name.
    const temporary = `${target}.transaction-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertSafeTraversal(target);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(relativePath: string): Promise<void> {
    const target = this.resolve(relativePath);
    await this.assertSafeTraversal(target);
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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
