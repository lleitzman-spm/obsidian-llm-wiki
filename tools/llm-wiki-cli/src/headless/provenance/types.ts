import {
  ADJUDICATION_DECISIONS,
  ADJUDICATION_RATIONALES,
  ALIAS_STATES,
  DISPOSITIONS,
  EVIDENCE_KINDS,
  EVIDENCE_REASONS,
  MATERIALITIES,
} from './vocab';

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];
export type Disposition = (typeof DISPOSITIONS)[number];
export type AliasState = (typeof ALIAS_STATES)[number];
export type AdjudicationDecision = (typeof ADJUDICATION_DECISIONS)[number];
export type AdjudicationRationale = (typeof ADJUDICATION_RATIONALES)[number];
export type Materiality = (typeof MATERIALITIES)[number];
export type PageStatementKind = 'sentence' | 'paragraph' | 'list-item' | 'table-cell' | 'heading' | 'code-block';
export type RenderRole = 'supports' | 'qualifies' | 'contests';
export type ProjectionEdgeKind = 'evidences' | 'renders' | 'nominates' | 'contests' | 'resolves';

export interface ByteRange {
  start: number;
  end: number;
}

export interface EvidenceIdInput {
  kind: EvidenceKind;
  reasonCode?: EvidenceReason;
  reason?: EvidenceReason;
  authorityTree?: string;
  authority_tree?: string;
  normalizedPath?: string;
  normalized_path?: string;
  sourcePath?: string;
  source_path?: string;
  originalSourceHash?: string;
  canonicalSourceHash?: string;
  sourceHashes?: { original: string; canonical: string };
  original_sha256?: string;
  canonical_sha256?: string;
  byteRange?: ByteRange;
  byte_start?: number;
  byte_end?: number;
  exactByteHash?: string;
  exact_byte_hash?: string;
  exactCanonicalBytes?: string;
  exact_canonical_bytes?: string;
  normalizationVersion?: string;
  normalization_version?: string;
}

export interface ClaimIdInput {
  subjectKey?: unknown;
  subject_key?: unknown;
  predicate?: string | unknown;
  object?: unknown;
  evidenceIds?: readonly string[];
  evidence_ids?: readonly string[];
}

export interface SourceIdentityInput {
  authorityTree?: string;
  authority_tree?: string;
  normalizedPath?: string;
  normalized_path?: string;
  path?: string;
  byteHash?: string;
  byte_hash?: string;
  byte_sha256?: string;
}

export interface CanonicalKeyIdInput {
  pageType?: string;
  page_type?: string;
  normalizedLabel?: string;
  normalized_label?: string;
  normalizationVersion?: string;
  normalization_version?: string;
}

export interface AliasIdInput {
  normalizationVersion?: string;
  normalization_version?: string;
  normalizedAliasLabel?: string;
  normalized_alias_label?: string;
  targetPageType?: string;
  target_page_type?: string;
  proposedCanonicalKeyId?: string;
  proposed_canonical_key_id?: string;
  evidenceIds?: readonly string[];
  evidence_ids?: readonly string[];
}

export interface PageStatementIdInput {
  canonicalKeyId?: string;
  canonical_key_id?: string;
  sectionPath?: readonly string[];
  section_path?: readonly string[];
  statementKind?: PageStatementKind;
  statement_kind?: PageStatementKind;
  ordinal: number;
  canonicalTextHash?: string;
  canonical_text_hash?: string;
}

export interface AdjudicationIdInput {
  authoritySnapshotId?: string;
  authority_snapshot_id?: string;
  claimIds?: readonly string[];
  claim_ids?: readonly string[];
  evidenceIds?: readonly string[];
  evidence_ids?: readonly string[];
  sourceRevision?: string;
  source_revision?: string;
  decisionCode?: AdjudicationDecision;
  decision_code?: AdjudicationDecision;
  rationaleCode?: AdjudicationRationale;
  rationale_code?: AdjudicationRationale;
}

export interface ProjectionEdgeIdInput {
  edgeKind: ProjectionEdgeKind;
  sourceId: string;
  targetId: string;
  payload: unknown;
}

export interface SourceNode {
  nodeType: 'source';
  id: string;
  authorityTree: string;
  normalizedPath: string;
  byteHash: string;
}

export interface ClaimNode {
  nodeType: 'claim';
  id: string;
  subjectKey: unknown;
  predicate: string;
  object: unknown;
  disposition: Disposition;
}

export interface AliasNode {
  nodeType: 'alias';
  id: string;
  normalizationVersion: string;
  normalizedAliasLabel: string;
  targetPageType: string;
  proposedCanonicalKeyId: string;
  evidenceIds: string[];
  state: AliasState;
}

export interface CanonicalKeyNode {
  nodeType: 'canonical-key';
  id: string;
  pageType: string;
  normalizationVersion: string;
  normalizedLabel: string;
}

export interface PageStatementNode {
  nodeType: 'page-statement';
  id: string;
  canonicalKeyId: string;
  sectionPath: string[];
  statementKind: PageStatementKind;
  ordinal: number;
  canonicalTextHash: string;
}

export interface AdjudicationNode {
  nodeType: 'adjudication';
  id: string;
  authoritySnapshotId: string;
  claimIds: string[];
  evidenceIds: string[];
  sourceRevision: string;
  decisionCode: AdjudicationDecision;
  rationaleCode: AdjudicationRationale;
}

export type ProjectionNode =
  | SourceNode
  | ClaimNode
  | AliasNode
  | CanonicalKeyNode
  | PageStatementNode
  | AdjudicationNode;

export interface ProjectionEdge {
  edgeKind: ProjectionEdgeKind;
  id: string;
  sourceId: string;
  targetId: string;
  payload: Record<string, unknown>;
}

export interface SemanticProjection {
  schema: 'semantic-projection/v1';
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
}

/** On-disk shape consumed by the headless contract validator. */
export interface ContractSemanticProjection {
  schema_version: 'semantic-projection/v1';
  run_id: string;
  parser: {
    version: string;
    source_sha256: string;
    grammar_sha256: string;
    unicode_sha256: string;
    boilerplate_policy_sha256: string;
  };
  nodes: Array<{ id: string; type: ProjectionNode['nodeType']; data: Record<string, unknown> }>;
  edges: Array<{ id: string; type: ProjectionEdgeKind; source_id: string; target_id: string; data: Record<string, unknown> }>;
}
