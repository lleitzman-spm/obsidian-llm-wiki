import { normalizePath } from 'obsidian';
import type { App, DataAdapter } from 'obsidian';
import type { IngestionLeaseContext } from './ingestion-coordinator';
import type { AuthoritativeSourceSnapshot } from './physical-source-authority';

/** Unforgeable capability for the source-specific, confirmed re-ingest path. */
export interface GovernedForceReingest {
  readonly sourcePath: string;
  readonly sourceSnapshot: AuthoritativeSourceSnapshot;
  readonly ingestionContext: IngestionLeaseContext;
  readonly signal: AbortSignal;
}

interface JournalArtifact {
  path: string;
  existed: boolean;
  kind: 'file' | 'folder';
  preimage?: string;
  sha256?: string;
  size?: number;
  ownedPostimages?: Array<{ sha256: string; size: number }>;
  ownedAbsent?: boolean;
  folderOwnershipToken?: string;
  folderTempPath?: string;
}

interface JournalBody {
  version: 1;
  sequence: number;
  transactionId: string;
  state: 'active' | 'committed';
  sourcePath: string;
  sourceSha256: string;
  createdAt: string;
  artifacts: JournalArtifact[];
}

interface SignedJournal {
  body: JournalBody;
  hmacSha256: string;
}

const KEY_FILE = 'governed-reingest.key';
const JOURNAL_DIR = 'governed-reingest-transactions';
const FOLDER_MARKER = '.karpathywiki-reingest-owner';
const recoveryLockTails = new WeakMap<object, Promise<void>>();

/** Serialize every local rollback/recovery decision for one vault process. */
async function withRecoveryLock<T>(app: App, operation: () => Promise<T>): Promise<T> {
  const key = app.vault as unknown as object;
  const previous = recoveryLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => owned, () => owned);
  recoveryLockTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (recoveryLockTails.get(key) === tail) {
      void tail.then(() => {
        if (recoveryLockTails.get(key) === tail) recoveryLockTails.delete(key);
      });
    }
  }
}

function pluginRoot(app: Pick<App, 'vault'>): string {
  return normalizePath(`${app.vault.configDir}/plugins/karpathywiki`);
}

function transactionRoot(app: Pick<App, 'vault'>): string {
  return `${pluginRoot(app)}/${JOURNAL_DIR}`;
}

function keyPath(app: Pick<App, 'vault'>): string {
  return `${pluginRoot(app)}/${KEY_FILE}`;
}

function artifactPathIdentity(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Refuse absolute, traversing, aliased, or Windows-unsafe vault paths. */
function safeArtifactPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  if (!slashed || slashed.startsWith('/') || slashed.startsWith('//') || /^[A-Za-z]:($|\/)/.test(slashed)) {
    throw new Error(`Unsafe governed artifact path refused: ${path}`);
  }
  const rawSegments = slashed.split('/');
  if (rawSegments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe governed artifact path refused: ${path}`);
  }
  const normalized = normalizePath(slashed).normalize('NFC');
  for (const segment of normalized.split('/')) {
    // eslint-disable-next-line no-control-regex -- Windows vault path boundary
    if (!segment || /[\u0000-\u001f\u007f<>:"|?*]/.test(segment) || /[ .]$/.test(segment)) {
      throw new Error(`Unsafe governed artifact path refused: ${path}`);
    }
    const stem = segment.split('.')[0]?.toUpperCase() ?? '';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error(`Unsafe governed artifact path refused: ${path}`);
    }
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  return hex(new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource)));
}

async function hmacSha256(key: Uint8Array, message: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const block = new Uint8Array(64);
  const normalizedKey = key.length > 64
    ? new Uint8Array(await subtle.digest('SHA-256', key as BufferSource))
    : key;
  block.set(normalizedKey);
  const innerPad = Uint8Array.from(block, byte => byte ^ 0x36);
  const outerPad = Uint8Array.from(block, byte => byte ^ 0x5c);
  const innerInput = new Uint8Array(innerPad.length + message.length);
  innerInput.set(innerPad);
  innerInput.set(message, innerPad.length);
  const inner = new Uint8Array(await subtle.digest('SHA-256', innerInput));
  const outerInput = new Uint8Array(outerPad.length + inner.length);
  outerInput.set(outerPad);
  outerInput.set(inner, outerPad.length);
  return sha256(outerInput, subtle);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoApi = activeWindow.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is required for governed re-ingest custody');
  return cryptoApi.getRandomValues(bytes);
}

function randomId(): string {
  return `${Date.now().toString(36)}-${hex(randomBytes(16))}`;
}

async function ensureFolder(adapter: DataAdapter, path: string): Promise<void> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (!await adapter.exists(current)) throw error;
    }
  }
}

async function readBytes(adapter: DataAdapter, path: string): Promise<Uint8Array> {
  if (typeof adapter.readBinary === 'function') return new Uint8Array(await adapter.readBinary(path));
  return new TextEncoder().encode(await adapter.read(path));
}

async function writeBytes(adapter: DataAdapter, path: string, bytes: Uint8Array): Promise<void> {
  const separator = path.lastIndexOf('/');
  if (separator > 0) await ensureFolder(adapter, path.slice(0, separator));
  if (typeof adapter.writeBinary === 'function') {
    const copy = Uint8Array.from(bytes);
    await adapter.writeBinary(path, copy.buffer);
  } else {
    await adapter.write(path, new TextDecoder().decode(bytes));
  }
}

async function loadOrCreateKey(app: App): Promise<Uint8Array> {
  const adapter = app.vault.adapter;
  const path = keyPath(app);
  try {
    const key = fromBase64(await adapter.read(path));
    if (key.length !== 32) throw new Error('invalid key length');
    return key;
  } catch {
    await ensureFolder(adapter, pluginRoot(app));
    const candidate = randomBytes(32);
    const temp = `${path}.${randomId()}.tmp`;
    await adapter.write(temp, toBase64(candidate));
    try {
      if (await adapter.exists(path)) {
        await adapter.remove(temp);
        const existing = fromBase64(await adapter.read(path));
        if (existing.length !== 32) throw new Error('Governed re-ingest custody key is corrupt');
        return existing;
      }
      await adapter.rename(temp, path);
      const readback = fromBase64(await adapter.read(path));
      if (readback.length !== 32 || toBase64(readback) !== toBase64(candidate)) {
        throw new Error('Governed re-ingest custody key readback failed');
      }
      return readback;
    } finally {
      if (await adapter.exists(temp)) await adapter.remove(temp).catch(() => undefined);
    }
  }
}

async function signBody(body: JournalBody, key: Uint8Array, subtle: SubtleCrypto): Promise<SignedJournal> {
  return { body, hmacSha256: await hmacSha256(key, new TextEncoder().encode(canonicalJson(body)), subtle) };
}

async function verifyJournal(raw: string, key: Uint8Array, subtle: SubtleCrypto): Promise<SignedJournal | null> {
  try {
    const parsed = JSON.parse(raw) as SignedJournal;
    if (parsed?.body?.version !== 1 || typeof parsed.hmacSha256 !== 'string') return null;
    const expected = await hmacSha256(key, new TextEncoder().encode(canonicalJson(parsed.body)), subtle);
    return expected === parsed.hmacSha256 ? parsed : null;
  } catch {
    return null;
  }
}

async function removeTree(adapter: DataAdapter, path: string): Promise<void> {
  if (!await adapter.exists(path)) return;
  if (typeof adapter.rmdir === 'function') {
    await adapter.rmdir(path, true);
    return;
  }
  throw new Error('Recursive local removal is required for governed re-ingest custody');
}

export class GovernedReingestTransaction {
  private readonly adapter: DataAdapter;
  private constructor(
    private readonly app: App,
    private readonly subtle: SubtleCrypto,
    private readonly key: Uint8Array,
    private readonly directory: string,
    private body: JournalBody,
  ) {
    this.adapter = app.vault.adapter;
  }

  static async begin(app: App, source: AuthoritativeSourceSnapshot, subtle: SubtleCrypto): Promise<GovernedReingestTransaction> {
    const key = await loadOrCreateKey(app);
    const transactionId = randomId();
    const directory = `${transactionRoot(app)}/${transactionId}`;
    await ensureFolder(app.vault.adapter, directory);
    const body: JournalBody = {
      version: 1,
      sequence: 0,
      transactionId,
      state: 'active',
      sourcePath: source.path,
      sourceSha256: await sha256(source.bytes, subtle),
      createdAt: new Date().toISOString(),
      artifacts: [],
    };
    const transaction = new GovernedReingestTransaction(app, subtle, key, directory, body);
    await transaction.persist();
    await transaction.persistGenesis();
    return transaction;
  }

  private async persistGenesis(): Promise<void> {
    const path = `${this.directory}/genesis.json`;
    const signed = await signBody(this.body, this.key, this.subtle);
    await this.adapter.write(path, canonicalJson(signed));
    const verified = await verifyJournal(await this.adapter.read(path), this.key, this.subtle);
    if (!verified || verified.body.sequence !== 0 || verified.body.artifacts.length !== 0) {
      throw new Error('Governed re-ingest genesis failed authenticated readback');
    }
  }

  private async persist(body: JournalBody = this.body): Promise<void> {
    const slot = body.sequence % 2 === 0 ? 'manifest-a.json' : 'manifest-b.json';
    const path = `${this.directory}/${slot}`;
    const signed = await signBody(body, this.key, this.subtle);
    await this.adapter.write(path, canonicalJson(signed));
    const verified = await verifyJournal(await this.adapter.read(path), this.key, this.subtle);
    if (!verified || verified.body.sequence !== body.sequence) {
      throw new Error('Governed re-ingest journal failed authenticated readback');
    }
  }

  async beforeFileMutation(
    path: string,
    plannedContent?: string | Uint8Array,
    plannedDeletion = false,
  ): Promise<void> {
    if (this.body.state !== 'active') throw new Error('Governed re-ingest transaction is not active');
    const normalized = safeArtifactPath(path);
    const identity = artifactPathIdentity(normalized);
    const journalIdentity = artifactPathIdentity(transactionRoot(this.app));
    if (identity === journalIdentity || identity.startsWith(`${journalIdentity}/`)
      || identity === artifactPathIdentity(keyPath(this.app))) {
      throw new Error('Refusing governed custody self-mutation');
    }
    const existingArtifact = this.body.artifacts.find(artifact => artifactPathIdentity(artifact.path) === identity);
    const plannedBytes = typeof plannedContent === 'string'
      ? new TextEncoder().encode(plannedContent)
      : plannedContent;
    if (existingArtifact) {
      // The engine-wide ingestion lease serializes in-process writers. Re-read
      // at every write boundary and fail before mutation on any observable
      // external drift; DataAdapter does not expose cross-process CAS.
      const currentExists = await this.adapter.exists(existingArtifact.path);
      if (!currentExists && existingArtifact.existed) {
        throw new Error(`Artifact disappeared before governed mutation; preserving path: ${existingArtifact.path}`);
      }
      if (currentExists) {
        const current = await readBytes(this.adapter, existingArtifact.path);
        const currentHash = await sha256(current, this.subtle);
        const matchesPreimage = existingArtifact.existed
          && currentHash === existingArtifact.sha256
          && current.length === existingArtifact.size;
        const matchesOwned = existingArtifact.ownedPostimages?.some(postimage =>
          postimage.sha256 === currentHash && postimage.size === current.length) ?? false;
        if (!matchesPreimage && !matchesOwned) {
          throw new Error(`Artifact drifted before governed mutation; preserving path: ${existingArtifact.path}`);
        }
      }
      if (!plannedBytes) return;
      const plannedPostimage = {
        sha256: await sha256(plannedBytes, this.subtle),
        size: plannedBytes.length,
      };
      const ownedPostimages = existingArtifact.ownedPostimages ?? [];
      const updated: JournalArtifact = {
        ...existingArtifact,
        ownedAbsent: plannedDeletion ? true : plannedBytes ? false : existingArtifact.ownedAbsent,
        ownedPostimages: ownedPostimages.some(postimage =>
          postimage.sha256 === plannedPostimage.sha256 && postimage.size === plannedPostimage.size)
          ? ownedPostimages
          : [...ownedPostimages, plannedPostimage],
      };
      const nextBody: JournalBody = {
        ...this.body,
        sequence: this.body.sequence + 1,
        artifacts: this.body.artifacts.map(artifact => artifactPathIdentity(artifact.path) === identity ? updated : artifact),
      };
      await this.persist(nextBody);
      this.body = nextBody;
      return;
    }
    const existed = await this.adapter.exists(normalized);
    const bytes = existed ? await readBytes(this.adapter, normalized) : undefined;
    const postimage = plannedBytes
      ? { ownedPostimages: [{ sha256: await sha256(plannedBytes, this.subtle), size: plannedBytes.length }] }
      : {};
    const artifact: JournalArtifact = existed
      ? {
          path: normalized,
          existed: true,
          kind: 'file',
          preimage: toBase64(bytes!),
          sha256: await sha256(bytes!, this.subtle),
          size: bytes!.length,
          ...(plannedDeletion ? { ownedAbsent: true } : {}),
          ...postimage,
        }
      : { path: normalized, existed: false, kind: 'file', ...(plannedDeletion ? { ownedAbsent: true } : {}), ...postimage };
    const nextBody = { ...this.body, sequence: this.body.sequence + 1, artifacts: [...this.body.artifacts, artifact] };
    await this.persist(nextBody);
    this.body = nextBody;
    const stillExists = await this.adapter.exists(normalized);
    if (stillExists !== existed) throw new Error(`Artifact changed during governed custody capture: ${normalized}`);
    if (existed && await sha256(await readBytes(this.adapter, normalized), this.subtle) !== artifact.sha256) {
      throw new Error(`Artifact changed during governed custody capture: ${normalized}`);
    }
  }

  async beforeFolderMutation(path: string): Promise<void> {
    if (this.body.state !== 'active') throw new Error('Governed re-ingest transaction is not active');
    const normalized = safeArtifactPath(path);
    const identity = artifactPathIdentity(normalized);
    const journalIdentity = artifactPathIdentity(transactionRoot(this.app));
    if (identity === journalIdentity || identity.startsWith(`${journalIdentity}/`)
      || identity === artifactPathIdentity(keyPath(this.app))) {
      throw new Error('Refusing governed custody self-mutation');
    }
    if (this.body.artifacts.some(artifact => artifactPathIdentity(artifact.path) === identity)) return;
    const existed = await this.adapter.exists(normalized);
    const ownershipToken = existed ? undefined : randomId();
    const separator = normalized.lastIndexOf('/');
    const parent = separator >= 0 ? normalized.slice(0, separator) : '';
    const name = separator >= 0 ? normalized.slice(separator + 1) : normalized;
    const folderTempPath = existed
      ? undefined
      : `${parent ? `${parent}/` : ''}.${name}.reingest-${this.body.transactionId}.tmp`;
    const nextBody: JournalBody = {
      ...this.body,
      sequence: this.body.sequence + 1,
      artifacts: [...this.body.artifacts, {
        path: normalized,
        existed,
        kind: 'folder',
        ...(ownershipToken ? { folderOwnershipToken: ownershipToken } : {}),
        ...(folderTempPath ? { folderTempPath } : {}),
      }],
    };
    await this.persist(nextBody);
    this.body = nextBody;
    if (existed) return;

    // Create through an authenticated, transaction-unique staging directory,
    // then move it into place. The marker proves ownership at recovery; an
    // unrelated empty replacement is never removed by name alone.
    await this.adapter.mkdir(folderTempPath!);
    await this.adapter.write(`${folderTempPath}/${FOLDER_MARKER}`, ownershipToken!);
    await this.adapter.rename(folderTempPath!, normalized);
    const markerPath = `${normalized}/${FOLDER_MARKER}`;
    if (!await this.adapter.exists(markerPath) || await this.adapter.read(markerPath) !== ownershipToken) {
      throw new Error(`Governed folder ownership readback failed: ${normalized}`);
    }
  }

  async assertSourceUnchanged(source: AuthoritativeSourceSnapshot): Promise<void> {
    if (source.path !== this.body.sourcePath || await sha256(source.bytes, this.subtle) !== this.body.sourceSha256) {
      throw new Error(`Authoritative source changed during governed re-ingest: ${this.body.sourcePath}`);
    }
  }

  private async assertArtifactsReadyForCommit(): Promise<void> {
    for (const artifact of this.body.artifacts) {
      if (artifact.kind === 'folder') {
        if (!await this.adapter.exists(artifact.path)) {
          throw new Error(`Governed artifact disappeared before commit: ${artifact.path}`);
        }
        if (!artifact.existed) {
          const markerPath = `${artifact.path}/${FOLDER_MARKER}`;
          if (!artifact.folderOwnershipToken
            || !await this.adapter.exists(markerPath)
            || await this.adapter.read(markerPath) !== artifact.folderOwnershipToken) {
            throw new Error(`Governed folder ownership drifted before commit: ${artifact.path}`);
          }
          if (artifact.folderTempPath && await this.adapter.exists(artifact.folderTempPath)) {
            throw new Error(`Governed folder staging remained before commit: ${artifact.folderTempPath}`);
          }
        }
        continue;
      }

      const exists = await this.adapter.exists(artifact.path);
      if (artifact.ownedAbsent) {
        if (exists) throw new Error(`Governed deleted artifact reappeared before commit: ${artifact.path}`);
        continue;
      }
      const latestPostimage = artifact.ownedPostimages?.at(-1);
      if (latestPostimage) {
        if (!exists || !await fileMatches(this.adapter, artifact.path, latestPostimage, this.subtle)) {
          throw new Error(`Governed artifact drifted before commit: ${artifact.path}`);
        }
        continue;
      }
      if (artifact.existed) {
        if (!exists || artifact.sha256 === undefined || artifact.size === undefined
          || !await fileMatches(this.adapter, artifact.path, { sha256: artifact.sha256, size: artifact.size }, this.subtle)) {
          throw new Error(`Governed preimage drifted before commit: ${artifact.path}`);
        }
      } else if (exists) {
        throw new Error(`Unplanned governed artifact appeared before commit: ${artifact.path}`);
      }
    }
    const sourceBytes = await readBytes(this.adapter, this.body.sourcePath);
    if (await sha256(sourceBytes, this.subtle) !== this.body.sourceSha256) {
      throw new Error(`Authoritative source changed at governed commit boundary: ${this.body.sourcePath}`);
    }
  }

  async commit(): Promise<void> {
    if (this.body.state === 'committed') return;
    await withRecoveryLock(this.app, async () => {
      await this.assertArtifactsReadyForCommit();
      const nextBody: JournalBody = { ...this.body, sequence: this.body.sequence + 1, state: 'committed' };
      await this.persist(nextBody);
      this.body = nextBody;
      const committedDirectory = `${this.directory}.committed`;
      await this.adapter.rename(this.directory, committedDirectory);
      await cleanupCommittedFolders(this.app, this.body);
      await removeTree(this.adapter, committedDirectory);
    });
  }

  async rollback(): Promise<void> {
    if (this.body.state === 'committed') return;
    await withRecoveryLock(this.app, async () => {
      await restoreBody(this.app, this.body, this.subtle, this.directory, true);
      await removeTree(this.adapter, this.directory);
    });
  }
}

async function restoreBody(
  app: App,
  body: JournalBody,
  subtle: SubtleCrypto,
  recoveryDirectory: string,
  allowCreatedCleanup: boolean,
): Promise<void> {
  const adapter = app.vault.adapter;
  const reversed = [...body.artifacts].map((artifact, index) => ({ artifact, index })).reverse();
  for (const { artifact, index } of reversed) {
    if (artifact.kind === 'folder') {
      if (!artifact.existed) {
        await rollbackCreatedFolder(adapter, artifact);
      }
      continue;
    }
    await restoreFileArtifact(adapter, artifact, subtle, recoveryDirectory, index, allowCreatedCleanup);
  }
}

async function fileMatches(
  adapter: DataAdapter,
  path: string,
  expected: { sha256: string; size: number },
  subtle: SubtleCrypto,
): Promise<boolean> {
  if (!await adapter.exists(path)) return false;
  const bytes = await readBytes(adapter, path);
  return bytes.length === expected.size && await sha256(bytes, subtle) === expected.sha256;
}

async function restoreClaimToTarget(adapter: DataAdapter, claim: string, target: string): Promise<void> {
  if (await adapter.exists(target)) {
    throw new Error(`Recovery target was concurrently replaced; preserving claimed bytes: ${target}`);
  }
  await adapter.rename(claim, target);
}

async function restoreFileArtifact(
  adapter: DataAdapter,
  artifact: JournalArtifact,
  subtle: SubtleCrypto,
  recoveryDirectory: string,
  index: number,
  allowCreatedCleanup: boolean,
): Promise<void> {
  const claimRoot = `${recoveryDirectory}/claims`;
  const claim = `${claimRoot}/file-${index}.claimed`;
  const owned = artifact.ownedPostimages ?? [];
  const preimage = artifact.existed && artifact.preimage && artifact.sha256 && artifact.size !== undefined
    ? { bytes: fromBase64(artifact.preimage), sha256: artifact.sha256, size: artifact.size }
    : null;
  if (artifact.existed && !preimage) throw new Error(`Missing governed preimage: ${artifact.path}`);
  if (preimage && (preimage.bytes.length !== preimage.size
    || await sha256(preimage.bytes, subtle) !== preimage.sha256)) {
    throw new Error(`Governed preimage authentication failed: ${artifact.path}`);
  }

  // After a process restart DataAdapter supplies no durable file identity or
  // exclusive-create proof. A file at a path that was absent before the run
  // could be an unrelated replacement, even when its bytes equal a planned
  // postimage. Preserve it and block for review. Same-process rollback is
  // permitted because the active engine lease owns the mutation interval.
  if (!artifact.existed && !allowCreatedCleanup) {
    if (await adapter.exists(artifact.path) || await adapter.exists(claim)) {
      throw new Error(`Created artifact ownership cannot be re-established after restart; preserving path: ${artifact.path}`);
    }
    return;
  }

  // A signed postimage proves what this transaction intended to write, but it
  // does not prove the identity of a file found at that path after a process
  // restart. DataAdapter has no durable file identity or cross-process CAS, so
  // restart recovery may only converge automatically when the exact signed
  // preimage is already in place. Every other existing-file state is preserved
  // and blocks startup for reviewed/manual resolution. Same-process rollback is
  // still safe below because the engine-wide lease owns that mutation interval.
  if (artifact.existed && !allowCreatedCleanup) {
    if (await adapter.exists(claim)) {
      throw new Error(`Existing artifact has unresolved recovery custody; preserving claim: ${artifact.path}`);
    }
    if (!await adapter.exists(artifact.path)) {
      throw new Error(`Existing artifact is absent after restart; refusing unowned restoration: ${artifact.path}`);
    }
    if (!await fileMatches(adapter, artifact.path, preimage!, subtle)) {
      throw new Error(`Existing artifact ownership cannot be re-established after restart; preserving path: ${artifact.path}`);
    }
    return;
  }

  // Move the path into journal-local quarantine before any destructive
  // decision. In-process recoveries are serialized by withRecoveryLock; the
  // claim survives a crash and is revalidated on the next startup. DataAdapter
  // exposes no cross-process CAS, so any observable drift blocks recovery.
  if (!await adapter.exists(claim) && await adapter.exists(artifact.path)) {
    await ensureFolder(adapter, claimRoot);
    await adapter.rename(artifact.path, claim);
  }

  if (await adapter.exists(claim)) {
    const claimedBytes = await readBytes(adapter, claim);
    const claimed = { sha256: await sha256(claimedBytes, subtle), size: claimedBytes.length };
    const isPreimage = Boolean(preimage
      && claimed.sha256 === preimage.sha256 && claimed.size === preimage.size);
    const isOwned = owned.some(postimage =>
      postimage.sha256 === claimed.sha256 && postimage.size === claimed.size);
    if (!isPreimage && !isOwned) {
      if (!await adapter.exists(artifact.path)) await adapter.rename(claim, artifact.path);
      throw new Error(`Artifact changed after interruption; preserving path: ${artifact.path}`);
    }

    if (!artifact.existed) {
      // The isolated bytes are transaction-owned. A concurrent replacement at
      // the original path, if any, remains untouched.
      await adapter.remove(claim);
      return;
    }
    if (isPreimage) {
      if (await adapter.exists(artifact.path)) {
        if (!await fileMatches(adapter, artifact.path, preimage!, subtle)) {
          throw new Error(`Recovery target was concurrently replaced; preserving claimed bytes: ${artifact.path}`);
        }
        await adapter.remove(claim);
      } else {
        await restoreClaimToTarget(adapter, claim, artifact.path);
      }
      return;
    }
  }

  if (!artifact.existed) return;
  if (await adapter.exists(artifact.path)) {
    if (await fileMatches(adapter, artifact.path, preimage!, subtle)) {
      if (await adapter.exists(claim)) await adapter.remove(claim);
      return;
    }
    throw new Error(`Recovery target was concurrently replaced; preserving claim: ${artifact.path}`);
  }
  const restoreTemp = `${claimRoot}/file-${index}.restore`;
  if (!await adapter.exists(restoreTemp)) {
    await writeBytes(adapter, restoreTemp, preimage!.bytes);
  }
  if (!await fileMatches(adapter, restoreTemp, preimage!, subtle)) {
    throw new Error(`Governed rollback staging readback failed: ${artifact.path}`);
  }
  if (await adapter.exists(artifact.path)) {
    throw new Error(`Recovery target was concurrently replaced; preserving staged preimage: ${artifact.path}`);
  }
  await adapter.rename(restoreTemp, artifact.path);
  if (!await fileMatches(adapter, artifact.path, preimage!, subtle)) {
    throw new Error(`Governed rollback readback failed: ${artifact.path}`);
  }
  if (await adapter.exists(claim)) await adapter.remove(claim);
}

async function verifyOwnedFolderOnly(adapter: DataAdapter, path: string, artifact: JournalArtifact): Promise<void> {
  const markerPath = `${path}/${FOLDER_MARKER}`;
  if (!artifact.folderOwnershipToken
    || !await adapter.exists(markerPath)
    || await adapter.read(markerPath) !== artifact.folderOwnershipToken) {
    throw new Error(`Created folder ownership is unproven; preserving path: ${artifact.path}`);
  }
  const listing = await adapter.list(path);
  const onlyMarker = listing.folders.length === 0
    && listing.files.length === 1
    && listing.files[0] === markerPath;
  if (!onlyMarker) {
    throw new Error(`Created folder contains unrelated artifacts; preserving path: ${artifact.path}`);
  }
}

async function rollbackCreatedFolder(adapter: DataAdapter, artifact: JournalArtifact): Promise<void> {
  if (!artifact.folderTempPath) {
    throw new Error(`Created folder recovery path is missing; preserving path: ${artifact.path}`);
  }
  const temp = artifact.folderTempPath;

  // A prior recovery may already have moved the owned directory aside.
  // Validate it before removal; never recursively delete by path alone.
  if (await adapter.exists(temp)) {
    try {
      await verifyOwnedFolderOnly(adapter, temp, artifact);
    } catch (error) {
      if (!await adapter.exists(artifact.path)) {
        await adapter.rename(temp, artifact.path);
      }
      throw error;
    }
    await removeTree(adapter, temp);
    return;
  }
  if (!await adapter.exists(artifact.path)) return;

  await verifyOwnedFolderOnly(adapter, artifact.path, artifact);
  // Move the target aside, then revalidate its marker and contents before
  // removal. An observable replacement blocks and is preserved; this is not
  // represented as cross-process compare-and-swap.
  await adapter.rename(artifact.path, temp);
  try {
    await verifyOwnedFolderOnly(adapter, temp, artifact);
  } catch (error) {
    if (!await adapter.exists(artifact.path)) await adapter.rename(temp, artifact.path);
    throw error;
  }
  await removeTree(adapter, temp);
}

async function cleanupCommittedFolders(app: App, body: JournalBody): Promise<void> {
  const adapter = app.vault.adapter;
  for (const artifact of body.artifacts) {
    if (artifact.kind !== 'folder' || artifact.existed) continue;
    if (artifact.folderTempPath && await adapter.exists(artifact.folderTempPath)) {
      throw new Error(`Committed governed folder has unresolved staging state: ${artifact.folderTempPath}`);
    }
    if (!await adapter.exists(artifact.path)) continue;
    const markerPath = `${artifact.path}/${FOLDER_MARKER}`;
    // Marker absence means a prior committed-cleanup attempt already removed
    // it. Committed recovery never rolls back or deletes final user artifacts.
    if (!await adapter.exists(markerPath)) continue;
    if (!artifact.folderOwnershipToken
      || await adapter.read(markerPath) !== artifact.folderOwnershipToken) {
      throw new Error(`Committed folder ownership marker is missing: ${artifact.path}`);
    }
    await adapter.remove(markerPath);
  }
}

async function readLatestJournal(app: App, directory: string, key: Uint8Array, subtle: SubtleCrypto): Promise<JournalBody | null> {
  const candidates: JournalBody[] = [];
  for (const slot of ['manifest-a.json', 'manifest-b.json']) {
    const path = `${directory}/${slot}`;
    if (!await app.vault.adapter.exists(path)) continue;
    const verified = await verifyJournal(await app.vault.adapter.read(path), key, subtle);
    if (verified) candidates.push(verified.body);
  }
  candidates.sort((left, right) => right.sequence - left.sequence);
  if (!candidates[0]) {
    const genesisPath = `${directory}/genesis.json`;
    const genesis = await app.vault.adapter.exists(genesisPath)
      ? await verifyJournal(await app.vault.adapter.read(genesisPath), key, subtle)
      : null;
    // Unknown or corrupt directories are never recursively deleted by name.
    // Without an authenticated genesis there is no ownership proof, so leave
    // every byte in place and block for manual review.
    if (!genesis) throw new Error(`Unauthenticated governed recovery directory preserved: ${directory}`);
    throw new Error(`Authenticated governed re-ingest journal is damaged: ${directory}`);
  }
  return candidates[0];
}

/** Recover every interrupted transaction before startup cleaners may run. */
export async function recoverGovernedReingestTransactions(app: App, subtle: SubtleCrypto): Promise<number> {
  return withRecoveryLock(app, async () => {
    const root = transactionRoot(app);
    if (!await app.vault.adapter.exists(root)) return 0;
    const listing = await app.vault.adapter.list(root);
    if (listing.folders.length === 0) return 0;
    let key: Uint8Array;
    try {
      key = fromBase64(await app.vault.adapter.read(keyPath(app)));
      if (key.length !== 32) throw new Error('invalid key length');
    } catch {
      throw new Error('Governed re-ingest custody key is missing; preserving recovery journals');
    }
    let recovered = 0;
    for (const directory of listing.folders.sort()) {
      if (directory.endsWith('.committed')) {
        const committedBody = await readLatestJournal(app, directory, key, subtle);
        if (!committedBody) throw new Error(`Committed governed journal is unreadable: ${directory}`);
        if (committedBody.state !== 'committed') {
          throw new Error(`Committed governed directory contains an active journal: ${directory}`);
        }
        await cleanupCommittedFolders(app, committedBody);
        await removeTree(app.vault.adapter, directory);
        continue;
      }
      const body = await readLatestJournal(app, directory, key, subtle);
      if (!body) throw new Error(`Unauthenticated governed recovery directory preserved: ${directory}`);
      if (body.state === 'active') {
        await restoreBody(app, body, subtle, directory, false);
        recovered++;
      } else {
        // Crash after the authenticated commit frame but before the journal
        // directory rename. Final artifacts stay committed; only local folder
        // ownership markers and the completed journal are cleaned up.
        await cleanupCommittedFolders(app, body);
      }
      await removeTree(app.vault.adapter, directory);
    }
    return recovered;
  });
}
