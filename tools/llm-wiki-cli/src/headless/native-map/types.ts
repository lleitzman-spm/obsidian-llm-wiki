/**
 * Source-scoped, write-free extraction contracts.
 *
 * This module intentionally does not expose `App`, `TFile`, `WikiEngine`, or
 * a vault writer.  A native host supplies an immutable source revision, a
 * frozen projection of the native settings/policy, and an already-authorized
 * provider client.  The map seam returns only content-addressed IR.  A later
 * reducer owns page rendering and the single candidate-vault transaction.
 */

import type {
  HeadlessProviderClient,
  ProviderCallParams,
  ProviderTypedResponse,
} from '../provider';

export const NATIVE_MAP_CONTRACT_VERSION = 'native-map/v1' as const;
export const NATIVE_MAP_PROMPT_VERSION = 'obsidian-llm-wiki/analyze-source/v1.26.4' as const;
export const NATIVE_MAP_DEFAULT_EXTRACTED_AT = '1970-01-01T00:00:00.000Z' as const;

/** The subset of native settings that can affect source extraction. */
export interface NativeMapSettings {
  readonly provider: string;
  readonly model: string;
  readonly ingestModel?: string;
  readonly wikiLanguage: string;
  readonly extractionGranularity: 'fine' | 'standard' | 'coarse' | 'minimal' | 'custom';
  readonly customEntityLimit?: number;
  readonly customConceptLimit?: number;
  readonly tagVocabularyMode: 'default' | 'custom';
  readonly customEntityTags: string;
  readonly customConceptTags: string;
  readonly disableThinking?: boolean;
}

/**
 * Safe policy metadata is explicit rather than an opaque settings object.  In
 * particular, no API key, SecretStorage handle, or provider credential may
 * cross this boundary.
 */
export interface NativeMapPolicyInput {
  readonly settings: NativeMapSettings;
  readonly entityTags: readonly string[];
  readonly conceptTags: readonly string[];
  readonly schemaContext?: string;
  readonly systemPrompt?: string;
  readonly promptVersion?: string;
  readonly policyPackSha256?: string;
  readonly settingsSha256?: string;
  readonly vocabularySha256?: string;
}

export interface NativeMapPolicy {
  readonly contractVersion: typeof NATIVE_MAP_CONTRACT_VERSION;
  readonly promptVersion: string;
  readonly settings: Readonly<NativeMapSettings>;
  readonly entityTags: readonly string[];
  readonly conceptTags: readonly string[];
  readonly schemaContext?: string;
  readonly systemPrompt?: string;
  readonly policyPackSha256: string;
  readonly settingsSha256: string;
  readonly vocabularySha256: string;
  readonly policySha256: string;
}

/** A path-bound, byte-addressed source revision. */
export interface NativeMapSource {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceBytes: Uint8Array;
  /** Optional explicit timestamp used only for generated mention metadata. */
  readonly extractedAt?: string;
}

/**
 * Immutable page-catalog entry supplied by the host after extraction.
 *
 * The map worker never receives an App, TFile, vault, or page body.  A host
 * may pass this small read-only projection when it wants SourceAnalyzer's
 * deterministic related-page matching; omitting it preserves the unresolved
 * related-page proposals returned by the model.
 */
export interface NativeMapExistingPage {
  readonly title: string;
  readonly aliases?: readonly string[];
}

export interface NativeMention {
  readonly quote: string;
  readonly translation?: string;
  readonly source_path: string;
  readonly source_slug: string;
  readonly extracted_at: string;
}

export interface NativeEntityProposal {
  readonly name: string;
  readonly type: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly mentions_in_source: readonly string[];
  readonly mentions_with_provenance: readonly NativeMention[];
  readonly related_entities: readonly string[];
  readonly related_concepts: readonly string[];
}

export interface NativeConceptProposal {
  readonly name: string;
  readonly type: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly mentions_in_source: readonly string[];
  readonly mentions_with_provenance: readonly NativeMention[];
  readonly related_concepts: readonly string[];
  readonly related_entities: readonly string[];
}

export interface NativeContradictionProposal {
  readonly claim: string;
  readonly source_page: string;
  readonly contradicted_by: string;
  readonly resolution: string;
}

/** A claim proposal remains explicitly unadjudicated until a reducer decides. */
export interface NativeClaimProposal {
  readonly claimId: string;
  readonly subject: { readonly pageType: 'entity' | 'concept' | 'source'; readonly label: string };
  readonly predicate: 'source-summary' | 'item-summary' | 'contradiction';
  readonly statement: string;
  readonly disposition: 'proposed' | 'contested';
  readonly evidenceQuotes: readonly string[];
  readonly sourcePath: string;
}

export interface NativeRelatedProposal {
  readonly sourcePath: string;
  readonly pageType: 'entity' | 'concept' | 'source' | 'unknown';
  readonly label: string;
  readonly resolution: 'unresolved-source-proposal';
}

export interface NativeAliasProposal {
  readonly alias: string;
  readonly targetPageType: 'entity' | 'concept' | 'source';
  readonly targetLabel: string;
  readonly sourcePath: string;
}

export type NativeMapArtifactKind =
  | 'summary'
  | 'entity'
  | 'concept'
  | 'claim'
  | 'alias'
  | 'related';

export interface NativeMapArtifact {
  readonly artifactId: string;
  readonly sourceId: string;
  readonly sourceByteSha256: string;
  readonly kind: NativeMapArtifactKind;
  readonly pageType: 'source' | 'entity' | 'concept' | 'claim' | 'alias' | 'related';
  readonly label: string;
  readonly normalizedLabel: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * A typed, source-neutral record that extraction stopped after preserving
 * earlier rounds.  It intentionally carries no provider error text or model
 * evidence: the map remains source-scoped without implying that later rounds
 * completed successfully.
 */
export interface NativeMapDegradation {
  readonly status: 'degraded';
  readonly code: 'later-batch-provider-failure';
  readonly failedBatch: number;
  readonly preservedBatchCount: number;
}

export interface NativeMapIR {
  readonly contractVersion: typeof NATIVE_MAP_CONTRACT_VERSION;
  readonly source: {
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly byteSha256: string;
    readonly byteCount: number;
  };
  readonly sourceTitle: string;
  readonly summary: string;
  readonly sourceAliases: readonly string[];
  readonly keyPoints: readonly string[];
  readonly entities: readonly NativeEntityProposal[];
  readonly concepts: readonly NativeConceptProposal[];
  readonly mentions: readonly NativeMention[];
  readonly claims: readonly NativeClaimProposal[];
  readonly aliases: readonly NativeAliasProposal[];
  readonly related: readonly NativeRelatedProposal[];
  readonly contradictions: readonly NativeContradictionProposal[];
  readonly artifacts: readonly NativeMapArtifact[];
  /** Present only when a later extraction batch stopped after prior success. */
  readonly degradations?: readonly NativeMapDegradation[];
  readonly policySha256: string;
  readonly irSha256: string;
}

export interface NativeMapInput {
  readonly source: NativeMapSource;
  readonly policy: NativeMapPolicy | NativeMapPolicyInput;
  /** The client is already authorized by the host; this seam never obtains credentials. */
  readonly client: NativeMapClient;
  readonly maxBatches?: number;
  /** Optional read-only catalog used for programmatic related-page matching. */
  readonly existingPages?: readonly NativeMapExistingPage[];
}

/** Provider shape accepted by the map seam; no authorization methods are exposed. */
export type NativeMapClient = Pick<HeadlessProviderClient, 'createMessage'> & {
  readonly createMessageWithOutput?: <T = unknown>(params: ProviderCallParams) => Promise<ProviderTypedResponse<T>>;
};

export interface NativeMapCallEvidence {
  readonly batch: number;
  readonly attempt?: number;
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export class NativeMapProtocolError extends Error {
  public readonly code:
    | 'invalid-policy'
    | 'invalid-source'
    | 'blank-source'
    | 'invalid-response'
    | 'invalid-provenance'
    | 'unsupported-output';

  public constructor(code: NativeMapProtocolError['code'], message: string) {
    super(message);
    this.name = 'NativeMapProtocolError';
    this.code = code;
  }
}
