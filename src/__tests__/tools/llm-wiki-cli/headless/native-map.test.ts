import { describe, expect, it, vi } from 'vitest';

import {
  createNativeMapPolicy,
  mapNativeSource,
  NativeMapProtocolError,
  type NativeMapClient,
  type NativeMapExistingPage,
  type NativeMapSettings,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-map';

const settings: NativeMapSettings = {
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  wikiLanguage: 'en',
  extractionGranularity: 'minimal',
  tagVocabularyMode: 'custom',
  customEntityTags: 'owner, property',
  customConceptTags: 'procedure, control',
  disableThinking: true,
};

function policy(overrides: Partial<NativeMapSettings> = {}) {
  const merged = { ...settings, ...overrides };
  return createNativeMapPolicy({
    settings: merged,
    entityTags: merged.tagVocabularyMode === 'custom' ? ['owner', 'property'] : ['person', 'organization', 'project', 'product', 'event', 'place', 'other'],
    conceptTags: merged.tagVocabularyMode === 'custom' ? ['procedure', 'control'] : ['theory', 'method', 'field', 'phenomenon', 'standard', 'term', 'other'],
    systemPrompt: 'native schema context',
  });
}

const sourceText = `---\naliases:\n  - Lease SOP\nlanguage: en\n---\n# Lease workflow\nThe owner approves the lease workflow.\nThe vendor follows the control procedure.`;

function clientFor(responses: readonly string[], onCall?: (params: Parameters<NativeMapClient['createMessage']>[0]) => void): NativeMapClient {
  let index = 0;
  return {
    createMessage: vi.fn(async params => {
      onCall?.(params);
      const response = responses[Math.min(index++, responses.length - 1)];
      return response ?? '{"entities":[],"concepts":[]}';
    }),
  };
}

function firstResponse(): string {
  return JSON.stringify({
    source_title: 'Lease workflow',
    summary: 'The source describes a lease workflow and its control procedure.',
    entities: [{
      name: 'owner',
      type: 'owner',
      aliases: ['landlord'],
      summary: 'The owner approves the workflow.',
      mentions_in_source: ['The owner approves the lease workflow.'],
      related_entities: ['vendor'],
      related_concepts: ['control procedure'],
    }],
    concepts: [{
      name: 'control procedure',
      type: 'procedure',
      aliases: ['control'],
      summary: 'The procedure describes how the vendor follows the control.',
      mentions_with_provenance: [{
        quote: 'The vendor follows the control procedure.',
        source_path: 'notes/lease.md',
        source_slug: 'wrong-slug-is-replaced',
        extracted_at: '2020-01-01T00:00:00.000Z',
      }],
      related_concepts: ['lease workflow'],
      related_entities: ['vendor'],
    }],
    contradictions: [{
      claim: 'The procedure is mandatory.',
      source_page: '[[controls/lease]]',
      contradicted_by: 'The existing page says it is optional.',
      resolution: 'Review the source and page together.',
    }],
    related_pages: ['Lease control'],
    key_points: ['Owner approval is required.'],
  });
}

describe('native source map seam', () => {
  it('uses native extraction prompts and emits typed, source-scoped IR without a vault context', async () => {
    const calls: Array<Parameters<NativeMapClient['createMessage']>[0]> = [];
    const client = clientFor([firstResponse(), '{"entities":[],"concepts":[]}'], params => calls.push(params));
    const sourceBytes = new TextEncoder().encode(sourceText);
    const result = await mapNativeSource({
      source: {
        sourceId: 'source-lease-1',
        sourcePath: 'notes/lease.md',
        sourceBytes,
        extractedAt: '2026-08-20T00:00:00.000Z',
      },
      policy: policy(),
      client,
    });

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.messages[0]?.content).toContain('Original vault path: notes/lease.md');
    expect(calls[0]?.messages[0]?.content).toContain('owner');
    expect(calls[0]?.messages[0]?.content).toContain('procedure');
    expect(calls[0]?.system).toContain('native schema context');
    expect(calls[0]?.enableThinking).toBe(false);
    expect(result.source).toMatchObject({ sourceId: 'source-lease-1', sourcePath: 'notes/lease.md' });
    expect(result.sourceAliases).toEqual(['Lease SOP']);
    expect(result.entities[0]).toMatchObject({ name: 'owner', type: 'owner', aliases: ['landlord'] });
    expect(result.concepts[0]).toMatchObject({ name: 'control procedure', type: 'procedure' });
    expect(result.mentions.map(mention => mention.source_path)).toEqual(['notes/lease.md', 'notes/lease.md']);
    expect(result.mentions[0]?.source_slug).toBe('lease');
    expect(result.claims.some(claim => claim.predicate === 'contradiction' && claim.disposition === 'contested')).toBe(true);
    expect(result.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'Lease SOP', targetPageType: 'source' }),
      expect.objectContaining({ alias: 'landlord', targetPageType: 'entity' }),
    ]));
    expect(result.related).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'vendor', pageType: 'entity' }),
      expect.objectContaining({ label: 'Lease control', pageType: 'unknown' }),
    ]));
    expect(result.artifacts.map(artifact => artifact.kind)).toEqual(expect.arrayContaining([
      'summary', 'entity', 'concept', 'claim', 'alias', 'related',
    ]));
    expect(new Set(result.artifacts.map(artifact => artifact.artifactId)).size).toBe(result.artifacts.length);
    expect(result.artifacts.every(artifact => artifact.sourceId === 'source-lease-1')).toBe(true);
    expect(result.irSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('normalizes structured mentions to the immutable source path and rejects fabricated quotes', async () => {
    const client = clientFor([firstResponse(), '{"entities":[],"concepts":[]}']);
    const sourceBytes = new TextEncoder().encode(sourceText);
    const result = await mapNativeSource({
      source: { sourceId: 'source-lease-1', sourcePath: 'notes/lease.md', sourceBytes, extractedAt: '2026-08-20T00:00:00.000Z' },
      policy: policy(),
      client,
    });
    expect(result.concepts[0]?.mentions_with_provenance[0]).toMatchObject({
      source_path: 'notes/lease.md', source_slug: 'lease', extracted_at: '2026-08-20T00:00:00.000Z',
    });

    const invalid = clientFor([JSON.stringify({
      source_title: 'Bad', summary: 'Bad source', entities: [{ name: 'owner', type: 'owner', summary: 'x', mentions_in_source: ['not in source'] }], concepts: [],
    })]);
    await expect(mapNativeSource({
      source: { sourceId: 'bad', sourcePath: 'notes/bad.md', sourceBytes, extractedAt: '2026-08-20T00:00:00.000Z' },
      policy: policy(),
      client: invalid,
      maxBatches: 1,
    })).rejects.toMatchObject({ name: 'NativeMapProtocolError', code: 'invalid-provenance' });
  });

  it('is deterministic for the same source revision, policy, and provider output', async () => {
    const sourceBytes = new TextEncoder().encode(sourceText);
    const make = () => mapNativeSource({
      source: { sourceId: 'source-lease-1', sourcePath: 'notes/lease.md', sourceBytes: new Uint8Array(sourceBytes), extractedAt: '2026-08-20T00:00:00.000Z' },
      policy: policy(),
      client: clientFor([firstResponse(), '{"entities":[],"concepts":[]}']),
    });
    const left = await make();
    const right = await make();
    expect(right.irSha256).toBe(left.irSha256);
    expect(right.artifacts.map(artifact => artifact.artifactId)).toEqual(left.artifacts.map(artifact => artifact.artifactId));
    expect(right.artifacts).toEqual(left.artifacts);
  });

  it('deep-freezes the policy and does not call an injected provider for blank sources', async () => {
    const frozenPolicy = policy();
    expect(Object.isFrozen(frozenPolicy)).toBe(true);
    expect(Object.isFrozen(frozenPolicy.settings)).toBe(true);
    expect(Object.isFrozen(frozenPolicy.entityTags)).toBe(true);
    const client = clientFor(['{"entities":[],"concepts":[]}']);
    await expect(mapNativeSource({
      source: { sourceId: 'blank', sourcePath: 'notes/blank.md', sourceBytes: new TextEncoder().encode('---\ntags: []\n---\n') },
      policy: frozenPolicy,
      client,
      maxBatches: 1,
    })).rejects.toMatchObject({ name: 'NativeMapProtocolError', code: 'blank-source' });
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the frozen policy vocabulary disagrees with native settings', () => {
    expect(() => createNativeMapPolicy({
      settings,
      entityTags: ['person'],
      conceptTags: ['procedure', 'control'],
    })).toThrow(NativeMapProtocolError);
  });

  it('uses the native repair callback and SourceAnalyzer-style batch coercion', async () => {
    const calls: Array<Parameters<NativeMapClient['createMessage']>[0]> = [];
    const repaired = JSON.stringify({
      source_title: 'Lease workflow',
      summary: 'The source describes a lease workflow.',
      // The null member is the kind of harmless irregularity that native
      // normalizeBatchResponse filters before extracting the valid item.
      entities: [null, {
        name: 'lease',
        type: 'owner',
        summary: 'The owner approves the workflow.',
        mentions_in_source: ['The owner approves the lease workflow.'],
      }],
      // A scalar is coerced to an empty array, matching SourceAnalyzer.
      concepts: { malformed: true },
    });
    const client = clientFor([
      '{"source_title":"Lease workflow","summary":"bad","entities":[{"name":"owner","summary":NaN}],"concepts":[]}',
      repaired,
      '{"entities":[],"concepts":[]}',
    ], params => calls.push(params));

    const result = await mapNativeSource({
      source: { sourceId: 'repair-1', sourcePath: 'notes/lease.md', sourceBytes: new TextEncoder().encode(sourceText) },
      policy: policy(),
      client,
      maxBatches: 1,
    });

    expect(result.entities.map(item => item.name)).toEqual(['lease']);
    expect(calls.map(call => call.task)).toEqual(['extract', 'extract-retry']);
    expect(calls[1]?.messages[0]?.content).toContain('Fix the following malformed JSON');
  });

  it('retries a first-batch placeholder once, then accepts the completed response', async () => {
    const calls: Array<Parameters<NativeMapClient['createMessage']>[0]> = [];
    const client = clientFor([
      '{"": ""}',
      JSON.stringify({
        source_title: 'Lease',
        summary: 'A lease workflow.',
        entities: [{ name: 'lease', type: 'owner', summary: 'The lease.', mentions_in_source: [] }],
        concepts: [],
      }),
    ], params => calls.push(params));
    const result = await mapNativeSource({
      source: { sourceId: 'placeholder-1', sourcePath: 'notes/lease.md', sourceBytes: new TextEncoder().encode(sourceText) },
      policy: policy(),
      client,
      maxBatches: 1,
    });
    expect(result.entities.map(item => item.name)).toEqual(['lease']);
    expect(calls).toHaveLength(2);
  });

  it('applies native convergence rules instead of exhausting every configured round', async () => {
    const longSource = `${sourceText}\n${'The owner follows the lease workflow. '.repeat(180)}`;
    const makeItem = (name: string) => ({ name, type: 'owner', summary: name, mentions_in_source: [] });
    const calls: Array<Parameters<NativeMapClient['createMessage']>[0]> = [];
    const client = clientFor([
      JSON.stringify({ source_title: 'Lease-workflow', summary: 'Summary.', entities: [makeItem('Lease-workflow')], concepts: [] }),
      JSON.stringify({ entities: [makeItem('Owner')], concepts: [] }),
      JSON.stringify({ entities: [makeItem('Vendor')], concepts: [] }),
      JSON.stringify({ entities: [makeItem('System')], concepts: [] }),
    ], params => calls.push(params));

    const result = await mapNativeSource({
      source: { sourceId: 'convergence-1', sourcePath: 'notes/Lease-workflow.md', sourceBytes: new TextEncoder().encode(longSource) },
      policy: policy({ extractionGranularity: 'standard', tagVocabularyMode: 'default' }),
      client,
      maxBatches: 4,
    });

    expect(result.entities.map(item => item.name)).toEqual(['Lease-workflow', 'Owner', 'Vendor']);
    expect(calls.filter(call => call.task === 'extract')).toHaveLength(3);
  });

  it('replaces LLM related_pages with deterministic catalog matches when a catalog is supplied', async () => {
    const existingPages: readonly NativeMapExistingPage[] = [
      { title: 'Lease Control', aliases: ['control procedure'] },
      { title: 'Unrelated page' },
    ];
    const result = await mapNativeSource({
      source: { sourceId: 'related-1', sourcePath: 'notes/lease.md', sourceBytes: new TextEncoder().encode(sourceText) },
      policy: policy(),
      client: clientFor([firstResponse(), '{"entities":[],"concepts":[]}']),
      existingPages,
      maxBatches: 1,
    });
    expect(result.related.filter(item => item.pageType === 'unknown').map(item => item.label)).toEqual(['Lease Control']);
  });

  it('adds the source filename lemma only after deterministic matching and classifies it safely', async () => {
    const client = clientFor([
      JSON.stringify({
        source_title: 'Model supplied title',
        summary: 'The source summary is used for the missing lemma.',
        entities: [{ name: 'owner', type: 'owner', summary: 'Owner.', mentions_in_source: [] }],
        concepts: [],
        related_pages: ['LLM fabricated page'],
      }),
      '{"kind":"concept"}',
    ]);
    const result = await mapNativeSource({
      source: { sourceId: 'lemma-1', sourcePath: 'notes/lease.md', sourceBytes: new TextEncoder().encode(sourceText) },
      policy: policy(),
      client,
      existingPages: [{ title: 'Owner' }],
      maxBatches: 1,
    });

    expect(result.entities.map(item => item.name)).toEqual(['owner']);
    expect(result.concepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'lease', type: 'procedure', summary: 'The source summary is used for the missing lemma.', mentions_in_source: [], mentions_with_provenance: [] }),
    ]));
    expect(result.related.filter(item => item.pageType === 'unknown').map(item => item.label)).toEqual(['Owner']);
  });
});
