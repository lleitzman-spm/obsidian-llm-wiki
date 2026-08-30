import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import {
  createContractSignature,
  createSigner,
  DOMAINS,
  digestHex,
  generateEd25519KeyPair,
  hashCanonical,
  verifyContractSignature,
  type ContractSignature,
  type KeyRegistry,
  type Signer,
} from '../crypto';
import { canonicalJsonSha256, sha256Hex } from '../preflight/hashing';
import { assertSafeCopyRoots, type SafeCopyRoots } from '../preflight/roots';
import { captureSnapshot, type CopySnapshotManifest } from '../copy-snapshot';
import { canonicalJson } from '../crypto/canonical-json';
import {
  NATIVE_REFERENCE_SIGNING_SCOPE,
  runNativeReference,
  type NativeReferenceInput,
  type NativeReferenceResult,
} from '../native-reference';
import type {
  IsolatedInjectedRunner,
  IsolatedJsonRecord,
  IsolatedProviderCallRequest,
  IsolatedRunnerInput,
  IsolatedRunnerRequest,
  IsolatedWorkerCapabilities,
} from '../isolation';
import { validateContract, type Receipt } from '../contracts';
import type { LLMClient } from '../../../../../src/types';
import { runNativeCanary } from './coordinator';
import { NATIVE_CANARY_ISOLATED_RUNNER_BRAND } from './types';
import type {
  NativeCanaryInput,
  NativeCanaryIsolatedRunner,
  NativeCanaryResult,
  LiveIdleObservation,
  NativeReferenceRunner,
  NativeCanaryWriterBinding,
} from './types';

/** The host is a shadow-copy boundary, never a live-vault execution mode. */
export const NATIVE_CANARY_HOST_VERSION = 'native-canary-host/v1' as const;
export const NATIVE_CANARY_HOST_ACTIVATION = 'copied-vault-shadow-canary/v1' as const;
export const COPIED_VAULT_MARKER_VERSION = 'spm-brain/copied-vault-marker/v1' as const;
export const COPIED_VAULT_MARKER_SIGNING_SCOPE = 'spm-brain-copy-marker-sign' as const;
export const NATIVE_CANARY_HOST_SIGNING_SCOPE = 'spm-brain-native-canary-host-sign' as const;
export const TRUSTED_LIVE_ROOT_SIGNING_SCOPE = 'spm-brain-trusted-live-root-sign' as const;
export const LIVE_OBSERVATION_SIGNING_SCOPE = 'spm-brain-live-observation-sign' as const;

const RUN_ID = /^[A-Za-z0-9._-]+$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export type CopiedVaultMarkerRole = 'native' | 'candidate';

/**
 * A marker is a sidecar next to a copied-vault directory.  It intentionally
 * binds the expected source snapshot, rather than the destination snapshot:
 * the coordinator creates the destination copies after this gate and must not
 * mutate a marker inside either copied vault.
 */
export interface CopiedVaultMarkerBody {
  readonly version: typeof COPIED_VAULT_MARKER_VERSION;
  readonly runId: string;
  readonly role: CopiedVaultMarkerRole;
  readonly copyRoot: string;
  readonly sourceSnapshotTreeSha256: string;
  readonly sourceInventorySha256: string;
  readonly authorityTree: string;
  readonly writerOwnerId: string;
  readonly writerFence: number;
}

export interface CopiedVaultMarker extends CopiedVaultMarkerBody {
  readonly signedDigest: string;
  readonly markerSha256: string;
  readonly signature: ContractSignature;
}

export interface TrustedLiveRootBindingBody {
  readonly version: 'trusted-live-root/v1';
  readonly runId: string;
  readonly windowId: string;
  readonly root: string;
  readonly rootIdentitySha256: string;
}

export interface TrustedLiveRootBinding extends TrustedLiveRootBindingBody {
  readonly signedDigest: string;
  readonly signature: ContractSignature;
}

export interface NativeCanaryWriterAuthority {
  readonly version: 'single-writer-authority/v1';
  readonly ownerId: string;
  readonly runId: string;
  readonly fence: number;
  readonly roots: {
    readonly native: string;
    readonly candidate: string;
  };
  /** The host must revalidate this authority on both sides of execution. */
  readonly assertCurrent: () => Promise<void>;
}

export interface NativeCanaryHostInput {
  /** Omitted by default: an inert host must not inspect roots or invoke a runner. */
  readonly activation?: typeof NATIVE_CANARY_HOST_ACTIVATION;
  readonly canary: NativeCanaryInput;
  /** Signed by an independently trusted launch/preflight authority. */
  readonly trustedLiveRoot: TrustedLiveRootBinding;
  /** Nominally branded child-process runner from the headless isolation factory. */
  readonly isolatedRunner: NativeCanaryIsolatedRunner;
  /** Exactly one writer authority covers both disposable copy roots. */
  readonly writerAuthority: NativeCanaryWriterAuthority;
}

export interface NativeCanaryHostReceiptInput {
  readonly version: typeof NATIVE_CANARY_HOST_VERSION;
  readonly phase: 'pre-execution';
  readonly runId: string;
  readonly authority: NativeCanaryInput['authority'];
  readonly sourceInventorySha256: string;
  readonly liveSnapshotTreeSha256: string;
  readonly liveRootIdentitySha256: string;
  readonly liveObservationSignedDigest: string;
  readonly roots: {
    readonly live: string;
    readonly native: string;
    readonly candidate: string;
    readonly artifact: string;
  };
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly authorizationRefSha256: string;
  };
  readonly writer: {
    readonly ownerId: string;
    readonly runId: string;
    readonly fence: number;
    readonly candidateRootSha256: string;
    readonly roots: {
      readonly native: string;
      readonly candidate: string;
    };
  };
  readonly markers: readonly [{
    readonly role: 'native';
    readonly path: string;
    readonly markerSha256: string;
    readonly signedDigest: string;
    readonly sourceSnapshotTreeSha256: string;
    readonly sourceInventorySha256: string;
  }, {
    readonly role: 'candidate';
    readonly path: string;
    readonly markerSha256: string;
    readonly signedDigest: string;
    readonly sourceSnapshotTreeSha256: string;
    readonly sourceInventorySha256: string;
  }];
  readonly inputSha256: string;
  readonly signedDigest: string;
  readonly signature: ContractSignature;
}

export interface NativeCanaryHostResult {
  readonly version: typeof NATIVE_CANARY_HOST_VERSION;
  readonly receiptInput: NativeCanaryHostReceiptInput;
  readonly receiptInputPath: string;
  readonly canary: NativeCanaryResult;
}

export type NativeCanaryHostRefusalCode =
  | 'inactive'
  | 'invalid-input'
  | 'unsafe-root'
  | 'marker-missing'
  | 'marker-invalid'
  | 'writer-authority-missing'
  | 'writer-authority-lost'
  | 'receipt-write-failed'
  | 'runner-refused';

export class NativeCanaryHostRefusal extends Error {
  readonly code: NativeCanaryHostRefusalCode;
  readonly details: readonly string[];

  constructor(code: NativeCanaryHostRefusalCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'NativeCanaryHostRefusal';
    this.code = code;
    this.details = [...details];
  }
}

function refuse(
  code: NativeCanaryHostRefusalCode,
  message: string,
  details: readonly string[] = [],
): never {
  throw new NativeCanaryHostRefusal(code, message, details);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceInventoryHash(inventory: NativeCanaryInput['sourceInventory']): string {
  const { inventorySha256: _ignored, ...body } = inventory;
  return canonicalJsonSha256(body);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneFrozenInventory(
  inventory: NativeCanaryInput['sourceInventory'],
): NativeCanaryInput['sourceInventory'] {
  return deepFreeze(JSON.parse(canonicalJson(inventory)) as NativeCanaryInput['sourceInventory']);
}

function samePath(left: string, right: string): boolean {
  const a = nodePath.normalize(nodePath.resolve(left));
  const b = nodePath.normalize(nodePath.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isIsolationFactoryRunner(value: unknown): value is IsolatedInjectedRunner {
  if (!value || typeof value !== 'object' || typeof (value as IsolatedInjectedRunner).run !== 'function') return false;
  const prototype = Object.getPrototypeOf(value) as { readonly constructor?: { readonly name?: string } } | null;
  // `createIsolatedInjectedRunner` deliberately exposes an interface rather
  // than its implementation class.  The constructor-name check is the
  // runtime half of this host-side nominal adapter; a plain `{ run() {} }`
  // test double cannot be promoted into an activated host input.
  return prototype?.constructor?.name === 'IsolatedInjectedRunnerImpl';
}

// Keep the nominal adapter non-forgeable by a caller that merely copies the
// public symbol/shape into a plain object.  A host input is accepted only when
// this module created the wrapper around the isolation factory product.
const nativeCanaryRunnerRegistry = new WeakSet<NativeCanaryIsolatedRunner>();

/**
 * Bind the concrete isolation-factory product to the native-canary host.
 * The bound wrapper owns only metadata and a receiver-safe `run` method; it
 * never exposes the factory's private options or capability handles.
 */
export function bindNativeCanaryIsolatedRunner(
  runner: IsolatedInjectedRunner,
): NativeCanaryIsolatedRunner {
  if (!isIsolationFactoryRunner(runner)) {
    throw new TypeError('Native canary host requires a runner created by createIsolatedInjectedRunner');
  }
  const bound = {
    copiedVaultRoot: runner.copiedVaultRoot,
    artifactRoot: runner.artifactRoot,
    workerId: runner.workerId,
    run: runner.run.bind(runner),
    [NATIVE_CANARY_ISOLATED_RUNNER_BRAND]: 'native-canary-isolated-runner/v1' as const,
  } satisfies NativeCanaryIsolatedRunner;
  const frozen = Object.freeze(bound);
  nativeCanaryRunnerRegistry.add(frozen);
  return frozen;
}

function nativeArtifactRoot(root: string): string {
  return nodePath.join(nodePath.resolve(root), 'native-reference');
}

function candidateRootSha256(root: string): string {
  return sha256Hex(nodePath.resolve(root));
}

function hostWriterBinding(input: NativeCanaryHostInput): NativeCanaryWriterBinding {
  return {
    ownerId: input.writerAuthority.ownerId,
    runId: input.writerAuthority.runId,
    fence: input.writerAuthority.fence,
    candidateRootSha256: candidateRootSha256(input.canary.candidateRoot),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    refuse('invalid-input', `${label} must be a non-empty NUL-free string`);
  }
  return value.trim();
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    refuse('invalid-input', `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) refuse('invalid-input', 'runId contains unsafe path characters');
}

function markerBody(marker: CopiedVaultMarker): CopiedVaultMarkerBody {
  return {
    version: marker.version,
    runId: marker.runId,
    role: marker.role,
    copyRoot: marker.copyRoot,
    sourceSnapshotTreeSha256: marker.sourceSnapshotTreeSha256,
    sourceInventorySha256: marker.sourceInventorySha256,
    authorityTree: marker.authorityTree,
    writerOwnerId: marker.writerOwnerId,
    writerFence: marker.writerFence,
  };
}

function markerSidecar(root: string): string {
  return `${nodePath.resolve(root)}.spm-copy-marker.json`;
}

function assertSigner(signer: Signer): void {
  if (!signer || !Array.isArray(signer.scopes) || !signer.scopes.includes(NATIVE_CANARY_HOST_SIGNING_SCOPE)) {
    refuse('invalid-input', `Signer lacks ${NATIVE_CANARY_HOST_SIGNING_SCOPE}`);
  }
  if (!signer.scopes.includes(NATIVE_REFERENCE_SIGNING_SCOPE)) {
    refuse('invalid-input', `Signer lacks ${NATIVE_REFERENCE_SIGNING_SCOPE}`);
  }
}

function trustedLiveRootBody(binding: TrustedLiveRootBinding): TrustedLiveRootBindingBody {
  return {
    version: binding.version,
    runId: binding.runId,
    windowId: binding.windowId,
    root: binding.root,
    rootIdentitySha256: binding.rootIdentitySha256,
  };
}

function observationBody(observation: LiveIdleObservation): Record<string, unknown> {
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

function validateTrustedLiveRoot(input: NativeCanaryHostInput, resolvedLiveRoot: string): string {
  const binding = input.trustedLiveRoot;
  if (!binding || binding.version !== 'trusted-live-root/v1'
    || binding.runId !== input.canary.runId
    || binding.windowId !== input.canary.windowId
    || typeof binding.root !== 'string'
    || !samePath(binding.root, resolvedLiveRoot)
    || !DIGEST.test(binding.rootIdentitySha256)
    || !binding.signature
    || binding.signature.key_id === input.canary.signer.keyId
    || binding.signature.signed_digest !== binding.signedDigest) {
    refuse('invalid-input', 'Signed trusted live-root binding is missing or does not match the resolved root');
  }
  if (binding.rootIdentitySha256 !== sha256Hex(nodePath.resolve(binding.root))) {
    refuse('invalid-input', 'Trusted live-root identity digest does not bind the resolved root');
  }
  const expectedDigest = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, trustedLiveRootBody(binding)));
  if (binding.signedDigest !== expectedDigest) {
    refuse('invalid-input', 'Trusted live-root signature digest does not bind its body');
  }
  try {
    verifyContractSignature(
      DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE,
      binding.signature,
      input.canary.trustedRegistry,
      { runId: input.canary.runId, requiredScope: TRUSTED_LIVE_ROOT_SIGNING_SCOPE },
    );
  } catch (error) {
    refuse('invalid-input', 'Trusted live-root signature is not authorized', [describe(error)]);
  }
  return binding.rootIdentitySha256;
}

function validateLiveObservation(
  input: NativeCanaryHostInput,
  observation: LiveIdleObservation,
  resolvedLiveRoot: string,
): LiveIdleObservation {
  if (!observation || observation.version !== 'spm-brain/live-idle-observation/v1'
    || observation.runId !== input.canary.runId
    || observation.windowId !== input.canary.windowId
    || !samePath(observation.liveRoot, resolvedLiveRoot)
    || observation.idle !== true
    || observation.mutationSurface !== 'read-only'
    || !DIGEST.test(observation.statusDigest)
    || !DIGEST.test(observation.signedDigest)
    || !observation.signature
    || observation.signature.signed_digest !== observation.signedDigest) {
    refuse('invalid-input', 'Live observation is not a bound idle read-only observation');
  }
  const expectedDigest = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, observationBody(observation)));
  if (observation.signedDigest !== expectedDigest) {
    refuse('invalid-input', 'Live observation signature digest does not bind its body');
  }
  try {
    verifyContractSignature(
      DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE,
      observation.signature,
      input.canary.trustedRegistry,
      { runId: input.canary.runId, requiredScope: LIVE_OBSERVATION_SIGNING_SCOPE },
    );
  } catch (error) {
    refuse('invalid-input', 'Live observation signature is not authorized for the observation scope', [describe(error)]);
  }
  const observedAt = Date.parse(observation.observedAt);
  const now = input.canary.now?.() ?? Date.now();
  if (!Number.isFinite(observedAt) || now - observedAt > 60_000 || observedAt > now + 5_000) {
    refuse('invalid-input', 'Live observation is stale or future-dated');
  }
  return observation;
}

function assertWriterAuthority(input: NativeCanaryHostInput): void {
  const authority = input.writerAuthority;
  if (!authority) refuse('writer-authority-missing', 'Exactly one writer authority is required');
  if (authority.version !== 'single-writer-authority/v1'
    || typeof authority.ownerId !== 'string'
    || !authority.ownerId.trim()
    || authority.runId !== input.canary.runId
    || !Number.isSafeInteger(authority.fence)
    || authority.fence < 1
    || typeof authority.assertCurrent !== 'function'
    || !authority.roots
    || typeof authority.roots.native !== 'string'
    || typeof authority.roots.candidate !== 'string') {
    refuse('writer-authority-missing', 'Writer authority is malformed or not bound to this run');
  }
  if (!samePath(authority.roots.native, input.canary.nativeRoot)
    || !samePath(authority.roots.candidate, input.canary.candidateRoot)
    || samePath(authority.roots.native, authority.roots.candidate)
    || samePath(authority.roots.native, input.canary.liveRoot)
    || samePath(authority.roots.candidate, input.canary.liveRoot)) {
    refuse('writer-authority-missing', 'Writer authority roots are not exactly the two disposable copy roots');
  }
}

function assertIsolatedRunner(input: NativeCanaryHostInput, roots: SafeCopyRoots): void {
  const runner = input.isolatedRunner;
  if (!runner || typeof runner.run !== 'function'
    || runner[NATIVE_CANARY_ISOLATED_RUNNER_BRAND] !== 'native-canary-isolated-runner/v1'
    || !nativeCanaryRunnerRegistry.has(runner)
    || typeof runner.copiedVaultRoot !== 'string'
    || typeof runner.artifactRoot !== 'string'
    || typeof runner.workerId !== 'string'
    || !runner.workerId.trim()) {
    refuse('invalid-input', 'An actual isolated subprocess runner is required');
  }
  if (!samePath(runner.copiedVaultRoot, roots.copyRoots[0].resolved)
    || !samePath(runner.artifactRoot, nativeArtifactRoot(roots.copyRoots[2].resolved))) {
    refuse('invalid-input', 'Isolated runner roots are not bound to the native copy and nested native artifact root');
  }
}

async function assertAuthorityCurrent(input: NativeCanaryHostInput): Promise<void> {
  try {
    await input.writerAuthority.assertCurrent();
  } catch (error) {
    refuse('writer-authority-lost', 'Single-writer authority is not current', [describe(error)]);
  }
}

async function resolveRoots(input: NativeCanaryHostInput): Promise<SafeCopyRoots> {
  try {
    return await assertSafeCopyRoots({
      liveRoot: input.canary.liveRoot,
      copyRoots: [input.canary.nativeRoot, input.canary.candidateRoot, input.canary.artifactRoot],
      syncRoots: input.canary.syncRoots,
    });
  } catch (error) {
    refuse('unsafe-root', 'Live, copied-vault, artifact, or sync roots failed containment checks', [describe(error)]);
  }
}

async function readMarker(
  input: NativeCanaryHostInput,
  roots: SafeCopyRoots,
  role: CopiedVaultMarkerRole,
  liveSnapshot: CopySnapshotManifest,
): Promise<{ readonly marker: CopiedVaultMarker; readonly path: string }> {
  const copyRoot = role === 'native' ? roots.copyRoots[0].resolved : roots.copyRoots[1].resolved;
  const path = markerSidecar(copyRoot);
  let parsed: unknown;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      refuse('marker-invalid', `Copied-vault ${role} marker is not a plain file`, [path]);
    }
    if (!samePath(await realpath(path), path)) {
      refuse('marker-invalid', `Copied-vault ${role} marker resolves through a reparse point`, [path]);
    }
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof NativeCanaryHostRefusal) throw error;
    refuse('marker-missing', `Copied-vault ${role} marker is not readable`, [path, describe(error)]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse('marker-invalid', `Copied-vault ${role} marker is not a JSON object`);
  }
  const marker = parsed as CopiedVaultMarker;
  if (typeof marker.copyRoot !== 'string'
    || typeof marker.sourceSnapshotTreeSha256 !== 'string'
    || typeof marker.sourceInventorySha256 !== 'string'
    || typeof marker.authorityTree !== 'string'
    || typeof marker.writerOwnerId !== 'string'
    || !marker.signature || typeof marker.signature !== 'object') {
    refuse('marker-invalid', `Copied-vault ${role} marker is missing typed binding fields`, [path]);
  }
  if (marker.version !== COPIED_VAULT_MARKER_VERSION
    || marker.runId !== input.canary.runId
    || marker.role !== role
    || !samePath(marker.copyRoot, copyRoot)
    || marker.sourceSnapshotTreeSha256 !== liveSnapshot.treeSha256
    || marker.sourceInventorySha256 !== input.canary.sourceInventory.inventorySha256
    || marker.authorityTree !== input.canary.authority.tree
    || marker.writerOwnerId !== input.writerAuthority.ownerId
    || marker.writerFence !== input.writerAuthority.fence) {
    refuse('marker-invalid', `Copied-vault ${role} marker is not bound to this run, source snapshot, or writer authority`, [path]);
  }
  requireDigest(marker.sourceSnapshotTreeSha256, `${role} marker source snapshot hash`);
  requireDigest(marker.sourceInventorySha256, `${role} marker source inventory hash`);
  requireDigest(marker.authorityTree, `${role} marker authority tree`);
  requireDigest(marker.markerSha256, `${role} marker hash`);
  requireDigest(marker.signedDigest, `${role} marker signed digest`);
  if (marker.markerSha256 !== canonicalJsonSha256(markerBody(marker))) {
    refuse('marker-invalid', `Copied-vault ${role} marker hash does not bind its body`, [path]);
  }
  const expectedSignedDigest = digestHex(hashCanonical(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, markerBody(marker)));
  if (marker.signedDigest !== expectedSignedDigest
    || !marker.signature
    || marker.signature.signed_digest !== marker.signedDigest) {
    refuse('marker-invalid', `Copied-vault ${role} marker signature digest is invalid`, [path]);
  }
  try {
    verifyContractSignature(
      DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE,
      marker.signature,
      input.canary.trustedRegistry,
      { runId: input.canary.runId, fence: input.writerAuthority.fence, requiredScope: COPIED_VAULT_MARKER_SIGNING_SCOPE },
    );
  } catch (error) {
    refuse('marker-invalid', `Copied-vault ${role} marker signature is not trusted`, [path, describe(error)]);
  }
  return { marker, path };
}

/**
 * Validate the shadow-copy boundary and create the signed, hash-bound input
 * receipt.  This function never invokes a runner and never writes an artifact.
 */
export async function prepareNativeCanaryHost(
  input: NativeCanaryHostInput,
): Promise<NativeCanaryHostReceiptInput> {
  if (input?.activation !== NATIVE_CANARY_HOST_ACTIVATION) {
    refuse('inactive', 'Native canary host preparation is activation-gated');
  }
  if (!input || !input.canary || !input.writerAuthority) {
    refuse('invalid-input', 'Canary input and exactly one writer authority are required');
  }
  if (!input.canary.provider || !input.canary.sourceInventory || !input.canary.authority) {
    refuse('invalid-input', 'Canary provider, source inventory, and authority are required');
  }
  assertRunId(requireString(input.canary.runId, 'runId'));
  if (sourceInventoryHash(input.canary.sourceInventory) !== input.canary.sourceInventory.inventorySha256) {
    refuse('invalid-input', 'Source inventory hash is not self-consistent before host execution');
  }
  requireString(input.canary.provider.provider, 'provider');
  requireString(input.canary.provider.model, 'model');
  requireString(input.canary.provider.authorizationRef, 'authorizationRef');
  if (typeof input.canary.provider.createClient !== 'function'
    || typeof input.canary.provider.mapClient?.createMessage !== 'function'
    || typeof input.isolatedRunner?.run !== 'function') {
    refuse('invalid-input', 'An injected provider/map client and actual isolated subprocess runner are required');
  }
  assertSigner(input.canary.signer);
  assertWriterAuthority(input);
  try {
    input.canary.trustedRegistry.require(input.canary.signer.keyId, {
      runId: input.canary.runId,
      fence: input.writerAuthority.fence,
      requiredScope: NATIVE_CANARY_HOST_SIGNING_SCOPE,
    });
  } catch (error) {
    refuse('invalid-input', 'Host signer is not present in the trusted registry with the required scope', [describe(error)]);
  }
  const roots = await resolveRoots(input);
  assertIsolatedRunner(input, roots);
  const liveRootIdentitySha256 = validateTrustedLiveRoot(input, roots.liveRoot.resolved);
  const liveSnapshot = await captureSnapshot({ root: roots.liveRoot.resolved, exclusions: ['run', 'lease'] });
  let observation: LiveIdleObservation;
  try {
    observation = validateLiveObservation(input, await input.canary.observeLive(), roots.liveRoot.resolved);
  } catch (error) {
    if (error instanceof NativeCanaryHostRefusal) throw error;
    refuse('invalid-input', 'Bound live observation could not be captured', [describe(error)]);
  }
  const nativeMarker = await readMarker(input, roots, 'native', liveSnapshot);
  const candidateMarker = await readMarker(input, roots, 'candidate', liveSnapshot);
  await assertAuthorityCurrent(input);

  const unsigned = {
    version: NATIVE_CANARY_HOST_VERSION,
    phase: 'pre-execution' as const,
    runId: input.canary.runId,
    authority: input.canary.authority,
    sourceInventorySha256: input.canary.sourceInventory.inventorySha256,
    liveSnapshotTreeSha256: liveSnapshot.treeSha256,
    liveRootIdentitySha256,
    liveObservationSignedDigest: observation.signedDigest,
    roots: {
      live: roots.liveRoot.resolved,
      native: roots.copyRoots[0].resolved,
      candidate: roots.copyRoots[1].resolved,
      artifact: roots.copyRoots[2].resolved,
    },
    provider: {
      provider: input.canary.provider.provider,
      model: input.canary.provider.model,
      authorizationRefSha256: sha256Hex(input.canary.provider.authorizationRef),
    },
    writer: {
      ownerId: input.writerAuthority.ownerId,
      runId: input.writerAuthority.runId,
      fence: input.writerAuthority.fence,
      candidateRootSha256: candidateRootSha256(roots.copyRoots[1].resolved),
      roots: {
        native: roots.copyRoots[0].resolved,
        candidate: roots.copyRoots[1].resolved,
      },
    },
    markers: [
      {
        role: 'native' as const,
        path: nativeMarker.path,
        markerSha256: nativeMarker.marker.markerSha256,
        signedDigest: nativeMarker.marker.signedDigest,
        sourceSnapshotTreeSha256: nativeMarker.marker.sourceSnapshotTreeSha256,
        sourceInventorySha256: nativeMarker.marker.sourceInventorySha256,
      },
      {
        role: 'candidate' as const,
        path: candidateMarker.path,
        markerSha256: candidateMarker.marker.markerSha256,
        signedDigest: candidateMarker.marker.signedDigest,
        sourceSnapshotTreeSha256: candidateMarker.marker.sourceSnapshotTreeSha256,
        sourceInventorySha256: candidateMarker.marker.sourceInventorySha256,
      },
    ] as const,
  } satisfies Omit<NativeCanaryHostReceiptInput, 'inputSha256' | 'signedDigest' | 'signature'>;
  const body = unsigned;
  const inputSha256 = canonicalJsonSha256(body);
  const signedDigest = digestHex(hashCanonical(DOMAINS.NATIVE_RECEIPT_SIGNATURE, body));
  return {
    ...body,
    inputSha256,
    signedDigest,
    signature: createContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, signedDigest, input.canary.signer),
  };
}

/** Verify a host receipt input without opening either vault or invoking a runner. */
export function verifyNativeCanaryHostReceiptInput(
  receipt: NativeCanaryHostReceiptInput,
  registry: KeyRegistry,
): void {
  if (!receipt || receipt.version !== NATIVE_CANARY_HOST_VERSION || receipt.phase !== 'pre-execution') {
    throw new Error('Native canary host receipt input has an unsupported version or phase');
  }
  if (typeof receipt.runId !== 'string' || !RUN_ID.test(receipt.runId)) {
    throw new Error('Native canary host receipt input run ID is invalid');
  }
  const roots = receipt.roots;
  const rootValues = [roots?.live, roots?.native, roots?.candidate, roots?.artifact];
  if (rootValues.some(value => typeof value !== 'string' || !nodePath.isAbsolute(value) || value.includes('\0'))) {
    throw new Error('Native canary host receipt input roots must be absolute NUL-free paths');
  }
  const overlaps = (left: string, right: string): boolean => {
    const a = nodePath.normalize(left);
    const b = nodePath.normalize(right);
    const relative = nodePath.relative(a, b);
    const reverse = nodePath.relative(b, a);
    return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative))
      || reverse === '' || (!reverse.startsWith('..') && !nodePath.isAbsolute(reverse));
  };
  if (overlaps(roots.live, roots.native) || overlaps(roots.live, roots.candidate)
    || overlaps(roots.live, roots.artifact) || overlaps(roots.native, roots.candidate)
    || overlaps(roots.native, roots.artifact) || overlaps(roots.candidate, roots.artifact)) {
    throw new Error('Native canary host receipt input roots overlap');
  }
  if (!receipt.writer || receipt.writer.runId !== receipt.runId
    || typeof receipt.writer.ownerId !== 'string' || !receipt.writer.ownerId.trim()
    || !Number.isSafeInteger(receipt.writer.fence) || receipt.writer.fence < 1
    || !DIGEST.test(receipt.writer.candidateRootSha256)
    || !receipt.writer.roots
    || typeof receipt.writer.roots.native !== 'string'
    || typeof receipt.writer.roots.candidate !== 'string'
    || !samePath(receipt.writer.roots.native, roots.native)
    || !samePath(receipt.writer.roots.candidate, roots.candidate)) {
    throw new Error('Native canary host receipt input writer binding is invalid');
  }
  if (receipt.writer.candidateRootSha256 !== sha256Hex(nodePath.resolve(roots.candidate))) {
    throw new Error('Native canary host receipt input candidate-root writer binding is invalid');
  }
  if (!receipt.provider || typeof receipt.provider.provider !== 'string' || !receipt.provider.provider.trim()
    || typeof receipt.provider.model !== 'string' || !receipt.provider.model.trim()
    || !DIGEST.test(receipt.provider.authorizationRefSha256)) {
    throw new Error('Native canary host receipt input provider binding is invalid');
  }
  if (!receipt.authority
    || typeof receipt.authority.repositoryUrl !== 'string' || !receipt.authority.repositoryUrl.trim()
    || typeof receipt.authority.commit !== 'string' || !receipt.authority.commit.trim()
    || !DIGEST.test(receipt.authority.tree)) {
    throw new Error('Native canary host receipt input authority binding is invalid');
  }
  if (!Array.isArray(receipt.markers) || receipt.markers.length !== 2
    || receipt.markers[0]?.role !== 'native' || receipt.markers[1]?.role !== 'candidate') {
    throw new Error('Native canary host receipt input must contain exactly native and candidate markers');
  }
  for (const marker of receipt.markers) {
    if (typeof marker.path !== 'string'
      || !samePath(marker.path, markerSidecar(marker.role === 'native' ? roots.native : roots.candidate))
      || !DIGEST.test(marker.markerSha256)
      || !DIGEST.test(marker.signedDigest)
      || !DIGEST.test(marker.sourceInventorySha256)
      || marker.sourceSnapshotTreeSha256 !== receipt.liveSnapshotTreeSha256
      || marker.sourceInventorySha256 !== receipt.sourceInventorySha256) {
      throw new Error('Native canary host receipt input marker binding is invalid');
    }
  }
  if (!DIGEST.test(receipt.sourceInventorySha256) || !DIGEST.test(receipt.liveSnapshotTreeSha256)
    || !DIGEST.test(receipt.liveRootIdentitySha256)
    || receipt.liveRootIdentitySha256 !== sha256Hex(nodePath.resolve(roots.live))
    || !DIGEST.test(receipt.liveObservationSignedDigest)) {
    throw new Error('Native canary host receipt input source binding is invalid');
  }
  const { inputSha256, signedDigest, signature, ...body } = receipt;
  if (!DIGEST.test(inputSha256) || !DIGEST.test(signedDigest) || !signature) {
    throw new Error('Native canary host receipt input digests/signature are invalid');
  }
  if (inputSha256 !== canonicalJsonSha256(body)) {
    throw new Error('Native canary host receipt input hash does not bind its body');
  }
  const expectedSignedDigest = digestHex(hashCanonical(DOMAINS.NATIVE_RECEIPT_SIGNATURE, body));
  if (signedDigest !== expectedSignedDigest || signature.signed_digest !== signedDigest) {
    throw new Error('Native canary host receipt input signature digest does not bind its body');
  }
  verifyContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, signature, registry, {
    runId: receipt.runId,
    fence: receipt.writer.fence,
    requiredScope: NATIVE_CANARY_HOST_SIGNING_SCOPE,
  });
}

async function persistReceiptInput(
  input: NativeCanaryHostInput,
  receiptInput: NativeCanaryHostReceiptInput,
  roots: SafeCopyRoots,
): Promise<string> {
  // The receipt is the first host-side mutation.  Revalidate the single
  // writer immediately before opening its artifact directory.
  await assertAuthorityCurrent(input);
  const directory = nodePath.join(roots.copyRoots[2].resolved, 'native-canary-host', input.canary.runId);
  const path = nodePath.join(directory, 'receipt-input.json');
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    refuse('receipt-write-failed', 'Signed host receipt input directory could not be prepared', [directory, describe(error)]);
  }
  // mkdir may have materialized the run directory, so re-check before the
  // separate receipt-file mutation as well.
  await assertAuthorityCurrent(input);
  try {
    await writeFile(path, `${canonicalJson(receiptInput)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    refuse('receipt-write-failed', 'Signed host receipt input could not be persisted without overwrite', [path, describe(error)]);
  }
  return path;
}

async function revalidatePostimage(
  input: NativeCanaryHostInput,
  receiptInput: NativeCanaryHostReceiptInput,
  receiptPath: string,
  roots: SafeCopyRoots,
): Promise<void> {
  const currentRoots = await resolveRoots(input);
  const expected = [
    roots.liveRoot.resolved,
    roots.copyRoots[0].resolved,
    roots.copyRoots[1].resolved,
    roots.copyRoots[2].resolved,
  ];
  const actual = [
    currentRoots.liveRoot.resolved,
    currentRoots.copyRoots[0].resolved,
    currentRoots.copyRoots[1].resolved,
    currentRoots.copyRoots[2].resolved,
  ];
  if (expected.some((value, index) => !samePath(value, actual[index] ?? ''))) {
    refuse('unsafe-root', 'A protected root changed while persisting the host receipt input');
  }
  const live = await captureSnapshot({ root: currentRoots.liveRoot.resolved, exclusions: ['run', 'lease'] });
  if (live.treeSha256 !== receiptInput.liveSnapshotTreeSha256) {
    refuse('unsafe-root', 'The trusted live snapshot changed while persisting the host receipt input');
  }
  try {
    const stat = await lstat(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(receiptPath), receiptPath)) {
      refuse('receipt-write-failed', 'Receipt input postimage is not a plain file at the contained artifact path');
    }
    const actualBytes = await readFile(receiptPath, 'utf8');
    const expectedBytes = `${canonicalJson(receiptInput)}\n`;
    if (actualBytes !== expectedBytes) {
      refuse('receipt-write-failed', 'Receipt input postimage does not match its signed bytes');
    }
  } catch (error) {
    if (error instanceof NativeCanaryHostRefusal) throw error;
    refuse('receipt-write-failed', 'Receipt input postimage could not be revalidated', [describe(error)]);
  }
  try {
    verifyNativeCanaryHostReceiptInput(receiptInput, input.canary.trustedRegistry);
  } catch (error) {
    refuse('receipt-write-failed', 'Persisted receipt input failed independent semantic verification', [describe(error)]);
  }
}

async function revalidatePostRun(
  input: NativeCanaryHostInput,
  receiptInput: NativeCanaryHostReceiptInput,
  receiptPath: string,
  roots: SafeCopyRoots,
): Promise<void> {
  await revalidatePostimage(input, receiptInput, receiptPath, roots);
  let terminalObservation: LiveIdleObservation;
  try {
    terminalObservation = validateLiveObservation(
      input,
      await input.canary.observeLive(),
      roots.liveRoot.resolved,
    );
  } catch (error) {
    if (error instanceof NativeCanaryHostRefusal) throw error;
    refuse('receipt-write-failed', 'Post-run live observation could not be revalidated', [describe(error)]);
  }
  if (terminalObservation.signedDigest !== receiptInput.liveObservationSignedDigest) {
    refuse('receipt-write-failed', 'Post-run live observation signature differs from the trusted pre-execution observation');
  }
  const liveSnapshot = await captureSnapshot({ root: roots.liveRoot.resolved, exclusions: ['run', 'lease'] });
  const nativeMarker = await readMarker(input, roots, 'native', liveSnapshot);
  const candidateMarker = await readMarker(input, roots, 'candidate', liveSnapshot);
  const expectedMarkers = [nativeMarker.marker, candidateMarker.marker];
  receiptInput.markers.forEach((receiptMarker, index) => {
    const actual = expectedMarkers[index];
    if (!actual || receiptMarker.markerSha256 !== actual.markerSha256
      || receiptMarker.signedDigest !== actual.signedDigest
      || receiptMarker.sourceSnapshotTreeSha256 !== actual.sourceSnapshotTreeSha256
      || receiptMarker.sourceInventorySha256 !== actual.sourceInventorySha256) {
      refuse('receipt-write-failed', 'A copied-vault marker changed after canary execution');
    }
  });
}

const CHILD_CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|authori[sz]ation|authentication|credential|password|secret|private[_-]?key|cookie)/iu;

function redactChildCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(child => redactChildCredentialFields(child));
  if (!record(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (CHILD_CREDENTIAL_KEY.test(key) && !/authorization.*sha256/iu.test(key)) continue;
    output[key] = redactChildCredentialFields(child);
  }
  return output;
}

function childCredentialField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = childCredentialField(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!record(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (CHILD_CREDENTIAL_KEY.test(key) && !/authorization.*sha256/iu.test(key)) return key;
    const found = childCredentialField(child);
    if (found) return found;
  }
  return undefined;
}

function cloneIsolatedJson(value: unknown): IsolatedJsonRecord {
  return JSON.parse(canonicalJson(value)) as IsolatedJsonRecord;
}

function isolatedSyntheticLiveRoot(request: IsolatedRunnerRequest): string {
  // The child must satisfy native-reference's disjoint-root preflight without
  // learning the host live root. This path is intentionally never created or
  // opened; the host rebinds the returned native proof to its signed root.
  return nodePath.join(
    nodePath.dirname(nodePath.resolve(request.copied_vault_root)),
    `.native-canary-isolated-live-${request.run_id}`,
  );
}

function isolatedProviderClient(capabilities: IsolatedWorkerCapabilities): LLMClient {
  return {
    createMessage: async params => {
      const request: Omit<IsolatedProviderCallRequest, 'type' | 'protocol_version' | 'request_id' | 'run_id' | 'worker_id' | 'provider' | 'model'> = {
        max_tokens: params.max_tokens,
        ...(params.system === undefined ? {} : { system: params.system }),
        messages: params.messages as IsolatedProviderCallRequest['messages'],
        ...(params.response_format === undefined ? {} : { response_format: params.response_format as never }),
        ...(params.task === undefined ? {} : { task: params.task }),
        ...(params.maxTokensPerCall === undefined ? {} : { max_tokens_per_call: params.maxTokensPerCall }),
        ...(params.enableThinking === undefined ? {} : { enable_thinking: params.enableThinking }),
        ...(params.reasoningEffort === undefined ? {} : { reasoning_effort: params.reasoningEffort }),
        ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
        ...(params.top_p === undefined ? {} : { top_p: params.top_p }),
        ...(params.seed === undefined ? {} : { seed: params.seed }),
      };
      const response = await capabilities.provider.call(request);
      if (response.status !== 'succeeded') throw new Error(response.error_code ?? 'isolated-provider-refused');
      if (response.text !== undefined) return response.text;
      return response.output === undefined ? '' : JSON.stringify(response.output);
    },
  };
}

/**
 * Child-side native adapter used by the real isolation worker entrypoint.
 * Its request contains only the copied root, nested artifact root, provider
 * identity hash, settings hashes, source inventory, and writer hash binding.
 * It uses an ephemeral child signer and capability-backed client; neither the
 * host live root nor host credential/signer/client objects enter this process.
 */
export async function runNativeReferenceIsolatedWorker(
  request: IsolatedRunnerRequest,
  capabilities: IsolatedWorkerCapabilities,
): Promise<IsolatedJsonRecord> {
  const childSigner = createSigner(generateEd25519KeyPair().privateKey, {
    scopes: [NATIVE_REFERENCE_SIGNING_SCOPE],
  });
  const native = await runNativeReference({
    runId: request.run_id,
    mode: request.mode,
    liveRoot: isolatedSyntheticLiveRoot(request),
    copiedVaultRoot: request.copied_vault_root,
    artifactRoot: request.artifact_root,
    sourceInventory: request.source_inventory,
    settings: {
      fullSha256: request.settings.full_sha256,
      safeProjectionSha256: request.settings.safe_projection_sha256,
    },
    provider: {
      provider: request.provider.provider,
      model: request.provider.model,
      // Only a hash is available in the child. The host rebinds the result
      // to its opaque grant hash after validating the worker response.
      authorizationRef: `isolated-capability:${request.provider.authorization_ref_sha256}`,
      createClient: async () => isolatedProviderClient(capabilities),
    },
    signer: childSigner,
    sourcePaths: request.source_paths,
    forceReingest: true,
  });
  const wire = { ...cloneIsolatedJson(redactChildCredentialFields(native)) } as Record<string, unknown>;
  const binding = record(wire.binding) ? { ...wire.binding } : undefined;
  const preflight = record(wire.preflight) ? { ...wire.preflight } : undefined;
  const roots = preflight && record(preflight.roots) ? { ...preflight.roots } : undefined;
  const receipt = record(wire.receipt) ? { ...wire.receipt } : undefined;
  if (!binding || !preflight || !roots || !receipt) {
    throw new Error('Native isolated worker produced an incomplete result');
  }
  // These values are host authority, not child authority. They are removed
  // from the wire and restored only by nativeResultFromSubprocess after the
  // host has checked the signed roots and re-signed the receipt.
  delete binding.liveRoot;
  delete binding.receiptSha256;
  delete roots.liveRoot;
  delete receipt.signature;
  if (record(binding.provider)) {
    binding.provider = {
      ...binding.provider,
      authorizationRefSha256: request.provider.authorization_ref_sha256,
    };
  }
  wire.binding = binding;
  wire.preflight = { ...preflight, roots };
  wire.receipt = receipt;
  return wire as IsolatedJsonRecord;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeResultFromSubprocess(
  input: NativeCanaryHostInput,
  nativeInput: NativeReferenceInput,
  value: IsolatedJsonRecord,
): NativeReferenceResult {
  const credentialField = childCredentialField(value);
  if (credentialField) {
    refuse('runner-refused', `Isolated native result contains a credential-shaped field: ${credentialField}`);
  }
  if (!record(value)
    || value.version !== 'native-reference/v1'
    || value.runId !== input.canary.runId
    || value.mode !== nativeInput.mode
    || value.status !== 'accepted'
    || !record(value.binding)
    || !record(value.preflight)) {
    refuse('runner-refused', 'Isolated native subprocess returned an invalid native-reference result');
  }
  const binding = value.binding;
  const expectedArtifactRoot = nativeArtifactRoot(input.canary.artifactRoot);
  if (Object.prototype.hasOwnProperty.call(binding, 'liveRoot')
    || typeof binding.copiedVaultRoot !== 'string'
    || !samePath(binding.copiedVaultRoot, input.canary.nativeRoot)
    || typeof binding.artifactRoot !== 'string'
    || !samePath(binding.artifactRoot, expectedArtifactRoot)
    || binding.sourceInventorySha256 !== input.canary.sourceInventory.inventorySha256
    || !record(binding.settings)
    || binding.settings.fullSha256 !== nativeInput.settings.fullSha256
    || binding.settings.safeProjectionSha256 !== nativeInput.settings.safeProjectionSha256
    || !record(binding.provider)
    || binding.provider.provider !== input.canary.provider.provider
    || binding.provider.model !== input.canary.provider.model
    || binding.provider.authorizationRefSha256 !== sha256Hex(input.canary.provider.authorizationRef)
    || Object.prototype.hasOwnProperty.call(binding, 'receiptSha256')) {
    refuse('runner-refused', 'Isolated native result is not bound to the host roots, provider, source inventory, or settings');
  }
  if (typeof value.artifactDirectory !== 'string'
    || !samePath(value.artifactDirectory, nodePath.join(expectedArtifactRoot, input.canary.runId))) {
    refuse('runner-refused', 'Isolated native result artifact directory is not the nested native run directory');
  }
  const preflightRoots = value.preflight.roots;
  if (!record(preflightRoots)
    || Object.prototype.hasOwnProperty.call(preflightRoots, 'liveRoot')
    || !Array.isArray(preflightRoots.copyRoots)
    || !record(preflightRoots.copyRoots[0])
    || !record(preflightRoots.copyRoots[1])
    || !samePath(String(preflightRoots.copyRoots[0].resolved), input.canary.nativeRoot)
    || !samePath(String(preflightRoots.copyRoots[1].resolved), expectedArtifactRoot)) {
    refuse('runner-refused', 'Isolated native preflight roots are not bound to the sealed host roots');
  }
  if (typeof value.preflight.copiedVaultRoot !== 'string'
    || !samePath(value.preflight.copiedVaultRoot, input.canary.nativeRoot)
    || typeof value.preflight.artifactRoot !== 'string'
    || !samePath(value.preflight.artifactRoot, expectedArtifactRoot)
    || !record(value.preflight.sourceInventory)
    || value.preflight.sourceInventory.inventorySha256 !== input.canary.sourceInventory.inventorySha256
    || !record(value.preflight.settings)
    || value.preflight.settings.fullSha256 !== nativeInput.settings.fullSha256
    || value.preflight.settings.safeProjectionSha256 !== nativeInput.settings.safeProjectionSha256
    || !record(value.preflight.effectiveSettings)) {
    refuse('runner-refused', 'Isolated native preflight metadata is not bound to the sealed host input');
  }
  const childReceipt = value.receipt;
  if (!record(childReceipt)
    || Object.prototype.hasOwnProperty.call(childReceipt, 'signature')
    || childReceipt.receipt_type !== 'native'
    || childReceipt.run_id !== input.canary.runId
    || childReceipt.status !== 'accepted') {
    refuse('runner-refused', 'Isolated native result did not return an unsigned accepted native receipt');
  }
  const receiptUnsigned = { ...childReceipt };
  const receiptDigest = canonicalJsonSha256(receiptUnsigned);
  const receipt: Receipt = {
    ...receiptUnsigned,
    signature: createContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, receiptDigest, input.canary.signer),
  } as Receipt;
  const receiptValidation = validateContract<Receipt>('receipt', receipt);
  if (!receiptValidation.valid) {
    refuse('runner-refused', 'Host re-signing could not produce a valid native receipt', receiptValidation.errors.map(error => error.message));
  }
  const hostBinding = {
    ...binding,
    liveRoot: input.canary.liveRoot,
    receiptSha256: canonicalJsonSha256(receipt),
  };
  const hostPreflight = {
    ...value.preflight,
    roots: {
      ...preflightRoots,
      liveRoot: {
        requested: input.canary.liveRoot,
        resolved: nodePath.resolve(input.canary.liveRoot),
      },
    },
  };
  return {
    ...value,
    preflight: hostPreflight,
    receipt,
    binding: hostBinding,
  } as unknown as NativeReferenceResult;
}

function isolatedRunner(input: NativeCanaryHostInput): NativeReferenceRunner {
  const sealedInventory = cloneFrozenInventory(input.canary.sourceInventory);
  const sealedInventorySha256 = sourceInventoryHash(sealedInventory);
  const expectedArtifactRoot = nativeArtifactRoot(input.canary.artifactRoot);
  return {
    run: async nativeInput => {
      const provider = input.canary.provider;
      if (nativeInput.runId !== input.canary.runId
        || !samePath(nativeInput.liveRoot, input.canary.liveRoot)
        || !samePath(nativeInput.copiedVaultRoot, input.canary.nativeRoot)
        || !samePath(nativeInput.artifactRoot, expectedArtifactRoot)
        || nativeInput.sourceInventory.inventorySha256 !== sealedInventorySha256
        || nativeInput.provider.provider !== provider.provider
        || nativeInput.provider.model !== provider.model
        || nativeInput.provider.authorizationRef !== provider.authorizationRef
        || nativeInput.provider.createClient !== provider.createClient
        || nativeInput.signer !== input.canary.signer) {
        refuse('runner-refused', 'Coordinator attempted to cross the isolated native-runner boundary');
      }
      const isolatedInput: IsolatedRunnerInput = {
        runId: nativeInput.runId,
        sourceInventory: sealedInventory,
        settings: nativeInput.settings,
        sourcePaths: nativeInput.sourcePaths ?? sealedInventory.sources.map(source => source.path),
        mode: nativeInput.mode,
        writer: hostWriterBinding(input),
        // The optional provider identity is intentionally omitted. The
        // configured isolation capability supplies the provider metadata and
        // the runner sends only its hash across the child-process wire.
      };
      let outcome;
      try {
        outcome = await input.isolatedRunner.run(isolatedInput);
      } catch (error) {
        refuse('runner-refused', 'Isolated native subprocess failed closed', [describe(error)]);
      }
      if (outcome.status !== 'accepted' || !outcome.result) {
        refuse('runner-refused', 'Isolated native subprocess rejected the native-reference operation', [outcome.error?.code ?? 'worker-rejected']);
      }
      return nativeResultFromSubprocess(input, nativeInput, outcome.result);
    },
  };
}

/** Exposed for host integration tests and adapters; it always delegates to the IPC runner. */
export function createIsolatedNativeReferenceRunner(input: NativeCanaryHostInput): NativeReferenceRunner {
  return isolatedRunner(input);
}

/**
 * Execute only an explicitly activated copied-vault canary.  No activation,
 * injected runner, marker, or writer authority can ever fall back to a live
 * run; the default is a typed inert refusal.
 */
export async function runNativeCanaryHost(input: NativeCanaryHostInput): Promise<NativeCanaryHostResult> {
  if (input.activation !== NATIVE_CANARY_HOST_ACTIVATION) {
    refuse('inactive', 'Native canary host is inert by default; explicit copied-vault activation is required');
  }
  const receiptInput = await prepareNativeCanaryHost(input);
  const roots = await resolveRoots(input);
  const receiptInputPath = await persistReceiptInput(input, receiptInput, roots);
  await revalidatePostimage(input, receiptInput, receiptInputPath, roots);
  await assertAuthorityCurrent(input);
  let canary: NativeCanaryResult;
  try {
    const writerBinding = hostWriterBinding(input);
    canary = await runNativeCanary({
      ...input.canary,
      writerBinding,
      assertWriterCurrent: () => assertAuthorityCurrent(input),
      nativeReference: createIsolatedNativeReferenceRunner(input),
    });
  } catch (error) {
    if (error instanceof NativeCanaryHostRefusal) throw error;
    refuse('runner-refused', 'Copied-vault native canary runner refused or failed', [describe(error)]);
  }
  if (sourceInventoryHash(input.canary.sourceInventory) !== receiptInput.sourceInventorySha256
    || sourceInventoryHash(canary.native.preflight.sourceInventory) !== receiptInput.sourceInventorySha256) {
    refuse('runner-refused', 'Source inventory changed or was not preserved across the native runner boundary');
  }
  await assertAuthorityCurrent(input);
  await revalidatePostRun(input, receiptInput, receiptInputPath, roots);
  const expectedWriter = hostWriterBinding(input);
  if (!canary.hostWriterBinding
    || canary.hostWriterBinding.ownerId !== expectedWriter.ownerId
    || canary.hostWriterBinding.runId !== expectedWriter.runId
    || canary.hostWriterBinding.fence !== expectedWriter.fence
    || canary.hostWriterBinding.candidateRootSha256 !== expectedWriter.candidateRootSha256
    || !canary.writerBinding
    || canary.writerBinding.ownerId !== expectedWriter.ownerId
    || canary.writerBinding.runId !== input.canary.runId
    || canary.writerBinding.candidateRootSha256 !== expectedWriter.candidateRootSha256
    || Number(canary.transactionPlan.fence) !== canary.writerBinding.fence) {
    refuse('writer-authority-lost', 'Coordinator result is not bound to the host writer and candidate-root authority');
  }
  if (samePath(canary.observation.liveRoot, canary.copies.native.root)
    || samePath(canary.observation.liveRoot, canary.copies.candidate.root)
    || samePath(canary.observation.liveRoot, input.canary.artifactRoot)) {
    refuse('runner-refused', 'Runner returned a live-root binding for a copied-vault canary');
  }
  return {
    version: NATIVE_CANARY_HOST_VERSION,
    receiptInput,
    receiptInputPath,
    canary,
  };
}
