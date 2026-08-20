import { describe, expect, it } from 'vitest';

import {
  contractSchemas,
  validateCandidatePlan,
  validatePartitionManifest,
  validatePreflightCapture,
  validatePreflightCaptureForExecution,
  validateReceipt,
  validateReplayLedger,
  validateRunManifest,
  validateSemanticProjection,
  validateSourceInventory,
  validateTerminalRoot,
  validateWorkerArtifact,
} from '../../../../../tools/llm-wiki-cli/src/headless/contracts';

const h = (letter: string) => letter.repeat(64);
const sig = (digest = h('a')) => ({ key_id: 'coordinator-key', algorithm: 'Ed25519', signature: 'signed', signed_digest: digest });
const source = (path = 'wiki/agent-operations/a.md') => ({
  authority_tree: h('b'), path, byte_sha256: h('c'), source_identity_sha256: h('d'), byte_count: 10,
});

const inventory = () => ({
  contract_version: 'headless-ingest/v1', inventory_id: 'inventory-1',
  authority: { repository_url: 'https://github.com/example/repo', commit: h('e'), tree: h('f') },
  selector: { version: 'all-markdown/v1', include: 'wiki/agent-operations/**/*.md', exclusions: ['wiki/agent-operations/_index.md'] },
  sources: [source()], inventory_sha256: h('a'),
});

const manifest = () => ({
  contract_version: 'headless-ingest/v1', run_id: 'run-1', job_id: 'job-1', created_at: '2026-08-20T12:00:00.000Z',
  authority: { repository_url: 'https://github.com/example/repo', commit: h('e'), tree: h('f') },
  source_inventory: { sha256: h('a'), selector_version: 'all-markdown/v1', exclusions: ['_index.md'] }, sources: [source()],
  runtime: { engine_version: '1.0.0', bundle_sha256: h('b') }, settings: { sha256: h('c'), safe_projection_sha256: h('d') },
  policy: { schema_sha256: h('e'), vocabulary_sha256: h('f'), policy_pack_sha256: h('a'), prompt_version: 'prompt/v1', contract_version: 'headless-ingest/v1' },
  provider: { provider: 'openai-codex', model: 'gpt-5.6-luna' }, target_vault: { snapshot_tree_sha256: h('b'), copy_roots: { native: 'copies/native', candidate: 'copies/candidate' }, writer_fence: 1 },
  workers: [{ worker_id: 'worker-1', key_id: 'worker-key-1', public_key: 'public-key', source_identity_sha256: h('d'), allowed_partition: 'partition-1' }], prior_replay_ledger_sha256: h('c'), signature: sig(),
});

const evidence = (path = 'wiki/agent-operations/a.md') => ({ evidence_id: h('e'), kind: 'quote', reason: 'direct-quote', source_path: path, original_sha256: h('c'), canonical_sha256: h('d'), byte_start: 0, byte_end: 4, exact_canonical_bytes: 'word', normalization_version: 'source-normalization/v1' });
const worker = () => ({
  contract_version: 'headless-ingest/v1', run_id: 'run-1', job_id: 'job-1', worker_id: 'worker-1', provider: 'openai-codex', model: 'gpt-5.6-luna', started_at: '2026-08-20T12:00:00.000Z', completed_at: '2026-08-20T12:01:00.000Z', source: source(), summary: 'summary', proposals: { entities: ['Agent'], concepts: ['Dispatch'] },
  claims: [{ claim_id: h('f'), subject_key: { page_type: 'entity', normalized_label: 'agent' }, predicate: { version: 'predicate/v1', name: 'defines-status' }, object: 'active', disposition: 'evidenced', evidence: [evidence()] }],
  attempts: [{ attempt: 1, provider: 'openai-codex', model: 'gpt-5.6-luna', status: 'success', reason: 'ok', delay_ms: 0, input_tokens: 1, output_tokens: 1, billed_tokens: 2, terminal: true }], artifact_sha256: h('a'), terminal_status: 'succeeded', signature: sig(),
});

describe('headless-ingest v1 contract schemas', () => {
  it('checks in every durable contract schema and accepts valid fixtures', () => {
    expect(Object.keys(contractSchemas).sort()).toEqual(['candidatePlan', 'partitionManifest', 'preflightCapture', 'receipt', 'replayLedger', 'runManifest', 'semanticProjection', 'sourceInventory', 'terminalRoot', 'workerArtifact']);
    expect(validateRunManifest(manifest()).valid).toBe(true);
    expect(validateSourceInventory(inventory()).valid).toBe(true);

    const artifact = worker();
    expect(validateWorkerArtifact(artifact).valid).toBe(true);
    expect(validatePartitionManifest({ contract_version: 'headless-ingest/v1', run_id: 'run-1', fence: 1, partitions: [{ partition_id: 'partition-1', reducer_worker_id: 'worker-1', fence: 1, keys: [{ canonical_key_id: h('a'), page_type: 'entity', normalization_version: 'nfkc-casefold-space/v1', normalized_label: 'agent' }], load: { key_count: 1, claim_count: 1 } }], signature: sig() }).valid).toBe(true);
    expect(validateCandidatePlan({ contract_version: 'headless-ingest/v1', run_id: 'run-1', fence: 1, snapshot_tree_sha256: h('a'), targets: [{ path: '20 Brain/Agent.md', action: 'replace', content_sha256: h('b'), content_bytes: '# Agent' }], plan_sha256: h('c'), signature: sig() }).valid).toBe(true);
    expect(validateReceipt({ contract_version: 'headless-ingest/v1', receipt_id: 'receipt-1', receipt_type: 'native', run_id: 'run-1', created_at: '2026-08-20T12:00:00.000Z', status: 'accepted', writer_fence: 1, target_snapshot_sha256: h('a'), counts: { claims: 1 }, signature: sig() }).valid).toBe(true);
    expect(validateSemanticProjection({ schema_version: 'semantic-projection/v1', run_id: 'run-1', parser: { version: 'projection-parser/v1', source_sha256: h('a'), grammar_sha256: h('b'), unicode_sha256: h('c'), boilerplate_policy_sha256: h('d') }, nodes: [{ id: h('a'), type: 'source', data: {} }, { id: h('b'), type: 'claim', data: {} }], edges: [{ id: h('c'), type: 'evidences', source_id: h('a'), target_id: h('b'), data: { evidence_ids: [h('d')] } }] }).valid).toBe(true);
    expect(validateTerminalRoot({ contract_version: 'headless-ingest/v1', run_id: 'run-1', root_sha256: h('a'), leaf_count: 1, leaves: [{ path: 'run-manifest.json', artifact_sha256: h('b'), leaf_sha256: h('c') }], journal_sha256: h('d'), replay_ledger_sha256: h('e'), projection_comparison_sha256: h('f'), signature: sig(h('a')) }).valid).toBe(true);
    expect(validatePreflightCapture({ contract_version: 'headless-ingest/v1', capture_type: 'initial', run_id: 'run-1', window_id: 'window-1', captured_at: '2026-08-20T12:00:00.000Z', vault: { identity: 'live-vault', root: 'C:/live-vault', snapshot_tree_sha256: h('a') }, idle: true, hashes: { authority_commit: h('b'), authority_tree: h('c'), runtime_sha256: h('d'), schema_sha256: h('e'), settings_sha256: h('f'), safe_settings_projection_sha256: h('a') }, copy_roots: { native: 'copies/native', candidate: 'copies/candidate' }, roots_outside_live_and_sync: true, root_check: { status: 'verified', verifier_id: 'root-verifier', verified_at: '2026-08-20T12:00:00.000Z', max_age_seconds: 60, live_root: 'C:/live-vault', copy_roots: { native: 'copies/native', candidate: 'copies/candidate' }, containment_checked: true, signed_digest: h('e'), signature: sig(h('e')) }, signature: sig() }).valid).toBe(true);
    expect(validateReplayLedger({ contract_version: 'headless-ingest/v1', run_id: 'run-1', previous_global_checkpoint_sha256: h('a'), entries: [{ sequence: 1, key_id: 'worker-key-1', run_id: 'run-1', nonce: 'nonce_1234567890123456', fence: 1, previous_entry_sha256: h('a'), entry_sha256: h('b'), signature: sig(h('b')) }], ledger_root_sha256: h('c') }).valid).toBe(true);
  });

  it('rejects unknown fields and closed vocabulary values', () => {
    const bad = { ...inventory(), unexpected: true };
    expect(validateSourceInventory(bad).valid).toBe(false);
    const badEvidence = { ...worker(), claims: [{ ...(worker() as any).claims[0], evidence: [{ ...evidence(), kind: 'free-form' }] }] };
    expect(validateWorkerArtifact(badEvidence).valid).toBe(false);
  });

  it('rejects source substitution, missing terminal attempt, and unsupported evidence grounding', () => {
    const bad = worker() as any;
    bad.claims[0].evidence[0].source_path = 'wiki/other.md';
    bad.attempts[0].terminal = false;
    const result = validateWorkerArtifact(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.keyword)).toEqual(expect.arrayContaining(['sourceBinding', 'terminalAttempt']));
  });

  it('rejects illegal semantic projection edges and duplicate/reordered nodes', () => {
    const bad = { schema_version: 'semantic-projection/v1', run_id: 'run-1', parser: { version: 'projection-parser/v1', source_sha256: h('a'), grammar_sha256: h('b'), unicode_sha256: h('c'), boilerplate_policy_sha256: h('d') }, nodes: [{ id: h('b'), type: 'claim', data: {} }, { id: h('a'), type: 'source', data: {} }], edges: [{ id: h('c'), type: 'renders', source_id: h('a'), target_id: h('b'), data: { render_role: 'supports' } }] };
    const result = validateSemanticProjection(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.keyword)).toEqual(expect.arrayContaining(['ordered', 'edgeMatrix']));
  });

  it('rejects replay, Merkle, precondition, and preflight safety violations', () => {
    const ledger = { contract_version: 'headless-ingest/v1', run_id: 'run-1', previous_global_checkpoint_sha256: h('a'), entries: [{ sequence: 1, key_id: 'key', run_id: 'run-1', nonce: 'same_nonce_123456', fence: 1, previous_entry_sha256: h('a'), entry_sha256: h('b'), signature: sig(h('b')) }, { sequence: 2, key_id: 'key', run_id: 'run-1', nonce: 'same_nonce_123456', fence: 1, previous_entry_sha256: h('b'), entry_sha256: h('c'), signature: sig(h('c')) }], ledger_root_sha256: h('d') };
    expect(validateReplayLedger(ledger).valid).toBe(false);
    const root = { contract_version: 'headless-ingest/v1', run_id: 'run-1', root_sha256: h('a'), leaf_count: 2, leaves: [{ path: 'verify.json', artifact_sha256: h('b'), leaf_sha256: h('c') }], journal_sha256: h('d'), replay_ledger_sha256: h('e'), projection_comparison_sha256: h('f'), signature: sig(h('z')) };
    expect(validateTerminalRoot(root).valid).toBe(false);
    const plan = { contract_version: 'headless-ingest/v1', run_id: 'run-1', fence: 1, snapshot_tree_sha256: h('a'), targets: [{ path: 'a.md', action: 'delete' }], plan_sha256: h('b'), signature: sig() };
    expect(validateCandidatePlan(plan).valid).toBe(false);
    const capture = { contract_version: 'headless-ingest/v1', capture_type: 'live', run_id: 'run-1', window_id: 'window-1', captured_at: '2026-08-20T12:00:00.000Z', vault: { identity: 'live-vault', root: 'live', snapshot_tree_sha256: h('a') }, idle: false, hashes: { authority_commit: h('b'), authority_tree: h('c'), runtime_sha256: h('d'), schema_sha256: h('e'), settings_sha256: h('f'), safe_settings_projection_sha256: h('a') }, copy_roots: { native: 'live', candidate: 'copy' }, roots_outside_live_and_sync: true, root_check: { status: 'verified', verifier_id: 'root-verifier', verified_at: '2026-08-20T12:00:00.000Z', max_age_seconds: 60, live_root: 'live', copy_roots: { native: 'live', candidate: 'copy' }, containment_checked: true, signed_digest: h('e'), signature: sig(h('e')) }, signature: sig() };
    expect(validatePreflightCapture(capture).valid).toBe(false);
  });

  it('never treats the containment assertion as execution proof', () => {
    const capture = { contract_version: 'headless-ingest/v1', capture_type: 'live', run_id: 'run-1', window_id: 'window-1', captured_at: '2026-08-20T12:00:00.000Z', vault: { identity: 'live-vault', root: 'live', snapshot_tree_sha256: h('a') }, idle: true, hashes: { authority_commit: h('b'), authority_tree: h('c'), runtime_sha256: h('d'), schema_sha256: h('e'), settings_sha256: h('f'), safe_settings_projection_sha256: h('a') }, copy_roots: { native: 'copy-native', candidate: 'copy-candidate' }, roots_outside_live_and_sync: true, root_check: { status: 'verified', verifier_id: 'root-verifier', verified_at: '2026-08-20T12:00:00.000Z', max_age_seconds: 60, live_root: 'live', copy_roots: { native: 'copy-native', candidate: 'copy-candidate' }, containment_checked: true, signed_digest: h('e'), signature: sig(h('e')) }, signature: sig() };
    expect(validatePreflightCaptureForExecution(capture, { now: '2026-08-20T12:02:00.000Z', verifyContainment: () => true }).valid).toBe(false);
    expect(validatePreflightCaptureForExecution(capture, { now: '2026-08-20T12:00:30.000Z', verifyContainment: () => false }).valid).toBe(false);
    expect(validatePreflightCaptureForExecution(capture, { now: '2026-08-20T12:00:30.000Z', verifyContainment: () => true }).valid).toBe(true);
  });

  it('rejects unallowlisted receipt counters and PII-shaped replay nonces', () => {
    const receipt = { contract_version: 'headless-ingest/v1', receipt_id: 'receipt-1', receipt_type: 'native', run_id: 'run-1', created_at: '2026-08-20T12:00:00.000Z', status: 'accepted', writer_fence: 1, target_snapshot_sha256: h('a'), counts: { resident_email: 1 }, signature: sig() };
    expect(validateReceipt(receipt).valid).toBe(false);
    const ledger = { contract_version: 'headless-ingest/v1', run_id: 'run-1', previous_global_checkpoint_sha256: h('a'), entries: [{ sequence: 1, key_id: 'key', run_id: 'run-1', nonce: 'resident@example.com', fence: 1, previous_entry_sha256: h('a'), entry_sha256: h('b'), signature: sig(h('b')) }], ledger_root_sha256: h('c') };
    expect(validateReplayLedger(ledger).valid).toBe(false);
  });
});
