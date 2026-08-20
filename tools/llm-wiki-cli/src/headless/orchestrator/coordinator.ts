import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve as resolvePath, sep } from 'node:path';

import {
  DOMAINS,
  ReplayLedger,
  createContractSignature,
  createSignedEnvelope,
  createTerminalRoot,
  digestHex,
  hashCanonical,
  publicKeyBase64,
  verifyContractSignature,
  type JsonValue,
  type SignedEnvelope,
} from '../crypto';
import { canonicalJsonSha256, sha256Hex } from '../preflight/hashing';
import {
  capturePreflightCapture,
  capturePreflightManifest,
} from '../preflight/manifest';
import { assertSafeCopyRoots, pathsOverlap, resolveSafeRoot, type SafeCopyRoots } from '../preflight/roots';
import { toContractSourceInventory } from '../preflight/source-inventory';
import { copySnapshot } from '../copy-snapshot';
import { independentlyVerifyRunArtifacts } from '../verification';
import {
  canonicalKeyId,
  claimId,
  createContractSemanticProjection,
  evidenceId,
  pageStatementId,
  projectionEdgeId,
  sourceIdentity,
  sourceNodeId,
} from '../provenance';
import { NORMALIZATION_VERSION as PROVENANCE_NORMALIZATION_VERSION } from '../provenance/vocab';
import type { ProjectionEdge, ProjectionNode, ContractSemanticProjection } from '../provenance';
import {
  BOILERPLATE_POLICY_HASH,
  parseProjectionPage,
  type PageStatement,
} from '../projection-parser';
import {
  executeMapReduce,
  type ArtifactData,
  type ContractPort,
  type MapReduceInput,
  type ProvenancePort,
  type ProviderPort,
  type SourceRecord,
  type SchedulerPort,
} from '../engine';
import { FilesystemLease, type LeaseHandle } from '../lease';
import {
  createTransactionPlan,
  hashNullable,
  NodeTransactionFileSystem,
  TransactionEngine,
  type SnapshotFile,
  type StagedFile,
  type TransactionPlan,
  type TransactionReceipt,
} from '../transaction';
import { assertPreflightCaptureForExecution, validateContract, type ContractName } from '../contracts';
import type {
  CandidatePlan,
  ContractSignature,
  PreflightCapture,
  Receipt,
  RunManifest,
  SourceIdentity,
  WorkerArtifact,
} from '../contracts';
import type { SourceInventory as Inventory, SourceInventoryEntry } from '../preflight/source-inventory';
import type { ContractSemanticProjection as ContractProjection } from '../provenance/types';
import type {
  CanarySourceDescriptor,
  CorrectnessCensus,
  CopiedVaultSnapshots,
  HeadlessCanaryInput,
  HeadlessCanaryResult,
} from './types';
import { SemanticMismatchError } from './types';

const ZERO_DIGEST = '0'.repeat(64);
const DEFAULT_REPLAY_CHECKPOINT = ZERO_DIGEST;
const DEFAULT_WINDOW_ID = 'headless-window';
const OPAQUE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertOpaqueRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !OPAQUE_RUN_ID.test(runId) || runId === '.' || runId === '..') {
    throw new Error('Headless run ID must be an opaque path-safe token (letters, digits, dot, underscore, or hyphen only)');
  }
}

function normalizedPathForComparison(path: string): string {
  const normalized = resolvePath(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isResolvedWithin(root: string, child: string): boolean {
  const relativePath = relative(normalizedPathForComparison(root), normalizedPathForComparison(child));
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !relativePath.includes(`..${sep}`)
    && !relativePath.startsWith('/')
    && !relativePath.startsWith('\\');
}

function assertRootBindings(preflightRoots: SafeCopyRoots, allRoots: SafeCopyRoots): void {
  const same = (left: string, right: string) => normalizedPathForComparison(left) === normalizedPathForComparison(right);
  if (!same(preflightRoots.liveRoot.resolved, allRoots.liveRoot.resolved)
    || preflightRoots.copyRoots.length < 2
    || !same(preflightRoots.copyRoots[0].resolved, allRoots.copyRoots[0].resolved)
    || !same(preflightRoots.copyRoots[1].resolved, allRoots.copyRoots[1].resolved)) {
    throw new Error('Preflight roots are not bound to the independently resolved copy roots');
  }
}

function assertExecutionCaptureRoots(
  capture: PreflightCapture,
  allRoots: SafeCopyRoots,
): void {
  const same = (left: string, right: string) => normalizedPathForComparison(left) === normalizedPathForComparison(right);
  if (!same(capture.vault.root, allRoots.liveRoot.resolved)
    || !same(capture.copy_roots.native, allRoots.copyRoots[0].resolved)
    || !same(capture.copy_roots.candidate, allRoots.copyRoots[1].resolved)) {
    throw new Error('Execution preflight roots are not bound to the independently resolved roots');
  }
}

function assertTrustedSigner(input: HeadlessCanaryInput): void {
  const trusted = input.trustedRegistry.require(input.signer.keyId);
  if (publicKeyBase64(trusted.publicKey) !== publicKeyBase64(input.signer.publicKey)) {
    throw new Error(`Signer ${input.signer.keyId} does not match the pinned trusted registry key`);
  }
}

function assertActivationMode(input: HeadlessCanaryInput): void {
  if (input.activationMode === 'synthetic-scaffold-only') return;
  if (!input.nativeSnapshot || !input.candidateSnapshot || !input.comparison) {
    throw new Error('Native-compatible activation is fail-closed until native/candidate snapshot and comparison components are supplied');
  }
  throw new Error('Native-compatible activation is not implemented by the synthetic scaffold coordinator');
}

/**
 * Create both isolated vault copies from one stable live-root observation.
 *
 * The copy helper captures the source before each copy because it verifies
 * source drift while writing. We retain both observations and require their
 * content-addressed trees to agree before any preflight or candidate work is
 * allowed to proceed. This prevents a coordinator from accidentally using an
 * inventory hash as a vault snapshot or treating an un-copied empty root as a
 * valid candidate vault.
 */
async function createCopiedVaultSnapshots(
  input: HeadlessCanaryInput,
  allRoots: SafeCopyRoots,
): Promise<CopiedVaultSnapshots> {
  const exclusions = ['run', 'lease'] as const;
  const native = await copySnapshot({
    root: allRoots.liveRoot.resolved,
    destinationRoot: allRoots.copyRoots[0].resolved,
    exclusions,
    syncRoots: input.syncRoots,
  });
  const candidate = await copySnapshot({
    root: allRoots.liveRoot.resolved,
    destinationRoot: allRoots.copyRoots[1].resolved,
    exclusions,
    syncRoots: input.syncRoots,
  });
  if (native.source.treeSha256 !== candidate.source.treeSha256
    || native.source.manifestSha256 !== candidate.source.manifestSha256) {
    throw new Error('Live vault changed while creating the native and candidate snapshots');
  }
  if (native.destination.treeSha256 !== native.source.treeSha256
    || candidate.destination.treeSha256 !== candidate.source.treeSha256) {
    throw new Error('Copied vault snapshot does not exactly match the captured live vault');
  }
  return {
    source: native.source,
    native: native.destination,
    candidate: candidate.destination,
  };
}

function jsonValue(value: unknown): JsonValue {
  return value;
}

function assertContract<T>(name: ContractName, value: unknown): T {
  const result = validateContract<T>(name, value);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Invalid ${name} contract: ${detail}`);
  }
  return result.data;
}

function requireScope(input: HeadlessCanaryInput, scope: string): void {
  const trusted = input.trustedRegistry.require(input.signer.keyId);
  if (!trusted.scopes.includes(scope)) {
    throw new Error(`Signer ${input.signer.keyId} lacks required scope ${scope}`);
  }
}

function digestBody(domain: (typeof DOMAINS)[keyof typeof DOMAINS], body: unknown): string {
  return digestHex(hashCanonical(domain, jsonValue(body)));
}

function signContract<T extends Record<string, unknown>>(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  body: T,
  signer: HeadlessCanaryInput['signer'],
): ContractSignature {
  const digest = digestBody(domain, body);
  return createContractSignature(domain, digest, signer);
}

function signerEnvelope<T extends JsonValue>(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  body: T,
  signer: HeadlessCanaryInput['signer'],
): SignedEnvelope<T> {
  return createSignedEnvelope(domain, body, signer);
}

function signedPreflightCapture(
  input: HeadlessCanaryInput,
  raw: Awaited<ReturnType<typeof capturePreflightCapture>>,
  allRoots: SafeCopyRoots,
): PreflightCapture {
  requireScope(input, 'spm-brain-preflight-sign');
  const rootCheckBody = {
    status: 'verified' as const,
    verifier_id: input.signer.keyId,
    verified_at: raw.captured_at,
    max_age_seconds: 60,
    live_root: raw.vault.root,
    copy_roots: raw.copy_roots,
    containment_checked: true as const,
  };
  const rootCheck = {
    ...rootCheckBody,
    signed_digest: digestBody(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, rootCheckBody),
    signature: signContract(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, rootCheckBody, input.signer),
  };
  const captureBody = { ...raw, root_check: rootCheck };
  const capture = {
    ...captureBody,
    signature: signContract(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, captureBody, input.signer),
  };
  assertExecutionCaptureRoots(capture as PreflightCapture, allRoots);
  verifyContractSignature(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, rootCheck.signature, input.trustedRegistry, { runId: input.runId });
  verifyContractSignature(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, capture.signature, input.trustedRegistry, { runId: input.runId });
  return assertPreflightCaptureForExecution<PreflightCapture>(capture, {
    now: new Date(input.now?.() ?? Date.now()),
    maxAgeSeconds: 60,
    verifyContainment: value => {
      const candidate = value as { vault?: { root?: unknown }; copy_roots?: { native?: unknown; candidate?: unknown }; root_check?: { copy_roots?: { native?: unknown; candidate?: unknown } } };
      const live = candidate.vault?.root;
      const copies = candidate.copy_roots;
      return typeof live === 'string'
        && typeof copies?.native === 'string'
        && typeof copies?.candidate === 'string'
        && !pathsOverlap(live, copies.native)
        && !pathsOverlap(live, copies.candidate)
        && !pathsOverlap(copies.native, copies.candidate)
        && !pathsOverlap(allRoots.liveRoot.resolved, allRoots.copyRoots[2].resolved)
        && !pathsOverlap(allRoots.copyRoots[0].resolved, allRoots.copyRoots[2].resolved)
        && !pathsOverlap(allRoots.copyRoots[1].resolved, allRoots.copyRoots[2].resolved)
        && live === allRoots.liveRoot.resolved
        && copies.native === allRoots.copyRoots[0].resolved
        && copies.candidate === allRoots.copyRoots[1].resolved;
    },
  });
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function asUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function descriptorFor(input: HeadlessCanaryInput, source: SourceInventoryEntry): CanarySourceDescriptor {
  const explicit = input.sourceDescriptors?.get(source.path);
  if (explicit) return explicit;
  const file = basename(source.path).replace(/\.[^.]+$/u, '');
  return { pageType: 'concept', label: file || source.path };
}

function inventoryIdentity(input: HeadlessCanaryInput, source: SourceInventoryEntry): SourceIdentity {
  return {
    authority_tree: input.authority.tree,
    path: source.path,
    byte_sha256: source.byteSha256,
    source_identity_sha256: source.sourceIdentity,
    byte_count: source.byteLength,
  };
}

function createSources(input: HeadlessCanaryInput): SourceRecord[] {
  const sources: SourceRecord[] = [];
  for (const source of input.sourceInventory.sources) {
    const provided = input.sourceContents.get(source.path);
    if (provided === undefined) throw new Error(`Missing source content for ${source.path}`);
    const bytes = asBytes(provided);
    if (bytes.byteLength !== source.byteLength) {
      throw new Error(`Source byte count mismatch for ${source.path}`);
    }
    const hash = sha256Hex(bytes);
    if (hash !== source.byteSha256) {
      throw new Error(`Source byte hash mismatch for ${source.path}`);
    }
    if (sourceIdentity({ authorityTree: input.authority.tree, path: source.path, byteHash: hash }) !== source.sourceIdentity) {
      throw new Error(`Source provenance identity mismatch for ${source.path}`);
    }
    const descriptor = descriptorFor(input, source);
    if (!descriptor.label.trim()) throw new Error(`Source label is empty for ${source.path}`);
    const sourceId = source.sourceIdentity;
    sources.push({
      sourceId,
      pageType: descriptor.pageType,
      label: descriptor.label,
      content: asUtf8(bytes),
      readyAt: 0,
      laneId: `source:${sourceId}`,
    });
  }
  return sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function contractSourceIdentity(input: HeadlessCanaryInput, source: SourceRecord): SourceIdentity {
  const inventory = input.sourceInventory.sources.find(item => item.sourceIdentity === source.sourceId);
  if (!inventory) throw new Error(`Source ${source.sourceId} is not present in the authority inventory`);
  return inventoryIdentity(input, inventory);
}

function createRunManifest(
  input: HeadlessCanaryInput,
  preflightSnapshot: string,
  settingsSha256: string,
  safeSettingsProjectionSha256: string,
  contractInventory: ReturnType<typeof toContractSourceInventory>,
  sources: readonly SourceRecord[],
  fence: number,
  resolvedRoots: { readonly native: string; readonly candidate: string },
): RunManifest {
  requireScope(input, 'spm-brain-run-manifest-sign');
  const body = {
    contract_version: 'headless-ingest/v1' as const,
    run_id: input.runId,
    job_id: input.jobId,
    created_at: new Date(input.now?.() ?? Date.now()).toISOString(),
    authority: {
      repository_url: input.authority.repositoryUrl,
      commit: input.authority.commit,
      tree: input.authority.tree,
    },
    source_inventory: {
      sha256: contractInventory.inventory_sha256,
      selector_version: contractInventory.selector.version,
      exclusions: contractInventory.selector.exclusions,
    },
    sources: input.sourceInventory.sources.map(source => inventoryIdentity(input, source)),
    runtime: { engine_version: input.runtime.engineVersion, bundle_sha256: input.runtime.bundleSha256 },
    settings: {
      sha256: settingsSha256,
      safe_projection_sha256: safeSettingsProjectionSha256,
    },
    policy: {
      schema_sha256: input.runtime.schemaSha256,
      vocabulary_sha256: input.runtime.vocabularySha256,
      policy_pack_sha256: input.runtime.policyPackSha256,
      prompt_version: input.runtime.promptVersion,
      contract_version: 'headless-ingest/v1',
    },
    provider: { provider: input.providerName, model: input.model },
    target_vault: {
      snapshot_tree_sha256: preflightSnapshot,
      copy_roots: { native: resolvedRoots.native, candidate: resolvedRoots.candidate },
      writer_fence: fence,
    },
    workers: sources.map((source, index) => {
      const workerId = input.workerIds[index % input.workerIds.length];
      return {
        worker_id: workerId,
        key_id: input.signer.keyId,
        public_key: input.signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        source_identity_sha256: source.sourceId,
        allowed_partition: `source:${source.sourceId}`,
      };
    }),
    prior_replay_ledger_sha256: DEFAULT_REPLAY_CHECKPOINT,
  };
  const signature = signContract(DOMAINS.RUN_MANIFEST_SIGNATURE, body, input.signer);
  return assertContract<RunManifest>('runManifest', { ...body, signature });
}

function internalPorts(input: HeadlessCanaryInput, sourceInventory: Inventory): {
  readonly contracts: ContractPort;
  readonly provenance: ProvenancePort;
  readonly provider: ProviderPort;
  readonly scheduler: SchedulerPort;
} {
  const sourceById = new Map(sourceInventory.sources.map(source => [source.sourceIdentity, source]));
  const contracts: ContractPort = {
    assertSource: source => {
      if (!sourceById.has(source.sourceId)) throw new Error(`Engine source is not inventory-bound: ${source.sourceId}`);
      if (!source.content) throw new Error(`Engine source has no content: ${source.sourceId}`);
    },
    assertArtifact: artifact => {
      if (!artifact.artifactId || !artifact.sourceId || !artifact.pageType || !artifact.label) {
        throw new Error(`Engine artifact is missing a stable identity: ${artifact.artifactId}`);
      }
      if (!sourceById.has(artifact.sourceId)) throw new Error(`Engine artifact source is not inventory-bound: ${artifact.sourceId}`);
    },
    assertPlan: plan => {
      if (!plan.complete || plan.artifacts.length === 0) throw new Error('Engine candidate plan is empty or incomplete');
      const ids = new Set(plan.artifacts.map(artifact => artifact.artifactId));
      if (ids.size !== plan.artifacts.length) throw new Error('Engine candidate plan contains duplicate artifacts');
    },
  };
  const provenance: ProvenancePort = {
    sourceRef: source => ({ sourceId: source.sourceId, sourceIdentity: source.sourceId }),
    artifactRef: artifact => ({ artifactId: artifact.artifactId, sourceId: artifact.sourceId }),
  };
  if (!input.scheduler) {
    throw new Error('Headless coordinator requires an injected scheduler; implicit Promise.all concurrency is forbidden');
  }
  return { contracts, provenance, provider: input.provider, scheduler: input.scheduler };
}

function artifactContent(artifact: ArtifactData): string {
  const content = artifact.data.content ?? artifact.data.body;
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return asUtf8(content);
  return JSON.stringify(artifact.data, Object.keys(artifact.data).sort()) ?? '';
}

function targetPath(artifact: ArtifactData): string {
  const label = (artifact.normalizedLabel ?? artifact.label).normalize('NFKC').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!label) throw new Error(`Artifact ${artifact.artifactId} has no safe target label`);
  return `headless-generated/${artifact.pageType}/${label}-${artifact.artifactId.slice(0, 12)}.md`;
}

function artifactClaims(artifact: ArtifactData): unknown[] {
  const claims = artifact.data.claims;
  return Array.isArray(claims) ? claims : [];
}

interface ProjectionBuildInput {
  readonly runId: string;
  readonly input: HeadlessCanaryInput;
  readonly sources: readonly SourceRecord[];
  readonly pages: ReadonlyMap<string, readonly ProjectionPage[]>;
}

interface ProjectionPage {
  readonly content: string;
  readonly pageType: string;
  readonly label: string;
}

function buildProjection(build: ProjectionBuildInput): ContractProjection {
  const nodes = new Map<string, ProjectionNode>();
  const edges = new Map<string, ProjectionEdge>();
  const parserHashes: string[] = [];
  const inventoryById = new Map(build.input.sourceInventory.sources.map(source => [source.sourceIdentity, source]));
  for (const source of build.sources) {
    const inventory = inventoryById.get(source.sourceId);
    if (!inventory) throw new Error(`Projection source is not inventory-bound: ${source.sourceId}`);
    const pages = build.pages.get(source.sourceId);
    if (pages === undefined || pages.length === 0) throw new Error(`Projection page content missing for ${source.sourceId}`);
    const sourceNode = sourceNodeId({ authorityTree: build.input.authority.tree, path: inventory.path, byteHash: inventory.byteSha256 });
    nodes.set(sourceNode, {
      nodeType: 'source', id: sourceNode,
      authorityTree: build.input.authority.tree,
      normalizedPath: inventory.path,
      byteHash: inventory.byteSha256,
    });
    for (const page of pages) {
      const parsed = parseProjectionPage(page.content);
      parserHashes.push(parsed.sourceHash);
      const normalizedLabel = page.label.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
      const key = canonicalKeyId({ pageType: page.pageType, normalizedLabel, normalizationVersion: PROVENANCE_NORMALIZATION_VERSION });
      nodes.set(key, {
        nodeType: 'canonical-key', id: key,
        pageType: page.pageType,
        normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
        normalizedLabel,
      });
      for (const statement of parsed.statements) {
      const statementKind = statement.statementKind === 'paragraph' ? 'paragraph' : statement.statementKind;
      const reason = statementKind === 'heading' ? 'defines-scope' : 'direct-quote';
      const evidence = evidenceId({
        kind: statementKind === 'paragraph' ? 'quote' : statementKind === 'list-item' || statementKind === 'table-cell' || statementKind === 'heading' ? statementKind : 'quote',
        reason,
        authorityTree: build.input.authority.tree,
        normalizedPath: inventory.path,
        originalSourceHash: inventory.byteSha256,
        canonicalSourceHash: parsed.sourceHash,
        byteRange: { start: statement.startByte, end: statement.endByte },
        exactCanonicalBytes: statement.canonicalText,
        normalizationVersion: parsed.normalizationVersion,
      });
      const claim = claimId({
        subjectKey: { page_type: page.pageType, normalized_label: normalizedLabel },
        predicate: 'statement',
        object: statement.canonicalText,
        evidenceIds: [evidence],
      });
      const statementNodeId = pageStatementId({
        canonicalKeyId: key,
        sectionPath: statement.sectionPath,
        statementKind,
        ordinal: statement.ordinal,
        canonicalTextHash: sha256Hex(statement.canonicalText),
      });
      nodes.set(claim, {
        nodeType: 'claim', id: claim,
        subjectKey: { page_type: page.pageType, normalized_label: normalizedLabel },
        predicate: 'statement', object: statement.canonicalText, disposition: 'evidenced',
      });
      nodes.set(statementNodeId, {
        nodeType: 'page-statement', id: statementNodeId,
        canonicalKeyId: key,
        sectionPath: statement.sectionPath,
        statementKind,
        ordinal: statement.ordinal,
        canonicalTextHash: sha256Hex(statement.canonicalText),
      });
      const evidenceEdge = {
        edgeKind: 'evidences' as const,
        sourceId: sourceNode,
        targetId: claim,
        payload: { evidence_ids: [evidence] },
      };
      const renderEdge = {
        edgeKind: 'renders' as const,
        sourceId: claim,
        targetId: statementNodeId,
        payload: { render_role: 'supports' },
      };
      const evidenceEdgeWithId = { ...evidenceEdge, id: projectionEdgeId(evidenceEdge) };
      const renderEdgeWithId = { ...renderEdge, id: projectionEdgeId(renderEdge) };
        edges.set(evidenceEdgeWithId.id, evidenceEdgeWithId);
        edges.set(renderEdgeWithId.id, renderEdgeWithId);
      }
    }
  }
  const parserHash = sha256Hex(parserHashes.sort().join('\n'));
  return createContractSemanticProjection({
    runId: build.runId,
    parser: {
      version: 'projection-parser/v1',
      source_sha256: parserHash,
      grammar_sha256: parseProjectionPage('').grammarHash,
      unicode_sha256: parseProjectionPage('').unicodeHash,
      boilerplate_policy_sha256: BOILERPLATE_POLICY_HASH,
    },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  });
}

function projectionIds(projection: ContractSemanticProjection): string[] {
  return projection.nodes.filter(node => node.type === 'page-statement').map(node => node.id).sort();
}

function census(source: ContractSemanticProjection, candidate: ContractSemanticProjection): CorrectnessCensus {
  const sourceStatementIds = projectionIds(source);
  const candidateStatementIds = projectionIds(candidate);
  const candidateSet = new Set(candidateStatementIds);
  const sourceSet = new Set(sourceStatementIds);
  const matchedStatementIds = sourceStatementIds.filter(id => candidateSet.has(id));
  const missingStatementIds = sourceStatementIds.filter(id => !candidateSet.has(id));
  const extraStatementIds = candidateStatementIds.filter(id => !sourceSet.has(id));
  const sourceClaimCount = source.nodes.filter(node => node.type === 'claim').length;
  const candidateClaimCount = candidate.nodes.filter(node => node.type === 'claim').length;
  return {
    sourceStatementIds,
    candidateStatementIds,
    matchedStatementIds,
    missingStatementIds,
    extraStatementIds,
    sourceClaimCount,
    candidateClaimCount,
    semanticEquivalent: missingStatementIds.length === 0 && extraStatementIds.length === 0,
  };
}

function buildWorkerArtifacts(
  input: HeadlessCanaryInput,
  sources: readonly SourceRecord[],
  plan: { readonly artifacts: readonly ArtifactData[] },
): WorkerArtifact[] {
  requireScope(input, 'spm-brain-worker-artifact-sign');
  const bySource = new Map<string, ArtifactData[]>();
  for (const artifact of plan.artifacts) {
    const list = bySource.get(artifact.sourceId) ?? [];
    list.push(artifact);
    bySource.set(artifact.sourceId, list);
  }
  return sources.map((source, index) => {
    const inventory = input.sourceInventory.sources.find(item => item.sourceIdentity === source.sourceId);
    if (!inventory) throw new Error(`Worker artifact source is not in inventory: ${source.sourceId}`);
    const artifacts = bySource.get(source.sourceId) ?? [];
    const claims = artifacts.flatMap(artifactClaims);
    const body = {
      contract_version: 'headless-ingest/v1' as const,
      run_id: input.runId,
      job_id: input.jobId,
      worker_id: input.workerIds[index % input.workerIds.length],
      provider: input.providerName,
      model: input.model,
      started_at: new Date(input.now?.() ?? Date.now()).toISOString(),
      completed_at: new Date(input.now?.() ?? Date.now()).toISOString(),
      source: inventoryIdentity(input, inventory),
      summary: artifacts.map(artifactContent).join('\n'),
      proposals: {
        entities: source.pageType === 'entity' ? [source.label] : [],
        concepts: source.pageType === 'concept' ? [source.label] : [],
      },
      claims,
      attempts: [{
        attempt: 1, provider: input.providerName, model: input.model, status: 'success' as const,
        reason: 'injected-provider', delay_ms: 0, input_tokens: 0, output_tokens: 0, billed_tokens: 0, terminal: true,
      }],
      artifact_sha256: sha256Hex(JSON.stringify(artifacts.map(artifact => ({
        artifactId: artifact.artifactId, sourceId: artifact.sourceId, pageType: artifact.pageType,
        label: artifact.label, data: artifact.data,
      })).sort((left, right) => left.artifactId.localeCompare(right.artifactId)))),
      terminal_status: 'succeeded' as const,
    };
    const signature = signContract(DOMAINS.WORKER_ARTIFACT_SIGNATURE, body, input.signer);
    return assertContract<WorkerArtifact>('workerArtifact', { ...body, signature });
  });
}

function buildCandidateContractPlan(
  input: HeadlessCanaryInput,
  enginePlan: { readonly artifacts: readonly ArtifactData[] },
  transactionPlan: TransactionPlan,
  snapshotTreeSha256: string,
): CandidatePlan {
  requireScope(input, 'spm-brain-candidate-plan-sign');
  const targets = transactionPlan.operations.map(operation => ({
    path: operation.path,
    action: operation.kind,
    ...(operation.kind === 'replace' || operation.kind === 'delete' ? { expected_sha256: operation.preconditionHash ?? undefined } : {}),
    ...(operation.after.exists ? {
      content_sha256: operation.after.hash ?? undefined,
      content_bytes: asUtf8(operation.after.bytes ?? new Uint8Array()),
    } : {}),
  }));
  const body = {
    contract_version: 'headless-ingest/v1' as const,
    run_id: input.runId,
    fence: Number(transactionPlan.fence),
    snapshot_tree_sha256: snapshotTreeSha256,
    targets,
    plan_sha256: transactionPlan.planHash,
  };
  void enginePlan;
  const signature = signContract(DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, body, input.signer);
  return assertContract<CandidatePlan>('candidatePlan', { ...body, signature });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Execute one isolated candidate canary. No branch of this function obtains a
 * live-vault writer or reads a credential store; all writes are rooted in the
 * preflight-approved candidate copy.
 */
export async function runHeadlessCanary(input: HeadlessCanaryInput): Promise<HeadlessCanaryResult> {
  assertOpaqueRunId(input.runId);
  assertActivationMode(input);
  assertTrustedSigner(input);
  if (!input.scheduler) {
    throw new Error('Headless coordinator requires an injected scheduler; implicit Promise.all concurrency is forbidden');
  }
  if (!input.idle) throw new Error('Headless canary requires an idle live runtime');
  if (input.liveRoot === input.candidateRoot || input.liveRoot === input.nativeRoot) {
    throw new Error('Headless canary refuses a live root used as a copy root');
  }
  requireScope(input, 'spm-brain-candidate-receipt-sign');
  requireScope(input, 'spm-brain-replay-append');
  requireScope(input, 'spm-brain-run-terminalize');

  // Validate the evidence root in the same containment pass as both copied
  // vaults. It is deliberately not part of either vault and will never be a
  // transaction target.
  const allRoots = await assertSafeCopyRoots({
    liveRoot: input.liveRoot,
    copyRoots: [input.nativeRoot, input.candidateRoot, input.artifactRoot],
    syncRoots: input.syncRoots,
  });
  const copySnapshots = await createCopiedVaultSnapshots(input, allRoots);

  const preflight = await capturePreflightManifest({
    authorityTree: input.authority.tree,
    sourceInventory: input.sourceInventory,
    liveRoot: input.liveRoot,
    copyRoots: [input.nativeRoot, input.candidateRoot],
    syncRoots: input.syncRoots,
    fullSettingsBytes: input.settings.fullSettingsBytes,
    settings: input.settings.value,
    snapshotEntries: copySnapshots.source.entries,
    runtimeHashes: {
      engine: input.runtime.engineVersion,
      bundle: input.runtime.bundleSha256,
      schema: input.runtime.schemaSha256,
      vocabulary: input.runtime.vocabularySha256,
      policy: input.runtime.policyPackSha256,
    },
    now: input.now?.(),
  });
  assertRootBindings(preflight.roots, allRoots);
  const preflightCaptureRaw = await capturePreflightCapture({
    captureType: 'initial',
    runId: input.runId,
    windowId: input.windowId || DEFAULT_WINDOW_ID,
    vaultIdentity: input.vaultIdentity,
    liveRoot: input.liveRoot,
    copyRoots: { native: input.nativeRoot, candidate: input.candidateRoot },
    syncRoots: input.syncRoots,
    idle: true,
    authorityCommit: input.authority.commit,
    authorityTree: input.authority.tree,
    runtimeSha256: input.runtime.bundleSha256,
    schemaSha256: input.runtime.schemaSha256,
    fullSettingsBytes: input.settings.fullSettingsBytes,
    settings: input.settings.value,
    snapshotTreeSha256: preflight.snapshotTreeHash,
    now: input.now?.(),
  });
  signedPreflightCapture(input, preflightCaptureRaw, allRoots);
  const contractSourceInventory = assertContract<ReturnType<typeof toContractSourceInventory>>('sourceInventory', toContractSourceInventory(input.sourceInventory, {
    repositoryUrl: input.authority.repositoryUrl,
    commit: input.authority.commit,
    inventoryId: `inventory-${input.runId}`,
  }));
  const sources = createSources(input);
  const ports = internalPorts(input, input.sourceInventory);
  const mapInput: MapReduceInput = {
    sources,
    workerIds: input.workerIds,
    laneIds: sources.map(source => source.laneId ?? source.sourceId),
    contracts: ports.contracts,
    provenance: ports.provenance,
    provider: ports.provider,
    scheduler: ports.scheduler,
  };
  const enginePlan = await executeMapReduce(mapInput);
  const workerArtifacts = buildWorkerArtifacts(input, sources, enginePlan);

  const safeCandidateRoot = allRoots.copyRoots[1].resolved;
  const safeArtifactRoot = allRoots.copyRoots[2].resolved;
  const requestedArtifactDirectory = join(safeArtifactRoot, input.runId);
  const leaseManager = new FilesystemLease(safeCandidateRoot, { now: input.now });
  let lease: LeaseHandle | undefined;
  let transactionPlan: TransactionPlan;
  let transactionReceipt: TransactionReceipt;
  try {
    const executionCaptureRaw = await capturePreflightCapture({
      captureType: 'live',
      runId: input.runId,
      windowId: input.windowId || DEFAULT_WINDOW_ID,
      vaultIdentity: input.vaultIdentity,
      liveRoot: input.liveRoot,
      copyRoots: { native: input.nativeRoot, candidate: input.candidateRoot },
      syncRoots: input.syncRoots,
      idle: input.idle,
      authorityCommit: input.authority.commit,
      authorityTree: input.authority.tree,
      runtimeSha256: input.runtime.bundleSha256,
      schemaSha256: input.runtime.schemaSha256,
      fullSettingsBytes: input.settings.fullSettingsBytes,
      settings: input.settings.value,
      snapshotTreeSha256: preflight.snapshotTreeHash,
      now: input.now?.(),
    });
    const executionPreflightCapture = signedPreflightCapture(input, executionCaptureRaw, allRoots);
    if (executionPreflightCapture.vault.snapshot_tree_sha256 !== preflight.snapshotTreeHash) {
      throw new Error('Execution preflight snapshot does not match the initial preflight snapshot');
    }
    await mkdir(requestedArtifactDirectory);
    const artifactRootResolution = await resolveSafeRoot(requestedArtifactDirectory);
    if (!isResolvedWithin(safeArtifactRoot, artifactRootResolution.resolved)) {
      throw new Error('Artifact directory resolved outside the preflight-approved artifact root');
    }
    const artifactDirectory = artifactRootResolution.resolved;
    await writeJson(join(artifactDirectory, 'preflight-capture.json'), executionPreflightCapture);
    lease = await leaseManager.acquire({ ownerId: `headless-coordinator:${input.signer.keyId}`, runId: input.runId });
    const activeLease = lease;
    const fileSystem = new NodeTransactionFileSystem(safeCandidateRoot);
    const desiredByPath = new Map<string, Uint8Array>();
    const targetToSource = new Map<string, string>();
    for (const artifact of enginePlan.artifacts) {
      const path = targetPath(artifact);
      if (targetToSource.has(path)) throw new Error(`Candidate target path collision: ${path}`);
      targetToSource.set(path, artifact.sourceId);
      desiredByPath.set(path, new TextEncoder().encode(artifactContent(artifact)));
    }
    const current: SnapshotFile[] = [];
    const desired: StagedFile[] = [];
    for (const [path, bytes] of [...desiredByPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      current.push({ path, bytes: await fileSystem.read(path) });
      desired.push({ path, bytes });
    }
    transactionPlan = createTransactionPlan({
      fence: lease.record.fence,
      transactionId: `tx-${input.runId}`,
      current,
      desired,
    });

    const sourcePages = new Map(sources.map(source => [source.sourceId, [{
      content: source.content,
      pageType: source.pageType,
      label: source.label,
    }]]));
    const candidatePageGroups = new Map<string, ProjectionPage[]>();
    for (const artifact of enginePlan.artifacts) {
      const pages = candidatePageGroups.get(artifact.sourceId) ?? [];
      pages.push({
        content: artifactContent(artifact),
        pageType: artifact.pageType,
        label: artifact.normalizedLabel ?? artifact.label,
      });
      candidatePageGroups.set(artifact.sourceId, pages);
    }
    const candidatePages = new Map<string, readonly ProjectionPage[]>(candidatePageGroups);
    const sourceProjection = assertContract<ContractSemanticProjection>('semanticProjection', buildProjection({ runId: input.runId, input, sources, pages: sourcePages }));
    const candidateProjection = assertContract<ContractSemanticProjection>('semanticProjection', buildProjection({ runId: input.runId, input, sources, pages: candidatePages }));
    const correctness = census(sourceProjection, candidateProjection);
    if (!correctness.semanticEquivalent) {
      throw new SemanticMismatchError(correctness);
    }
    const runManifest = createRunManifest(
      input,
      executionPreflightCapture.vault.snapshot_tree_sha256,
      executionPreflightCapture.hashes.settings_sha256,
      executionPreflightCapture.hashes.safe_settings_projection_sha256,
      contractSourceInventory,
      sources,
      lease.record.fence,
      { native: allRoots.copyRoots[0].resolved, candidate: allRoots.copyRoots[1].resolved },
    );
    const candidatePlan = buildCandidateContractPlan(input, enginePlan, transactionPlan, executionPreflightCapture.vault.snapshot_tree_sha256);

    transactionReceipt = await new TransactionEngine({
      rootDir: safeCandidateRoot,
      journalPath: join(artifactDirectory, 'transaction-journal.jsonl'),
      lease: {
        assertFence: activeLease.assertFence,
        withWriteFence: activeLease.withWriteFence,
        withFinalCommit: activeLease.withFinalCommit,
        onRollbackStart: async () => undefined,
        onRollbackComplete: async () => undefined,
        freeze: async (fence, reason) => { await activeLease.freeze(fence, reason); },
      },
      faults: input.transactionFaults,
    }).apply(transactionPlan);
    const journalBytes = await readFile(join(artifactDirectory, 'transaction-journal.jsonl'));
    const journalSha256 = sha256Hex(journalBytes);
    const projectionSha256 = canonicalJsonSha256(candidateProjection);
    const receiptBody = {
      contract_version: 'headless-ingest/v1' as const,
      receipt_id: `receipt-${input.runId}`,
      receipt_type: 'candidate' as const,
      run_id: input.runId,
      created_at: new Date(input.now?.() ?? Date.now()).toISOString(),
      status: 'accepted' as const,
      writer_fence: lease.record.fence,
      target_snapshot_sha256: executionPreflightCapture.vault.snapshot_tree_sha256,
      plan_sha256: candidatePlan.plan_sha256,
      projection_sha256: projectionSha256,
      journal_sha256: journalSha256,
      counts: {
        sources: sources.length,
        pages: enginePlan.artifacts.length,
        statements: correctness.matchedStatementIds.length,
        claims: correctness.candidateClaimCount,
        evidences: candidateProjection.edges.filter(edge => edge.type === 'evidences').length,
        edges: candidateProjection.edges.length,
        creates: transactionPlan.operations.filter(operation => operation.kind === 'create').length,
        replaces: transactionPlan.operations.filter(operation => operation.kind === 'replace').length,
        deletes: transactionPlan.operations.filter(operation => operation.kind === 'delete').length,
      },
      deltas: [],
    };
    const receipt = assertContract<Receipt>('receipt', {
      ...receiptBody,
      signature: signContract(DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, receiptBody, input.signer),
    });
    const receiptEnvelope = signerEnvelope(DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, receiptBody, input.signer);
    const ledger = new ReplayLedger(join(artifactDirectory, 'replay-ledger.jsonl'), {
      registry: input.trustedRegistry,
      requiredScope: 'spm-brain-replay-append',
      initialCheckpointHash: DEFAULT_REPLAY_CHECKPOINT,
      lockPath: join(artifactDirectory, 'replay-ledger.lock'),
    });
    ledger.append({
      runId: input.runId,
      nonce: `candidate-${input.runId}`,
      fence: lease.record.fence,
      timestamp: receipt.created_at,
      payload: { receipt_id: receipt.receipt_id, plan_sha256: candidatePlan.plan_sha256, projection_sha256: projectionSha256 },
    }, input.signer);
    await writeJson(join(artifactDirectory, 'preflight-capture.json'), executionPreflightCapture);
    await writeJson(join(artifactDirectory, 'source-inventory.json'), contractSourceInventory);
    await writeJson(join(artifactDirectory, 'run-manifest.json'), runManifest);
    await writeJson(join(artifactDirectory, 'candidate-plan.json'), candidatePlan);
    await writeJson(join(artifactDirectory, 'worker-artifacts.json'), workerArtifacts);
    await writeJson(join(artifactDirectory, 'source-projection.json'), sourceProjection);
    await writeJson(join(artifactDirectory, 'candidate-projection.json'), candidateProjection);
    await writeJson(join(artifactDirectory, 'correctness-census.json'), correctness);
    await writeJson(join(artifactDirectory, 'candidate-receipt.json'), receipt);
    await writeJson(join(artifactDirectory, 'candidate-receipt-envelope.json'), receiptEnvelope);
    await writeFile(join(artifactDirectory, 'transaction-journal.jsonl'), journalBytes);
    const terminalRoot = createTerminalRoot({
      runId: input.runId,
      directory: artifactDirectory,
      signer: input.signer,
      manifestHash: canonicalJsonSha256(runManifest),
      ledgerRootHash: ledger.rootHash(),
    });
    await writeJson(join(artifactDirectory, 'terminal-run-root.json'), terminalRoot);
    const independentVerification = independentlyVerifyRunArtifacts({
      directory: artifactDirectory,
      registry: input.trustedRegistry,
      expectedRunId: input.runId,
      requiredScopes: {
        preflight: 'spm-brain-preflight-sign',
        manifest: 'spm-brain-run-manifest-sign',
        worker: 'spm-brain-worker-artifact-sign',
        candidatePlan: 'spm-brain-candidate-plan-sign',
        candidateReceipt: 'spm-brain-candidate-receipt-sign',
        replay: 'spm-brain-replay-append',
        terminal: 'spm-brain-run-terminalize',
      },
      verifyTerminalTree: true,
    });
    return {
      activationMode: input.activationMode,
      runId: input.runId,
      preflight,
      preflightCapture: executionPreflightCapture,
      copySnapshots,
      contractSourceInventory,
      runManifest,
      sources,
      enginePlan,
      workerArtifacts,
      sourceProjection,
      candidateProjection,
      correctness,
      candidatePlan,
      transactionPlan,
      transactionReceipt,
      receipt,
      receiptEnvelope,
      terminalRoot,
      independentVerification,
      artifactDirectory,
    };
  } finally {
    if (lease) await lease.release().catch(() => undefined);
  }
}

export const executeHeadlessCanary = runHeadlessCanary;
