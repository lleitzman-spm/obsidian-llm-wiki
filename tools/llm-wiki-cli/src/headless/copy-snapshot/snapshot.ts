import {
  lstat as fsLstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath as fsRealpath,
} from 'node:fs/promises';
import * as nodePath from 'node:path';
import { sha256Hex, snapshotTreeHash, type SnapshotHashEntry } from '../preflight/hashing';
import { assertSafeCopyRoots, type RootProbe } from '../preflight/roots';

/** A manifest deliberately contains bytes, not mtimes or platform-specific metadata. */
export interface SnapshotEntry {
  path: string;
  byteLength: number;
  byteSha256: string;
}

export interface CopySnapshotManifest {
  version: 'copied-vault-snapshot/v1';
  root: string;
  exclusions: string[];
  entries: SnapshotEntry[];
  treeSha256: string;
  manifestSha256: string;
}

export interface SnapshotProbe {
  lstat?: (path: string) => Promise<SnapshotStat | undefined> | SnapshotStat | undefined;
  realpath?: (path: string) => Promise<string> | string;
  readdir?: (path: string) => Promise<readonly SnapshotDirent[]> | readonly SnapshotDirent[];
  readFile?: (path: string) => Promise<Uint8Array> | Uint8Array;
}

export interface SnapshotStat {
  isDirectory?: () => boolean;
  isFile?: () => boolean;
  isSymbolicLink?: () => boolean;
  isReparsePoint?: boolean | (() => boolean);
  /** Stable identity/metadata fields exposed by Node's fs.Stats. */
  dev?: number | bigint;
  ino?: number | bigint;
  mode?: number | bigint;
  size?: number | bigint;
  mtimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
}

export interface SnapshotDirent {
  name: string;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
}

export interface CaptureSnapshotOptions {
  root: string;
  exclusions?: readonly string[];
  probe?: SnapshotProbe;
  now?: number;
}

export interface CopySnapshotOptions extends CaptureSnapshotOptions {
  destinationRoot: string;
  syncRoots?: readonly string[];
}

export interface SnapshotDrift {
  added: string[];
  removed: string[];
  changed: string[];
  exact: boolean;
  expectedTreeSha256: string;
  actualTreeSha256: string;
}

const EMPTY_TREE_HASH = sha256Hex('copied-vault-snapshot/empty-tree/v1\0');

function absoluteRoot(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Snapshot root must be non-empty and NUL-free');
  return nodePath.resolve(value);
}

function normalizeRelative(value: string): string {
  if (!value || value.includes('\0')) throw new Error(`Unsafe snapshot path: ${value}`);
  const normalized = value.replaceAll('\\', '/').normalize('NFKC');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) throw new Error(`Unsafe snapshot path: ${value}`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
  return parts.join('/');
}

function excluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Only runtime bookkeeping may be omitted from a copied-vault snapshot. A
 * caller cannot use this option to hide source notes, settings, or outputs.
 */
function normalizeExclusions(values: readonly string[] | undefined): string[] {
  const normalized = (values ?? []).map(normalizeRelative);
  for (const value of normalized) {
    const first = value.split('/')[0].toLowerCase();
    if (first !== 'run' && first !== 'lease') {
      throw new Error(`Snapshot exclusion is not run/lease metadata: ${value}`);
    }
  }
  return [...new Set(normalized)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function statIsReparse(stat: SnapshotStat): boolean {
  const link = stat.isSymbolicLink?.() === true;
  const reparse = typeof stat.isReparsePoint === 'function' ? stat.isReparsePoint() : stat.isReparsePoint;
  return link || reparse === true;
}

const STAT_IDENTITY_FIELDS = ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'] as const;
type StatIdentityField = (typeof STAT_IDENTITY_FIELDS)[number];
const DIRECTORY_IDENTITY_FIELDS = ['dev', 'ino', 'mode', 'birthtimeMs'] as const;
type DirectoryIdentityField = (typeof DIRECTORY_IDENTITY_FIELDS)[number];

/**
 * Node does not expose a portable no-follow/openat primitive for all of the
 * platforms supported by this CLI.  The fields below are the strongest
 * cross-platform identity we can revalidate around a path-based byte read.
 * Missing identity is deliberately not treated as stable: a synthetic probe
 * must opt into the same fail-closed contract as the real fs.Stats object.
 */
function statIdentity(stat: SnapshotStat | undefined): string | undefined {
  if (!stat) return undefined;
  const values = STAT_IDENTITY_FIELDS.map(field => stat[field as StatIdentityField]);
  if (values.some(value => value === undefined || (typeof value === 'number' && !Number.isFinite(value)))) return undefined;
  return values.map(value => `${typeof value}:${String(value)}`).join('|');
}

/** Directory mtimes legitimately change when a child is created. */
function directoryIdentity(stat: SnapshotStat | undefined): string | undefined {
  if (!stat) return undefined;
  const values = DIRECTORY_IDENTITY_FIELDS.map(field => stat[field as DirectoryIdentityField]);
  if (values.some(value => value === undefined || (typeof value === 'number' && !Number.isFinite(value)))) return undefined;
  return values.map(value => `${typeof value}:${String(value)}`).join('|');
}

function comparisonPath(value: string): string {
  let normalized = nodePath.normalize(nodePath.resolve(value));
  if (process.platform === 'win32') {
    // fs.realpath may use the extended-length spelling while the caller uses
    // the ordinary spelling.  They are the same path, unlike a junction that
    // resolves to a different location.
    normalized = normalized.replace(/^\\\\\?\\/u, '').toLowerCase();
  }
  return normalized;
}

function assertDirectoryStat(path: string, stat: SnapshotStat | undefined, label: string): asserts stat is SnapshotStat {
  if (!stat || statIsReparse(stat) || stat.isDirectory?.() !== true) {
    throw new Error(`${label} is not a plain directory: ${path}`);
  }
  if (statIdentity(stat) === undefined) {
    throw new Error(`${label} has no stable filesystem identity: ${path}`);
  }
}

function assertFileStat(path: string, stat: SnapshotStat | undefined, label: string): asserts stat is SnapshotStat {
  if (!stat || statIsReparse(stat) || stat.isDirectory?.() === true || stat.isFile?.() !== true) {
    throw new Error(`${label} is not a plain file: ${path}`);
  }
  if (statIdentity(stat) === undefined) {
    throw new Error(`${label} has no stable filesystem identity: ${path}`);
  }
}

async function assertNoReparseAlias(path: string, probe: SnapshotProbe, label: string): Promise<void> {
  let resolved: string;
  try {
    resolved = nodePath.resolve(probe.realpath ? await probe.realpath(path) : await fsRealpath(path));
  } catch (error) {
    throw new Error(`${label} could not be resolved without following a reparse point: ${path} (${String(error)})`);
  }
  if (comparisonPath(resolved) !== comparisonPath(path)) {
    throw new Error(`${label} resolves through a symlink/junction/reparse point: ${path}`);
  }
}

function assertStableIdentity(path: string, before: SnapshotStat | undefined, after: SnapshotStat | undefined, label: string): void {
  const beforeIdentity = statIdentity(before);
  const afterIdentity = statIdentity(after);
  if (!beforeIdentity || !afterIdentity) {
    throw new Error(`${label} has no stable filesystem identity: ${path}`);
  }
  if (beforeIdentity !== afterIdentity) {
    throw new Error(`${label} changed while bytes were being read: ${path}`);
  }
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function statPath(path: string, probe: SnapshotProbe): Promise<SnapshotStat | undefined> {
  if (probe.lstat) {
    try {
      return await probe.lstat(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  try {
    return await fsLstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function listPath(path: string, probe: SnapshotProbe): Promise<readonly SnapshotDirent[]> {
  if (probe.readdir) return probe.readdir(path);
  return readdir(path, { withFileTypes: true });
}

async function bytesAt(path: string, probe: SnapshotProbe): Promise<Uint8Array> {
  if (probe.readFile) return probe.readFile(path);
  return readFile(path);
}

async function verifyRoot(root: string, probe: SnapshotProbe): Promise<string> {
  const absolute = absoluteRoot(root);
  let resolved: string;
  try {
    resolved = nodePath.resolve(probe.realpath ? await probe.realpath(absolute) : await fsRealpath(absolute));
  } catch (error) {
    throw new Error(`Snapshot root is not an existing directory: ${absolute} (${String(error)})`);
  }
  const stat = await statPath(absolute, probe);
  assertDirectoryStat(absolute, stat, 'Snapshot root');
  if (comparisonPath(resolved) !== comparisonPath(absolute)) {
    throw new Error(`Snapshot root is a symlink/junction/reparse point: ${absolute}`);
  }
  return resolved;
}

async function walk(root: string, relative: string, exclusions: readonly string[], probe: SnapshotProbe, output: SnapshotEntry[]): Promise<void> {
  const directory = relative ? nodePath.join(root, ...relative.split('/')) : root;
  const directoryBefore = await statPath(directory, probe);
  assertDirectoryStat(directory, directoryBefore, 'Snapshot directory');
  await assertNoReparseAlias(directory, probe, 'Snapshot directory');
  const children = [...await listPath(directory, probe)].sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const directoryAfter = await statPath(directory, probe);
  assertDirectoryStat(directory, directoryAfter, 'Snapshot directory');
  assertStableIdentity(directory, directoryBefore, directoryAfter, 'Snapshot directory');
  await assertNoReparseAlias(directory, probe, 'Snapshot directory');
  for (const child of children) {
    const childRelative = normalizeRelative(relative ? `${relative}/${child.name}` : child.name);
    if (excluded(childRelative, exclusions)) continue;
    const childPath = nodePath.join(root, ...childRelative.split('/'));
    const stat = await statPath(childPath, probe);
    if (!stat) throw new Error(`Snapshot entry disappeared during capture: ${childRelative}`);
    if (statIsReparse(stat) || child.isSymbolicLink?.() === true) {
      throw new Error(`Snapshot contains a symlink/reparse point: ${childRelative}`);
    }
    if (stat.isDirectory?.() === true || child.isDirectory?.() === true) {
      assertDirectoryStat(childPath, stat, 'Snapshot entry');
      await assertNoReparseAlias(childPath, probe, 'Snapshot entry');
      await walk(root, childRelative, exclusions, probe, output);
      continue;
    }
    const content = await readStableBytes(childPath, probe, stat, 'Snapshot entry');
    output.push({ path: childRelative, byteLength: content.byteLength, byteSha256: sha256Hex(content) });
  }
}

function treeHash(entries: readonly SnapshotEntry[]): string {
  if (entries.length === 0) return EMPTY_TREE_HASH;
  return snapshotTreeHash(entries.map(entry => ({ path: entry.path, byteSha256: entry.byteSha256 })) satisfies SnapshotHashEntry[]);
}

function manifestHash(body: Omit<CopySnapshotManifest, 'manifestSha256'>): string {
  const serialized = JSON.stringify({
    version: body.version,
    root: body.root,
    exclusions: body.exclusions,
    entries: body.entries,
    treeSha256: body.treeSha256,
  });
  return sha256Hex(serialized);
}

export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<CopySnapshotManifest> {
  const probe = options.probe ?? {};
  const root = await verifyRoot(options.root, probe);
  const exclusions = normalizeExclusions(options.exclusions);
  const entries: SnapshotEntry[] = [];
  await walk(root, '', exclusions, probe, entries);
  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const body = {
    version: 'copied-vault-snapshot/v1' as const,
    root,
    exclusions,
    entries,
    treeSha256: treeHash(entries),
  };
  return { ...body, manifestSha256: manifestHash(body) };
}

async function assertDestinationEmpty(root: string, probe: SnapshotProbe): Promise<void> {
  const stat = await statPath(root, probe);
  if (!stat) return;
  assertDirectoryStat(root, stat, 'Copy destination');
  await assertNoReparseAlias(root, probe, 'Copy destination');
  const children = await listPath(root, probe);
  if (children.length !== 0) throw new Error(`Copy destination must be empty: ${root}`);
}

interface DestinationAncestorIdentity {
  path: string;
  identity: string;
}

async function ensureSafeDestinationAncestors(root: string, path: string, probe: SnapshotProbe): Promise<readonly DestinationAncestorIdentity[]> {
  const relative = nodePath.relative(root, path);
  if (relative.startsWith('..') || nodePath.isAbsolute(relative)) throw new Error(`Destination path escapes root: ${path}`);
  const parts = relative.split(nodePath.sep).filter(Boolean);
  let current = root;
  const directories = [root, ...parts.slice(0, -1).map(part => {
    current = nodePath.join(current, part);
    return current;
  })];
  const result: DestinationAncestorIdentity[] = [];
  for (const directory of directories) {
    const stat = await statPath(directory, probe);
    assertDirectoryStat(directory, stat, 'Destination ancestor');
    await assertNoReparseAlias(directory, probe, 'Destination ancestor');
    const identity = directoryIdentity(stat);
    if (!identity) throw new Error(`Destination ancestor has no stable filesystem identity: ${directory}`);
    result.push({ path: directory, identity });
  }
  return result;
}

function assertStableDestinationAncestors(
  path: string,
  before: readonly DestinationAncestorIdentity[],
  after: readonly DestinationAncestorIdentity[],
): void {
  if (before.length !== after.length || before.some((entry, index) => {
    const counterpart = after[index];
    return !counterpart || comparisonPath(entry.path) !== comparisonPath(counterpart.path) || entry.identity !== counterpart.identity;
  })) {
    throw new Error(`Destination ancestor changed while copying: ${path}`);
  }
}

async function ensurePlainDirectory(path: string, probe: SnapshotProbe): Promise<void> {
  const existing = await statPath(path, probe);
  if (existing) {
    assertDirectoryStat(path, existing, 'Copy destination');
    await assertNoReparseAlias(path, probe, 'Copy destination');
    return;
  }

  const parent = nodePath.dirname(path);
  if (parent === path) throw new Error(`Cannot create destination directory: ${path}`);
  await ensurePlainDirectory(parent, probe);
  try {
    await mkdir(path);
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const created = await statPath(path, probe);
  assertDirectoryStat(path, created, 'Copy destination');
  await assertNoReparseAlias(path, probe, 'Copy destination');
}

async function writeStableDestinationFile(
  path: string,
  content: Uint8Array,
  root: string,
  probe: SnapshotProbe,
): Promise<void> {
  const beforeAncestors = await ensureSafeDestinationAncestors(root, path, probe);
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content);
    const handleStat = await handle.stat();
    assertFileStat(path, handleStat, 'Copied destination file');
    const afterAncestors = await ensureSafeDestinationAncestors(root, path, probe);
    assertStableDestinationAncestors(path, beforeAncestors, afterAncestors);
    const pathStat = await statPath(path, probe);
    assertFileStat(path, pathStat, 'Copied destination file');
    assertStableIdentity(path, handleStat, pathStat, 'Copied destination file');
    await assertNoReparseAlias(path, probe, 'Copied destination file');
  } finally {
    await handle.close();
  }
}

async function readStableBytes(
  path: string,
  probe: SnapshotProbe,
  initialStat?: SnapshotStat,
  label = 'Snapshot entry',
): Promise<Uint8Array> {
  const before = initialStat ?? await statPath(path, probe);
  assertFileStat(path, before, label);
  await assertNoReparseAlias(path, probe, label);
  const content = await bytesAt(path, probe);
  const after = await statPath(path, probe);
  assertFileStat(path, after, label);
  assertStableIdentity(path, before, after, label);
  await assertNoReparseAlias(path, probe, label);
  return content;
}

/** Capture an immutable source manifest, then copy its bytes to a fresh destination. */
export async function copySnapshot(options: CopySnapshotOptions): Promise<{ source: CopySnapshotManifest; destination: CopySnapshotManifest }> {
  const probe = options.probe ?? {};
  const roots = await assertSafeCopyRoots({
    liveRoot: options.root,
    copyRoots: [options.destinationRoot],
    syncRoots: options.syncRoots,
    probe,
  });
  const source = await captureSnapshot({ ...options, root: roots.liveRoot.resolved, probe });
  const destination = roots.copyRoots[0].resolved;
  await ensurePlainDirectory(destination, probe);
  await assertDestinationEmpty(destination, probe);
  for (const entry of source.entries) {
    const destinationPath = nodePath.join(destination, ...entry.path.split('/'));
    await ensurePlainDirectory(nodePath.dirname(destinationPath), probe);
    const content = await readStableBytes(
      nodePath.join(source.root, ...entry.path.split('/')),
      probe,
      undefined,
      'Source entry',
    );
    if (content.byteLength !== entry.byteLength || sha256Hex(content) !== entry.byteSha256) {
      throw new Error(`Source drifted during copy: ${entry.path}`);
    }
    await writeStableDestinationFile(destinationPath, content, destination, probe);
  }
  // The per-file identity checks above catch replacement of an existing file;
  // this second source manifest also catches additions/removals that happened
  // after the initial directory walk. A path-based copy cannot be made fully
  // race-free on every Node platform, so any observed drift remains fatal.
  const sourceAfter = await captureSnapshot({ root: source.root, exclusions: source.exclusions, probe });
  const sourceDrift = compareSnapshots(source, sourceAfter);
  if (!sourceDrift.exact) throw new Error(`Source drifted during copy: ${JSON.stringify(sourceDrift)}`);
  const copied = await captureSnapshot({ root: destination, exclusions: source.exclusions, probe });
  const drift = compareSnapshots(source, copied);
  if (!drift.exact) throw new Error(`Copied snapshot mismatch: ${JSON.stringify(drift)}`);
  return { source, destination: copied };
}

export function compareSnapshots(expected: CopySnapshotManifest, actual: CopySnapshotManifest): SnapshotDrift {
  const expectedMap = new Map(expected.entries.map(entry => [entry.path, entry]));
  const actualMap = new Map(actual.entries.map(entry => [entry.path, entry]));
  const added = [...actualMap.keys()].filter(path => !expectedMap.has(path)).sort();
  const removed = [...expectedMap.keys()].filter(path => !actualMap.has(path)).sort();
  const changed = [...expectedMap.keys()].filter(path => {
    const left = expectedMap.get(path);
    const right = actualMap.get(path);
    return right !== undefined && (left?.byteLength !== right.byteLength || left.byteSha256 !== right.byteSha256);
  }).sort();
  const expectedExclusions = [...expected.exclusions].sort();
  const actualExclusions = [...actual.exclusions].sort();
  const sameExclusions = expectedExclusions.length === actualExclusions.length
    && expectedExclusions.every((value, index) => value === actualExclusions[index]);
  return {
    added,
    removed,
    changed,
    exact: sameExclusions && added.length === 0 && removed.length === 0 && changed.length === 0 && expected.treeSha256 === actual.treeSha256,
    expectedTreeSha256: expected.treeSha256,
    actualTreeSha256: actual.treeSha256,
  };
}

export async function detectSnapshotDrift(root: string, expected: CopySnapshotManifest, probe?: SnapshotProbe): Promise<SnapshotDrift> {
  const actual = await captureSnapshot({ root, exclusions: expected.exclusions, probe });
  return compareSnapshots(expected, actual);
}

export const createCopiedVaultSnapshot = captureSnapshot;
export const copyVaultSnapshot = copySnapshot;
