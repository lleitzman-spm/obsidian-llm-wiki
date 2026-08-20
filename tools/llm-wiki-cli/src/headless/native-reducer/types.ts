/**
 * Source-scoped intermediate representation consumed by the native reducer.
 *
 * This boundary deliberately contains no Obsidian types and no filesystem
 * handles.  A map worker may produce one IR record per source (and any number
 * of proposals inside it); reduction is the first place where proposals from
 * different sources are allowed to meet.
 */

export type NativePageType = 'entity' | 'concept';
export type NativeEvidenceRole = 'supports' | 'qualifies' | 'contests';
export type NativeReductionStatus = 'candidate' | 'requires-native-comparison';
export type NativePageKind = NativePageType | 'source' | 'index' | 'log' | 'schema';
export type NativeDesiredAction = 'create' | 'replace' | 'unchanged';

export interface NativeByteRange {
  readonly start: number;
  readonly end: number;
}

/** A typed evidence item.  Qualification and contestation are not flattened. */
export interface NativeEvidence {
  readonly evidenceId: string;
  readonly role?: NativeEvidenceRole;
  readonly quote?: string;
  readonly sourcePath?: string;
  readonly sourceSlug?: string;
  readonly sourceId?: string;
  readonly byteRange?: NativeByteRange;
}

/** A claim/statement and its evidence role. */
export interface NativeStatement {
  readonly statementId: string;
  readonly text: string;
  readonly role?: NativeEvidenceRole;
  readonly evidenceIds?: readonly string[];
}

export interface NativeRelatedProposal {
  readonly pageType: NativePageType;
  readonly label: string;
}

/**
 * One source-local extraction result.  `body` is an optional provider/page
 * candidate; it is never trusted as a source of identity, paths, or
 * frontmatter.  Those are derived below from the typed fields.
 */
export interface NativePageProposal {
  readonly proposalId: string;
  readonly sourceId: string;
  readonly pageType: NativePageType;
  readonly label: string;
  readonly typeTag?: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly body?: string;
  readonly reviewed?: boolean;
  readonly statements?: readonly NativeStatement[];
  readonly qualifications?: readonly NativeStatement[];
  readonly evidence?: readonly NativeEvidence[];
  readonly related?: readonly NativeRelatedProposal[];
  /** Legacy native IR fields retained as typed input for adapter callers. */
  readonly relatedEntities?: readonly string[];
  readonly relatedConcepts?: readonly string[];
  readonly mentions?: readonly NativeEvidence[];
}

export interface NativeSourcePage {
  readonly title?: string;
  readonly body?: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly reviewed?: boolean;
}

/** Source identity is authority-bound before this reducer is called. */
export interface NativeSourceScopedIR {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceSlug: string;
  /** Sealed UTF-8 source body used by the native source-page contentHash tail. */
  readonly sourceContent?: string;
  readonly sourceTitle?: string;
  readonly sourceSummary?: string;
  readonly sourceBody?: string;
  readonly sourceAliases?: readonly string[];
  readonly sourceTags?: readonly string[];
  readonly sourcePage?: NativeSourcePage;
  readonly proposals: readonly NativePageProposal[];
  /** Adapter-level refusals remain visible in the final comparison plan. */
  readonly unsupported?: readonly string[];
}

export interface NativeExistingPage {
  readonly path: string;
  readonly pageType: NativePageKind;
  readonly label?: string;
  readonly content: string;
  readonly reviewed?: boolean;
}

export interface NativeGlobalPaths {
  readonly index: string;
  readonly log: string;
  readonly schema: string;
}

export interface NativeGlobalInput {
  readonly paths: NativeGlobalPaths;
  /** Stable run identity used only in the deterministic log entry. */
  readonly runId: string;
  /** The native schema body is supplied by the caller, never invented here. */
  readonly schemaContent: string;
  /** Optional existing global bodies, useful when constructing a comparison. */
  readonly existing?: ReadonlyMap<string, string>;
}

export interface NativeReducerOptions {
  readonly wikiFolder: string;
  readonly global: NativeGlobalInput;
  /** Native language used by the index/log planners; defaults to native English labels. */
  readonly wikiLanguage?: string;
  /** Sealed HH:MM run time required by the native log planner. */
  readonly time?: string;
  /** Optional source bytes decoded as UTF-8, keyed by normalized source path. */
  readonly sourceContents?: ReadonlyMap<string, string>;
  /** Use the native default (lowercase) unless preserve-case is explicit. */
  readonly slugCase?: 'lower' | 'preserve';
  /** Stable date supplied by the run manifest; no wall-clock reads occur. */
  readonly date: string;
  readonly existingPages?: readonly NativeExistingPage[];
  readonly existingFiles?: ReadonlyMap<string, string>;
}

export interface NativeCanonicalKey {
  readonly pageType: NativePageType;
  readonly normalizedLabel: string;
  readonly keyString: string;
}

export interface NativePageCandidate {
  readonly key: NativeCanonicalKey;
  readonly path: string;
  readonly pageType: NativePageType;
  readonly label: string;
  readonly sourceIds: readonly string[];
  readonly sourceLinks: readonly string[];
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly related: readonly NativeRelatedProposal[];
  readonly statements: readonly NativeStatement[];
  readonly qualifications: readonly NativeStatement[];
  readonly evidence: readonly NativeEvidence[];
  readonly reviewed: boolean;
  readonly bodyPolicy: 'generated' | 'preserve-reviewed' | 'append-reviewed' | 'preserve-existing';
  readonly content: string;
  readonly comparisonReasons: readonly string[];
}

export interface NativeDesiredFile {
  readonly path: string;
  readonly kind: NativePageKind;
  readonly phase: 'partition' | 'serialized-global';
  readonly action: NativeDesiredAction;
  readonly content: string;
  readonly desiredSha256: string;
  readonly currentSha256?: string;
  readonly sourceIds: readonly string[];
  readonly canonicalKey?: NativeCanonicalKey;
}

export interface NativeGlobalPhase {
  readonly serialized: true;
  /** Source pages precede index/log/schema; all are one writer phase. */
  readonly serializationOrder: readonly string[];
  readonly files: readonly NativeDesiredFile[];
}

export interface NativeReductionPlan {
  readonly version: 'native-reducer/v1';
  readonly status: NativeReductionStatus;
  readonly complete: true;
  /** False whenever native comparison is needed or a structural ambiguity exists. */
  readonly canApply: boolean;
  readonly reasons: readonly string[];
  readonly unsupported: readonly string[];
  readonly pages: readonly NativePageCandidate[];
  /** Every desired file, including source/index/log/schema files. */
  readonly desiredState: readonly NativeDesiredFile[];
  readonly globalPhase: NativeGlobalPhase;
}
