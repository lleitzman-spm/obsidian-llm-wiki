import { basename, extname } from 'node:path';

import { parseFrontmatter } from '../../../../../src/core/frontmatter';
import { resolveSourceSlug } from '../../../../../src/core/source-slug';
import {
  canonicalKeyId,
  claimId,
  evidenceId,
  aliasNodeId,
  pageStatementId,
  projectionEdgeId,
  sourceNodeId,
} from '../provenance/ids';
import { createContractSemanticProjection } from '../provenance/projection';
import { normalizeLabel } from '../provenance/canonical';
import { NORMALIZATION_VERSION as PROVENANCE_NORMALIZATION_VERSION } from '../provenance/vocab';
import type { ContractSemanticProjection, ProjectionEdge, ProjectionNode } from '../provenance/types';
import { BOILERPLATE_POLICY_HASH, parseProjectionPage } from '../projection-parser';
import { sha256Hex } from '../preflight/hashing';
import type { SourceInventoryEntry } from '../preflight/source-inventory';

/** The subset of the native vault adapter needed to build a deterministic projection. */
export interface NativeProjectionVault {
  getMarkdownFiles(): readonly { path: string; name: string }[];
  read(file: { path: string; name: string }): Promise<string>;
}

export interface NativeProjectionInput {
  readonly runId: string;
  readonly authorityTree: string;
  readonly wikiFolder: string;
  /** Must match the copied vault's slugCase setting; lower is native default. */
  readonly slugCase?: 'lower' | 'preserve';
  readonly sourceInventory: readonly SourceInventoryEntry[];
  readonly vault: NativeProjectionVault;
}

const WIKI_PAGE_TYPES = new Set(['entity', 'concept', 'source', 'overview', 'comparison']);

interface SourceRef {
  readonly source: SourceInventoryEntry;
  readonly references: readonly string[];
}

interface NativePageRecord {
  readonly path: string;
  readonly contentSha256: string;
  readonly frontmatter: Record<string, unknown> | null;
  readonly type: string;
  readonly parsed: ReturnType<typeof parseProjectionPage>;
  readonly normalizedLabel: string;
  readonly key: string;
  readonly pageSources: readonly SourceInventoryEntry[];
  readonly links: readonly string[];
}

function normalizedVaultPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').normalize('NFKC');
}

function normalizedWikiFolder(value: string): string {
  return normalizedVaultPath(value);
}

function sourcePagePath(source: SourceInventoryEntry, wikiFolder: string, slugCase: 'lower' | 'preserve'): string {
  return `${wikiFolder}/sources/${resolveSourceSlug(source.path, { preserveCase: slugCase === 'preserve' })}.md`;
}

function sourceSlugCase(
  source: SourceInventoryEntry,
  wikiFolder: string,
  requested: 'lower' | 'preserve' | undefined,
  pagePaths: ReadonlySet<string>,
): 'lower' | 'preserve' {
  if (requested) return requested;
  const lowerPath = sourcePagePath(source, wikiFolder, 'lower');
  const preservePath = sourcePagePath(source, wikiFolder, 'preserve');
  // Candidate projection callers do not carry settings separately. Prefer the
  // one concrete generated page that is actually present in the copied vault;
  // when neither (or both) exists, retain the native default deterministically.
  if (pagePaths.has(preservePath) && !pagePaths.has(lowerPath)) return 'preserve';
  return 'lower';
}

function pageLabel(path: string, frontmatter: Record<string, unknown> | null, parsed?: ReturnType<typeof parseProjectionPage>): string {
  const title = frontmatter?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  const heading = parsed?.excluded.find(item => item.exclusionReason === 'title-heading')?.canonicalText;
  if (heading) return heading;
  const name = basename(path, extname(path));
  return name || path;
}

function pageType(frontmatter: Record<string, unknown> | null): string | undefined {
  const value = frontmatter?.type;
  return typeof value === 'string' && WIKI_PAGE_TYPES.has(value) ? value : undefined;
}

function sourceReferenceKeys(value: string, wikiFolder: string): string[] {
  let normalized = normalizedVaultPath(value).trim();
  if (normalized.startsWith('[[') && normalized.endsWith(']]')) normalized = normalized.slice(2, -2).trim();
  normalized = normalized.split('|', 1)[0]!.split('#', 1)[0]!.replace(/\.md$/iu, '');
  const keys = new Set<string>([normalized]);
  const folderPrefix = `${wikiFolder}/`;
  if (normalized.startsWith(folderPrefix)) keys.add(normalized.slice(folderPrefix.length));
  if (normalized.startsWith('sources/')) {
    keys.add(normalized);
    keys.add(`${wikiFolder}/${normalized}`);
  }
  if (normalized.startsWith(`${folderPrefix}sources/`)) keys.add(normalized.slice(folderPrefix.length));
  return [...keys];
}

function sourceReferences(source: SourceInventoryEntry, wikiFolder: string, slugCase: 'lower' | 'preserve'): SourceRef {
  const slug = resolveSourceSlug(source.path, { preserveCase: slugCase === 'preserve' });
  const normalizedPath = normalizedVaultPath(source.path);
  return {
    source,
    references: [
      ...sourceReferenceKeys(`sources/${slug}`, wikiFolder),
      ...sourceReferenceKeys(`sources/${slug}.md`, wikiFolder),
      ...sourceReferenceKeys(`${wikiFolder}/sources/${slug}`, wikiFolder),
      ...sourceReferenceKeys(`${wikiFolder}/sources/${slug}.md`, wikiFolder),
      ...sourceReferenceKeys(normalizedPath, wikiFolder),
    ],
  };
}

function frontmatterSources(frontmatter: Record<string, unknown> | null): string[] {
  const value = frontmatter?.sources;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function matchedSources(
  path: string,
  frontmatter: Record<string, unknown> | null,
  refs: readonly SourceRef[],
  wikiFolder: string,
): SourceInventoryEntry[] {
  const values = new Set(frontmatterSources(frontmatter).flatMap(value => sourceReferenceKeys(value, wikiFolder)));
  const normalizedPath = normalizedVaultPath(path);
  const sourcePrefix = `${wikiFolder}/sources/`;
  if (normalizedPath.startsWith(sourcePrefix)) {
    values.add(normalizedPath);
    values.add(normalizedPath.slice(`${wikiFolder}/`.length));
    values.add(normalizedPath.replace(/\.md$/iu, ''));
    values.add(normalizedPath.slice(`${wikiFolder}/`.length).replace(/\.md$/iu, ''));
  }
  const matched: SourceInventoryEntry[] = [];
  for (const ref of refs) {
    if (ref.references.some(value => values.has(value))) matched.push(ref.source);
  }
  return matched;
}

function frontmatterStrings(frontmatter: Record<string, unknown> | null, field: string): string[] {
  const value = frontmatter?.[field];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

const WIKI_LINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/gu;

function normalizedPageTarget(value: string, wikiFolder: string): string {
  let target = normalizedVaultPath(value).trim();
  const prefix = `${wikiFolder}/`;
  if (target.startsWith(prefix)) target = target.slice(prefix.length);
  return target.replace(/\.md$/iu, '');
}

function relatedPagePaths(
  content: string,
  pagePath: string,
  wikiFolder: string,
  knownPaths: ReadonlyMap<string, string>,
  knownBasenames: ReadonlyMap<string, readonly string[]>,
): string[] {
  const targets = new Set<string>();
  WIKI_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_RE.exec(content)) !== null) {
    const target = normalizedPageTarget(match[1]!, wikiFolder);
    const direct = knownPaths.get(target)
      ?? knownPaths.get(`${target}.md`)
      ?? knownPaths.get(`${wikiFolder}/${target}`)
      ?? knownPaths.get(`${wikiFolder}/${target}.md`);
    const basenameKey = basename(target);
    const basenameMatches = knownBasenames.get(basenameKey) ?? [];
    const resolved = direct ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
    if (resolved && resolved !== pagePath) targets.add(resolved);
  }
  return [...targets].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function pagePathIndexes(pages: readonly { path: string }[]): {
  paths: Map<string, string>;
  basenames: Map<string, string[]>;
} {
  const paths = new Map<string, string>();
  const basenames = new Map<string, string[]>();
  for (const page of pages) {
    const path = normalizedVaultPath(page.path);
    const withoutExtension = path.replace(/\.md$/iu, '');
    paths.set(path, path);
    paths.set(withoutExtension, path);
    const key = basename(withoutExtension);
    const values = basenames.get(key) ?? [];
    values.push(path);
    basenames.set(key, values);
  }
  return { paths, basenames };
}

function statementKind(value: string): 'heading' | 'list-item' | 'table-cell' | 'quote' {
  if (value === 'heading' || value === 'list-item' || value === 'table-cell') return value;
  return 'quote';
}

/**
 * Build the same contract projection shape used by the headless canary from
 * the native engine's actual Markdown output.  This is intentionally a
 * read-only pass over the copied vault; it never invokes a fix or writes a
 * projection into the vault.
 */
export async function buildNativeReferenceProjection(input: NativeProjectionInput): Promise<ContractSemanticProjection> {
  const wikiFolder = normalizedWikiFolder(input.wikiFolder);
  const pageFiles = [...input.vault.getMarkdownFiles()]
    .filter(file => {
      const path = normalizedVaultPath(file.path);
      return path === wikiFolder || path.startsWith(`${wikiFolder}/`);
    })
    .filter(file => !/(?:^|\/)log\.md$/iu.test(normalizedVaultPath(file.path)))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const pagePaths = new Set(pageFiles.map(file => normalizedVaultPath(file.path)));
  const sourceSlugCases = new Map<string, 'lower' | 'preserve'>(input.sourceInventory.map(source => [
    source.path,
    sourceSlugCase(source, wikiFolder, input.slugCase, pagePaths),
  ]));
  const refs = input.sourceInventory.map(source => sourceReferences(
    source,
    wikiFolder,
    sourceSlugCases.get(source.path) ?? 'lower',
  ));
  const nodes = new Map<string, ProjectionNode>();
  const edges = new Map<string, ProjectionEdge>();
  const parserHashes: string[] = [];

  for (const source of input.sourceInventory) {
    const id = sourceNodeId({
      authorityTree: input.authorityTree,
      normalizedPath: source.path,
      byteHash: source.byteSha256,
    });
    nodes.set(id, {
      nodeType: 'source',
      id,
      authorityTree: input.authorityTree,
      normalizedPath: source.path,
      byteHash: source.byteSha256,
      sourcePagePath: sourcePagePath(source, wikiFolder, sourceSlugCases.get(source.path) ?? 'lower'),
    });
  }

  const pageIndexes = pagePathIndexes(pageFiles);
  const pages: NativePageRecord[] = [];
  for (const file of pageFiles) {
    const path = normalizedVaultPath(file.path);
    const content = await input.vault.read(file);
    const frontmatter = parseFrontmatter(content) as Record<string, unknown> | null;
    const parsed = parseProjectionPage(content);
    parserHashes.push(parsed.sourceHash);
    const type = pageType(frontmatter) ?? 'unknown';
    const label = pageLabel(path, frontmatter, parsed);
    const normalizedLabel = normalizeLabel(label);
    const key = canonicalKeyId({
      pageType: type,
      normalizedLabel,
      normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
    });
    const pageSources = matchedSources(path, frontmatter, refs, wikiFolder);
    const links = relatedPagePaths(content, path, wikiFolder, pageIndexes.paths, pageIndexes.basenames);
    pages.push({
      path,
      contentSha256: sha256Hex(new TextEncoder().encode(content)),
      frontmatter,
      type,
      parsed,
      normalizedLabel,
      key,
      pageSources,
      links,
    });
  }

  const pageKeyByPath = new Map<string, string>(pages.map(page => [page.path, page.key]));
  for (const page of pages) {
    const aliases = frontmatterStrings(page.frontmatter, 'aliases')
      .filter(alias => normalizeLabel(alias) !== page.normalizedLabel)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const tags = frontmatterStrings(page.frontmatter, 'tags')
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const relatedPageIds = page.links.map(path => pageKeyByPath.get(path)).filter((id): id is string => Boolean(id)).sort();
    nodes.set(page.key, {
      nodeType: 'canonical-key',
      id: page.key,
      pageType: page.type,
      normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
      normalizedLabel: page.normalizedLabel,
      pagePath: page.path,
      path: page.path,
      pageSha256: page.contentSha256,
      aliases: [...aliases],
      tags: [...tags],
      relatedLinks: [...page.links],
      relatedPageIds: [...relatedPageIds],
    });

    for (const alias of aliases) {
      // A page's alias is native output metadata, not an exact quote from the
      // authority bytes. Keep it visible but speculative until an explicit
      // adjudication/evidence path binds it; never fabricate grounding from a
      // page's `sources:` backlink.
      const aliasEvidence: string[] = [];
      const aliasId = aliasNodeId({
        normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
        normalizedAliasLabel: alias,
        targetPageType: page.type,
        proposedCanonicalKeyId: page.key,
        evidenceIds: aliasEvidence,
      });
      nodes.set(aliasId, {
        nodeType: 'alias',
        id: aliasId,
        normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
        normalizedAliasLabel: normalizeLabel(alias),
        targetPageType: page.type,
        proposedCanonicalKeyId: page.key,
        evidenceIds: aliasEvidence,
        state: 'speculative',
      });
    }

    // Unknown/untyped Markdown files still participate in the page census,
    // but cannot safely contribute source-grounded claims.
    if (!WIKI_PAGE_TYPES.has(page.type)) continue;
    for (const statement of page.parsed.statements) {
      const kind = statementKind(statement.statementKind);
      const evidenceSources = page.pageSources;
      const evidenceIds = evidenceSources.map(source => evidenceId({
        kind,
        reason: kind === 'heading' ? 'defines-scope' : 'direct-quote',
        authorityTree: input.authorityTree,
        normalizedPath: source.path,
        originalSourceHash: source.byteSha256,
        canonicalSourceHash: page.parsed.sourceHash,
        byteRange: { start: statement.startByte, end: statement.endByte },
        exactCanonicalBytes: statement.canonicalText,
        normalizationVersion: page.parsed.normalizationVersion,
      }));
      const claim = claimId({
        subjectKey: { page_type: page.type, normalized_label: page.normalizedLabel },
        predicate: 'statement',
        object: statement.canonicalText,
        evidenceIds,
      });
      const statementNode = pageStatementId({
        canonicalKeyId: page.key,
        sectionPath: statement.sectionPath,
        statementKind: statement.statementKind === 'paragraph' ? 'paragraph' : statement.statementKind,
        ordinal: statement.ordinal,
        canonicalTextHash: sha256Hex(statement.canonicalText),
      });
      nodes.set(claim, {
        nodeType: 'claim',
        id: claim,
        subjectKey: { page_type: page.type, normalized_label: page.normalizedLabel },
        predicate: 'statement',
        object: statement.canonicalText,
        disposition: 'evidenced',
      });
      nodes.set(statementNode, {
        nodeType: 'page-statement',
        id: statementNode,
        canonicalKeyId: page.key,
        sectionPath: statement.sectionPath,
        statementKind: statement.statementKind === 'paragraph' ? 'paragraph' : statement.statementKind,
        ordinal: statement.ordinal,
        canonicalTextHash: sha256Hex(statement.canonicalText),
      });

      const render = {
        edgeKind: 'renders' as const,
        sourceId: claim,
        targetId: statementNode,
        payload: { render_role: 'supports' },
      };
      const renderWithId = { ...render, id: projectionEdgeId(render) };
      edges.set(renderWithId.id, renderWithId);
      if (evidenceIds.length > 0) {
        const evidence = {
          edgeKind: 'evidences' as const,
          sourceId: sourceNodeId({
            authorityTree: input.authorityTree,
            normalizedPath: evidenceSources[0].path,
            byteHash: evidenceSources[0].byteSha256,
          }),
          targetId: claim,
          payload: { evidence_ids: [...evidenceIds].sort() },
        };
        const evidenceWithId = { ...evidence, id: projectionEdgeId(evidence) };
        edges.set(evidenceWithId.id, evidenceWithId);
      }
    }
  }

  const parserHash = sha256Hex(parserHashes.sort().join('\n'));
  const empty = parseProjectionPage('');
  return createContractSemanticProjection({
    runId: input.runId,
    parser: {
      version: 'projection-parser/v1',
      source_sha256: parserHash,
      grammar_sha256: empty.grammarHash,
      unicode_sha256: empty.unicodeHash,
      boilerplate_policy_sha256: BOILERPLATE_POLICY_HASH,
    },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  });
}
