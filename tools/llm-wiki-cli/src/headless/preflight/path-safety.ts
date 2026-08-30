import {
  lstat as fsLstat,
  mkdir,
  realpath as fsRealpath,
  rmdir,
} from 'node:fs/promises';
import * as nodePath from 'node:path';

export interface PathSafetyStat {
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
  isReparsePoint?: boolean | (() => boolean);
  dev?: number | bigint;
  ino?: number | bigint;
  mode?: number | bigint;
  birthtimeMs?: number;
}

export interface PathSafetyProbe {
  lstat?: (path: string) => PathSafetyStat | undefined | Promise<PathSafetyStat | undefined>;
  realpath?: (path: string) => string | Promise<string>;
}

export interface RootPathBinding {
  readonly requested: string;
  readonly resolved: string;
}

export interface RootBinding {
  readonly requested: string;
  readonly resolved: string;
  readonly identity: string;
}

export interface RootRealpathCheck {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const ROOT_IDENTITY_FIELDS = ['dev', 'ino', 'mode', 'birthtimeMs'] as const;

function pathApi(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function absolutePath(value: string, platform = process.platform): string {
  if (!value || value.includes('\0')) throw new Error('Root path must be non-empty and NUL-free');
  return pathApi(platform).resolve(value);
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isReparse(stat: PathSafetyStat): boolean {
  const symbolic = stat.isSymbolicLink?.() === true;
  const reparse = typeof stat.isReparsePoint === 'function' ? stat.isReparsePoint() : stat.isReparsePoint;
  return symbolic || reparse === true;
}

function statIdentity(stat: PathSafetyStat | undefined): string | undefined {
  if (!stat) return undefined;
  const values = ROOT_IDENTITY_FIELDS.map(field => stat[field]);
  if (values.some(value => value === undefined || (typeof value === 'number' && !Number.isFinite(value)))) return undefined;
  return values.map(value => `${typeof value}:${String(value)}`).join('|');
}

async function statAt(path: string, probe: PathSafetyProbe): Promise<PathSafetyStat | undefined> {
  try {
    return await (probe.lstat ? probe.lstat(path) : fsLstat(path));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function realpathAt(path: string, probe: PathSafetyProbe): Promise<string> {
  return nodePath.resolve(await (probe.realpath ? probe.realpath(path) : fsRealpath(path)));
}

/** Compare root identities using Windows path semantics even in cross-platform tests. */
export function sameRootPath(left: string, right: string, platform = process.platform): boolean {
  const api = pathApi(platform);
  let normalizeLeft = api.normalize(api.resolve(left));
  let normalizeRight = api.normalize(api.resolve(right));
  if (platform === 'win32') {
    normalizeLeft = normalizeLeft.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase();
    normalizeRight = normalizeRight.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase();
  }
  return normalizeLeft === normalizeRight;
}

function pathComponents(absolute: string, platform = process.platform): string[] {
  const api = pathApi(platform);
  const parsed = api.parse(absolute);
  return absolute.slice(parsed.root.length).split(api.sep).filter(Boolean);
}

/**
 * Inspect every existing component and perform realpath checks before and
 * after the inspection. A path-based API cannot make an uncooperative rename
 * impossible, so any observed alias or component replacement is fatal.
 */
export async function assertNoReparseAncestors(
  path: string,
  probe: PathSafetyProbe = {},
  label = 'Root path',
): Promise<RootRealpathCheck> {
  const absolute = absolutePath(path);
  const api = pathApi(process.platform);
  const parsed = api.parse(absolute);
  let current = parsed.root;
  let deepestExisting = parsed.root;
  for (const part of pathComponents(absolute)) {
    current = api.join(current, part);
    const stat = await statAt(current, probe);
    if (!stat) break;
    if (stat.isDirectory && !stat.isDirectory()) throw new Error(`${label} ancestor is not a directory: ${current}`);
    if (isReparse(stat)) throw new Error(`${label} contains a symlink/reparse ancestor: ${current}`);
    deepestExisting = current;
  }
  // A realpath of the deepest existing component resolves all of its
  // ancestors, so one pre/post pair catches an unflagged junction while
  // avoiding redundant permission-sensitive calls on every parent directory.
  const before = await realpathAt(deepestExisting, probe);
  const after = await realpathAt(deepestExisting, probe);
  if (!sameRootPath(before, deepestExisting) || !sameRootPath(after, deepestExisting)) {
    throw new Error(`${label} resolves through a symlink/junction/reparse ancestor: ${deepestExisting}`);
  }
  if (!sameRootPath(before, after)) throw new Error(`${label} realpath changed during validation: ${deepestExisting}`);
  return { path: deepestExisting, before, after };
}

function assertPlainDirectory(path: string, stat: PathSafetyStat | undefined, label: string): asserts stat is PathSafetyStat {
  if (!stat || isReparse(stat) || stat.isDirectory?.() !== true) {
    throw new Error(`${label} is not a plain directory: ${path}`);
  }
  if (!statIdentity(stat)) throw new Error(`${label} has no stable filesystem identity: ${path}`);
}

/** Capture a directory's canonical path and stable identity for later CAS. */
export async function captureRootBinding(
  path: string,
  probe: PathSafetyProbe = {},
  label = 'Root path',
): Promise<RootBinding> {
  const requested = absolutePath(path);
  const realpathCheck = await assertNoReparseAncestors(requested, probe, label);
  if (!sameRootPath(realpathCheck.path, requested)) throw new Error(`${label} does not exist: ${requested}`);
  const statBefore = await statAt(requested, probe);
  assertPlainDirectory(requested, statBefore, label);
  const statAfter = await statAt(requested, probe);
  assertPlainDirectory(requested, statAfter, label);
  if (!sameRootPath(requested, realpathCheck.after)) throw new Error(`${label} resolves through a symlink/junction/reparse point: ${requested}`);
  const identityBefore = statIdentity(statBefore);
  const identityAfter = statIdentity(statAfter);
  if (!identityBefore || !identityAfter || identityBefore !== identityAfter) {
    throw new Error(`${label} filesystem identity changed during validation: ${requested}`);
  }
  return { requested, resolved: realpathCheck.after, identity: identityAfter };
}

/** Validate a resolved root against its requested spelling and current path identity. */
export async function assertRootPathBinding(
  binding: RootPathBinding,
  probe: PathSafetyProbe = {},
  label = 'Root path',
): Promise<void> {
  const requested = absolutePath(binding.requested);
  const resolved = absolutePath(binding.resolved);
  if (!sameRootPath(requested, resolved)) {
    throw new Error(`${label} requested path is not bound to its resolved path: ${requested} -> ${resolved}`);
  }
  await assertNoReparseAncestors(requested, probe, label);
  const current = await statAt(requested, probe);
  if (!current) return;
  assertPlainDirectory(requested, current, label);
}

export async function assertRootBindingUnchanged(
  binding: RootBinding,
  probe: PathSafetyProbe = {},
  label = 'Root path',
): Promise<void> {
  // This is the cheap CAS half of the contract. Full pre/post realpath checks
  // occur when the binding is captured and when a snapshot verifies the root;
  // the mutation boundary only needs to compare the stable directory identity
  // and reject a newly introduced reparse point.
  const currentStat = await statAt(binding.requested, probe);
  assertPlainDirectory(binding.requested, currentStat, label);
  const currentIdentity = statIdentity(currentStat);
  if (!currentIdentity || currentIdentity !== binding.identity || !sameRootPath(binding.requested, binding.resolved)) {
    throw new Error(`${label} changed after it was bound: ${binding.requested}`);
  }
}

/**
 * Acquire a best-effort cross-process lock beside a root using mkdir's atomic
 * create semantics. A stale lock is intentionally not removed automatically;
 * recovery must be an explicit operator action rather than a race-prone guess.
 */
export async function withExclusiveRootLock<T>(root: string, operation: () => Promise<T> | T): Promise<T> {
  const absolute = absolutePath(root);
  const lockPath = `${absolute}.spm-root-lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Root lock is already held: ${lockPath}`);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
}
