import { describe, expect, it, vi } from 'vitest';

import {
  createNativeMapPolicy,
  mapNativeSource,
  NativeMapProtocolError,
  type NativeMapClient,
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
});
