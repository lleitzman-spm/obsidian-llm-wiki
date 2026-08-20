import { describe, expect, it } from 'vitest';

import { compareNativeCandidate } from '../../../../../tools/llm-wiki-cli/src/headless/comparison';
import type { ContractSemanticProjection } from '../../../../../tools/llm-wiki-cli/src/headless/provenance/types';

function projection(options: {
  readonly claimId?: string;
  readonly evidenceId?: string;
  readonly disposition?: string;
  readonly tags?: string[];
  readonly qualifying?: boolean;
  readonly sourcePaths?: string[];
  readonly extraClaim?: boolean;
} = {}): ContractSemanticProjection {
  const claimId = options.claimId ?? 'claim-1';
  const evidenceId = options.evidenceId ?? 'evidence-1';
  const sourcePaths = options.sourcePaths ?? ['agent-operations/a.md', 'agent-operations/b.md', 'agent-operations/c.md'];
  const nodes: ContractSemanticProjection['nodes'] = [
    ...sourcePaths.map((path, index) => ({ id: `source-${index}`, type: 'source' as const, data: { normalizedPath: path } })),
    { id: 'key-1', type: 'canonical-key', data: { pageType: 'entity', normalizedLabel: 'alpha', normalizationVersion: 'v1' } },
    { id: claimId, type: 'claim', data: { subjectKey: { page_type: 'entity', normalized_label: 'alpha' }, predicate: 'statement', object: 'Alpha is maintained.', disposition: options.disposition ?? 'evidenced', ...(options.tags ? { custom_tags: options.tags } : {}) } },
    { id: 'statement-1', type: 'page-statement', data: { canonicalKeyId: 'key-1', sectionPath: ['Summary'], statementKind: 'paragraph', ordinal: 0, canonicalTextHash: 'text-1' } },
  ];
  if (options.extraClaim) nodes.push({ id: 'claim-extra', type: 'claim', data: { disposition: 'evidenced' } });
  const edges: ContractSemanticProjection['edges'] = [
    ...sourcePaths.map((_, index) => ({ id: `edge-source-${index}`, type: 'evidences' as const, source_id: `source-${index}`, target_id: claimId, data: { evidence_ids: [evidenceId] } })),
    { id: 'edge-render', type: 'renders', source_id: claimId, target_id: 'statement-1', data: { render_role: options.qualifying ? 'qualifies' : 'supports' } },
  ];
  return {
    schema_version: 'semantic-projection/v1', run_id: 'run-1',
    parser: { version: 'projection-parser/v1', source_sha256: 'a', grammar_sha256: 'b', unicode_sha256: 'c', boilerplate_policy_sha256: 'd' },
    nodes, edges,
  };
}

describe('native-vs-candidate semantic comparator', () => {
  it('passes a complete 3/3 agent-operations projection with exact grounding and claims', () => {
    const result = compareNativeCandidate({
      native: projection(), candidate: projection(),
      maintainedSources: [
        { normalizedPath: 'agent-operations/a.md' },
        { normalizedPath: 'agent-operations/b.md' },
        { normalizedPath: 'agent-operations/c.md' },
      ], expectedReach: 3,
    });
    expect(result.accepted).toBe(true);
    expect(result.sourceReach).toMatchObject({ passed: true, observed: 3, expected: 3 });
    expect(result.grounding).toMatchObject({ passed: true, nativeGroundedClaims: 1, candidateGroundedClaims: 1 });
    expect(result.nativeClaimRetention.passed).toBe(true);
    expect(result.exactClaimData.passed).toBe(true);
    expect(result.materialDeltas).toEqual([]);
  });

  it('fails closed on missing reach, native claim loss, and ungrounded candidate claims', () => {
    const candidate = projection({ sourcePaths: ['agent-operations/a.md', 'agent-operations/b.md'], claimId: 'candidate-claim', evidenceId: '' });
    const result = compareNativeCandidate({ native: projection(), candidate, expectedReach: 3 });
    expect(result.accepted).toBe(false);
    expect(result.sourceReach.missingSourcePaths).toContain('agent-operations/c.md');
    expect(result.nativeClaimRetention.missingClaimIds).toContain('claim-1');
    expect(result.grounding.passed).toBe(false);
  });

  it('compares exact evidence IDs and dispositions, rather than only counting claims', () => {
    const result = compareNativeCandidate({
      native: projection(), candidate: projection({ evidenceId: 'evidence-2', disposition: 'asserted' }),
    });
    expect(result.accepted).toBe(false);
    expect(result.exactClaimData.evidenceMismatches).toEqual(['claim-1']);
    expect(result.exactClaimData.dispositionMismatches).toEqual(['claim-1']);
    expect(result.materialDeltas.some(delta => delta.materiality === 'provenance-change')).toBe(true);
    expect(result.materialDeltas.some(delta => delta.materiality === 'disposition-change')).toBe(true);
  });

  it('treats aliases, tags, qualifications, and graph edges as semantic surface', () => {
    const native = projection({ tags: ['owner'], qualifying: false });
    const candidate = projection({ tags: ['resident'], qualifying: true });
    native.nodes.push({ id: 'alias-1', type: 'alias', data: { normalizedAliasLabel: 'a', targetPageType: 'entity', custom_tags: ['owner'] } });
    candidate.nodes.push({ id: 'alias-2', type: 'alias', data: { normalizedAliasLabel: 'a', targetPageType: 'entity', custom_tags: ['resident'] } });
    const result = compareNativeCandidate({ native, candidate });
    expect(result.accepted).toBe(false);
    expect(result.aliases.passed).toBe(false);
    expect(result.customTags.passed).toBe(false);
    expect(result.qualifications.passed).toBe(false);
    expect(result.graphEdges.passed).toBe(false);
  });

  it('reports missing and extra filesystem pages when an explicit page census is supplied', () => {
    const result = compareNativeCandidate({
      native: projection(), candidate: projection(),
      nativePages: [{ id: 'page-a' }, { id: 'page-b' }], candidatePages: [{ id: 'page-a' }, { id: 'page-c' }],
    });
    expect(result.pages.missingIds).toEqual(['page-b']);
    expect(result.pages.extraIds).toEqual(['page-c']);
    expect(result.missingPages).toEqual(['page-b']);
    expect(result.extraPages).toEqual(['page-c']);
    expect(result.accepted).toBe(false);
  });

  it('records material additions but never accepts them, even when a disposition is explicit', () => {
    const result = compareNativeCandidate({ native: projection(), candidate: projection({ extraClaim: true }) });
    expect(result.nativeClaimRetention.passed).toBe(false);
    expect(result.materiality.passed).toBe(false);
    expect(result.materialDeltas.some(delta => delta.materiality === 'semantic-addition' && delta.explicitDisposition)).toBe(true);
    expect(result.accepted).toBe(false);
  });
});
