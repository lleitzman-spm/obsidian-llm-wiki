// Deterministic guard for wiki links emitted by ingest-time LLM calls.
//
// A generated page must not create a new dead-link edge. Existing pages and
// same-run page plans are indexed by path, title, and aliases. A link that
// cannot be resolved is rendered as its visible text instead of becoming an
// invented stub target.

import { computeSlug } from './slug';

export interface GeneratedLinkPageRef {
  path: string;
  title: string;
  aliases?: string[];
}

export interface GeneratedLinkGuardOptions {
  wikiFolder: string;
  pages: GeneratedLinkPageRef[];
  additionalPages?: GeneratedLinkPageRef[];
}

interface LinkMatch {
  path: string;
  canonicalTarget: string;
  inputTarget: string;
}

interface LiveWikilink {
  start: number;
  end: number;
  target: string;
  fragment?: string;
  display?: string;
}

interface LinkIndexes {
  path: Map<string, string>;
  pathSlug: Map<string, string>;
  title: Map<string, string>;
  titleSlug: Map<string, string>;
  alias: Map<string, string>;
  aliasSlug: Map<string, string>;
  ambiguous: {
    path: Set<string>;
    pathSlug: Set<string>;
    title: Set<string>;
    titleSlug: Set<string>;
    alias: Set<string>;
    aliasSlug: Set<string>;
  };
}

type LinkResolution =
  | { status: 'found'; path: string }
  | { status: 'ambiguous' }
  | { status: 'missing' };

function lineEnd(content: string, start: number): number {
  const newline = content.indexOf('\n', start);
  return newline === -1 ? content.length : newline + 1;
}

function isDelimiterLine(content: string, start: number, end: number, marker: string): boolean {
  let cursor = start;
  while (cursor < end && (content[cursor] === ' ' || content[cursor] === '\t')) cursor += 1;
  return content.slice(cursor, end).replace(/\r?\n$/, '').trim() === marker;
}

/**
 * Return the end of YAML frontmatter when the document starts with a
 * delimiter. Frontmatter is metadata, not live Markdown, so wikilinks in it
 * must not be canonicalized or counted as inbound prose links.
 */
function frontmatterEnd(content: string): number {
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!content.startsWith('---', start)) return 0;
  const openingEnd = lineEnd(content, start);
  if (!isDelimiterLine(content, start, openingEnd, '---')) return 0;

  let cursor = openingEnd;
  while (cursor < content.length) {
    const end = lineEnd(content, cursor);
    if (isDelimiterLine(content, cursor, end, '---') || isDelimiterLine(content, cursor, end, '...')) {
      return end;
    }
    cursor = end;
  }
  return content.length;
}

function fenceAt(content: string, start: number): { marker: '`' | '~'; length: number } | undefined {
  if (start > 0 && content[start - 1] !== '\n') return undefined;
  let cursor = start;
  let spaces = 0;
  while (cursor < content.length && spaces < 4 && (content[cursor] === ' ' || content[cursor] === '\t')) {
    cursor += 1;
    spaces += 1;
  }
  if (spaces > 3) return undefined;
  const marker = content[cursor] as '`' | '~';
  if (marker !== '`' && marker !== '~') return undefined;
  let length = 0;
  while (content[cursor + length] === marker) length += 1;
  return length >= 3 ? { marker, length } : undefined;
}

function skipFence(content: string, start: number, fence: { marker: '`' | '~'; length: number }): number {
  let cursor = lineEnd(content, start);
  while (cursor < content.length) {
    const end = lineEnd(content, cursor);
    let markerStart = cursor;
    let spaces = 0;
    while (markerStart < end && spaces < 4 && (content[markerStart] === ' ' || content[markerStart] === '\t')) {
      markerStart += 1;
      spaces += 1;
    }
    let markerLength = 0;
    while (content[markerStart + markerLength] === fence.marker) markerLength += 1;
    const suffix = content.slice(markerStart + markerLength, end).replace(/\r?\n$/, '');
    if (spaces <= 3 && markerLength >= fence.length && suffix.trim() === '') return end;
    cursor = end;
  }
  return content.length;
}

function skipInlineCode(content: string, start: number): number | undefined {
  let length = 0;
  while (content[start + length] === '`') length += 1;
  if (length === 0) return undefined;
  const delimiter = '`'.repeat(length);
  let cursor = start + length;
  while (cursor < content.length) {
    const match = content.indexOf(delimiter, cursor);
    if (match === -1) return undefined;
    const before = match > 0 ? content[match - 1] : '';
    const after = content[match + length] ?? '';
    // A delimiter run longer than the opener is not its closing delimiter.
    if (before !== '`' && after !== '`') return match + length;
    cursor = match + 1;
  }
  return undefined;
}

function isEscaped(content: string, start: number): boolean {
  let slashes = 0;
  for (let cursor = start - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function parseWikilink(content: string, start: number): LiveWikilink | undefined {
  if (content[start] !== '[' || content[start + 1] !== '[' || isEscaped(content, start)) return undefined;
  const close = content.indexOf(']]', start + 2);
  if (close === -1) return undefined;
  const body = content.slice(start + 2, close);
  const pipe = body.indexOf('|');
  const targetAndFragment = pipe === -1 ? body : body.slice(0, pipe);
  const hash = targetAndFragment.indexOf('#');
  const target = hash === -1 ? targetAndFragment : targetAndFragment.slice(0, hash);
  if (!target.trim() || target.includes(']') || (pipe !== -1 && pipe === body.length - 1)) return undefined;
  return {
    start,
    end: close + 2,
    target,
    fragment: hash === -1 ? undefined : targetAndFragment.slice(hash + 1),
    display: pipe === -1 ? undefined : body.slice(pipe + 1),
  };
}

/** Scan only wikilinks which Markdown renders as live prose. */
function scanLiveWikilinks(content: string): LiveWikilink[] {
  const links: LiveWikilink[] = [];
  let cursor = frontmatterEnd(content);
  while (cursor < content.length) {
    const fence = fenceAt(content, cursor);
    if (fence) {
      cursor = skipFence(content, cursor, fence);
      continue;
    }
    if (content.startsWith('<!--', cursor)) {
      const close = content.indexOf('-->', cursor + 4);
      cursor = close === -1 ? content.length : close + 3;
      continue;
    }
    if (content[cursor] === '`' && !isEscaped(content, cursor)) {
      const codeEnd = skipInlineCode(content, cursor);
      if (codeEnd !== undefined) {
        cursor = codeEnd;
        continue;
      }
    }
    const link = parseWikilink(content, cursor);
    if (link) {
      links.push(link);
      cursor = link.end;
      continue;
    }
    cursor += 1;
  }
  return links;
}

function replaceLiveWikilinks(content: string, replace: (link: LiveWikilink) => string): string {
  const links = scanLiveWikilinks(content);
  if (links.length === 0) return content;
  let result = '';
  let cursor = 0;
  for (const link of links) {
    result += content.slice(cursor, link.start) + replace(link);
    cursor = link.end;
  }
  return result + content.slice(cursor);
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, '');
}

function normalizePath(path: string, wikiFolder: string): string {
  const withoutExtension = stripMd(path.trim());
  const prefix = `${wikiFolder}/`;
  return withoutExtension.startsWith(prefix)
    ? withoutExtension.slice(prefix.length)
    : withoutExtension;
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  const trimmed = value.trim().normalize('NFKC').replace(/[_\u2013\u2014]+/g, '-');
  return trimmed.length > 0 ? computeSlug(trimmed) : '';
}

function addUnique(
  index: Map<string, string>,
  ambiguous: Set<string>,
  raw: string,
  path: string,
): void {
  const normalized = key(raw);
  if (!normalized) return;
  const previous = index.get(normalized);
  if (previous !== undefined && previous !== path) {
    ambiguous.add(normalized);
    return;
  }
  index.set(normalized, path);
}

function addSlug(
  index: Map<string, string>,
  ambiguous: Set<string>,
  raw: string,
  path: string,
): void {
  const normalized = slugKey(raw);
  if (!normalized) return;
  const previous = index.get(normalized);
  if (previous !== undefined && previous !== path) {
    ambiguous.add(normalized);
    return;
  }
  index.set(normalized, path);
}

function visibleText(target: string, display: string | undefined): string {
  if (display !== undefined) return display;
  const basename = target.split('/').pop() ?? target;
  return stripMd(basename);
}

function buildIndexes(
  refs: GeneratedLinkPageRef[],
  wikiFolder: string,
): LinkIndexes {
  const indexes: LinkIndexes = {
    path: new Map<string, string>(),
    pathSlug: new Map<string, string>(),
    title: new Map<string, string>(),
    titleSlug: new Map<string, string>(),
    alias: new Map<string, string>(),
    aliasSlug: new Map<string, string>(),
    ambiguous: {
      path: new Set<string>(),
      pathSlug: new Set<string>(),
      title: new Set<string>(),
      titleSlug: new Set<string>(),
      alias: new Set<string>(),
      aliasSlug: new Set<string>(),
    },
  };

  for (const page of refs) {
    const relativePath = normalizePath(page.path, wikiFolder);
    const canonicalTarget = relativePath;
    const namespace = canonicalTarget.includes('/')
      ? canonicalTarget.slice(0, canonicalTarget.lastIndexOf('/'))
      : '';
    const basename = canonicalTarget.split('/').pop() ?? canonicalTarget;
    const pathForms = [
      canonicalTarget,
      `${canonicalTarget}.md`,
      page.path,
      `${page.path}.md`,
      basename,
      `${basename}.md`,
    ];
    for (const form of pathForms) {
      addUnique(indexes.path, indexes.ambiguous.path, form, canonicalTarget);
      addSlug(indexes.pathSlug, indexes.ambiguous.pathSlug, form, canonicalTarget);
    }
    const titleForms = namespace ? [page.title, `${namespace}/${page.title}`] : [page.title];
    for (const form of titleForms) {
      addUnique(indexes.title, indexes.ambiguous.title, form, canonicalTarget);
      addSlug(indexes.titleSlug, indexes.ambiguous.titleSlug, form, canonicalTarget);
    }
    for (const alias of page.aliases ?? []) {
      const aliasForms = namespace ? [alias, `${namespace}/${alias}`] : [alias];
      for (const form of aliasForms) {
        addUnique(indexes.alias, indexes.ambiguous.alias, form, canonicalTarget);
        addSlug(indexes.aliasSlug, indexes.ambiguous.aliasSlug, form, canonicalTarget);
      }
    }
  }

  return indexes;
}

function resolveFromIndexes(target: string, indexes: LinkIndexes): LinkResolution {
  const exact = key(target);
  const slug = slugKey(target);
  const stages: Array<[Map<string, string>, Set<string>, string]> = [
    [indexes.path, indexes.ambiguous.path, exact],
    [indexes.title, indexes.ambiguous.title, exact],
    [indexes.alias, indexes.ambiguous.alias, exact],
    [indexes.pathSlug, indexes.ambiguous.pathSlug, slug],
    [indexes.titleSlug, indexes.ambiguous.titleSlug, slug],
    [indexes.aliasSlug, indexes.ambiguous.aliasSlug, slug],
  ];
  for (const [index, conflicts, lookup] of stages) {
    if (!lookup) continue;
    if (conflicts.has(lookup)) return { status: 'ambiguous' };
    const path = index.get(lookup);
    if (path) return { status: 'found', path };
  }
  return { status: 'missing' };
}

/**
 * Canonicalize or remove wikilinks in generated content.
 *
 * Title matches outrank aliases. Exact path/basename matches are checked
 * before title/alias matches, and slug-normalized matches are accepted only
 * when unambiguous. The returned content keeps display text and anchors.
 */
export function guardGeneratedWikiLinks(
  content: string,
  options: GeneratedLinkGuardOptions,
): string {
  const existingIndexes = buildIndexes(options.pages, options.wikiFolder);
  const additionalIndexes = buildIndexes(options.additionalPages ?? [], options.wikiFolder);

  const resolve = (rawTarget: string): LinkMatch | undefined => {
    const target = rawTarget.trim();
    const existing = resolveFromIndexes(target, existingIndexes);
    if (existing.status === 'ambiguous') return undefined;
    const planned = existing.status === 'missing'
      ? resolveFromIndexes(target, additionalIndexes)
      : existing;
    if (planned.status !== 'found') return undefined;
    const canonicalTarget = planned.path;
    return {
      path: canonicalTarget,
      canonicalTarget,
      inputTarget: target,
    };
  };

  return replaceLiveWikilinks(content, (link) => {
    const target = link.target.trim();
    const match = resolve(target);
    if (!match) return visibleText(target, link.display);

    const anchor = link.fragment ? `#${link.fragment}` : '';
    const targetKey = key(target);
    const canonicalKey = key(match.canonicalTarget);
    const label = link.display ?? (targetKey === canonicalKey ? undefined : visibleText(target, undefined));
    return `[[${match.canonicalTarget}${anchor}${label === undefined ? '' : `|${label}`}]]`;
  });
}

/**
 * Ensure a generated source summary links every page the ingest resolved.
 * LLM summaries may choose a useful subset for prose, but the provenance hub
 * must provide an inbound edge to every emitted page so successful output does
 * not become orphaned. Paths are already resolver decisions; no guessing is
 * performed here.
 */
export function ensureGeneratedPageLinks(
  content: string,
  pagePaths: string[],
  wikiFolder: string,
): string {
  const existingTargets = new Set<string>();
  for (const link of scanLiveWikilinks(content)) {
    existingTargets.add(key(normalizePath(link.target, wikiFolder)));
  }
  const missing = [...new Set(pagePaths.map(path => normalizePath(path, wikiFolder)))]
    .filter(Boolean)
    .filter(path => !existingTargets.has(key(path)));
  if (missing.length === 0) return content;
  const section = `## Generated Pages\n\n${missing.map(path => `- [[${path}]]`).join('\n')}`;
  return `${content.trimEnd()}\n\n${section}\n`;
}
