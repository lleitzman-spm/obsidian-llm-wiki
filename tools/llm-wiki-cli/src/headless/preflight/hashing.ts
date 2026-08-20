import { createHash } from 'node:crypto';

import { canonicalize, hashDomain } from '../provenance/canonical';

export const SOURCE_IDENTITY_DOMAIN = 'spm-brain/source-identity/v1\0';
export const MERKLE_LEAF_DOMAIN = 'spm-brain/merkle-leaf/v1\0';
export const MERKLE_NODE_DOMAIN = 'spm-brain/merkle-node/v1\0';

export interface SnapshotHashEntry {
  path: string;
  byteSha256: string;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function rawDigest(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`Expected a SHA-256 hex digest, got: ${hex}`);
  const output = new Uint8Array(32);
  for (let i = 0; i < output.length; i += 1) output[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return output;
}

function normalizeSourcePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFKC');
  if (normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`Unsafe source path: ${path}`);
  const parts = normalized.split('/').filter(part => part !== '');
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`Unsafe source path: ${path}`);
  if (parts.length === 0) throw new Error('Source path must not be empty');
  return parts.join('/');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(bytes(value)).digest('hex');
}

/**
 * Source identity is deliberately path-aware: two files with identical bytes
 * remain different sources when their authority paths differ.
 */
export function sourceIdentityDigest(authorityTree: string, path: string, byteSha256: string): string {
  if (!authorityTree || authorityTree.includes('\0')) throw new Error('Authority tree is required');
  const normalizedPath = normalizeSourcePath(path);
  if (!/^[0-9a-f]{64}$/i.test(byteSha256)) throw new Error(`Expected a SHA-256 hex digest, got: ${byteSha256}`);
  return hashDomain(SOURCE_IDENTITY_DOMAIN, {
    authority_tree: authorityTree,
    normalized_path: normalizedPath,
    byte_hash: byteSha256.toLowerCase(),
  });
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

/** Compute the versioned Merkle hash used for sealed relative-path snapshots. */
export function snapshotTreeHash(entries: readonly SnapshotHashEntry[]): string {
  if (entries.length === 0) throw new Error('Cannot hash an empty snapshot tree');
  const normalized = entries.map(entry => ({
    path: normalizeSourcePath(entry.path),
    byteSha256: entry.byteSha256.toLowerCase(),
  }));
  const unique = new Set(normalized.map(entry => entry.path));
  if (unique.size !== normalized.length) throw new Error('Snapshot tree contains duplicate paths');

  let nodes = normalized
    .sort((a, b) => compareUtf8(a.path, b.path))
    .map(entry => sha256Hex(new Uint8Array([
      ...bytes(MERKLE_LEAF_DOMAIN),
      ...bytes(entry.path), 0,
      ...rawDigest(entry.byteSha256),
    ])));

  while (nodes.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const right = nodes[i + 1] ?? nodes[i];
      next.push(sha256Hex(new Uint8Array([
        ...bytes(MERKLE_NODE_DOMAIN),
        ...rawDigest(nodes[i]),
        ...rawDigest(right),
      ])));
    }
    nodes = next;
  }
  return nodes[0];
}

export const hashSnapshotTree = snapshotTreeHash;

/** Deterministic JSON for hashes and receipts; object keys are UTF-8 sorted. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
