import { createHash } from 'node:crypto';

import { sourceIdentityDigest } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';

import {
  ADJUDICATION_DECISIONS,
  ADJUDICATION_RATIONALES,
  ALIAS_STATES,
  DISPOSITIONS,
  EVIDENCE_KINDS,
  EVIDENCE_REASONS,
  MATERIALITIES,
  canonicalize,
  claimId,
  createContractSemanticProjection,
  createSemanticProjection,
  evidenceId,
  isEvidenceEligible,
  isLegalProjectionEdge,
  isValidDispositionTransition,
  pageStatementId,
  projectionEdgeId,
  semanticProjectionJson,
  sourceIdentity,
  sourceNodeId,
} from '../../../../../tools/llm-wiki-cli/src/headless/provenance';

describe('headless provenance primitives', () => {
  it('serializes objects with JCS-like sorted keys and no whitespace', () => {
    expect(canonicalize({ z: 1, a: { y: true, x: 'ok' }, n: [3, 2] })).toBe(
      '{"a":{"x":"ok","y":true},"n":[3,2],"z":1}',
    );
    expect(canonicalize(-0)).toBe('0');
  });

  it('uses the normative NUL-terminated domain before canonical bytes', () => {
    const input = {
      authorityTree: 'tree',
      normalizedPath: 'wiki/a.md',
      byteHash: 'a'.repeat(64),
    };
    const expected = createHash('sha256')
      .update(Buffer.from('spm-brain/source-identity/v1\0', 'utf8'))
      .update(Buffer.from(canonicalize({
        authority_tree: 'tree', normalized_path: 'wiki/a.md', byte_hash: 'a'.repeat(64),
      }), 'utf8'))
      .digest('hex');
    expect(sourceIdentity(input)).toBe(expected);
    expect(sourceIdentity(input)).not.toBe(sourceNodeId(input));
  });

  it('matches preflight source identity and rejects non-canonical byte hashes', () => {
    const byteHash = 'a'.repeat(64);
    const input = { authorityTree: 'tree', normalizedPath: 'wiki/a.md', byteHash };
    expect(sourceIdentity(input)).toBe(sourceIdentityDigest('tree', 'wiki/a.md', byteHash));
    expect(() => sourceIdentity({ ...input, byteHash: byteHash.toUpperCase() })).toThrow(/lowercase|SHA-256/i);
    expect(() => sourceIdentity({ ...input, byteHash: 'a'.repeat(63) })).toThrow(/64|SHA-256/i);
    expect(() => sourceIdentity({ ...input, byteHash: 'g'.repeat(64) })).toThrow(/lowercase|SHA-256/i);
  });

  it('normalizes duplicate evidence IDs for run-independent claim identity', () => {
    const base = {
      subjectKey: { pageType: 'concept', normalizedLabel: 'same label' },
      predicate: 'defines-scope/v1',
      object: { value: 'x', type: 'string' },
      evidenceIds: ['b', 'a', 'a'],
    };
    expect(claimId(base)).toBe(claimId({ ...base, evidenceIds: ['a', 'b'] }));
  });

  it('rejects invalid closed vocabularies and enforces the eligibility matrix', () => {
    expect(EVIDENCE_KINDS).toContain('quote');
    expect(EVIDENCE_REASONS).toContain('defines-control');
    expect(isEvidenceEligible('quote', 'direct-quote')).toBe(true);
    expect(isEvidenceEligible('heading', 'defines-relationship')).toBe(false);
    expect(isEvidenceEligible('code-block', 'defines-metric')).toBe(true);
    expect(isEvidenceEligible('frontmatter-field', 'defines-status', { frontmatterKeyRecognized: false })).toBe(false);
    expect(() => evidenceId({
      kind: 'not-a-kind' as never,
      reasonCode: 'direct-quote',
      authorityTree: 'tree', normalizedPath: 'a',
      originalSourceHash: 'a', canonicalSourceHash: 'b',
      byteRange: { start: 0, end: 1 }, exactByteHash: 'c', normalizationVersion: 'v1',
    })).toThrow(/evidence kind/i);
  });

  it('keeps disposition transitions monotonic and guarded', () => {
    expect(DISPOSITIONS).toEqual(['unknown', 'asserted', 'evidenced', 'contested']);
    expect(isValidDispositionTransition('unknown', 'asserted')).toBe(false);
    expect(isValidDispositionTransition('unknown', 'asserted', { exactSourceEvidence: true })).toBe(true);
    expect(isValidDispositionTransition('asserted', 'evidenced', { eligibleEvidence: true })).toBe(true);
    expect(isValidDispositionTransition('evidenced', 'asserted')).toBe(false);
    expect(isValidDispositionTransition('contested', 'evidenced', { eligibleEvidence: true })).toBe(false);
  });

  it('builds sorted semantic projections and legal typed edges deterministically', () => {
    const source = {
      nodeType: 'source' as const,
      id: sourceNodeId({ authorityTree: 'tree', normalizedPath: 'wiki/a.md', byteHash: 'a'.repeat(64) }),
      authorityTree: 'tree', normalizedPath: 'wiki/a.md', byteHash: 'a'.repeat(64),
    };
    const claim = {
      nodeType: 'claim' as const,
      id: claimId({ subjectKey: 'concept:alpha', predicate: 'defines-scope/v1', object: 'x', evidenceIds: ['e1'] }),
      subjectKey: 'concept:alpha', predicate: 'defines-scope/v1', object: 'x', disposition: 'evidenced' as const,
    };
    const statement = {
      nodeType: 'page-statement' as const,
      id: pageStatementId({ canonicalKeyId: 'k1', sectionPath: ['Summary'], statementKind: 'paragraph', ordinal: 0, canonicalTextHash: 'h1' }),
      canonicalKeyId: 'k1', sectionPath: ['Summary'], statementKind: 'paragraph' as const, ordinal: 0, canonicalTextHash: 'h1',
    };
    const edge = {
      edgeKind: 'renders' as const,
      id: projectionEdgeId({ edgeKind: 'renders', sourceId: claim.id, targetId: statement.id, payload: { render_role: 'supports' } }),
      sourceId: claim.id, targetId: statement.id, payload: { render_role: 'supports' as const },
    };
    expect(isLegalProjectionEdge(edge, [claim, statement])).toBe(true);
    expect(isLegalProjectionEdge({ ...edge, sourceId: source.id }, [source, statement])).toBe(false);
    const projection = createSemanticProjection({ nodes: [statement, claim, source], edges: [edge] });
    expect(projection.nodes.map(node => node.id)).toEqual([...projection.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(node => node.id));
    expect(JSON.parse(semanticProjectionJson(projection))).toEqual(projection);
    const contract = createContractSemanticProjection({
      runId: 'run-1',
      parser: { version: 'projection-parser/v1', source_sha256: 'a', grammar_sha256: 'b', unicode_sha256: 'c', boilerplate_policy_sha256: 'd' },
      nodes: [statement, claim, source],
      edges: [edge],
    });
    expect(contract.schema_version).toBe('semantic-projection/v1');
    expect(contract.nodes.every(node => 'type' in node && 'data' in node)).toBe(true);
  });

  it('exposes the remaining v1 vocabularies as closed tuples', () => {
    expect(ALIAS_STATES).toEqual(['speculative', 'grounded', 'adjudicated']);
    expect(ADJUDICATION_DECISIONS).toContain('preserve-both');
    expect(ADJUDICATION_RATIONALES).toContain('insufficient-evidence');
    expect(MATERIALITIES).toContain('identity-change');
  });
});
import { describe, expect, it } from 'vitest';
