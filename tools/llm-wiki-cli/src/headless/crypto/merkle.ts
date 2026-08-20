import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

import {
  DOMAINS,
  digestFromHex,
  digestHex,
  domainBytes,
  hashCanonical,
} from './domains';
import {
  CryptoVerificationError,
  KeyRegistry,
  signPayload,
  type Signer,
  type SignedEnvelope,
} from './signing';

export interface MerkleArtifactInput {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly sha256?: string;
}

export interface MerkleLeaf {
  readonly path: string;
  readonly artifactHash: string;
  readonly leafHash: string;
}

export interface MerkleTree {
  readonly leaves: readonly MerkleLeaf[];
  readonly rootHash: string;
  readonly levels: readonly (readonly string[])[];
}

export interface TerminalRootPayload {
  readonly version: 'spm-brain/terminal-root/v1';
  readonly runId: string;
  readonly rootHash: string;
  readonly leafCount: number;
  readonly leaves: readonly MerkleLeaf[];
  readonly manifestHash?: string;
  readonly ledgerRootHash?: string;
}

export interface TerminalRoot extends TerminalRootPayload {
  readonly domain: typeof DOMAINS.TERMINAL_ROOT_SIGNATURE;
  readonly keyId: string;
  readonly digest: string;
  readonly signature: string;
}

export interface MerkleVerificationResult {
  readonly ok: true;
  readonly rootHash: string;
  readonly leafCount: number;
}

/** Terminal artifacts which cannot be leaves without creating a cycle. */
export const TERMINAL_EXCLUDED_PATHS = Object.freeze([
  'terminal-run-root.json',
  'verify.json',
  'live-preflight-capture.json',
]);

const SIGNER_CONTEXT_KEYS = ['runId', 'workerId', 'sourceIdentity', 'partition', 'fence'] as const;

function isReservedTerminalPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return TERMINAL_EXCLUDED_PATHS.includes(path)
    || TERMINAL_EXCLUDED_PATHS.includes(basename)
    || path.startsWith('live-preflight-')
    || path.startsWith('release-')
    || basename.startsWith('live-preflight-')
    || basename.startsWith('release-');
}

/** Normalize a relative path without allowing an escaping/traversal segment. */
export function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Merkle artifact path must be non-empty');
  const normalizedUnicode = value.normalize('NFKC').replaceAll('\\', '/');
  if (normalizedUnicode.includes('\0') || normalizedUnicode.startsWith('/') || /^[A-Za-z]:\//.test(normalizedUnicode)) {
    throw new TypeError(`Merkle artifact path must be relative: ${value}`);
  }
  const segments = normalizedUnicode.split('/');
  if (segments.some(segment => segment === '..')) throw new TypeError(`Merkle artifact path may not traverse parent directories: ${value}`);
  const clean = segments.filter(segment => segment !== '' && segment !== '.').join('/');
  if (!clean) throw new TypeError(`Merkle artifact path is empty after normalization: ${value}`);
  return clean;
}

function artifactDigest(input: MerkleArtifactInput): Buffer {
  if (input.bytes !== undefined && input.sha256 !== undefined) {
    throw new TypeError(`Merkle artifact ${input.path} supplied both bytes and sha256`);
  }
  if (input.bytes !== undefined) return createHash('sha256').update(input.bytes).digest();
  if (input.sha256 !== undefined) return digestFromHex(input.sha256);
  throw new TypeError(`Merkle artifact ${input.path} requires bytes or sha256`);
}

function leafDigest(path: string, artifactHash: Buffer): Buffer {
  return createHash('sha256')
    .update(domainBytes(DOMAINS.MERKLE_LEAF))
    .update(Buffer.from(path, 'utf8'))
    .update(Buffer.from([0]))
    .update(artifactHash)
    .digest();
}

function nodeDigest(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256')
    .update(domainBytes(DOMAINS.MERKLE_NODE))
    .update(left)
    .update(right)
    .digest();
}

function comparePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

type ReparseMetadata = {
  readonly isReparsePoint?: boolean | (() => boolean);
  readonly reparsePoint?: boolean;
};

type LstatResult = NonNullable<ReturnType<typeof lstatSync>>;

/**
 * Node's Windows Stats type does not expose reparse metadata, even though
 * newer runtimes may provide it at runtime.  Keep the check structural so a
 * junction/mount-point marker is honoured when the host exposes one, while
 * retaining the ordinary symbolic-link check on older Node versions.
 */
function statIsReparse(stat: LstatResult): boolean {
  const candidate = stat as LstatResult & ReparseMetadata;
  const reparse = typeof candidate.isReparsePoint === 'function'
    ? candidate.isReparsePoint()
    : candidate.isReparsePoint;
  return stat.isSymbolicLink() || reparse === true || candidate.reparsePoint === true;
}

/** Normalize native/extended Windows paths for a conservative comparison. */
function comparablePath(value: string): string {
  let normalized = resolve(value);
  if (process.platform === 'win32') {
    const extendedUncPrefix = '\\\\?\\UNC\\';
    const extendedPrefix = '\\\\?\\';
    const devicePrefix = '\\\\.\\';
    if (normalized.startsWith(extendedUncPrefix)) {
      normalized = `\\\\${normalized.slice(extendedUncPrefix.length)}`;
    } else if (normalized.startsWith(extendedPrefix)) {
      normalized = normalized.slice(extendedPrefix.length);
    } else if (normalized.startsWith(devicePrefix)) {
      normalized = normalized.slice(devicePrefix.length);
    }
    normalized = normalized.replace(/[\\/]+$/, '') || normalized;
    return normalized.toLowerCase();
  }
  return normalized;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function assertNonReparseStat(path: string, label: 'root' | 'ancestor' | 'artifact'):
  LstatResult {
  const stat = lstatSync(path);
  if (stat === undefined) {
    throw new CryptoVerificationError('missing-path', `Merkle ${label} disappeared during verification: ${path}`);
  }
  if (statIsReparse(stat)) {
    throw new CryptoVerificationError('reparse-path', `Symlink or reparse ${label} is not allowed: ${path}`);
  }
  return stat;
}

/**
 * Inspect a path without following links, then compare its native canonical
 * path.  `lstat` catches ordinary links and exposed reparse tags; the
 * canonical comparison catches Windows junctions/mount points that Node
 * reports as ordinary directories.  Both checks are intentionally fail-closed.
 */
function assertNonReparsePath(path: string, label: 'root' | 'ancestor' | 'artifact'):
  LstatResult {
  const stat = assertNonReparseStat(path, label);
  const canonical = realpathSync.native(path);
  if (!samePath(path, canonical)) {
    throw new CryptoVerificationError('reparse-path', `Path resolves through a symlink or reparse ${label}: ${path}`);
  }
  return stat;
}

/** Inspect the requested root and every existing ancestor before traversal. */
function assertRootPathIsSafe(root: string): LstatResult {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new TypeError('Merkle artifact root must be non-empty and NUL-free');
  }
  const absolute = resolve(root);
  const rootStat = assertNonReparsePath(absolute, 'root');
  const filesystemRoot = resolve(parse(absolute).root);
  let current = absolute;
  while (current !== filesystemRoot) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    // On managed Windows hosts, native realpath can be denied for an
    // otherwise ordinary user-profile ancestor (for example C:\Users\user).
    // The requested root's own canonical comparison above still detects a
    // redirecting junction; ancestors only need the no-follow lstat check.
    assertNonReparseStat(current, 'ancestor');
  }
  return rootStat;
}

function buildTreeFromLeaves(leaves: readonly MerkleLeaf[]): MerkleTree {
  if (leaves.length === 0) throw new TypeError('An empty Merkle tree is invalid');
  const levels: string[][] = [leaves.map(leaf => leaf.leafHash)];
  let current = leaves.map(leaf => digestFromHex(leaf.leafHash));
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const right = current[index + 1] ?? current[index];
      next.push(nodeDigest(current[index], right));
    }
    current = next;
    levels.push(current.map(digestHex));
  }
  return { leaves, rootHash: digestHex(current[0]), levels };
}

/** Build a sorted, domain-separated Merkle tree over non-cyclic artifacts. */
export function buildMerkleTree(inputs: readonly MerkleArtifactInput[]): MerkleTree {
  const seen = new Set<string>();
  const leaves = inputs.map(input => {
    const path = normalizeRelativePath(input.path);
    if (isReservedTerminalPath(path)) {
      throw new CryptoVerificationError('cyclic-leaf', `${path} is reserved and cannot be a terminal Merkle leaf`);
    }
    if (seen.has(path)) throw new CryptoVerificationError('duplicate-leaf', `Duplicate normalized Merkle path: ${path}`);
    seen.add(path);
    const artifactHash = artifactDigest(input);
    return {
      path,
      artifactHash: digestHex(artifactHash),
      leafHash: digestHex(leafDigest(path, artifactHash)),
    } satisfies MerkleLeaf;
  }).sort((left, right) => comparePathBytes(left.path, right.path));
  return buildTreeFromLeaves(leaves);
}

function collectDirectoryArtifacts(root: string, current: string, result: MerkleArtifactInput[]): void {
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => (
    Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8'))
  ));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    // Dirent metadata can be stale (and Windows junctions/reparse points are
    // not consistently reported as symbolic links), so lstat every child
    // before following or reading it.
    const stat = assertNonReparsePath(absolute, 'artifact');
    if (entry.isSymbolicLink()) {
      throw new CryptoVerificationError('reparse-artifact', `Symlink or reparse artifact is not allowed: ${absolute}`);
    }
    if (stat.isDirectory()) {
      collectDirectoryArtifacts(root, absolute, result);
      continue;
    }
    if (!stat.isFile()) throw new CryptoVerificationError('unsupported-artifact', `Unsupported terminal artifact: ${absolute}`);
    const normalized = normalizeRelativePath(relative(root, absolute).split(sep).join('/'));
    // The root and release/preflight receipts are written after terminal
    // terminalization; they are explicitly omitted to prevent self-reference.
    if (isReservedTerminalPath(normalized)) continue;
    result.push({ path: normalized, bytes: readFileSync(absolute) });
  }
}

export function buildMerkleTreeFromDirectory(root: string): MerkleTree {
  const result: MerkleArtifactInput[] = [];
  // lstat is essential here: statSync would follow a symlinked root and make
  // an out-of-tree directory appear to be the attested artifact root.  The
  // native canonical-path check additionally catches Windows junctions and
  // mount-point reparse tags that older Node Stats objects omit.
  const stat = assertRootPathIsSafe(root);
  if (!stat.isDirectory()) throw new TypeError(`Merkle artifact root is not a directory: ${root}`);
  collectDirectoryArtifacts(resolve(root), resolve(root), result);
  return buildMerkleTree(result);
}

function terminalPayload(root: MerkleTree, runId: string, manifestHash?: string, ledgerRootHash?: string): TerminalRootPayload {
  if (!runId) throw new TypeError('Terminal root requires a non-empty runId');
  return {
    version: 'spm-brain/terminal-root/v1',
    runId,
    rootHash: root.rootHash,
    leafCount: root.leaves.length,
    leaves: root.leaves,
    ...(manifestHash !== undefined ? { manifestHash } : {}),
    ...(ledgerRootHash !== undefined ? { ledgerRootHash } : {}),
  };
}

/** Sign a terminal root only with a signer delegated terminalize scope. */
export function createTerminalRoot(input: {
  readonly runId: string;
  readonly signer: Signer;
  readonly directory?: string;
  readonly artifacts?: readonly MerkleArtifactInput[];
  readonly manifestHash?: string;
  readonly ledgerRootHash?: string;
  readonly workerId?: string;
  readonly sourceIdentity?: string;
  readonly partition?: string;
  readonly fence?: number | string;
}): TerminalRoot {
  if (!input.signer.scopes.includes('spm-brain-run-terminalize')) {
    throw new CryptoVerificationError('scope-denied', `Signer ${input.signer.keyId} lacks scope spm-brain-run-terminalize`);
  }
  for (const key of SIGNER_CONTEXT_KEYS) {
    const constrained = input.signer.constraints?.[key];
    const requested = input[key];
    if (constrained !== undefined && constrained !== requested) {
      throw new CryptoVerificationError('scope-denied', `Signer ${input.signer.keyId} is not delegated for ${key}`);
    }
  }
  if ((input.directory === undefined) === (input.artifacts === undefined)) {
    throw new TypeError('Terminal root requires exactly one of directory or artifacts');
  }
  const tree = input.directory !== undefined
    ? buildMerkleTreeFromDirectory(input.directory)
    : buildMerkleTree(input.artifacts ?? []);
  const payload = terminalPayload(tree, input.runId, input.manifestHash, input.ledgerRootHash);
  const signed = signPayload(DOMAINS.TERMINAL_ROOT_SIGNATURE, payload, input.signer);
  return {
    ...payload,
    domain: DOMAINS.TERMINAL_ROOT_SIGNATURE,
    keyId: input.signer.keyId,
    // The signed digest commits to the complete root envelope (including the
    // run ID and explicit bindings), while the payload's rootHash remains the
    // raw Merkle digest used by the terminal tree contract.
    digest: signed.digest,
    signature: signed.signature,
  };
}

function assertSameLeaves(expected: readonly MerkleLeaf[], actual: readonly MerkleLeaf[]): void {
  if (expected.length !== actual.length) throw new CryptoVerificationError('root-mismatch', 'Terminal root leaf count mismatch');
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.artifactHash !== right.artifactHash || left.leafHash !== right.leafHash) {
      throw new CryptoVerificationError('root-mismatch', `Terminal root leaf mismatch at index ${index}`);
    }
  }
}

/** Independently recompute artifacts, the root, and the delegated signature. */
export function verifyTerminalRoot(
  root: TerminalRoot,
  options: {
    readonly registry: KeyRegistry;
    readonly directory?: string;
    readonly artifacts?: readonly MerkleArtifactInput[];
    readonly requiredScope?: string;
    readonly workerId?: string;
    readonly sourceIdentity?: string;
    readonly partition?: string;
    readonly fence?: number | string;
  },
): MerkleVerificationResult {
  if (root.version !== 'spm-brain/terminal-root/v1') throw new CryptoVerificationError('invalid-root', 'Wrong terminal root version');
  if (root.domain !== DOMAINS.TERMINAL_ROOT_SIGNATURE) throw new CryptoVerificationError('wrong-domain', 'Wrong terminal root signature domain');
  if ((options.directory === undefined) === (options.artifacts === undefined)) {
    throw new TypeError('Terminal root verification requires exactly one of directory or artifacts');
  }
  const payload: TerminalRootPayload = {
    version: root.version,
    runId: root.runId,
    rootHash: root.rootHash,
    leafCount: root.leafCount,
    leaves: root.leaves,
    ...(root.manifestHash !== undefined ? { manifestHash: root.manifestHash } : {}),
    ...(root.ledgerRootHash !== undefined ? { ledgerRootHash: root.ledgerRootHash } : {}),
  };
  const envelope: SignedEnvelope<TerminalRootPayload> = {
    version: 'spm-brain/signed/v1',
    domain: root.domain,
    keyId: root.keyId,
    digest: root.digest,
    signature: root.signature,
    payload,
  };
  options.registry.verifyEnvelope(envelope, {
    requiredScope: options.requiredScope ?? 'spm-brain-run-terminalize',
    runId: root.runId,
    workerId: options.workerId,
    sourceIdentity: options.sourceIdentity,
    partition: options.partition,
    fence: options.fence,
  });
  // Resolve the signer and verify the signed envelope before touching
  // untrusted directory contents.  This keeps unknown-key/signature failures
  // from being masked by an unrelated artifact mismatch.
  const tree = options.directory !== undefined
    ? buildMerkleTreeFromDirectory(options.directory)
    : buildMerkleTree(options.artifacts ?? []);
  assertSameLeaves(root.leaves, tree.leaves);
  if (root.leafCount !== tree.leaves.length || root.rootHash !== tree.rootHash) {
    throw new CryptoVerificationError('root-mismatch', 'Terminal root hash or count mismatch');
  }
  return { ok: true, rootHash: tree.rootHash, leafCount: tree.leaves.length };
}

export const computeMerkleTree = buildMerkleTree;
export const computeMerkleRoot = (inputs: readonly MerkleArtifactInput[]): string => buildMerkleTree(inputs).rootHash;
