// Lint scanner functions — extracted from lint-controller.ts for testability.
// These have no Obsidian API dependencies and can be unit tested directly.

import { parseFrontmatter } from '../../core/frontmatter';
import { getActiveEntityTags, getActiveConceptTags, getActiveSourceTags } from '../../core/tag-vocab';
import { computeSlug } from '../../core/slug';
import { normalizeQuote, isQuoteGrounded } from './utils';
import { LLMWikiSettings } from '../../types';

export interface ScannerPage {
  path: string;
  content: string;
  basename: string;
}

// Build a set of all known link targets across the vault for dead link detection.
export function buildKnownTargets(allVaultFiles: Array<{ basename: string; path: string }>): { known: Set<string>; knownLower: Set<string> } {
  const known = new Set<string>();
  const knownLower = new Set<string>();
  const addTarget = (t: string) => { known.add(t); knownLower.add(t.toLowerCase()); };
  for (const file of allVaultFiles) {
    const nameWithoutExt = file.basename.replace('.md', '');
    addTarget(file.basename);
    addTarget(nameWithoutExt);
    const relPath = file.path.replace('.md', '');
    addTarget(relPath);
    addTarget(file.path);
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const subPath = parts.slice(i).join('/');
      addTarget(subPath);
      addTarget(subPath + '.md');
    }
  }
  return { known, knownLower };
}

interface AliasTargetIndex {
  exact: Map<string, Set<string>>;
  slug: Map<string, Set<string>>;
}

/**
 * Extract the page target from a wikilink while preserving literal `#`
 * characters in known page paths.
 *
 * Obsidian uses `#` for heading fragments, but it is also a valid character
 * in a page filename. Prefer the complete path when it is a known target;
 * otherwise retain the historical fragment behavior and use the portion
 * before the first `#`. This is deliberately lookup-based: no rename or
 * slug semantics are inferred for an unknown target.
 */
function resolveWikiLinkTarget(
  rawTarget: string,
  knownTargets: Set<string>,
  knownTargetsLower: Set<string>,
): string | undefined {
  const pipeIndex = rawTarget.indexOf('|');
  const path = (pipeIndex >= 0 ? rawTarget.slice(0, pipeIndex) : rawTarget).trim();
  if (!path) return undefined;

  if (knownTargets.has(path) || knownTargetsLower.has(path.toLowerCase())) {
    return path;
  }

  const fragmentIndex = path.indexOf('#');
  if (fragmentIndex < 0) return path;
  const pageTarget = path.slice(0, fragmentIndex).trim();
  return pageTarget || undefined;
}

/**
 * Build the alias index used by the programmatic dead-link scanner.
 *
 * `buildKnownTargets` deliberately indexes filesystem names only. Generated
 * pages, however, commonly emit a typed path whose basename is an alias
 * (e.g. `[[entities/spm]]` for the page whose filename is
 * `strategic-property-management.md`). Obsidian's resolver can answer that
 * name from frontmatter, so treating it as dead is a scanner false positive.
 *
 * The index stores page paths rather than a single winner. This is important:
 * two pages may claim the same alias, and lint must fail closed instead of
 * choosing whichever page happened to be iterated first.
 */
function buildAliasTargetIndex(pageMap: Map<string, ScannerPage>): AliasTargetIndex {
  const index: AliasTargetIndex = { exact: new Map(), slug: new Map() };

  const add = (map: Map<string, Set<string>>, key: string, path: string): void => {
    if (!key) return;
    const paths = map.get(key) ?? new Set<string>();
    paths.add(path);
    map.set(key, paths);
  };

  for (const [path, page] of pageMap) {
    const aliases = parseFrontmatter(page.content)?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue;
      const trimmed = alias.trim();
      if (!trimmed) continue;
      add(index.exact, trimmed.toLowerCase(), path);
      const slug = computeSlug(trimmed);
      if (slug) add(index.slug, slug, path);
    }
  }

  return index;
}

/**
 * Return true only when a dead-link target has one unambiguous alias owner.
 * Canonical path matching remains the caller's first choice; this helper is
 * consulted only after exact and slugged filesystem forms failed.
 */
function hasUniqueAliasTarget(
  target: string,
  wikiFolder: string,
  index: AliasTargetIndex,
): boolean {
  const withoutExtension = target.replace(/\.md$/i, '');
  const parts = withoutExtension.split('/');
  const prefix = parts.length > 1 ? parts[0] : undefined;
  const aliasKey = parts[parts.length - 1].trim().toLowerCase();
  if (!aliasKey) return false;

  // A folder-qualified target is allowed to resolve through an alias only
  // within that typed folder. Sources are excluded: source links are identity
  // links and aliasing them would mask a missing provenance page.
  if (prefix === 'sources' || prefix === 'source') return false;
  const expectedFolder = prefix === 'entities' || prefix === 'entity'
    ? `${wikiFolder}/entities/`
    : prefix === 'concepts' || prefix === 'concept'
      ? `${wikiFolder}/concepts/`
      : undefined;

  const filterToFolder = (paths: Set<string>): Set<string> => {
    if (!expectedFolder) return paths;
    return new Set([...paths].filter(path => path.startsWith(expectedFolder)));
  };

  // Exact alias ownership takes precedence over slug-normalized ownership,
  // matching the resolver's exact-before-slug contract. Any collision is
  // intentionally unresolved.
  const exactPaths = filterToFolder(index.exact.get(aliasKey) ?? new Set());
  if (exactPaths.size > 0) return exactPaths.size === 1;

  const slug = computeSlug(aliasKey);
  const slugPaths = filterToFolder(index.slug.get(slug) ?? new Set());
  return slugPaths.size === 1;
}

// Detect pages with missing aliases (entities & concepts only).
export function detectAliasDeficiency(
  wikiFiles: Array<{ path: string }>,
  pageMap: Map<string, ScannerPage>
): ScannerPage[] {
  const result: ScannerPage[] = [];
  for (const file of wikiFiles) {
    if (file.path.includes('/entities/') || file.path.includes('/concepts/')) {
      const info = pageMap.get(file.path);
      if (info) {
        const fmMatch = info.content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch && !hasNonEmptyAliases(fmMatch[1])) {
          result.push(info);
        }
      }
    }
  }
  return result;
}

/**
 * v1.24.0: A page is "alias-deficient" when the frontmatter either
 * lacks an `aliases:` line entirely, OR the aliases line is empty
 * (`aliases: []` or `aliases:\n  - ""`). The previous `includes('aliases:')`
 * check falsely treated empty arrays as "has aliases" — when a user
 * deleted every alias entry in Obsidian, lint missed the deficiency.
 *
 * Inline-style and block-style empty arrays are both detected:
 *   - `aliases: []`                 → empty inline
 *   - `aliases:\n  - ""\n  - ""`    → block with only empty strings
 *   - `aliases:\n` (no entries)     → block with zero entries
 */
function hasNonEmptyAliases(frontmatter: string): boolean {
  // Match `aliases:` followed by everything up to end-of-line (no \n).
  // Use [^\n]* for the trailing content to avoid consuming newlines
  // that belong to subsequent block entries.
  const aliasesLineMatch = frontmatter.match(/^aliases:[ \t]*(.*)$/m);
  if (!aliasesLineMatch) return false;

  const inlineContent = aliasesLineMatch[1].trim();

  // Inline-style: `aliases: []` or `aliases: [a, b, ...]`.
  if (inlineContent.startsWith('[')) {
    const innerMatch = inlineContent.match(/^\[(.*)\]$/);
    if (innerMatch) {
      const items = innerMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/^['"](.*)['"]$/, '$1'));
      return items.some(item => item.length > 0);
    }
  }

  // Inline empty OR block-style: look for indented `-` entries
  // on subsequent lines and check whether they have content.
  const aliasesLineIdx = aliasesLineMatch.index ?? 0;
  const afterAliases = frontmatter.substring(aliasesLineIdx + aliasesLineMatch[0].length);
  const blockEntries = afterAliases.match(/^[ \t]+-[ \t]*(.*)$/gm) || [];

  let blockHasContent = false;
  for (const rawEntry of blockEntries) {
    const m = rawEntry.match(/^[ \t]+-[ \t]*(.*?)[ \t]*$/);
    if (!m) continue;
    const entryValue = m[1].replace(/^['"](.*)['"]$/, '$1');
    if (entryValue.length > 0) {
      blockHasContent = true;
      break;
    }
  }

  // If `aliases: foo` had inline content but no brackets, treat it
  // as a single-entry list with content.
  if (!blockHasContent && inlineContent.length > 0) {
    return true;
  }

  return blockHasContent;
}

// Scan wiki pages for dead links ([[wikilinks]] pointing to non-existent targets).
// Uses Map<string, {path, content, basename}> which requires no Obsidian types.
export function scanDeadLinks(
  pageMap: Map<string, ScannerPage>,
  knownTargets: Set<string>,
  knownTargetsLower: Set<string>,
  wikiFolder: string
): Array<{ source: string; target: string }> {
  const deadLinks: Array<{ source: string; target: string }> = [];
  const aliasIndex = buildAliasTargetIndex(pageMap);
  // Per-(source,target) dedup so a page referencing the same missing target
  // 4 times shows up as 1 entry, not 4. Diff against (source, target) across
  // pages intentionally stays (different source pages should each list the
  // missing targets they reference, so users can see which sources are affected).
  const seen = new Set<string>();
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  for (const { path, content } of pageMap.values()) {
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      const target = resolveWikiLinkTarget(match[1], knownTargets, knownTargetsLower);
      if (!target) continue;
      const targetLower = target.toLowerCase();
      if (!knownTargets.has(target) && !knownTargetsLower.has(targetLower)) {
        // Slug-normalized fallback: "entities/Claude Code" matches "entities/Claude-Code"
        const parts = target.split('/');
        const sluggedBasename = parts[parts.length - 1].replace(/\s+/g, '-');
        const sluggedTarget = [...parts.slice(0, -1), sluggedBasename].join('/');
        const isSlugMatch =
          sluggedTarget !== target &&
          (knownTargets.has(sluggedTarget) || knownTargetsLower.has(sluggedTarget.toLowerCase()));
        const isAliasMatch = !isSlugMatch && hasUniqueAliasTarget(target, wikiFolder, aliasIndex);
        if (!isSlugMatch && !isAliasMatch) {
          const source = path.replace(wikiFolder + '/', '').replace('.md', '');
          const key = `${source}::${target}`;
          if (!seen.has(key)) {
            seen.add(key);
            deadLinks.push({ source, target });
          }
        }
      }
    }
    linkRegex.lastIndex = 0;
  }
  return deadLinks;
}

// Detect orphan pages (no incoming links from any wiki page, alias-aware).
export function scanOrphans(
  pageMap: Map<string, ScannerPage>,
  wikiFolder: string
): string[] {
  const incomingLinks = new Map<string, string[]>();
  const { known, knownLower } = buildKnownTargets(
    [...pageMap.values()].map(({ basename, path }) => ({ basename, path }))
  );
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  for (const { path, content } of pageMap.values()) {
    const sourceRel = path.replace(wikiFolder + '/', '').replace('.md', '');
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      const target = resolveWikiLinkTarget(match[1], known, knownLower);
      if (!target) continue;
      if (!incomingLinks.has(target)) incomingLinks.set(target, []);
      incomingLinks.get(target)!.push(sourceRel);
    }
    linkRegex.lastIndex = 0;
  }
  const orphans: string[] = [];
  for (const { path, basename, content } of pageMap.values()) {
    const fm = parseFrontmatter(content);
    const aliases = Array.isArray(fm?.aliases) ? fm.aliases : [];
    const relPath = path.replace(wikiFolder + '/', '').replace('.md', '');
    const nameWithoutExt = basename.replace('.md', '');
    const forms = [basename, nameWithoutExt, relPath, ...aliases];
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const subPath = parts.slice(i).join('/');
      forms.push(subPath);
      forms.push(subPath + '.md');
    }
    const hasIncoming = forms.some(f => incomingLinks.has(f) || incomingLinks.has(f.toLowerCase()));
    if (!hasIncoming) orphans.push(path);
  }
  return orphans;
}

// ── Quote grounding scanner (Issue #126) ──────────────────────

export interface QuoteGroundingIssue {
  pagePath: string;
  sourcePath?: string;
  quote: string;
  hasSourceLink: boolean;
}

/**
 * Split a link target into its path-without-`.md` and a flag indicating
 * whether the original ended in `.md`. Used by the direct raw-note path
 * compatibility branch below.
 */
function splitMdExtension(target: string): { basePath: string; hasMd: boolean } {
  if (target.endsWith('.md')) {
    return { basePath: target.slice(0, -3), hasMd: true };
  }
  return { basePath: target, hasMd: false };
}

function extractMentionsSection(content: string, mentionsLabel: string): string | undefined {
  // Match the localized "## <label>" section up to the next ## heading.
  // Caller MUST pass the resolved label from getSectionLabels(settings).
  const escaped = mentionsLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i'));
  return match?.[1];
}

function extractSourceBody(content: string): string {
  // Strip YAML frontmatter while preserving the raw body byte-for-byte.
  // Both LF and CRLF vault files are valid input.
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

/**
 * Projection/model output sometimes uses an omission marker in place of
 * source text. Such a marker is evidence only when the exact marker is
 * literally present in the raw source body; normalized matching must never
 * turn it into a passing quote.
 */
function containsOmissionMarker(quote: string): boolean {
  return /(?:\.\.\.|…|\[\s*(?:omitted|truncated|redacted)[^\]]*\]|\b(?:omitted|truncated|redacted)\b)/iu.test(quote);
}

function quoteMatchesBody(
  quote: string,
  body: string,
  allowNormalizedMatch: boolean,
): boolean {
  if (containsOmissionMarker(quote)) return body.includes(quote);
  return allowNormalizedMatch ? isQuoteGrounded(quote, body) : body.includes(quote);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function generatedSourcePagePath(target: string, wikiFolder: string): string | undefined {
  const normalizedTarget = normalizePath(target.trim());
  const folderPrefix = `${normalizePath(wikiFolder).replace(/\/$/, '')}/sources/`;
  let slug: string | undefined;
  if (normalizedTarget.startsWith('sources/')) {
    slug = normalizedTarget.slice('sources/'.length);
  } else if (normalizedTarget.startsWith(folderPrefix)) {
    slug = normalizedTarget.slice(folderPrefix.length);
  } else {
    return undefined;
  }
  if (!slug) return undefined;
  return `${folderPrefix}${slug.replace(/\.md$/i, '')}.md`;
}

function uniqueByPath(pages: ScannerPage[]): ScannerPage[] {
  const byPath = new Map<string, ScannerPage>();
  for (const page of pages) byPath.set(normalizePath(page.path), page);
  return [...byPath.values()];
}

/**
 * Resolve a generated source page and its raw source note fail-closed.
 *
 * A `sources/...` citation is a projection reference, not a raw-note path:
 * it must identify exactly one generated page with `type: source`, and that
 * page must identify exactly one raw note through `source_file`. No basename,
 * version, or "any source" fallback is allowed here.
 */
function resolveGeneratedSource(
  target: string,
  wikiFolder: string,
  pageMap: Map<string, ScannerPage>,
  sourceMap: Map<string, ScannerPage>,
): { generatedPath: string; rawSource?: ScannerPage } {
  const generatedPath = generatedSourcePagePath(target, wikiFolder);
  if (!generatedPath) return { generatedPath: target };

  const targetKey = normalizePath(generatedPath).toLowerCase();
  const generatedPages = uniqueByPath(
    [...pageMap.values(), ...sourceMap.values()].filter(page =>
      normalizePath(page.path).toLowerCase() === targetKey
    )
  );
  if (generatedPages.length !== 1) return { generatedPath };

  const generated = generatedPages[0];
  const frontmatter = parseFrontmatter(generated.content);
  if (frontmatter?.type !== 'source' || typeof frontmatter.source_file !== 'string') {
    return { generatedPath };
  }

  const sourceFileValue = frontmatter.source_file.trim();
  const sourceLinks = [...sourceFileValue.matchAll(/\[\[([^\]]+)\]\]/g)];
  if (sourceLinks.length > 1) return { generatedPath };

  // Generated source pages use exactly one complete wikilink. A scalar or a
  // value with surrounding text is not an auditable raw-note binding.
  const rawTarget = sourceLinks.length === 1 && sourceLinks[0][0] === sourceFileValue
    ? sourceLinks[0][1].split('|')[0].trim()
    : '';
  if (!rawTarget) return { generatedPath };

  const { basePath, hasMd } = splitMdExtension(normalizePath(rawTarget));
  const candidates = new Set<string>([
    normalizePath(rawTarget),
    hasMd ? basePath : `${basePath}.md`,
  ]);
  const rawMatches = uniqueByPath(
    [...sourceMap.values()].filter(page => {
      const path = normalizePath(page.path);
      return [...candidates].some(candidate => path.toLowerCase() === candidate.toLowerCase());
    })
  );
  if (rawMatches.length !== 1) return { generatedPath };

  const rawPrefix = `${normalizePath(wikiFolder).replace(/\/$/, '')}/sources/`.toLowerCase();
  if (normalizePath(rawMatches[0].path).toLowerCase().startsWith(rawPrefix)) {
    return { generatedPath };
  }
  return { generatedPath, rawSource: rawMatches[0] };
}

/**
 * Issue #126: programmatic quote-grounding audit. Verifies that every quote
 * listed under a page's `## Mentions in Source` section can be found in its
 * source. `[[sources/...]]` is resolved through one generated `type: source`
 * page and one uniquely resolved `source_file` raw note. Legacy direct raw
 * note links and bare quotes retain their historical behavior.
 *
 * Generated source links use only a contiguous raw-body match after
 * frontmatter. Direct raw-note links and legacy bare quotes retain the
 * historical normalized compatibility match, except omission markers, which
 * require an exact literal match.
 *
 * Mentions may have either of these forms:
 *   - "quote text" — [[sources/slug]]     (current format)
 *   - "quote text"                          (legacy format without source link)
 *
 * Legacy bare quotes are accepted if they appear in ANY source file under
 * `wiki/sources/`. This avoids false positives on older pages generated before
 * the source-link suffix was added.
 *
 * Returns a sorted list of ungrounded issues. No file IO, no LLM.
 */
export function scanQuoteGrounding(
  pageMap: Map<string, ScannerPage>,
  sourceMap: Map<string, ScannerPage>,
  wikiFolder: string,
  mentionsLabel: string = 'Mentions in Source',
): QuoteGroundingIssue[] {
  const issues: QuoteGroundingIssue[] = [];

  // E2/E3: pre-build source-body lookup + pre-normalize once for legacy fallback.
  // Avoids re-stripping frontmatter per quote and re-normalizing per source per quote.
  const sourceBodyMap = new Map<string, string>();
  const legacySourceBodies: Array<{ body: string; normalized: string }> = [];
  const wikiSourcePrefix = `${wikiFolder}/sources/`.toLowerCase();
  for (const [p, s] of sourceMap) {
    const body = extractSourceBody(s.content);
    sourceBodyMap.set(p, body);
    // Raw linked notes are valid for an explicitly linked quote, but must not
    // widen the legacy bare-quote fallback. That fallback predates raw-note
    // provenance and is intentionally limited to generated wiki sources.
    if (p.toLowerCase().startsWith(wikiSourcePrefix)) {
      legacySourceBodies.push({ body, normalized: normalizeQuote(body) });
    }
  }

  for (const [path, page] of pageMap) {
    if (!path.startsWith(wikiFolder + '/')) continue;

    const mentionsBlock = extractMentionsSection(page.content, mentionsLabel);
    if (!mentionsBlock) continue;

    // Match formatter bullets, including blockquote-prefixed legacy bullets
    // and quote text that spans multiple physical lines. The closing quote
    // must be followed by either a citation or the end of its bullet line.
    const lineRegex = /^(?:>\s*)?[-*]\s+"([\s\S]*?)"\s*(?:[—-]\s*\[\[([^\]]+)\]\])?[ \t]*$/gm;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(mentionsBlock)) !== null) {
      const isBlockquote = match[0].trimStart().startsWith('>');
      const quote = (isBlockquote ? match[1].replace(/\r?\n>\s?/g, '\n') : match[1]).trim();
      // Keep this as a string so grouped-header lookup cannot leak an
      // optional `string | undefined` into the citation branch below.
      let linkTarget = match[2]?.trim() ?? '';

      // Older generated pages grouped blockquote bullets beneath a source
      // header instead of repeating the citation on every bullet. Preserve
      // that shape while still routing a grouped `sources/...` link through
      // the strict generated-page contract.
      if (!linkTarget && isBlockquote) {
        const headers = [...mentionsBlock
          .slice(0, match.index)
          .matchAll(/^>\s*\**[^"\n]*\[\[([^\]]+)\]\]\s*\**\s*$/gm)];
        const lastHeader = headers.at(-1);
        if (lastHeader?.[1]) linkTarget = lastHeader[1].trim();
      }

      if (linkTarget) {
        // Strip any display-name suffix: [[path|name]] → path
        const bareTarget = linkTarget.split('|')[0].trim();
        let source: ScannerPage | undefined;
        let resolvedPath: string;
        const generatedPath = generatedSourcePagePath(bareTarget, wikiFolder);
        if (generatedPath) {
          const resolved = resolveGeneratedSource(bareTarget, wikiFolder, pageMap, sourceMap);
          resolvedPath = resolved.generatedPath;
          source = resolved.rawSource;
        } else {
          // Raw-note path. Try as-is, with and without .md.
          const { basePath, hasMd } = splitMdExtension(bareTarget);
          const candidates = [
            bareTarget,
            basePath + (hasMd ? '' : '.md'),
          ];
          resolvedPath = bareTarget;
          for (const p of candidates) {
            const found = sourceMap.get(p);
            if (found) {
              source = found;
              resolvedPath = p;
              break;
            }
          }
        }

        const body = source ? sourceBodyMap.get(source.path) ?? '' : '';
        // Generated source pages are projection metadata only; never ground a
        // quote against their summary body. Their raw note is the sole source
        // of truth and requires a contiguous match after frontmatter.
        // `String.prototype.includes('')` is true. An empty or whitespace-only
        // citation is never grounded, even when a linked body exists.
        const grounded = quote.length > 0 && body.length > 0 && quoteMatchesBody(quote, body, !generatedPath);
        if (!grounded) {
          issues.push({
            pagePath: path,
            sourcePath: resolvedPath,
            quote,
            hasSourceLink: true,
          });
        }
      } else {
        // Legacy format: accept if quote appears in any source file.
        // E3: pre-normalized once, so this is O(Q) not O(Q*S).
        const normalizedQuote = normalizeQuote(quote);
        const grounded = normalizedQuote.length > 0 &&
          legacySourceBodies.some(source => containsOmissionMarker(quote)
            ? source.body.includes(quote)
            : source.normalized.includes(normalizedQuote));
        if (!grounded) {
          issues.push({
            pagePath: path,
            quote,
            hasSourceLink: false,
          });
        }
      }
    }
  }

  issues.sort((a, b) => {
    const pathCmp = a.pagePath.localeCompare(b.pagePath);
    if (pathCmp !== 0) return pathCmp;
    return a.quote.localeCompare(b.quote);
  });

  return issues;
}

// ── Tag vocabulary violation scanner (Issue #85 v7) ───────────

export type TagViolationPageType = 'entity' | 'concept' | 'source';

export interface TagViolation {
  path: string;
  pageType: TagViolationPageType;
  title: string;
  currentTags: string[];
  invalidTags: string[];   // subset of currentTags that are NOT in the active vocabulary
}

/**
 * Issue #85 v7: programmatic tag-vocabulary audit. Pure function. Walks
 * the same pageMap used by the other Lint scanners and reports every
 * entity / concept / source page whose frontmatter `tags` array
 * contains at least one value that is not in the active vocabulary.
 *
 * Active vocabulary is resolved via the existing getActive*Tags
 * helpers so this scanner automatically tracks Issue #85 v6 settings
 * (default vs custom mode, plus the new static source-page taxonomy
 * VALID_SOURCE_TAGS).
 *
 * Returns an empty array when everything is clean. No file IO, no LLM.
 * Sort: by path, so the Lint report is deterministic.
 */
export function scanTagViolations(
  pageMap: Map<string, ScannerPage>,
  settings: LLMWikiSettings,
): TagViolation[] {
  const validEntity = new Set(getActiveEntityTags(settings));
  const validConcept = new Set(getActiveConceptTags(settings));
  const validSource = new Set(getActiveSourceTags(settings));
  const violations: TagViolation[] = [];

  for (const [path, page] of pageMap) {
    const fm = parseFrontmatter(page.content);
    if (!fm) continue;
    const pageType = fm.type as TagViolationPageType | 'comparison' | 'overview' | undefined;
    if (pageType !== 'entity' && pageType !== 'concept' && pageType !== 'source') continue;

    const validSet =
      pageType === 'entity' ? validEntity :
      pageType === 'concept' ? validConcept :
      validSource;

    // tags can be a string (YAML scalar) or array. parseFrontmatter
    // returns a string for scalar and string[] for array. Accept both.
    // (The runtime type is broad; tsc narrows it to never here, so we
    // explicitly cast to unknown then back to the union we actually
    // handle below.)
    const rawTags: unknown = (fm as Record<string, unknown>).tags;
    let currentTags: string[];
    if (Array.isArray(rawTags)) {
      currentTags = rawTags.map(t => String(t).trim()).filter(t => t.length > 0);
    } else if (typeof rawTags === 'string' && rawTags.length > 0) {
      currentTags = [rawTags.trim()];
    } else {
      continue; // empty / no tags → not a violation
    }

    const invalidTags = currentTags.filter(t => !validSet.has(t));
    if (invalidTags.length > 0) {
      violations.push({
        path,
        pageType,
        title: typeof fm.title === 'string' ? fm.title : page.basename.replace(/\.md$/, ''),
        currentTags,
        invalidTags,
      });
    }
  }

  violations.sort((a, b) => a.path.localeCompare(b.path));
  return violations;
}

// ── Hub link density scanner (Issue #157 / #175, v1.23.0 P1-6) ──────────
// Re-exported from core/ because the scanner needs a Graph (wiki-link
// structure), which the other scanners don't. Keeping the
// implementation in core/ preserves the pure-function convention and
// makes the algorithm unit-testable without an Obsidian dependency.

export { scanHubLinkDensity, type HubLinkDensityIssue, type HubLinkDensityOptions } from '../../core/hub-link-distinctiveness';
