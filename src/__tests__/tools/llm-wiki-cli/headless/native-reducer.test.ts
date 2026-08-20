import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../../src/types';
import {
  nativeSourceSlug,
  planNativeGeneratedPage,
  planNativeIndex,
  planNativeIngestLog,
  planNativeMerge,
  planNativeSourcePage,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-compatibility';
import {
  NativeReductionError,
  reduceNativeMapIR,
  reduceNativeSourceIR,
  type NativeExistingPage,
  type NativeReducerOptions,
  type NativeSourceScopedIR,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-reducer';
import type { NativeMapIR } from '../../../../../tools/llm-wiki-cli/src/headless/native-map/types';

const options = (overrides: Partial<NativeReducerOptions> = {}): NativeReducerOptions => ({
  wikiFolder: 'wiki',
  wikiLanguage: 'en',
  time: '00:00',
  sourceContents: new Map([['notes/mapped.md', 'Mapped source bytes\n']]),
  date: '2026-08-20',
  nativeSettings: { ...DEFAULT_SETTINGS },
  generatedPageContents: new Map([
    ['entity\u001fmapped entity', '# Mapped Entity\n\n## Contested Evidence\n- The contrary quote.\n'],
    ['entity\u001fa page', '# A Page\n'],
    ['entity\u001fb page', '# B Page\n'],
  ]),
  global: {
    paths: { index: 'wiki/index.md', log: '20 Brain/log.md', schema: '20 Brain/schema.md' },
    runId: 'run-native-test',
    schemaContent: '# Schema\n',
  },
  ...overrides,
});

const source = (sourceId: string, proposals: NativeSourceScopedIR['proposals'], extra: Partial<NativeSourceScopedIR> = {}): NativeSourceScopedIR => ({
  sourceId,
  sourcePath: `notes/${sourceId}.md`,
  sourceSlug: nativeSourceSlug(`notes/${sourceId}.md`),
  sourceContent: `Source bytes for ${sourceId}\n`,
  sourceTitle: sourceId,
  proposals,
  ...extra,
});

const mapped = (overrides: Partial<NativeMapIR> = {}): NativeMapIR => ({
  contractVersion: 'native-map/v1',
  source: { sourceId: 'mapped-source', sourcePath: 'notes/mapped.md', byteSha256: 'a'.repeat(64), byteCount: 6 },
  sourceTitle: 'Mapped source',
  summary: 'A mapped summary',
  sourceAliases: [],
  keyPoints: [],
  entities: [{ name: 'Mapped Entity', type: 'person', aliases: [], summary: 'Entity summary', mentions_in_source: [], mentions_with_provenance: [], related_entities: [], related_concepts: [] }],
  concepts: [],
  mentions: [],
  claims: [],
  aliases: [],
  related: [],
  contradictions: [],
  artifacts: [],
  policySha256: 'b'.repeat(64),
  irSha256: 'c'.repeat(64),
  ...overrides,
});

describe('native reducer', () => {
  it('shuffles by typed key and merges shared same-type proposals deterministically', () => {
    const first = source('s-b', [{
      proposalId: 'p-b', sourceId: 's-b', pageType: 'entity', label: 'Alice Example', typeTag: 'person',
      aliases: ['A. Example'], summary: 'Second source summary',
      relatedConcepts: ['Canonical Concept'],
      statements: [{ statementId: 'stmt-b', text: 'A qualified fact.', role: 'qualifies', evidenceIds: ['ev-b'] }],
      evidence: [{ evidenceId: 'ev-b', role: 'qualifies', quote: 'A qualified fact.' }],
    }]);
    const second = source('s-a', [{
      proposalId: 'p-a', sourceId: 's-a', pageType: 'entity', label: ' alice   example ', typeTag: 'person',
      aliases: ['Alice E.'], summary: 'First source summary',
      related: [{ pageType: 'concept', label: 'Canonical Concept' }],
      statements: [{ statementId: 'stmt-a', text: 'A supported fact.', role: 'supports', evidenceIds: ['ev-a'] }],
      evidence: [{ evidenceId: 'ev-a', role: 'supports', quote: 'A supported fact.' }],
    }]);
    const generated = `# Alice Example\n\n## Qualifications\n### Qualifies\n- A qualified fact.\n\n## Evidence\n### Supports\n- A supported fact.\n\n## Sources\n[[sources/${nativeSourceSlug('notes/s-a.md')}]]\n[[sources/${nativeSourceSlug('notes/s-b.md')}]]\n\n## Related Concepts\n- [[concepts/canonical-concept|Canonical Concept]]\n`;
    const reducerOptions = options({
      generatedPageContents: new Map([['entity\u001falice example', generated]]),
    });
    const a = reduceNativeSourceIR([first, second], reducerOptions);
    const b = reduceNativeSourceIR([second, first], reducerOptions);

    expect(a).toEqual(b);
    expect(a.complete).toBe(true);
    expect(a.status).toBe('requires-native-comparison');
    expect(a.canApply).toBe(false);
    expect(a.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('native-log:ambiguous-shared-page-attribution'),
    ]));
    expect(a.pages).toHaveLength(1);
    const page = a.pages[0];
    expect(page?.key.keyString).toBe('entity\u001falice example');
    expect(page?.path).toBe('wiki/entities/alice-example.md');
    expect(page?.sourceIds).toEqual(['s-a', 's-b']);
    expect(page?.aliases).toEqual(['A. Example', 'Alice E.']);
    expect(page?.content).toContain(`sources/${nativeSourceSlug('notes/s-a.md')}`);
    expect(page?.content).toContain(`sources/${nativeSourceSlug('notes/s-b.md')}`);
    expect(page?.content).toContain('## Qualifications');
    expect(page?.content).toContain('## Evidence');
    expect(page?.content).toContain('### Qualifies');
    expect(page?.content).toContain('## Related Concepts');
  });

  it('keeps entity and concept keys typed and refuses unresolved cross-type collisions', () => {
    const result = reduceNativeSourceIR([
      source('entity-source', [{ proposalId: 'entity-proposal', sourceId: 'entity-source', pageType: 'entity', label: 'Shared Name' }]),
      source('concept-source', [{ proposalId: 'concept-proposal', sourceId: 'concept-source', pageType: 'concept', label: 'shared name' }]),
    ], options());

    expect(result.complete).toBe(true);
    expect(result.status).toBe('requires-native-comparison');
    expect(result.canApply).toBe(false);
    expect(result.unsupported).toContain('unresolved-cross-type-collision:shared name');
    expect(result.pages.map(page => page.key.pageType)).toEqual(['concept', 'entity']);
  });

  it('routes a cross-type collision to an existing native page without changing its type', () => {
    const existing: NativeExistingPage = {
      path: 'wiki/entities/shared-name.md',
      pageType: 'entity',
      label: 'Shared Name',
      content: '---\ntype: entity\nreviewed: true\n---\n\n# Curated\n',
      reviewed: true,
    };
    const result = reduceNativeSourceIR([
      source('entity-source', [{ proposalId: 'entity-proposal', sourceId: 'entity-source', pageType: 'entity', label: 'Shared Name' }]),
      source('concept-source', [{ proposalId: 'concept-proposal', sourceId: 'concept-source', pageType: 'concept', label: 'shared name', summary: 'new evidence' }]),
    ], options({ existingPages: [existing] }));

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.pageType).toBe('entity');
    expect(result.pages[0]?.path).toBe('wiki/entities/shared-name.md');
    expect(result.pages[0]?.reviewed).toBe(true);
    expect(result.pages[0]?.bodyPolicy).toBe('append-reviewed');
    expect(result.canApply).toBe(false);
    expect(result.reasons).toContain('cross-type-alias:shared name');
    expect(result.pages[0]?.content).toContain('# Curated');
    expect(result.pages[0]?.content).not.toContain('new evidence');
    expect(result.reasons).toContain('native-merge:reviewed-page:wiki/entities/shared-name.md');
  });

  it('preserves reviewed content and makes reviewed append comparison explicit', () => {
    const existing: NativeExistingPage = {
      path: 'wiki/entities/locked.md',
      pageType: 'entity',
      label: 'Locked',
      content: '---\ntype: entity\ncreated: 2024-01-01\nreviewed: true\n---\n\n# Locked\nDo not rewrite this paragraph.\n',
    };
    const result = reduceNativeSourceIR([source('s-locked', [{
      proposalId: 'p-locked', sourceId: 's-locked', pageType: 'entity', label: 'Locked', summary: 'New qualification',
      qualifications: [{ statementId: 'q1', text: 'Only under condition X.', role: 'qualifies' }],
    }])], options({ existingPages: [existing] }));
    const page = result.pages[0];

    expect(page?.bodyPolicy).toBe('append-reviewed');
    expect(page?.content).toContain('Do not rewrite this paragraph.');
    expect(page?.content).not.toContain('Only under condition X.');
    expect(page?.content).toContain('reviewed: true');
    expect(result.reasons).toContain('reviewed-append-requires-native-comparison:wiki/entities/locked.md');
    expect(result.reasons).toContain('native-merge:reviewed-page:wiki/entities/locked.md');
    expect(result.canApply).toBe(false);
  });

  it('uses native frontmatter-only merge bytes for a supported existing page', () => {
    const sourcePath = 'notes/merge-source.md';
    const sourceSlug = nativeSourceSlug(sourcePath);
    const existingContent = `---\ntype: entity\ncreated: 2024-01-01\nupdated: 2026-08-19\nsources:\n  - "[[sources/older-source_abcdef]]"\ntags:\n  - "person"\naliases:\n  - "Existing Alias"\ncustom: preserve-me\n---\n\n# Merge Target\n\nCurated body.\n`;
    const existing: NativeExistingPage = {
      path: 'wiki/entities/merge-target.md',
      pageType: 'entity',
      label: 'Merge Target',
      content: existingContent,
    };
    const reducerOptions = options({
      existingPages: [existing],
      existingFiles: new Map([[existing.path, existing.content]]),
    });
    const result = reduceNativeSourceIR([source('merge-source', [{
      proposalId: 'merge-proposal',
      sourceId: 'merge-source',
      pageType: 'entity',
      label: 'Merge Target',
    }], { sourcePath, sourceSlug })], reducerOptions);
    const page = result.pages[0];
    const expected = planNativeMerge({
      pagePath: existing.path,
      sourcePath,
      sourceSlug,
      existingContent,
      wikiFolder: 'wiki',
      date: '2026-08-20',
      mode: 'frontmatter-only',
      slug: { preserveCase: false },
    });
    const desired = result.desiredState.find(file => file.path === existing.path);

    expect(result.canApply).toBe(true);
    expect(expected.canApply).toBe(true);
    expect(page?.content).toBe(expected.content);
    expect(desired?.action).toBe(expected.action);
    expect(page?.content).toContain('created: 2024-01-01');
    expect(page?.content).toContain(`sources/${sourceSlug}`);
    expect(page?.content).toContain('Existing Alias');
    expect(page?.content).toContain('custom: preserve-me');
    expect(page?.content).toContain('Curated body.');
  });

  it('refuses an existing non-reviewed body merge without generic-render fallback', () => {
    const existing: NativeExistingPage = {
      path: 'wiki/entities/body-target.md',
      pageType: 'entity',
      label: 'Body Target',
      content: '---\ntype: entity\ncreated: 2024-01-01\n---\n\n# Curated body.\n',
    };
    const result = reduceNativeSourceIR([source('body-source', [{
      proposalId: 'body-proposal',
      sourceId: 'body-source',
      pageType: 'entity',
      label: 'Body Target',
      body: '# Provider body\n\nNew content.\n',
    }])], options({ existingPages: [existing] }));

    expect(result.canApply).toBe(false);
    expect(result.pages[0]?.content).toBe(existing.content);
    expect(result.pages[0]?.content).not.toContain('New content.');
    expect(result.reasons).toContain('native-merge:body-comparison-required:wiki/entities/body-target.md');
    expect(result.reasons).toContain('native-merge-required:wiki/entities/body-target.md');
  });

  it('refuses shared existing-page sequencing even when frontmatter is otherwise mergeable', () => {
    const existing: NativeExistingPage = {
      path: 'wiki/entities/shared-existing.md',
      pageType: 'entity',
      label: 'Shared Existing',
      content: '---\ntype: entity\ncreated: 2024-01-01\n---\n\n# Shared Existing\n',
    };
    const result = reduceNativeSourceIR([
      source('shared-a', [{ proposalId: 'shared-a-proposal', sourceId: 'shared-a', pageType: 'entity', label: 'Shared Existing' }]),
      source('shared-b', [{ proposalId: 'shared-b-proposal', sourceId: 'shared-b', pageType: 'entity', label: 'Shared Existing' }]),
    ], options({ existingPages: [existing] }));

    expect(result.canApply).toBe(false);
    expect(result.pages[0]?.content).toBe(existing.content);
    expect(result.reasons).toContain('native-merge:shared-page-sequence-required:wiki/entities/shared-existing.md');
  });

  it('emits a complete serialized global phase without touching the filesystem', () => {
    const result = reduceNativeSourceIR([source('s-one', [{ proposalId: 'p-one', sourceId: 's-one', pageType: 'concept', label: 'One' }])], options());
    const globalKinds = result.globalPhase.files.map(file => file.kind);

    expect(result.complete).toBe(true);
    expect(result.globalPhase.serialized).toBe(true);
    expect(globalKinds).toEqual(['source', 'index', 'log', 'schema']);
    expect(result.globalPhase.serializationOrder).toEqual(result.globalPhase.files.map(file => file.path));
    expect(result.desiredState.map(file => file.path)).toContain('20 Brain/schema.md');
    expect(result.desiredState.find(file => file.path === '20 Brain/log.md')?.content).toContain('## [2026-08-20 00:00] ingest | s-one');
    expect(result.desiredState.find(file => file.path === `wiki/sources/${nativeSourceSlug('notes/s-one.md')}.md`)?.phase).toBe('serialized-global');
  });

  it('fingerprints duplicate-basename source paths for every source link', () => {
    const firstPath = 'raw/Course X/About this course.md';
    const secondPath = 'raw/Course Y/About this course.md';
    const firstSlug = nativeSourceSlug(firstPath);
    const secondSlug = nativeSourceSlug(secondPath);
    const proposal = (sourceId: string) => ({
      proposalId: `${sourceId}-proposal`, sourceId, pageType: 'entity' as const, label: 'Shared entity',
    });
    const result = reduceNativeSourceIR([
      source('course-x', [proposal('course-x')], { sourcePath: firstPath, sourceSlug: firstSlug }),
      source('course-y', [proposal('course-y')], { sourcePath: secondPath, sourceSlug: secondSlug }),
    ], options({
      generatedPageContents: new Map([[
        'entity\u001fshared entity',
        `# Shared entity\n\n## Sources\n[[sources/${firstSlug}]]\n[[sources/${secondSlug}]]\n`,
      ]]),
    }));

    expect(firstSlug).not.toBe(secondSlug);
    expect(result.desiredState.map(file => file.path)).toEqual(expect.arrayContaining([
      `wiki/sources/${firstSlug}.md`,
      `wiki/sources/${secondSlug}.md`,
    ]));
    const page = result.pages[0];
    expect(page?.sourceLinks).toEqual([
      `[[sources/${firstSlug}]]`,
      `[[sources/${secondSlug}]]`,
    ].sort());
    expect(page?.content).toContain(`[[sources/${firstSlug}]]`);
    expect(page?.content).toContain(`[[sources/${secondSlug}]]`);
    expect(page?.content).not.toContain('[[sources/about-this-course]]');
  });

  it('refuses a stale basename-only source slug instead of falling back', () => {
    const sourcePath = 'raw/Course X/About this course.md';
    expect(() => reduceNativeSourceIR([
      source('stale', [{ proposalId: 'stale-proposal', sourceId: 'stale', pageType: 'entity', label: 'Stale' }], {
        sourcePath,
        sourceSlug: 'about-this-course',
      }),
    ], options())).toThrow(/source slug does not match native path fingerprint/u);
  });

  it('uses native source, index, and log planners for serialized global bytes', () => {
    const sourcePath = 'raw/Course X/Source.md';
    const sourceSlug = nativeSourceSlug(sourcePath);
    const sourceBody = '---\ntype: source\n---\n\n# Source\n\nGenerated source body.\n';
    const sourceContent = '---\ntags:\n  - source\n---\n\nOriginal source bytes.\n';
    const reducerOptions = options({
      wikiFolder: 'wiki',
      global: {
        paths: { index: 'wiki/index.md', log: 'wiki/log.md', schema: 'wiki/schema.md' },
        runId: 'planner-run',
        schemaContent: '# Schema\n',
      },
      sourceContents: new Map([[sourcePath, sourceContent]]),
      time: '03:04',
      generatedPageContents: new Map([['entity\u001fplanner entity', '# Planner Entity\n\nPlanner body.\n']]),
    });
    const input = source('planner-source', [{
      proposalId: 'planner-proposal', sourceId: 'planner-source', pageType: 'entity', label: 'Planner Entity',
    }], {
      sourcePath,
      sourceSlug,
      sourceContent,
      sourceBody,
      sourceTitle: 'Planner Source',
      sourceAliases: ['Raw Source'],
      sourceTags: ['source'],
      sourcePage: { title: 'Planner Source', body: sourceBody, aliases: ['Page Source'], tags: ['source'] },
    });
    const result = reduceNativeSourceIR([input], reducerOptions);
    const sourceFile = result.desiredState.find(file => file.kind === 'source');
    const indexFile = result.desiredState.find(file => file.kind === 'index');
    const logFile = result.desiredState.find(file => file.kind === 'log');
    const expectedSource = planNativeSourcePage({
      sourcePath,
      wikiFolder: 'wiki',
      generatedContent: sourceBody,
      sourceContent,
      sourceNoteAliases: ['Page Source', 'Raw Source'],
      sourceTags: ['source'],
      slug: { preserveCase: false },
    });
    const expectedIndex = planNativeIndex({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      entities: [{ path: result.pages[0]?.path, content: result.pages[0]?.content ?? '' }],
      concepts: [],
      sources: [{ path: sourceFile?.path, basename: sourceSlug, sourcePath, content: sourceFile?.content ?? '' }],
      slug: { preserveCase: false },
    });
    const expectedLog = planNativeIngestLog({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      operation: 'ingest',
      sourceTitle: 'Planner Source',
      createdPages: [result.pages[0]?.path ?? '', sourceFile?.path ?? ''],
      updatedPages: [],
      date: '2026-08-20',
      time: '03:04',
    });

    expect(result.canApply).toBe(true);
    expect(sourceFile?.content).toBe(expectedSource.content);
    expect(indexFile?.content).toBe(expectedIndex.content);
    expect(logFile?.content).toBe(expectedLog.content);
    expect(sourceFile?.content).toContain('contentHash:');
    expect(sourceFile?.content).toContain('tags:');
    expect(sourceFile?.content).toContain('Raw Source');
  });

  it('uses native generated-page bytes for a new page and preserves typed metadata inputs', () => {
    const generatedContent = '---\ntype: entity\n---\n\n# Generated Entity\n\nProvider body.\n\n## Related Concepts\n- [[Linked Concept]]\n';
    const reducerOptions = options({
      generatedPageContents: new Map([['entity\u001fgenerated entity', generatedContent]]),
    });
    const input = source('generated-source', [{
      proposalId: 'generated-proposal',
      sourceId: 'generated-source',
      pageType: 'entity',
      label: 'Generated Entity',
      typeTag: 'person',
      aliases: ['Generated Alias'],
      relatedConcepts: ['Linked Concept'],
      evidence: [
        {
          evidenceId: 'a-later-generated-evidence',
          role: 'supports',
          quote: 'A later generated-source mention.',
          sourcePath: 'notes/generated-source.md',
          sourceSlug: nativeSourceSlug('notes/generated-source.md'),
          extractedAt: '2026-08-20T00:00:02.000Z',
        },
        {
          evidenceId: 'b-earlier-generated-evidence',
          role: 'supports',
          quote: 'An earlier generated-source mention.',
          sourcePath: 'notes/generated-source.md',
          sourceSlug: nativeSourceSlug('notes/generated-source.md'),
          extractedAt: '2026-08-20T00:00:01.000Z',
        },
      ],
    }]);
    const result = reduceNativeSourceIR([input], reducerOptions);
    const page = result.pages[0];
    const expected = planNativeGeneratedPage({
      pageType: 'entity',
      path: 'wiki/entities/generated-entity.md',
      generatedContent,
      settings: reducerOptions.nativeSettings as NonNullable<NativeReducerOptions['nativeSettings']>,
      sourcePath: input.sourcePath,
      sourceSlug: input.sourceSlug,
      aliases: ['Generated Alias'],
      tags: ['person'],
      relatedEntities: [],
      relatedConcepts: ['Linked Concept'],
      mentions: [
        {
          quote: 'A later generated-source mention.',
          source_path: 'notes/generated-source.md',
          source_slug: nativeSourceSlug('notes/generated-source.md'),
          extracted_at: '2026-08-20T00:00:02.000Z',
        },
        {
          quote: 'An earlier generated-source mention.',
          source_path: 'notes/generated-source.md',
          source_slug: nativeSourceSlug('notes/generated-source.md'),
          extracted_at: '2026-08-20T00:00:01.000Z',
        },
      ],
      date: '2026-08-20',
    });

    expect(result.canApply).toBe(true);
    expect(page?.content).toBe(expected.content);
    expect(page?.content).toContain('Generated Alias');
    expect(page?.content).toContain('person');
    expect(page?.content).toContain('Linked Concept');
    expect(page?.content).toContain('A later generated-source mention.');
    expect(page?.content).toContain('An earlier generated-source mention.');
    expect(page?.content.indexOf('An earlier generated-source mention.')).toBeLessThan(page?.content.indexOf('A later generated-source mention.'));
  });

  it('fails closed when new-page native settings or provider content is not sealed', () => {
    const result = reduceNativeSourceIR([source('unbound-page', [{
      proposalId: 'unbound-page-proposal',
      sourceId: 'unbound-page',
      pageType: 'entity',
      label: 'Unbound Page',
    }])], options({
      nativeSettings: undefined,
      generatedPageContents: new Map(),
    }));
    const page = result.pages[0];

    expect(result.canApply).toBe(false);
    expect(page?.content).toBe('');
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('native-generated-page:missing-settings:wiki/entities/unbound-page.md'),
      expect.stringContaining('native-generated-page:missing-generated-content:entity\u001funbound page:wiki/entities/unbound-page.md'),
    ]));
    expect(result.unsupported).toEqual(expect.arrayContaining([
      expect.stringContaining('native-generated-page:missing-settings'),
      expect.stringContaining('native-generated-page:missing-generated-content'),
    ]));
  });

  it('retains sealed native-map mention extraction timestamps through reduction', () => {
    const result = reduceNativeMapIR([mapped({
      entities: [{
        name: 'Mapped Entity',
        type: 'person',
        aliases: [],
        summary: 'Entity summary',
        mentions_in_source: ['Older mapped mention.', 'Newer mapped mention.'],
        mentions_with_provenance: [
          {
            quote: 'Older mapped mention.',
            source_path: 'notes/mapped.md',
            source_slug: 'stale-mapped-slug',
            extracted_at: '2026-08-20T00:00:01.000Z',
          },
          {
            quote: 'Newer mapped mention.',
            source_path: 'notes/mapped.md',
            source_slug: 'stale-mapped-slug',
            extracted_at: '2026-08-20T00:00:02.000Z',
          },
        ],
        related_entities: [],
        related_concepts: [],
      }],
    })], options());
    const evidence = result.pages[0]?.evidence ?? [];

    expect(evidence.map(item => item.extractedAt)).toEqual(expect.arrayContaining([
      '2026-08-20T00:00:01.000Z',
      '2026-08-20T00:00:02.000Z',
    ]));
    expect(evidence.every(item => item.sourcePath === 'notes/mapped.md')).toBe(true);
    expect(evidence.every(item => item.sourceSlug === nativeSourceSlug('notes/mapped.md'))).toBe(true);
  });

  it('propagates missing sealed source content and time as native planner refusals', () => {
    const noBindings = options({
      sourceContents: new Map(),
      time: undefined,
      global: {
        paths: { index: 'wiki/index.md', log: 'wiki/log.md', schema: 'wiki/schema.md' },
        runId: 'refusal-run',
        schemaContent: '# Schema\n',
      },
    });
    const result = reduceNativeSourceIR([source('unbound', [{
      proposalId: 'unbound-proposal', sourceId: 'unbound', pageType: 'entity', label: 'Unbound',
    }], { sourceContent: undefined })], noBindings);

    expect(result.canApply).toBe(false);
    expect(result.status).toBe('requires-native-comparison');
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('native-source-page:missing-source-content'),
      expect.stringContaining('native-log:missing-time'),
    ]));
    expect(result.unsupported).toEqual(expect.arrayContaining([
      expect.stringContaining('native-source-page:missing-source-content'),
      expect.stringContaining('native-log:missing-time'),
    ]));
  });

  it('folds one native log entry per source while carrying prior log bytes forward', () => {
    const reducerOptions = options({
      global: {
        paths: { index: 'wiki/index.md', log: 'wiki/log.md', schema: 'wiki/schema.md' },
        runId: 'fold-run',
        schemaContent: '# Schema\n',
        existing: new Map([['wiki/log.md', '# Existing log\n']]),
      },
      time: '03:05',
      generatedPageContents: new Map([
        ['entity\u001fa page', '# A Page\n'],
        ['entity\u001fb page', '# B Page\n'],
      ]),
    });
    const result = reduceNativeSourceIR([
      source('source-b', [{ proposalId: 'b-page', sourceId: 'source-b', pageType: 'entity', label: 'B Page' }]),
      source('source-a', [{ proposalId: 'a-page', sourceId: 'source-a', pageType: 'entity', label: 'A Page' }]),
    ], reducerOptions);
    const log = result.desiredState.find(file => file.kind === 'log')?.content ?? '';
    const aPage = result.pages.find(page => page.label === 'A Page')?.path ?? '';
    const bPage = result.pages.find(page => page.label === 'B Page')?.path ?? '';
    const aSource = result.desiredState.find(file => file.kind === 'source' && file.sourceIds.includes('source-a'))?.path ?? '';
    const bSource = result.desiredState.find(file => file.kind === 'source' && file.sourceIds.includes('source-b'))?.path ?? '';
    const first = planNativeIngestLog({
      wikiFolder: 'wiki', wikiLanguage: 'en', existingContent: '# Existing log\n', operation: 'ingest', sourceTitle: 'source-a',
      createdPages: [aPage, aSource], updatedPages: [], date: '2026-08-20', time: '03:05',
    });
    const second = planNativeIngestLog({
      wikiFolder: 'wiki', wikiLanguage: 'en', existingContent: first.content, operation: 'ingest', sourceTitle: 'source-b',
      createdPages: [bPage, bSource], updatedPages: [], date: '2026-08-20', time: '03:05',
    });

    expect(result.canApply).toBe(true);
    expect(log).toBe(second.content);
    expect(log.indexOf('ingest | source-a')).toBeLessThan(log.indexOf('ingest | source-b'));
    expect((log.match(/## \[2026-08-20 03:05\] ingest/gu) ?? []).length).toBe(2);
    expect(log).toContain(`[[${aPage.replace('wiki/', '')}]]`);
    expect(log).toContain(`[[${bPage.replace('wiki/', '')}]]`);
  });

  it('refuses native log attribution for a shared canonical page', () => {
    const result = reduceNativeSourceIR([
      source('source-a', [{ proposalId: 'a-page', sourceId: 'source-a', pageType: 'entity', label: 'Shared Page' }]),
      source('source-b', [{ proposalId: 'b-page', sourceId: 'source-b', pageType: 'entity', label: 'Shared Page' }]),
    ], options({
      global: {
        paths: { index: 'wiki/index.md', log: 'wiki/log.md', schema: 'wiki/schema.md' },
        runId: 'ambiguous-log-run',
        schemaContent: '# Schema\n',
      },
    }));

    expect(result.canApply).toBe(false);
    expect(result.status).toBe('requires-native-comparison');
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('native-log:ambiguous-shared-page-attribution'),
    ]));
    expect(result.unsupported).toEqual(expect.arrayContaining([
      expect.stringContaining('native-log:ambiguous-shared-page-attribution'),
    ]));
  });

  it('fails closed for provider-owned unsupported frontmatter instead of applying it', () => {
    const result = reduceNativeSourceIR([source('s-unsafe', [{
      proposalId: 'p-unsafe', sourceId: 's-unsafe', pageType: 'entity', label: 'Unsafe',
      body: '---\ntype: entity\nowner_only: secret\n---\n\n# Unsafe\n',
    }])], options());
    expect(result.status).toBe('requires-native-comparison');
    expect(result.canApply).toBe(false);
    expect(result.unsupported).toContain('provider-frontmatter:owner_only');
  });

  it('accepts the native source summary, source alias, and deterministically resolved related proposal', () => {
    const result = reduceNativeMapIR([mapped({
      claims: [{
        claimId: 'source-summary',
        subject: { pageType: 'source', label: 'Mapped source' },
        predicate: 'source-summary',
        statement: 'A mapped summary',
        disposition: 'proposed',
        evidenceQuotes: [],
        sourcePath: 'notes/mapped.md',
      }, {
        claimId: 'source-contradiction',
        subject: { pageType: 'source', label: 'Mapped source' },
        predicate: 'contradiction',
        statement: 'Mapped Entity fact is disputed',
        disposition: 'contested',
        evidenceQuotes: [],
        sourcePath: 'notes/mapped.md',
      }],
      aliases: [{
        alias: 'Mapped SOP',
        targetPageType: 'source',
        targetLabel: 'Mapped source',
        sourcePath: 'notes/mapped.md',
      }],
      related: [{
        sourcePath: 'notes/mapped.md',
        pageType: 'entity',
        label: 'Mapped Entity',
        resolution: 'unresolved-source-proposal',
      }],
      contradictions: [{
        claim: 'Mapped Entity fact is disputed',
        source_page: 'Mapped Entity.md',
        contradicted_by: 'Contrary evidence',
        resolution: 'Needs review',
      }],
    })], options());
    const sourceFile = result.desiredState.find(file => file.kind === 'source');

    expect(result.canApply).toBe(true);
    expect(result.unsupported).toEqual([]);
    expect(sourceFile?.content).toContain('Mapped SOP');
    expect(result.pages[0]?.statements.some(statement => statement.role === 'contests')).toBe(true);
  });

  it('fails closed when a source alias collides with a native page label', () => {
    const result = reduceNativeMapIR([mapped({
      aliases: [{
        alias: 'Mapped Entity',
        targetPageType: 'source',
        targetLabel: 'Mapped source',
        sourcePath: 'notes/mapped.md',
      }],
    })], options());

    expect(result.canApply).toBe(false);
    expect(result.unsupported.some(reason => reason.startsWith('ambiguous-source-alias:'))).toBe(true);
  });

  it('propagates every adapter refusal into the non-applyable plan', () => {
    const cases: Array<{ label: string; ir: NativeMapIR; reason: string }> = [
      {
        label: 'source summary mismatch',
        ir: mapped({ claims: [{ claimId: 'source-claim', subject: { pageType: 'source', label: 'Mapped source' }, predicate: 'source-summary', statement: 'Different summary', disposition: 'proposed', evidenceQuotes: [], sourcePath: 'notes/mapped.md' }] }),
        reason: 'native-map-claim-source-subject:source-claim',
      },
      {
        label: 'claim target missing',
        ir: mapped({ claims: [{ claimId: 'missing-claim', subject: { pageType: 'entity', label: 'Missing entity' }, predicate: 'item-summary', statement: 'Missing target', disposition: 'proposed', evidenceQuotes: [], sourcePath: 'notes/mapped.md' }] }),
        reason: 'native-map-claim-target-missing:missing-claim',
      },
      {
        label: 'claim source mismatch',
        ir: mapped({ claims: [{ claimId: 'mismatched-claim', subject: { pageType: 'entity', label: 'Mapped Entity' }, predicate: 'item-summary', statement: 'Mismatched source', disposition: 'proposed', evidenceQuotes: [], sourcePath: 'notes/other.md' }] }),
        reason: 'native-map-claim-source-mismatch:mismatched-claim',
      },
      {
        label: 'source alias target',
        ir: mapped({ aliases: [{ alias: 'Mapped SOP', targetPageType: 'source', targetLabel: 'Other source', sourcePath: 'notes/mapped.md' }] }),
        reason: 'native-map-alias-target:Mapped SOP',
      },
      {
        label: 'alias target missing',
        ir: mapped({ aliases: [{ alias: 'Ghost', targetPageType: 'entity', targetLabel: 'Missing entity', sourcePath: 'notes/mapped.md' }] }),
        reason: 'native-map-alias-target-missing:Ghost',
      },
      {
        label: 'alias source mismatch',
        ir: mapped({ aliases: [{ alias: 'Mapped', targetPageType: 'entity', targetLabel: 'Mapped Entity', sourcePath: 'notes/other.md' }] }),
        reason: 'native-map-alias-source-mismatch:Mapped',
      },
      {
        label: 'unknown related target',
        ir: mapped({ related: [{ sourcePath: 'notes/mapped.md', pageType: 'entity', label: 'Missing entity', resolution: 'unresolved-source-proposal' }] }),
        reason: 'native-map-related-target-missing:Missing entity',
      },
      {
        label: 'unsupported related type',
        ir: mapped({ related: [{ sourcePath: 'notes/mapped.md', pageType: 'unknown', label: 'Unknown', resolution: 'unresolved-source-proposal' }] }),
        reason: 'native-map-related-target:Unknown',
      },
      {
        label: 'related source mismatch',
        ir: mapped({ related: [{ sourcePath: 'notes/other.md', pageType: 'entity', label: 'Mapped Entity', resolution: 'unresolved-source-proposal' }] }),
        reason: 'native-map-related-source-mismatch:Mapped Entity',
      },
      {
        label: 'contradiction target',
        ir: mapped({ contradictions: [{ claim: 'Missing page claim', source_page: 'missing.md', contradicted_by: 'Contrary quote', resolution: 'Unresolved' }] }),
        reason: 'native-map-contradiction-target:missing.md',
      },
    ];

    for (const testCase of cases) {
      const result = reduceNativeMapIR([testCase.ir], options());
      expect(result.canApply, testCase.label).toBe(false);
      expect(result.status, testCase.label).toBe('requires-native-comparison');
      expect(result.reasons, testCase.label).toContain(testCase.reason);
      expect(result.unsupported, testCase.label).toContain(testCase.reason);
    }
  });

  it('propagates source-scoped unsupported reasons verbatim instead of silently applying', () => {
    const result = reduceNativeSourceIR([source('s-refused', [{
      proposalId: 'p-refused', sourceId: 's-refused', pageType: 'entity', label: 'Refused',
    }], { unsupported: ['native-map-custom-refusal:provider-output', 'native-map-another-refusal'] })], options());

    expect(result.canApply).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['native-map-custom-refusal:provider-output', 'native-map-another-refusal']));
    expect(result.unsupported).toEqual(expect.arrayContaining(['native-map-custom-refusal:provider-output', 'native-map-another-refusal']));
  });

  it('refuses a native-map result degraded by a later provider batch failure', () => {
    const result = reduceNativeMapIR([mapped({
      degradations: [{
        status: 'degraded',
        code: 'later-batch-provider-failure',
        failedBatch: 2,
        preservedBatchCount: 1,
      }],
    })], options());

    expect(result.canApply).toBe(false);
    expect(result.status).toBe('requires-native-comparison');
    expect(result.reasons).toContain('native-map-degradation:later-batch-provider-failure');
    expect(result.unsupported).toContain('native-map-degradation:later-batch-provider-failure');
    expect(result.unsupported.join('\n')).not.toContain('provider unavailable');
  });

  it('consumes native-map/v1 IR while retaining contested claims and provenance', () => {
    const mapped: NativeMapIR = {
      contractVersion: 'native-map/v1',
      source: { sourceId: 'mapped-source', sourcePath: 'notes/mapped.md', byteSha256: 'a'.repeat(64), byteCount: 6 },
      sourceTitle: 'Mapped source',
      summary: 'A mapped summary',
      sourceAliases: [],
      keyPoints: [],
      entities: [{ name: 'Mapped Entity', type: 'person', aliases: [], summary: 'Entity summary', mentions_in_source: [], mentions_with_provenance: [], related_entities: [], related_concepts: [] }],
      concepts: [],
      mentions: [],
      claims: [{ claimId: 'claim-1', subject: { pageType: 'entity', label: 'Mapped Entity' }, predicate: 'item-summary', statement: 'This claim is contested.', disposition: 'contested', evidenceQuotes: ['The contrary quote'], sourcePath: 'notes/mapped.md' }],
      aliases: [],
      related: [],
      contradictions: [],
      artifacts: [],
      policySha256: 'b'.repeat(64),
      irSha256: 'c'.repeat(64),
    };
    const result = reduceNativeMapIR([mapped], options());
    const page = result.pages[0];
    expect(page?.statements.some(statement => statement.role === 'contests')).toBe(true);
    expect(page?.evidence.some(evidence => evidence.role === 'contests')).toBe(true);
    expect(page?.content).toContain('## Contested Evidence');
    expect(page?.content).toContain('notes/mapped');
  });

  it('rejects source leakage and non-deterministic unsafe labels before producing a plan', () => {
    expect(() => reduceNativeSourceIR([source('s-one', [{ proposalId: 'p', sourceId: 'other-source', pageType: 'entity', label: 'Valid' }])], options())).toThrow(NativeReductionError);
    expect(() => reduceNativeSourceIR([source('s-two', [{ proposalId: 'p', sourceId: 's-two', pageType: 'entity', label: '///' }])], options())).toThrow(NativeReductionError);
  });

  it('refuses proposal-id, case-insensitive path, and existing-page collisions', () => {
    expect(() => reduceNativeSourceIR([source('s-duplicate', [
      { proposalId: 'same', sourceId: 's-duplicate', pageType: 'entity', label: 'First' },
      { proposalId: 'same', sourceId: 's-duplicate', pageType: 'entity', label: 'Second' },
    ])], options())).toThrow(/duplicate proposal id/u);

    const slugCollision = reduceNativeSourceIR([
      source('s-comma', [{ proposalId: 'comma', sourceId: 's-comma', pageType: 'entity', label: 'A,B' }]),
      source('s-plain', [{ proposalId: 'plain', sourceId: 's-plain', pageType: 'entity', label: 'AB' }]),
    ], options());
    expect(slugCollision.canApply).toBe(false);
    expect(slugCollision.reasons.some(reason => reason.startsWith('path-collision:'))).toBe(true);

    const existingKindCollision = reduceNativeSourceIR([source('s-existing', [{
      proposalId: 'existing', sourceId: 's-existing', pageType: 'entity', label: 'Existing',
    }])], options({ existingPages: [{
      path: 'wiki/entities/existing.md', pageType: 'source', label: 'Existing', content: '---\ntype: source\n---\n\n# Existing source\n',
    }] }));
    expect(existingKindCollision.canApply).toBe(false);
    expect(existingKindCollision.reasons).toContain('existing-page-type-mismatch:wiki/entities/existing.md');

    expect(() => reduceNativeSourceIR([
      source('s-path-a', [{ proposalId: 'path-a', sourceId: 's-path-a', pageType: 'entity', label: 'Path A' }], { sourcePath: 'notes/shared.md', sourceSlug: nativeSourceSlug('notes/shared.md') }),
      source('s-path-b', [{ proposalId: 'path-b', sourceId: 's-path-b', pageType: 'entity', label: 'Path B' }], { sourcePath: 'notes/SHARED.md', sourceSlug: nativeSourceSlug('notes/SHARED.md') }),
    ], options())).toThrow(/duplicate source path/u);
  });

  it('refuses aliases which collide with another page label', () => {
    const result = reduceNativeSourceIR([
      source('s-one', [{ proposalId: 'one', sourceId: 's-one', pageType: 'entity', label: 'One', aliases: ['Two'] }]),
      source('s-two', [{ proposalId: 'two', sourceId: 's-two', pageType: 'entity', label: 'Two' }]),
    ], options());

    expect(result.canApply).toBe(false);
    expect(result.reasons.some(reason => reason.startsWith('ambiguous-alias:Two:'))).toBe(true);
  });
});
