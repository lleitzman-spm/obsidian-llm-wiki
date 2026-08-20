/**
 * Checked-in JSON Schema documents for the headless-ingest v1 artifacts.
 *
 * These are ordinary JSON-compatible values rather than TypeScript-only
 * predicates, so they can be serialized by a future `contracts schema` CLI
 * command without changing the validation surface.
 */

export type JsonSchema = Record<string, unknown>;

const DIGEST: JsonSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const ID: JsonSchema = { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9._:/-]+$' };
const PATH: JsonSchema = { type: 'string', minLength: 1, pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$' };
const ROOT: JsonSchema = { type: 'string', minLength: 1 };
const SAFE_NONCE: JsonSchema = { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const RECEIPT_COUNT_KEYS = ['sources', 'claims', 'evidences', 'pages', 'statements', 'edges', 'creates', 'replaces', 'deletes', 'attempts', 'retries', 'input_tokens', 'output_tokens', 'billed_tokens', 'duration_ms', 'errors'];
const DATE_TIME: JsonSchema = { type: 'string', format: 'date-time' };
const NON_NEGATIVE: JsonSchema = { type: 'integer', minimum: 0 };

const COMMON_DEFS: Record<string, JsonSchema> = {
  digest: DIGEST,
  id: ID,
  path: PATH,
  dateTime: DATE_TIME,
  signature: {
    type: 'object', additionalProperties: false,
    required: ['key_id', 'algorithm', 'signature', 'signed_digest'],
    properties: {
      key_id: { $ref: '#/$defs/id' }, algorithm: { const: 'Ed25519' },
      signature: { type: 'string', minLength: 1 }, signed_digest: { $ref: '#/$defs/digest' },
    },
  },
  sourceIdentity: {
    type: 'object', additionalProperties: false,
    required: ['authority_tree', 'path', 'byte_sha256', 'source_identity_sha256', 'byte_count'],
    properties: {
      authority_tree: { $ref: '#/$defs/digest' }, path: { $ref: '#/$defs/path' },
      byte_sha256: { $ref: '#/$defs/digest' }, source_identity_sha256: { $ref: '#/$defs/digest' },
      byte_count: { type: 'integer', minimum: 0 }, canonical_sha256: { $ref: '#/$defs/digest' },
      normalization_version: { type: 'string', minLength: 1 },
    },
  },
  evidence: {
    type: 'object', additionalProperties: false,
    required: ['evidence_id', 'kind', 'reason', 'source_path', 'original_sha256', 'canonical_sha256', 'byte_start', 'byte_end', 'exact_canonical_bytes', 'normalization_version'],
    properties: {
      evidence_id: { $ref: '#/$defs/digest' },
      kind: { enum: ['quote', 'heading', 'list-item', 'table-cell', 'frontmatter-field', 'code-block'] },
      reason: { enum: ['direct-quote', 'defines-relationship', 'defines-scope', 'defines-status', 'defines-obligation', 'defines-exception', 'defines-control', 'defines-metric'] },
      source_path: { $ref: '#/$defs/path' }, original_sha256: { $ref: '#/$defs/digest' }, canonical_sha256: { $ref: '#/$defs/digest' },
      byte_start: { type: 'integer', minimum: 0 }, byte_end: { type: 'integer', minimum: 1 },
      exact_canonical_bytes: { type: 'string', minLength: 1 }, normalization_version: { type: 'string', minLength: 1 },
    },
  },
  claim: {
    type: 'object', additionalProperties: false,
    required: ['claim_id', 'subject_key', 'predicate', 'object', 'disposition', 'evidence'],
    properties: {
      claim_id: { $ref: '#/$defs/digest' },
      subject_key: {
        type: 'object', additionalProperties: false, required: ['page_type', 'normalized_label'],
        properties: { page_type: { enum: ['entity', 'concept'] }, normalized_label: { type: 'string', minLength: 1 } },
      },
      predicate: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'object', additionalProperties: false, required: ['version', 'name'], properties: { version: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } } },
        ],
      },
      object: {}, disposition: { enum: ['evidenced', 'asserted', 'contested', 'unknown'] },
      evidence: { type: 'array', items: { $ref: '#/$defs/evidence' } },
      aliases: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
      subtype_tags: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    },
  },
  artifactRef: {
    type: 'object', additionalProperties: false, required: ['path', 'sha256'],
    properties: { path: { $ref: '#/$defs/path' }, sha256: { $ref: '#/$defs/digest' }, bytes: { type: 'integer', minimum: 0 } },
  },
};

function schema(id: string, properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `spm-brain/headless/contracts/${id}/v1`, type: 'object', additionalProperties: false,
    required, properties, $defs: COMMON_DEFS,
  };
}

const VERSION = { const: 'headless-ingest/v1' };
const AUTHORITY = {
  type: 'object', additionalProperties: false, required: ['repository_url', 'commit', 'tree'],
  properties: { repository_url: { type: 'string', format: 'uri' }, commit: { $ref: '#/$defs/digest' }, tree: { $ref: '#/$defs/digest' } },
};
const SOURCE_LIST = { type: 'array', minItems: 1, items: { $ref: '#/$defs/sourceIdentity' } };

export const runManifestSchema = schema('run-manifest', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, job_id: { $ref: '#/$defs/id' }, created_at: { $ref: '#/$defs/dateTime' },
  authority: AUTHORITY,
  source_inventory: { type: 'object', additionalProperties: false, required: ['sha256', 'selector_version', 'exclusions'], properties: { sha256: { $ref: '#/$defs/digest' }, selector_version: { type: 'string', minLength: 1 }, exclusions: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } } },
  sources: SOURCE_LIST,
  runtime: { type: 'object', additionalProperties: false, required: ['engine_version', 'bundle_sha256'], properties: { engine_version: { type: 'string', minLength: 1 }, bundle_sha256: { $ref: '#/$defs/digest' } } },
  settings: { type: 'object', additionalProperties: false, required: ['sha256', 'safe_projection_sha256'], properties: { sha256: { $ref: '#/$defs/digest' }, safe_projection_sha256: { $ref: '#/$defs/digest' } } },
  policy: { type: 'object', additionalProperties: false, required: ['schema_sha256', 'vocabulary_sha256', 'policy_pack_sha256', 'prompt_version', 'contract_version'], properties: { schema_sha256: { $ref: '#/$defs/digest' }, vocabulary_sha256: { $ref: '#/$defs/digest' }, policy_pack_sha256: { $ref: '#/$defs/digest' }, prompt_version: { type: 'string', minLength: 1 }, contract_version: { type: 'string', minLength: 1 } } },
  provider: { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: { provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 } } },
  target_vault: { type: 'object', additionalProperties: false, required: ['snapshot_tree_sha256', 'copy_roots', 'writer_fence'], properties: { snapshot_tree_sha256: { $ref: '#/$defs/digest' }, copy_roots: { type: 'object', additionalProperties: false, required: ['native', 'candidate'], properties: { native: ROOT, candidate: ROOT } }, writer_fence: { type: 'integer', minimum: 1 } } },
  workers: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['worker_id', 'key_id', 'public_key', 'source_identity_sha256', 'allowed_partition'], properties: { worker_id: { $ref: '#/$defs/id' }, key_id: { $ref: '#/$defs/id' }, public_key: { type: 'string', minLength: 1 }, source_identity_sha256: { $ref: '#/$defs/digest' }, allowed_partition: { $ref: '#/$defs/id' } } } },
  prior_replay_ledger_sha256: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'run_id', 'job_id', 'created_at', 'authority', 'source_inventory', 'sources', 'runtime', 'settings', 'policy', 'provider', 'target_vault', 'workers', 'prior_replay_ledger_sha256', 'signature']);

export const sourceInventorySchema = schema('source-inventory', {
  contract_version: VERSION, inventory_id: { $ref: '#/$defs/id' }, authority: AUTHORITY,
  selector: { type: 'object', additionalProperties: false, required: ['version', 'include', 'exclusions'], properties: { version: { type: 'string', minLength: 1 }, include: { type: 'string', minLength: 1 }, exclusions: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } } },
  sources: SOURCE_LIST, inventory_sha256: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'inventory_id', 'authority', 'selector', 'sources', 'inventory_sha256']);

export const workerArtifactSchema = schema('worker-artifact', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, job_id: { $ref: '#/$defs/id' }, worker_id: { $ref: '#/$defs/id' },
  provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 }, started_at: { $ref: '#/$defs/dateTime' }, completed_at: { $ref: '#/$defs/dateTime' }, source: { $ref: '#/$defs/sourceIdentity' }, summary: { type: 'string' },
  proposals: { type: 'object', additionalProperties: false, required: ['entities', 'concepts'], properties: { entities: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true }, concepts: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } } },
  claims: { type: 'array', items: { $ref: '#/$defs/claim' } },
  attempts: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['attempt', 'provider', 'model', 'status', 'reason', 'delay_ms', 'input_tokens', 'output_tokens', 'billed_tokens', 'terminal'], properties: { attempt: { type: 'integer', minimum: 1 }, provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 }, status: { enum: ['success', 'retry', 'failed'] }, reason: { type: 'string' }, delay_ms: { type: 'integer', minimum: 0 }, input_tokens: NON_NEGATIVE, output_tokens: NON_NEGATIVE, billed_tokens: NON_NEGATIVE, terminal: { type: 'boolean' } } } },
  artifact_sha256: { $ref: '#/$defs/digest' }, terminal_status: { enum: ['succeeded', 'failed', 'cancelled'] }, signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'run_id', 'job_id', 'worker_id', 'provider', 'model', 'started_at', 'completed_at', 'source', 'summary', 'proposals', 'claims', 'attempts', 'artifact_sha256', 'terminal_status', 'signature']);

export const partitionManifestSchema = schema('partitions', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, fence: { type: 'integer', minimum: 1 },
  partitions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['partition_id', 'reducer_worker_id', 'fence', 'keys', 'load'], properties: { partition_id: { $ref: '#/$defs/id' }, reducer_worker_id: { $ref: '#/$defs/id' }, fence: { type: 'integer', minimum: 1 }, keys: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['canonical_key_id', 'page_type', 'normalization_version', 'normalized_label'], properties: { canonical_key_id: { $ref: '#/$defs/digest' }, page_type: { enum: ['entity', 'concept'] }, normalization_version: { type: 'string', minLength: 1 }, normalized_label: { type: 'string', minLength: 1 } } } }, load: { type: 'object', additionalProperties: false, required: ['key_count', 'claim_count'], properties: { key_count: NON_NEGATIVE, claim_count: NON_NEGATIVE } } } } },
  signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'run_id', 'fence', 'partitions', 'signature']);

export const candidatePlanSchema = schema('candidate-plan', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, fence: { type: 'integer', minimum: 1 }, snapshot_tree_sha256: { $ref: '#/$defs/digest' },
  targets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'action'], properties: { path: { $ref: '#/$defs/path' }, action: { enum: ['create', 'replace', 'delete'] }, expected_sha256: { $ref: '#/$defs/digest' }, content_sha256: { $ref: '#/$defs/digest' }, content_bytes: { type: 'string' } } } },
  plan_sha256: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'run_id', 'fence', 'snapshot_tree_sha256', 'targets', 'plan_sha256', 'signature']);

export const receiptSchema = schema('receipt', {
  contract_version: VERSION, receipt_id: { $ref: '#/$defs/id' }, receipt_type: { enum: ['native', 'candidate', 'comparison'] }, run_id: { $ref: '#/$defs/id' }, created_at: { $ref: '#/$defs/dateTime' }, status: { enum: ['accepted', 'rejected', 'restored'] }, writer_fence: { type: 'integer', minimum: 1 }, target_snapshot_sha256: { $ref: '#/$defs/digest' }, plan_sha256: { $ref: '#/$defs/digest' }, projection_sha256: { $ref: '#/$defs/digest' }, journal_sha256: { $ref: '#/$defs/digest' },
  counts: { type: 'object', propertyNames: { enum: RECEIPT_COUNT_KEYS }, additionalProperties: { type: 'integer', minimum: 0 } }, deltas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'materiality'], properties: { id: { $ref: '#/$defs/digest' }, materiality: { enum: ['semantic-preserving', 'semantic-addition', 'semantic-removal', 'qualification-change', 'disposition-change', 'identity-change', 'provenance-change', 'render-only', 'boilerplate-only'] }, disposition: { enum: ['evidenced', 'asserted', 'contested', 'unknown'] }, adjudication_id: { $ref: '#/$defs/digest' } } } },
  signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'receipt_id', 'receipt_type', 'run_id', 'created_at', 'status', 'writer_fence', 'target_snapshot_sha256', 'counts', 'signature']);

export const semanticProjectionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'spm-brain/headless/contracts/semantic-projection/v1', type: 'object', additionalProperties: false,
  required: ['schema_version', 'run_id', 'parser', 'nodes', 'edges'], properties: {
    schema_version: { const: 'semantic-projection/v1' }, run_id: { $ref: '#/$defs/id' },
    parser: { type: 'object', additionalProperties: false, required: ['version', 'source_sha256', 'grammar_sha256', 'unicode_sha256', 'boilerplate_policy_sha256'], properties: { version: { type: 'string', minLength: 1 }, source_sha256: { $ref: '#/$defs/digest' }, grammar_sha256: { $ref: '#/$defs/digest' }, unicode_sha256: { $ref: '#/$defs/digest' }, boilerplate_policy_sha256: { $ref: '#/$defs/digest' } } },
    nodes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'data'], properties: { id: { $ref: '#/$defs/digest' }, type: { enum: ['source', 'claim', 'alias', 'canonical-key', 'page-statement', 'adjudication'] }, data: { type: 'object' } } } },
    edges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'source_id', 'target_id', 'data'], properties: { id: { $ref: '#/$defs/digest' }, type: { enum: ['evidences', 'renders', 'nominates', 'contests', 'resolves'] }, source_id: { $ref: '#/$defs/digest' }, target_id: { $ref: '#/$defs/digest' }, data: { type: 'object' } } } },
  }, $defs: COMMON_DEFS,
} as JsonSchema;

export const terminalRootSchema = schema('terminal-run-root', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, root_sha256: { $ref: '#/$defs/digest' }, leaf_count: { type: 'integer', minimum: 1 },
  leaves: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['path', 'artifact_sha256', 'leaf_sha256'], properties: { path: { $ref: '#/$defs/path' }, artifact_sha256: { $ref: '#/$defs/digest' }, leaf_sha256: { $ref: '#/$defs/digest' } } } }, journal_sha256: { $ref: '#/$defs/digest' }, replay_ledger_sha256: { $ref: '#/$defs/digest' }, projection_comparison_sha256: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'run_id', 'root_sha256', 'leaf_count', 'leaves', 'journal_sha256', 'replay_ledger_sha256', 'projection_comparison_sha256', 'signature']);

export const preflightCaptureSchema = schema('preflight-capture', {
  contract_version: VERSION, capture_type: { enum: ['initial', 'live'] }, run_id: { $ref: '#/$defs/id' }, window_id: { $ref: '#/$defs/id' }, captured_at: { $ref: '#/$defs/dateTime' },
  vault: { type: 'object', additionalProperties: false, required: ['identity', 'root', 'snapshot_tree_sha256'], properties: { identity: { type: 'string', minLength: 1 }, root: ROOT, snapshot_tree_sha256: { $ref: '#/$defs/digest' } } }, idle: { const: true },
  hashes: { type: 'object', additionalProperties: false, required: ['authority_commit', 'authority_tree', 'runtime_sha256', 'schema_sha256', 'settings_sha256', 'safe_settings_projection_sha256'], properties: { authority_commit: { $ref: '#/$defs/digest' }, authority_tree: { $ref: '#/$defs/digest' }, runtime_sha256: { $ref: '#/$defs/digest' }, schema_sha256: { $ref: '#/$defs/digest' }, settings_sha256: { $ref: '#/$defs/digest' }, safe_settings_projection_sha256: { $ref: '#/$defs/digest' } } },
  copy_roots: { type: 'object', additionalProperties: false, required: ['native', 'candidate'], properties: { native: ROOT, candidate: ROOT } }, roots_outside_live_and_sync: { const: true },
  root_check: { type: 'object', additionalProperties: false, required: ['status', 'verifier_id', 'verified_at', 'max_age_seconds', 'live_root', 'copy_roots', 'containment_checked', 'signed_digest', 'signature'], properties: { status: { const: 'verified' }, verifier_id: { $ref: '#/$defs/id' }, verified_at: { $ref: '#/$defs/dateTime' }, max_age_seconds: { type: 'integer', minimum: 1, maximum: 60 }, live_root: ROOT, copy_roots: { type: 'object', additionalProperties: false, required: ['native', 'candidate'], properties: { native: ROOT, candidate: ROOT } }, containment_checked: { const: true }, signed_digest: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' } } },
  signature: { $ref: '#/$defs/signature' },
}, ['contract_version', 'capture_type', 'run_id', 'window_id', 'captured_at', 'vault', 'idle', 'hashes', 'copy_roots', 'roots_outside_live_and_sync', 'root_check', 'signature']);

export const replayLedgerSchema = schema('replay-ledger', {
  contract_version: VERSION, run_id: { $ref: '#/$defs/id' }, previous_global_checkpoint_sha256: { $ref: '#/$defs/digest' },
  entries: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['sequence', 'key_id', 'run_id', 'nonce', 'fence', 'previous_entry_sha256', 'entry_sha256', 'signature'], properties: { sequence: { type: 'integer', minimum: 1 }, key_id: { $ref: '#/$defs/id' }, run_id: { $ref: '#/$defs/id' }, nonce: SAFE_NONCE, fence: { type: 'integer', minimum: 1 }, previous_entry_sha256: { $ref: '#/$defs/digest' }, entry_sha256: { $ref: '#/$defs/digest' }, signature: { $ref: '#/$defs/signature' } } } },
  ledger_root_sha256: { $ref: '#/$defs/digest' },
}, ['contract_version', 'run_id', 'previous_global_checkpoint_sha256', 'entries', 'ledger_root_sha256']);

export const contractSchemas = {
  runManifest: runManifestSchema,
  sourceInventory: sourceInventorySchema,
  workerArtifact: workerArtifactSchema,
  partitionManifest: partitionManifestSchema,
  candidatePlan: candidatePlanSchema,
  receipt: receiptSchema,
  semanticProjection: semanticProjectionSchema,
  terminalRoot: terminalRootSchema,
  preflightCapture: preflightCaptureSchema,
  replayLedger: replayLedgerSchema,
} as const;

// Short aliases keep consumers from having to know whether a caller wants the
// document-style or implementation-style name.
export const runManifest = runManifestSchema;
export const sourceInventory = sourceInventorySchema;
export const workerArtifact = workerArtifactSchema;
export const partitionManifest = partitionManifestSchema;
export const candidatePlan = candidatePlanSchema;
export const receipt = receiptSchema;
export const semanticProjection = semanticProjectionSchema;
export const terminalRoot = terminalRootSchema;
export const preflightCapture = preflightCaptureSchema;
export const replayLedger = replayLedgerSchema;
export const schemas = contractSchemas;

export type ContractName = keyof typeof contractSchemas;
