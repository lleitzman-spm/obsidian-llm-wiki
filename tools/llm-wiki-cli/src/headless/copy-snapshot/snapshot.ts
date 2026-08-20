import {
  lstat as fsLstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
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
  isSymbolicLink?: () => boolean;
  isReparsePoint?: boolean | (() => boolean);
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

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function statPath(path: string, probe: SnapshotProbe): Promise<SnapshotStat | undefined> {
  if (probe.lstat) return probe.lstat(path);
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
  if (!stat || statIsReparse(stat) || stat.isDirectory?.() === false) {
    throw new Error(`Snapshot root must be a non-reparse directory: ${absolute}`);
  }
  if (nodePath.normalize(resolved) !== nodePath.normalize(absolute)) {
    // realpath differing from the requested path is allowed for ordinary
    // case/volume normalization, but a root symlink must never be followed.
    if (statIsReparse(stat)) throw new Error(`Snapshot root is a symlink/reparse point: ${absolute}`);
  }
  return resolved;
}

async function walk(root: string, relative: string, exclusions: readonly string[], probe: SnapshotProbe, output: SnapshotEntry[]): Promise<void> {
  const directory = relative ? nodePath.join(root, ...relative.split('/')) : root;
  const children = [...await listPath(directory, probe)].sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
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
      await walk(root, childRelative, exclusions, probe, output);
      continue;
    }
    const content = await bytesAt(childPath, probe);
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
  if (statIsReparse(stat) || stat.isDirectory?.() === false) throw new Error(`Copy destination is not a plain directory: ${root}`);
  const children = await listPath(root, probe);
  if (children.length !== 0) throw new Error(`Copy destination must be empty: ${root}`);
}

async function ensureSafeDestinationAncestors(root: string, path: string, probe: SnapshotProbe): Promise<void> {
  const relative = nodePath.relative(root, path);
  if (relative.startsWith('..') || nodePath.isAbsolute(relative)) throw new Error(`Destination path escapes root: ${path}`);
  let current = root;
  for (const part of relative.split(nodePath.sep).slice(0, -1)) {
    current = nodePath.join(current, part);
    const stat = await statPath(current, probe);
    if (stat && statIsReparse(stat)) throw new Error(`Destination contains a symlink/reparse point: ${current}`);
  }
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
  await assertDestinationEmpty(destination, probe);
  await mkdir(destination, { recursive: true });
  for (const entry of source.entries) {
    const destinationPath = nodePath.join(destination, ...entry.path.split('/'));
    await ensureSafeDestinationAncestors(destination, destinationPath, probe);
    await mkdir(nodePath.dirname(destinationPath), { recursive: true });
    const content = await bytesAt(nodePath.join(source.root, ...entry.path.split('/')), probe);
    if (content.byteLength !== entry.byteLength || sha256Hex(content) !== entry.byteSha256) {
      throw new Error(`Source drifted during copy: ${entry.path}`);
    }
    await writeFile(destinationPath, content, { flag: 'wx' });
  }
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
