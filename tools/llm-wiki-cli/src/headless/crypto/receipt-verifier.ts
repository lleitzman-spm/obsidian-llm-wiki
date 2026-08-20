import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  CryptoVerificationError,
  KeyRegistry,
  verifySignedEnvelope,
  type SignedEnvelope,
} from './signing';
import type { JsonValue } from './canonical-json';
import {
  verifyTerminalRoot,
  type TerminalRoot,
  type MerkleVerificationResult,
} from './merkle';
import {
  verifyReplayLedgerFile,
  type ReplayLedgerOptions,
  type ReplayLedgerVerification,
} from './replay-ledger';

export interface ReceiptVerificationOptions {
  readonly registry: KeyRegistry;
  readonly requiredScope?: string;
  readonly runId?: string;
  readonly workerId?: string;
  readonly sourceIdentity?: string;
  readonly partition?: string;
  readonly fence?: number | string;
}

export interface IndependentRunVerificationOptions {
  readonly directory: string;
  readonly registry: KeyRegistry;
  readonly terminalRootPath?: string;
  readonly replayLedgerPath?: string;
  readonly expectedRunId?: string;
  readonly workerId?: string;
  readonly sourceIdentity?: string;
  readonly partition?: string;
  readonly fence?: number | string;
  readonly terminalScope?: string;
  readonly replayScope?: string;
  readonly initialCheckpointHash?: string;
  readonly priorTuples?: Iterable<string>;
}

export interface IndependentRunVerificationResult extends MerkleVerificationResult {
  readonly ledger?: ReplayLedgerVerification;
}

function parseJsonFile<T>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CryptoVerificationError('missing-artifact', `Unable to read receipt ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new CryptoVerificationError('invalid-receipt', `Invalid JSON receipt ${path}: ${(error as Error).message}`);
  }
}

function runArtifactPath(directory: string, requested: string): string {
  if (!requested || requested.includes('\0')) {
    throw new CryptoVerificationError('missing-artifact', 'Run artifact path must be non-empty and NUL-free');
  }
  const root = resolve(directory);
  const path = resolve(root, requested);
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new CryptoVerificationError('scope-denied', 'Run artifact path escapes the verified run directory');
  }
  return path;
}

/** Verify one signed receipt against an independent trusted-key registry. */
export function independentlyVerifyReceipt<T extends JsonValue>(
  receipt: SignedEnvelope<T>,
  options: ReceiptVerificationOptions,
): { readonly ok: true; readonly digest: string } {
  const record = options.registry.require(receipt.keyId, {
    requiredScope: options.requiredScope,
    runId: options.runId,
    workerId: options.workerId,
    sourceIdentity: options.sourceIdentity,
    partition: options.partition,
    fence: options.fence,
  });
  if (!verifySignedEnvelope(receipt, record.publicKey)) {
    throw new CryptoVerificationError('invalid-signature', `Receipt signature is invalid for ${receipt.keyId}`);
  }
  return { ok: true, digest: receipt.digest };
}

/**
 * Independently verify a terminal run from disk. The root and ledger are read
 * as untrusted JSONL artifacts; the verifier recomputes every directory byte
 * hash and every signed digest before returning success.
 */
export function independentlyVerifyRun(
  options: IndependentRunVerificationOptions,
): IndependentRunVerificationResult {
  const terminalRootPath = runArtifactPath(options.directory, options.terminalRootPath ?? 'terminal-run-root.json');
  const root = parseJsonFile<TerminalRoot>(terminalRootPath);
  if (options.expectedRunId !== undefined && root.runId !== options.expectedRunId) {
    throw new CryptoVerificationError('scope-denied', `Terminal root run ID ${root.runId} does not match expected ${options.expectedRunId}`);
  }

  const verifiedRoot = verifyTerminalRoot(root, {
    directory: options.directory,
    registry: options.registry,
    requiredScope: options.terminalScope,
    workerId: options.workerId,
    sourceIdentity: options.sourceIdentity,
    partition: options.partition,
    fence: options.fence,
  });

  // A directory may contain an ordinary artifact named replay-ledger.jsonl;
  // only an explicitly supplied path or a root-bound ledger checkpoint makes
  // it a replay ledger that this verifier must parse as signed JSONL.
  const replayLedgerPath = options.replayLedgerPath !== undefined
    ? runArtifactPath(options.directory, options.replayLedgerPath)
    : (root.ledgerRootHash !== undefined ? join(options.directory, 'replay-ledger.jsonl') : undefined);
  let ledger: ReplayLedgerVerification | undefined;
  if (replayLedgerPath !== undefined && existsSync(replayLedgerPath)) {
    const ledgerOptions: ReplayLedgerOptions = {
      registry: options.registry,
      ...(options.replayScope !== undefined ? { requiredScope: options.replayScope } : {}),
      ...(options.initialCheckpointHash !== undefined ? { initialCheckpointHash: options.initialCheckpointHash } : {}),
      ...(options.priorTuples !== undefined ? { priorTuples: options.priorTuples } : {}),
    };
    ledger = verifyReplayLedgerFile(replayLedgerPath, ledgerOptions);
    if (root.ledgerRootHash !== undefined && root.ledgerRootHash !== ledger.rootHash) {
      throw new CryptoVerificationError('root-mismatch', 'Terminal root ledger checkpoint does not match replay ledger');
    }
  } else if (root.ledgerRootHash !== undefined) {
    throw new CryptoVerificationError('missing-artifact', 'Terminal root binds a replay ledger that is not present');
  }

  return { ...verifiedRoot, ...(ledger ? { ledger } : {}) };
}

export const verifyReceipt = independentlyVerifyReceipt;
export const verifyRun = independentlyVerifyRun;
