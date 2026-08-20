import { describe, expect, it } from 'vitest';

import { nativeSourceSlug } from '../../../../../tools/llm-wiki-cli/src/headless/native-compatibility';
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
  date: '2026-08-20',
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
    const a = reduceNativeSourceIR([first, second], options());
    const b = reduceNativeSourceIR([second, first], options());

    expect(a).toEqual(b);
    expect(a.complete).toBe(true);
    expect(a.status).toBe('candidate');
    expect(a.canApply).toBe(true);
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
    expect(result.pages[0]?.content).toContain('new evidence');
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
    expect(page?.content).toContain('Only under condition X.');
    expect(page?.content).toContain('reviewed: true');
    expect(result.reasons).toContain('reviewed-append-requires-native-comparison:wiki/entities/locked.md');
    expect(result.canApply).toBe(false);
  });

  it('emits a complete serialized global phase without touching the filesystem', () => {
    const result = reduceNativeSourceIR([source('s-one', [{ proposalId: 'p-one', sourceId: 's-one', pageType: 'concept', label: 'One' }])], options());
    const globalKinds = result.globalPhase.files.map(file => file.kind);

    expect(result.complete).toBe(true);
    expect(result.globalPhase.serialized).toBe(true);
    expect(globalKinds).toEqual(['source', 'index', 'log', 'schema']);
    expect(result.globalPhase.serializationOrder).toEqual(result.globalPhase.files.map(file => file.path));
    expect(result.desiredState.map(file => file.path)).toContain('20 Brain/schema.md');
    expect(result.desiredState.find(file => file.path === '20 Brain/log.md')?.content).toContain('run-native-test');
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
    ], options());

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
