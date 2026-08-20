/**
 * Native v1.26.4 compatibility lane.
 *
 * This is intentionally a small, model-free fixture lane. It exercises the
 * native deterministic boundaries that a parallel runner must preserve and
 * marks provider-owned decisions as non-accepting until a real native run is
 * compared. The fixture values are in the sibling fixture module rather than
 * derived from the functions under test.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { DEFAULT_SETTINGS, type LLMWikiSettings, type SourceAnalysis } from '../../types';
import {
  resolveSourceSlug,
  sourceBaseSlug,
  sourceFingerprint,
} from '../../core/source-slug';
import {
  enforceFrontmatterConstraints,
  mergeFrontmatter,
  mergeFrontmatterArrayField,
  parseFrontmatter,
} from '../../core/frontmatter';
import { correctRelatedLinkPrefixes } from '../../core/related-link-corrector';
import { resolvePagePath, type PathResolutionContext } from '../../wiki/page-factory/path-resolution';
import { appendSourceSlugToFrontmatter } from '../../wiki/page-factory/create-page';
import { IndexGenerator } from '../../wiki/engine-internals/index-generator';
import { LogWriter } from '../../wiki/engine-internals/log-writer';
import { NATIVE_V1264_COMPAT_FIXTURE as fixture } from '../fixtures/native-v1264-compat.fixture';

function makePathContext(settings: Partial<LLMWikiSettings> = {}): PathResolutionContext {
  return {
    settings: { ...DEFAULT_SETTINGS, wikiFolder: 'wiki', ...settings },
    app: {
      vault: {
        getMarkdownFiles: () => [],
        read: async () => '',
      },
    },
    tryReadFile: async () => null,
    createOrUpdateFile: async () => undefined,
    getClient: () => null,
    buildSystemPrompt: async () => 'unused in this empty-vault fixture',
  };
}

function asTFile(path: string, basename: string): TFile {
  // Test-only structural file: IndexGenerator reads only these two fields.
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- fixture stub is intentionally narrower than Obsidian's TFile
  return { path, basename } as unknown as TFile;
}

function makeIngestAnalysis(): SourceAnalysis {
  return {
    source_file: fixture.sources.secondPath,
    source_title: 'Lease Standards',
    summary: 'Lease standards source fixture',
    entities: [],
    concepts: [],
    related_pages: [],
    key_points: [],
    created_pages: [
      'wiki/entities/lease-coordinator.md',
      'wiki/entities/lease-coordinator.md',
      fixture.pagePaths.sourcePath,
    ],
    updated_pages: ['concepts/lease-policy.md'],
    contradictions: [
      {
        claim: 'Renewal notice is 60 days',
        source_page: 'legacy-lease-standards',
        contradicted_by: '[[sources/legacy-lease-standards]]',
        resolution: '',
      },
    ],
  };
}

describe('native v1.26.4 compatibility fixture', () => {
  it('uses the full source path for a stable six-hex fingerprint and slug', () => {
    const { sources } = fixture;

    expect(sourceFingerprint(sources.firstPath)).toBe(sources.firstFingerprint);
    expect(sourceFingerprint(sources.secondPath)).toBe(sources.secondFingerprint);
    expect(sourceBaseSlug(sources.firstPath)).toBe('lease-standards');
    expect(resolveSourceSlug(sources.firstPath)).toBe(sources.firstSlug);
    expect(resolveSourceSlug(sources.secondPath)).toBe(sources.secondSlug);

    // Same basename is not an identity: changing only the parent folder must
    // produce a different source page and must not depend on ingest order.
    expect(sources.firstPath.endsWith('/Lease Standards.md')).toBe(true);
    expect(sources.secondPath.endsWith('/Lease Standards.md')).toBe(true);
    expect(sources.firstSlug).not.toBe(sources.secondSlug);
    expect(resolveSourceSlug(sources.firstPath)).toBe(sources.firstSlug);
    expect(resolveSourceSlug(sources.secondPath)).toBe(sources.secondSlug);

    const bounded = resolveSourceSlug(sources.maxLengthPath, { maxLen: 80 });
    expect(bounded).toHaveLength(80);
    expect(bounded).toMatch(/_[0-9a-f]{6}$/);
  });

  it('resolves native entity/concept paths under wiki/{entities,concepts}', async () => {
    const ctx = makePathContext({ slugCase: 'lower' });

    const entity = await resolvePagePath(
      ctx,
      fixture.pagePaths.entityName,
      'entity',
      'coordinates lease standards',
    );
    const concept = await resolvePagePath(
      ctx,
      fixture.pagePaths.conceptName,
      'concept',
      'lease policy',
    );

    expect(entity).toEqual({ path: fixture.pagePaths.entityPath });
    expect(concept).toEqual({ path: fixture.pagePaths.conceptPath });
    expect(fixture.pagePaths.sourcePath).toBe(`wiki/sources/${fixture.sources.firstSlug}.md`);
  });

  it('normalizes model-shaped frontmatter, preserves unknown fields, and stamps source provenance', () => {
    const constrained = enforceFrontmatterConstraints(
      fixture.modelPageReply,
      'entity',
      DEFAULT_SETTINGS,
    );
    // The source stamp is a separate native write boundary. Keep this call
    // explicit so a headless implementation cannot accidentally infer source
    // provenance from the generated body.
    const withSource = appendSourceSlugToFrontmatter(constrained, fixture.newSourceSlug);
    const parsed = parseFrontmatter(withSource);

    expect(parsed?.type).toBe('entity');
    expect(parsed?.tags).toEqual(['person', 'invented-tag']);
    expect(parsed?.aliases).toEqual(['LC', 'Lease Coordinator']);
    expect(withSource).toContain('redirect_to: "[[entities/Legacy Coordinator]]"');
    expect(parsed?.sources).toEqual([`[[sources/${fixture.newSourceSlug}]]`]);
    expect(withSource).toContain('# Lease Coordinator');
    expect(withSource).toContain('Coordinates lease standards.');
    expect(withSource).not.toContain('created: 1999-01-01');
    expect(withSource).not.toContain('updated: 1999-01-01');
  });

  it('retypes related links from the typed lists while leaving source citations alone', () => {
    const corrected = correctRelatedLinkPrefixes(
      fixture.modelPageReply,
      ['Vendor Manager'],
      ['Lease Policy'],
      'Related Entities',
      'Related Concepts',
      false,
      {
        wikiFolder: 'wiki',
        pages: [
          {
            path: 'wiki/entities/Vendor Manager.md',
            title: 'Vendor Manager',
            aliases: ['VM'],
          },
          {
            path: 'wiki/concepts/Lease Policy.md',
            title: 'Lease Policy',
          },
        ],
      },
    );

    expect(corrected).toContain('[[entities/Vendor Manager|Vendor Manager]]');
    expect(corrected).toContain('[[concepts/Lease Policy|Lease Policy]]');
    expect(corrected).toContain('[[sources/lease-standards_92ebf9|Lease Standards]]');
    expect(corrected).not.toContain('[[sources/Vendor Manager]]');
  });

  it('merges source provenance without dropping curated body or user-owned frontmatter', () => {
    const merged = mergeFrontmatter(fixture.existingPage, fixture.newSourcePage);
    const parsed = parseFrontmatter(merged.frontmatter);
    const today = new Date().toISOString().split('T')[0];

    expect(merged.wasMerged).toBe(true);
    expect(parsed?.created).toBe('2026-01-04');
    expect(parsed?.updated).toBe(today);
    expect(parsed?.sources).toEqual([
      '[[sources/lease-standards_92ebf9]]',
      '[[sources/lease-standards_980663]]',
    ]);
    expect(parsed?.tags).toEqual(['person']);
    expect(parsed?.aliases).toEqual(['LC']);
    expect(parsed?.reviewed).toBe(true);
    expect(merged.frontmatter).toContain('redirect_to: "[[entities/Legacy Coordinator]]"');
    expect(merged.frontmatter).toContain('owner: "operations"');

    expect(merged.body).toBe([
      '# Lease Coordinator',
      '',
      '## Description',
      'Curated description that must remain available.',
      '',
      '## Related Entities',
      '- [[entities/Existing Coordinator]]',
      '',
      '## Mentions in Source',
      '- "A curated earlier citation" — [[sources/lease-standards_92ebf9|Lease Standards]]',
    ].join('\n'));

    const aliasMerge = mergeFrontmatterArrayField(
      fixture.existingPage,
      'aliases',
      ['LC', 'Lease Standards'],
    );
    expect(parseFrontmatter(aliasMerge)?.aliases).toEqual(['LC', 'Lease Standards']);
    expect(aliasMerge).toContain('owner: "operations"');
  });

  it('renders native index sections and aliases from fixture pages byte-for-byte', async () => {
    const pages = [fixture.index.entity, fixture.index.concept, fixture.index.source];
    const contentByPath = new Map<string, string>();
    for (const page of pages) contentByPath.set(page.path, page.content);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const generator = new IndexGenerator({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile: async file => contentByPath.get(file.path) ?? '',
      writeFile,
    });

    await generator.generateFlatIndex(
      [asTFile(fixture.index.entity.path, fixture.index.entity.basename)],
      [asTFile(fixture.index.concept.path, fixture.index.concept.basename)],
      [asTFile(fixture.index.source.path, fixture.index.source.basename)],
    );

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('wiki/index.md', fixture.index.expected);
  });

  it('renders native ingest log metrics, links, deduplication, and contradictions', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile: async () => '# Wiki Operation Log\n',
      writeFile,
    });

    await writer.appendIngest('ingest', makeIngestAnalysis(), {
      durationSec: 28,
      model: 'gpt-5.6-luna-20260820',
      sourceBytes: 2048,
    });

    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('wiki/log.md');
    expect(content).toMatch(
      /## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ingest \| Lease Standards · 28s · gpt-5\.6-luna · 2\.0KB/,
    );
    expect(content).toContain('**Created pages**：[[entities/lease-coordinator.md]], [[sources/lease-standards_92ebf9.md]]');
    expect(content).toContain('**Updated pages**：[[concepts/lease-policy.md]]');
    expect(content).toContain('**Contradictions found**：');
    expect(content).toContain('- Renewal notice is 60 days vs legacy-lease-standards');
    expect((content.match(/\[\[entities\/lease-coordinator\.md\]\]/g) ?? []).length).toBe(1);
  });

  it('fails closed at provider-owned boundaries instead of treating fixtures as acceptance', () => {
    expect(fixture.modelBoundary.deterministicAcceptance).toBe('fixture-covered');
    expect(fixture.modelBoundary.extraction).toBe('requires-native-provider-run');
    expect(fixture.modelBoundary.semanticDedup).toBe('requires-native-provider-run');
    expect(fixture.modelBoundary.generatedBody).toBe('requires-native-provider-run');
  });
});
