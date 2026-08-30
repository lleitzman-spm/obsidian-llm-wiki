import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import {
  DOMAINS,
  ReplayLedger,
  digestHex,
  hashCanonical,
  verifyContractSignature,
  type JsonValue,
} from '../crypto';
import { buildTagVocabulary, verifySignedSettingsProjection } from '../policy-pack';
import { captureSettingsHashes } from '../preflight/settings';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../preflight/hashing';
import { assertSafeCopyRoots, type SafeCopyRoots } from '../preflight/roots';
import {
  captureSnapshot,
  compareSnapshots,
  copySnapshot,
  type CopySnapshotManifest,
} from '../copy-snapshot';
import {
  createNativeMapPolicy,
  mapNativeSource,
  NATIVE_MAP_DEFAULT_EXTRACTED_AT,
  type NativeMapIR,
  type NativeMapPolicy,
  type NativeMapSource,
} from '../native-map';
import {
  nativeMapIRToSourceScopedIR,
  reduceNativeMapIR,
  type NativeExistingPage,
  type NativeReductionPlan,
} from '../native-reducer';
import {
  runNativeReference,
  type NativeReferenceInput,
  type NativeReferenceResult,
} from '../native-reference';
import { buildNativeReferenceProjection, type NativeProjectionVault } from '../native-reference/projection';
import { compareNativeCandidate } from '../comparison';
import {
  FilesystemLease,
  type LeaseHandle,
} from '../lease';
import {
  AdaptiveConcurrencyController,
  type AdaptiveConcurrencyController as AdaptiveConcurrencyControllerType,
} from '../scheduler';
import {
  createTransactionPlan,
  NodeTransactionFileSystem,
  TransactionEngine,
  type SnapshotFile,
  type StagedFile,
  type TransactionPlan,
  type TransactionReceipt,
} from '../transaction';
import {
  finalizeRun,
  prepareFinalization,
  type FinalizationResult,
  type ReplayAppender,
} from '../finalization';
import {
  independentlyVerifyNativeCanaryArtifacts,
  type VerifiedNativeCanaryArtifacts,
} from '../verification';
import { parseFrontmatter } from '../../../../../src/core/frontmatter';
import type { LLMWikiSettings } from '../../../../../src/types';
import type { ContractSemanticProjection } from '../provenance/types';
import type {
  LiveIdleObservation,
  NativeCanaryCopies,
  NativeCanaryInput,
  NativeCanaryRefusalCode,
  NativeCanaryResult,
  NativeCanaryWriterBinding,
  NativeReferenceRunner,
} from './types';
import {
  LIVE_IDLE_OBSERVATION_VERSION,
  NATIVE_CANARY_VERSION,
  NativeCanaryRefusal,
} from './types';

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_OBSERVATION_AGE_MS = 60_000;
const FUTURE_OBSERVATION_SKEW_MS = 5_000;
const ZERO_CHECKPOINT = '0'.repeat(64);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const a = nodePath.resolve(left);
  const b = nodePath.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fail(code: NativeCanaryRefusalCode, message: string, details: readonly string[] = []): never {
  throw new NativeCanaryRefusal(code, message, details);
}

function wrap(code: NativeCanaryRefusalCode, message: string, error: unknown): never {
  if (error instanceof NativeCanaryRefusal) throw error;
  fail(code, message, [describe(error)]);
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail('invalid-input', `${label} must be a non-empty NUL-free string`);
  }
  return value.trim();
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail('invalid-input', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function relativePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').normalize('NFKC');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0')) {
    fail('invalid-input', `${label} must be a safe relative path`);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
    fail('invalid-input', `${label} contains an unsafe path component`);
  }
  return parts.join('/');
}

function jsonText(value: unknown): string {
  const output = JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Uint8Array) return Buffer.from(nested).toString('base64');
    return nested;
  });
  if (output === undefined) throw new Error('Evidence value is not JSON-serializable');
  return `${output}\n`;
}

function normalizeInventoryPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFKC');
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe source inventory path: ${path}`);
  }
  return parts.join('/');
}

function validateSourceInventory(input: NativeCanaryInput): void {
  const inventory = input.sourceInventory;
  if (inventory.version !== 'source-inventory/v1' || inventory.authorityTree !== input.authority.tree) {
    fail('source-manifest-mismatch', 'Source inventory version or authority tree does not match the canary authority');
  }
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) {
    fail('source-manifest-mismatch', 'Source inventory must contain at least one source');
  }
  const paths = new Set<string>();
  for (const [index, source] of inventory.sources.entries()) {
    let path: string;
    try { path = normalizeInventoryPath(source.path); } catch (error) { wrap('source-manifest-mismatch', `Source inventory path ${index} is unsafe`, error); }
    if (source.path !== path || paths.has(path)) fail('source-manifest-mismatch', `Source inventory path is not canonical or is duplicated: ${path}`);
    paths.add(path);
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) fail('source-manifest-mismatch', `Invalid byte length for ${path}`);
    const byteHash = requireDigest(source.byteSha256, `Source byte hash for ${path}`);
    let expectedIdentity: string;
    try { expectedIdentity = sourceIdentityDigest(input.authority.tree, path, byteHash); } catch (error) { wrap('source-manifest-mismatch', `Unable to derive source identity for ${path}`, error); }
    if (source.sourceIdentity !== expectedIdentity) fail('source-manifest-mismatch', `Source identity is not bound to authority/path/bytes for ${path}`);
  }
  const body = {
    version: inventory.version,
    authorityTree: inventory.authorityTree,
    selectorVersion: inventory.selectorVersion,
    includes: inventory.includes,
    exclusions: inventory.exclusions,
    sources: inventory.sources,
    snapshotTreeHash: inventory.snapshotTreeHash,
  };
  try {
    if (inventory.snapshotTreeHash !== snapshotTreeHash(inventory.sources.map(source => ({ path: source.path, byteSha256: source.byteSha256 })))) {
      fail('source-manifest-mismatch', 'Source inventory snapshot tree hash is incorrect');
    }
    if (inventory.inventorySha256 !== canonicalJsonSha256(body)) {
      fail('source-manifest-mismatch', 'Source inventory hash is incorrect');
    }
  } catch (error) {
    wrap('source-manifest-mismatch', 'Source inventory canonical binding could not be verified', error);
  }
}

function observationBody(observation: LiveIdleObservation): JsonValue {
  return {
    version: observation.version,
    runId: observation.runId,
    windowId: observation.windowId,
    liveRoot: observation.liveRoot,
    observedAt: observation.observedAt,
    idle: observation.idle,
    mutationSurface: observation.mutationSurface,
    statusDigest: observation.statusDigest,
  };
}

function validateObservation(input: NativeCanaryInput, observation: LiveIdleObservation, liveRoot: string): LiveIdleObservation {
  if (!observation || observation.version !== LIVE_IDLE_OBSERVATION_VERSION || observation.runId !== input.runId
    || observation.windowId !== input.windowId || !samePath(observation.liveRoot, liveRoot)
    || observation.idle !== true || observation.mutationSurface !== 'read-only') {
    fail('live-observation-invalid', 'Live observation is not an idle, read-only observation bound to this run/window/root');
  }
  requireDigest(observation.statusDigest, 'Live observation status digest');
  requireDigest(observation.signedDigest, 'Live observation signed digest');
  if (!observation.signature || observation.signature.signed_digest !== observation.signedDigest) {
    fail('live-observation-invalid', 'Live observation signature is not bound to its signed digest');
  }
  const expected = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, observationBody(observation)));
  if (expected !== observation.signedDigest) fail('live-observation-invalid', 'Live observation digest does not match its signed body');
  try {
    verifyContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, observation.signature, input.trustedRegistry, { runId: input.runId });
  } catch (error) {
    wrap('live-observation-invalid', 'Live observation signature is not trusted', error);
  }
  const observedAt = Date.parse(observation.observedAt);
  const now = input.now?.() ?? Date.now();
  if (!Number.isFinite(observedAt) || !Number.isFinite(now) || observedAt > now + FUTURE_OBSERVATION_SKEW_MS || now - observedAt > MAX_OBSERVATION_AGE_MS) {
    fail('live-observation-stale', 'Live observation is missing, future-dated, or older than the freshness window');
  }
  return observation;
}

function validateInputShape(input: NativeCanaryInput): void {
  requireNonEmpty(input.runId, 'runId');
  requireNonEmpty(input.windowId, 'windowId');
  requireNonEmpty(input.authority.repositoryUrl, 'authority.repositoryUrl');
  requireNonEmpty(input.authority.commit, 'authority.commit');
  requireNonEmpty(input.authority.tree, 'authority.tree');
  requireNonEmpty(input.provider.provider, 'provider.provider');
  requireNonEmpty(input.provider.model, 'provider.model');
  requireNonEmpty(input.provider.authorizationRef, 'provider.authorizationRef');
  if (typeof input.provider.createClient !== 'function' || typeof input.provider.mapClient?.createMessage !== 'function') {
    fail('invalid-input', 'Provider must supply an injected client factory and map client');
  }
  if (!input.signer || !input.trustedRegistry) fail('invalid-input', 'Signer and trusted registry are required');
  if (!input.policy || !input.global) fail('invalid-input', 'Policy and global bindings are required');
  const date = requireNonEmpty(input.global.date, 'global.date');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) fail('invalid-input', 'global.date must be YYYY-MM-DD');
  relativePath(input.global.wikiFolder, 'global.wikiFolder');
  relativePath(input.global.indexPath, 'global.indexPath');
  relativePath(input.global.logPath, 'global.logPath');
  relativePath(input.global.schemaPath, 'global.schemaPath');
  validateSourceInventory(input);
}

function candidateRootSha256(root: string): string {
  return sha256Hex(nodePath.resolve(root));
}

function validateWriterBinding(input: NativeCanaryInput): NativeCanaryWriterBinding | undefined {
  const binding = input.writerBinding;
  if (binding === undefined) return undefined;
  if (typeof binding.ownerId !== 'string' || !binding.ownerId.trim()
    || binding.runId !== input.runId
    || !Number.isSafeInteger(binding.fence) || binding.fence < 1
    || !HEX64.test(binding.candidateRootSha256)
    || binding.candidateRootSha256 !== candidateRootSha256(input.candidateRoot)) {
    fail('invalid-input', 'Writer owner/run/fence/candidate-root binding is invalid for this canary');
  }
  return binding;
}

async function assertWriterCurrent(input: NativeCanaryInput): Promise<void> {
  validateWriterBinding(input);
  if (!input.assertWriterCurrent) return;
  try {
    await input.assertWriterCurrent();
  } catch (error) {
    wrap('transaction-refused', 'Writer authority was lost before candidate mutation', error);
  }
}

async function validatePolicy(input: NativeCanaryInput): Promise<{ readonly hashes: ReturnType<typeof captureSettingsHashes>; readonly mapPolicy: NativeMapPolicy }> {
  const policy = input.policy;
  let hashes: ReturnType<typeof captureSettingsHashes>;
  try {
    hashes = captureSettingsHashes(policy.fullSettingsBytes, policy.safeSettingsProjection);
    await verifySignedSettingsProjection(policy.policyPack.settings, policy.verifySettingsSignature);
    const vocabulary = buildTagVocabulary(policy.policyPack.settings.projection);
    if (canonicalJsonSha256(vocabulary) !== canonicalJsonSha256(policy.policyPack.vocabulary)) {
      fail('policy-binding-mismatch', 'Signed tag vocabulary does not match the signed settings projection');
    }
    // The preflight-safe settings projection and the policy-pack's extraction
    // projection intentionally have different schemas.  They are both bound
    // below (the former through the native reference settings hashes and the
    // latter through the frozen map policy); requiring their raw hashes to be
    // equal would reject valid packs while providing no additional binding.
    const policyBody = {
      version: policy.policyPack.version,
      policy: policy.policyPack.policy,
      policySha256: policy.policyPack.policySha256,
      settings: policy.policyPack.settings,
      vocabulary: policy.policyPack.vocabulary,
    };
    if (policy.policyPack.policySha256 !== canonicalJsonSha256(policy.policyPack.policy)
      || policy.policyPack.policyPackSha256 !== canonicalJsonSha256(policyBody)) {
      fail('policy-binding-mismatch', 'Extraction policy-pack hashes are not self-consistent');
    }
    if (policy.policyPack.vocabulary.entityTags.length === 0 || policy.policyPack.vocabulary.conceptTags.length === 0) {
      fail('policy-binding-mismatch', 'Signed tag vocabularies must not be empty');
    }
    if (policy.nativeMapSettings.provider !== input.provider.provider
      || (policy.nativeMapSettings.model !== input.provider.model && policy.nativeMapSettings.ingestModel !== input.provider.model)) {
      fail('policy-binding-mismatch', 'Native map settings do not match the injected provider identity');
    }
    const mapPolicy = createNativeMapPolicy({
      settings: policy.nativeMapSettings,
      entityTags: policy.policyPack.vocabulary.entityTags,
      conceptTags: policy.policyPack.vocabulary.conceptTags,
      schemaContext: input.global.schemaContent,
      policyPackSha256: policy.policyPack.policyPackSha256,
      settingsSha256: policy.policyPack.settings.projectionSha256,
      vocabularySha256: policy.policyPack.vocabulary.vocabularySha256,
    });
    return { hashes, mapPolicy };
  } catch (error) {
    wrap('policy-binding-mismatch', 'Extraction settings, vocabulary, or policy-pack binding failed', error);
  }
}

async function copyVaults(input: NativeCanaryInput, roots: SafeCopyRoots, observation: LiveIdleObservation): Promise<NativeCanaryCopies> {
  let first: { source: CopySnapshotManifest; destination: CopySnapshotManifest };
  let second: { source: CopySnapshotManifest; destination: CopySnapshotManifest };
  try {
    const exclusions = ['run', 'lease'] as const;
    first = await copySnapshot({ root: roots.liveRoot.resolved, destinationRoot: roots.copyRoots[0].resolved, exclusions, syncRoots: input.syncRoots });
    // The two disposable copies are independent writer operations.  Re-check
    // the host lease between them so a revoked writer cannot start the second
    // copy after the authority boundary has already changed.
    await assertWriterCurrent(input);
    second = await copySnapshot({ root: roots.liveRoot.resolved, destinationRoot: roots.copyRoots[1].resolved, exclusions, syncRoots: input.syncRoots });
  } catch (error) {
    wrap('unsafe-root', 'Independent native/candidate snapshot copies could not be made safely', error);
  }
  const sourceComparison = compareSnapshots(first.source, second.source);
  if (!sourceComparison.exact) {
    fail('live-drift', 'Live vault changed between the two independently captured copy snapshots', [JSON.stringify(sourceComparison)]);
  }
  if (!samePath(first.source.root, roots.liveRoot.resolved)
    || !samePath(first.destination.root, roots.copyRoots[0].resolved)
    || !samePath(second.destination.root, roots.copyRoots[1].resolved)) {
    fail('unsafe-root', 'Snapshot manifests are not bound to the independently resolved roots');
  }
  void observation;
  return { live: first.source, native: first.destination, candidate: second.destination };
}

async function assertLiveUnchanged(input: NativeCanaryInput, live: CopySnapshotManifest): Promise<void> {
  try {
    const actual = await captureSnapshot({ root: live.root, exclusions: live.exclusions });
    const drift = compareSnapshots(live, actual);
    if (!drift.exact) fail('live-drift', 'Live vault drifted after the sealed initial snapshot', [JSON.stringify(drift)]);
  } catch (error) {
    wrap('live-drift', 'Unable to prove that the live vault remained unchanged', error);
  }
}

/**
 * Obtain a fresh signed live observation after the candidate-side work and
 * bind it to the sealed initial status and bytes.  This is deliberately a
 * separate gate from the pre-transaction observation: a successful candidate
 * transaction or terminal artifact can never stand in for proof that the
 * live Obsidian surface stayed unchanged.
 */
export async function validateTerminalLiveObservation(
  input: NativeCanaryInput,
  roots: SafeCopyRoots,
  copies: NativeCanaryCopies,
  initial: LiveIdleObservation,
): Promise<LiveIdleObservation> {
  let terminal: LiveIdleObservation;
  try {
    terminal = validateObservation(input, await input.observeLive(), roots.liveRoot.resolved);
  } catch (error) {
    wrap('live-observation-invalid', 'Terminal live idle observation failed closed', error);
  }
  try {
    await assertLiveUnchanged(input, copies.live);
  } catch (error) {
    if (error instanceof NativeCanaryRefusal) throw error;
    wrap('live-drift', 'Unable to prove the live vault remained unchanged at terminal observation', error);
  }
  if (terminal.statusDigest !== initial.statusDigest) {
    fail('live-drift', 'Terminal live observation status differs from the signed initial observation', [
      `initial=${initial.statusDigest}`,
      `terminal=${terminal.statusDigest}`,
    ]);
  }
  return terminal;
}

async function readSnapshotFiles(root: string, manifest: CopySnapshotManifest): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    for (const entry of manifest.entries) {
      if (!entry.path.toLowerCase().endsWith('.md')) continue;
      const bytes = await readFile(nodePath.join(root, ...entry.path.split('/')));
      if (bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.byteSha256) {
        throw new Error(`Snapshot file drifted while being read: ${entry.path}`);
      }
      files.set(entry.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
  } catch (error) {
    throw new Error(`Unable to read candidate snapshot files: ${describe(error)}`);
  }
  return files;
}

async function readSources(root: string, inventory: NativeCanaryInput['sourceInventory']): Promise<NativeMapSource[]> {
  const result: NativeMapSource[] = [];
  for (const source of inventory.sources) {
    try {
      const bytes = new Uint8Array(await readFile(nodePath.join(root, ...source.path.split('/'))));
      if (bytes.byteLength !== source.byteLength || sha256Hex(bytes) !== source.byteSha256) {
        fail('source-manifest-mismatch', `Candidate copy source differs from the authority inventory: ${source.path}`);
      }
      result.push({ sourceId: source.sourceIdentity, sourcePath: source.path, sourceBytes: bytes, extractedAt: NATIVE_MAP_DEFAULT_EXTRACTED_AT });
    } catch (error) {
      if (error instanceof NativeCanaryRefusal) throw error;
      wrap('source-manifest-mismatch', `Unable to read an authority-bound source from the candidate copy: ${source.path}`, error);
    }
  }
  return result;
}

function existingPages(wikiFolder: string, files: ReadonlyMap<string, string>): NativeExistingPage[] {
  const pages: NativeExistingPage[] = [];
  for (const [path, content] of files.entries()) {
    if (!path.startsWith(`${wikiFolder}/`) || !path.toLowerCase().endsWith('.md')) continue;
    const frontmatter = parseFrontmatter(content);
    const type = frontmatter?.type;
    if (type !== 'entity' && type !== 'concept' && type !== 'source' && type !== 'index' && type !== 'log' && type !== 'schema') continue;
    const label = nodePath.posix.basename(path, '.md');
    pages.push({ path, pageType: type, label, content, reviewed: frontmatter?.reviewed === true });
  }
  return pages.sort((left, right) => left.path.localeCompare(right.path));
}

async function boundedMap(
  input: NativeCanaryInput,
  policy: NativeMapPolicy,
  sources: readonly NativeMapSource[],
  scheduler: AdaptiveConcurrencyControllerType,
): Promise<NativeMapIR[]> {
  if (scheduler.snapshot().activeLanes !== 0) fail('candidate-map-failed', 'Injected scheduler already owns active lanes');
  scheduler.start(sources.length);
  const pending = [...sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const active = new Map<string, Promise<{ id: string; result: NativeMapIR }>>();
  const output = new Map<string, NativeMapIR>();
  try {
    while (pending.length > 0 || active.size > 0) {
      await scheduler.refreshCapacity();
      while (pending.length > 0 && scheduler.dispatchSlots() > 0) {
        const source = pending.shift();
        if (!source) break;
        const release = scheduler.tryStartLane(source.sourceId);
        if (!release) {
          pending.unshift(source);
          break;
        }
        const task = mapNativeSource({ source, policy, client: input.provider.mapClient })
          .then(result => {
            scheduler.recordTerminalSource({ sourceId: source.sourceId, status: 'success' });
            return { id: source.sourceId, result };
          })
          .catch(error => {
            scheduler.recordTerminalSource({ sourceId: source.sourceId, status: 'failed' });
            throw error;
          });
        active.set(source.sourceId, task);
      }
      if (active.size === 0) {
        if (pending.length > 0 && scheduler.isCoolingDown) {
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          continue;
        }
        if (pending.length > 0) fail('candidate-map-failed', 'Bounded scheduler could not dispatch a ready source');
        break;
      }
      const completed = await Promise.race(active.values());
      active.delete(completed.id);
      output.set(completed.id, completed.result);
    }
  } catch (error) {
    await Promise.allSettled(active.values());
    wrap('candidate-map-failed', 'Source-isolated native map failed', error);
  }
  return [...output.values()].sort((left, right) => left.source.sourceId.localeCompare(right.source.sourceId));
}

function projectionVault(root: string, manifest: CopySnapshotManifest): NativeProjectionVault {
  const markdown = manifest.entries
    .filter(entry => entry.path.toLowerCase().endsWith('.md'))
    .map(entry => ({ path: entry.path, name: nodePath.posix.basename(entry.path) }));
  return {
    getMarkdownFiles: () => markdown,
    read: async file => new TextDecoder('utf-8', { fatal: true }).decode(await readFile(nodePath.join(root, ...file.path.split('/')))),
  };
}

async function buildCandidateProjection(
  input: NativeCanaryInput,
  root: string,
  manifest: CopySnapshotManifest,
): Promise<ContractSemanticProjection> {
  try {
    return await buildNativeReferenceProjection({
      runId: input.runId,
      authorityTree: input.authority.tree,
      wikiFolder: input.global.wikiFolder,
      sourceInventory: input.sourceInventory.sources,
      vault: projectionVault(root, manifest),
    });
  } catch (error) {
    wrap('candidate-comparison-refused', 'Candidate semantic projection could not be built from the committed copy', error);
  }
}

async function runNative(
  input: NativeCanaryInput,
  roots: SafeCopyRoots,
  copies: NativeCanaryCopies,
  settingsHashes: ReturnType<typeof captureSettingsHashes>,
): Promise<NativeReferenceResult> {
  const nativeArtifactsRoot = nodePath.join(roots.copyRoots[2].resolved, 'native-reference');
  const runner: NativeReferenceRunner = input.nativeReference ?? { run: runNativeReference };
  const nativeInput: NativeReferenceInput = {
    runId: input.runId,
    mode: 'ingest',
    liveRoot: roots.liveRoot.resolved,
    copiedVaultRoot: roots.copyRoots[0].resolved,
    artifactRoot: nativeArtifactsRoot,
    syncRoots: input.syncRoots,
    sourceInventory: input.sourceInventory,
    settings: { fullSha256: settingsHashes.fullSettingsSha256, safeProjectionSha256: settingsHashes.safeSettingsProjectionSha256 },
    provider: {
      provider: input.provider.provider,
      model: input.provider.model,
      authorizationRef: input.provider.authorizationRef,
      createClient: input.provider.createClient,
    },
    signer: input.signer,
    sourcePaths: input.sourceInventory.sources.map(source => source.path),
    forceReingest: true,
    now: input.now,
  };
  let native: NativeReferenceResult;
  try {
    native = await runner.run(nativeInput);
  } catch (error) {
    wrap('native-rejected', 'Native reference execution refused or failed', error);
  }
  if (native.status !== 'accepted') fail('native-rejected', 'Native reference did not produce an accepted ingest', [native.errorMessage ?? 'unknown native error']);
  const before = compareSnapshots(copies.native, native.beforeSnapshot);
  if (!before.exact) fail('native-rejected', 'Native reference did not start from the sealed native copy', [JSON.stringify(before)]);
  if (native.runId !== input.runId || native.mode !== 'ingest'
    || native.binding.sourceInventorySha256 !== input.sourceInventory.inventorySha256
    || native.binding.settings.fullSha256 !== settingsHashes.fullSettingsSha256
    || native.binding.settings.safeProjectionSha256 !== settingsHashes.safeSettingsProjectionSha256
    || !samePath(native.binding.liveRoot, roots.liveRoot.resolved)
    || !samePath(native.binding.copiedVaultRoot, roots.copyRoots[0].resolved)) {
    fail('source-manifest-mismatch', 'Native reference result is not bound to the sealed source/settings/copy roots');
  }
  const selected = new Set(native.binding.sourceIdentities);
  if (selected.size !== input.sourceInventory.sources.length || input.sourceInventory.sources.some(source => !selected.has(source.sourceIdentity))) {
    fail('source-manifest-mismatch', 'Native reference did not process exactly the authority-bound source set');
  }
  return native;
}

function transactionEvidencePlan(plan: TransactionPlan): unknown {
  return {
    ...plan,
    operations: plan.operations.map(operation => ({
      ...operation,
      before: { ...operation.before, bytes: operation.before.bytes === null ? null : Buffer.from(operation.before.bytes).toString('base64') },
      after: { ...operation.after, bytes: operation.after.bytes === null ? null : Buffer.from(operation.after.bytes).toString('base64') },
    })),
  };
}

async function performCandidateTransaction(
  input: NativeCanaryInput,
  roots: SafeCopyRoots,
  copies: NativeCanaryCopies,
  reduction: NativeReductionPlan,
  observation: LiveIdleObservation,
): Promise<{
  readonly plan: TransactionPlan;
  readonly receipt: TransactionReceipt;
  readonly candidate: CopySnapshotManifest;
  readonly lease: LeaseHandle;
  readonly observation: LiveIdleObservation;
}> {
  const safeCandidateRoot = roots.copyRoots[1].resolved;
  const artifactRoot = roots.copyRoots[2].resolved;
  const journalPath = nodePath.join(artifactRoot, 'journals', `${input.runId}.transaction-journal.jsonl`);
  let lease: LeaseHandle;
  try {
    // Re-check the host launch authority before even creating candidate-side
    // lease metadata.  The isolated native worker cannot grant this authority.
    await assertWriterCurrent(input);
    lease = await new FilesystemLease(safeCandidateRoot, {
      now: input.now,
      metadataRoot: nodePath.join(artifactRoot, 'leases'),
    }).acquire({ ownerId: input.writerBinding?.ownerId ?? `native-canary:${input.signer.keyId}`, runId: input.runId });
    if (input.writerBinding
      && (lease.record.ownerId !== input.writerBinding.ownerId
        || lease.record.runId !== input.writerBinding.runId
        || candidateRootSha256(safeCandidateRoot) !== input.writerBinding.candidateRootSha256)) {
      await lease.release().catch(() => undefined);
      fail('transaction-refused', 'Candidate lease is not bound to the host writer owner/run/candidate root');
    }
  } catch (error) {
    wrap('transaction-refused', 'Candidate writer lease acquisition failed closed', error);
  }
  try {
    let fresh: LiveIdleObservation;
    try {
      fresh = validateObservation(input, await input.observeLive(), roots.liveRoot.resolved);
    } catch (error) {
      wrap('live-observation-invalid', 'Fresh live idle observation failed closed before candidate mutation', error);
    }
    await assertWriterCurrent(input);
    await assertLiveUnchanged(input, copies.live);
    if (fresh.statusDigest !== observation.statusDigest && fresh.observedAt === observation.observedAt) {
      fail('live-observation-invalid', 'Fresh live observation changed status without changing its observation timestamp');
    }
    const currentManifest = await captureSnapshot({ root: safeCandidateRoot });
    const currentFiles = await readSnapshotFiles(safeCandidateRoot, currentManifest);
    const desired: StagedFile[] = reduction.desiredState.map(file => ({
      path: file.path,
      bytes: file.content,
      scope: file.phase === 'serialized-global' ? 'global' : 'page',
    }));
    const current: SnapshotFile[] = reduction.desiredState.map(file => ({
      path: file.path,
      bytes: currentFiles.get(file.path) ?? null,
      scope: file.phase === 'serialized-global' ? 'global' : 'page',
    }));
    const plan = createTransactionPlan({
      fence: lease.record.fence,
      transactionId: `tx-${input.runId}`,
      current,
      desired,
    });
    // The transaction engine is the first candidate-vault writer.  Keep the
    // host authority check adjacent to the mutation, after all read/planning
    // work but before the journal or candidate files can be touched.
    await assertWriterCurrent(input);
    const fileSystem = new NodeTransactionFileSystem(safeCandidateRoot);
    const receipt = await new TransactionEngine({
      rootDir: safeCandidateRoot,
      fileSystem,
      journalPath,
      lease: {
        // Keep the coordinator's owner/run/fence authority check in the
        // transaction engine's lease callbacks.  The engine calls these
        // callbacks for every journal/file mutation and final CAS boundary;
        // checking only once before apply would leave a revocation window.
        assertFence: async (fence) => {
          await lease.assertFence(fence);
          await assertWriterCurrent(input);
        },
        withWriteFence: async <T>(operation: () => Promise<T>): Promise<T> => lease.withWriteFence(async () => {
          await assertWriterCurrent(input);
          return operation();
        }),
        withFinalCommit: async <T>(operation: () => Promise<T>): Promise<T> => lease.withFinalCommit(async () => {
          await assertWriterCurrent(input);
          return operation();
        }),
        onRollbackStart: async () => undefined,
        onRollbackComplete: async () => undefined,
        freeze: async (fence, reason) => { await lease.freeze(fence, reason); },
      },
      faults: input.transactionFaults,
    }).apply(plan);
    if (receipt.status !== 'committed' || receipt.restored) fail('transaction-refused', 'Candidate transaction did not commit cleanly');
    const candidate = await captureSnapshot({ root: safeCandidateRoot });
    return { plan, receipt, candidate, lease, observation: fresh };
  } catch (error) {
    await lease.release().catch(() => undefined);
    wrap('transaction-refused', 'Candidate transaction failed closed', error);
  }
}

async function finalizeAndVerify(
  input: NativeCanaryInput,
  roots: SafeCopyRoots,
  native: NativeReferenceResult,
  copies: NativeCanaryCopies,
  mapPolicy: NativeMapPolicy,
  mapIR: readonly NativeMapIR[],
  reduction: NativeReductionPlan,
  transactionPlan: TransactionPlan,
  transaction: TransactionReceipt,
  writerBinding: NativeCanaryWriterBinding,
  comparison: ReturnType<typeof compareNativeCandidate>,
  candidateProjection: ContractSemanticProjection,
  candidateSnapshot: CopySnapshotManifest,
  observation: LiveIdleObservation,
  terminalObservation: LiveIdleObservation,
): Promise<{ readonly finalization: FinalizationResult; readonly independentVerification: VerifiedNativeCanaryArtifacts; readonly artifactDirectory: string }> {
  const artifactBase = nodePath.join(roots.copyRoots[2].resolved, 'canary-runs');
  const artifactDirectory = nodePath.join(artifactBase, input.runId);
  const stateRoot = nodePath.join(roots.copyRoots[2].resolved, 'canary-state', input.runId);
  const journalPath = transaction.journalPath;
  let journalBytes: Uint8Array;
  try { journalBytes = new Uint8Array(await readFile(journalPath)); } catch (error) { wrap('finalization-refused', 'Candidate transaction journal is not readable for finalization', error); }
  const files = [
    { path: 'live-idle-observation.json', bytes: jsonText(observation) },
    { path: 'live-terminal-observation.json', bytes: jsonText(terminalObservation) },
    { path: 'copy-manifests.json', bytes: jsonText(copies) },
    { path: 'canary-binding.json', bytes: jsonText({
      version: 'native-canary-binding/v1',
      runId: input.runId,
      windowId: input.windowId,
      authority: input.authority,
      sourceInventorySha256: input.sourceInventory.inventorySha256,
      liveRoot: roots.liveRoot.resolved,
      nativeRoot: roots.copyRoots[0].resolved,
      candidateRoot: roots.copyRoots[1].resolved,
      artifactRoot: nodePath.join(roots.copyRoots[2].resolved, 'native-reference'),
      writer: writerBinding,
      ...(input.writerBinding ? { hostWriter: input.writerBinding } : {}),
      policySha256: mapPolicy.policySha256,
      provider: {
        provider: input.provider.provider,
        model: input.provider.model,
        authorizationRefSha256: sha256Hex(input.provider.authorizationRef),
      },
    }) },
    { path: 'native-receipt.json', bytes: jsonText(native.receipt) },
    { path: 'native-binding.json', bytes: jsonText(native.binding) },
    { path: 'native-projection.json', bytes: jsonText(native.projection) },
    { path: 'map-policy.json', bytes: jsonText(mapPolicy) },
    { path: 'map-ir.json', bytes: jsonText(mapIR) },
    { path: 'reduction-plan.json', bytes: jsonText(reduction) },
    { path: 'candidate-projection.json', bytes: jsonText(candidateProjection) },
    { path: 'candidate-snapshot.json', bytes: jsonText(candidateSnapshot) },
    { path: 'semantic-comparison.json', bytes: jsonText(comparison) },
    { path: 'transaction-plan.json', bytes: jsonText(transactionEvidencePlan(transactionPlan)) },
    { path: 'transaction-receipt.json', bytes: jsonText(transaction) },
    { path: 'transaction-journal.jsonl', bytes: journalBytes },
  ];
  // Finalization creates the durable artifact set and replay entry.  The
  // candidate lease remains the writer authority for this run, so check it
  // again immediately before preparing those writes.
  await assertWriterCurrent(input);
  let pending: ReturnType<typeof prepareFinalization>;
  try {
    pending = prepareFinalization({
      runId: input.runId,
      transactionId: transactionPlan.transactionId,
      planHash: transactionPlan.planHash,
      fence: transactionPlan.fence,
      artifactRoot: artifactDirectory,
      stateRoot,
      forbiddenRoots: [roots.liveRoot.resolved, roots.copyRoots[0].resolved, roots.copyRoots[1].resolved, ...(input.syncRoots ?? [])],
      files,
      replay: {
        nonce: `native-canary-${input.runId}`.slice(0, 128).padEnd(16, '0'),
        artifactPath: 'replay-ledger.jsonl',
        payload: { run_id: input.runId, transaction_id: transactionPlan.transactionId, plan_sha256: transactionPlan.planHash },
      },
      signer: input.signer,
      now: input.now,
    });
  } catch (error) {
    wrap('finalization-refused', 'Canary finalization preparation failed closed', error);
  }
  const ledgerPath = nodePath.join(artifactDirectory, pending.replay.artifactPath);
  const replayAppender: ReplayAppender = {
    ensureAppended: async intent => {
      const lockPath = nodePath.join(nodePath.dirname(ledgerPath), 'replay-ledger.lock');
      const ledger = new ReplayLedger(ledgerPath, {
        registry: input.trustedRegistry,
        requiredScope: 'spm-brain-replay-append',
        initialCheckpointHash: ZERO_CHECKPOINT,
        lockPath,
      });
      const existing = ledger.entries().find(entry => entry.runId === input.runId && entry.nonce === intent.nonce && entry.fence === transactionPlan.fence);
      let entry = existing;
      if (entry === undefined) {
        // Replay append is a durable write in its own right.  The check is
        // intentionally immediately adjacent to the synchronous append.
        await assertWriterCurrent(input);
        entry = ledger.append({
          runId: input.runId,
          nonce: intent.nonce,
          fence: transactionPlan.fence,
          timestamp: new Date(input.now?.() ?? Date.now()).toISOString(),
          payload: intent.payload,
        }, input.signer);
        await assertWriterCurrent(input);
      }
      const bytes = new Uint8Array(await readFile(ledgerPath));
      return { entryHash: entry.hash, ledgerRootHash: ledger.rootHash(), artifactPath: intent.artifactPath, artifactSha256: sha256Hex(bytes) };
    },
  };
  let finalization: FinalizationResult;
  try {
    // prepareFinalization materializes the signed pending envelope and the
    // finalizer then performs the durable artifact/terminal writes. Re-check
    // the launch authority at the handoff so a revocation cannot be hidden by
    // the earlier preparation check.
    await assertWriterCurrent(input);
    finalization = await finalizeRun({
      ...pending,
      files,
      transaction: { status: 'committed', transactionId: transactionPlan.transactionId, planHash: transactionPlan.planHash, fence: transactionPlan.fence },
      replayAppender,
      signer: input.signer,
      now: input.now,
    });
    await assertWriterCurrent(input);
  } catch (error) {
    wrap('finalization-refused', 'Durable canary finalization failed closed', error);
  }
  if (finalization.state !== 'terminal') fail('finalization-refused', `Canary finalization ended in ${finalization.state}`, [finalization.reason ?? 'no reason']);
  let independentVerification: VerifiedNativeCanaryArtifacts;
  try {
    independentVerification = await independentlyVerifyNativeCanaryArtifacts({
      directory: artifactDirectory,
      registry: input.trustedRegistry,
      expectedRunId: input.runId,
      expectedWindowId: input.windowId,
      expectedLiveRoot: roots.liveRoot.resolved,
      expectedNativeRoot: roots.copyRoots[0].resolved,
      expectedCandidateRoot: roots.copyRoots[1].resolved,
      expectedArtifactRoot: nodePath.join(roots.copyRoots[2].resolved, 'native-reference'),
      expectedAuthority: input.authority,
      sourceInventory: input.sourceInventory,
      expectedProvider: {
        provider: input.provider.provider,
        model: input.provider.model,
        authorizationRefSha256: sha256Hex(input.provider.authorizationRef),
      },
      verifyLiveRoot: true,
      liveRoot: roots.liveRoot.resolved,
      terminalScope: 'spm-brain-run-terminalize',
      replayScope: 'spm-brain-replay-append',
    });
  } catch (error) {
    wrap('verification-refused', 'Independent native/map/reduction/projection/transaction/live verification failed', error);
  }
  return { finalization, independentVerification, artifactDirectory };
}

/**
 * Run a native-vs-candidate canary entirely against disposable copies.  The
 * live vault is observed and snapshotted, but is never opened by a writer.
 * Every seam is a hard gate: unsupported native output, source/policy drift,
 * semantic mismatch, transaction failure, finalization failure, or verifier
 * failure returns a typed refusal and never grants live authority.
 */
export async function runNativeCanary(input: NativeCanaryInput): Promise<NativeCanaryResult> {
  validateInputShape(input);
  validateWriterBinding(input);
  await assertWriterCurrent(input);
  let initialObservation: LiveIdleObservation;
  try {
    initialObservation = validateObservation(input, await input.observeLive(), nodePath.resolve(input.liveRoot));
  } catch (error) {
    wrap('live-observation-invalid', 'Initial live idle observation failed closed', error);
  }
  let roots: SafeCopyRoots;
  try {
    roots = await assertSafeCopyRoots({
      liveRoot: input.liveRoot,
      copyRoots: [input.nativeRoot, input.candidateRoot, input.artifactRoot],
      syncRoots: input.syncRoots,
    });
  } catch (error) {
    wrap('unsafe-root', 'Live, copy, artifact, and sync roots failed containment checks', error);
  }
  if (!samePath(initialObservation.liveRoot, roots.liveRoot.resolved)) fail('live-observation-invalid', 'Initial observation root differs from the resolved live root');
  const { hashes, mapPolicy } = await validatePolicy(input);
  // Both disposable copy roots are created by the next operation.  Do not
  // begin that mutation on a stale launch authority.
  await assertWriterCurrent(input);
  const copies = await copyVaults(input, roots, initialObservation);
  await assertLiveUnchanged(input, copies.live);
  await assertWriterCurrent(input);
  const native = await runNative(input, roots, copies, hashes);
  await assertLiveUnchanged(input, copies.live);
  let candidateBefore: CopySnapshotManifest;
  try {
    candidateBefore = await captureSnapshot({ root: roots.copyRoots[1].resolved });
  } catch (error) {
    wrap('candidate-map-failed', 'Candidate copy could not be snapshotted before mapping', error);
  }
  if (!compareSnapshots(copies.candidate, candidateBefore).exact) fail('candidate-map-failed', 'Candidate copy drifted before source-isolated mapping');
  const sourceBytes = await readSources(roots.copyRoots[1].resolved, input.sourceInventory);
  const scheduler = input.scheduler ?? new AdaptiveConcurrencyController({ capacity: input.schedulerCapacity, initialReadySources: sourceBytes.length });
  const mapIR = await boundedMap(input, mapPolicy, sourceBytes, scheduler);
  let sourceIR: ReturnType<typeof nativeMapIRToSourceScopedIR>[];
  try {
    sourceIR = mapIR.map(ir => nativeMapIRToSourceScopedIR(ir));
  } catch (error) {
    wrap('candidate-reduction-refused', 'Native map output could not cross the typed reducer boundary', error);
  }
  const unsupported = sourceIR.flatMap(ir => ir.unsupported ?? []);
  if (unsupported.length > 0) fail('candidate-reduction-refused', 'Native map output contains unsupported semantics; candidate reduction refuses to drop them', unsupported);
  let candidateFiles: Map<string, string>;
  try {
    candidateFiles = await readSnapshotFiles(roots.copyRoots[1].resolved, candidateBefore);
  } catch (error) {
    wrap('candidate-reduction-refused', 'Candidate copy could not be read for reduction', error);
  }
  let schemaContent = input.global.schemaContent;
  if (schemaContent === undefined) {
    schemaContent = candidateFiles.get(input.global.schemaPath);
    if (schemaContent === undefined) {
      try {
        schemaContent = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(nodePath.join(roots.copyRoots[1].resolved, ...input.global.schemaPath.split('/'))));
        candidateFiles.set(input.global.schemaPath, schemaContent);
      } catch (error) {
        wrap('candidate-reduction-refused', 'The candidate copy does not contain the bound schema file', error);
      }
    }
  }
  if (!schemaContent?.trim()) fail('candidate-reduction-refused', 'A complete schema body is required for candidate reduction');
  let reduction: NativeReductionPlan;
  try {
    reduction = reduceNativeMapIR(mapIR, {
      wikiFolder: input.global.wikiFolder,
      global: {
        paths: { index: input.global.indexPath, log: input.global.logPath, schema: input.global.schemaPath },
        runId: input.runId,
        schemaContent,
        existing: candidateFiles,
      },
      slugCase: input.global.slugCase,
      date: input.global.date,
      // Bind page post-processing to the exact settings captured by the
      // native reference run, never to an unverified caller projection.
      nativeSettings: native.preflight.effectiveSettings as unknown as LLMWikiSettings,
      existingPageContents: input.existingPageContents,
      generatedPageContents: input.generatedPageContents,
      existingPages: existingPages(input.global.wikiFolder, candidateFiles),
      existingFiles: candidateFiles,
    });
  } catch (error) {
    wrap('candidate-reduction-refused', 'Candidate reducer failed closed', error);
  }
  if (!reduction.canApply || reduction.status !== 'candidate' || reduction.reasons.length > 0 || reduction.unsupported.length > 0) {
    fail('candidate-reduction-refused', 'Candidate reduction requires native comparison or contains unsupported structure', [...reduction.reasons, ...reduction.unsupported]);
  }
  const transactionResult = await performCandidateTransaction(input, roots, copies, reduction, initialObservation);
  const transactionFence = Number(transactionResult.plan.fence);
  if (!Number.isSafeInteger(transactionFence) || transactionFence < 1) {
    await transactionResult.lease.release().catch(() => undefined);
    fail('transaction-refused', 'Candidate transaction returned an invalid writer fence');
  }
  const transactionWriterBinding: NativeCanaryWriterBinding = {
    ownerId: transactionResult.lease.record.ownerId,
    runId: transactionResult.lease.record.runId,
    fence: transactionFence,
    candidateRootSha256: candidateRootSha256(roots.copyRoots[1].resolved),
  };
  let preFinalizationTerminalObservation: LiveIdleObservation;
  try {
    preFinalizationTerminalObservation = await validateTerminalLiveObservation(input, roots, copies, initialObservation);
  } catch (error) {
    await transactionResult.lease.release().catch(() => undefined);
    throw error;
  }
  let candidateProjection: ContractSemanticProjection;
  try {
    candidateProjection = await buildCandidateProjection(input, roots.copyRoots[1].resolved, transactionResult.candidate);
  } catch (error) {
    await transactionResult.lease.release().catch(() => undefined);
    throw error;
  }
  let comparison: ReturnType<typeof compareNativeCandidate>;
  try {
    comparison = compareNativeCandidate({
      native: native.projection,
      candidate: candidateProjection,
      requiredSourcePaths: input.sourceInventory.sources.map(source => source.path),
    });
  } catch (error) {
    await transactionResult.lease.release().catch(() => undefined);
    wrap('candidate-comparison-refused', 'Native/candidate semantic comparison failed closed', error);
  }
  if (!comparison.accepted) {
    await transactionResult.lease.release().catch(() => undefined);
    fail('candidate-comparison-refused', 'Native and candidate semantic projections are not equivalent', comparison.materialDeltas.map(delta => delta.issue));
  }
  let finalized: Awaited<ReturnType<typeof finalizeAndVerify>>;
  try {
    finalized = await finalizeAndVerify(input, roots, native, copies, mapPolicy, mapIR, reduction, transactionResult.plan, transactionResult.receipt, transactionWriterBinding, comparison, candidateProjection, transactionResult.candidate, transactionResult.observation, preFinalizationTerminalObservation);
  } catch (error) {
    await transactionResult.lease.release().catch(() => undefined);
    throw error;
  }
  let terminalObservation: LiveIdleObservation;
  try {
    terminalObservation = await validateTerminalLiveObservation(input, roots, copies, initialObservation);
  } catch (error) {
    await transactionResult.lease.release().catch(() => undefined);
    throw error;
  }
  await transactionResult.lease.release().catch(error => wrap('verification-refused', 'Unable to release the candidate writer lease after verification', error));
  return {
    version: NATIVE_CANARY_VERSION,
    runId: input.runId,
    observation: initialObservation,
    terminalObservation,
    copies,
    native,
    nativeMapPolicy: mapPolicy,
    mapIR,
    reduction,
    transactionPlan: transactionResult.plan,
    transaction: transactionResult.receipt,
    writerBinding: transactionWriterBinding,
    ...(input.writerBinding ? { hostWriterBinding: input.writerBinding } : {}),
    comparison,
    finalization: finalized.finalization,
    independentVerification: finalized.independentVerification,
    artifactDirectory: finalized.artifactDirectory,
  };
}

export const executeNativeCanary = runNativeCanary;
