// page-factory/create-page.ts — create or update entity/concept pages.
//
// Extracted from the original page-factory.ts god-class. Contains 4
// functions: 3 public (createOrUpdateEntityPage / createOrUpdateConceptPage
// / createNewPage) and 1 private router (createOrUpdatePage).
//
// Behavior (v1.24.1 Phase 2 refactor — preserved verbatim):
//   - createOrUpdatePage resolves the path first (same-type slug match / LLM
//     dedup fallback). Issue #472: the opposite folder is not consulted, so
//     there is no cross-type branch — same letters under the other type are a
//     different designator.
//   - new-file branch: LLM generates the body (entity or concept prompt).
//   - existing-file branch: reviewed pages route to appendToReviewedPage;
//     other pages route to mergePage.
//
// Issue #244: Mentions section is injected programmatically post-LLM (in
// createNewPage and mergePage) so the LLM cannot drift the citation format.
// Conversation sources emit a single synthetic citation line.

import { TFile } from 'obsidian';
import type {
  EntityInfo,
  ConceptInfo,
  PageCreationResult,
  LLMWikiSettings,
  LLMClient,
  SourceAnalysis,
  SourceContext,
} from '../../types';
import { PROMPTS } from '../../prompts';
import { TOKENS_PAGE_GENERATION } from '../../constants';
import { resolveModelForTask } from '../../core/model-resolver';
import { cleanMarkdownResponse } from '../../core/markdown';
import { canonicalizeSectionHeaders } from '../../core/section-header-canonicalizer';
import { correctRelatedLinkPrefixes } from '../../core/related-link-corrector';
import { guardGeneratedWikiLinks, type GeneratedLinkPageRef } from '../../core/generated-link-guard';
import { parseFrontmatter, enforceFrontmatterConstraints } from '../../core/frontmatter';
import { getActiveConceptTags, getActiveEntityTags } from '../../core/tag-vocab';
import { injectMentionsSection } from '../../core/mentions-injector';
import { filterGroundedMentions, filterLegacyGroundedMentions } from '../../core/quote-grounding';
import type { AuthoritativeSourceSnapshot } from '../../core/physical-source-authority';
import { renderTemplate } from '../../core/template-renderer';
import { applySectionLabels, getSectionLabels } from '../system-prompts';
import { resolvePagePath, type PathResolutionContext, type ResolvedPathResult } from './path-resolution';
import { appendAliases } from './aliases';
import { getExistingWikiPages } from '../lint/get-existing-pages';
import { mergePage } from './merge-page';
import { appendToReviewedPage } from './merge-page';
import { isConversationSource, contextualizeError } from './contextualize';

/**
 * Return tags that belong exclusively to the opposite page taxonomy.
 *
 * `parseFrontmatter` already types `tags` as `string[] | undefined`, but this
 * guard remains deliberately defensive because generated frontmatter is
 * untrusted input and the parser has an open-ended passthrough shape.
 */
function findOppositeTaxonomyTags(
  pageType: 'entity' | 'concept',
  tags: string[] | undefined,
  settings: LLMWikiSettings,
): string[] {
  if (!Array.isArray(tags)) return [];

  const ownTags = pageType === 'entity'
    ? getActiveEntityTags(settings)
    : getActiveConceptTags(settings);
  const oppositeTags = pageType === 'entity'
    ? getActiveConceptTags(settings)
    : getActiveEntityTags(settings);
  const ownTagSet = new Set(ownTags);
  const oppositeTagSet = new Set(oppositeTags);

  return tags.filter(tag => oppositeTagSet.has(tag) && !ownTagSet.has(tag));
}

/**
 * Minimal context contract required by createOrUpdatePage / createNewPage.
 */
export interface CreatePageContext extends PathResolutionContext {
  settings: LLMWikiSettings;
  getClient(): LLMClient | null;
  buildSystemPrompt(mode: 'full' | 'compact' | 'merge' | 'entity' | 'concept' | 'index'): Promise<string>;
  createOrUpdateFile(path: string, content: string): Promise<void>;
  createOrUpdateFileUnlocked?: (path: string, content: string) => Promise<void>;
  withPathWriteLock: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
  tryReadFile(path: string): Promise<string | null>;
}

type SourceContent = AuthoritativeSourceSnapshot | string;

function groundMentions(
  mentions: EntityInfo['mentions_with_provenance'] | string[] | undefined,
  sourceContent: SourceContent,
  sourcePath: string,
): EntityInfo['mentions_with_provenance'] | string[] | undefined {
  return typeof sourceContent === 'string'
    ? filterLegacyGroundedMentions(mentions, sourceContent, sourcePath)
    : filterGroundedMentions(mentions, sourceContent, sourcePath);
}

/**
 * Issue #312 — lift the ingest-side source facts out of the analysis object
 * the engine already hands to this module. Returns undefined when there is no
 * analysis (lint-side callers), which keeps the merge path unchanged for them.
 */
export function sourceContextFromAnalysis(
  analysis: SourceAnalysis | undefined,
): SourceContext | undefined {
  if (!analysis) return undefined;
  return {
    sourceTitle: analysis.source_title,
    summary: analysis.summary,
    sourcePath: analysis.source_file,
    noteAliases: analysis.source_note_aliases,
  };
}

/**
 * Generic page CRUD (entity/concept unified). Returns:
 *   - { path } when a page was written.
 *   - { path: null } when the name was empty.
 */
export async function createOrUpdatePage(
  ctx: CreatePageContext,
  info: EntityInfo | ConceptInfo,
  pageType: 'entity' | 'concept',
  sourceFile: TFile | { path: string; basename: string },
  extraPagePaths: string[] = [],
  sourceSlug?: string,
  sourceContext?: SourceContext,
  sourceContent?: SourceContent,
  resolutionOverride?: ResolvedPathResult,
): Promise<PageCreationResult> {
  if (!info.name || info.name.trim().length === 0) {
    console.warn(`${pageType} name is empty, skipping creation`);
    return { path: null, created: false };
  }

  console.debug(`=== Creating/Updating ${pageType} page ===`);
  console.debug('name:', info.name);
  console.debug('type:', info.type);

  // Issue #446: `info.type` is the term this page will carry as its own `tags:`
  // (see the generation template), so it is like-for-like with the candidate
  // pages' tags and needs no new read at the note.
  const result = resolutionOverride
    ? resolutionOverride
    : await resolvePagePath(ctx, info.name, pageType, info.summary, info.type ? [info.type] : undefined);
  if (result.path === null) {
    // Nothing was written: the resolver reached no decision it could act on.
    return { ...result, created: false };
  }
  const resolvedPath = result.path;
  if (result.aliasCommit && result.aliasCommit.targetPath !== resolvedPath) {
    throw new Error(
      `Refusing alias commit for ${result.aliasCommit.targetPath}: resolved write path is ${resolvedPath}`,
    );
  }
  console.debug('Resolved path:', resolvedPath);

  const commitResolution = async (pageResult: PageCreationResult): Promise<PageCreationResult> => {
    if (pageResult.path && result.aliasCommit) {
      if (pageResult.path !== resolvedPath) {
        throw new Error(
          `Refusing alias commit for ${result.aliasCommit.targetPath}: successful write path was ${pageResult.path}`,
        );
      }
      // This function is called from inside updatePage, which itself runs
      // under the mandatory lock for resolvedPath. The alias therefore merges
      // against the just-written page rather than a stale preflight snapshot.
      await appendAliases(ctx, result.aliasCommit.targetPath, [result.aliasCommit.alias]);
    }
    return pageResult;
  };

  const updatePage = async (): Promise<PageCreationResult> => {
    // Read inside the path lock. A concurrent page-generation task may have
    // created or updated this page while this task was resolving its path.
    // Reading before the lock would let both tasks merge against the same
    // stale snapshot and the later write would discard the first merge.
    const existingContent = await ctx.tryReadFile(resolvedPath);

    if (!existingContent) {
      const createdPath = await createNewPage(ctx, info, pageType, sourceFile, extraPagePaths, resolvedPath, sourceSlug, sourceContent);
      return commitResolution({ path: createdPath, created: true });
    }

    const isReviewed = parseFrontmatter(existingContent)?.reviewed === true;

    if (isReviewed) {
      console.debug(`${pageType} page has reviewed: true, using minimal append mode:`, resolvedPath);
      const updatedPath = await appendToReviewedPage(ctx, info, sourceFile, existingContent, resolvedPath, sourceSlug, sourceContent);
      return commitResolution({ path: updatedPath, created: false });
    }

    const mergedPath = await mergePage(ctx, info, pageType, sourceFile, existingContent, extraPagePaths, resolvedPath, sourceSlug, sourceContext, sourceContent);
    return commitResolution({ path: mergedPath, created: false });
  };

  return ctx.withPathWriteLock(resolvedPath, updatePage);
}

/**
 * Public wrapper: create or update an entity page. Delegates to the
 * generic createOrUpdatePage router.
 */
export async function createOrUpdateEntityPage(
  ctx: CreatePageContext,
  entity: EntityInfo,
  analysis: SourceAnalysis | undefined,
  sourceFile: TFile | { path: string; basename: string },
  extraPagePaths: string[] = [],
  sourceSlug?: string,
  sourceContent?: SourceContent,
  resolutionOverride?: ResolvedPathResult,
): Promise<PageCreationResult> {
  return createOrUpdatePage(
    ctx, entity, 'entity', sourceFile, extraPagePaths, sourceSlug,
    sourceContextFromAnalysis(analysis),
    sourceContent,
    resolutionOverride,
  );
}

/**
 * Public wrapper: create or update a concept page. Delegates to the
 * generic createOrUpdatePage router.
 */
export async function createOrUpdateConceptPage(
  ctx: CreatePageContext,
  concept: ConceptInfo,
  analysis: SourceAnalysis | undefined,
  sourceFile: TFile | { path: string; basename: string },
  extraPagePaths: string[] = [],
  sourceSlug?: string,
  sourceContent?: SourceContent,
  resolutionOverride?: ResolvedPathResult,
): Promise<PageCreationResult> {
  return createOrUpdatePage(
    ctx, concept, 'concept', sourceFile, extraPagePaths, sourceSlug,
    sourceContextFromAnalysis(analysis),
    sourceContent,
    resolutionOverride,
  );
}

/**
 * Generate a brand-new entity/concept page body via the LLM. Used when
 * the resolved path doesn't exist yet. Issues #244 and #85:
 *   - #85: pass settings so custom tag vocabulary is honored.
 *   - #244: programmatically inject the Mentions section so the LLM cannot
 *     drift the citation format or leak note-folder prefixes into the body.
 *
 * Throws via `contextualizeError` on any failure, wrapping the entity/concept
 * name + page type for easier triage.
 */
export async function createNewPage(
  ctx: CreatePageContext,
  info: EntityInfo | ConceptInfo,
  pageType: 'entity' | 'concept',
  sourceFile: TFile | { path: string; basename: string },
  extraPagePaths: string[],
  path: string,
  sourceSlug?: string,
  sourceContent?: SourceContent,
): Promise<string | null> {
  const client = ctx.getClient();
  if (!client) throw new Error('LLM client not initialized');

  try {
    const generatePrompt = pageType === 'entity' ? PROMPTS.generateEntityPage : PROMPTS.generateConceptPage;

    const prompt = renderTemplate(generatePrompt, {
      entity_name: info.name,
      concept_name: info.name,
      entity_type: info.type,
      concept_type: info.type,
      entity_summary: info.summary,
      concept_summary: info.summary,
      extraction_aliases: info.aliases?.length ? `[${info.aliases.join(', ')}]` : 'None',
      related_entities: info.related_entities?.join(', ') || 'No related entities',
      related_concepts: info.related_concepts?.join(', ') || 'No related concepts',
      related_content: 'No existing content',
      merge_strategy: 'New page, no merge needed.',
      date: new Date().toISOString().split('T')[0],
      // Issue #155: entity/concept pages cite the canonical source PAGE
      // ([[sources/<slug>]]), not the raw note path — so a collision-
      // disambiguated source slug is honored and the normalizer passes it
      // through unchanged.
      source_file: sourceSlug ? `sources/${sourceSlug}` : sourceFile.path,
    });

    // #328 Phase 1 follow-up: user-layer tag-vocab removed — system layer injects once.
    const finalPrompt = applySectionLabels(prompt, ctx.settings);

    const pageContent = await client.createMessage({
      task: 'page-generate',
      model: resolveModelForTask(ctx.settings, 'ingest'),
      max_tokens: TOKENS_PAGE_GENERATION,
      system: await ctx.buildSystemPrompt(pageType),
      messages: [{ role: 'user', content: finalPrompt }],
      ...(ctx.settings.disableThinking ? { enableThinking: false } : {}),
    });

    const cleanedContent = cleanMarkdownResponse(pageContent);
    // Issue #85: pass settings so custom tag vocabulary is honored.
    // Issue #388: no `preserveCreated` — this page is being created, so there is
    // no prior file and no real creation date to preserve. Anything `created:`
    // in the model's reply says about the past is invented by construction.
    const enforcedContent = enforceFrontmatterConstraints(cleanedContent, pageType, ctx.settings);
    const taxonomyMismatches = findOppositeTaxonomyTags(
      pageType,
      parseFrontmatter(enforcedContent)?.tags,
      ctx.settings,
    );
    if (taxonomyMismatches.length > 0) {
      throw new Error(
        `Taxonomy mismatch: ${pageType} page has opposite-only tag(s): ${taxonomyMismatches.join(', ')}`,
      );
    }
    const labels = getSectionLabels(ctx.settings);
    // Re-assert the known section labels before the link corrector runs, so a
    // garbled `## Verwandte …` header still resolves its section for prefix
    // correction.
    const canonicalizedContent = canonicalizeSectionHeaders(enforcedContent, Object.values(labels));
    const existingPages = await getExistingWikiPages(ctx.app as never, ctx.settings.wikiFolder);
    const correctedContent = correctRelatedLinkPrefixes(
      canonicalizedContent,
      info.related_entities,
      info.related_concepts,
      labels.related_entities,
      labels.related_concepts,
      ctx.settings.slugCase === 'preserve',
      // #482 stage 2: the prompt no longer carries a page list, so the link
      // targets are resolved here — against every page, not a window.
      { wikiFolder: ctx.settings.wikiFolder, pages: existingPages },
    );
    const generatedRefs: GeneratedLinkPageRef[] = [
      { path, title: info.name, aliases: info.aliases },
      ...extraPagePaths.map(plannedPath => ({
        path: plannedPath,
        title: plannedPath.replace(/\.md$/i, '').split('/').pop() ?? plannedPath,
      })),
      { path: sourceFile.path, title: sourceFile.basename },
      ...(sourceSlug ? [{
        path: `${ctx.settings.wikiFolder}/sources/${sourceSlug}.md`,
        title: sourceSlug,
      }] : []),
    ];
    const guardedContent = guardGeneratedWikiLinks(correctedContent, {
      wikiFolder: ctx.settings.wikiFolder,
      pages: existingPages,
      additionalPages: generatedRefs,
    });
    // Issue #244: programmatically inject the Mentions section.
    const isConv = isConversationSource(sourceFile, ctx.settings.wikiFolder);
    const mentionsForInject = isConv
      ? []
      : (info.mentions_with_provenance?.length
        ? info.mentions_with_provenance
        : info.mentions_in_source);
    const groundedMentions = sourceContent === undefined
      ? mentionsForInject
      : groundMentions(mentionsForInject, sourceContent, sourceFile.path);
    const mentionsInjectedContent = injectMentionsSection(
      guardedContent,
      groundedMentions ?? [],
      sourceFile.path,
      {
        sectionLabel: labels.mentions_in_source,
        conversationMode: isConv,
        conversationLabel: `Conversation: ${sourceFile.basename}`,
      },
    );
    // #365 v1.25.11 PATCH: stamp `sources:` provenance on every freshly
    // generated page. `enforceFrontmatterConstraints` rewrites the
    // frontmatter block from a fixed allowlist (`type/created/updated/tags/
    // aliases/reviewed`), so the `sources:` that `merge-page.ts:93` writes
    // is stripped here. Splice `mergeFrontmatter` AFTER every transform step
    // (last thing before the write). We use the SAME helper that
    // `merge-page.ts:95` uses, so the byte-shape of the `sources:` entry is
    // identical regardless of which code path produced the page — bit-
    // identical `[[sources/<slug>]]` wikilink form (line 490 of frontmatter.ts
    // rewraps every entry). This is the Plan-A path: smallest blast radius
    // because the only thing the surrounding code learns is that
    // `createNewPage` now goes through `mergeFrontmatter` before the write;
    // we do not touch `enforceFrontmatterConstraints` (which 8+ callers
    // depend on, including the fix-runners that re-touch pages and would
    // otherwise need to relearn this rule).
    //
    // Guarded by `sourceSlug` truthiness so the two non-ingest call sites
    // (conversation-ingest.ts:251 / :270 do not pass sourceSlug) leave the
    // content unchanged — they never had a source-stamp in the LLM prompt,
    // and synthesising `sources/undefined` would be a hard regression on the
    // conversation-source path.
    //
    // If `enforceFrontmatterConstraints` returned content without a
    // parseable frontmatter block (LLM drift on the very rare path),
    // `mergeFrontmatter` reports `wasMerged:false` — we leave the content
    // unchanged rather than synthesise a thin frontmatter block. The
    // sources stamp is a best-effort add-on; it is strictly less risky than
    // the primary write.
    // Inline source-stamp to avoid `mergeFrontmatter`'s 4× regex pass
    // (parseFrontmatter + extractBody + extractPassthroughLines +
    // serializeFrontmatter rebuild). `enforceFrontmatterConstraints`
    // already produced a clean YAML block; we only need to splice
    // `sources: [[[sources/<slug>]]]` into the existing block without
    // re-serializing type/created/updated/tags/aliases. The original
    // `mergeFrontmatter` helper still owns the merge-page.ts path
    // (which has different requirements: emit a fresh `updated:`
    // stamp and full re-serialization).
    const sourcedContent = sourceSlug
      ? appendSourceSlugToFrontmatter(mentionsInjectedContent, sourceSlug)
      : mentionsInjectedContent;
    await (ctx.createOrUpdateFileUnlocked ?? ctx.createOrUpdateFile)(path, sourcedContent);
    return path;
  } catch (error) {
    throw contextualizeError(error, info.name, pageType);
  }
}

/**
 * v1.25.11 PATCH #365 source-stamp helper (Plan A): splice a single
 * `[[sources/<slug>]]` entry into the document's existing frontmatter
 * block without re-serializing the whole YAML. Designed to be called
 * AFTER `enforceFrontmatterConstraints` has produced a clean block
 * (so the byte-shape of type/created/updated/tags/aliases is already
 * canonical). Falls back to returning the input unchanged when the
 * content has no parseable frontmatter — same semantics as
 * `mergeFrontmatter.wasMerged=false`.
 *
 * The dedup contract matches `mergeFrontmatter` line 484-490: a Set
 * of normalized wikilink forms, re-wrapped as `[[name]]`. The slug
 * input here is the bare source slug (no `sources/` prefix and no
 * `[[]]` wrapper); we add both to keep the wire format identical to
 * what `merge-page.ts:95` would have produced.
 */
// Exported for direct unit-test coverage of the flow-style detection path
// added for #399. Not part of the plugin's public API — call sites live in
// createOrUpdatePage / createNewPage above.
export function appendSourceSlugToFrontmatter(content: string, sourceSlug: string): string {
  if (!content.startsWith('---')) return content;
  const fmEnd = content.indexOf('\n---\n', 3);
  if (fmEnd === -1) return content;
  const fmText = content.substring(3, fmEnd).replace(/^\n/, '');
  const body = content.substring(fmEnd + 5);
  const sourceEntry = `[[sources/${sourceSlug}]]`;

  const lines = fmText.split('\n');

  // First, handle inline flow-style `sources: ["[[...]]", ...]`. Prior to
  // this fix, we only matched the block-style form `^sources:\s*$`, so a
  // flow-style existing key would fall through to the "no sources yet"
  // branch and get a NEW block-style key inserted — producing two
  // top-level `sources:` keys, which is invalid YAML and breaks the
  // Properties panel. See #399. Detect the flow-style form, extract its
  // wikilink entries, add the new one if absent, then re-emit as
  // block-style (canonical shape used elsewhere in the plugin).
  const flowIdx = lines.findIndex(l => /^sources:\s*\[.*\]\s*$/.test(l));
  if (flowIdx !== -1) {
    const flowMatch = lines[flowIdx].match(/^sources:\s*\[(.*)\]\s*$/);
    const entries: string[] = [];
    if (flowMatch && flowMatch[1].trim().length > 0) {
      const linkPattern = /\[\[([^\]]+)\]\]/g;
      let m;
      while ((m = linkPattern.exec(flowMatch[1])) !== null) {
        entries.push(m[1]);
      }
    }
    const targetLink = sourceEntry.slice(2, -2);
    if (entries.includes(targetLink)) return content;
    entries.push(targetLink);
    // Double-quote wikilink values. Unquoted `- [[x]]` YAML-parses as a
    // nested flow sequence (not a string), which breaks Obsidian's Properties
    // panel + backlinks + graph edges. Match `yamlStringify()` in
    // src/core/frontmatter.ts (line 104). See PR #405 review.
    const blockLines = ['sources:', ...entries.map(e => `  - "[[${e}]]"`)];
    lines.splice(flowIdx, 1, ...blockLines);
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }

  const sourcesIdx = lines.findIndex(l => /^sources:\s*$/.test(l));
  if (sourcesIdx === -1) {
    // No existing `sources:` key — insert one. Anchor on `tags:` so the
    // block order (type / created / updated / sources / tags / aliases /
    // reviewed) matches the canonical layout produced by
    // `enforceFrontmatterConstraints` + `serializeFrontmatter`.
    //
    // Double-quote the wikilink value — bare `- [[x]]` YAML-parses as a
    // nested flow sequence (not a string). See PR #405 review.
    const tagsIdx = lines.findIndex(l => /^tags:\s*$/.test(l));
    const insertAt = tagsIdx === -1 ? lines.length : tagsIdx;
    lines.splice(insertAt, 0, `sources:\n  - "${sourceEntry}"`);
  } else {
    // Existing `sources:` block — collect continuation entries, append
    // the new one if not already present, and re-emit the WHOLE block
    // in canonical quoted form. This "block heals" behavior means a
    // legacy v1.25.11-stamped file (with bare `- [[x]]` entries) gets
    // normalized to `- "[[x]]"` the next time we stamp it, matching
    // the healing behavior the flow→block branch already has. See PR
    // #405 review note A from @DocTpoint.
    //
    // Continuation lines may be quoted (`- "[[x]]"` canonical) or
    // bare (`- [[x]]` legacy) — strip surrounding quotes when reading,
    // always emit quoted when writing.
    const entries: string[] = [];
    const seen = new Set<string>();
    let contEnd = sourcesIdx + 1;
    for (let i = sourcesIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('- ')) break;
      contEnd = i + 1;
      let entry = line.substring(2).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) ||
          (entry.startsWith("'") && entry.endsWith("'"))) {
        entry = entry.slice(1, -1);
      }
      if (entry.startsWith('[[') && entry.endsWith(']]')) {
        const inner = entry.slice(2, -2).trim();
        if (!seen.has(inner)) {
          seen.add(inner);
          entries.push(inner);
        }
      }
    }
    const targetInner = sourceEntry.slice(2, -2);
    if (seen.has(targetInner)) return content;
    entries.push(targetInner);
    // Splice out the old (bare + new) continuation lines and replace
    // with the canonical quoted form for all entries.
    const newContinuation = entries.map(e => `  - "[[${e}]]"`);
    lines.splice(sourcesIdx + 1, contEnd - (sourcesIdx + 1), ...newContinuation);
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
