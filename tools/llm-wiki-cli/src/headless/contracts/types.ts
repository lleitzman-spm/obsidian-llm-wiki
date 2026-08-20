/** Provider-neutral v1 headless-ingest contract types. */

export type ContractVersion = 'headless-ingest/v1';
export type Digest = string;

export interface ContractSignature {
  key_id: string;
  algorithm: 'Ed25519';
  signature: string;
  signed_digest: Digest;
}

export interface SourceIdentity {
  authority_tree: string;
  path: string;
  byte_sha256: Digest;
  source_identity_sha256: Digest;
  byte_count: number;
  canonical_sha256?: Digest;
  normalization_version?: string;
}

export interface RunManifest {
  contract_version: ContractVersion;
  run_id: string;
  job_id: string;
  created_at: string;
  authority: { repository_url: string; commit: string; tree: string };
  source_inventory: { sha256: Digest; selector_version: string; exclusions: string[] };
  sources: SourceIdentity[];
  runtime: { engine_version: string; bundle_sha256: Digest };
  settings: { sha256: Digest; safe_projection_sha256: Digest };
  policy: {
    schema_sha256: Digest;
    vocabulary_sha256: Digest;
    policy_pack_sha256: Digest;
    prompt_version: string;
    contract_version: string;
  };
  provider: { provider: string; model: string };
  target_vault: {
    snapshot_tree_sha256: Digest;
    copy_roots: { native: string; candidate: string };
    writer_fence: number;
  };
  workers: Array<{
    worker_id: string;
    key_id: string;
    public_key: string;
    source_identity_sha256: Digest;
    allowed_partition: string;
  }>;
  prior_replay_ledger_sha256: Digest;
  signature: ContractSignature;
}

export interface SourceInventory {
  contract_version: ContractVersion;
  inventory_id: string;
  authority: { repository_url: string; commit: string; tree: string };
  selector: { version: string; include: string; exclusions: string[] };
  sources: SourceIdentity[];
  inventory_sha256: Digest;
  signature?: ContractSignature;
}

export type EvidenceKind = 'quote' | 'heading' | 'list-item' | 'table-cell' | 'frontmatter-field' | 'code-block';
export type EvidenceReason =
  | 'direct-quote'
  | 'defines-relationship'
  | 'defines-scope'
  | 'defines-status'
  | 'defines-obligation'
  | 'defines-exception'
  | 'defines-control'
  | 'defines-metric';
export type ClaimDisposition = 'evidenced' | 'asserted' | 'contested' | 'unknown';

export interface Evidence {
  evidence_id: Digest;
  kind: EvidenceKind;
  reason: EvidenceReason;
  source_path: string;
  original_sha256: Digest;
  canonical_sha256: Digest;
  byte_start: number;
  byte_end: number;
  exact_canonical_bytes: string;
  normalization_version: string;
}

export interface Claim {
  claim_id: Digest;
  subject_key: { page_type: 'entity' | 'concept'; normalized_label: string };
  predicate: { version: string; name: string } | string;
  object: unknown;
  disposition: ClaimDisposition;
  evidence: Evidence[];
  aliases?: string[];
  subtype_tags?: string[];
}

export interface WorkerArtifact {
  contract_version: ContractVersion;
  run_id: string;
  job_id: string;
  worker_id: string;
  provider: string;
  model: string;
  started_at: string;
  completed_at: string;
  source: SourceIdentity;
  summary: string;
  proposals: {
    entities: string[];
    concepts: string[];
  };
  claims: Claim[];
  attempts: Array<{
    attempt: number;
    provider: string;
    model: string;
    status: 'success' | 'retry' | 'failed';
    reason: string;
    delay_ms: number;
    input_tokens: number;
    output_tokens: number;
    billed_tokens: number;
    terminal: boolean;
  }>;
  artifact_sha256: Digest;
  terminal_status: 'succeeded' | 'failed' | 'cancelled';
  signature: ContractSignature;
}

export interface PartitionManifest {
  contract_version: ContractVersion;
  run_id: string;
  fence: number;
  partitions: Array<{
    partition_id: string;
    reducer_worker_id: string;
    fence: number;
    keys: Array<{
      canonical_key_id: Digest;
      page_type: 'entity' | 'concept';
      normalization_version: string;
      normalized_label: string;
    }>;
    load: { key_count: number; claim_count: number };
  }>;
  signature: ContractSignature;
}

export interface CandidatePlan {
  contract_version: ContractVersion;
  run_id: string;
  fence: number;
  snapshot_tree_sha256: Digest;
  targets: Array<{
    path: string;
    action: 'create' | 'replace' | 'delete';
    expected_sha256?: Digest;
    content_sha256?: Digest;
    content_bytes?: string;
  }>;
  plan_sha256: Digest;
  signature: ContractSignature;
}

export type ReceiptType = 'native' | 'candidate' | 'comparison';
export interface Receipt {
  contract_version: ContractVersion;
  receipt_id: string;
  receipt_type: ReceiptType;
  run_id: string;
  created_at: string;
  status: 'accepted' | 'rejected' | 'restored';
  writer_fence: number;
  target_snapshot_sha256: Digest;
  plan_sha256?: Digest;
  projection_sha256?: Digest;
  journal_sha256?: Digest;
  counts: Record<string, number>;
  deltas?: Array<{ id: Digest; materiality: string; disposition?: string; adjudication_id?: Digest }>;
  signature: ContractSignature;
}

export interface SemanticProjection {
  schema_version: 'semantic-projection/v1';
  run_id: string;
  parser: {
    version: string;
    source_sha256: Digest;
    grammar_sha256: Digest;
    unicode_sha256: Digest;
    boilerplate_policy_sha256: Digest;
  };
  nodes: Array<{ id: Digest; type: 'source' | 'claim' | 'alias' | 'canonical-key' | 'page-statement' | 'adjudication'; data: Record<string, unknown> }>;
  edges: Array<{ id: Digest; type: 'evidences' | 'renders' | 'nominates' | 'contests' | 'resolves'; source_id: Digest; target_id: Digest; data: Record<string, unknown> }>;
}

export interface PreflightCapture {
  contract_version: ContractVersion;
  capture_type: 'initial' | 'live';
  run_id: string;
  window_id: string;
  captured_at: string;
  vault: { identity: string; root: string; snapshot_tree_sha256: Digest };
  idle: boolean;
  hashes: { authority_commit: string; authority_tree: string; runtime_sha256: Digest; schema_sha256: Digest; settings_sha256: Digest; safe_settings_projection_sha256: Digest };
  copy_roots: { native: string; candidate: string };
  roots_outside_live_and_sync: true;
  root_check: {
    status: 'verified';
    verifier_id: string;
    verified_at: string;
    max_age_seconds: number;
    live_root: string;
    copy_roots: { native: string; candidate: string };
    containment_checked: true;
    signed_digest: Digest;
    signature: ContractSignature;
  };
  signature: ContractSignature;
}

export interface ReplayLedger {
  contract_version: ContractVersion;
  run_id: string;
  previous_global_checkpoint_sha256: Digest;
  entries: Array<{
    sequence: number;
    key_id: string;
    run_id: string;
    nonce: string;
    fence: number;
    previous_entry_sha256: Digest;
    entry_sha256: Digest;
    signature: ContractSignature;
  }>;
  ledger_root_sha256: Digest;
}

export interface TerminalRoot {
  contract_version: ContractVersion;
  run_id: string;
  root_sha256: Digest;
  leaf_count: number;
  leaves: Array<{ path: string; artifact_sha256: Digest; leaf_sha256: Digest }>;
  journal_sha256: Digest;
  replay_ledger_sha256: Digest;
  projection_comparison_sha256: Digest;
  signature: ContractSignature;
}
