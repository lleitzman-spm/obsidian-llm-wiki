import { createHash } from 'node:crypto';

import { canonicalJsonBytes, type JsonValue } from './canonical-json';

/**
 * The complete v1 domain registry from ADR-0001. Values intentionally omit
 * the NUL terminator; domainBytes is the only boundary that adds it.
 */
export const DOMAINS = {
  EVIDENCE_ID: 'spm-brain/evidence-id/v1',
  CLAIM_ID: 'spm-brain/claim-id/v1',
  SOURCE_IDENTITY: 'spm-brain/source-identity/v1',
  SOURCE_NODE_ID: 'spm-brain/source-node-id/v1',
  ALIAS_NODE_ID: 'spm-brain/alias-node-id/v1',
  CANONICAL_KEY_ID: 'spm-brain/canonical-key-id/v1',
  PAGE_STATEMENT_ID: 'spm-brain/page-statement-id/v1',
  ADJUDICATION_NODE_ID: 'spm-brain/adjudication-node-id/v1',
  PROJECTION_EDGE_ID: 'spm-brain/projection-edge-id/v1',
  COORDINATOR_DELEGATION_SIGNATURE: 'spm-brain/coordinator-delegation-signature/v1',
  PREFLIGHT_CAPTURE_SIGNATURE: 'spm-brain/preflight-capture-signature/v1',
  LIVE_PREFLIGHT_CAPTURE_SIGNATURE: 'spm-brain/live-preflight-capture-signature/v1',
  WORKER_ARTIFACT_SIGNATURE: 'spm-brain/worker-artifact-signature/v1',
  RUN_MANIFEST_SIGNATURE: 'spm-brain/run-manifest-signature/v1',
  JOURNAL_ENTRY_SIGNATURE: 'spm-brain/journal-entry-signature/v1',
  NATIVE_RECEIPT_SIGNATURE: 'spm-brain/native-receipt-signature/v1',
  CANDIDATE_RECEIPT_SIGNATURE: 'spm-brain/candidate-receipt-signature/v1',
  COMPARISON_RECEIPT_SIGNATURE: 'spm-brain/comparison-receipt-signature/v1',
  ADJUDICATION_RECEIPT_SIGNATURE: 'spm-brain/adjudication-receipt-signature/v1',
  TERMINAL_ROOT_SIGNATURE: 'spm-brain/terminal-root-signature/v1',
  VERIFIER_SIGNATURE: 'spm-brain/verifier-signature/v1',
  RELEASE_DECISION_SIGNATURE: 'spm-brain/release-decision-signature/v1',
  FAILURE_RESTORE_RECEIPT_SIGNATURE: 'spm-brain/failure-restore-receipt-signature/v1',
  REPLAY_ENTRY: 'spm-brain/replay-entry/v1',
  MERKLE_LEAF: 'spm-brain/merkle-leaf/v1',
  MERKLE_NODE: 'spm-brain/merkle-node/v1',
} as const;

export type DomainName = typeof DOMAINS[keyof typeof DOMAINS];

const DOMAIN_VALUES = new Set<string>(Object.values(DOMAINS));

/** Public byte/string views for callers that need to seal domain bytes. */
export const DOMAIN_SEPARATORS = Object.freeze(
  Object.fromEntries(Object.entries(DOMAINS).map(([key, value]) => [key, `${value}\0`])) as {
    readonly [key in keyof typeof DOMAINS]: `${typeof DOMAINS[key]}\0`;
  },
);
export const EXACT_DOMAINS = DOMAIN_SEPARATORS;

/** Convert an ADR domain to its exact UTF-8 bytes, including the final NUL. */
export function domainBytes(domain: string): Buffer {
  if (!DOMAIN_VALUES.has(domain)) throw new TypeError(`Unknown or non-v1 crypto domain: ${domain}`);
  return Buffer.from(`${domain}\0`, 'utf8');
}

/** SHA-256(domain || canonical JSON). */
export function hashCanonical(domain: DomainName, value: JsonValue): Buffer {
  return hashDomainBytes(domain, canonicalJsonBytes(value));
}

/** SHA-256(domain || bytes), where bytes are already the protocol payload. */
export function hashDomainBytes(domain: DomainName, bytes: Uint8Array): Buffer {
  return createHash('sha256').update(domainBytes(domain)).update(bytes).digest();
}

export function digestHex(digest: Uint8Array): string {
  if (digest.byteLength !== 32) throw new TypeError('SHA-256 digests must be exactly 32 bytes');
  return Buffer.from(digest).toString('hex');
}

export function digestFromHex(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('Digest must be lowercase 64-character hexadecimal');
  return Buffer.from(value, 'hex');
}
