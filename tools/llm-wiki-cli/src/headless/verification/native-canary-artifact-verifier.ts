import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  DOMAINS,
  KeyRegistry,
  digestHex,
  hashCanonical,
  verifyContractSignature,
  verifyTerminalRoot,
  normalizeRelativePath,
  TERMINAL_EXCLUDED_PATHS,
  type MerkleArtifactInput,
  type JsonValue,
  type TerminalRoot,
} from '../crypto';
import { assertValidContract, type Receipt } from '../contracts';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../preflight/hashing';
import {
  captureSnapshot,
  compareSnapshots,
  type CopySnapshotManifest,
  type SnapshotEntry,
} from '../copy-snapshot';
import { compareNativeCandidate } from '../comparison';
import { hashDomain, validateContractSemanticProjection } from '../provenance';
import type { ContractSemanticProjection } from '../provenance/types';
import { hashNullable, assertPlanHash, type FileState, type JournalEvent, type TransactionOperation, type TransactionPlan } from '../transaction';
import { TransactionJournal } from '../transaction/journal';
import { verifyReplayLedgerFile } from '../crypto/replay-ledger';
import type { NativeMapIR, NativeMapPolicy } from '../native-map';
import type { NativeReductionPlan } from '../native-reducer';
import type { NativeReferenceBinding } from '../native-reference';
import type { SemanticComparisonResult } from '../comparison';
import type { SourceInventory } from '../preflight/source-inventory';
import { assertRootBindingUnchanged, captureRootBinding, type RootBinding } from '../preflight/path-safety';
import {
  RunArtifactVerificationError,
} from './types';

/** Files emitted by `finalizeAndVerify` for the native-vs-candidate canary. */
export const NATIVE_CANARY_ARTIFACT_FILES = Object.freeze([
  'live-idle-observation.json',
  'live-terminal-observation.json',
  'copy-manifests.json',
  'native-receipt.json',
  'native-binding.json',
  'canary-binding.json',
  'native-projection.json',
  'map-policy.json',
  'map-ir.json',
  'reduction-plan.json',
  'candidate-projection.json',
  'candidate-snapshot.json',
  'semantic-comparison.json',
  'transaction-plan.json',
  'transaction-receipt.json',
  'transaction-journal.jsonl',
  'replay-ledger.jsonl',
  'terminal-run-root.json',
] as const);

const LIVE_OBSERVATION_VERSION = 'spm-brain/live-idle-observation/v1';
const ZERO_CHECKPOINT = '0'.repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const JOURNAL_KINDS = new Set<JournalEvent['kind']>([
  'prepared', 'cas-checked', 'applied', 'apply-failed', 'interrupted',
  'readback-mismatch', 'commit-check-failed', 'committed', 'restore-started',
  'restore-failed', 'restored', 'recovery-started', 'recovered', 'frozen',
]);
const MAP_ARTIFACT_DOMAIN = 'spm-brain/native-map-artifact/v1\0' as const;

export interface NativeCanaryArtifactVerificationOptions {
  /** Terminal artifact directory. This verifier never writes beneath it. */
  readonly directory: string;
  readonly registry: KeyRegistry;
  readonly expectedRunId?: string;
  readonly expectedWindowId?: string;
  readonly expectedLiveRoot?: string;
  readonly expectedNativeRoot?: string;
  readonly expectedCandidateRoot?: string;
  readonly expectedArtifactRoot?: string;
  readonly expectedAuthority?: { readonly repositoryUrl?: string; readonly commit?: string; readonly tree: string };
  /** The exact inventory used by the canary. Supplying it enables source-byte identity checks. */
  readonly sourceInventory?: SourceInventory;
  readonly expectedProvider?: { readonly provider: string; readonly model: string; readonly authorizationRefSha256?: string };
  readonly now?: Date | number;
  readonly maxObservationAgeMs?: number;
  readonly liveRoot?: string;
  /** If supplied, recapture the live vault and compare it with the sealed live snapshot. */
  readonly verifyLiveRoot?: boolean;
  readonly terminalScope?: string;
  readonly liveObservationScope?: string;
  readonly nativeReceiptScope?: string;
  readonly replayScope?: string;
}

export interface VerifiedNativeCanaryArtifacts {
  readonly ok: true;
  readonly runId: string;
  readonly directory: string;
  readonly terminalRoot: TerminalRoot;
  readonly liveObservation: Readonly<Record<string, unknown>>;
  readonly terminalObservation: Readonly<Record<string, unknown>>;
  readonly copies: Readonly<{ live: CopySnapshotManifest; native: CopySnapshotManifest; candidate: CopySnapshotManifest }>;
  readonly nativeReceipt: Receipt;
  readonly nativeBinding: NativeReferenceBinding;
  readonly nativeProjection: ContractSemanticProjection;
  readonly mapPolicy: NativeMapPolicy;
  readonly mapIR: readonly NativeMapIR[];
  readonly reduction: NativeReductionPlan;
  readonly candidateProjection: ContractSemanticProjection;
  readonly candidateSnapshot: CopySnapshotManifest;
  readonly comparison: SemanticComparisonResult;
  readonly transactionPlan: TransactionPlan;
  readonly transactionReceipt: Readonly<Record<string, unknown>>;
  readonly transactionJournalSha256: string;
  readonly replayLedgerRootSha256: string;
  readonly liveUnchanged: boolean;
}

interface CanaryBinding {
  readonly version: 'native-canary-binding/v1';
  readonly runId: string;
  readonly windowId: string;
  readonly authority: { readonly repositoryUrl: string; readonly commit: string; readonly tree: string };
  readonly sourceInventorySha256: string;
  readonly liveRoot: string;
  readonly nativeRoot: string;
  readonly candidateRoot: string;
  readonly artifactRoot: string;
  readonly policySha256: string;
  readonly provider: { readonly provider: string; readonly model: string; readonly authorizationRefSha256: string };
}

type RecordValue = Record<string, unknown>;

function invalid(path: string, message: string, code = 'invalid'): RunArtifactVerificationError {
  return new RunArtifactVerificationError(`${path}: ${message}`, { code, path, message });
}

function fail(path: string, message: string, code = 'invalid'): never {
  throw invalid(path, message, code);
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object', 'shape');
  return value as RecordValue;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(path, 'expected a lowercase SHA-256 digest', 'digest');
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(path, 'expected a non-empty NUL-free string', 'shape');
  return value;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function artifactPath(directory: string, name: string): string {
  if (!name || name.includes('\0')) fail(name || '/', 'artifact path is empty or contains NUL', 'unsafe-path');
  const root = resolve(directory);
  const target = resolve(root, name);
  const child = relative(root, target);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail(name, 'artifact path escapes the run directory', 'unsafe-path');
  return target;
}

function isTerminalExcluded(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return TERMINAL_EXCLUDED_PATHS.includes(path as (typeof TERMINAL_EXCLUDED_PATHS)[number])
    || TERMINAL_EXCLUDED_PATHS.includes(basename as (typeof TERMINAL_EXCLUDED_PATHS)[number])
    || path.startsWith('live-preflight-') || path.startsWith('release-')
    || basename.startsWith('live-preflight-') || basename.startsWith('release-');
}

function assertPlainPath(path: string, label: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.isDirectory() !== directory || (!directory && !stat.isFile())) {
    fail(label, `${label} is not a plain ${directory ? 'directory' : 'file'}`, 'unsafe-path');
  }
  const resolved = realpathSync(path);
  if (!samePath(resolved, path)) fail(label, `${label} resolves through a link or reparse point`, 'unsafe-path');
}

function collectArtifactFiles(directory: string): Map<string, Uint8Array> {
  assertPlainPath(directory, 'artifact-root', true);
  const result = new Map<string, Uint8Array>();
  const walk = (absolute: string, prefix: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = resolve(absolute, entry.name);
      const relativePath = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) fail(relativePath, 'terminal artifact contains a symbolic link', 'unsafe-path');
      assertPlainPath(child, relativePath, entry.isDirectory());
      if (entry.isDirectory()) {
        walk(child, relativePath);
      } else if (!isTerminalExcluded(relativePath)) {
        if (result.has(relativePath)) fail(relativePath, 'duplicate terminal artifact path', 'duplicate');
        result.set(relativePath, new Uint8Array(readFileSync(child)));
      } else {
        // The terminal root is parsed and retained for the final immutability
        // check, but is intentionally omitted from the Merkle leaf set.
        result.set(relativePath, new Uint8Array(readFileSync(child)));
      }
    }
  };
  walk(resolve(directory), '');
  for (const required of NATIVE_CANARY_ARTIFACT_FILES) {
    if (!result.has(required)) fail(required, 'required artifact is not present in the immutable terminal snapshot', 'missing-artifact');
  }
  return result;
}

function assertArtifactSnapshotUnchanged(directory: string, baseline: ReadonlyMap<string, Uint8Array>): void {
  const current = collectArtifactFiles(directory);
  if (current.size !== baseline.size) fail('terminal-run-root.json', 'terminal artifact set changed during verification', 'artifact-mutated');
  for (const [path, bytes] of baseline) {
    const actual = current.get(path);
    if (!actual || Buffer.compare(Buffer.from(actual), Buffer.from(bytes)) !== 0) fail(path, 'terminal artifact bytes changed during verification', 'artifact-mutated');
  }
}

function parseJsonBytes<T>(bytes: Uint8Array, name: string): T {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
  catch (error) { fail(name, `invalid JSON: ${(error as Error).message}`, 'malformed-json'); }
}

function bytesFor(baseline: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const bytes = baseline.get(name);
  if (!bytes) fail(name, 'required artifact is not present in the immutable terminal snapshot', 'missing-artifact');
  return bytes;
}

function terminalMerkleArtifacts(baseline: ReadonlyMap<string, Uint8Array>): readonly MerkleArtifactInput[] {
  return [...baseline.entries()]
    .filter(([path]) => path !== 'terminal-run-root.json' && !isTerminalExcluded(path))
    .map(([path, bytes]) => ({ path, bytes }));
}

function readBytes(directory: string, name: string): Uint8Array {
  try { return new Uint8Array(readFileSync(artifactPath(directory, name))); }
  catch (error) { fail(name, `required artifact is not readable: ${(error as Error).message}`, 'missing-artifact'); }
}

function unsigned(value: unknown, path: string): RecordValue {
  const input = record(value, path);
  if (!Object.prototype.hasOwnProperty.call(input, 'signature')) fail(`${path}/signature`, 'signature is missing', 'missing-signature');
  const { signature: _signature, ...body } = input;
  return body;
}

function validateSnapshot(value: unknown, path: string): CopySnapshotManifest {
  const snapshot = record(value, path) as unknown as CopySnapshotManifest;
  if (snapshot.version !== 'copied-vault-snapshot/v1') fail(`${path}/version`, 'unsupported snapshot version', 'contract');
  const root = nonEmpty(snapshot.root, `${path}/root`);
  const exclusions = snapshot.exclusions;
  if (!Array.isArray(exclusions) || exclusions.some(item => typeof item !== 'string')) fail(`${path}/exclusions`, 'snapshot exclusions are invalid', 'contract');
  const normalizedExclusions = (exclusions as string[]).map((item, index) => {
    let normalized: string;
    try { normalized = normalizeRelativePath(item); } catch (error) { fail(`${path}/exclusions/${index}`, (error as Error).message, 'unsafe-path'); }
    if (normalized !== item || (!['run', 'lease'].includes(normalized) && !normalized.startsWith('run/') && !normalized.startsWith('lease/'))) fail(`${path}/exclusions/${index}`, 'snapshot exclusion is outside constrained runtime metadata', 'unsafe-path');
    return normalized;
  });
  if (new Set(normalizedExclusions).size !== normalizedExclusions.length || JSON.stringify(normalizedExclusions) !== JSON.stringify([...normalizedExclusions].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))))) fail(`${path}/exclusions`, 'snapshot exclusions are not canonical', 'ordering');
  if (!Array.isArray(snapshot.entries)) fail(`${path}/entries`, 'snapshot entries are missing', 'contract');
  const seen = new Set<string>();
  const entries: SnapshotEntry[] = [];
  for (const [index, entryValue] of snapshot.entries.entries()) {
    const entry = record(entryValue, `${path}/entries/${index}`);
    const entryPath = nonEmpty(entry.path, `${path}/entries/${index}/path`).replaceAll('\\', '/');
    if (entryPath !== entry.path || entryPath.startsWith('/') || entryPath.split('/').some(part => part === '..' || part === '.')) fail(`${path}/entries/${index}/path`, 'snapshot path is not normalized', 'unsafe-path');
    if (seen.has(entryPath)) fail(`${path}/entries/${index}/path`, 'duplicate snapshot path', 'duplicate');
    seen.add(entryPath);
    if (!Number.isSafeInteger(entry.byteLength) || Number(entry.byteLength) < 0) fail(`${path}/entries/${index}/byteLength`, 'invalid byte length', 'contract');
    const byteSha256 = digest(entry.byteSha256, `${path}/entries/${index}/byteSha256`);
    entries.push({ path: entryPath, byteLength: Number(entry.byteLength), byteSha256 });
  }
  const sorted = [...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) fail(`${path}/entries`, 'snapshot entries are not sorted', 'ordering');
  const treeSha256 = digest(snapshot.treeSha256, `${path}/treeSha256`);
  let expectedTree: string;
  try { expectedTree = snapshotTreeHash(entries); } catch (error) { fail(`${path}/treeSha256`, (error as Error).message, 'hash-mismatch'); }
  if (expectedTree !== treeSha256) fail(`${path}/treeSha256`, 'snapshot tree hash does not match entries', 'hash-mismatch');
  const body = { version: snapshot.version, root, exclusions: normalizedExclusions, entries, treeSha256 };
  if (sha256Hex(JSON.stringify(body)) !== snapshot.manifestSha256) fail(`${path}/manifestSha256`, 'snapshot manifest hash does not match its exact body', 'hash-mismatch');
  return { ...body, manifestSha256: snapshot.manifestSha256 };
}

function validateObservation(value: unknown, path: string, options: NativeCanaryArtifactVerificationOptions, runId: string, initial?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const observation = record(value, path);
  if (observation.version !== LIVE_OBSERVATION_VERSION || observation.runId !== runId || observation.idle !== true || observation.mutationSurface !== 'read-only') fail(path, 'observation is not a signed idle read-only observation for this run', 'binding-mismatch');
  const windowId = nonEmpty(observation.windowId, `${path}/windowId`);
  if (options.expectedWindowId !== undefined && windowId !== options.expectedWindowId) fail(`${path}/windowId`, 'window identity differs from expected', 'binding-mismatch');
  const liveRoot = nonEmpty(observation.liveRoot, `${path}/liveRoot`);
  if (options.expectedLiveRoot !== undefined && !samePath(liveRoot, options.expectedLiveRoot)) fail(`${path}/liveRoot`, 'live root differs from expected root', 'binding-mismatch');
  const statusDigest = digest(observation.statusDigest, `${path}/statusDigest`);
  const observedAt = nonEmpty(observation.observedAt, `${path}/observedAt`);
  const signedDigest = digest(observation.signedDigest, `${path}/signedDigest`);
  const signature = record(observation.signature, `${path}/signature`);
  if (signature.signed_digest !== signedDigest) fail(`${path}/signature/signed_digest`, 'observation signature is not bound to signedDigest', 'binding-mismatch');
  const body = {
    version: observation.version,
    runId: observation.runId,
    windowId,
    liveRoot,
    observedAt,
    idle: observation.idle,
    mutationSurface: observation.mutationSurface,
    statusDigest,
  } as JsonValue;
  if (digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, body)) !== signedDigest) fail(`${path}/signedDigest`, 'observation digest does not match its unsigned body', 'hash-mismatch');
  try {
    verifyContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, signature as never, options.registry, {
      requiredScope: options.liveObservationScope ?? 'spm-brain-live-preflight-sign',
      runId,
    });
  } catch (error) { fail(`${path}/signature`, (error as Error).message, 'signature-invalid'); }
  const timestamp = Date.parse(observedAt);
  const now = options.now instanceof Date ? options.now.getTime() : typeof options.now === 'number' ? options.now : Date.now();
  const maxAge = options.maxObservationAgeMs ?? 60_000;
  if (!Number.isFinite(timestamp) || timestamp > now + 5_000 || now - timestamp > maxAge) fail(`${path}/observedAt`, 'observation is missing, future-dated, or stale', 'stale-observation');
  if (initial !== undefined && initial.statusDigest !== statusDigest) fail(`${path}/statusDigest`, 'terminal observation differs from initial live status', 'live-drift');
  return observation;
}

function validateProjection(value: unknown, path: string, runId: string): ContractSemanticProjection {
  const projection = record(value, path) as unknown as ContractSemanticProjection;
  if (projection.schema_version !== 'semantic-projection/v1' || projection.run_id !== runId) fail(path, 'projection schema or run identity is invalid', 'projection-invalid');
  const legality = validateContractSemanticProjection(projection);
  if (!legality.valid) fail(path, legality.errors.join('; '), 'projection-invalid');
  const nodeIds = new Set(projection.nodes.map(node => node.id));
  const edgeIds = new Set<string>();
  for (const edge of projection.edges) {
    if (edgeIds.has(edge.id)) fail(`${path}/edges/${edge.id}`, 'duplicate projection edge', 'duplicate');
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) fail(`${path}/edges/${edge.id}`, 'projection edge endpoint is missing', 'projection-invalid');
  }
  return projection;
}

function verifyPolicy(value: unknown, path: string): NativeMapPolicy {
  const policy = record(value, path) as unknown as NativeMapPolicy;
  if (policy.contractVersion !== 'native-map/v1' || typeof policy.settings !== 'object' || policy.settings === null) fail(path, 'map policy contract is invalid', 'contract');
  const settingsSha256 = digest(policy.settingsSha256, `${path}/settingsSha256`);
  const vocabularySha256 = digest(policy.vocabularySha256, `${path}/vocabularySha256`);
  const policyPackSha256 = digest(policy.policyPackSha256, `${path}/policyPackSha256`);
  const policySha256 = digest(policy.policySha256, `${path}/policySha256`);
  if (canonicalJsonSha256(policy.settings) !== settingsSha256) fail(`${path}/settingsSha256`, 'settings hash is not exact', 'hash-mismatch');
  if (canonicalJsonSha256({ entityTags: policy.entityTags, conceptTags: policy.conceptTags }) !== vocabularySha256) fail(`${path}/vocabularySha256`, 'vocabulary hash is not exact', 'hash-mismatch');
  if (canonicalJsonSha256({
    contractVersion: policy.contractVersion,
    promptVersion: policy.promptVersion,
    settings: policy.settings,
    entityTags: policy.entityTags,
    conceptTags: policy.conceptTags,
    schemaContext: policy.schemaContext ?? null,
    systemPrompt: policy.systemPrompt ?? null,
    settingsSha256,
    vocabularySha256,
    policyPackSha256,
  }) !== policySha256) fail(`${path}/policySha256`, 'policy hash is not exact', 'hash-mismatch');
  return policy;
}

function verifyMapIR(value: unknown, path: string, policy: NativeMapPolicy, options: NativeCanaryArtifactVerificationOptions, runId: string): NativeMapIR[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'map IR must contain one artifact per source', 'coverage');
  const inventory = options.sourceInventory;
  if (options.expectedAuthority !== undefined) {
    if (inventory === undefined) fail(path, 'expected authority cannot be checked without the source inventory', 'missing-authority');
    if (inventory.authorityTree !== options.expectedAuthority.tree) fail(path, 'map source authority tree differs from expected authority', 'binding-mismatch');
  }
  const expectedByPath = new Map(inventory?.sources.map(source => [source.path, source]) ?? []);
  const seen = new Set<string>();
  const result: NativeMapIR[] = [];
  for (const [index, raw] of value.entries()) {
    const ir = record(raw, `${path}/${index}`) as unknown as NativeMapIR;
    if (ir.contractVersion !== 'native-map/v1') fail(`${path}/${index}/contractVersion`, 'unsupported map IR version', 'contract');
    const source = record(ir.source, `${path}/${index}/source`);
    const sourceId = nonEmpty(source.sourceId, `${path}/${index}/source/sourceId`);
    const sourcePath = nonEmpty(source.sourcePath, `${path}/${index}/source/sourcePath`).replaceAll('\\', '/');
    try { if (normalizeRelativePath(sourcePath) !== sourcePath) fail(`${path}/${index}/source/sourcePath`, 'map source path is not canonical', 'unsafe-path'); }
    catch (error) { fail(`${path}/${index}/source/sourcePath`, (error as Error).message, 'unsafe-path'); }
    if (seen.has(sourceId)) fail(`${path}/${index}/source/sourceId`, 'duplicate source map artifact', 'duplicate');
    if (index > 0 && [...seen].at(-1)! >= sourceId) fail(`${path}/${index}/source/sourceId`, 'map IR is not sorted by source identity', 'ordering');
    seen.add(sourceId);
    const sourceByteSha256 = digest(source.byteSha256, `${path}/${index}/source/byteSha256`);
    if (!Number.isSafeInteger(source.byteCount) || Number(source.byteCount) < 0) fail(`${path}/${index}/source/byteCount`, 'invalid source byte count', 'contract');
    if (inventory) {
      const expected = expectedByPath.get(sourcePath);
      if (!expected || expected.sourceIdentity !== sourceId || expected.byteSha256 !== sourceByteSha256 || expected.byteLength !== source.byteCount) fail(`${path}/${index}/source`, 'map source is not authority-inventory bound', 'binding-mismatch');
      if (sourceId !== sourceIdentityDigest(inventory.authorityTree, sourcePath, sourceByteSha256)) fail(`${path}/${index}/source/sourceId`, 'source identity is not reproducible', 'provenance-invalid');
    }
    if (ir.policySha256 !== policy.policySha256) fail(`${path}/${index}/policySha256`, 'map IR uses a substituted policy', 'binding-mismatch');
    const { irSha256, ...body } = ir as NativeMapIR & { irSha256: string };
    if (digest(irSha256, `${path}/${index}/irSha256`) !== canonicalJsonSha256(body)) fail(`${path}/${index}/irSha256`, 'map IR hash does not match exact body', 'hash-mismatch');
    const artifacts = ir.artifacts;
    if (!Array.isArray(artifacts)) fail(`${path}/${index}/artifacts`, 'map artifacts are missing', 'contract');
    for (const [artifactIndex, artifactValue] of artifacts.entries()) {
      const artifact = record(artifactValue, `${path}/${index}/artifacts/${artifactIndex}`);
      const artifactBody = {
        contractVersion: ir.contractVersion,
        sourceId,
        sourceByteSha256,
        kind: artifact.kind,
        pageType: artifact.pageType,
        label: artifact.label,
        normalizedLabel: artifact.normalizedLabel,
        data: artifact.data,
      } as JsonValue;
      if (artifact.sourceId !== sourceId || artifact.sourceByteSha256 !== sourceByteSha256 || artifact.artifactId !== hashDomain(MAP_ARTIFACT_DOMAIN, artifactBody)) fail(`${path}/${index}/artifacts/${artifactIndex}`, 'map artifact is not source/byte content-addressed', 'provenance-invalid');
    }
    result.push(ir);
  }
  if (inventory && seen.size !== inventory.sources.length) fail(path, 'map IR does not cover the complete source inventory', 'coverage');
  if (policy && result.some(ir => ir.policySha256 !== policy.policySha256)) fail(path, 'map policy coverage is incomplete', 'binding-mismatch');
  void runId;
  return result;
}

function verifyExpectedInventory(inventory: SourceInventory, expectedAuthority: NativeCanaryArtifactVerificationOptions['expectedAuthority']): void {
  if (inventory.version !== 'source-inventory/v1' || typeof inventory.authorityTree !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(inventory.authorityTree)) fail('sourceInventory', 'source inventory version or authority tree is invalid', 'source-manifest-mismatch');
  if (expectedAuthority !== undefined && inventory.authorityTree !== expectedAuthority.tree) fail('sourceInventory/authorityTree', 'source inventory authority differs from expected authority', 'binding-mismatch');
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) fail('sourceInventory/sources', 'source inventory is empty', 'coverage');
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const [index, source] of inventory.sources.entries()) {
    const path = nonEmpty(source.path, `sourceInventory/sources/${index}/path`).replaceAll('\\', '/');
    try { if (normalizeRelativePath(path) !== path) fail(`sourceInventory/sources/${index}/path`, 'source path is not canonical', 'unsafe-path'); }
    catch (error) { fail(`sourceInventory/sources/${index}/path`, (error as Error).message, 'unsafe-path'); }
    const byteSha256 = digest(source.byteSha256, `sourceInventory/sources/${index}/byteSha256`);
    if (path !== source.path || paths.has(path) || identities.has(source.sourceIdentity)) fail(`sourceInventory/sources/${index}`, 'source inventory has duplicate or non-normalized identity', 'source-manifest-mismatch');
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || sourceIdentityDigest(inventory.authorityTree, path, byteSha256) !== source.sourceIdentity) fail(`sourceInventory/sources/${index}`, 'source identity is not reproducible', 'provenance-invalid');
    paths.add(path); identities.add(source.sourceIdentity);
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
  if (inventory.snapshotTreeHash !== snapshotTreeHash(inventory.sources.map(source => ({ path: source.path, byteSha256: source.byteSha256 })))) fail('sourceInventory/snapshotTreeHash', 'source inventory tree hash is not exact', 'hash-mismatch');
  if (inventory.inventorySha256 !== canonicalJsonSha256(body)) fail('sourceInventory/inventorySha256', 'source inventory hash is not exact', 'hash-mismatch');
}

function decodeBase64(value: unknown, path: string): Uint8Array | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail(path, 'state bytes are not strict base64', 'transaction-invalid');
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) fail(path, 'state bytes are not canonical base64', 'transaction-invalid');
  return bytes;
}

function decodeState(value: unknown, path: string): FileState {
  const raw = record(value, path);
  if (typeof raw.exists !== 'boolean') fail(`${path}/exists`, 'state existence is invalid', 'transaction-invalid');
  const bytes = decodeBase64(raw.bytes, `${path}/bytes`);
  const hash = raw.hash === null ? null : digest(raw.hash, `${path}/hash`);
  if (raw.exists !== (bytes !== null) || hashNullable(bytes) !== hash) fail(path, 'state bytes/hash are inconsistent', 'transaction-invalid');
  return { exists: raw.exists, bytes, hash };
}

function decodePlan(value: unknown): TransactionPlan {
  const raw = record(value, 'transaction-plan');
  if (raw.version !== 'transaction-plan/v1') fail('transaction-plan/version', 'unsupported transaction plan', 'transaction-invalid');
  const operationsValue = raw.operations;
  if (!Array.isArray(operationsValue)) fail('transaction-plan/operations', 'transaction operations are missing', 'transaction-invalid');
  const operations: TransactionOperation[] = operationsValue.map((operationValue, index) => {
    const operation = record(operationValue, `transaction-plan/operations/${index}`);
    const kind = operation.kind;
    if (kind !== 'create' && kind !== 'replace' && kind !== 'delete') fail(`transaction-plan/operations/${index}/kind`, 'invalid operation kind', 'transaction-invalid');
    const path = nonEmpty(operation.path, `transaction-plan/operations/${index}/path`);
    let normalized: string;
    try { normalized = normalizeRelativePath(path); } catch (error) { fail(`transaction-plan/operations/${index}/path`, (error as Error).message, 'transaction-invalid'); }
    if (normalized !== path) fail(`transaction-plan/operations/${index}/path`, 'transaction path is not normalized', 'transaction-invalid');
    if (operation.scope !== 'page' && operation.scope !== 'global') fail(`transaction-plan/operations/${index}/scope`, 'invalid transaction scope', 'transaction-invalid');
    const before = decodeState(operation.before, `transaction-plan/operations/${index}/before`);
    const after = decodeState(operation.after, `transaction-plan/operations/${index}/after`);
    const preconditionHash = operation.preconditionHash === null ? null : digest(operation.preconditionHash, `transaction-plan/operations/${index}/preconditionHash`);
    const expectedKind = !before.exists && after.exists ? 'create' : before.exists && after.exists ? 'replace' : before.exists && !after.exists ? 'delete' : undefined;
    if (kind !== expectedKind || preconditionHash !== before.hash) fail(`transaction-plan/operations/${index}`, 'operation kind/precondition does not bind state', 'transaction-invalid');
    return { kind, path, scope: operation.scope, preconditionHash, before, after };
  });
  const plan = { version: 'transaction-plan/v1' as const, transactionId: nonEmpty(raw.transactionId, 'transaction-plan/transactionId'), fence: raw.fence as string | number, operations, planHash: digest(raw.planHash, 'transaction-plan/planHash') };
  if (!(typeof plan.fence === 'string' || (typeof plan.fence === 'number' && Number.isSafeInteger(plan.fence)))) fail('transaction-plan/fence', 'invalid transaction fence', 'transaction-invalid');
  try { assertPlanHash(plan); } catch (error) { fail('transaction-plan/planHash', (error as Error).message, 'hash-mismatch'); }
  return plan;
}

function comparablePlan(plan: TransactionPlan): JsonValue {
  return {
    version: plan.version,
    transactionId: plan.transactionId,
    fence: plan.fence,
    operations: plan.operations.map(operation => ({
      kind: operation.kind,
      path: operation.path,
      scope: operation.scope,
      preconditionHash: operation.preconditionHash,
      before: {
        exists: operation.before.exists,
        hash: operation.before.hash,
        bytes: operation.before.bytes === null ? null : Buffer.from(operation.before.bytes).toString('base64'),
      },
      after: {
        exists: operation.after.exists,
        hash: operation.after.hash,
        bytes: operation.after.bytes === null ? null : Buffer.from(operation.after.bytes).toString('base64'),
      },
    })),
    planHash: plan.planHash,
  };
}

function verifyReduction(value: unknown, path: string, mapIR: readonly NativeMapIR[], policy: NativeMapPolicy): NativeReductionPlan {
  const reduction = record(value, path) as unknown as NativeReductionPlan;
  if (reduction.version !== 'native-reducer/v1' || reduction.complete !== true || reduction.status !== 'candidate' || reduction.canApply !== true) fail(path, 'reduction is not an eligible candidate plan', 'reduction-refused');
  if (reduction.reasons.length !== 0 || reduction.unsupported.length !== 0) fail(path, 'reduction contains refusal reasons or unsupported semantics', 'reduction-refused');
  const sourceIds = new Set(mapIR.map(ir => ir.source.sourceId));
  const paths = new Set<string>();
  for (const [index, desired] of reduction.desiredState.entries()) {
    const item = record(desired, `${path}/desiredState/${index}`);
    const targetPath = nonEmpty(item.path, `${path}/desiredState/${index}/path`).replaceAll('\\', '/');
    try { if (normalizeRelativePath(targetPath) !== targetPath) fail(`${path}/desiredState/${index}/path`, 'desired path is not canonical', 'unsafe-path'); }
    catch (error) { fail(`${path}/desiredState/${index}/path`, (error as Error).message, 'unsafe-path'); }
    if (paths.has(targetPath)) fail(`${path}/desiredState/${index}/path`, 'duplicate desired path', 'duplicate');
    if (index > 0 && [...paths].at(-1)! >= targetPath) fail(`${path}/desiredState/${index}/path`, 'desired state is not sorted by path', 'ordering');
    paths.add(targetPath);
    if (item.phase !== 'partition' && item.phase !== 'serialized-global') fail(`${path}/desiredState/${index}/phase`, 'invalid desired-file phase', 'reduction-invalid');
    if (!['create', 'replace', 'unchanged'].includes(String(item.action))) fail(`${path}/desiredState/${index}/action`, 'invalid desired-file action', 'reduction-invalid');
    if (typeof item.content !== 'string' || sha256Hex(item.content) !== item.desiredSha256) fail(`${path}/desiredState/${index}`, 'desired file hash does not match content', 'hash-mismatch');
    if (!Array.isArray(item.sourceIds) || item.sourceIds.length === 0 || item.sourceIds.some(id => !sourceIds.has(String(id))) || new Set(item.sourceIds).size !== item.sourceIds.length) fail(`${path}/desiredState/${index}/sourceIds`, 'desired file source binding is not map-bound', 'binding-mismatch');
    if (item.canonicalKey !== undefined) {
      const key = record(item.canonicalKey, `${path}/desiredState/${index}/canonicalKey`);
      if (key.pageType !== 'entity' && key.pageType !== 'concept') fail(`${path}/desiredState/${index}/canonicalKey/pageType`, 'invalid canonical key type', 'reduction-invalid');
    }
  }
  const global = record(reduction.globalPhase, `${path}/globalPhase`);
  if (global.serialized !== true || !Array.isArray(global.serializationOrder) || !Array.isArray(global.files)) fail(`${path}/globalPhase`, 'global serialization phase is incomplete', 'reduction-invalid');
  if (global.serializationOrder.some((item: unknown) => typeof item !== 'string' || normalizeRelativePath(item) !== item) || new Set(global.serializationOrder).size !== global.serializationOrder.length) fail(`${path}/globalPhase/serializationOrder`, 'global serialization order contains unsafe or duplicate paths', 'unsafe-path');
  if (global.files.some((item: unknown) => !record(item, `${path}/globalPhase/files` ).path)) fail(`${path}/globalPhase/files`, 'global phase contains malformed desired files', 'reduction-invalid');
  const policyHashes = [policy.policySha256];
  void policyHashes;
  return reduction;
}

function compareSnapshotsExact(left: CopySnapshotManifest, right: CopySnapshotManifest, path: string): void {
  const comparison = compareSnapshots(left, right);
  if (!comparison.exact) fail(path, `snapshot mismatch: ${JSON.stringify(comparison)}`, 'snapshot-mismatch');
}

function verifyCandidatePostState(initial: CopySnapshotManifest, post: CopySnapshotManifest, plan: TransactionPlan): void {
  const before = new Map(initial.entries.map(entry => [entry.path, entry]));
  const after = new Map(post.entries.map(entry => [entry.path, entry]));
  const operations = new Map(plan.operations.map(operation => [operation.path, operation]));
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const path of allPaths) {
    const left = before.get(path); const right = after.get(path); const operation = operations.get(path);
    const changed = left?.byteLength !== right?.byteLength || left?.byteSha256 !== right?.byteSha256;
    if (!changed && operation !== undefined) fail(`candidate-snapshot/${path}`, 'transaction operation did not change candidate snapshot', 'snapshot-mismatch');
    if (changed && operation === undefined) fail(`candidate-snapshot/${path}`, 'candidate snapshot changed outside transaction plan', 'snapshot-mismatch');
    if (!operation) continue;
    if (operation.after.exists) {
      if (!right || right.byteSha256 !== operation.after.hash || right.byteLength !== operation.after.bytes?.byteLength) fail(`candidate-snapshot/${path}`, 'post-state does not match transaction after bytes', 'snapshot-mismatch');
    } else if (right !== undefined) fail(`candidate-snapshot/${path}`, 'deleted transaction target remains in candidate snapshot', 'snapshot-mismatch');
  }
}

function verifyTransactionCoverage(plan: TransactionPlan, reduction: NativeReductionPlan, initial: CopySnapshotManifest): void {
  const before = new Map(initial.entries.map(entry => [entry.path, entry]));
  const desired = new Map(reduction.desiredState.map(file => [file.path, file]));
  const operations = new Map(plan.operations.map(operation => [operation.path, operation]));
  if (operations.size !== plan.operations.length) fail('transaction-plan.json/operations', 'transaction contains duplicate paths', 'duplicate');
  for (const [index, operation] of plan.operations.entries()) {
    try { if (normalizeRelativePath(operation.path) !== operation.path) fail(`transaction-plan.json/operations/${index}/path`, 'transaction path is not canonical', 'unsafe-path'); }
    catch (error) { fail(`transaction-plan.json/operations/${index}/path`, (error as Error).message, 'unsafe-path'); }
    if (index > 0 && plan.operations[index - 1].path >= operation.path) fail(`transaction-plan.json/operations/${index}/path`, 'transaction operations are not sorted by path', 'ordering');
    const target = desired.get(operation.path);
    if (!target) fail(`transaction-plan.json/${operation.path}`, 'transaction operation is outside reduction desired state', 'binding-mismatch');
    const current = before.get(operation.path);
    const currentHash = current?.byteSha256 ?? null;
    const currentLength = current?.byteLength ?? 0;
    if (operation.preconditionHash !== currentHash) fail(`transaction-plan.json/${operation.path}/preconditionHash`, 'transaction precondition does not match the sealed candidate snapshot', 'transaction-invalid');
    const beforeBytesLength = operation.before.bytes?.byteLength ?? 0;
    if (operation.before.exists !== (current !== undefined) || operation.before.hash !== currentHash || beforeBytesLength !== (current === undefined ? 0 : currentLength)) fail(`transaction-plan.json/${operation.path}/before`, 'transaction before-state is not the sealed candidate state', 'binding-mismatch');
    if (target.action === 'unchanged') fail(`transaction-plan.json/${operation.path}`, 'unchanged reduction target must not have a transaction operation', 'transaction-invalid');
    if (target.action === 'create' && operation.kind !== 'create') fail(`transaction-plan.json/${operation.path}/kind`, 'create target has a non-create operation', 'transaction-invalid');
    if (target.action === 'replace' && operation.kind !== 'replace') fail(`transaction-plan.json/${operation.path}/kind`, 'replace target has a non-replace operation', 'transaction-invalid');
    if (!operation.after.exists || operation.after.hash !== target.desiredSha256 || operation.after.bytes === null || sha256Hex(new TextDecoder('utf-8', { fatal: true }).decode(operation.after.bytes)) !== target.desiredSha256) fail(`transaction-plan.json/${operation.path}/after`, 'transaction after-state does not match reduction desired bytes', 'binding-mismatch');
  }
  for (const target of reduction.desiredState) {
    const current = before.get(target.path);
    const changed = current?.byteSha256 !== target.desiredSha256 || current?.byteLength !== new TextEncoder().encode(target.content).byteLength;
    const operation = operations.get(target.path);
    if (target.action === 'unchanged') {
      if (changed || operation !== undefined || target.currentSha256 !== target.desiredSha256) fail(`reduction-plan.json/desiredState/${target.path}`, 'unchanged target is not byte-identical and operation-free', 'transaction-invalid');
    } else if (!changed || operation === undefined) {
      fail(`transaction-plan.json/${target.path}`, 'transaction coverage does not exactly match changed reduction targets', 'transaction-invalid');
    }
    if (target.currentSha256 !== undefined && target.currentSha256 !== (current?.byteSha256 ?? null)) fail(`reduction-plan.json/desiredState/${target.path}/currentSha256`, 'reduction current hash differs from sealed candidate snapshot', 'binding-mismatch');
  }
}

async function verifyJournal(directory: string, plan: TransactionPlan, receipt: RecordValue): Promise<{ readonly events: readonly JournalEvent[]; readonly sha256: string }> {
  const pathName = 'transaction-journal.jsonl';
  const bytes = readBytes(directory, pathName);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.length === 0 || text.split(/\r?\n/u).some((line, index, lines) => index < lines.length - 1 && line.trim() === '')) fail(pathName, 'journal contains blank lines', 'transaction-invalid');
  let events: JournalEvent[];
  try { events = await new TransactionJournal(artifactPath(directory, pathName)).read(); }
  catch (error) { fail(pathName, (error as Error).message, 'transaction-invalid'); }
  if (events.length === 0) fail(pathName, 'journal is empty', 'missing-artifact');
  const first = events[0]; const terminal = events.at(-1);
  if (!first || first.kind !== 'prepared' || !first.plan || !terminal || terminal.kind !== 'committed') fail(pathName, 'journal does not contain prepared/committed terminal chain', 'transaction-invalid');
  const cas = new Set<number>();
  const applied = new Set<number>();
  let terminalFailure = false;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || !JOURNAL_KINDS.has(event.kind) || event.transactionId !== plan.transactionId || event.fence !== plan.fence || event.planHash !== plan.planHash) fail(`${pathName}/${index}`, 'journal sequence or binding changed', 'transaction-invalid');
    if (event.kind === 'prepared' && index !== 0) fail(`${pathName}/${index}`, 'prepared event must be first', 'transaction-invalid');
    if (event.kind === 'cas-checked' || event.kind === 'applied') {
      const operationIndex = event.operationIndex;
      if (operationIndex === undefined || !Number.isSafeInteger(operationIndex) || operationIndex < 0 || operationIndex >= plan.operations.length) fail(`${pathName}/${index}/operationIndex`, 'journal operation index is invalid', 'transaction-invalid');
      if (event.kind === 'cas-checked') {
        if (cas.has(operationIndex)) fail(`${pathName}/${index}`, 'duplicate compare-and-swap event', 'transaction-invalid');
        cas.add(operationIndex);
      } else {
        if (!cas.has(operationIndex) || applied.has(operationIndex)) fail(`${pathName}/${index}`, 'applied event lacks a unique preceding compare-and-swap', 'transaction-invalid');
        applied.add(operationIndex);
      }
    }
    if (event.kind === 'commit-check-failed' || event.kind === 'readback-mismatch' || event.kind === 'apply-failed' || event.kind === 'interrupted') terminalFailure = true;
    if (event.kind === 'committed' && (terminalFailure || applied.size !== plan.operations.length)) fail(`${pathName}/${index}`, 'committed event is not preceded by all successful readback/CAS stages', 'transaction-invalid');
  }
  if (canonicalJsonSha256(comparablePlan(first.plan)) !== canonicalJsonSha256(comparablePlan(plan))) fail(`${pathName}/1/plan`, 'journal prepared plan differs from transaction plan', 'binding-mismatch');
  if (receipt.transactionId !== plan.transactionId || receipt.planHash !== plan.planHash || receipt.fence !== plan.fence || receipt.status !== 'committed' || receipt.restored !== false) fail('transaction-receipt.json', 'transaction receipt is not bound to a committed plan', 'binding-mismatch');
  return { events, sha256: sha256Hex(bytes) };
}

function verifyReplay(directory: string, options: NativeCanaryArtifactVerificationOptions, runId: string, plan: TransactionPlan, terminal: TerminalRoot): string {
  const path = artifactPath(directory, 'replay-ledger.jsonl');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(directory, 'replay-ledger.jsonl'));
  const lines = text.split(/\r?\n/u); if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some(line => line.trim() === '')) fail('replay-ledger.jsonl', 'replay ledger is empty or contains blank lines', 'replay-invalid');
  let ledger;
  try {
    ledger = verifyReplayLedgerFile(path, {
      registry: options.registry,
      requiredScope: options.replayScope ?? 'spm-brain-replay-append',
      initialCheckpointHash: ZERO_CHECKPOINT,
    });
  } catch (error) { fail('replay-ledger.jsonl', (error as Error).message, 'replay-invalid'); }
  if (ledger.entryCount === 0 || terminal.ledgerRootHash !== ledger.rootHash) fail('replay-ledger.jsonl', 'replay root is not terminal-root bound', 'replay-binding-mismatch');
  for (const [index, entry] of ledger.entries.entries()) {
    if (entry.runId !== runId || entry.fence !== plan.fence) fail(`replay-ledger.jsonl/${index}`, 'replay entry is not run/fence bound', 'binding-mismatch');
  }
  const last = ledger.entries.at(-1);
  const payload = last?.payload;
  if (!payload || typeof payload !== 'object') fail('replay-ledger.jsonl/last/payload', 'terminal replay entry has no binding payload', 'replay-invalid');
  const body = payload as RecordValue;
  if (body.run_id !== runId || body.transaction_id !== plan.transactionId || body.plan_sha256 !== plan.planHash) fail('replay-ledger.jsonl/last/payload', 'terminal replay payload is substituted', 'replay-binding-mismatch');
  return ledger.rootHash;
}

function verifyNativeReceipt(value: unknown, path: string, options: NativeCanaryArtifactVerificationOptions, runId: string, binding: NativeReferenceBinding, nativeProjection: ContractSemanticProjection): Receipt {
  const receipt = assertValidContract<Receipt>('receipt', value);
  if (receipt.receipt_type !== 'native' || receipt.status !== 'accepted' || receipt.run_id !== runId) fail(path, 'native receipt is not an accepted run-bound receipt', 'receipt-invalid');
  if (receipt.signature.signed_digest !== canonicalJsonSha256(unsigned(receipt, path))) fail(`${path}/signature/signed_digest`, 'native receipt hash is not exact', 'hash-mismatch');
  try { verifyContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, receipt.signature, options.registry, { requiredScope: options.nativeReceiptScope ?? 'spm-brain-native-reference-sign', runId }); }
  catch (error) { fail(`${path}/signature`, (error as Error).message, 'signature-invalid'); }
  const projectionSha256 = canonicalJsonSha256(nativeProjection);
  if (receipt.projection_sha256 !== projectionSha256 || receipt.projection_sha256 !== binding.projectionSha256 || receipt.receipt_id !== `native/${runId}` || receipt.target_snapshot_sha256 !== binding.afterSnapshotTreeSha256 || binding.receiptSha256 !== canonicalJsonSha256(receipt)) fail(path, 'native receipt/binding projection, snapshot, or receipt hash differs', 'binding-mismatch');
  return receipt;
}

function verifyBinding(value: unknown, path: string, options: NativeCanaryArtifactVerificationOptions, runId: string, copies: { live: CopySnapshotManifest; native: CopySnapshotManifest; candidate: CopySnapshotManifest }, policy: NativeMapPolicy, nativeProjection: ContractSemanticProjection): NativeReferenceBinding {
  const binding = record(value, path) as unknown as NativeReferenceBinding;
  if (binding.version !== 'native-reference-binding/v1' || binding.runId !== runId || binding.mode !== 'ingest') fail(path, 'native binding contract is invalid', 'binding-mismatch');
  if (!samePath(binding.liveRoot, copies.live.root) || !samePath(binding.copiedVaultRoot, copies.native.root)) fail(path, 'native binding roots differ from sealed copies', 'binding-mismatch');
  if (options.expectedLiveRoot !== undefined && !samePath(binding.liveRoot, options.expectedLiveRoot)) fail(`${path}/liveRoot`, 'native binding live root differs from expected', 'binding-mismatch');
  if (options.expectedNativeRoot !== undefined && !samePath(binding.copiedVaultRoot, options.expectedNativeRoot)) fail(`${path}/copiedVaultRoot`, 'native binding native root differs from expected', 'binding-mismatch');
  if (options.expectedArtifactRoot !== undefined && !samePath(binding.artifactRoot, options.expectedArtifactRoot)) fail(`${path}/artifactRoot`, 'native binding artifact root differs from expected', 'binding-mismatch');
  digest(binding.sourceInventorySha256, `${path}/sourceInventorySha256`);
  const provider = record(binding.provider, `${path}/provider`);
  nonEmpty(provider.provider, `${path}/provider/provider`);
  nonEmpty(provider.model, `${path}/provider/model`);
  digest(provider.authorizationRefSha256, `${path}/provider/authorizationRefSha256`);
  if (options.sourceInventory && binding.sourceInventorySha256 !== options.sourceInventory.inventorySha256) fail(`${path}/sourceInventorySha256`, 'native binding source inventory differs', 'binding-mismatch');
  if (!Array.isArray(binding.sourceIdentities) || new Set(binding.sourceIdentities).size !== binding.sourceIdentities.length) fail(`${path}/sourceIdentities`, 'native source identity set is invalid', 'coverage');
  if (options.sourceInventory && (binding.sourceIdentities.length !== options.sourceInventory.sources.length || options.sourceInventory.sources.some(source => !binding.sourceIdentities.includes(source.sourceIdentity)))) fail(`${path}/sourceIdentities`, 'native binding does not cover the inventory', 'coverage');
  if (binding.beforeSnapshotTreeSha256 !== copies.native.treeSha256) fail(`${path}/beforeSnapshotTreeSha256`, 'native binding before snapshot is substituted', 'hash-mismatch');
  digest(binding.afterSnapshotTreeSha256, `${path}/afterSnapshotTreeSha256`);
  if (binding.projectionSha256 !== canonicalJsonSha256(nativeProjection)) fail(`${path}/projectionSha256`, 'native binding projection hash differs', 'hash-mismatch');
  if (options.expectedProvider && (provider.provider !== options.expectedProvider.provider || provider.model !== options.expectedProvider.model || (options.expectedProvider.authorizationRefSha256 !== undefined && provider.authorizationRefSha256 !== options.expectedProvider.authorizationRefSha256))) fail(`${path}/provider`, 'native provider identity differs from expected', 'binding-mismatch');
  const settings = record(binding.settings, `${path}/settings`);
  if (!DIGEST.test(String(settings.fullSha256)) || !DIGEST.test(String(settings.safeProjectionSha256))) fail(`${path}/settings`, 'native settings hashes are invalid', 'digest');
  void policy;
  return binding;
}

function verifyCanaryBinding(value: unknown, path: string, options: NativeCanaryArtifactVerificationOptions, runId: string, windowId: string, copies: { live: CopySnapshotManifest; native: CopySnapshotManifest; candidate: CopySnapshotManifest }, policy: NativeMapPolicy): CanaryBinding {
  const binding = record(value, path) as unknown as CanaryBinding;
  if (binding.version !== 'native-canary-binding/v1' || binding.runId !== runId || binding.windowId !== windowId) fail(path, 'canary binding version or identity is invalid', 'binding-mismatch');
  const authority = record(binding.authority, `${path}/authority`);
  const repositoryUrl = nonEmpty(authority.repositoryUrl, `${path}/authority/repositoryUrl`);
  const commit = nonEmpty(authority.commit, `${path}/authority/commit`);
  const tree = nonEmpty(authority.tree, `${path}/authority/tree`);
  if (options.expectedAuthority && ((options.expectedAuthority.repositoryUrl !== undefined && repositoryUrl !== options.expectedAuthority.repositoryUrl) || (options.expectedAuthority.commit !== undefined && commit !== options.expectedAuthority.commit) || tree !== options.expectedAuthority.tree)) fail(`${path}/authority`, 'authority repository, commit, or tree differs from expected', 'binding-mismatch');
  digest(binding.sourceInventorySha256, `${path}/sourceInventorySha256`);
  if (options.sourceInventory && binding.sourceInventorySha256 !== options.sourceInventory.inventorySha256) fail(`${path}/sourceInventorySha256`, 'canary source inventory differs from expected inventory', 'binding-mismatch');
  if (!samePath(binding.liveRoot, copies.live.root) || !samePath(binding.nativeRoot, copies.native.root) || !samePath(binding.candidateRoot, copies.candidate.root)) fail(path, 'canary binding roots differ from sealed copy manifests', 'binding-mismatch');
  if (options.expectedLiveRoot && !samePath(binding.liveRoot, options.expectedLiveRoot)) fail(`${path}/liveRoot`, 'canary live root differs from expected', 'binding-mismatch');
  if (options.expectedNativeRoot && !samePath(binding.nativeRoot, options.expectedNativeRoot)) fail(`${path}/nativeRoot`, 'canary native root differs from expected', 'binding-mismatch');
  if (options.expectedCandidateRoot && !samePath(binding.candidateRoot, options.expectedCandidateRoot)) fail(`${path}/candidateRoot`, 'canary candidate root differs from expected', 'binding-mismatch');
  if (options.expectedArtifactRoot && !samePath(binding.artifactRoot, options.expectedArtifactRoot)) fail(`${path}/artifactRoot`, 'canary artifact root differs from expected', 'binding-mismatch');
  if (binding.policySha256 !== policy.policySha256) fail(`${path}/policySha256`, 'canary policy differs from map policy', 'binding-mismatch');
  const provider = record(binding.provider, `${path}/provider`);
  const providerName = nonEmpty(provider.provider, `${path}/provider/provider`);
  const model = nonEmpty(provider.model, `${path}/provider/model`);
  const authorizationRefSha256 = digest(provider.authorizationRefSha256, `${path}/provider/authorizationRefSha256`);
  if (options.expectedProvider && (providerName !== options.expectedProvider.provider || model !== options.expectedProvider.model || (options.expectedProvider.authorizationRefSha256 !== undefined && authorizationRefSha256 !== options.expectedProvider.authorizationRefSha256))) fail(`${path}/provider`, 'canary provider differs from expected provider', 'binding-mismatch');
  return binding;
}

function verifyInventoryAgainstSnapshot(inventory: SourceInventory, snapshot: CopySnapshotManifest, path: string): void {
  const entries = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  for (const [index, source] of inventory.sources.entries()) {
    const entry = entries.get(source.path);
    if (!entry || entry.byteLength !== source.byteLength || entry.byteSha256 !== source.byteSha256) fail(`${path}/${index}`, 'sealed copy bytes differ from authority source inventory', 'source-manifest-mismatch');
  }
}

/**
 * Independently verify the complete terminal artifact set produced by the
 * native-vs-candidate canary. Every stage is checked against exact bytes and
 * cross-bound to the same run, source inventory, copy roots, transaction, and
 * terminal Merkle root. The verifier is strictly read-only.
 */
export async function independentlyVerifyNativeCanaryArtifacts(options: NativeCanaryArtifactVerificationOptions): Promise<VerifiedNativeCanaryArtifacts> {
  const directory = resolve(options.directory);
  const artifactBytes = collectArtifactFiles(directory);
  if (options.expectedLiveRoot === undefined || options.expectedNativeRoot === undefined || options.expectedCandidateRoot === undefined || options.expectedArtifactRoot === undefined || options.liveRoot === undefined) {
    fail('verification-options', 'independent canary verification requires live, native, candidate, native-artifact, and live-readback roots', 'missing-authority');
  }
  let rootBindings: readonly RootBinding[];
  try {
    rootBindings = await Promise.all([
      captureRootBinding(options.liveRoot, {}, 'live root'),
      captureRootBinding(options.expectedNativeRoot, {}, 'native root'),
      captureRootBinding(options.expectedCandidateRoot, {}, 'candidate root'),
      captureRootBinding(options.expectedArtifactRoot, {}, 'native artifact root'),
      captureRootBinding(directory, {}, 'terminal artifact root'),
    ]);
  } catch (error) { fail('verification-options', (error as Error).message, 'unsafe-root'); }
  const liveEntry = { value: parseJsonBytes<RecordValue>(bytesFor(artifactBytes, 'live-idle-observation.json'), 'live-idle-observation.json'), bytes: bytesFor(artifactBytes, 'live-idle-observation.json') };
  const terminalEntry = { value: parseJsonBytes<RecordValue>(bytesFor(artifactBytes, 'live-terminal-observation.json'), 'live-terminal-observation.json'), bytes: bytesFor(artifactBytes, 'live-terminal-observation.json') };
  const copiesEntry = { value: parseJsonBytes<RecordValue>(bytesFor(artifactBytes, 'copy-manifests.json'), 'copy-manifests.json'), bytes: bytesFor(artifactBytes, 'copy-manifests.json') };
  const nativeProjectionEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'native-projection.json'), 'native-projection.json'), bytes: bytesFor(artifactBytes, 'native-projection.json') };
  const policyEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'map-policy.json'), 'map-policy.json'), bytes: bytesFor(artifactBytes, 'map-policy.json') };
  const mapEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'map-ir.json'), 'map-ir.json'), bytes: bytesFor(artifactBytes, 'map-ir.json') };
  const reductionEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'reduction-plan.json'), 'reduction-plan.json'), bytes: bytesFor(artifactBytes, 'reduction-plan.json') };
  const candidateProjectionEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'candidate-projection.json'), 'candidate-projection.json'), bytes: bytesFor(artifactBytes, 'candidate-projection.json') };
  const candidateSnapshotEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'candidate-snapshot.json'), 'candidate-snapshot.json'), bytes: bytesFor(artifactBytes, 'candidate-snapshot.json') };
  const comparisonEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'semantic-comparison.json'), 'semantic-comparison.json'), bytes: bytesFor(artifactBytes, 'semantic-comparison.json') };
  const transactionPlanEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'transaction-plan.json'), 'transaction-plan.json'), bytes: bytesFor(artifactBytes, 'transaction-plan.json') };
  const transactionReceiptEntry = { value: parseJsonBytes<RecordValue>(bytesFor(artifactBytes, 'transaction-receipt.json'), 'transaction-receipt.json'), bytes: bytesFor(artifactBytes, 'transaction-receipt.json') };
  const nativeBindingEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'native-binding.json'), 'native-binding.json'), bytes: bytesFor(artifactBytes, 'native-binding.json') };
  const canaryBindingEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'canary-binding.json'), 'canary-binding.json'), bytes: bytesFor(artifactBytes, 'canary-binding.json') };
  const nativeReceiptEntry = { value: parseJsonBytes<unknown>(bytesFor(artifactBytes, 'native-receipt.json'), 'native-receipt.json'), bytes: bytesFor(artifactBytes, 'native-receipt.json') };
  const terminalRootEntry = { value: parseJsonBytes<TerminalRoot>(bytesFor(artifactBytes, 'terminal-run-root.json'), 'terminal-run-root.json'), bytes: bytesFor(artifactBytes, 'terminal-run-root.json') };

  const terminalRoot = terminalRootEntry.value;
  if (terminalRoot.version !== 'spm-brain/terminal-root/v1') fail('terminal-run-root.json/version', 'unsupported terminal root', 'terminal-root-invalid');
  try { verifyTerminalRoot(terminalRoot, { artifacts: terminalMerkleArtifacts(artifactBytes), registry: options.registry, requiredScope: options.terminalScope ?? 'spm-brain-run-terminalize' }); }
  catch (error) { fail('terminal-run-root.json', (error as Error).message, 'terminal-root-invalid'); }
  const runId = nonEmpty(terminalRoot.runId, 'terminal-run-root.json/runId');
  if (options.expectedRunId !== undefined && runId !== options.expectedRunId) fail('terminal-run-root.json/runId', 'run ID differs from expected', 'binding-mismatch');
  const liveObservation = validateObservation(liveEntry.value, 'live-idle-observation.json', options, runId);
  const terminalObservation = validateObservation(terminalEntry.value, 'live-terminal-observation.json', options, runId, liveObservation);
  const copiesValue = record(copiesEntry.value, 'copy-manifests.json');
  const copies = {
    live: validateSnapshot(copiesValue.live, 'copy-manifests.json/live'),
    native: validateSnapshot(copiesValue.native, 'copy-manifests.json/native'),
    candidate: validateSnapshot(copiesValue.candidate, 'copy-manifests.json/candidate'),
  } as const;
  verifyInventoryAgainstSnapshot(options.sourceInventory ?? fail('sourceInventory', 'source inventory is required', 'missing-authority'), copies.live, 'copy-manifests.json/live/source-inventory');
  verifyInventoryAgainstSnapshot(options.sourceInventory ?? fail('sourceInventory', 'source inventory is required', 'missing-authority'), copies.native, 'copy-manifests.json/native/source-inventory');
  verifyInventoryAgainstSnapshot(options.sourceInventory ?? fail('sourceInventory', 'source inventory is required', 'missing-authority'), copies.candidate, 'copy-manifests.json/candidate/source-inventory');
  if (!samePath(copies.live.root, String(liveObservation.liveRoot)) || samePath(copies.live.root, copies.native.root) || samePath(copies.live.root, copies.candidate.root) || samePath(copies.native.root, copies.candidate.root)) fail('copy-manifests.json', 'copy roots are not distinct and observation-bound', 'unsafe-root');
  compareSnapshotsExact(copies.native, copies.candidate, 'copy-manifests.json/native-candidate');
  if (options.expectedNativeRoot !== undefined && !samePath(copies.native.root, options.expectedNativeRoot)) fail('copy-manifests.json/native/root', 'native root differs from expected', 'binding-mismatch');
  if (options.expectedCandidateRoot !== undefined && !samePath(copies.candidate.root, options.expectedCandidateRoot)) fail('copy-manifests.json/candidate/root', 'candidate root differs from expected', 'binding-mismatch');
  const policy = verifyPolicy(policyEntry.value, 'map-policy.json');
  const nativeProjection = validateProjection(nativeProjectionEntry.value, 'native-projection.json', runId);
  const candidateProjection = validateProjection(candidateProjectionEntry.value, 'candidate-projection.json', runId);
  if (options.sourceInventory === undefined) fail('sourceInventory', 'independent canary verification requires the exact authority source inventory', 'missing-authority');
  verifyExpectedInventory(options.sourceInventory, options.expectedAuthority);
  const mapIR = verifyMapIR(mapEntry.value, 'map-ir.json', policy, options, runId);
  const reduction = verifyReduction(reductionEntry.value, 'reduction-plan.json', mapIR, policy);
  const nativeBinding = verifyBinding(nativeBindingEntry.value, 'native-binding.json', options, runId, copies, policy, nativeProjection);
  verifyCanaryBinding(canaryBindingEntry.value, 'canary-binding.json', options, runId, String(liveObservation.windowId), copies, policy);
  const nativeReceipt = verifyNativeReceipt(nativeReceiptEntry.value, 'native-receipt.json', options, runId, nativeBinding, nativeProjection);
  const transactionPlan = decodePlan(transactionPlanEntry.value);
  verifyTransactionCoverage(transactionPlan, reduction, copies.candidate);
  const desiredByPath = new Map(reduction.desiredState.map(file => [file.path, file]));
  for (const operation of transactionPlan.operations) {
    const desired = desiredByPath.get(operation.path);
    if (!desired) fail(`transaction-plan.json/${operation.path}`, 'transaction target is absent from reduction desired state', 'binding-mismatch');
    if (operation.after.exists && (desired.desiredSha256 !== operation.after.hash || desired.content !== new TextDecoder('utf-8', { fatal: true }).decode(operation.after.bytes ?? new Uint8Array()))) fail(`transaction-plan.json/${operation.path}`, 'transaction after-state differs from reduction desired content', 'binding-mismatch');
  }
  const candidateSnapshot = validateSnapshot(candidateSnapshotEntry.value, 'candidate-snapshot.json');
  if (!samePath(candidateSnapshot.root, copies.candidate.root)) fail('candidate-snapshot.json/root', 'candidate snapshot root differs from candidate copy', 'binding-mismatch');
  verifyCandidatePostState(copies.candidate, candidateSnapshot, transactionPlan);
  const journal = await verifyJournal(directory, transactionPlan, transactionReceiptEntry.value);
  const comparison = comparisonEntry.value as SemanticComparisonResult;
  const recomputedComparison = compareNativeCandidate({ native: nativeProjection, candidate: candidateProjection, requiredSourcePaths: mapIR.map(ir => ir.source.sourcePath) });
  if (!recomputedComparison.accepted || canonicalJsonSha256(comparison) !== canonicalJsonSha256(recomputedComparison)) fail('semantic-comparison.json', 'stored semantic comparison is substituted or not accepted', 'comparison-invalid');
  const replayLedgerRootSha256 = verifyReplay(directory, options, runId, transactionPlan, terminalRoot);
  if (terminalRoot.manifestHash !== undefined && !DIGEST.test(terminalRoot.manifestHash)) fail('terminal-run-root.json/manifestHash', 'terminal manifest hash is invalid', 'hash-mismatch');
  let liveUnchanged = false;
  try {
    const [actualLive, actualNative, actualCandidate] = await Promise.all([
      captureSnapshot({ root: options.liveRoot, exclusions: copies.live.exclusions }),
      captureSnapshot({ root: options.expectedNativeRoot, exclusions: copies.native.exclusions }),
      captureSnapshot({ root: options.expectedCandidateRoot, exclusions: copies.candidate.exclusions }),
    ]);
    compareSnapshotsExact(copies.live, actualLive, 'live-root');
    compareSnapshotsExact(copies.native, actualNative, 'native-root');
    compareSnapshotsExact(candidateSnapshot, actualCandidate, 'candidate-root');
    liveUnchanged = true;
  } catch (error) { fail('live-root', (error as Error).message, 'live-drift'); }
  try { for (const binding of rootBindings) await assertRootBindingUnchanged(binding, {}, `verification root ${binding.resolved}`); }
  catch (error) { fail('verification-roots', (error as Error).message, 'unsafe-root'); }
  assertArtifactSnapshotUnchanged(directory, artifactBytes);
  return {
    ok: true,
    runId,
    directory,
    terminalRoot,
    liveObservation,
    terminalObservation,
    copies,
    nativeReceipt,
    nativeBinding,
    nativeProjection,
    mapPolicy: policy,
    mapIR,
    reduction,
    candidateProjection,
    candidateSnapshot,
    comparison: recomputedComparison,
    transactionPlan,
    transactionReceipt: transactionReceiptEntry.value,
    transactionJournalSha256: journal.sha256,
    replayLedgerRootSha256,
    liveUnchanged,
  };
}

export const verifyNativeCanaryArtifacts = independentlyVerifyNativeCanaryArtifacts;
export const verifyNativeCanaryArtifactDirectory = independentlyVerifyNativeCanaryArtifacts;
