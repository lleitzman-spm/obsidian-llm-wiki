import {
  DOMAINS,
  digestHex,
  hashCanonical,
  verifyContractSignature,
} from '../crypto';
import { canonicalJsonBytes } from '../crypto/canonical-json';
import { validateWorkerArtifact } from '../contracts';
import type { SourceIdentity, WorkerArtifact } from '../contracts';
import {
  claimId,
  evidenceId,
  sourceIdentity,
} from '../provenance';
import { assertSha256Hex, normalizePath, sha256Hex } from '../provenance/canonical';
import type { WorkerArtifactValidationContext, WorkerArtifactValidationError, WorkerArtifactValidationResult, WorkerBytes } from './types';

function bytes(value: WorkerBytes): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function error(instancePath: string, keyword: string, message: string): WorkerArtifactValidationError {
  return { instancePath, keyword, message };
}

function sourceEqual(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.authority_tree === right.authority_tree
    && left.path === right.path
    && left.byte_sha256 === right.byte_sha256
    && left.source_identity_sha256 === right.source_identity_sha256
    && left.byte_count === right.byte_count
    && left.canonical_sha256 === right.canonical_sha256
    && left.normalization_version === right.normalization_version;
}

function expectedSource(context: WorkerArtifactValidationContext, artifact: WorkerArtifact): SourceIdentity | undefined {
  const sources = context.sources ?? [];
  return sources.find(source => source.source_identity_sha256 === artifact.source.source_identity_sha256)
    ?? (sources.length === 1 ? sources[0] : undefined);
}

function expectedString(contextValue: string | undefined, manifestValue: string | undefined): string | undefined {
  return contextValue ?? manifestValue;
}

/** Stable digest of the worker payload, excluding its self-referential digest and signature. */
export function workerArtifactDigest(artifact: WorkerArtifact): string {
  const { artifact_sha256: _artifactDigest, signature: _signature, ...payload } = artifact;
  return sha256Hex(canonicalJsonBytes(payload));
}

/** Digest signed by the contract signature, excluding only the signature field. */
export function workerArtifactSignedDigest(artifact: WorkerArtifact): string {
  const { signature: _signature, ...payload } = artifact;
  return digestHex(hashCanonical(DOMAINS.WORKER_ARTIFACT_SIGNATURE, payload));
}

function addSourceChecks(
  artifact: WorkerArtifact,
  context: WorkerArtifactValidationContext,
  expected: SourceIdentity | undefined,
  errors: WorkerArtifactValidationError[],
): void {
  const authorityTree = expectedString(context.authorityTree, context.runManifest?.authority.tree);
  if (!authorityTree) errors.push(error('/source/authority_tree', 'authorityBinding', 'authority tree is required from trusted context'));
  else if (artifact.source.authority_tree !== authorityTree) errors.push(error('/source/authority_tree', 'authorityBinding', 'worker source authority tree is not the trusted tree'));
  if (expected && !sourceEqual(artifact.source, expected)) errors.push(error('/source', 'sourceBinding', 'worker source does not exactly match the authority inventory entry'));
  try {
    const recomputed = sourceIdentity({ authorityTree: artifact.source.authority_tree, path: artifact.source.path, byteHash: artifact.source.byte_sha256 });
    if (recomputed !== artifact.source.source_identity_sha256) errors.push(error('/source/source_identity_sha256', 'sourceIdentity', 'source identity does not recompute from authority path and byte hash'));
  } catch (cause) {
    errors.push(error('/source', 'sourceIdentity', cause instanceof Error ? cause.message : 'source identity cannot be recomputed'));
  }
  try { assertSha256Hex(artifact.source.byte_sha256, 'source byte hash'); } catch { errors.push(error('/source/byte_sha256', 'digest', 'source byte hash must be lowercase SHA-256')); }
  const raw = context.sourceBytes;
  if (raw !== undefined) {
    const rawBytes = bytes(raw);
    if (rawBytes.byteLength !== artifact.source.byte_count) errors.push(error('/source/byte_count', 'sourceBytes', 'authority byte count does not match supplied bytes'));
    if (sha256Hex(rawBytes) !== artifact.source.byte_sha256) errors.push(error('/source/byte_sha256', 'sourceBytes', 'authority byte hash does not match supplied bytes'));
  }
}

function addEvidenceChecks(
  artifact: WorkerArtifact,
  context: WorkerArtifactValidationContext,
  errors: WorkerArtifactValidationError[],
): void {
  const canonical = context.canonicalSourceBytes === undefined ? undefined : bytes(context.canonicalSourceBytes);
  const canonicalHash = canonical === undefined ? undefined : sha256Hex(canonical);
  for (let claimIndex = 0; claimIndex < artifact.claims.length; claimIndex += 1) {
    const claim = artifact.claims[claimIndex];
    const evidenceIds: string[] = [];
    for (let evidenceIndex = 0; evidenceIndex < claim.evidence.length; evidenceIndex += 1) {
      const evidence = claim.evidence[evidenceIndex];
      const path = `/claims/${claimIndex}/evidence/${evidenceIndex}`;
      try {
        if (normalizePath(evidence.source_path) !== normalizePath(artifact.source.path)) errors.push(error(`${path}/source_path`, 'sourceBinding', 'evidence source path is outside the worker source'));
      } catch { errors.push(error(`${path}/source_path`, 'path', 'evidence source path is unsafe')); }
      if (evidence.original_sha256 !== artifact.source.byte_sha256) errors.push(error(`${path}/original_sha256`, 'sourceBinding', 'evidence original hash does not equal the authority source hash'));
      const upperBound = canonical?.byteLength ?? artifact.source.byte_count;
      if (evidence.byte_start < 0 || evidence.byte_end < evidence.byte_start || evidence.byte_end > upperBound) {
        errors.push(error(`${path}/byte_end`, 'byteBounds', `evidence byte range must fit within 0..${upperBound}`));
      }
      const exact = bytes(evidence.exact_canonical_bytes);
      if (exact.byteLength !== evidence.byte_end - evidence.byte_start) errors.push(error(`${path}/exact_canonical_bytes`, 'canonicalBytes', 'exact canonical bytes length must equal the exclusive evidence range'));
      if (canonical !== undefined) {
        const slice = canonical.slice(evidence.byte_start, evidence.byte_end);
        if (!equalBytes(exact, slice)) errors.push(error(`${path}/exact_canonical_bytes`, 'canonicalBytes', 'exact canonical bytes do not match the trusted canonical source slice'));
        if (evidence.canonical_sha256 !== canonicalHash) errors.push(error(`${path}/canonical_sha256`, 'canonicalSourceBinding', 'evidence canonical hash does not match the trusted canonical source'));
      } else if (artifact.source.canonical_sha256 !== undefined && evidence.canonical_sha256 !== artifact.source.canonical_sha256) {
        errors.push(error(`${path}/canonical_sha256`, 'canonicalSourceBinding', 'evidence canonical hash does not match the authority source canonical hash'));
      }
      try {
        const recomputed = evidenceId({
          kind: evidence.kind,
          reasonCode: evidence.reason,
          authorityTree: artifact.source.authority_tree,
          normalizedPath: artifact.source.path,
          originalSourceHash: evidence.original_sha256,
          canonicalSourceHash: evidence.canonical_sha256,
          byteRange: { start: evidence.byte_start, end: evidence.byte_end },
          exactCanonicalBytes: evidence.exact_canonical_bytes,
          normalizationVersion: evidence.normalization_version,
        });
        if (recomputed !== evidence.evidence_id) errors.push(error(`${path}/evidence_id`, 'evidenceId', 'evidence ID does not recompute from its exact fields'));
      } catch (cause) { errors.push(error(`${path}/evidence_id`, 'evidenceId', cause instanceof Error ? cause.message : 'evidence ID cannot be recomputed')); }
      evidenceIds.push(evidence.evidence_id);
    }
    const unique = new Set(evidenceIds);
    if (unique.size !== evidenceIds.length) errors.push(error(`/claims/${claimIndex}/evidence`, 'uniqueItems', 'claim evidence IDs must be unique'));
    try {
      const recomputed = claimId({ subjectKey: claim.subject_key, predicate: claim.predicate, object: claim.object, evidenceIds });
      if (recomputed !== claim.claim_id) errors.push(error(`/claims/${claimIndex}/claim_id`, 'claimId', 'claim ID does not recompute from subject, predicate, object, and evidence IDs'));
    } catch (cause) { errors.push(error(`/claims/${claimIndex}/claim_id`, 'claimId', cause instanceof Error ? cause.message : 'claim ID cannot be recomputed')); }
  }
}

function addBindingChecks(artifact: WorkerArtifact, context: WorkerArtifactValidationContext, errors: WorkerArtifactValidationError[]): void {
  const runId = expectedString(context.runId, context.runManifest?.run_id);
  const jobId = expectedString(context.jobId, context.runManifest?.job_id);
  if (!runId) errors.push(error('/run_id', 'runBinding', 'trusted run ID is required'));
  else if (artifact.run_id !== runId) errors.push(error('/run_id', 'runBinding', 'worker run ID does not match the trusted run'));
  if (!jobId) errors.push(error('/job_id', 'jobBinding', 'trusted job ID is required'));
  else if (artifact.job_id !== jobId) errors.push(error('/job_id', 'jobBinding', 'worker job ID does not match the trusted job'));
  const workerBinding = context.runManifest?.workers.find(worker => worker.worker_id === artifact.worker_id)
    ?? (context.workerId === artifact.worker_id ? undefined : undefined);
  if (context.workerId !== undefined && artifact.worker_id !== context.workerId) errors.push(error('/worker_id', 'workerBinding', 'worker ID does not match the requested worker'));
  if (!workerBinding && context.runManifest) errors.push(error('/worker_id', 'workerBinding', 'worker is not bound by the trusted run manifest'));
  if (workerBinding) {
    if (workerBinding.source_identity_sha256 !== artifact.source.source_identity_sha256) errors.push(error('/worker_id', 'sourceBinding', 'worker is bound to a different source identity'));
    if (workerBinding.key_id !== artifact.signature.key_id) errors.push(error('/signature/key_id', 'keyBinding', 'worker signature key is not the manifest-bound key'));
    const partition = context.partition ?? workerBinding.allowed_partition;
    if (workerBinding.allowed_partition !== partition) errors.push(error('/worker_id', 'partitionBinding', 'worker partition is not the trusted partition'));
  }
  const fence = context.fence ?? context.runManifest?.target_vault.writer_fence;
  const partition = context.partition ?? workerBinding?.allowed_partition;
  try {
    verifyContractSignature(DOMAINS.WORKER_ARTIFACT_SIGNATURE, artifact.signature, context.registry, {
      requiredScope: context.requiredScope ?? 'spm-brain-worker-artifact-sign',
      ...(runId ? { runId } : {}),
      workerId: artifact.worker_id,
      sourceIdentity: artifact.source.source_identity_sha256,
      ...(partition ? { partition } : {}),
      ...(fence !== undefined ? { fence } : {}),
    });
  } catch (cause) { errors.push(error('/signature', 'trustedSignature', cause instanceof Error ? cause.message : 'worker signature is not trusted')); }
  const signedDigest = workerArtifactSignedDigest(artifact);
  if (artifact.signature.signed_digest !== signedDigest) errors.push(error('/signature/signed_digest', 'signatureBinding', 'signature digest does not recompute from the worker payload'));
}

/** Validate one worker artifact against authority, run, lease, and trusted-key facts. */
export function validateWorkerArtifactProvenance(
  artifact: unknown,
  context: WorkerArtifactValidationContext,
): WorkerArtifactValidationResult {
  const structural = validateWorkerArtifact(artifact);
  const value = structural.data as WorkerArtifact;
  const errors: WorkerArtifactValidationError[] = structural.valid
    ? []
    : structural.errors.map(item => ({ instancePath: item.instancePath, keyword: item.keyword, message: item.message }));
  // AJV's semantic checks intentionally stop at the contract boundary only
  // for malformed shapes.  A structurally complete artifact with one failed
  // semantic check still gets the deeper authority/ID/signature checks below;
  // this prevents a forged path or range from hiding other provenance faults.
  if (!structural.valid && (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)
    || !('source' in artifact) || !('claims' in artifact) || !('signature' in artifact))) {
    return { valid: false, data: value, errors };
  }
  const expected = expectedSource(context, value);
  if (!expected) errors.push(error('/source/source_identity_sha256', 'authorityBinding', 'source is not present in the trusted authority inventory'));
  addSourceChecks(value, context, expected, errors);
  addBindingChecks(value, context, errors);
  addEvidenceChecks(value, context, errors);
  if (value.artifact_sha256 !== workerArtifactDigest(value)) errors.push(error('/artifact_sha256', 'artifactDigest', 'artifact digest does not recompute from canonical worker payload'));
  const started = Date.parse(value.started_at);
  const completed = Date.parse(value.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) errors.push(error('/completed_at', 'timeOrder', 'worker completion time precedes start time'));
  if (context.now !== undefined && context.maxAgeSeconds !== undefined) {
    const now = context.now instanceof Date ? context.now.getTime() : Date.parse(context.now);
    if (Number.isFinite(now) && Number.isFinite(completed) && now - completed > context.maxAgeSeconds * 1000) errors.push(error('/completed_at', 'freshness', 'worker artifact is older than the allowed validation window'));
  }
  if (errors.length > 0) return { valid: false, data: value, errors };
  return { valid: true, data: value, errors: [] };
}

export function assertWorkerArtifactProvenance(artifact: unknown, context: WorkerArtifactValidationContext): WorkerArtifact {
  const result = validateWorkerArtifactProvenance(artifact, context);
  if (!result.valid) throw new Error(`Invalid worker artifact provenance: ${result.errors.map(item => `${item.instancePath || '/'} ${item.message}`).join('; ')}`);
  return result.data;
}
