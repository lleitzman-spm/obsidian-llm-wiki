import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../types';
import { appendSourceSlugToFrontmatter } from '../../../../../src/wiki/page-factory/create-page';
import {
  nativeSourcePagePath,
  nativeSourceSlug,
  normalizeNativeMapSourceSlugs,
  planNativeGeneratedPage,
  planNativeIndex,
  planNativeIngestLog,
  planNativeLintLog,
  planNativeMerge,
  planNativeSourcePage,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-compatibility';
import { appendNativeSourceSlugToFrontmatter } from '../../../../../tools/llm-wiki-cli/src/headless/native-compatibility/source-stamp';

describe('native compatibility adapters', () => {
  it('uses the v1.26.4 path fingerprint for source pages and links', () => {
    const path = 'raw/Course X/About this course.md';
    const slug = nativeSourceSlug(path);
    expect(slug).toMatch(/^about-this-course_[0-9a-f]{6}$/u);
    expect(nativeSourcePagePath('wiki', path)).toBe(`wiki/sources/${slug}.md`);
    expect(nativeSourceSlug('raw\\Course X\\About this course.md')).toBe(slug);
    expect(nativeSourceSlug('raw/Other Course/About this course.md')).not.toBe(slug);
    expect(nativeSourceSlug('raw/Course X/About this course.md', { preserveCase: true })).toMatch(/^About-this-course_[0-9a-f]{6}$/u);
  });

  it('renders the native source-page postprocessing tail without inventing model bytes', () => {
    const sourcePath = 'raw/lease/Lease SOP.md';
    const result = planNativeSourcePage({
      sourcePath,
      wikiFolder: 'wiki',
      generatedContent: '---\ntype: source\n---\n\n# Lease SOP\n\nBody.',
      sourceContent: 'The original\nsource text.',
      sourceNoteAliases: ['Lease procedure'],
    });
    expect(result.status).toBe('ready');
    expect(result.canApply).toBe(true);
    expect(result.path).toBe(nativeSourcePagePath('wiki', sourcePath));
    expect(result.content).toContain('contentHash:');
    expect(result.content).toContain('Lease procedure');
    expect(planNativeSourcePage({
      sourcePath,
      wikiFolder: 'wiki',
      generatedContent: '',
      sourceContent: 'source',
    }).canApply).toBe(false);
  });

  it('re-stamps mapper provenance and recomputes the content address', () => {
    const sourcePath = 'raw/Course X/About this course.md';
    const ir = {
      contractVersion: 'native-map/v1',
      source: { sourceId: 's1', sourcePath, byteSha256: 'a'.repeat(64), byteCount: 1 },
      sourceTitle: 'About this course',
      summary: 'Summary',
      sourceAliases: [],
      keyPoints: [],
      entities: [{ name: 'Person', type: 'person', aliases: [], summary: 'A person', mentions_in_source: [], mentions_with_provenance: [{ quote: 'q', source_path: sourcePath, source_slug: 'about-this-course', extracted_at: '1970-01-01T00:00:00.000Z' }], related_entities: [], related_concepts: [] }],
      concepts: [],
      mentions: [{ quote: 'q', source_path: sourcePath, source_slug: 'about-this-course', extracted_at: '1970-01-01T00:00:00.000Z' }],
      claims: [], aliases: [], related: [], contradictions: [], artifacts: [], policySha256: 'b'.repeat(64), irSha256: 'c'.repeat(64),
    } as const;
    const normalized = normalizeNativeMapSourceSlugs(ir as never);
    const slug = nativeSourceSlug(sourcePath);
    expect(normalized.mentions[0]?.source_slug).toBe(slug);
    expect(normalized.entities[0]?.mentions_with_provenance[0]?.source_slug).toBe(slug);
    expect(normalized.irSha256).not.toBe(ir.irSha256);
  });

  it('runs the exact native generated-page tail with an explicit run date', () => {
    const sourcePath = 'raw/lease/Lease SOP.md';
    const sourceSlug = nativeSourceSlug(sourcePath);
    const result = planNativeGeneratedPage({
      pageType: 'entity',
      path: 'wiki/entities/Lease-Policy.md',
      generatedContent: '---\ntype: entity\ncreated: 2000-01-01\ntags: [person]\n---\n\n# Lease Policy\n\n## Related Entities\n- [[sources/Wrong]]',
      settings: DEFAULT_SETTINGS,
      sourcePath,
      sourceSlug,
      relatedEntities: ['Lease Policy'],
      relatedConcepts: [],
      mentions: ['A lease rule'],
      date: '2026-08-20',
    });
    expect(result.status).toBe('ready');
    expect(result.content).toContain('updated: 2026-08-20');
    expect(result.content).toContain(`[[sources/${sourceSlug}]]`);
    expect(result.content).toContain('## Mentions in Source');

    const preserved = planNativeGeneratedPage({
      pageType: 'entity',
      path: 'wiki/entities/Lease-Policy.md',
      generatedContent: '---\ntype: entity\ncreated: 2000-01-01\ntags: [person]\n---\n\n# Lease Policy',
      settings: DEFAULT_SETTINGS,
      sourcePath,
      sourceSlug,
      date: '2026-08-20',
      preserveCreated: '2020-02-03',
    });
    expect(preserved.content).toContain('created: 2020-02-03');
    expect(preserved.content).toContain('updated: 2026-08-20');
  });

  it('keeps the headless source-stamp splice byte-equivalent to PageFactory', () => {
    const slug = nativeSourceSlug('raw/lease/Lease SOP.md');
    const fixtures = [
      '---\ntype: entity\ntags: []\n---\n\n# Body',
      '---\ntype: entity\nsources: ["[[sources/old]]"]\ntags: []\n---\n\n# Body',
      '---\ntype: entity\nsources:\n  - [[sources/old]]\n---\n\n# Body',
    ];
    for (const fixture of fixtures) {
      expect(appendNativeSourceSlugToFrontmatter(fixture, slug)).toBe(appendSourceSlugToFrontmatter(fixture, slug));
    }
  });

  it('keeps frontmatter-only merges applyable and refuses LLM-owned merge modes', () => {
    const existing = '---\ntype: entity\ncreated: 2026-01-01\ntags:\n  - person\ncustom: keep\n---\n\n# Person\n\nExisting body.\n';
    const sourcePath = 'raw/lease/Lease SOP.md';
    const frontmatter = planNativeMerge({
      pagePath: 'wiki/entities/Person.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'frontmatter-only',
    });
    expect(frontmatter.status).toBe('ready');
    expect(frontmatter.canApply).toBe(true);
    expect(frontmatter.content).toContain(`[[sources/${nativeSourceSlug(sourcePath)}]]`);
    expect(frontmatter.content).toContain('custom: keep');
    expect(frontmatter.content).toContain('updated: 2026-08-20');

    const merge = planNativeMerge({
      pagePath: 'wiki/entities/Person.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'llm-merge',
      proposedBody: '# Person\n\nNew body.',
    });
    expect(merge.status).toBe('requires-native-comparison');
    expect(merge.canApply).toBe(false);
    expect(merge.reasons.some(reason => reason.code === 'native-llm-seam-required')).toBe(true);

    const complementary = planNativeMerge({
      pagePath: 'wiki/entities/Person.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'complementary-append',
      generatedContent: '## Description\nAppended.',
      pageType: 'entity',
      settings: DEFAULT_SETTINGS,
    });
    expect(complementary.canApply).toBe(false);
    expect(complementary.action).toBe('unchanged');
    expect(complementary.content).toBe(existing);
  });

  it('runs the bound native body-merge tail without dropping curated sections or provenance', () => {
    const sourcePath = 'raw/lease/Lease SOP.md';
    const existing = '---\ntype: entity\ncreated: 2024-01-01\nupdated: 2026-08-19\nsources:\n  - "[[sources/old_abc123]]"\ntags:\n  - person\naliases:\n  - Lease policy\ncustom: keep\n---\n\n# Lease Policy\n\n## Basic Information\nCurated description.\n\n## Evidence\nOld evidence.\n';
    const result = planNativeMerge({
      pagePath: 'wiki/entities/Lease-Policy.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'llm-merge',
      pageType: 'entity',
      settings: DEFAULT_SETTINGS,
      generatedContent: '# Wrong title\n\n## Description\nMerged description.\n',
      relatedEntities: [],
      relatedConcepts: [],
      mentions: [{ quote: 'A lease rule', source_path: sourcePath, source_slug: nativeSourceSlug(sourcePath), extracted_at: '2026-08-20T00:00:00.000Z' }],
      existingPages: [],
    });
    expect(result.canApply).toBe(true);
    expect(result.content).toContain('# Lease Policy');
    expect(result.content).toContain('Curated description.');
    expect(result.content).toContain('Merged description.');
    expect(result.content).toContain('custom: keep');
    expect(result.content).toContain('Lease policy');
    expect(result.content).toContain(`sources/${nativeSourceSlug(sourcePath)}`);
    expect(result.content).toContain('A lease rule');
    expect(result.content).not.toContain('# Wrong title');
  });

  it('runs the bound reviewed append tail and keeps a no-new-content response unchanged', () => {
    const sourcePath = 'raw/lease/Lease SOP.md';
    const existing = '---\ntype: entity\ncreated: 2024-01-01\nreviewed: true\n---\n\n# Lease Policy\n\n## Curated\nLocked.\n';
    const appended = planNativeMerge({
      pagePath: 'wiki/entities/Lease-Policy.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'reviewed-append',
      pageType: 'entity',
      settings: DEFAULT_SETTINGS,
      generatedContent: '## New Information (2026-08-20)\nNew rule.\n',
      mentions: ['A lease rule'],
    });
    expect(appended.canApply).toBe(true);
    expect(appended.content).toContain('reviewed: true');
    expect(appended.content).toContain('New rule.');
    expect(appended.content).toContain(`sources/${nativeSourceSlug(sourcePath)}`);

    const noNew = planNativeMerge({
      pagePath: 'wiki/entities/Lease-Policy.md',
      sourcePath,
      existingContent: existing,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'reviewed-append',
      pageType: 'entity',
      settings: DEFAULT_SETTINGS,
      generatedContent: 'NO_NEW_CONTENT',
    });
    expect(noNew.canApply).toBe(true);
    expect(noNew.action).toBe('unchanged');
    expect(noNew.content).toBe(existing);
  });

  it('normalizes Windows source paths through body and mention provenance output', () => {
    const sourcePath = 'raw\\lease\\Lease SOP.md';
    const result = planNativeMerge({
      pagePath: 'wiki/entities/Lease-Policy.md',
      sourcePath,
      existingContent: '---\ntype: entity\ncreated: 2024-01-01\n---\n\n# Lease Policy\n',
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'llm-merge',
      pageType: 'entity',
      settings: DEFAULT_SETTINGS,
      generatedContent: '## Description\nWindows-safe merge.\n',
      mentions: [{ quote: 'Windows quote', source_path: sourcePath, source_slug: nativeSourceSlug(sourcePath), extracted_at: '2026-08-20T00:00:00.000Z' }],
      existingPages: [],
    });
    expect(result.canApply).toBe(true);
    expect(result.content).toContain('[[sources/lease-sop_');
    expect(result.content).toContain('[[raw/lease/Lease SOP|Lease SOP]]');
    expect(result.content).not.toContain('raw\\lease\\Lease SOP');
  });

  it('plans the native index with fingerprinted source basenames and native summaries', () => {
    const sourcePath = 'raw/lease/Lease SOP.md';
    const sourceSlug = nativeSourceSlug(sourcePath);
    const result = planNativeIndex({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      entities: [{ basename: 'Person', content: '---\naliases:\n  - Tenant\n---\n\n# Person\n\nA person.' }],
      concepts: [{ basename: 'Lease-Policy', content: '# Lease Policy\n\nA concept.' }],
      sources: [{ sourcePath, basename: sourceSlug, content: '# Lease SOP\n\nSource.' }],
    });
    expect(result.status).toBe('ready');
    expect(result.content).toContain('## Entities');
    expect(result.content).toContain('`aliases: Tenant`');
    expect(result.content).toContain(`[[sources/${sourceSlug}|${sourceSlug}]]`);
    expect(result.content).toContain('- A person.');
  });

  it('refuses an index source whose basename is not the native fingerprinted slug', () => {
    const result = planNativeIndex({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      entities: [],
      concepts: [],
      sources: [{ sourcePath: 'raw/a.md', basename: 'a', content: '# A' }],
    });
    expect(result.canApply).toBe(false);
    expect(result.status).toBe('refused');
    expect(result.reasons[0]?.code).toBe('ambiguous-source-entry');
  });

  it('plans native ingest and lint log entries with a sealed clock', () => {
    const ingest = planNativeIngestLog({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      existingContent: '# Wiki Operation Log\n',
      operation: 'ingest',
      sourceTitle: 'Lease SOP',
      createdPages: ['wiki/sources/a.md', 'wiki/sources/a.md'],
      updatedPages: ['wiki/entities/Person.md'],
      date: '2026-08-20',
      time: '03:40',
      metrics: { durationSec: 28, model: 'gpt-5.6-luna-20260820', sourceBytes: 4400 },
    });
    expect(ingest.status).toBe('ready');
    expect(ingest.content).toContain('ingest | Lease SOP · 28s · gpt-5.6-luna · 4.3KB');
    expect((ingest.content?.match(/\[\[sources\/a\.md\]\]/gu) ?? []).length).toBe(1);

    const lint = planNativeLintLog({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      existingContent: '# Wiki Operation Log\n',
      operation: 'lint',
      details: 'No fixes.',
      date: '2026-08-20',
      time: '03:41',
    });
    expect(lint.content).toContain('## [2026-08-20 03:41] lint');
    expect(lint.content).toContain('No fixes.');
  });
});
