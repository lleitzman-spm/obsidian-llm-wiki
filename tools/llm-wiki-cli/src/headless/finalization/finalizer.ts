import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  DOMAINS,
  createKeyRegistry,
  createSignedEnvelope,
  createTerminalRoot,
  verifyTerminalRoot,
  verifySignedEnvelope,
  type JsonValue,
  type Signer,
  type TerminalRoot,
} from '../crypto';
import { TransactionJournal } from '../transaction/journal';
import type { JournalEvent } from '../transaction/types';
import type {
  FinalizationFile,
  FinalizationIdentity,
  FinalizationResult,
  FinalizationInspection,
  FinalizationStatusEnvelope,
  FinalizationStatusPayload,
  FinalizeRunInput,
  PendingEnvelope,
  PendingPayload,
  PrepareFinalizationInput,
  RecoveryInput,
  ReplayAppendResult,
  ReplayIntent,
  TransactionObservation,
  TransactionProbe,
} from './types';

const PENDING_FILE = 'pending.json';
const COMMITTED_FILE = 'committed.json';
const TERMINAL_FILE = 'terminal.json';
const FAILURE_FILE = 'failure.json';
const TERMINAL_ROOT_FILE = 'terminal-run-root.json';
const RECEIPT_NAMES = new Set([
  'candidate-receipt.json',
  'candidate-receipt-envelope.json',
  'native-receipt.json',
  'receipt.json',
]);
const HEX64 = /^[0-9a-f]{64}$/u;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : new Uint8Array(value);
}

function asPath(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty NUL-free path`);
  }
  return resolve(value);
}

function equivalentPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function pathContains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertOutsideRoots(path: string, roots: readonly string[], label: string): void {
  const candidate = asPath(path, label);
  for (const rootValue of roots) {
    const root = asPath(rootValue, 'forbidden root');
    if (pathContains(root, candidate) || pathContains(candidate, root)) {
      throw new Error(`${label} overlaps forbidden root ${root}`);
    }
  }
}

function existingRealPath(value: string): string | undefined {
  try {
    return resolve(realpathSync.native(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertNoReparseAncestors(path: string, label: string): void {
  const absolute = asPath(path, label);
  let current = absolute;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} may not contain a symlink/reparse point: ${current}`);
    }
    const parent = dirname(current);
    if (equivalentPath(parent, current)) break;
    current = parent;
  }
}

function assertEvidenceRoots(input: { artifactRoot: string; stateRoot: string; forbiddenRoots?: readonly string[] }): void {
  const artifactRoot = asPath(input.artifactRoot, 'artifactRoot');
  const stateRoot = asPath(input.stateRoot, 'stateRoot');
  if (equivalentPath(artifactRoot, stateRoot) || pathContains(artifactRoot, stateRoot) || pathContains(stateRoot, artifactRoot)) {
    throw new Error('artifactRoot and stateRoot must be separate non-overlapping roots');
  }
  const forbidden = input.forbiddenRoots ?? [];
  assertOutsideRoots(artifactRoot, forbidden, 'artifactRoot');
  assertOutsideRoots(stateRoot, forbidden, 'stateRoot');
  // Checking existing real paths catches a symlinked root even when lexical
  // containment looks safe. Missing run-specific roots are checked through
  // every existing ancestor before creation.
  assertNoReparseAncestors(artifactRoot, 'artifactRoot');
  assertNoReparseAncestors(stateRoot, 'stateRoot');
  const artifactReal = existingRealPath(artifactRoot);
  const stateReal = existingRealPath(stateRoot);
  if (artifactReal !== undefined && (pathContains(stateRoot, artifactReal) || pathContains(artifactReal, stateRoot))) {
    throw new Error('artifactRoot real path overlaps stateRoot');
  }
  if (stateReal !== undefined && (pathContains(artifactRoot, stateReal) || pathContains(stateReal, artifactRoot))) {
    throw new Error('stateRoot real path overlaps artifactRoot');
  }
  for (const forbiddenRoot of forbidden) {
    const forbiddenReal = existingRealPath(forbiddenRoot);
    if (forbiddenReal === undefined) continue;
    if (artifactReal !== undefined && (pathContains(forbiddenReal, artifactReal) || pathContains(artifactReal, forbiddenReal))) {
      throw new Error(`artifactRoot real path overlaps forbidden root ${forbiddenReal}`);
    }
    if (stateReal !== undefined && (pathContains(forbiddenReal, stateReal) || pathContains(stateReal, forbiddenReal))) {
      throw new Error(`stateRoot real path overlaps forbidden root ${forbiddenReal}`);
    }
  }
}

/** Normalize an evidence-root-relative path and reject traversal/reparse names. */
export function normalizeEvidencePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error('Evidence path must be non-empty and NUL-free');
  const normalized = value.normalize('NFKC').replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) throw new Error(`Evidence path must be relative: ${value}`);
  const parts = normalized.split('/');
  if (parts.some(part => part === '..')) throw new Error(`Evidence path may not traverse a parent: ${value}`);
  const clean = parts.filter(part => part !== '' && part !== '.').join('/');
  if (!clean) throw new Error(`Evidence path is empty: ${value}`);
  if (clean === TERMINAL_ROOT_FILE || clean === 'verify.json' || clean.startsWith('live-preflight-') || clean.startsWith('release-')) {
    throw new Error(`Evidence path is reserved for terminalization: ${value}`);
  }
  return clean;
}

function validateIdentity(identity: FinalizationIdentity): void {
  for (const [label, value] of [
    ['runId', identity.runId],
    ['transactionId', identity.transactionId],
    ['planHash', identity.planHash],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty`);
  }
  if (!HEX64.test(identity.planHash)) throw new Error('planHash must be lowercase 64-character hexadecimal');
  if (typeof identity.fence !== 'string' && typeof identity.fence !== 'number') throw new Error('fence must be non-empty');
  if (typeof identity.fence === 'string' && identity.fence.length === 0) throw new Error('fence must be non-empty');
  if (typeof identity.fence === 'number' && (!Number.isSafeInteger(identity.fence) || identity.fence < 1)) throw new Error('fence must be a positive safe integer');
}

function normalizeFiles(files: readonly FinalizationFile[]): PendingPayload['files'] {
  const seen = new Set<string>();
  return files.map(file => {
    const path = normalizeEvidencePath(file.path);
    if (seen.has(path)) throw new Error(`Duplicate finalization path: ${path}`);
    seen.add(path);
    const content = bytes(file.bytes);
    return { path, sha256: sha256(content), bytes_base64: Buffer.from(content).toString('base64') };
  }).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

function normalizeReplay(intent: ReplayIntent): ReplayIntent {
  if (typeof intent.nonce !== 'string' || intent.nonce.length < 16 || intent.nonce.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(intent.nonce)) {
    throw new Error('Replay nonce must be 16-128 URL-safe characters');
  }
  const artifactPath = normalizeEvidencePath(intent.artifactPath);
  if (RECEIPT_NAMES.has(artifactPath) || artifactPath === TERMINAL_ROOT_FILE) throw new Error('Replay artifact path is reserved');
  return { nonce: intent.nonce, artifactPath, ...(intent.payload === undefined ? {} : { payload: intent.payload }) };
}

function nowIso(now: (() => number) | undefined): string {
  const value = now?.() ?? Date.now();
  if (!Number.isFinite(value)) throw new Error('Finalization clock returned a non-finite value');
  return new Date(value).toISOString();
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    // Windows does not permit opening every directory for fsync. The file is
    // still fsynced and rename is same-directory; do not mask success solely
    // because directory handles are unsupported by the host filesystem.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP') throw error;
  }
}

/** Write bytes with a same-directory fsync+rename commit. */
export function writeAtomically(path: string, content: Uint8Array | string): void {
  const target = asPath(path, 'atomic target');
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  assertNoReparseAncestors(parent, 'atomic target parent');
  const temporary = join(parent, `.${target.slice(target.lastIndexOf(sep) + 1)}.${process.pid}.${randomUUID()}.tmp`);
  const data = bytes(content);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, null);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    fsyncDirectory(parent);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve commit error */ }
    throw error;
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Finalization JSON is not a regular file: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function statePath(root: string, name: string): string {
  return join(asPath(root, 'stateRoot'), name);
}

function writeSigned<T extends JsonValue>(path: string, domain: (typeof DOMAINS)[keyof typeof DOMAINS], payload: T, signer: Signer): void {
  writeAtomically(path, jsonBytes(createSignedEnvelope(domain, payload, signer)));
}

function statusPayload(input: FinalizationIdentity, state: FinalizationStatusPayload['state'], now: (() => number) | undefined, extras: Partial<FinalizationStatusPayload> = {}): FinalizationStatusPayload {
  return {
    version: 'spm-brain/finalization-status/v1',
    runId: input.runId,
    transactionId: input.transactionId,
    planHash: input.planHash,
    fence: input.fence,
    state,
    recordedAt: nowIso(now),
    ...extras,
  };
}

function verifyStatus(path: string, signer: Signer, expected: FinalizationIdentity): FinalizationStatusPayload | undefined {
  const envelope = readJson<FinalizationStatusEnvelope>(path);
  if (envelope === undefined) return undefined;
  if (envelope.payload.runId !== expected.runId || envelope.payload.transactionId !== expected.transactionId || envelope.payload.planHash !== expected.planHash || envelope.payload.fence !== expected.fence) {
    throw new Error(`Finalization status identity mismatch at ${path}`);
  }
  if (!verifySignedEnvelope(envelope, signer.publicKey)) throw new Error(`Invalid finalization status signature at ${path}`);
  return envelope.payload;
}

function verifyPending(path: string, signer: Signer, expected: FinalizationIdentity): PendingPayload | undefined {
  const envelope = readJson<PendingEnvelope>(path);
  if (envelope === undefined) return undefined;
  if (!verifySignedEnvelope(envelope, signer.publicKey)) throw new Error(`Invalid pending finalization signature at ${path}`);
  const payload = envelope.payload;
  for (const key of ['runId', 'transactionId', 'planHash', 'fence'] as const) {
    if (payload[key] !== expected[key]) throw new Error(`Pending finalization ${key} does not match requested run`);
  }
  if (payload.artifactRoot !== expectedPath(payload.artifactRoot) || payload.stateRoot !== expectedPath(payload.stateRoot)) throw new Error('Pending finalization roots are not canonical');
  return payload;
}

function verifyTerminalArtifact(rootPath: string, artifactRoot: string, signer: Signer, expected: FinalizationIdentity, expectedRootHash?: string): TerminalRoot {
  const root = readJson<TerminalRoot>(rootPath);
  if (root === undefined || root.runId !== expected.runId) throw new Error('Terminal root is missing or has the wrong run ID');
  if (expectedRootHash === undefined) throw new Error('Terminal marker does not bind a terminal root hash');
  if (expectedRootHash !== undefined && root.rootHash !== expectedRootHash) throw new Error('Terminal marker does not bind the terminal root hash');
  verifyTerminalRoot(root, {
    directory: artifactRoot,
    registry: createKeyRegistry({ trustedKeys: [signer] }),
    fence: expected.fence,
  });
  return root;
}

function expectedPath(value: string): string {
  return resolve(value);
}

function decodePendingFiles(payload: PendingPayload): FinalizationFile[] {
  return payload.files.map(file => {
    const content = Buffer.from(file.bytes_base64, 'base64');
    if (sha256(content) !== file.sha256) throw new Error(`Pending evidence bytes hash mismatch for ${file.path}`);
    return { path: normalizeEvidencePath(file.path), bytes: content };
  });
}

function assertFreshArtifactRoot(root: string): void {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Evidence root is not a plain directory: ${root}`);
}

function assertPathInRoot(root: string, path: string): string {
  const normalized = normalizeEvidencePath(path);
  const absolute = resolve(root, ...normalized.split('/'));
  if (!pathContains(resolve(root), absolute)) throw new Error(`Evidence path escapes root: ${path}`);
  return absolute;
}

function writeEvidenceFiles(root: string, files: readonly FinalizationFile[], allowReceipt: boolean): void {
  for (const file of files) {
    const path = normalizeEvidencePath(file.path);
    if (!allowReceipt && RECEIPT_NAMES.has(path.split('/').at(-1) ?? '')) continue;
    const target = assertPathInRoot(root, path);
    const data = bytes(file.bytes);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Evidence target is not a regular file: ${path}`);
      const existing = readFileSync(target);
      if (sha256(existing) !== sha256(data)) throw new Error(`Evidence target collision or tamper: ${path}`);
      continue;
    }
    writeAtomically(target, data);
  }
}

function receiptFiles(files: readonly FinalizationFile[]): FinalizationFile[] {
  return files.filter(file => RECEIPT_NAMES.has(normalizeEvidencePath(file.path).split('/').at(-1) ?? ''));
}

function nonReceiptFiles(files: readonly FinalizationFile[]): FinalizationFile[] {
  return files.filter(file => !RECEIPT_NAMES.has(normalizeEvidencePath(file.path).split('/').at(-1) ?? ''));
}

function terminalRootPath(root: string): string {
  return join(root, TERMINAL_ROOT_FILE);
}

async function observe(input: TransactionProbe | TransactionObservation): Promise<TransactionObservation> {
  return 'observe' in input ? input.observe() : input;
}

function assertObservation(identity: FinalizationIdentity, observed: TransactionObservation): void {
  if (observed.transactionId !== identity.transactionId || observed.planHash !== identity.planHash || observed.fence !== identity.fence) throw new Error('Transaction observation does not match pending finalization identity');
}

function normalizeReplayResult(result: ReplayAppendResult, intent: ReplayIntent): ReplayAppendResult {
  if (!HEX64.test(result.entryHash) || !HEX64.test(result.ledgerRootHash)) throw new Error('Replay appender returned invalid hashes');
  if (result.artifactPath !== undefined && normalizeEvidencePath(result.artifactPath) !== intent.artifactPath) throw new Error('Replay appender path does not match pending intent');
  if (result.artifactSha256 !== undefined && !HEX64.test(result.artifactSha256)) throw new Error('Replay appender returned invalid artifact hash');
  return result;
}

function collectArtifactFiles(root: string, current: string, output: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const stat = lstatSync(absolute);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error(`Evidence root contains a symlink/reparse point: ${absolute}`);
    if (stat.isDirectory()) {
      collectArtifactFiles(root, absolute, output);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Evidence root contains an unsupported entry: ${absolute}`);
    const relativePath = relative(root, absolute).split(sep).join('/').normalize('NFKC');
    if (relativePath.startsWith('/') || relativePath.split('/').some(part => part === '..')) throw new Error(`Evidence entry escapes root: ${relativePath}`);
    output.push(relativePath.split('/').filter(part => part !== '' && part !== '.').join('/'));
  }
}

function ensureArtifactRootEmptyOrOwned(root: string, files: readonly FinalizationFile[], replayPath: string): void {
  assertFreshArtifactRoot(root);
  mkdirSync(root, { recursive: true });
  const allowed = new Set<string>([
    ...files.map(file => normalizeEvidencePath(file.path)),
    normalizeEvidencePath(replayPath),
    TERMINAL_ROOT_FILE,
  ]);
  const existing: string[] = [];
  collectArtifactFiles(root, root, existing);
  for (const path of existing) if (!allowed.has(path)) throw new Error(`Evidence root contains an unowned artifact: ${path}`);
}

function result(input: FinalizationIdentity & { artifactRoot: string; stateRoot: string }, state: FinalizationResult['state'], extras: Partial<FinalizationResult> = {}): FinalizationResult {
  return { runId: input.runId, transactionId: input.transactionId, planHash: input.planHash, fence: input.fence, artifactRoot: resolve(input.artifactRoot), stateRoot: resolve(input.stateRoot), state, ...extras };
}

function terminalMarker(input: FinalizeRunInput, root: TerminalRoot, replay: ReplayAppendResult, receiptFilesValue: readonly FinalizationFile[]): void {
  const receipt = receiptFilesValue.find(file => normalizeEvidencePath(file.path).split('/').at(-1) === 'candidate-receipt.json')
    ?? receiptFilesValue[0];
  const payload = statusPayload(input, 'terminal', input.now, {
    terminalRootHash: root.rootHash,
    receiptSha256: receipt === undefined ? undefined : sha256(bytes(receipt.bytes)),
    ledgerRootHash: replay.ledgerRootHash,
  });
  writeSigned(statePath(input.stateRoot, TERMINAL_FILE), DOMAINS.TERMINAL_ROOT_SIGNATURE, payload, input.signer);
}

function failure(input: FinalizationIdentity & { artifactRoot: string; stateRoot: string; signer: Signer; now?: () => number }, state: 'failed' | 'frozen', reason: string): FinalizationResult {
  const payload = statusPayload(input, state, input.now, { reason });
  try { writeSigned(statePath(input.stateRoot, FAILURE_FILE), DOMAINS.FAILURE_RESTORE_RECEIPT_SIGNATURE, payload, input.signer); } catch { /* return frozen even if the state root itself is unavailable */ }
  return result(input, state, { reason });
}

function pendingEnvelope(input: PrepareFinalizationInput, payload: PendingPayload): PendingEnvelope {
  return createSignedEnvelope(DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, payload, input.signer) as PendingEnvelope;
}

/**
 * Prepare all evidence needed to finish a run. This is the only durable input
 * to post-commit finalization: file bytes are copied into a signed pending
 * envelope so a crash cannot force recovery to ask a provider for new output.
 */
export function prepareFinalization(input: PrepareFinalizationInput): PendingPayload {
  validateIdentity(input);
  assertEvidenceRoots(input);
  const replay = normalizeReplay(input.replay);
  const files = normalizeFiles(input.files);
  if (files.length === 0) throw new Error('A finalization must contain at least one evidence file');
  if (files.some(file => file.path === replay.artifactPath)) throw new Error('Replay ledger path collides with a prepared evidence file');
  const pending: PendingPayload = {
    version: 'spm-brain/finalization-pending/v1',
    runId: input.runId,
    transactionId: input.transactionId,
    planHash: input.planHash,
    fence: input.fence,
    artifactRoot: resolve(input.artifactRoot),
    stateRoot: resolve(input.stateRoot),
    files,
    replay,
    ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
    preparedAt: nowIso(input.now),
  };
  const state = asPath(input.stateRoot, 'stateRoot');
  mkdirSync(state, { recursive: true });
  const pendingPath = join(state, PENDING_FILE);
  if (existsSync(pendingPath)) {
    const existing = readJson<PendingEnvelope>(pendingPath);
    if (existing === undefined) throw new Error('Existing pending finalization is unreadable');
    if (!verifySignedEnvelope(existing, input.signer.publicKey) || JSON.stringify(existing.payload) !== JSON.stringify(pending)) throw new Error('Pending finalization already exists with different content');
    return existing.payload;
  }
  writeAtomically(pendingPath, jsonBytes(pendingEnvelope(input, pending)));
  return pending;
}

async function complete(input: FinalizeRunInput, pending: PendingPayload): Promise<FinalizationResult> {
  const artifactRoot = resolve(pending.artifactRoot);
  const stateRoot = resolve(pending.stateRoot);
  const files = decodePendingFiles(pending);
  ensureArtifactRootEmptyOrOwned(artifactRoot, files, pending.replay.artifactPath);
  // Stable source/manifest/journal artifacts are installed first. Receipt
  // files are deliberately held until after replay is durable.
  writeEvidenceFiles(artifactRoot, nonReceiptFiles(files), true);
  const replay = normalizeReplayResult(await input.replayAppender.ensureAppended(pending.replay), pending.replay);
  const replayAbsolute = assertPathInRoot(artifactRoot, pending.replay.artifactPath);
  if (!existsSync(replayAbsolute)) throw new Error(`Replay appender did not materialize ${pending.replay.artifactPath}`);
  if (replay.artifactSha256 !== undefined && sha256(readFileSync(replayAbsolute)) !== replay.artifactSha256) throw new Error('Replay artifact hash does not match appender result');
  writeEvidenceFiles(artifactRoot, receiptFiles(files), true);
  const terminalRoot = createTerminalRoot({
    runId: pending.runId,
    directory: artifactRoot,
    signer: input.signer,
    ...(pending.manifestHash === undefined ? {} : { manifestHash: pending.manifestHash }),
    ledgerRootHash: replay.ledgerRootHash,
    fence: pending.fence,
  });
  writeAtomically(terminalRootPath(artifactRoot), jsonBytes(terminalRoot));
  terminalMarker(input, terminalRoot, replay, receiptFiles(files));
  return result(input, 'terminal', { terminalRoot, ledgerRootHash: replay.ledgerRootHash });
}

/** Finalize only after an independently observed committed transaction. */
export async function finalizeRun(input: FinalizeRunInput): Promise<FinalizationResult> {
  validateIdentity(input);
  assertEvidenceRoots(input);
  const pending = verifyPending(statePath(input.stateRoot, PENDING_FILE), input.signer, input);
  if (pending === undefined) return failure(input, 'frozen', 'No signed pending finalization exists');
  if (resolve(input.artifactRoot) !== pending.artifactRoot || resolve(input.stateRoot) !== pending.stateRoot) {
    return failure(input, 'frozen', 'Requested evidence/state roots do not match signed pending finalization');
  }
  const observed = await observe(input.transaction);
  try { assertObservation(input, observed); } catch (error) { return failure(input, 'frozen', describe(error)); }
  const existingTerminal = verifyStatus(statePath(pending.stateRoot, TERMINAL_FILE), input.signer, input);
  if (existingTerminal?.state === 'terminal') {
    let root: TerminalRoot;
    try {
      root = verifyTerminalArtifact(terminalRootPath(pending.artifactRoot), pending.artifactRoot, input.signer, input, existingTerminal.terminalRootHash);
    } catch (error) {
      return failure(input, 'frozen', `Terminal marker exists but terminal root cannot be verified: ${describe(error)}`);
    }
    return result(input, 'terminal', { terminalRoot: root, ledgerRootHash: existingTerminal.ledgerRootHash });
  }
  if (observed.status !== 'committed') {
    if (observed.status === 'in-progress') return result(input, 'in-progress', { reason: 'Transaction has not committed yet' });
    if (observed.status === 'no-commit') return failure(input, 'failed', observed.reason ?? 'Transaction completed without a commit');
    return failure(input, 'frozen', observed.reason);
  }
  try {
    writeSigned(statePath(pending.stateRoot, COMMITTED_FILE), DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, statusPayload(input, 'committed-unreceipted', input.now), input.signer);
    return await complete(input, pending);
  } catch (error) {
    return failure(input, 'frozen', `Post-commit evidence finalization failed: ${describe(error)}`);
  }
}

/**
 * Recover a prepared run. A committed journal is sufficient to replay the
 * deterministic finalization; a restored/frozen/no-journal run is never
 * reported as accepted. A non-terminal journal remains in-progress.
 */
export async function recoverFinalization(input: RecoveryInput): Promise<FinalizationResult> {
  const base: FinalizeRunInput = { ...input, files: [], replay: { nonce: 'placeholder-placeholder', artifactPath: 'replay-ledger.jsonl' }, manifestHash: undefined };
  validateIdentity(input);
  assertEvidenceRoots(input);
  const pending = verifyPending(statePath(input.stateRoot, PENDING_FILE), input.signer, input);
  if (pending === undefined) return failure(input, 'frozen', 'No signed pending finalization exists');
  if (resolve(input.artifactRoot) !== pending.artifactRoot || resolve(input.stateRoot) !== pending.stateRoot) {
    return failure(input, 'frozen', 'Requested evidence/state roots do not match signed pending finalization');
  }
  const terminal = verifyStatus(statePath(input.stateRoot, TERMINAL_FILE), input.signer, input);
  if (terminal?.state === 'terminal') {
    let root: TerminalRoot;
    try {
      root = verifyTerminalArtifact(terminalRootPath(input.artifactRoot), input.artifactRoot, input.signer, input, terminal.terminalRootHash);
    } catch (error) {
      return failure(input, 'frozen', `Terminal marker cannot be verified: ${describe(error)}`);
    }
    return result(input, 'terminal', { terminalRoot: root, ledgerRootHash: terminal.ledgerRootHash });
  }
  const observed = await observe(input.transaction);
  try { assertObservation(input, observed); } catch (error) { return failure(input, 'frozen', describe(error)); }
  if (observed.status === 'in-progress') return result(input, 'in-progress', { reason: 'Transaction is still active' });
  if (observed.status === 'no-commit') return failure(input, 'failed', observed.reason ?? 'Transaction did not commit');
  if (observed.status === 'unknown') return failure(input, 'frozen', observed.reason);
  return complete({ ...base, transaction: observed }, pending);
}

/** Read a transaction journal without granting it any write authority. */
export async function observeTransactionJournal(identity: FinalizationIdentity, journalPath: string): Promise<TransactionObservation> {
  validateIdentity(identity);
  let events: JournalEvent[];
  try {
    events = await new TransactionJournal(journalPath).read();
  } catch (error) {
    return { status: 'unknown', ...identity, reason: `Unable to read transaction journal: ${describe(error)}` };
  }
  const matching = events.filter(event => event.transactionId === identity.transactionId);
  if (matching.some(event => event.planHash !== identity.planHash)) return { status: 'unknown', ...identity, reason: 'Transaction plan hash differs from pending evidence' };
  const latest = [...matching].sort((left, right) => right.sequence - left.sequence)[0];
  if (latest?.kind === 'committed') return { status: 'committed', ...identity };
  if (latest === undefined || latest.kind === 'restored' || latest.kind === 'frozen' || latest.kind === 'recovered') return { status: 'no-commit', ...identity, reason: latest?.kind ?? 'no transaction journal' };
  return { status: 'in-progress', ...identity };
}

/**
 * Inspect only the durable finalization state. This deliberately reports
 * committed-unreceipted separately from terminal: the former means the
 * vault commit is known but the evidence root has not reached its final
 * terminal marker yet.
 */
export function inspectFinalization(input: {
  readonly stateRoot: string;
  readonly signer: Signer;
  readonly identity?: FinalizationIdentity;
}): FinalizationInspection {
  const identity = input.identity;
  const pending = readJson<PendingEnvelope>(statePath(input.stateRoot, PENDING_FILE));
  const expected = identity ?? (pending?.payload === undefined ? undefined : {
    runId: pending.payload.runId,
    transactionId: pending.payload.transactionId,
    planHash: pending.payload.planHash,
    fence: pending.payload.fence,
  });
  if (expected === undefined) return { state: 'missing' };
  const pendingPayload = pending === undefined ? undefined : verifyPending(statePath(input.stateRoot, PENDING_FILE), input.signer, expected);
  const terminal = verifyStatus(statePath(input.stateRoot, TERMINAL_FILE), input.signer, expected);
  if (terminal?.state === 'terminal') return { state: 'terminal', pending: pendingPayload, status: terminal };
  const committed = verifyStatus(statePath(input.stateRoot, COMMITTED_FILE), input.signer, expected);
  if (committed?.state === 'committed-unreceipted') return { state: 'committed-unreceipted', pending: pendingPayload, status: committed };
  const failed = verifyStatus(statePath(input.stateRoot, FAILURE_FILE), input.signer, expected);
  if (failed?.state === 'failed') return { state: 'failed', pending: pendingPayload, status: failed };
  if (failed?.state === 'frozen') return { state: 'frozen', pending: pendingPayload, status: failed };
  if (pendingPayload !== undefined) return { state: 'pending', pending: pendingPayload };
  return { state: 'missing' };
}

export const prepareRunFinalization = prepareFinalization;
export const finalizeRunEvidence = finalizeRun;
export const recoverRunFinalization = recoverFinalization;
