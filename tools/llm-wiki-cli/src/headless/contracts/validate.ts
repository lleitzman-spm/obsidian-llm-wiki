import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

import {
  contractSchemas,
  type ContractName,
  type JsonSchema,
} from './schemas';

export interface ContractValidationError {
  instancePath: string;
  keyword: string;
  message: string;
  params?: Record<string, unknown>;
}

export type ContractValidationResult<T = unknown> =
  | { valid: true; data: T; errors: [] }
  | { valid: false; data: T; errors: ContractValidationError[] };

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addFormat('date-time', { type: 'string', validate: (value: string) => !Number.isNaN(Date.parse(value)) && /T/.test(value) });
ajv.addFormat('uri', { type: 'string', validate: (value: string) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) });

const compiled = new Map<ContractName, ValidateFunction>();
for (const [name, contractSchema] of Object.entries(contractSchemas) as Array<[ContractName, JsonSchema]>) {
  compiled.set(name, ajv.compile(contractSchema));
}

function ajvErrors(errors: ErrorObject[] | null | undefined): ContractValidationError[] {
  return (errors ?? []).map(error => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
    params: error.params as Record<string, unknown>,
  }));
}

function semanticError(instancePath: string, message: string, keyword = 'contract'): ContractValidationError {
  return { instancePath, keyword, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function pathSortKey(value: Record<string, unknown>): string {
  return String(value.path ?? '');
}

function sortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value) && new Set(values).size === values.length;
}

function semanticChecks(name: ContractName, value: unknown): ContractValidationError[] {
  if (!isRecord(value)) return [];
  const errors: ContractValidationError[] = [];

  if (name === 'runManifest' || name === 'sourceInventory') {
    const sources = Array.isArray(value.sources) ? value.sources : [];
    const paths = sources.map(source => isRecord(source) ? String(source.path) : '');
    const identities = sources.map(source => isRecord(source) ? String(source.source_identity_sha256) : '');
    if (!sortedUnique(paths)) errors.push(semanticError('/sources', 'source paths must be strictly sorted and unique', 'orderedUnique'));
    if (new Set(identities).size !== identities.length) errors.push(semanticError('/sources', 'source identities must be unique', 'uniqueItems'));
    if (name === 'runManifest') {
      const workers = Array.isArray(value.workers) ? value.workers : [];
      const workerSourceIds = workers.map(worker => isRecord(worker) ? String(worker.source_identity_sha256) : '');
      if (new Set(workerSourceIds).size !== workerSourceIds.length) errors.push(semanticError('/workers', 'worker bindings must not duplicate a source identity', 'uniqueItems'));
      const sourceSet = new Set(identities);
      for (let i = 0; i < workerSourceIds.length; i += 1) {
        if (!sourceSet.has(workerSourceIds[i])) errors.push(semanticError(`/workers/${i}/source_identity_sha256`, 'worker source is not present in the manifest source set', 'referentialIntegrity'));
      }
    }
  }

  if (name === 'workerArtifact') {
    const source = isRecord(value.source) ? value.source : {};
    const claims = Array.isArray(value.claims) ? value.claims : [];
    const claimIds = claims.map(claim => isRecord(claim) ? String(claim.claim_id) : '');
    if (new Set(claimIds).size !== claimIds.length) errors.push(semanticError('/claims', 'claim IDs must be unique within an artifact', 'uniqueItems'));
    const attempts = Array.isArray(value.attempts) ? value.attempts : [];
    const terminals = attempts.filter(attempt => isRecord(attempt) && attempt.terminal === true);
    if (terminals.length !== 1) errors.push(semanticError('/attempts', 'exactly one terminal provider attempt is required', 'terminalAttempt'));
    if (value.terminal_status === 'succeeded' && terminals.some(attempt => attempt.status !== 'success')) errors.push(semanticError('/terminal_status', 'a succeeded artifact requires a successful terminal attempt', 'terminalAttempt'));
    for (let i = 0; i < claims.length; i += 1) {
      const claim = isRecord(claims[i]) ? claims[i] : {};
      const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      if (claim.disposition !== 'unknown' && evidence.length === 0) errors.push(semanticError(`/claims/${i}/evidence`, 'non-unknown claims require exact evidence', 'evidenceRequired'));
      for (let j = 0; j < evidence.length; j += 1) {
        const item = isRecord(evidence[j]) ? evidence[j] : {};
        if (item.source_path !== source.path) errors.push(semanticError(`/claims/${i}/evidence/${j}/source_path`, 'evidence source path must equal the artifact source path', 'sourceBinding'));
        if (typeof item.byte_start === 'number' && typeof item.byte_end === 'number' && item.byte_end <= item.byte_start) errors.push(semanticError(`/claims/${i}/evidence/${j}/byte_end`, 'byte_end must be greater than byte_start', 'range'));
        if (item.kind === 'quote' && item.reason !== 'direct-quote') errors.push(semanticError(`/claims/${i}/evidence/${j}/reason`, 'quote evidence must use direct-quote', 'eligibility'));
        if (item.kind === 'heading' && !['defines-scope', 'defines-status'].includes(String(item.reason))) errors.push(semanticError(`/claims/${i}/evidence/${j}`, 'heading evidence may only establish scope or status', 'eligibility'));
        if (item.kind === 'code-block' && !['defines-control', 'defines-metric'].includes(String(item.reason))) errors.push(semanticError(`/claims/${i}/evidence/${j}`, 'code-block evidence may only establish control or metric', 'eligibility'));
      }
    }
  }

  if (name === 'partitionManifest') {
    const partitions = Array.isArray(value.partitions) ? value.partitions : [];
    const partitionIds = partitions.map(partition => isRecord(partition) ? String(partition.partition_id) : '');
    if (new Set(partitionIds).size !== partitionIds.length) errors.push(semanticError('/partitions', 'partition IDs must be unique', 'uniqueItems'));
    const keyIds: string[] = [];
    for (let i = 0; i < partitions.length; i += 1) {
      const partition = isRecord(partitions[i]) ? partitions[i] : {};
      if (partition.fence !== value.fence) errors.push(semanticError(`/partitions/${i}/fence`, 'partition fence must equal the manifest fence', 'fence'));
      const keys = Array.isArray(partition.keys) ? partition.keys : [];
      const sortKeys = keys.map((key: unknown) => isRecord(key) ? `${String(key.page_type)}\u0000${String(key.normalized_label)}` : '');
      if (!sortedUnique(sortKeys)) errors.push(semanticError(`/partitions/${i}/keys`, 'keys must be strictly sorted by page type and normalized label', 'orderedUnique'));
      for (const key of keys) if (isRecord(key)) keyIds.push(String(key.canonical_key_id));
      const load = isRecord(partition.load) ? partition.load : {};
      if (load.key_count !== keys.length) errors.push(semanticError(`/partitions/${i}/load/key_count`, 'key_count must equal the partition key count', 'count'));
    }
    if (new Set(keyIds).size !== keyIds.length) errors.push(semanticError('/partitions', 'a canonical key may have only one reducer owner', 'uniqueItems'));
  }

  if (name === 'candidatePlan') {
    const targets = Array.isArray(value.targets) ? value.targets : [];
    const paths = targets.map(target => isRecord(target) ? pathSortKey(target) : '');
    if (!sortedUnique(paths)) errors.push(semanticError('/targets', 'target paths must be strictly sorted and unique', 'orderedUnique'));
    for (let i = 0; i < targets.length; i += 1) {
      const target = isRecord(targets[i]) ? targets[i] : {};
      if ((target.action === 'create' || target.action === 'replace') && (!digest(target.content_sha256) || typeof target.content_bytes !== 'string')) errors.push(semanticError(`/targets/${i}`, 'create and replace targets require content bytes and content_sha256', 'completeTarget'));
      if (target.action === 'delete' && !digest(target.expected_sha256)) errors.push(semanticError(`/targets/${i}/expected_sha256`, 'delete targets require the expected precondition hash', 'precondition'));
    }
  }

  if (name === 'receipt') {
    if (value.receipt_type === 'comparison' && (!digest(value.projection_sha256) || !Array.isArray(value.deltas))) errors.push(semanticError('/', 'comparison receipts require a projection hash and typed deltas', 'comparisonComplete'));
    const safeMateriality = new Set(['semantic-preserving', 'render-only', 'boilerplate-only']);
    const deltas = Array.isArray(value.deltas) ? value.deltas : [];
    for (let i = 0; i < deltas.length; i += 1) {
      const delta = isRecord(deltas[i]) ? deltas[i] : {};
      if (!safeMateriality.has(String(delta.materiality)) && !id(delta.disposition) && !digest(delta.adjudication_id)) errors.push(semanticError(`/deltas/${i}`, 'material semantic deltas require a disposition or adjudication receipt', 'materialityAuthorization'));
    }
  }

  if (name === 'semanticProjection') {
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    const edges = Array.isArray(value.edges) ? value.edges : [];
    const nodeIds = nodes.map(node => isRecord(node) ? String(node.id) : '');
    const edgeIds = edges.map(edge => isRecord(edge) ? String(edge.id) : '');
    if (new Set(nodeIds).size !== nodeIds.length) errors.push(semanticError('/nodes', 'node IDs must be unique', 'uniqueItems'));
    if (!sortedUnique(nodeIds)) errors.push(semanticError('/nodes', 'nodes must be sorted by ID', 'ordered'));
    if (new Set(edgeIds).size !== edgeIds.length) errors.push(semanticError('/edges', 'edge IDs must be unique', 'uniqueItems'));
    if (!sortedUnique(edgeIds)) errors.push(semanticError('/edges', 'edges must be sorted by ID', 'ordered'));
    const nodeType = new Map<string, string>();
    for (const node of nodes) if (isRecord(node)) nodeType.set(String(node.id), String(node.type));
    const legal: Record<string, [string, string]> = { evidences: ['source', 'claim'], renders: ['claim', 'page-statement'], nominates: ['alias', 'canonical-key'], contests: ['claim', 'claim'], resolves: ['adjudication', 'claim'] };
    for (let i = 0; i < edges.length; i += 1) {
      const edge = isRecord(edges[i]) ? edges[i] : {};
      const sourceType = nodeType.get(String(edge.source_id)); const targetType = nodeType.get(String(edge.target_id));
      const expected = legal[String(edge.type)]; const data = isRecord(edge.data) ? edge.data : {};
      if (!sourceType || !targetType) errors.push(semanticError(`/edges/${i}`, 'edge endpoints must reference existing nodes', 'referentialIntegrity'));
      if (expected && (sourceType !== expected[0] || targetType !== expected[1])) errors.push(semanticError(`/edges/${i}`, `edge ${String(edge.type)} has an illegal endpoint type pair`, 'edgeMatrix'));
      if (edge.source_id === edge.target_id) errors.push(semanticError(`/edges/${i}`, 'self-edges are not permitted', 'selfEdge'));
      if (edge.type === 'evidences' && (!Array.isArray(data.evidence_ids) || !sortedUnique(data.evidence_ids.map(String)))) errors.push(semanticError(`/edges/${i}/data/evidence_ids`, 'evidence_ids must be sorted and duplicate-free', 'orderedUnique'));
      if (edge.type === 'renders' && !['supports', 'qualifies', 'contests'].includes(String(data.render_role))) errors.push(semanticError(`/edges/${i}/data/render_role`, 'render_role is a closed enum', 'enum'));
      if (edge.type === 'nominates' && !['speculative', 'grounded', 'adjudicated'].includes(String(data.alias_state))) errors.push(semanticError(`/edges/${i}/data/alias_state`, 'alias_state is a closed enum', 'enum'));
      if (edge.type === 'contests' && (!Array.isArray(data.conflict_evidence_ids) || !sortedUnique(data.conflict_evidence_ids.map(String)))) errors.push(semanticError(`/edges/${i}/data/conflict_evidence_ids`, 'conflict_evidence_ids must be sorted and duplicate-free', 'orderedUnique'));
      if (edge.type === 'resolves' && typeof data.active_view !== 'boolean') errors.push(semanticError(`/edges/${i}/data/active_view`, 'active_view must be boolean', 'type'));
    }
  }

  if (name === 'terminalRoot') {
    const leaves = Array.isArray(value.leaves) ? value.leaves : [];
    const paths = leaves.map(leaf => isRecord(leaf) ? String(leaf.path) : '');
    if (value.leaf_count !== leaves.length) errors.push(semanticError('/leaf_count', 'leaf_count must equal leaves.length', 'count'));
    if (!sortedUnique(paths)) errors.push(semanticError('/leaves', 'Merkle leaves must be sorted by normalized relative path and unique', 'orderedUnique'));
    if (paths.some(path => path === 'terminal-run-root.json' || path === 'verify.json')) errors.push(semanticError('/leaves', 'terminal root and verify.json cannot be Merkle leaves', 'scope'));
    if (value.signature && isRecord(value.signature) && value.signature.signed_digest !== value.root_sha256) errors.push(semanticError('/signature/signed_digest', 'terminal signature must bind root_sha256', 'binding'));
  }

  if (name === 'preflightCapture') {
    const vault = isRecord(value.vault) ? value.vault : {};
    const copies = isRecord(value.copy_roots) ? value.copy_roots : {};
    if (copies.native === copies.candidate) errors.push(semanticError('/copy_roots', 'native and candidate roots must be distinct', 'distinctRoots'));
    if (copies.native === vault.root || copies.candidate === vault.root) errors.push(semanticError('/copy_roots', 'copy roots must not equal the observed live vault root', 'liveContainment'));
    const rootCheck = isRecord(value.root_check) ? value.root_check : {};
    const checkedCopies = isRecord(rootCheck.copy_roots) ? rootCheck.copy_roots : {};
    if (rootCheck.live_root !== undefined && rootCheck.live_root !== vault.root) errors.push(semanticError('/root_check/live_root', 'signed root-check live_root must equal the captured vault root', 'binding'));
    if (checkedCopies.native !== undefined && checkedCopies.native !== copies.native) errors.push(semanticError('/root_check/copy_roots/native', 'signed root-check native root must equal the captured native root', 'binding'));
    if (checkedCopies.candidate !== undefined && checkedCopies.candidate !== copies.candidate) errors.push(semanticError('/root_check/copy_roots/candidate', 'signed root-check candidate root must equal the captured candidate root', 'binding'));
    if (rootCheck.signature && isRecord(rootCheck.signature) && rootCheck.signature.signed_digest !== rootCheck.signed_digest) errors.push(semanticError('/root_check/signature/signed_digest', 'root-check signature must bind root_check.signed_digest', 'binding'));
  }

  if (name === 'replayLedger') {
    const entries = Array.isArray(value.entries) ? value.entries : [];
    const tuples = new Set<string>();
    for (let i = 0; i < entries.length; i += 1) {
      const entry = isRecord(entries[i]) ? entries[i] : {};
      if (entry.sequence !== i + 1) errors.push(semanticError(`/entries/${i}/sequence`, 'ledger sequence must be contiguous and append-only', 'sequence'));
      if (entry.run_id !== value.run_id) errors.push(semanticError(`/entries/${i}/run_id`, 'ledger entry run_id must equal the ledger run_id', 'runBinding'));
      const tuple = `${String(entry.key_id)}\u0000${String(entry.run_id)}\u0000${String(entry.nonce)}\u0000${String(entry.fence)}`;
      if (tuples.has(tuple)) errors.push(semanticError(`/entries/${i}`, 'duplicate key_id/run_id/nonce/fence replay tuple', 'replay'));
      tuples.add(tuple);
      if (i === 0 && entry.previous_entry_sha256 !== value.previous_global_checkpoint_sha256) errors.push(semanticError(`/entries/${i}/previous_entry_sha256`, 'first entry must bind the manifest global checkpoint', 'chain'));
      if (i > 0 && entry.previous_entry_sha256 !== entries[i - 1]?.entry_sha256) errors.push(semanticError(`/entries/${i}/previous_entry_sha256`, 'entry hash chain is broken', 'chain'));
      if (entry.signature && isRecord(entry.signature) && entry.signature.signed_digest !== entry.entry_sha256) errors.push(semanticError(`/entries/${i}/signature/signed_digest`, 'entry signature must bind entry_sha256', 'binding'));
    }
  }

  return errors;
}

export function validateContract<T = unknown>(name: ContractName, value: unknown): ContractValidationResult<T> {
  const validator = compiled.get(name);
  if (!validator) throw new Error(`Unknown headless-ingest contract: ${name}`);
  const valid = validator(value);
  const errors = [...ajvErrors(validator.errors), ...semanticChecks(name, value)];
  if (!valid || errors.length > 0) return { valid: false, data: value as T, errors };
  return { valid: true, data: value as T, errors: [] };
}

export function assertValidContract<T = unknown>(name: ContractName, value: unknown): T {
  const result = validateContract<T>(name, value);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Invalid ${name} contract: ${detail}`);
  }
  return result.data;
}

export function isValidContract(name: ContractName, value: unknown): boolean {
  return validateContract(name, value).valid;
}

/**
 * Structural preflight validation is deliberately not execution eligibility.
 * The boolean `roots_outside_live_and_sync` is an assertion carried in the
 * artifact; it is never accepted as proof. Callers must supply a fresh
 * signed root-check and re-run actual filesystem/sync containment themselves.
 */
export interface PreflightExecutionValidationOptions {
  now?: Date | string;
  maxAgeSeconds?: number;
  verifyContainment: (capture: unknown) => boolean;
}

export function validatePreflightCaptureForExecution<T = unknown>(
  value: unknown,
  options: PreflightExecutionValidationOptions,
): ContractValidationResult<T> {
  const structural = validateContract<T>('preflightCapture', value);
  if (!structural.valid) return structural;
  const errors: ContractValidationError[] = [];
  const capture = structural.data as unknown as Record<string, unknown>;
  const rootCheck = capture.root_check as Record<string, unknown>;
  const verifiedAt = Date.parse(String(rootCheck.verified_at));
  const nowValue = options.now ?? new Date();
  const now = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const requestedMaxAge = options.maxAgeSeconds ?? 60;
  const rootMaxAge = Number(rootCheck.max_age_seconds);
  const maxAge = Math.min(requestedMaxAge, rootMaxAge, 60);
  if (!Number.isFinite(now) || !Number.isFinite(verifiedAt)) errors.push(semanticError('/root_check/verified_at', 'root-check freshness cannot be established', 'freshness'));
  else {
    const ageSeconds = (now - verifiedAt) / 1000;
    if (ageSeconds < 0 || ageSeconds > maxAge) errors.push(semanticError('/root_check/verified_at', `signed root-check must be no older than ${maxAge} seconds`, 'freshness'));
  }
  try {
    if (options.verifyContainment(capture) !== true) errors.push(semanticError('/root_check', 'actual live/sync containment re-check failed', 'liveContainment'));
  } catch {
    errors.push(semanticError('/root_check', 'actual live/sync containment re-check failed', 'liveContainment'));
  }
  if (errors.length > 0) return { valid: false, data: structural.data, errors };
  return structural;
}

export function assertPreflightCaptureForExecution<T = unknown>(value: unknown, options: PreflightExecutionValidationOptions): T {
  const result = validatePreflightCaptureForExecution<T>(value, options);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Preflight is not execution-eligible: ${detail}`);
  }
  return result.data;
}

export const validateRunManifest = <T = unknown>(value: unknown) => validateContract<T>('runManifest', value);
export const validateSourceInventory = <T = unknown>(value: unknown) => validateContract<T>('sourceInventory', value);
export const validateWorkerArtifact = <T = unknown>(value: unknown) => validateContract<T>('workerArtifact', value);
export const validatePartitionManifest = <T = unknown>(value: unknown) => validateContract<T>('partitionManifest', value);
export const validateCandidatePlan = <T = unknown>(value: unknown) => validateContract<T>('candidatePlan', value);
export const validateReceipt = <T = unknown>(value: unknown) => validateContract<T>('receipt', value);
export const validateSemanticProjection = <T = unknown>(value: unknown) => validateContract<T>('semanticProjection', value);
export const validateTerminalRoot = <T = unknown>(value: unknown) => validateContract<T>('terminalRoot', value);
export const validatePreflightCapture = <T = unknown>(value: unknown) => validateContract<T>('preflightCapture', value);
export const validatePreflightCaptureExecution = validatePreflightCaptureForExecution;
export const validateReplayLedger = <T = unknown>(value: unknown) => validateContract<T>('replayLedger', value);
