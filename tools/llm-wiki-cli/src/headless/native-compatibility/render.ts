import { extractSourceTags } from '../../../../../src/core/arrays';
import {
  extractBody,
  enforceFrontmatterConstraints,
  mergeFrontmatterArrayField,
  parseFrontmatter,
  upsertFrontmatterField,
} from '../../../../../src/core/frontmatter';
import { hashBody } from '../../../../../src/core/source-requirements';
import { cleanMarkdownResponse } from '../../../../../src/core/markdown';
import { canonicalizeSectionHeaders } from '../../../../../src/core/section-header-canonicalizer';
import { correctRelatedLinkPrefixes } from '../../../../../src/core/related-link-corrector';
import { injectMentionsSection } from '../../../../../src/core/mentions-injector';
import { getSectionLabels } from '../../../../../src/wiki/system-prompts';
import { DEFAULT_SOURCE_TAG, VALID_SOURCE_TAGS } from '../../../../../src/types';
import type { LLMWikiSettings, MentionWithProvenance } from '../../../../../src/types';
import { nativeSourcePagePath, nativeSourceSlug, normalizeNativeVaultPath } from './slug';
import { appendNativeSourceSlugToFrontmatter } from './source-stamp';
import type {
  NativeCompatibilityBase,
  NativeGeneratedPageInput,
  NativePlannedFile,
  NativeSourcePageInput,
} from './types';

function ready<T extends NativeCompatibilityBase>(value: T): T {
  return Object.freeze(value);
}

function refusal<T extends NativeCompatibilityBase>(
  value: Omit<T, keyof NativeCompatibilityBase> & Partial<NativeCompatibilityBase>,
  code: string,
  message: string,
): T {
  return Object.freeze({
    ...value,
    status: 'refused',
    canApply: false,
    reasons: [{ code, message }],
  } as unknown as T);
}

function replacementAction(currentContent: string | undefined, content: string): 'create' | 'replace' | 'unchanged' {
  if (currentContent === undefined) return 'create';
  return currentContent === content ? 'unchanged' : 'replace';
}

function replaceNativeDates(content: string, date: string, preserveCreated?: string): string {
  const end = content.indexOf('\n---', 3);
  if (end < 0) return content;
  const header = content.slice(0, end);
  const body = content.slice(end);
  const created = preserveCreated && /^\d{4}-\d{2}-\d{2}$/u.test(preserveCreated) ? preserveCreated : date;
  const updated = header
    .replace(/^created:\s*\d{4}-\d{2}-\d{2}\s*$/mu, `created: ${created}`)
    .replace(/^updated:\s*\d{4}-\d{2}-\d{2}\s*$/mu, `updated: ${date}`);
  return updated + body;
}

function todayUtc(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

/**
 * Apply the non-LLM tail of WikiEngine.createSummaryPage exactly:
 * fingerprinted source path, contentHash, and curated source-note aliases.
 * The model response itself must come from the native provider seam.
 */
export function planNativeSourcePage(input: NativeSourcePageInput): NativePlannedFile {
  const path = nativeSourcePagePath(input.wikiFolder, input.sourcePath, input.slug);
  if (typeof input.generatedContent !== 'string' || input.generatedContent.trim() === '') {
    return refusal<NativePlannedFile>({ path, action: 'replace' }, 'missing-generated-content', 'Native source-page generation returned no content');
  }

  let content = upsertFrontmatterField(
    input.generatedContent,
    'contentHash',
    hashBody(extractBody(input.sourceContent)),
  );
  if (input.sourceNoteAliases?.length) {
    content = mergeFrontmatterArrayField(content, 'aliases', [...input.sourceNoteAliases]);
  }
  if (input.sourceTags?.length) {
    content = mergeFrontmatterArrayField(content, 'tags', [...input.sourceTags]);
  }

  return ready({
    status: 'ready',
    canApply: true,
    reasons: [],
    path,
    action: replacementAction(input.existingContent, content),
    content,
    ...(input.existingContent !== undefined ? { currentContent: input.existingContent } : {}),
  });
}

function asMentionInput(
  mentions: NativeGeneratedPageInput['mentions'],
): MentionWithProvenance[] | string[] {
  if (!mentions) return [];
  return [...mentions] as MentionWithProvenance[] | string[];
}

function sourceFileBasename(sourcePath: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  return sourcePath.replaceAll('\\', '/').split('/').pop() ?? sourcePath;
}

function isNativeConversationSource(sourcePath: string, wikiFolder: string): boolean {
  return sourcePath.startsWith(`${wikiFolder}/sources/`);
}

/**
 * Apply the deterministic post-processing tail of PageFactory.createNewPage.
 *
 * This function deliberately refuses to synthesize an entity/concept body or
 * to choose merge semantics.  It only runs after a native provider response
 * is supplied, and all settings/date/source facts are explicit.  The native
 * frontmatter helper reads the wall clock internally; the final frontmatter
 * dates are replaced with the sealed run date, which is byte-equivalent to a
 * native run on that date while keeping the plan reproducible.
 */
export function planNativeGeneratedPage(input: NativeGeneratedPageInput): NativePlannedFile {
  if (input.pageType !== 'entity' && input.pageType !== 'concept') {
    return refusal<NativePlannedFile>({ path: input.path, action: 'replace' }, 'unsupported-page-kind', `Native PageFactory does not generate ${input.pageType} pages here`);
  }
  if (typeof input.generatedContent !== 'string' || input.generatedContent.trim() === '') {
    return refusal<NativePlannedFile>({ path: input.path, action: 'replace' }, 'missing-generated-content', 'Native page generation returned no content');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) {
    return refusal<NativePlannedFile>({ path: input.path, action: 'replace' }, 'invalid-date', `Native generated-page date is invalid: ${input.date}`);
  }

  const sourcePathForSlug = normalizeNativeVaultPath(input.sourcePath, 'sourcePath');
  const slugOptions = { preserveCase: input.settings.slugCase === 'preserve' };
  if (input.sourceSlug !== undefined && input.sourceSlug !== nativeSourceSlug(sourcePathForSlug, slugOptions)) {
    return refusal<NativePlannedFile>({ path: input.path, action: 'replace' }, 'source-slug-mismatch', `Expected ${nativeSourceSlug(sourcePathForSlug, slugOptions)} for ${sourcePathForSlug}, received ${input.sourceSlug}`);
  }

  const settings = input.settings as LLMWikiSettings;
  const cleaned = cleanMarkdownResponse(input.generatedContent);
  const enforcedAtRuntimeDate = enforceFrontmatterConstraints(
    cleaned,
    input.pageType,
    settings,
    input.preserveCreated ? { preserveCreated: input.preserveCreated } : undefined,
  );
  const enforced = replaceNativeDates(enforcedAtRuntimeDate, input.date, input.preserveCreated);
  const labels = getSectionLabels(settings);
  const canonicalized = canonicalizeSectionHeaders(enforced, Object.values(labels));
  const corrected = correctRelatedLinkPrefixes(
    canonicalized,
    input.relatedEntities ? [...input.relatedEntities] : undefined,
    input.relatedConcepts ? [...input.relatedConcepts] : undefined,
    labels.related_entities,
    labels.related_concepts,
    settings.slugCase === 'preserve',
    input.existingPages
      ? { wikiFolder: settings.wikiFolder, pages: [...input.existingPages] }
      : undefined,
  );

  const sourcePath = sourcePathForSlug;
  const sourceFile = {
    path: sourcePath,
    basename: sourceFileBasename(sourcePath, input.sourceFileBasename),
  };
  const conversation = isNativeConversationSource(sourceFile.path, settings.wikiFolder);
  const mentions = conversation ? [] : asMentionInput(input.mentions);
  const mentionsInjected = injectMentionsSection(
    corrected,
    mentions,
    sourcePath,
    {
      sectionLabel: labels.mentions_in_source,
      conversationMode: conversation,
      conversationLabel: `Conversation: ${sourceFile.basename}`,
    },
  );

  const content = input.sourceSlug
    ? appendNativeSourceSlugToFrontmatter(mentionsInjected, input.sourceSlug)
    : mentionsInjected;
  if (!content.trim()) {
    return refusal<NativePlannedFile>({ path: input.path, action: 'replace' }, 'missing-page-body', 'Native post-processing produced an empty page');
  }

  return ready({
    status: 'ready',
    canApply: true,
    reasons: [],
    path: normalizeNativeVaultPath(input.path, 'pagePath'),
    action: 'replace',
    content,
  });
}

/**
 * Keep source-tag policy visible without modifying native output.  Native
 * source-page rendering passes source-note tags through the prompt and does
 * not perform a second write-time normalization in createSummaryPage.
 */
export function nativeSourceTagCandidates(sourceContent: string): readonly string[] {
  const tags = extractSourceTags(sourceContent).filter(tag => (VALID_SOURCE_TAGS as readonly string[]).includes(tag));
  return tags.length > 0 ? tags : [DEFAULT_SOURCE_TAG];
}

/** Return the native page's parsed frontmatter for comparison tooling only. */
export function readNativeRenderedFrontmatter(content: string) {
  return parseFrontmatter(content);
}
