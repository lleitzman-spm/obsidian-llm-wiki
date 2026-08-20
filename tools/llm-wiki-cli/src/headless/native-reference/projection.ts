import { basename, extname } from 'node:path';

import { parseFrontmatter } from '../../../../../src/core/frontmatter';
import { resolveSourceSlug } from '../../../../../src/core/source-slug';
import {
  canonicalKeyId,
  claimId,
  evidenceId,
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
  readonly sourceInventory: readonly SourceInventoryEntry[];
  readonly vault: NativeProjectionVault;
}

const WIKI_PAGE_TYPES = new Set(['entity', 'concept', 'source', 'overview', 'comparison']);

interface SourceRef {
  readonly source: SourceInventoryEntry;
  readonly references: readonly string[];
}

function normalizedVaultPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').normalize('NFKC');
}

function pageLabel(path: string, frontmatter: Record<string, unknown> | null): string {
  const title = frontmatter?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  const name = basename(path, extname(path));
  return name || path;
}

function pageType(frontmatter: Record<string, unknown> | null): string | undefined {
  const value = frontmatter?.type;
  return typeof value === 'string' && WIKI_PAGE_TYPES.has(value) ? value : undefined;
}

function sourceReferences(source: SourceInventoryEntry): SourceRef {
  const slug = resolveSourceSlug(source.path);
  const normalizedPath = normalizedVaultPath(source.path);
  const base = basename(normalizedPath);
  return {
    source,
    references: [
      `sources/${slug}`,
      `[[sources/${slug}]]`,
      normalizedPath,
      `[[${normalizedPath}]]`,
      base,
      `[[${base}]]`,
    ],
  };
}

function frontmatterSources(frontmatter: Record<string, unknown> | null): string[] {
  const value = frontmatter?.sources;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(normalizedVaultPath);
}

function matchedSources(
  path: string,
  frontmatter: Record<string, unknown> | null,
  refs: readonly SourceRef[],
): SourceInventoryEntry[] {
  const values = new Set(frontmatterSources(frontmatter));
  if (path.startsWith('sources/')) values.add(path.slice('sources/'.length).replace(/\.md$/iu, ''));
  const matched: SourceInventoryEntry[] = [];
  for (const ref of refs) {
    if (ref.references.some(value => values.has(normalizedVaultPath(value)))) matched.push(ref.source);
  }
  return matched;
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
  const refs = input.sourceInventory.map(sourceReferences);
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
    });
  }

  const pages = [...input.vault.getMarkdownFiles()]
    .filter(file => {
      const path = normalizedVaultPath(file.path);
      return path === input.wikiFolder || path.startsWith(`${input.wikiFolder}/`);
    })
    .filter(file => !/(?:^|\/)log\.md$/iu.test(normalizedVaultPath(file.path)))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));

  for (const file of pages) {
    const path = normalizedVaultPath(file.path);
    const content = await input.vault.read(file);
    const frontmatter = parseFrontmatter(content) as Record<string, unknown> | null;
    const type = pageType(frontmatter);
    if (!type) continue;
    const parsed = parseProjectionPage(content);
    parserHashes.push(parsed.sourceHash);
    const label = pageLabel(path, frontmatter);
    const normalizedLabel = normalizeLabel(label);
    const key = canonicalKeyId({
      pageType: type,
      normalizedLabel,
      normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
    });
    nodes.set(key, {
      nodeType: 'canonical-key',
      id: key,
      pageType: type,
      normalizationVersion: PROVENANCE_NORMALIZATION_VERSION,
      normalizedLabel,
    });

    const pageSources = matchedSources(path, frontmatter, refs);
    for (const statement of parsed.statements) {
      const kind = statementKind(statement.statementKind);
      const evidenceSources = pageSources;
      const evidenceIds = evidenceSources.map(source => evidenceId({
        kind,
        reason: kind === 'heading' ? 'defines-scope' : 'direct-quote',
        authorityTree: input.authorityTree,
        normalizedPath: source.path,
        originalSourceHash: source.byteSha256,
        canonicalSourceHash: parsed.sourceHash,
        byteRange: { start: statement.startByte, end: statement.endByte },
        exactCanonicalBytes: statement.canonicalText,
        normalizationVersion: parsed.normalizationVersion,
      }));
      const claim = claimId({
        subjectKey: { page_type: type, normalized_label: normalizedLabel },
        predicate: 'statement',
        object: statement.canonicalText,
        evidenceIds,
      });
      const statementNode = pageStatementId({
        canonicalKeyId: key,
        sectionPath: statement.sectionPath,
        statementKind: statement.statementKind === 'paragraph' ? 'paragraph' : statement.statementKind,
        ordinal: statement.ordinal,
        canonicalTextHash: sha256Hex(statement.canonicalText),
      });
      nodes.set(claim, {
        nodeType: 'claim',
        id: claim,
        subjectKey: { page_type: type, normalized_label: normalizedLabel },
        predicate: 'statement',
        object: statement.canonicalText,
        disposition: 'evidenced',
      });
      nodes.set(statementNode, {
        nodeType: 'page-statement',
        id: statementNode,
        canonicalKeyId: key,
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
