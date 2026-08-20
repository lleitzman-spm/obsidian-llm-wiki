import { describe, expect, it } from 'vitest';

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
  sourceSlug: `${sourceId}-slug`,
  sourceTitle: sourceId,
  proposals,
  ...extra,
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
    expect(page?.content).toContain('sources/s-a-slug');
    expect(page?.content).toContain('sources/s-b-slug');
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
    expect(result.desiredState.find(file => file.path === 'wiki/sources/s-one-slug.md')?.phase).toBe('serialized-global');
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
});
