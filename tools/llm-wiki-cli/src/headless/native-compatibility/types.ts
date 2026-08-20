/**
 * Read-only adapters for the installed Karpathy LLM Wiki v1.26.4 runtime.
 *
 * The headless reducer owns the generic candidate model.  This module is the
 * deliberately narrower compatibility seam: it describes the bytes and
 * paths the native PageFactory, IndexGenerator, and LogWriter would produce
 * when their non-LLM inputs are already known.  Anything that still requires
 * a native LLM decision is returned as `requires-native-comparison` instead
 * of being silently approximated.
 */

export type NativeCompatibilityStatus =
  | 'ready'
  | 'requires-native-comparison'
  | 'refused';

export type NativeCompatibilityAction = 'create' | 'replace' | 'unchanged';

export type NativeCompatibilityRefusalCode =
  | 'invalid-path'
  | 'invalid-date'
  | 'invalid-time'
  | 'missing-generated-content'
  | 'source-slug-mismatch'
  | 'missing-source-path'
  | 'missing-page-body'
  | 'native-llm-seam-required'
  | 'ambiguous-source-entry'
  | 'unsupported-page-kind';

export interface NativeCompatibilityReason {
  readonly code: NativeCompatibilityRefusalCode | string;
  readonly message: string;
}

export interface NativeCompatibilityBase {
  readonly status: NativeCompatibilityStatus;
  readonly canApply: boolean;
  readonly reasons: readonly NativeCompatibilityReason[];
}

export interface NativePlannedFile extends NativeCompatibilityBase {
  readonly path: string;
  readonly action: NativeCompatibilityAction;
  readonly content?: string;
  readonly currentContent?: string;
}

export interface NativeSourceSlugOptions {
  /** Native `slugCase` setting.  Defaults to lower-case. */
  readonly preserveCase?: boolean;
  /** Native source slug cap.  Defaults to the v1.26.4 cap of 80. */
  readonly maxLen?: number;
}

export interface NativeSourcePageInput {
  /** Raw vault source path, not the generated `wiki/sources` path. */
  readonly sourcePath: string;
  readonly wikiFolder: string;
  /** The already-generated source-page response from the native provider. */
  readonly generatedContent: string;
  /** Original source bytes decoded as UTF-8, used for native contentHash. */
  readonly sourceContent: string;
  /** Curated aliases from the raw source note frontmatter. */
  readonly sourceNoteAliases?: readonly string[];
  /** Curated source-note tags retained by the native source-page tail. */
  readonly sourceTags?: readonly string[];
  /** Existing generated source page, if this is a re-ingest. */
  readonly existingContent?: string;
  readonly slug?: NativeSourceSlugOptions;
}

export interface NativeGeneratedPageInput {
  readonly pageType: 'entity' | 'concept';
  readonly path: string;
  /** Raw model response before native post-processing. */
  readonly generatedContent: string;
  /** Full native settings are required because they control frontmatter and labels. */
  readonly settings: import('../../../../../src/types').LLMWikiSettings;
  readonly sourcePath: string;
  readonly sourceSlug?: string;
  readonly sourceFileBasename?: string;
  readonly relatedEntities?: readonly string[];
  readonly relatedConcepts?: readonly string[];
  readonly mentions?: readonly import('../../../../../src/types').MentionWithProvenance[] | readonly string[];
  readonly existingPages?: readonly import('../../../../../src/core/related-link-corrector').ExistingPageRef[];
  /** Native creation/updated date.  Must be explicit for reproducible plans. */
  readonly date: string;
  /** Existing `created:` is preserved only on native merge paths. */
  readonly preserveCreated?: string;
}

export type NativeMergeMode =
  | 'frontmatter-only'
  | 'llm-merge'
  | 'reviewed-append'
  | 'complementary-append';

export interface NativeMergeInput {
  readonly pagePath: string;
  /** Raw source note path. */
  readonly sourcePath: string;
  readonly existingContent: string;
  readonly wikiFolder: string;
  readonly date: string;
  readonly mode: NativeMergeMode;
  /** Optional model body for comparison only; it is not trusted as native output. */
  readonly proposedBody?: string;
  readonly sourceSlug?: string;
  readonly slug?: NativeSourceSlugOptions;
}

export interface NativeMergePlan extends NativePlannedFile {
  readonly mode: NativeMergeMode;
  readonly sourceSlug: string;
  readonly frontmatterChanged: boolean;
  readonly bodyChanged: boolean;
}

export interface NativeIndexPage {
  /** Existing on-disk generated page path or a stable display basename. */
  readonly path?: string;
  readonly basename?: string;
  readonly content: string;
}

export interface NativeIndexSourcePage extends NativeIndexPage {
  /** Raw source note path. Required to prove the fingerprinted native slug. */
  readonly sourcePath: string;
}

export interface NativeIndexInput {
  readonly wikiFolder: string;
  readonly wikiLanguage: string;
  readonly entities: readonly NativeIndexPage[];
  readonly concepts: readonly NativeIndexPage[];
  readonly sources: readonly NativeIndexSourcePage[];
  readonly slug?: NativeSourceSlugOptions;
}

export interface NativeIndexPlan extends NativePlannedFile {
  readonly sectionCounts: Readonly<{
    entities: number;
    concepts: number;
    sources: number;
  }>;
}

export interface NativeIngestLogInput {
  readonly wikiFolder: string;
  readonly wikiLanguage: string;
  readonly existingContent?: string | null;
  readonly operation: string;
  readonly sourceTitle: string;
  readonly createdPages: readonly string[];
  readonly updatedPages: readonly string[];
  readonly contradictions?: readonly Readonly<{
    claim: string;
    source_page: string;
  }>[];
  readonly date: string;
  readonly time: string;
  readonly metrics?: Readonly<{
    durationSec?: number;
    model?: string;
    sourceBytes?: number;
  }>;
}

export interface NativeLintLogInput {
  readonly wikiFolder: string;
  readonly wikiLanguage: string;
  readonly existingContent?: string | null;
  readonly operation: string;
  readonly details: string;
  readonly date: string;
  readonly time: string;
}

export interface NativeLogPlan extends NativePlannedFile {
  readonly entryKind: 'ingest' | 'lint';
}
