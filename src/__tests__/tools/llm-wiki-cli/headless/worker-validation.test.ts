import { createKeyRegistry, createSigner, generateEd25519KeyPair, createContractSignature, DOMAINS } from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { describe, expect, it } from 'vitest';
import { claimId, evidenceId, sourceIdentity } from '../../../../../tools/llm-wiki-cli/src/headless/provenance';
import { sha256Hex } from '../../../../../tools/llm-wiki-cli/src/headless/provenance/canonical';
import {
  assertWorkerArtifactProvenance,
  validateWorkerArtifactProvenance,
  workerArtifactDigest,
  workerArtifactSignedDigest,
} from '../../../../../tools/llm-wiki-cli/src/headless/worker-validation';
import type { SourceIdentity, WorkerArtifact } from '../../../../../tools/llm-wiki-cli/src/headless/contracts';

const authorityTree = 'b'.repeat(64);
const sourcePath = 'wiki/agent-operations/worker.md';
const sourceBytes = new TextEncoder().encode('word');
const byteSha = sha256Hex(sourceBytes);
const sourceId = sourceIdentity({ authorityTree, path: sourcePath, byteHash: byteSha });
const source: SourceIdentity = {
  authority_tree: authorityTree,
  path: sourcePath,
  byte_sha256: byteSha,
  source_identity_sha256: sourceId,
  byte_count: sourceBytes.byteLength,
  canonical_sha256: byteSha,
  normalization_version: 'source-normalization/v1',
};

function makeArtifact(): { artifact: WorkerArtifact; context: Parameters<typeof validateWorkerArtifactProvenance>[1] } {
  const pair = generateEd25519KeyPair();
  const signer = createSigner(pair.privateKey, { scopes: ['spm-brain-worker-artifact-sign'] });
  const registry = createKeyRegistry({ trustedKeys: [signer] });
  const evidence = {
    evidence_id: evidenceId({
      kind: 'quote', reasonCode: 'direct-quote', authorityTree, normalizedPath: sourcePath,
      originalSourceHash: byteSha, canonicalSourceHash: byteSha,
      byteRange: { start: 0, end: sourceBytes.byteLength }, exactCanonicalBytes: 'word',
      normalizationVersion: 'source-normalization/v1',
    }),
    kind: 'quote' as const,
    reason: 'direct-quote' as const,
    source_path: sourcePath,
    original_sha256: byteSha,
    canonical_sha256: byteSha,
    byte_start: 0,
    byte_end: sourceBytes.byteLength,
    exact_canonical_bytes: 'word',
    normalization_version: 'source-normalization/v1',
  };
  const claim = {
    claim_id: claimId({ subjectKey: { page_type: 'concept' as const, normalized_label: 'worker' }, predicate: 'defines-status', object: 'active', evidenceIds: [evidence.evidence_id] }),
    subject_key: { page_type: 'concept' as const, normalized_label: 'worker' },
    predicate: 'defines-status', object: 'active', disposition: 'evidenced' as const, evidence: [evidence],
  };
  const payload = {
    contract_version: 'headless-ingest/v1' as const,
    run_id: 'run-1', job_id: 'job-1', worker_id: 'worker-1', provider: 'openai-codex', model: 'gpt-5.6-luna',
    started_at: '2026-08-20T12:00:00.000Z', completed_at: '2026-08-20T12:00:01.000Z', source,
    summary: 'word', proposals: { entities: [], concepts: ['worker'] }, claims: [claim],
    attempts: [{ attempt: 1, provider: 'openai-codex', model: 'gpt-5.6-luna', status: 'success' as const, reason: 'ok', delay_ms: 0, input_tokens: 1, output_tokens: 1, billed_tokens: 2, terminal: true }],
    terminal_status: 'succeeded' as const,
  };
  const artifactWithoutDigest = { ...payload, artifact_sha256: '' } as unknown as WorkerArtifact;
  const artifactDigest = workerArtifactDigest(artifactWithoutDigest);
  const body = { ...payload, artifact_sha256: artifactDigest };
  const signature = createContractSignature(DOMAINS.WORKER_ARTIFACT_SIGNATURE, workerArtifactSignedDigest({ ...body, signature: undefined } as unknown as WorkerArtifact), signer);
  const artifact = { ...body, signature } as WorkerArtifact;
  const context = {
    registry,
    sources: [source],
    authorityTree,
    runId: 'run-1', jobId: 'job-1', workerId: 'worker-1', partition: `source:${sourceId}`, fence: 1,
    sourceBytes,
    canonicalSourceBytes: sourceBytes,
    runManifest: {
      run_id: 'run-1', job_id: 'job-1', authority: { repository_url: 'https://example.test/repo', commit: 'c'.repeat(64), tree: authorityTree },
      workers: [{ worker_id: 'worker-1', key_id: signer.keyId, public_key: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), source_identity_sha256: sourceId, allowed_partition: `source:${sourceId}` }],
      target_vault: { snapshot_tree_sha256: 'd'.repeat(64), copy_roots: { native: 'native', candidate: 'candidate' }, writer_fence: 1 },
    },
  } as const;
  return { artifact, context };
}

describe('strict worker-artifact provenance validation', () => {
  it('accepts an authority-bound, signed artifact and recomputes all IDs', () => {
    const { artifact, context } = makeArtifact();
    const result = validateWorkerArtifactProvenance(artifact, context);
    expect(result.valid).toBe(true);
    expect(() => assertWorkerArtifactProvenance(artifact, context)).not.toThrow();
  });

  it('rejects forged source identity, wrong authority path, and out-of-bounds evidence', () => {
    const { artifact, context } = makeArtifact();
    const forged = structuredClone(artifact) as WorkerArtifact;
    forged.source.path = 'wiki/other.md';
    forged.source.source_identity_sha256 = sourceId;
    forged.claims[0].evidence[0].byte_end = 99;
    const result = validateWorkerArtifactProvenance(forged, context);
    expect(result.valid).toBe(false);
    expect(result.errors.map(item => item.keyword)).toEqual(expect.arrayContaining(['sourceBinding', 'sourceIdentity', 'byteBounds', 'signatureBinding']));
  });

  it('rejects forged evidence and claim IDs even when the source scope is correct', () => {
    const { artifact, context } = makeArtifact();
    const forged = structuredClone(artifact) as WorkerArtifact;
    forged.claims[0].evidence[0].exact_canonical_bytes = 'word!';
    forged.claims[0].evidence[0].evidence_id = 'e'.repeat(64);
    forged.claims[0].claim_id = 'f'.repeat(64);
    const result = validateWorkerArtifactProvenance(forged, context);
    expect(result.valid).toBe(false);
    expect(result.errors.map(item => item.keyword)).toEqual(expect.arrayContaining(['canonicalBytes', 'evidenceId', 'claimId', 'artifactDigest', 'signatureBinding']));
  });

  it('requires the manifest worker binding, partition, fence, and delegated signature scope', () => {
    const { artifact, context } = makeArtifact();
    const bad = { ...context, workerId: 'worker-2', partition: 'partition-other', fence: 2 };
    const result = validateWorkerArtifactProvenance(artifact, bad);
    expect(result.valid).toBe(false);
    expect(result.errors.map(item => item.keyword)).toEqual(expect.arrayContaining(['workerBinding', 'partitionBinding']));
  });
});
