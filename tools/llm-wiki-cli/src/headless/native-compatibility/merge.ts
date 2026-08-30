import {
  extractBody,
  extractPassthroughLines,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../../../../src/core/frontmatter';
import { cleanMarkdownResponse } from '../../../../../src/core/markdown';
import {
  canonicalizeSectionHeaders,
  preserveExistingSections,
  reassertH1,
} from '../../../../../src/core/section-header-canonicalizer';
import { correctRelatedLinkPrefixes } from '../../../../../src/core/related-link-corrector';
import { computeReingestMentions, stripMentionsSection } from '../../../../../src/core/mentions-parser';
import { injectMentionsSection } from '../../../../../src/core/mentions-injector';
import { isConversationSource } from '../../../../../src/wiki/page-factory/contextualize';
import { getSectionLabels } from '../../../../../src/wiki/system-prompts';
import type { EntityInfo, ConceptInfo, LLMWikiSettings, MentionWithProvenance } from '../../../../../src/types';
import { nativeSourceLink, nativeSourceSlug, normalizeNativeVaultPath, normalizeNativeWikiFolder } from './slug';
import type {
  NativeCompatibilityReason,
  NativeMergeInput,
  NativeMergePlan,
} from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function normalizeSourceEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) return trimmed.slice(2, -2).trim();
  return trimmed;
}

function nativeMergeFrontmatter(existingContent: string, sourcePath: string, date: string): { frontmatter: string; body: string; wasMerged: boolean } {
  const fm = parseFrontmatter(existingContent);
  const body = extractBody(existingContent);
  if (!fm) return { frontmatter: '', body: existingContent, wasMerged: false };

  const sourceSet = new Set<string>();
  for (const source of Array.isArray(fm.sources) ? fm.sources : []) {
    sourceSet.add(normalizeSourceEntry(String(source)));
  }
  sourceSet.add(sourcePath);
  const mergedSources = Array.from(sourceSet).map(source => `[[${source}]]`);
  const created = fm.created || date;
  const passthroughLines = extractPassthroughLines(existingContent);
  const frontmatter = serializeFrontmatter(
    {
      type: fm.type,
      created,
      updated: date,
      sources: mergedSources,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      reviewed: fm.reviewed,
      aliases: Array.isArray(fm.aliases) ? fm.aliases : undefined,
    },
    { tagStyle: 'block', emitEmptyTags: true, passthroughLines },
  );
  return { frontmatter, body, wasMerged: true };
}

function reason(code: string, message: string): NativeCompatibilityReason {
  return { code, message };
}

function action(current: string, next: string): 'replace' | 'unchanged' {
  return current === next ? 'unchanged' : 'replace';
}

function frontmatterBlock(content: string): string {
  if (!content.startsWith('---\n')) return '';
  const end = content.indexOf('\n---', 4);
  return end < 0 ? '' : content.slice(0, end + 4);
}

function sourceBasename(sourcePath: string, explicit?: string): string {
  return explicit ?? sourcePath.replaceAll('\\', '/').split('/').pop() ?? sourcePath;
}

function mentionInputs(
  mentions: readonly MentionWithProvenance[] | readonly string[] | undefined,
): { structured: MentionWithProvenance[]; legacy: string[] } {
  if (!mentions) return { structured: [], legacy: [] };
  const values = [...mentions];
  if (values.every(value => typeof value === 'string')) {
    return { structured: [], legacy: values as string[] };
  }
  return { structured: values as MentionWithProvenance[], legacy: [] };
}

/**
 * Assemble the body exactly as the native merge paths do after their provider
 * call.  This helper intentionally accepts only a bound provider response;
 * it never invents a body, triage decision, or metadata from a page label.
 */
function assembleNativeMergeBody(input: NativeMergeInput, frontmatter: string, existingBody: string, generatedBody: string): string {
  const settings = input.settings as LLMWikiSettings;
  const normalizedSourcePath = normalizeNativeVaultPath(input.sourcePath, 'sourcePath');
  const sourceFile = { path: normalizedSourcePath, basename: sourceBasename(normalizedSourcePath, input.sourceFileBasename) };
  const mentions = mentionInputs(input.mentions);
  const normalizedStructuredMentions = mentions.structured.map(mention => ({
    ...mention,
    source_path: mention.source_path
      ? normalizeNativeVaultPath(mention.source_path, 'mention.source_path')
      : normalizedSourcePath,
    source_slug: mention.source_slug?.replaceAll('\\', '/'),
  }));
  const info = {
    name: input.pagePath.split('/').pop()?.replace(/\.md$/iu, '') ?? input.pagePath,
    summary: '',
    related_entities: [...(input.relatedEntities ?? [])],
    related_concepts: [...(input.relatedConcepts ?? [])],
    mentions_in_source: mentions.legacy,
    mentions_with_provenance: normalizedStructuredMentions,
  } as unknown as EntityInfo | ConceptInfo;

  if (input.mode === 'reviewed-append') {
    const cleaned = cleanMarkdownResponse(generatedBody);
    if (cleaned.trim() === 'NO_NEW_CONTENT') return `${frontmatter}\n\n${existingBody}`;
    const labels = getSectionLabels(settings);
    const isConv = isConversationSource(sourceFile, settings.wikiFolder);
    const appendMentions = isConv ? [] : (normalizedStructuredMentions.length > 0 ? normalizedStructuredMentions : mentions.legacy);
    const body = injectMentionsSection(cleaned, appendMentions, sourceFile.path, {
      sectionLabel: labels.mentions_in_source,
      conversationMode: isConv,
      conversationLabel: `Conversation: ${sourceFile.basename}`,
      pageIsReviewed: true,
    });
    return `${frontmatter}\n\n${body}`;
  }

  const labels = getSectionLabels(settings);
  const cleaned = cleanMarkdownResponse(generatedBody);
  if (cleaned.trim() === 'NO_NEW_CONTENT') return `${frontmatter}\n\n${existingBody}`;
  let body = cleaned;
  if (input.mode === 'llm-merge') {
    const canonicalized = canonicalizeSectionHeaders(body, Object.values(labels));
    const corrected = correctRelatedLinkPrefixes(
      canonicalized,
      input.relatedEntities ? [...input.relatedEntities] : undefined,
      input.relatedConcepts ? [...input.relatedConcepts] : undefined,
      labels.related_entities,
      labels.related_concepts,
      settings.slugCase === 'preserve',
      input.existingPages ? { wikiFolder: settings.wikiFolder, pages: [...input.existingPages] } : undefined,
    );
    body = reassertH1(
      existingBody,
      preserveExistingSections(existingBody, corrected, Object.values(labels), labels.mentions_in_source),
    );
  }

  const isConv = isConversationSource(sourceFile, settings.wikiFolder);
  if (isConv) {
    body = injectMentionsSection(body, [], sourceFile.path, {
      sectionLabel: labels.mentions_in_source,
      conversationMode: true,
      conversationLabel: `Conversation: ${sourceFile.basename}`,
    });
    return `${frontmatter}\n\n${body}`;
  }

  const newMentions: MentionWithProvenance[] = normalizedStructuredMentions.length > 0
    ? normalizedStructuredMentions
    : mentions.legacy.map(quote => ({ quote, source_path: sourceFile.path, source_slug: '', extracted_at: '' }));
  const reingested = computeReingestMentions(existingBody, newMentions, labels.mentions_in_source, sourceFile.path);
  if (reingested.preserveRaw !== null) {
    const stripped = stripMentionsSection(body, labels.mentions_in_source);
    const preserved = stripped ? `${stripped}\n\n${reingested.preserveRaw}` : reingested.preserveRaw;
    return `${frontmatter}\n\n${preserved}`;
  }
  body = injectMentionsSection(body, reingested.mentions, sourceFile.path, {
    sectionLabel: labels.mentions_in_source,
    conversationMode: false,
    conversationLabel: `Conversation: ${sourceFile.basename}`,
  });
  return `${frontmatter}\n\n${body}`;
}

/**
 * Plan the deterministic portion of a native merge. Native `mergePage` and
 * reviewed append remain provider-owned for body bytes, but an explicitly
 * bound provider response can cross this seam for native post-processing.
 * Complementary append remains refused because its per-section triage and
 * anchor sequence are not represented here. The frontmatter-only path needs
 * no provider response.
 */
export function planNativeMerge(input: NativeMergeInput): NativeMergePlan {
  const pagePath = normalizeNativeVaultPath(input.pagePath, 'pagePath');
  const sourcePath = normalizeNativeVaultPath(input.sourcePath, 'sourcePath');
  const wikiFolder = normalizeNativeWikiFolder(input.wikiFolder);
  const reasons: NativeCompatibilityReason[] = [];
  if (!pagePath.startsWith(`${wikiFolder}/`)) {
    reasons.push(reason('invalid-path', `Native merge page path ${pagePath} is outside wiki folder ${wikiFolder}`));
  }
  if (!ISO_DATE.test(input.date)) reasons.push(reason('invalid-date', `Native merge date is invalid: ${input.date}`));
  if (input.existingContent === undefined) reasons.push(reason('missing-page-body', 'Native merge requires the existing page bytes'));

  const expectedSlug = nativeSourceSlug(sourcePath, input.slug);
  if (input.sourceSlug !== undefined && input.sourceSlug !== expectedSlug) {
    reasons.push(reason('source-slug-mismatch', `Expected ${expectedSlug} for ${sourcePath}, received ${input.sourceSlug}`));
  }

  const sourceRef = nativeSourceLink(sourcePath, input.slug).slice(2, -2);
  const merged = reasons.length === 0
    ? nativeMergeFrontmatter(input.existingContent, sourceRef, input.date)
    : { frontmatter: '', body: input.existingContent, wasMerged: false };
  let plannedContent = merged.wasMerged ? `${merged.frontmatter}\n\n${merged.body}` : input.existingContent;
  const bodyChanged = input.proposedBody !== undefined && input.proposedBody !== merged.body;

  if (input.mode !== 'frontmatter-only' && input.generatedContent === undefined) {
    reasons.push(reason(
      'native-llm-seam-required',
      `Native ${input.mode} requires a provider response bound to the existing-page seam`,
    ));
  }
  if (input.mode === 'complementary-append') {
    reasons.push(reason(
      'native-llm-seam-required',
      'Native complementary append requires the per-section triage and anchor sequence',
    ));
  }
  if (
    input.mode === 'llm-merge'
    && (input.relatedEntities?.length || input.relatedConcepts?.length)
    && input.existingPages === undefined
  ) {
    reasons.push(reason(
      'native-llm-seam-required',
      'Native body merge requires the sealed existing-page catalog for related-link correction',
    ));
  }
  if (input.mode !== 'frontmatter-only' && input.pageType === undefined) {
    reasons.push(reason('native-llm-seam-required', `Native ${input.mode} requires the existing page type`));
  }
  if (input.mode !== 'frontmatter-only' && input.settings === undefined) {
    reasons.push(reason('native-llm-seam-required', `Native ${input.mode} requires sealed native settings`));
  }
  if (!merged.wasMerged && reasons.length === 0) {
    reasons.push(reason('missing-page-body', 'Native merge frontmatter was not parseable; preserving bytes is not a proven merge'));
  }
  if (bodyChanged) {
    reasons.push(reason('native-llm-seam-required', 'A proposed body is not trusted without the native merge/append path'));
  }

  if (
    input.mode !== 'frontmatter-only'
    && input.generatedContent !== undefined
    && input.pageType !== undefined
    && input.settings !== undefined
    && merged.wasMerged
    && reasons.length === 0
  ) {
    try {
      // Native mergePage / appendToReviewedPage return before writing when the
      // provider says NO_NEW_CONTENT; the pre-merge frontmatter is not leaked.
      plannedContent = cleanMarkdownResponse(input.generatedContent).trim() === 'NO_NEW_CONTENT'
        ? input.existingContent
        : assembleNativeMergeBody(input, merged.frontmatter, merged.body, input.generatedContent);
    } catch (error) {
      reasons.push(reason(
        'native-llm-seam-required',
        `Native ${input.mode} post-processing failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  const canApply = reasons.length === 0;
  const refusedNoWrite = input.mode === 'complementary-append' && !canApply;
  if (refusedNoWrite) plannedContent = input.existingContent;
  const frontmatterChanged = merged.wasMerged && frontmatterBlock(plannedContent) !== frontmatterBlock(input.existingContent);
  const finalBodyChanged = merged.wasMerged && extractBody(plannedContent) !== merged.body;
  return Object.freeze({
    status: canApply ? 'ready' : 'requires-native-comparison',
    canApply,
    reasons,
    path: pagePath,
    action: canApply ? action(input.existingContent, plannedContent) : refusedNoWrite ? 'unchanged' : 'replace',
    content: plannedContent,
    currentContent: input.existingContent,
    mode: input.mode,
    sourceSlug: expectedSlug,
    frontmatterChanged,
    bodyChanged: finalBodyChanged,
  });
}
