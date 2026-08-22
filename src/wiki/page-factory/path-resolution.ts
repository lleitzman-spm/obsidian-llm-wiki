// page-factory/path-resolution.ts — resolve the file path for a new entity/
// concept page and build the LLM candidate list shown to dedup prompts.
//
// Extracted from the original page-factory.ts god-class so the slug-vs-LLM
// resolution logic and the LLM candidate-list shape are independently
// testable.
//
// Behavior (v1.24.1 Phase 2 refactor — preserved verbatim):
//   - resolvePagePath: exact-slug fast path → ConflictResolver (same-type
//     slug/alias match) → LLM semantic dedup fallback. Issue #472: matching is
//     scoped to the item's own type throughout — a designator is `(letters,
//     type)`, so the same letters in the opposite folder denote a different
//     thing and are never consulted.
//   - buildPagesListForPrompt: filters out sources/ by default (#234) and
//     polluted basenames (L2); caps at MAX_PAGES=50 with entity/concept
//     bias based on includePaths; emits a "(truncated)" suffix when the cap
//     fires; optionally appends includePaths that aren't already in the
//     list.

import { WIKI_SUBFOLDERS, TOKENS_DEDUP_RESOLUTION, DEDUP_CANDIDATE_TOP_K } from '../../constants';
import { slugify } from '../../core/slug';
import { ConflictResolver } from '../../core/conflict-resolver';
import { localKeywordMatch } from '../../core/index-search';
import { getExistingWikiPages } from '../lint/get-existing-pages';
import { PROMPTS } from '../../prompts';
import { parseJsonResult } from '../../core/json';
import { normalizeLLMPath } from '../../core/prompt-builders';
import { renderTemplate } from '../../core/template-renderer';
import { resolveModelForTask } from '../../core/model-resolver';
import { PathResolutionLLMSchema } from '../../llm-sdk/output-schemas';
import { callLlm } from '../../core/llm-dispatch';

/** Page shape consumed by the dedup candidate pre-filter. */
export interface DedupCandidatePage {
  path: string;
  title: string;
  aliases?: string[];
}

/**
 * Pre-filter the same-type page list before it is rendered into the
 * semantic dedup prompt. The full list grows with the vault and made the
 * call prefill-bound (~40K prompt tokens for a 16-token answer), so only
 * the top-K lexically ranked candidates are kept.
 *
 * Recall guard (binding): the fallback to the FULL list is gated on the
 * candidate's NAME alone, not on the ranked result. Summary tokens are
 * ranking signal only — incidental substrings ("in" ⊂ "institute") make
 * the ranked list non-empty for almost any query on a large vault, so a
 * ranked-list-empty check would never fire and the translation/initialism
 * case ("MIT" vs "Massachusetts Institute of Technology", "Tsinghua
 * University" vs "清华大学") would silently lose its true duplicate. A
 * missed duplicate becomes a duplicate page, so that rare case pays the
 * old full-list cost instead of risking correctness.
 *
 * The name is additionally matched with hyphens/underscores split so
 * compound candidates share tokens with reordered variants
 * ("Diabetes-mellitus-Typ-2" ↔ "Typ-2-Diabetes").
 */
export function selectDedupCandidates(
  name: string,
  summary: string,
  sameTypePages: DedupCandidatePage[],
): DedupCandidatePage[] {
  const normalized = sameTypePages.map(p => ({
    path: p.path,
    title: p.title,
    aliases: p.aliases ?? [],
  }));
  const nameQuery = `${name} ${name.split(/[-_]+/).join(' ')}`;
  const nameHits = localKeywordMatch(nameQuery, normalized);
  if (nameHits.length === 0) return sameTypePages;
  const ranked = localKeywordMatch(`${nameQuery} ${summary.substring(0, 300)}`, normalized);
  const byPath = new Map(sameTypePages.map(p => [p.path, p]));
  return ranked
    .slice(0, DEDUP_CANDIDATE_TOP_K)
    .map(r => byPath.get(r.path))
    .filter((p): p is DedupCandidatePage => p !== undefined);
}

/** A write that must be committed only after the resolved page succeeds. */
export interface PathAliasCommit {
  targetPath: string;
  alias: string;
}

/** Mirrors the subset of PageCreationResult we return plus deferred provenance. */
export interface ResolvedPathResult {
  path: string | null;
  aliasCommit?: PathAliasCommit;
}

/**
 * Minimal context contract required by `resolvePagePath` and
 * `buildPagesListForPrompt`. Production callers pass the real EngineContext;
 * tests inject a mock with the same shape. Accepts the full `LLMWikiSettings`
 * shape (no index signature) since production callers want type-safe access
 * to other settings (provider, model, etc.).
 */
export interface PathResolutionContext {
  app: unknown;
  settings: import('../../types').LLMWikiSettings;
  tryReadFile: (path: string) => Promise<string | null>;
  /** Legacy test/facade compatibility; resolution itself never writes. */
  createOrUpdateFile?: (path: string, content: string) => Promise<void>;
  getClient(): {
    createMessage: (...args: unknown[]) => Promise<string>;
    // v1.26.3 PATCH Issue #443 expanded scope: typed-output path. Optional
    // so legacy clients (Anthropic/OpenAI/Codex) and test mocks without the
    // method still type-check; the call site falls back to createMessage.
    createMessageWithOutput?: (...args: unknown[]) => Promise<{ text: string }>;
  } | null;
  buildSystemPrompt(mode: 'full' | 'compact' | 'merge' | 'index'): Promise<string>;
}

/**
 * Determine the actual file path for a new entity/concept, using slug-based
 * matching first and falling back to LLM semantic resolution.
 *
 * This function is deliberately side-effect-free with respect to the vault.
 * When a semantic/deterministic match should acquire an alias, it returns a
 * deferred commit instruction. The page-write layer commits that instruction
 * only after its own read/modify/write operation succeeds under the target
 * path lock.
 *
 * Issue #472: the opposite folder is never consulted. A page there carrying
 * the same letters is a different designator, so it can neither be a merge
 * target nor a reason to withhold this one.
 */
export async function resolvePagePath(
  ctx: PathResolutionContext,
  name: string,
  pageType: 'entity' | 'concept',
  summary: string,
  tags?: string[],
): Promise<ResolvedPathResult> {
  const folder = pageType === 'entity' ? WIKI_SUBFOLDERS.entities : WIKI_SUBFOLDERS.concepts;
  const slug = slugify(name, ctx.settings.slugCase === 'preserve');
  const slugPath = `${ctx.settings.wikiFolder}/${folder}/${slug}.md`;

  // Fast path: exact slug match (same type folder)
  const existing = await ctx.tryReadFile(slugPath);
  if (existing !== null) {
    // Issue #472: a page in the opposite folder that happens to carry the same
    // letters is a different designator, not a duplicate of this one. It is
    // neither read nor written here — the previous code bridged the two with an
    // alias, which wrote this name into the other type's namespace and made the
    // two pages match each other on every later ingest.
    return { path: slugPath };
  }

  // Fast path 2 + Slow path: share sameTypePages across slug-match and LLM resolution
  try {
    const allPages = await getExistingWikiPages(ctx.app as never, ctx.settings.wikiFolder);

    // Use ConflictResolver for deterministic slug/alias matching before LLM fallback.
    const resolver = new ConflictResolver(ctx.settings.wikiFolder, allPages);
    const cr = resolver.resolve({ name, slug, pageType, tags });

    if (cr.action === 'merge') {
      return {
        path: cr.targetPath,
        aliasCommit: { targetPath: cr.targetPath, alias: name },
      };
    }

    // Issue #446: more than one same-type page carries this designator. The
    // deterministic gate cannot say which one is meant — tags rank the
    // candidates, they never decide identity — so the question goes to the
    // semantic dedup below with the ranked candidates at the head of the
    // list. Before this, `find` returned whichever page the vault happened to
    // yield first and the ambiguity left no trace.
    const ambiguous = cr.action === 'disambiguate' ? cr.candidates ?? [] : [];
    if (ambiguous.length > 0) {
      console.debug(`Entity resolution: ${cr.reason}`);
    }

    const sameTypePages = allPages
      .filter(p => p.path.includes(`/${folder}/`))
      .filter(p => {
        // Purge polluted entries from LLM input (L2)
        const bn = p.title || '';
        return !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(bn);
      })
      // Append-only ordering (ctime ascending): pages created during a run
      // join the rendered list at the END, so consecutive dedup calls keep a
      // byte-identical prefix and a local KV prefix cache can reuse it.
      // Alphabetical or vault-iteration order inserts new pages mid-list and
      // re-pays the prefill from the insertion point. Stable sort: pages
      // without ctime keep their relative order.
      .sort((a, b) => (a.ctime ?? 0) - (b.ctime ?? 0));

    // Same-type slug/alias match is handled above by ConflictResolver.
    // Remaining path: LLM-based semantic dedup for pages that don't match by slug/alias.

    if (sameTypePages.length === 0) return { path: slugPath };

    const selected = selectDedupCandidates(name, summary, sameTypePages);
    // The pages that actually carry the designator lead the list; the lexical
    // pre-filter supplies the rest as context.
    const pagesList = (ambiguous.length > 0
      ? [...ambiguous, ...selected.filter(p => !ambiguous.some(c => c.path === p.path))]
      : selected)
      .map(p => {
        const aliasBlock = p.aliases?.length
          ? `\n  aliases: ${p.aliases.join(', ')}`
          : '';
        return `- path: ${p.path}\n  title: ${p.title}${aliasBlock}`;
      })
      .join('\n');

    const client = ctx.getClient();
    if (!client) {
      console.error(`Entity resolution for "${name}": semantic decision required but no LLM client is available`);
      return { path: null };
    }

    const prompt = renderTemplate(PROMPTS.resolveEntityDedup, {
      wikiFolder: ctx.settings.wikiFolder,
      entity_name: name,
      entity_type: pageType,
      entity_summary: summary.substring(0, 300),
      page_type: pageType,
      existing_pages: pagesList,
    });

    const resolveArgs = {
      task: 'dedup' as const,
      model: resolveModelForTask(ctx.settings, 'ingest'),
      max_tokens: TOKENS_DEDUP_RESOLUTION,
      // Slim selector: the dedup decision is same-type and the matching
      // criteria are fully stated in the user prompt — only the Wiki
      // Structure section is load-bearing here. 'full' (~8.5K chars of
      // templates/naming/maintenance) added pure prefill cost per call.
      system: await ctx.buildSystemPrompt('index'),
      messages: [{ role: 'user' as const, content: prompt }],
      // v1.26.3 PATCH Issue #443 expanded scope: typed-output path.
      // PathResolutionLLMSchema ({match?: boolean, path?: string|null}) on the
      // wire as Tier 0 json_schema — LMStudio accepts, no parse-error fallback
      // to slugPath.
      response_format: { type: 'json_object' as const, schema: PathResolutionLLMSchema },
      ...(ctx.settings.disableThinking ? { enableThinking: false } : {}),
    };
    const response = await callLlm(client, resolveArgs);

    const parsed = await parseJsonResult(response);

    if (!parsed.ok) {
      // #407 Stage 1. Until now this path returned `null` and joined the
      // `match === false` branch below, so an unreadable reply was recorded as
      // "no existing page matches" and a new page was written for an entity
      // that may already have one — without leaving a trace, because the
      // `catch` further down only sees thrown errors.
      //
      const detail =
        parsed.reason === 'exception'
          ? `exception: ${String(parsed.error)}`
          : `${parsed.reason}, raw length ${parsed.rawLength}`;
      console.error(
        `Entity resolution for "${name}": dedup reply unreadable (${detail}) — refusing to write`,
      );
      return { path: null };
    }

    const result = parsed.value as { match?: boolean; path?: string | null };

    if (result.match && result.path) {
      const normalizedPath = normalizeLLMPath(result.path, ctx.settings.wikiFolder);
      const allowedPaths = new Set(sameTypePages.map(page => page.path));
      if (!allowedPaths.has(normalizedPath)) {
        console.error(
          `Entity resolution for "${name}": model selected unknown or wrong-type path "${normalizedPath}" — refusing to write`,
        );
        return { path: null };
      }
      console.debug(`Entity resolution: "${name}" matched existing page "${normalizedPath}"`);
      // Append the new name as an alias only after the page operation succeeds.
      return {
        path: normalizedPath,
        aliasCommit: { targetPath: normalizedPath, alias: name },
      };
    }

    // A clean negative answer is actionable only when the designator was not
    // already ambiguous. Creating a third page for an alias carried by two
    // existing pages would preserve and deepen the ambiguity.
    return { path: ambiguous.length > 0 ? null : slugPath };
  } catch (error) {
    console.error(`Entity resolution for "${name}" failed — refusing to write:`, error);
    return { path: null };
  }
}
