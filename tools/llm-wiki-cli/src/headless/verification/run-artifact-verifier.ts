import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  DOMAINS,
  KeyRegistry,
  hashCanonical,
  verifyContractSignature,
  verifyTerminalRoot,
  publicKeyBase64,
  type ContractSignature,
  type JsonValue,
  type SignedEnvelope,
  type TerminalRoot as CryptoTerminalRoot,
} from '../crypto';
import {
  assertValidContract,
  type CandidatePlan,
  type PreflightCapture,
  type Receipt,
  type RunManifest,
  type SemanticProjection,
  type SourceInventory,
  type TerminalRoot as ContractTerminalRoot,
  type WorkerArtifact,
} from '../contracts';
import { canonicalJsonSha256, sha256Hex } from '../preflight/hashing';
import {
  adjudicationNodeId,
  aliasNodeId,
  canonicalKeyId,
  claimId,
  evidenceId,
  pageStatementId,
  projectionEdgeId,
  sourceIdentity,
  sourceNodeId,
  validateContractSemanticProjection,
} from '../provenance';
import { verifyReplayLedgerFile, type ReplayLedgerVerification } from '../crypto/replay-ledger';
import {
  assertPlanHash,
  hashNullable,
  normalizeRelativePath,
  type FileState,
  type JournalEvent,
  type TransactionOperation,
  type TransactionPlan,
} from '../transaction';
import {
  terminalRootFromContract,
  verifyTerminalRootContract,
} from './terminal-root-bridge';
import {
  RunArtifactVerificationError,
  type RunArtifactVerificationResult,
  type VerifyRunArtifactsOptions,
  type VerifiedJournal,
  type VerifiedReplay,
} from './types';

type RecordValue = Record<string, unknown>;

const REQUIRED_FILES = {
  preflight: 'preflight-capture.json',
  sourceInventory: 'source-inventory.json',
  manifest: 'run-manifest.json',
  workers: 'worker-artifacts.json',
  candidatePlan: 'candidate-plan.json',
  sourceProjection: 'source-projection.json',
  candidateProjection: 'candidate-projection.json',
  receipt: 'candidate-receipt.json',
  envelope: 'candidate-receipt-envelope.json',
  terminalRoot: 'terminal-run-root.json',
} as const;

const JOURNAL_EVENT_KINDS = new Set<JournalEvent['kind']>([
  'prepared', 'cas-checked', 'applied', 'apply-failed', 'interrupted',
  'readback-mismatch', 'commit-check-failed', 'committed', 'restore-started',
  'restore-failed', 'restored', 'recovery-started', 'recovered', 'frozen',
]);

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('/', `${label} must be an object`, 'shape');
  }
  return value as RecordValue;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid('/', `${label} must be an array`, 'shape');
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalid('/', `${label} must be a lowercase 64-character SHA-256 digest`, 'digest');
  }
  return value;
}

function invalid(path: string, message: string, code = 'invalid'): RunArtifactVerificationError {
  return new RunArtifactVerificationError(`${path}: ${message}`, { code, path, message });
}

function fail(path: string, message: string, code = 'invalid'): never {
  throw invalid(path, message, code);
}

function artifactPath(directory: string, name: string): string {
  if (!name || name.includes('\0')) fail(name || '/', 'artifact path must be non-empty and NUL-free', 'unsafe-path');
  const root = resolve(directory);
  const path = resolve(root, name);
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(name, 'artifact path escapes the verified run directory', 'unsafe-path');
  }
  return path;
}

function parseJsonFile<T>(directory: string, name: string): T {
  const path = artifactPath(directory, name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(name, `required artifact is not readable: ${(error as Error).message}`, 'missing-artifact');
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    fail(name, `invalid JSON: ${(error as Error).message}`, 'malformed-json');
  }
}

function withoutSignature(value: unknown): RecordValue {
  const input = record(value, 'signed artifact');
  if (!Object.prototype.hasOwnProperty.call(input, 'signature')) fail('/signature', 'signed artifact has no signature', 'missing-signature');
  const { signature: _signature, ...body } = input;
  return body;
}

function contractSignature(value: unknown, path: string): ContractSignature {
  const signature = record(value, 'signature');
  if (signature.algorithm !== 'Ed25519') fail(`${path}/algorithm`, 'only Ed25519 signatures are supported', 'wrong-algorithm');
  return {
    key_id: String(signature.key_id),
    algorithm: 'Ed25519',
    signature: String(signature.signature),
    signed_digest: digest(signature.signed_digest, `${path}/signed_digest`),
  };
}

function verifySignedContract<T>(
  name: Parameters<typeof assertValidContract>[0],
  value: unknown,
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  registry: KeyRegistry,
  context: Parameters<typeof verifyContractSignature>[3],
): T {
  let validated: T;
  try {
    validated = assertValidContract<T>(name, value);
  } catch (error) {
    fail(String(name), (error as Error).message, 'malformed-contract');
  }
  const signature = contractSignature(record(value, name).signature, `/${name}/signature`);
  const body = withoutSignature(value) as JsonValue;
  const expected = Buffer.from(
    // hashCanonical is intentionally not used through a self-referential
    // signature object; the digest covers exactly the unsigned body.
    requireHashCanonical(domain, body),
  ).toString('hex');
  if (signature.signed_digest !== expected) {
    fail(`${name}.signature.signed_digest`, 'signature digest does not match the canonical unsigned body', 'digest-mismatch');
  }
  try {
    verifyContractSignature(domain, signature, registry, context);
  } catch (error) {
    fail(`${name}.signature`, (error as Error).message, 'signature-invalid');
  }
  return validated;
}

/* Keep the digest operation local to this verifier so no producer-provided
 * digest field can be accidentally included in the signed body. */
function requireHashCanonical(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  value: JsonValue,
): Uint8Array {
  // Imported lazily by name below to keep this helper's call sites explicit.
  return hashCanonicalForVerifier(domain, value);
}

function hashCanonicalForVerifier(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  value: JsonValue,
): Uint8Array {
  // The crypto module exports the normative domain-separated canonical hash.
  // This wrapper makes the signed-body boundary visible in code review.
  return hashCanonical(domain, value);
}

function canonicalBodyDigest(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  value: unknown,
): string {
  return Buffer.from(hashCanonicalForVerifier(domain, withoutSignature(value) as JsonValue)).toString('hex');
}

function canonicalUnsignedDigest(
  domain: (typeof DOMAINS)[keyof typeof DOMAINS],
  value: unknown,
): string {
  return Buffer.from(hashCanonicalForVerifier(domain, value)).toString('hex');
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonSha256(left) === canonicalJsonSha256(right);
  } catch {
    return false;
  }
}

function scope(options: VerifyRunArtifactsOptions, key: keyof NonNullable<VerifyRunArtifactsOptions['requiredScopes']>, fallback: string): string {
  return options.requiredScopes?.[key] ?? fallback;
}

function verifyPreflight(
  value: unknown,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): PreflightCapture {
  const capture = assertValidContract<PreflightCapture>('preflightCapture', value);
  if (!capture.idle) fail('preflight-capture.json/idle', 'run artifacts require a positively observed idle capture', 'not-idle');
  const runId = capture.run_id;
  const rootCheck = record(capture.root_check, 'root_check');
  const rootCheckSignature = contractSignature(rootCheck.signature, 'preflight-capture.json/root_check/signature');
  const rootCheckUnsigned = { ...rootCheck };
  delete rootCheckUnsigned.signature;
  const declaredRootDigest = digest(rootCheckUnsigned.signed_digest, 'root_check.signed_digest');
  delete rootCheckUnsigned.signed_digest;
  if (declaredRootDigest !== canonicalUnsignedDigest(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, rootCheckUnsigned)) {
    fail('preflight-capture.json/root_check/signed_digest', 'root-check digest does not match its unsigned body', 'digest-mismatch');
  }
  try {
    verifyContractSignature(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, rootCheckSignature, registry, {
      requiredScope: scope(options, 'preflight', 'spm-brain-preflight-sign'),
      runId,
    });
  } catch (error) {
    fail('preflight-capture.json/root_check/signature', (error as Error).message, 'signature-invalid');
  }
  const captureSignature = contractSignature(capture.signature, 'preflight-capture.json/signature');
  const unsigned = withoutSignature(capture);
  if (captureSignature.signed_digest !== canonicalBodyDigest(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, capture)) {
    fail('preflight-capture.json/signature/signed_digest', 'capture digest does not match its unsigned body', 'digest-mismatch');
  }
  try {
    verifyContractSignature(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, captureSignature, registry, {
      requiredScope: scope(options, 'preflight', 'spm-brain-preflight-sign'),
      runId,
    });
  } catch (error) {
    fail('preflight-capture.json/signature', (error as Error).message, 'signature-invalid');
  }
  // Prevent a signed but substituted root check from being accepted.
  const rootCheckCopies = record(rootCheck.copy_roots, 'root_check.copy_roots');
  const copies = record(capture.copy_roots, 'copy_roots');
  const vault = record(capture.vault, 'vault');
  if (rootCheck.live_root !== vault.root || rootCheckCopies.native !== copies.native || rootCheckCopies.candidate !== copies.candidate) {
    fail('preflight-capture.json/root_check', 'signed root-check paths do not match the capture paths', 'binding-mismatch');
  }
  void unsigned;
  return capture;
}

function verifySourceIdentitySet(
  manifest: RunManifest,
  inventory: SourceInventory,
): void {
  if (manifest.source_inventory.sha256 !== inventory.inventory_sha256) {
    fail('run-manifest.json/source_inventory/sha256', 'manifest is bound to a different source inventory', 'binding-mismatch');
  }
  if (manifest.authority.repository_url !== inventory.authority.repository_url
    || manifest.authority.commit !== inventory.authority.commit
    || manifest.authority.tree !== inventory.authority.tree) {
    fail('run-manifest.json/authority', 'manifest and source inventory authority bindings differ', 'binding-mismatch');
  }
  const manifestSources = manifest.sources;
  const inventorySources = inventory.sources;
  if (manifestSources.length !== inventorySources.length) fail('run-manifest.json/sources', 'manifest source count differs from inventory', 'coverage');
  for (let index = 0; index < manifestSources.length; index += 1) {
    const left = manifestSources[index];
    const right = inventorySources[index];
    if (left.path !== right.path || left.source_identity_sha256 !== right.source_identity_sha256
      || left.byte_sha256 !== right.byte_sha256 || left.byte_count !== right.byte_count) {
      fail(`run-manifest.json/sources/${index}`, 'manifest source identity differs from inventory', 'binding-mismatch');
    }
    let expected: string;
    try {
      expected = sourceIdentity({ authorityTree: right.authority_tree, path: right.path, byteHash: right.byte_sha256 });
    } catch (error) {
      fail(`source-inventory.json/sources/${index}`, (error as Error).message, 'provenance-invalid');
    }
    if (expected !== right.source_identity_sha256) fail(`source-inventory.json/sources/${index}/source_identity_sha256`, 'source identity digest is not reproducible', 'provenance-invalid');
  }
}

function verifyManifest(
  value: unknown,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): RunManifest {
  return verifySignedContract<RunManifest>(
    'runManifest', value, DOMAINS.RUN_MANIFEST_SIGNATURE, registry,
    { requiredScope: scope(options, 'manifest', 'spm-brain-run-manifest-sign'), runId: record(value, 'manifest').run_id as string },
  );
}

function verifyWorkerArtifacts(
  value: unknown,
  manifest: RunManifest,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): WorkerArtifact[] {
  const raw = array(value, 'worker artifacts');
  if (raw.length !== manifest.sources.length) fail('worker-artifacts.json', 'worker artifact count does not cover the manifest source set', 'coverage');
  const workersBySource = new Map(manifest.workers.map(worker => [worker.source_identity_sha256, worker]));
  const seenSources = new Set<string>();
  const output: WorkerArtifact[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const artifact = verifySignedContract<WorkerArtifact>(
      'workerArtifact', raw[index], DOMAINS.WORKER_ARTIFACT_SIGNATURE, registry,
      { requiredScope: scope(options, 'worker', 'spm-brain-worker-artifact-sign'), runId: manifest.run_id },
    );
    const sourceId = artifact.source.source_identity_sha256;
    if (seenSources.has(sourceId)) fail(`worker-artifacts.json/${index}/source`, 'duplicate worker source artifact', 'duplicate');
    seenSources.add(sourceId);
    const binding = workersBySource.get(sourceId);
    if (!binding) fail(`worker-artifacts.json/${index}/source`, 'worker source is not manifest-bound', 'binding-mismatch');
    if (artifact.run_id !== manifest.run_id || artifact.job_id !== manifest.job_id) fail(`worker-artifacts.json/${index}`, 'worker run/job binding differs from manifest', 'binding-mismatch');
    if (artifact.provider !== manifest.provider.provider || artifact.model !== manifest.provider.model) fail(`worker-artifacts.json/${index}`, 'worker provider/model differs from manifest', 'binding-mismatch');
    if (artifact.worker_id !== binding.worker_id || artifact.signature.key_id !== binding.key_id) fail(`worker-artifacts.json/${index}`, 'worker key or worker ID substitution detected', 'binding-mismatch');
    const key = registry.get(binding.key_id);
    if (!key || publicKeyBase64(key.publicKey) !== binding.public_key) fail(`run-manifest.json/workers/${binding.worker_id}`, 'manifest public key is not the trusted registry key', 'untrusted-key');
    if (binding.allowed_partition !== `source:${sourceId}`) fail(`run-manifest.json/workers/${binding.worker_id}/allowed_partition`, 'worker partition is not source-bound', 'binding-mismatch');
    try {
      verifyContractSignature(DOMAINS.WORKER_ARTIFACT_SIGNATURE, contractSignature(artifact.signature, `worker-artifacts.json/${index}/signature`), registry, {
        requiredScope: scope(options, 'worker', 'spm-brain-worker-artifact-sign'),
        runId: manifest.run_id,
        workerId: binding.worker_id,
        sourceIdentity: sourceId,
        partition: binding.allowed_partition,
        fence: manifest.target_vault.writer_fence,
      });
    } catch (error) {
      fail(`worker-artifacts.json/${index}/signature`, (error as Error).message, 'signature-invalid');
    }
    verifyWorkerClaims(artifact, `worker-artifacts.json/${index}`);
    output.push(artifact);
  }
  if (seenSources.size !== manifest.sources.length) fail('worker-artifacts.json', 'worker artifacts do not cover every source exactly once', 'coverage');
  return output;
}

function verifyWorkerClaims(artifact: WorkerArtifact, path: string): void {
  const seenClaim = new Set<string>();
  for (let claimIndex = 0; claimIndex < artifact.claims.length; claimIndex += 1) {
    const claim = artifact.claims[claimIndex];
    if (seenClaim.has(claim.claim_id)) fail(`${path}/claims/${claimIndex}/claim_id`, 'duplicate claim ID', 'duplicate');
    seenClaim.add(claim.claim_id);
    const evidenceIds: string[] = [];
    for (let evidenceIndex = 0; evidenceIndex < claim.evidence.length; evidenceIndex += 1) {
      const evidence = claim.evidence[evidenceIndex];
      const expected = evidenceIdFromContract(evidence, artifact.source.authority_tree);
      if (expected !== evidence.evidence_id) fail(`${path}/claims/${claimIndex}/evidence/${evidenceIndex}/evidence_id`, 'evidence ID is not reproducible from its exact tuple', 'provenance-invalid');
      evidenceIds.push(evidence.evidence_id);
    }
    if (claim.disposition !== 'unknown' && evidenceIds.length === 0) fail(`${path}/claims/${claimIndex}/evidence`, 'non-unknown worker claim has no evidence', 'evidence-required');
    if (evidenceIds.length > 0) {
      let expectedClaim: string;
      try {
        expectedClaim = claimId({
          subject_key: claim.subject_key,
          predicate: claim.predicate,
          object: claim.object,
          evidence_ids: evidenceIds,
        });
      } catch (error) {
        fail(`${path}/claims/${claimIndex}`, (error as Error).message, 'provenance-invalid');
      }
      if (expectedClaim !== claim.claim_id) fail(`${path}/claims/${claimIndex}/claim_id`, 'claim ID is not reproducible from its typed tuple', 'provenance-invalid');
    }
  }
}

function evidenceIdFromContract(
  evidence: WorkerArtifact['claims'][number]['evidence'][number],
  authorityTree: string,
): string {
  try {
    return evidenceId({
      kind: evidence.kind,
      reason: evidence.reason,
      authority_tree: authorityTree,
      source_path: evidence.source_path,
      original_sha256: evidence.original_sha256,
      canonical_sha256: evidence.canonical_sha256,
      byte_start: evidence.byte_start,
      byte_end: evidence.byte_end,
      exact_canonical_bytes: evidence.exact_canonical_bytes,
      normalization_version: evidence.normalization_version,
    });
  } catch (error) {
    fail('worker-artifacts.json/evidence', `evidence ID tuple is invalid: ${(error as Error).message}`, 'provenance-invalid');
  }
}

function verifyCandidatePlan(
  value: unknown,
  manifest: RunManifest,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): CandidatePlan {
  const plan = verifySignedContract<CandidatePlan>(
    'candidatePlan', value, DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, registry,
    { requiredScope: scope(options, 'candidatePlan', 'spm-brain-candidate-plan-sign'), runId: manifest.run_id, fence: manifest.target_vault.writer_fence },
  );
  if (plan.run_id !== manifest.run_id || plan.fence !== manifest.target_vault.writer_fence) fail('candidate-plan.json', 'candidate plan is not bound to the manifest run/fence', 'binding-mismatch');
  if (plan.snapshot_tree_sha256 !== manifest.target_vault.snapshot_tree_sha256) fail('candidate-plan.json/snapshot_tree_sha256', 'candidate plan snapshot differs from manifest', 'binding-mismatch');
  return plan;
}

function verifyProjection(value: unknown, path: string, runId: string): SemanticProjection {
  const projection = assertValidContract<SemanticProjection>('semanticProjection', value);
  if (projection.run_id !== runId) fail(`${path}/run_id`, 'projection is bound to a different run', 'binding-mismatch');
  let legal: { valid: boolean; errors: string[] };
  try {
    legal = validateContractSemanticProjection(projection);
  } catch (error) {
    fail(path, `projection legality check failed: ${(error as Error).message}`, 'projection-invalid');
  }
  if (!legal.valid) fail(path, legal.errors.join('; '), 'projection-invalid');
  const nodeMap = new Map(projection.nodes.map(node => [node.id, node]));
  const evidenceByClaim = new Map<string, string[]>();
  for (const edge of projection.edges) {
    if (edge.type === 'evidences') {
      const ids = edge.data.evidence_ids;
      if (Array.isArray(ids)) evidenceByClaim.set(edge.target_id, ids.map(String));
    }
    let expectedEdge: string;
    try {
      expectedEdge = projectionEdgeId({ edgeKind: edge.type, sourceId: edge.source_id, targetId: edge.target_id, payload: edge.data });
    } catch (error) {
      fail(`${path}/edges/${edge.id}`, (error as Error).message, 'provenance-invalid');
    }
    if (expectedEdge !== edge.id) fail(`${path}/edges/${edge.id}`, 'projection edge ID is not reproducible', 'provenance-invalid');
  }
  for (const node of projection.nodes) {
    let expected: string | undefined;
    try {
      const data = node.data;
      switch (node.type) {
        case 'source':
          expected = sourceNodeId({ authority_tree: String(data.authorityTree ?? data.authority_tree), path: String(data.normalizedPath ?? data.normalized_path), byte_sha256: String(data.byteHash ?? data.byte_sha256) });
          break;
        case 'canonical-key':
          expected = canonicalKeyId({ page_type: String(data.pageType ?? data.page_type), normalization_version: String(data.normalizationVersion ?? data.normalization_version), normalized_label: String(data.normalizedLabel ?? data.normalized_label) });
          break;
        case 'page-statement':
          expected = pageStatementId({ canonical_key_id: String(data.canonicalKeyId ?? data.canonical_key_id), section_path: (data.sectionPath ?? data.section_path) as string[], statement_kind: String(data.statementKind ?? data.statement_kind) as never, ordinal: Number(data.ordinal), canonical_text_hash: String(data.canonicalTextHash ?? data.canonical_text_hash) });
          break;
        case 'alias':
          expected = aliasNodeId({ normalization_version: String(data.normalizationVersion ?? data.normalization_version), normalized_alias_label: String(data.normalizedAliasLabel ?? data.normalized_alias_label), target_page_type: String(data.targetPageType ?? data.target_page_type), proposed_canonical_key_id: String(data.proposedCanonicalKeyId ?? data.proposed_canonical_key_id), evidence_ids: (data.evidenceIds ?? data.evidence_ids) as string[] });
          break;
        case 'adjudication':
          expected = adjudicationNodeId({ authority_snapshot_id: String(data.authoritySnapshotId ?? data.authority_snapshot_id), claim_ids: (data.claimIds ?? data.claim_ids) as string[], evidence_ids: (data.evidenceIds ?? data.evidence_ids) as string[], source_revision: String(data.sourceRevision ?? data.source_revision), decision_code: String(data.decisionCode ?? data.decision_code) as never, rationale_code: String(data.rationaleCode ?? data.rationale_code) as never });
          break;
        case 'claim': {
          const ids = evidenceByClaim.get(node.id);
          if (ids !== undefined) expected = claimId({ subject_key: data.subjectKey ?? data.subject_key, predicate: data.predicate, object: data.object, evidence_ids: ids });
          break;
        }
      }
    } catch (error) {
      fail(`${path}/nodes/${node.id}`, `projection node ID cannot be recomputed: ${(error as Error).message}`, 'provenance-invalid');
    }
    if (expected !== undefined && expected !== node.id) fail(`${path}/nodes/${node.id}`, 'projection node ID is not reproducible', 'provenance-invalid');
    if (!nodeMap.has(node.id)) fail(`${path}/nodes/${node.id}`, 'projection node index is inconsistent', 'projection-invalid');
  }
  return projection;
}

function decodeBase64(value: unknown, path: string): Uint8Array | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(path, 'state bytes are not strict base64', 'journal-invalid');
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) fail(path, 'state bytes use non-canonical base64', 'journal-invalid');
  return bytes;
}

function decodeState(value: unknown, path: string): FileState {
  const state = record(value, 'file state');
  if (typeof state.exists !== 'boolean') fail(`${path}/exists`, 'file-state exists must be boolean', 'journal-invalid');
  const bytes = decodeBase64(state.bytes, `${path}/bytes`);
  const hash = state.hash === null ? null : digest(state.hash, `${path}/hash`);
  if (state.exists !== (bytes !== null)) fail(path, 'file-state exists disagrees with bytes', 'journal-invalid');
  if (hashNullable(bytes) !== hash) fail(path, 'file-state hash does not match bytes', 'journal-invalid');
  return { exists: state.exists, hash, bytes };
}

function decodeTransactionPlan(value: unknown, path: string): TransactionPlan {
  const raw = record(value, 'transaction plan');
  if (raw.version !== 'transaction-plan/v1' || typeof raw.transactionId !== 'string' || raw.transactionId.length === 0) fail(path, 'unsupported transaction plan', 'journal-invalid');
  if (!(typeof raw.fence === 'number' || typeof raw.fence === 'string')) fail(`${path}/fence`, 'invalid transaction fence', 'journal-invalid');
  const rawOps = array(raw.operations, `${path}/operations`);
  const operations: TransactionOperation[] = rawOps.map((rawOperation, index) => {
    const operation = record(rawOperation, 'transaction operation');
    if (!['create', 'replace', 'delete'].includes(String(operation.kind))) fail(`${path}/operations/${index}/kind`, 'invalid operation kind', 'journal-invalid');
    let normalizedPath: string;
    try { normalizedPath = normalizeRelativePath(String(operation.path)); } catch (error) { fail(`${path}/operations/${index}/path`, (error as Error).message, 'journal-invalid'); }
    if (operation.path !== normalizedPath) fail(`${path}/operations/${index}/path`, 'transaction path is not normalized', 'journal-invalid');
    if (operation.scope !== 'page' && operation.scope !== 'global') fail(`${path}/operations/${index}/scope`, 'invalid file scope', 'journal-invalid');
    const preconditionHash = operation.preconditionHash === null ? null : digest(operation.preconditionHash, `${path}/operations/${index}/preconditionHash`);
    const before = decodeState(operation.before, `${path}/operations/${index}/before`);
    const after = decodeState(operation.after, `${path}/operations/${index}/after`);
    const kind = operation.kind as TransactionOperation['kind'];
    const expectedKind = !before.exists && after.exists ? 'create' : before.exists && after.exists ? 'replace' : before.exists && !after.exists ? 'delete' : undefined;
    if (kind !== expectedKind) fail(`${path}/operations/${index}`, 'operation kind does not describe before/after state', 'journal-invalid');
    if (preconditionHash !== before.hash) fail(`${path}/operations/${index}/preconditionHash`, 'precondition does not bind the before state', 'journal-invalid');
    return { kind, path: normalizedPath, scope: operation.scope, preconditionHash, before, after };
  });
  if (typeof raw.planHash !== 'string') fail(`${path}/planHash`, 'transaction plan hash is missing', 'journal-invalid');
  const plan: TransactionPlan = { version: 'transaction-plan/v1', transactionId: raw.transactionId, fence: raw.fence, operations, planHash: raw.planHash };
  try { assertPlanHash(plan); } catch (error) { fail(path, (error as Error).message, 'plan-hash-mismatch'); }
  return plan;
}

function verifyJournal(directory: string, manifest: RunManifest, plan: CandidatePlan, options: VerifyRunArtifactsOptions): VerifiedJournal {
  const name = options.journalPath ?? (['transaction-journal.jsonl', 'journal.jsonl'].find(candidate => {
    try { readFileSync(join(directory, candidate)); return true; } catch { return false; }
  }) ?? 'transaction-journal.jsonl');
  const path = artifactPath(directory, name);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { fail(name, `journal is not readable: ${(error as Error).message}`, 'missing-artifact'); }
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.some(line => line.trim() === '')) fail(name, 'journal contains no events or blank lines', 'journal-invalid');
  const events: JournalEvent[] = [];
  let transactionId: string | undefined;
  let fence: number | string | undefined;
  let planHash: string | undefined;
  let preparedPlan: TransactionPlan | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    let raw: RecordValue;
    try { raw = record(JSON.parse(lines[index]), 'journal event'); } catch (error) { fail(`${name}:${index + 1}`, (error as Error).message, 'journal-invalid'); }
    if (raw.version !== 'transaction-journal/v1' || raw.sequence !== index + 1) fail(`${name}:${index + 1}`, 'journal version or contiguous sequence is invalid', 'journal-invalid');
    if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) fail(`${name}:${index + 1}/at`, 'journal event timestamp is invalid', 'journal-invalid');
    if (typeof raw.transactionId !== 'string' || raw.transactionId.length === 0) fail(`${name}:${index + 1}/transactionId`, 'journal transaction ID is invalid', 'journal-invalid');
    if (!(typeof raw.fence === 'number' || typeof raw.fence === 'string')) fail(`${name}:${index + 1}/fence`, 'journal fence is invalid', 'journal-invalid');
    const eventKind = raw.kind as JournalEvent['kind'];
    if (!JOURNAL_EVENT_KINDS.has(eventKind)) fail(`${name}:${index + 1}/kind`, 'unknown journal event kind', 'journal-invalid');
    if (typeof raw.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.planHash)) fail(`${name}:${index + 1}/planHash`, 'journal plan hash is invalid', 'journal-invalid');
    transactionId ??= raw.transactionId;
    fence ??= raw.fence;
    planHash ??= raw.planHash;
    if (raw.transactionId !== transactionId || raw.fence !== fence || raw.planHash !== planHash) fail(`${name}:${index + 1}`, 'journal event binding changed mid-stream', 'journal-invalid');
    let decodedPlan: TransactionPlan | undefined;
    if (raw.plan !== undefined) {
      decodedPlan = decodeTransactionPlan(raw.plan, `${name}:${index + 1}/plan`);
      if (decodedPlan.planHash !== raw.planHash || decodedPlan.transactionId !== raw.transactionId || decodedPlan.fence !== raw.fence) fail(`${name}:${index + 1}/plan`, 'journal embedded plan binding mismatch', 'journal-invalid');
      if (preparedPlan !== undefined && canonicalJsonSha256(decodedPlan) !== canonicalJsonSha256(preparedPlan)) fail(`${name}:${index + 1}/plan`, 'journal contains conflicting transaction plans', 'journal-invalid');
      preparedPlan ??= decodedPlan;
    }
    const event: JournalEvent = {
      version: 'transaction-journal/v1', sequence: raw.sequence, at: raw.at,
      transactionId: raw.transactionId, fence: raw.fence, planHash: raw.planHash,
      kind: eventKind,
      ...(decodedPlan ? { plan: decodedPlan } : {}),
      ...(raw.operationIndex !== undefined ? { operationIndex: raw.operationIndex as number } : {}),
      ...(raw.error !== undefined ? { error: raw.error as JournalEvent['error'] } : {}),
      ...(raw.mismatches !== undefined ? { mismatches: raw.mismatches as JournalEvent['mismatches'] } : {}),
    };
    events.push(event);
  }
  if (!preparedPlan || !transactionId || fence === undefined || !planHash) fail(name, 'journal has no complete prepared transaction plan', 'journal-invalid');
  if (planHash !== plan.plan_sha256) fail(name, 'journal plan hash does not match candidate plan', 'plan-hash-mismatch');
  if (fence !== plan.fence || fence !== manifest.target_vault.writer_fence) fail(name, 'journal fence does not match manifest/candidate plan', 'binding-mismatch');
  const terminal = events.at(-1);
  if (!terminal || !['committed', 'restored', 'recovered', 'frozen'].includes(terminal.kind)) fail(name, 'journal does not end in a terminal writer event', 'journal-invalid');
  if (terminal.kind !== 'committed') fail(name, `candidate artifact journal ended ${terminal.kind}, not committed`, 'transaction-not-committed');
  comparePlanToCandidateContract(preparedPlan, plan, name);
  return {
    path,
    sha256: sha256Hex(text),
    events,
    transactionId,
    fence,
    planHash,
    terminalKind: terminal.kind,
  };
}

function comparePlanToCandidateContract(transactionPlan: TransactionPlan, candidatePlan: CandidatePlan, path: string): void {
  const targets = candidatePlan.targets;
  if (targets.length !== transactionPlan.operations.length) fail(path, 'candidate plan target count differs from WAL operations', 'plan-mismatch');
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const operation = transactionPlan.operations[index];
    if (target.path !== operation.path || target.action !== operation.kind) fail(`${path}/operation/${index}`, 'candidate target differs from WAL operation', 'plan-mismatch');
    if ((operation.kind === 'replace' || operation.kind === 'delete') && target.expected_sha256 !== operation.preconditionHash) fail(`${path}/operation/${index}/expected_sha256`, 'candidate precondition differs from WAL', 'plan-mismatch');
    if (operation.after.exists) {
      if (target.content_sha256 !== operation.after.hash || target.content_bytes !== new TextDecoder().decode(operation.after.bytes ?? new Uint8Array())) fail(`${path}/operation/${index}`, 'candidate content differs from WAL after-state', 'plan-mismatch');
    }
  }
}

function verifyReplay(directory: string, manifest: RunManifest, receipt: Receipt, plan: CandidatePlan, projectionSha256: string, options: VerifyRunArtifactsOptions): VerifiedReplay {
  const name = options.replayLedgerPath ?? 'replay-ledger.jsonl';
  const path = artifactPath(directory, name);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { fail(name, `replay ledger is not readable: ${(error as Error).message}`, 'missing-artifact'); }
  let verification: ReplayLedgerVerification;
  try {
    verification = verifyReplayLedgerFile(path, {
      registry: options.registry,
      requiredScope: scope(options, 'replay', 'spm-brain-replay-append'),
      initialCheckpointHash: options.initialReplayCheckpointSha256 ?? manifest.prior_replay_ledger_sha256,
      priorTuples: options.priorReplayTuples,
    });
  } catch (error) {
    fail(name, (error as Error).message, 'replay-invalid');
  }
  if (verification.entryCount === 0) fail(name, 'replay ledger must contain a terminal entry', 'replay-invalid');
  const first = verification.entries[0];
  const last = verification.entries.at(-1);
  if (!first || !last) fail(name, 'replay ledger has no entries', 'replay-invalid');
  if (first.previousHash !== (options.initialReplayCheckpointSha256 ?? manifest.prior_replay_ledger_sha256)) fail(`${name}/0/previousHash`, 'replay ledger does not begin at the manifest checkpoint', 'replay-checkpoint-mismatch');
  for (const [index, entry] of verification.entries.entries()) {
    if (entry.runId !== manifest.run_id || entry.fence !== manifest.target_vault.writer_fence) fail(`${name}/${index}`, 'replay entry run/fence is not manifest-bound', 'binding-mismatch');
  }
  if (!last.payload || typeof last.payload !== 'object') fail(`${name}/${verification.entryCount - 1}/payload`, 'terminal replay entry has no receipt binding payload', 'replay-invalid');
  const payload = last.payload as RecordValue;
  if (payload.receipt_id !== receipt.receipt_id || payload.plan_sha256 !== plan.plan_sha256 || payload.projection_sha256 !== projectionSha256) fail(`${name}/${verification.entryCount - 1}/payload`, 'terminal replay entry does not bind receipt/plan/projection', 'replay-binding-mismatch');
  return {
    path,
    sha256: sha256Hex(text),
    rootSha256: verification.rootHash,
    entryCount: verification.entryCount,
    firstPreviousHash: first.previousHash,
    lastRunId: last.runId,
    lastFence: last.fence,
  };
}

function verifyReceipt(
  value: unknown,
  envelopeValue: unknown,
  manifest: RunManifest,
  plan: CandidatePlan,
  projectionSha256: string,
  journalSha256: string,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): Receipt {
  const receipt = verifySignedContract<Receipt>(
    'receipt', value, DOMAINS.CANDIDATE_RECEIPT_SIGNATURE, registry,
    { requiredScope: scope(options, 'candidateReceipt', 'spm-brain-candidate-receipt-sign'), runId: manifest.run_id, fence: manifest.target_vault.writer_fence },
  );
  if (receipt.receipt_type !== 'candidate' || receipt.status !== 'accepted') fail('candidate-receipt.json', 'only an accepted candidate receipt is eligible for terminal verification', 'receipt-rejected');
  if (receipt.run_id !== manifest.run_id || receipt.writer_fence !== manifest.target_vault.writer_fence) fail('candidate-receipt.json', 'receipt is not manifest-bound', 'binding-mismatch');
  if (receipt.plan_sha256 !== plan.plan_sha256) fail('candidate-receipt.json/plan_sha256', 'receipt plan hash differs from candidate plan', 'hash-mismatch');
  if (receipt.projection_sha256 !== projectionSha256) fail('candidate-receipt.json/projection_sha256', 'receipt projection hash differs from candidate projection', 'hash-mismatch');
  if (receipt.journal_sha256 !== journalSha256) fail('candidate-receipt.json/journal_sha256', 'receipt journal hash differs from journal bytes', 'hash-mismatch');
  const envelope = record(envelopeValue, 'receipt envelope');
  if (envelope.version !== 'spm-brain/signed/v1' || envelope.domain !== DOMAINS.CANDIDATE_RECEIPT_SIGNATURE) fail('candidate-receipt-envelope.json', 'receipt envelope version/domain is invalid', 'envelope-invalid');
  if (envelope.keyId !== receipt.signature.key_id || envelope.digest !== receipt.signature.signed_digest || envelope.signature !== receipt.signature.signature) fail('candidate-receipt-envelope.json', 'receipt envelope is not the same signed receipt', 'envelope-mismatch');
  if (!sameCanonical(envelope.payload, withoutSignature(receipt))) fail('candidate-receipt-envelope.json/payload', 'receipt envelope payload differs from candidate receipt body', 'envelope-mismatch');
  try {
    registry.verifyEnvelope(envelope as unknown as SignedEnvelope<JsonValue>, {
      requiredScope: scope(options, 'candidateReceipt', 'spm-brain-candidate-receipt-sign'), runId: manifest.run_id, fence: manifest.target_vault.writer_fence,
    });
  } catch (error) {
    fail('candidate-receipt-envelope.json', (error as Error).message, 'signature-invalid');
  }
  return receipt;
}

function verifyTerminal(
  directory: string,
  manifest: RunManifest,
  journalSha256: string,
  replaySha256: string,
  projectionSha256: string,
  registry: KeyRegistry,
  options: VerifyRunArtifactsOptions,
): { root: ContractTerminalRoot | CryptoTerminalRoot; contract?: ContractTerminalRoot; crypto?: CryptoTerminalRoot } {
  const name = options.terminalRootPath ?? REQUIRED_FILES.terminalRoot;
  const value = parseJsonFile<unknown>(directory, name);
  const raw = record(value, 'terminal root');
  if (raw.version === 'spm-brain/terminal-root/v1') {
    const root = value as CryptoTerminalRoot;
    if (root.runId !== manifest.run_id) fail(`${name}/runId`, 'terminal root run ID differs from manifest', 'binding-mismatch');
    try {
      verifyTerminalRoot(root, {
        directory,
        registry,
        requiredScope: scope(options, 'terminal', 'spm-brain-run-terminalize'),
      });
    } catch (error) {
      fail(name, (error as Error).message, 'terminal-root-invalid');
    }
    if (root.manifestHash !== undefined && root.manifestHash !== canonicalJsonSha256(manifest)) fail(`${name}/manifestHash`, 'terminal root manifest hash differs from manifest', 'hash-mismatch');
    if (root.ledgerRootHash !== undefined && root.ledgerRootHash !== replaySha256) fail(`${name}/ledgerRootHash`, 'terminal root replay checkpoint differs from replay ledger', 'hash-mismatch');
    void journalSha256;
    void projectionSha256;
    return { root, crypto: root };
  }
  if (raw.contract_version === 'headless-ingest/v1') {
    const contract = assertValidContract<ContractTerminalRoot>('terminalRoot', value);
    try {
      verifyTerminalRootContract(contract, {
        registry,
        directory,
        expectedRunId: manifest.run_id,
        expectedJournalSha256: journalSha256,
        expectedReplayLedgerSha256: replaySha256,
        expectedProjectionComparisonSha256: projectionSha256,
        requiredScope: scope(options, 'terminal', 'spm-brain-run-terminalize'),
      });
    } catch (error) {
      fail(name, (error as Error).message, 'terminal-root-invalid');
    }
    return { root: contract, contract, crypto: terminalRootFromContract(contract) };
  }
  fail(name, 'terminal root is neither the crypto nor snake_case contract shape', 'malformed-contract');
}

/**
 * Verify every durable artifact needed to credit a headless run. This method
 * is intentionally read-only and returns only after all cross-artifact,
 * signature, provenance, replay, journal, projection, and Merkle checks pass.
 */
export function independentlyVerifyRunArtifacts(options: VerifyRunArtifactsOptions): RunArtifactVerificationResult {
  const directory = resolve(options.directory);
  const preflight = verifyPreflight(parseJsonFile(directory, REQUIRED_FILES.preflight), options.registry, options);
  const inventory = assertValidContract<SourceInventory>('sourceInventory', parseJsonFile(directory, REQUIRED_FILES.sourceInventory));
  const manifest = verifyManifest(parseJsonFile(directory, REQUIRED_FILES.manifest), options.registry, options);
  if (options.expectedRunId !== undefined && manifest.run_id !== options.expectedRunId) fail(REQUIRED_FILES.manifest, `run ID ${manifest.run_id} does not match expected ${options.expectedRunId}`, 'binding-mismatch');
  verifySourceIdentitySet(manifest, inventory);
  if (preflight.run_id !== manifest.run_id || preflight.vault.snapshot_tree_sha256 !== manifest.target_vault.snapshot_tree_sha256) fail(REQUIRED_FILES.preflight, 'preflight capture is not manifest-bound', 'binding-mismatch');
  const workers = verifyWorkerArtifacts(parseJsonFile(directory, REQUIRED_FILES.workers), manifest, options.registry, options);
  const plan = verifyCandidatePlan(parseJsonFile(directory, REQUIRED_FILES.candidatePlan), manifest, options.registry, options);
  const sourceProjection = verifyProjection(parseJsonFile(directory, REQUIRED_FILES.sourceProjection), REQUIRED_FILES.sourceProjection, manifest.run_id);
  const candidateProjection = verifyProjection(parseJsonFile(directory, REQUIRED_FILES.candidateProjection), REQUIRED_FILES.candidateProjection, manifest.run_id);
  const projectionSha256 = canonicalJsonSha256(candidateProjection);
  const journal = verifyJournal(directory, manifest, plan, options);
  const receipt = verifyReceipt(parseJsonFile(directory, REQUIRED_FILES.receipt), parseJsonFile(directory, REQUIRED_FILES.envelope), manifest, plan, projectionSha256, journal.sha256, options.registry, options);
  const replay = verifyReplay(directory, manifest, receipt, plan, projectionSha256, options);
  const terminal = verifyTerminal(directory, manifest, journal.sha256, replay.rootSha256, projectionSha256, options.registry, options);
  return {
    ok: true,
    runId: manifest.run_id,
    directory,
    manifest,
    sourceInventory: inventory,
    workerArtifacts: workers,
    candidatePlan: plan,
    receipt,
    sourceProjection,
    candidateProjection,
    preflightCapture: preflight,
    journal,
    replay,
    terminalRoot: terminal.root,
    ...(terminal.contract ? { terminalRootContract: terminal.contract } : {}),
    ...(terminal.crypto ? { terminalRootCrypto: terminal.crypto } : {}),
    projectionSha256,
    manifestSha256: canonicalJsonSha256(manifest),
  };
}

export const verifyRunArtifacts = independentlyVerifyRunArtifacts;
export const verifyRunArtifactDirectory = independentlyVerifyRunArtifacts;
export const independentlyVerifyFullRun = independentlyVerifyRunArtifacts;
