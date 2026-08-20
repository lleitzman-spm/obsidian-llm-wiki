import {
  DOMAINS,
  buildMerkleTree,
  buildMerkleTreeFromDirectory,
  createContractSignature,
  verifyContractSignature,
  type ContractSignature as CryptoContractSignature,
  type KeyRegistry,
  type Signer,
  type TerminalRoot as CryptoTerminalRoot,
} from '../crypto';
import {
  assertValidContract,
  type ContractSignature,
  type TerminalRoot as ContractTerminalRoot,
} from '../contracts';
import type { MerkleArtifactInput } from '../crypto';

/**
 * References which are not present in the crypto terminal-root payload but are
 * required by the on-disk headless-ingest contract. The values are hashes of
 * the exact bytes on disk, not hashes supplied by a caller for convenience.
 */
export interface TerminalRootContractReferences {
  readonly journalSha256: string;
  readonly replayLedgerSha256: string;
  readonly projectionComparisonSha256: string;
}

export interface ContractTerminalRootSignerOptions {
  readonly signer: Signer;
  readonly requiredScope?: string;
}

export interface VerifyTerminalRootContractOptions {
  readonly registry: KeyRegistry;
  readonly directory?: string;
  readonly artifacts?: readonly MerkleArtifactInput[];
  readonly expectedRunId?: string;
  readonly expectedJournalSha256?: string;
  readonly expectedReplayLedgerSha256?: string;
  readonly expectedProjectionComparisonSha256?: string;
  readonly requiredScope?: string;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (!isDigest(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function asCryptoSignature(signature: ContractSignature): CryptoContractSignature {
  return {
    key_id: signature.key_id,
    algorithm: signature.algorithm,
    signature: signature.signature,
    signed_digest: signature.signed_digest,
  };
}

/**
 * Make the canonical snake_case terminal-root contract from the crypto
 * terminal tree. A contract signature is intentionally required: the crypto
 * root signature signs the camelCase payload, while the contract signature
 * binds the canonical `root_sha256` digest. Silently re-labelling one as the
 * other would make signed-but-invalid substitutions possible.
 */
export function terminalRootToContract(
  root: CryptoTerminalRoot,
  references: TerminalRootContractReferences,
  signature: ContractSignature,
): ContractTerminalRoot {
  if (root.version !== 'spm-brain/terminal-root/v1' || root.domain !== DOMAINS.TERMINAL_ROOT_SIGNATURE) {
    throw new Error('Crypto terminal root has an unsupported version or domain');
  }
  assertDigest(root.rootHash, 'terminal root hash');
  assertDigest(references.journalSha256, 'journal hash');
  assertDigest(references.replayLedgerSha256, 'replay ledger hash');
  assertDigest(references.projectionComparisonSha256, 'projection comparison hash');
  if (root.ledgerRootHash !== undefined && root.ledgerRootHash !== references.replayLedgerSha256) {
    throw new Error('Terminal root ledger hash does not match the contract replay checkpoint');
  }
  if (signature.signed_digest !== root.rootHash) {
    throw new Error('Contract terminal signature must bind root_sha256, not the camelCase envelope digest');
  }
  const contract: ContractTerminalRoot = {
    contract_version: 'headless-ingest/v1',
    run_id: root.runId,
    root_sha256: root.rootHash,
    leaf_count: root.leafCount,
    leaves: root.leaves.map(leaf => ({
      path: leaf.path,
      artifact_sha256: leaf.artifactHash,
      leaf_sha256: leaf.leafHash,
    })),
    journal_sha256: references.journalSha256,
    replay_ledger_sha256: references.replayLedgerSha256,
    projection_comparison_sha256: references.projectionComparisonSha256,
    signature,
  };
  return assertValidContract<ContractTerminalRoot>('terminalRoot', contract);
}

/** Alias with an explicit bridge name for integration callers. */
export const bridgeCryptoTerminalRoot = terminalRootToContract;
export const bridgeTerminalRoot = terminalRootToContract;

/**
 * Create a snake_case contract signature over the Merkle root. This is useful
 * when a coordinator has a crypto terminal root and wants to emit the
 * canonical contract as a separate, independently verifiable artifact.
 */
export function createTerminalRootContract(
  root: CryptoTerminalRoot,
  references: TerminalRootContractReferences,
  options: ContractTerminalRootSignerOptions,
): ContractTerminalRoot {
  if (!options.signer.scopes.includes(options.requiredScope ?? 'spm-brain-run-terminalize')) {
    throw new Error(`Signer ${options.signer.keyId} lacks terminal-root scope`);
  }
  const signature = createContractSignature(
    DOMAINS.TERMINAL_ROOT_SIGNATURE,
    root.rootHash,
    options.signer,
  );
  return terminalRootToContract(root, references, signature);
}

export const createContractTerminalRoot = createTerminalRootContract;

/**
 * Convert a validated snake_case root to a lossless Merkle-root view. The
 * returned view is deliberately not asserted to be a crypto signed envelope:
 * callers must use verifyTerminalRootContract for the contract signature.
 */
export function terminalRootFromContract(root: unknown): CryptoTerminalRoot {
  const contract = assertValidContract<ContractTerminalRoot>('terminalRoot', root);
  return {
    version: 'spm-brain/terminal-root/v1',
    runId: contract.run_id,
    rootHash: contract.root_sha256,
    leafCount: contract.leaf_count,
    leaves: contract.leaves.map(leaf => ({
      path: leaf.path,
      artifactHash: leaf.artifact_sha256,
      leafHash: leaf.leaf_sha256,
    })),
    domain: DOMAINS.TERMINAL_ROOT_SIGNATURE,
    keyId: contract.signature.key_id,
    // The bridge view exposes the digest bound by the contract signature. It
    // is intentionally not claimed to be the original camelCase envelope
    // digest, which is unavailable in the snake_case contract.
    digest: contract.signature.signed_digest,
    signature: contract.signature.signature,
    ledgerRootHash: contract.replay_ledger_sha256,
  };
}

export const contractTerminalRootToCryptoView = terminalRootFromContract;

function assertSameLeaves(
  expected: readonly ContractTerminalRoot['leaves'][number][],
  actual: readonly { path: string; artifactHash: string; leafHash: string }[],
): void {
  if (expected.length !== actual.length) throw new Error('Terminal root leaf count mismatch');
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.artifact_sha256 !== right.artifactHash || left.leaf_sha256 !== right.leafHash) {
      throw new Error(`Terminal root leaf mismatch at index ${index}`);
    }
  }
}

/** Independently verify the snake_case contract and its actual artifact tree. */
export function verifyTerminalRootContract(
  value: unknown,
  options: VerifyTerminalRootContractOptions,
): { readonly ok: true; readonly rootSha256: string; readonly leafCount: number } {
  const root = assertValidContract<ContractTerminalRoot>('terminalRoot', value);
  if (options.expectedRunId !== undefined && root.run_id !== options.expectedRunId) {
    throw new Error(`Terminal root run ID ${root.run_id} does not match expected ${options.expectedRunId}`);
  }
  for (const [label, expected, actual] of [
    ['journal', options.expectedJournalSha256, root.journal_sha256],
    ['replay ledger', options.expectedReplayLedgerSha256, root.replay_ledger_sha256],
    ['projection comparison', options.expectedProjectionComparisonSha256, root.projection_comparison_sha256],
  ] as const) {
    if (expected !== undefined && expected !== actual) throw new Error(`Terminal root ${label} hash mismatch`);
  }
  verifyContractSignature(
    DOMAINS.TERMINAL_ROOT_SIGNATURE,
    asCryptoSignature(root.signature),
    options.registry,
    { requiredScope: options.requiredScope ?? 'spm-brain-run-terminalize', runId: root.run_id },
  );
  if (root.signature.signed_digest !== root.root_sha256) {
    throw new Error('Terminal root signature is not bound to root_sha256');
  }
  if ((options.directory === undefined) === (options.artifacts === undefined)) {
    throw new Error('Terminal root verification requires exactly one of directory or artifacts');
  }
  const tree = options.directory !== undefined
    ? buildMerkleTreeFromDirectory(options.directory)
    : buildMerkleTree(options.artifacts ?? []);
  assertSameLeaves(root.leaves, tree.leaves);
  if (tree.rootHash !== root.root_sha256 || tree.leaves.length !== root.leaf_count) {
    throw new Error('Terminal root Merkle hash or count mismatch');
  }
  return { ok: true, rootSha256: tree.rootHash, leafCount: tree.leaves.length };
}

export const independentlyVerifyTerminalRootContract = verifyTerminalRootContract;
