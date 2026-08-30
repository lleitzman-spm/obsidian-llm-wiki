import { lstat as fsLstat, realpath as fsRealpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { assertRootPathBinding } from './path-safety';

export interface RootStat {
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
  isReparsePoint?: boolean | (() => boolean);
}

export interface RootProbe {
  lstat?: (path: string) => RootStat | undefined | Promise<RootStat | undefined>;
  realpath?: (path: string) => string | Promise<string>;
}

export interface ResolvedRoot {
  requested: string;
  resolved: string;
}

export interface SafeCopyRoots {
  liveRoot: ResolvedRoot;
  copyRoots: ResolvedRoot[];
  assertion: 'copy-roots-resolved-outside-live-and-sync-roots';
}

export interface SafeCopyRootOptions {
  liveRoot: string;
  copyRoots: readonly string[];
  probe?: RootProbe;
  syncRoots?: readonly string[];
}

const DEFAULT_SYNC_DIRECTORY_NAMES = new Set([
  'onedrive', 'dropbox', 'google drive', 'googledrive', 'icloud drive',
  'sharepoint', 'synced', 'sync-folder',
]);

function absolutePath(path: string): string {
  if (!path || path.includes('\0')) throw new Error('Root path must be non-empty and NUL-free');
  return nodePath.resolve(path);
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function reparse(stat: RootStat): boolean {
  const isLink = stat.isSymbolicLink?.() === true;
  const value = typeof stat.isReparsePoint === 'function' ? stat.isReparsePoint() : stat.isReparsePoint;
  return isLink || value === true;
}

async function getStat(path: string, probe: RootProbe): Promise<RootStat | undefined> {
  if (probe.lstat) return probe.lstat(path);
  try {
    return await fsLstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function getRealpath(path: string, probe: RootProbe): Promise<string> {
  if (probe.realpath) return nodePath.resolve(await probe.realpath(path));
  return nodePath.resolve(await fsRealpath(path));
}

/** Resolve a root while inspecting every existing path component for links/reparse points. */
export async function resolveSafeRoot(requested: string, probe: RootProbe = {}): Promise<ResolvedRoot> {
  const absolute = absolutePath(requested);
  const parsed = nodePath.parse(absolute);
  const remainder = absolute.slice(parsed.root.length).split(nodePath.sep).filter(Boolean);
  let current = parsed.root;
  let deepestExisting = parsed.root;
  let missingParts: string[] = [];
  for (const part of remainder) {
    current = nodePath.join(current, part);
    const stat = await getStat(current, probe);
    if (!stat) {
      // Keep the original component order. Reversing this list would turn
      // `copies/native/vault` into `vault/native/copies` when the root is
      // reconstructed from its deepest existing ancestor.
      missingParts.push(part);
      continue;
    }
    if (missingParts.length > 0) {
      // A later existing component after a missing one is not possible for a
      // normal filesystem path; keeping the check explicit fails closed for a
      // synthetic probe that reports an inconsistent tree.
      throw new Error(`Cannot resolve root path component: ${current}`);
    }
    if (reparse(stat)) throw new Error(`Root contains symlink/reparse point: ${current}`);
    if (stat.isDirectory && !stat.isDirectory()) throw new Error(`Root component is not a directory: ${current}`);
    deepestExisting = current;
  }

  let resolved: string | undefined;
  try {
    // Probe the requested root first. This matters for a not-yet-created copy:
    // a realpath adapter may still know that the requested path aliases a
    // junction/reparse target, while resolving only the deepest existing
    // ancestor would silently lose that fact.
    resolved = await getRealpath(absolute, probe);
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      const resolvedExisting = await getRealpath(deepestExisting, probe);
      resolved = nodePath.resolve(resolvedExisting, ...missingParts);
    } catch (ancestorError) {
      if (!missing(ancestorError)) throw ancestorError;
      resolved = nodePath.resolve(deepestExisting, ...missingParts);
    }
  }
  if (!resolved) throw new Error(`Unable to resolve root: ${absolute}`);
  return { requested: absolute, resolved: nodePath.resolve(resolved) };
}

function comparisonPath(path: string): string {
  const normalized = nodePath.normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrWithin(path: string, root: string): boolean {
  const target = comparisonPath(path);
  const base = comparisonPath(root);
  const relative = nodePath.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

function syncMarker(path: string): boolean {
  return path.split(/[\\/]/).some(part => DEFAULT_SYNC_DIRECTORY_NAMES.has(part.toLowerCase()));
}

function assertDistinct(copyRoots: readonly ResolvedRoot[]): void {
  for (let i = 0; i < copyRoots.length; i += 1) {
    for (let j = i + 1; j < copyRoots.length; j += 1) {
      if (isSameOrWithin(copyRoots[i].resolved, copyRoots[j].resolved) || isSameOrWithin(copyRoots[j].resolved, copyRoots[i].resolved)) {
        throw new Error(`Copied-vault roots overlap: ${copyRoots[i].resolved} and ${copyRoots[j].resolved}`);
      }
    }
  }
}

export async function assertSafeCopyRoots(options: SafeCopyRootOptions): Promise<SafeCopyRoots> {
  const probe = options.probe ?? {};
  const liveRoot = await resolveSafeRoot(options.liveRoot, probe);
  const copyRoots = await Promise.all(options.copyRoots.map(path => resolveSafeRoot(path, probe)));
  const syncRoots = await Promise.all((options.syncRoots ?? []).map(path => resolveSafeRoot(path, probe)));
  await assertRootPathBinding(liveRoot, probe, 'Live root');
  await Promise.all(copyRoots.map(root => assertRootPathBinding(root, probe, 'Copied-vault root')));
  await Promise.all(syncRoots.map(root => assertRootPathBinding(root, probe, 'Sync root')));
  for (const copyRoot of copyRoots) {
    if (
      isSameOrWithin(copyRoot.resolved, liveRoot.resolved)
      || isSameOrWithin(copyRoot.requested, liveRoot.requested)
    ) {
      throw new Error(`Copied-vault root resolves inside the live vault: ${copyRoot.resolved}`);
    }
    if (
      syncMarker(copyRoot.resolved)
      || syncMarker(copyRoot.requested)
      || syncRoots.some(syncRoot =>
        isSameOrWithin(copyRoot.resolved, syncRoot.resolved)
        || isSameOrWithin(copyRoot.requested, syncRoot.requested))
    ) {
      throw new Error(`Copied-vault root resolves inside a sync folder: ${copyRoot.resolved}`);
    }
  }
  assertDistinct(copyRoots);
  return {
    liveRoot,
    copyRoots,
    assertion: 'copy-roots-resolved-outside-live-and-sync-roots',
  };
}

export const validateCopyRoots = assertSafeCopyRoots;

export function pathsOverlap(left: string, right: string): boolean {
  return isSameOrWithin(absolutePath(left), absolutePath(right)) || isSameOrWithin(absolutePath(right), absolutePath(left));
}
