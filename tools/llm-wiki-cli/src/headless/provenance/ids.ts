import {
  assertSha256Hex,
  assertByteRange,
  assertNonEmpty,
  hashDomain,
  normalizeLabel,
  normalizePath,
  sha256Hex,
  sortedUnique,
} from './canonical';
import {
  ADJUDICATION_DECISIONS,
  ADJUDICATION_RATIONALES,
  EVIDENCE_KINDS,
  EVIDENCE_REASONS,
  NORMALIZATION_VERSION,
  isAdjudicationDecision,
  isAdjudicationRationale,
  isEvidenceKind,
  isEvidenceReason,
} from './vocab';
import type {
  AdjudicationIdInput,
  AliasIdInput,
  CanonicalKeyIdInput,
  ClaimIdInput,
  EvidenceIdInput,
  PageStatementIdInput,
  ProjectionEdgeIdInput,
  SourceIdentityInput,
} from './types';

export const DOMAINS = Object.freeze({
  EVIDENCE_ID: 'spm-brain/evidence-id/v1',
  CLAIM_ID: 'spm-brain/claim-id/v1',
  SOURCE_IDENTITY: 'spm-brain/source-identity/v1',
  SOURCE_NODE_ID: 'spm-brain/source-node-id/v1',
  ALIAS_NODE_ID: 'spm-brain/alias-node-id/v1',
  CANONICAL_KEY_ID: 'spm-brain/canonical-key-id/v1',
  PAGE_STATEMENT_ID: 'spm-brain/page-statement-id/v1',
  ADJUDICATION_NODE_ID: 'spm-brain/adjudication-node-id/v1',
  PROJECTION_EDGE_ID: 'spm-brain/projection-edge-id/v1',
});

export const DOMAIN_SEPARATORS = Object.freeze({
  evidence: `${DOMAINS.EVIDENCE_ID}\0`,
  claim: `${DOMAINS.CLAIM_ID}\0`,
  sourceIdentity: `${DOMAINS.SOURCE_IDENTITY}\0`,
  sourceNode: `${DOMAINS.SOURCE_NODE_ID}\0`,
  aliasNode: `${DOMAINS.ALIAS_NODE_ID}\0`,
  canonicalKey: `${DOMAINS.CANONICAL_KEY_ID}\0`,
  pageStatement: `${DOMAINS.PAGE_STATEMENT_ID}\0`,
  adjudication: `${DOMAINS.ADJUDICATION_NODE_ID}\0`,
  projectionEdge: `${DOMAINS.PROJECTION_EDGE_ID}\0`,
});

export function evidenceId(input: EvidenceIdInput): string {
  if (!isEvidenceKind(input.kind)) throw new TypeError(`Invalid evidence kind: ${String(input.kind)}`);
  const reason = input.reasonCode ?? input.reason;
  if (!isEvidenceReason(reason)) throw new TypeError(`Invalid evidence reason: ${String(reason)}`);
  const authorityTree = input.authorityTree ?? input.authority_tree;
  assertNonEmpty('authority tree', authorityTree ?? '');
  const path = input.normalizedPath ?? input.normalized_path ?? input.sourcePath ?? input.source_path;
  const normalizedPath = normalizePath(path ?? '');
  const byteRange = input.byteRange ?? { start: input.byte_start ?? -1, end: input.byte_end ?? -1 };
  assertByteRange(byteRange);
  const original = input.originalSourceHash ?? input.original_sha256 ?? input.sourceHashes?.original;
  const canonical = input.canonicalSourceHash ?? input.canonical_sha256 ?? input.sourceHashes?.canonical;
  assertNonEmpty('original source hash', original ?? '');
  assertNonEmpty('canonical source hash', canonical ?? '');
  const exactBytes = input.exactCanonicalBytes ?? input.exact_canonical_bytes;
  const exactByteHash = input.exactByteHash ?? input.exact_byte_hash ?? (exactBytes === undefined ? undefined : sha256Hex(Buffer.from(exactBytes, 'utf8')));
  const normalizationVersion = input.normalizationVersion ?? input.normalization_version;
  assertNonEmpty('exact byte hash', exactByteHash ?? '');
  assertNonEmpty('normalization version', normalizationVersion ?? '');
  return hashDomain(DOMAIN_SEPARATORS.evidence, {
    kind: input.kind,
    authority_tree: authorityTree,
    normalized_path: normalizedPath,
    source_hashes: { original, canonical },
    byte_range: byteRange,
    exact_byte_hash: exactByteHash,
    normalization_version: normalizationVersion,
    reason_code: reason,
  });
}

export const computeEvidenceId = evidenceId;

export function claimId(input: ClaimIdInput): string {
  const predicate = input.predicate;
  if (predicate === undefined || predicate === null || (typeof predicate === 'string' && predicate.length === 0)) throw new TypeError('predicate must be non-empty');
  const subjectKey = input.subjectKey ?? input.subject_key;
  if (subjectKey === undefined) throw new TypeError('subject key is required');
  if (input.object === undefined) throw new TypeError('claim object is required');
  const evidenceIds = input.evidenceIds ?? input.evidence_ids;
  if (!Array.isArray(evidenceIds)) throw new TypeError('evidence IDs must be an array');
  evidenceIds.forEach(id => assertNonEmpty('evidence ID', id));
  return hashDomain(DOMAIN_SEPARATORS.claim, {
    subject_key: subjectKey,
    predicate,
    object: input.object,
    evidence_ids: sortedUnique(evidenceIds),
  });
}

export const computeClaimId = claimId;

export function sourceIdentity(input: SourceIdentityInput): string {
  const authorityTree = input.authorityTree ?? input.authority_tree;
  const path = input.normalizedPath ?? input.normalized_path ?? input.path;
  const byteHash = input.byteHash ?? input.byte_hash ?? input.byte_sha256;
  assertNonEmpty('authority tree', authorityTree ?? '');
  if (authorityTree?.includes('\0')) throw new TypeError('authority tree must not contain NUL');
  assertNonEmpty('byte hash', byteHash ?? '');
  assertSha256Hex(byteHash ?? '', 'source byte hash');
  return hashDomain(DOMAIN_SEPARATORS.sourceIdentity, {
    authority_tree: authorityTree,
    normalized_path: normalizePath(path ?? ''),
    byte_hash: byteHash,
  });
}

export const sourceIdentityId = sourceIdentity;

export function sourceNodeId(input: SourceIdentityInput): string {
  const authorityTree = input.authorityTree ?? input.authority_tree;
  const path = input.normalizedPath ?? input.normalized_path ?? input.path;
  const byteHash = input.byteHash ?? input.byte_hash ?? input.byte_sha256;
  assertNonEmpty('authority tree', authorityTree ?? '');
  if (authorityTree?.includes('\0')) throw new TypeError('authority tree must not contain NUL');
  assertNonEmpty('byte hash', byteHash ?? '');
  assertSha256Hex(byteHash ?? '', 'source byte hash');
  return hashDomain(DOMAIN_SEPARATORS.sourceNode, {
    authority_tree: authorityTree,
    normalized_path: normalizePath(path ?? ''),
    byte_hash: byteHash,
  });
}

export function canonicalKeyId(input: CanonicalKeyIdInput): string {
  const pageType = input.pageType ?? input.page_type;
  const normalizedLabel = input.normalizedLabel ?? input.normalized_label;
  const normalizationVersion = input.normalizationVersion ?? input.normalization_version ?? NORMALIZATION_VERSION;
  assertNonEmpty('page type', pageType ?? '');
  assertNonEmpty('normalized label', normalizedLabel ?? '');
  return hashDomain(DOMAIN_SEPARATORS.canonicalKey, {
    page_type: pageType,
    normalization_version: normalizationVersion,
    normalized_label: normalizeLabel(normalizedLabel ?? ''),
  });
}

export const computeCanonicalKeyId = canonicalKeyId;

export function aliasNodeId(input: AliasIdInput): string {
  const normalizationVersion = input.normalizationVersion ?? input.normalization_version;
  const aliasLabel = input.normalizedAliasLabel ?? input.normalized_alias_label;
  const targetPageType = input.targetPageType ?? input.target_page_type;
  const canonicalKey = input.proposedCanonicalKeyId ?? input.proposed_canonical_key_id;
  const evidenceIds = input.evidenceIds ?? input.evidence_ids;
  assertNonEmpty('normalization version', normalizationVersion ?? '');
  assertNonEmpty('target page type', targetPageType ?? '');
  assertNonEmpty('proposed canonical key ID', canonicalKey ?? '');
  if (!Array.isArray(evidenceIds)) throw new TypeError('evidence IDs must be an array');
  evidenceIds.forEach(id => assertNonEmpty('evidence ID', id));
  return hashDomain(DOMAIN_SEPARATORS.aliasNode, {
    normalization_version: normalizationVersion,
    normalized_alias_label: normalizeLabel(aliasLabel ?? ''),
    target_page_type: targetPageType,
    proposed_canonical_key_id: canonicalKey,
    evidence_ids: sortedUnique(evidenceIds),
  });
}

export const computeAliasNodeId = aliasNodeId;

export function pageStatementId(input: PageStatementIdInput): string {
  const canonicalKeyIdValue = input.canonicalKeyId ?? input.canonical_key_id;
  const sectionPath = input.sectionPath ?? input.section_path;
  const statementKind = input.statementKind ?? input.statement_kind;
  const canonicalTextHash = input.canonicalTextHash ?? input.canonical_text_hash;
  assertNonEmpty('canonical key ID', canonicalKeyIdValue ?? '');
  assertNonEmpty('canonical text hash', canonicalTextHash ?? '');
  if (!Array.isArray(sectionPath)) throw new TypeError('section path must be an array');
  if (!statementKind) throw new TypeError('statement kind must be non-empty');
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new TypeError('statement ordinal must be a non-negative safe integer');
  return hashDomain(DOMAIN_SEPARATORS.pageStatement, {
    canonical_key_id: canonicalKeyIdValue,
    section_path: [...sectionPath],
    statement_kind: statementKind,
    ordinal: input.ordinal,
    canonical_text_hash: canonicalTextHash,
  });
}

export const computePageStatementId = pageStatementId;

export function adjudicationNodeId(input: AdjudicationIdInput): string {
  const authoritySnapshotId = input.authoritySnapshotId ?? input.authority_snapshot_id;
  const claimIds = input.claimIds ?? input.claim_ids;
  const evidenceIds = input.evidenceIds ?? input.evidence_ids;
  const sourceRevision = input.sourceRevision ?? input.source_revision;
  const decisionCode = input.decisionCode ?? input.decision_code;
  const rationaleCode = input.rationaleCode ?? input.rationale_code;
  assertNonEmpty('authority snapshot ID', authoritySnapshotId ?? '');
  assertNonEmpty('source revision', sourceRevision ?? '');
  if (!isAdjudicationDecision(decisionCode)) throw new TypeError(`Invalid adjudication decision: ${String(decisionCode)}`);
  if (!isAdjudicationRationale(rationaleCode)) throw new TypeError(`Invalid adjudication rationale: ${String(rationaleCode)}`);
  if (!Array.isArray(claimIds) || !Array.isArray(evidenceIds)) throw new TypeError('claim and evidence IDs must be arrays');
  claimIds.forEach(id => assertNonEmpty('claim ID', id));
  evidenceIds.forEach(id => assertNonEmpty('evidence ID', id));
  return hashDomain(DOMAIN_SEPARATORS.adjudication, {
    authority_snapshot_id: authoritySnapshotId,
    claim_ids: sortedUnique(claimIds),
    evidence_ids: sortedUnique(evidenceIds),
    source_revision: sourceRevision,
    decision_code: decisionCode,
    rationale_code: rationaleCode,
  });
}

export const computeAdjudicationNodeId = adjudicationNodeId;

export function projectionEdgeId(input: ProjectionEdgeIdInput): string {
  assertNonEmpty('edge kind', input.edgeKind);
  assertNonEmpty('source ID', input.sourceId);
  assertNonEmpty('target ID', input.targetId);
  return hashDomain(DOMAIN_SEPARATORS.projectionEdge, {
    edge_kind: input.edgeKind,
    source_id: input.sourceId,
    target_id: input.targetId,
    payload: input.payload,
  });
}

export const computeProjectionEdgeId = projectionEdgeId;

export { ADJUDICATION_DECISIONS, ADJUDICATION_RATIONALES, EVIDENCE_KINDS, EVIDENCE_REASONS };
