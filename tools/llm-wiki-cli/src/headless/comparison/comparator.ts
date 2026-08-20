import { createHash } from 'node:crypto';

import { canonicalize, normalizePath, sortedUnique } from '../provenance/canonical';
import { isMaterialityAllowed } from '../provenance/rules';
import { isDisposition } from '../provenance/vocab';
import type { ContractSemanticProjection, Materiality, ProjectionNode, SemanticProjection } from '../provenance/types';
import type {
  ComparisonDelta,
  ComparisonGate,
  ComparisonProjection,
  PageRecord,
  SemanticComparisonInput,
  SemanticComparisonResult,
} from './types';

interface FlatNode {
  readonly id: string;
  readonly type: ProjectionNode['nodeType'];
  readonly data: Record<string, unknown>;
}

interface FlatEdge {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly data: Record<string, unknown>;
}

interface FlatProjection {
  readonly nodes: readonly FlatNode[];
  readonly edges: readonly FlatEdge[];
}

const TAG_KEYS = [
  'tags', 'custom_tags', 'customTags', 'entity_tags', 'entityTags', 'concept_tags', 'conceptTags', 'subtype_tags', 'subtypeTags',
] as const;

/**
 * Compare the complete semantic surface of native and candidate projections.
 *
 * This is deliberately a pure, read-only function. It does not infer that a
 * missing claim is harmless, and it never authorizes a transaction. A caller
 * must treat `accepted === false` as a hard stop before candidate writes.
 */
export function compareNativeCandidate(input: SemanticComparisonInput): SemanticComparisonResult {
  const native = flattenProjection(input.native);
  const candidate = flattenProjection(input.candidate);
  const maintained = maintainedSources(input, native);
  const nativeSources = sourcePaths(native);
  const candidateSources = sourcePaths(candidate);
  const reached = maintained.filter(path => candidateSources.has(path));
  const missingSources = maintained.filter(path => !candidateSources.has(path));
  const extraSources = [...candidateSources].filter(path => !maintained.includes(path)).sort();
  const reachExpected = input.expectedReach ?? maintained.length;
  const sourceReach = {
    ...gate(reached.length === reachExpected && missingSources.length === 0 && extraSources.length === 0, reached.length, reachExpected, [
      ...missingSources.map(path => `candidate did not reach maintained source: ${path}`),
      ...extraSources.map(path => `candidate reached unmaintained source: ${path}`),
      ...(reached.length !== reachExpected ? [`source reach was ${reached.length}/${reachExpected}`] : []),
    ]),
    maintainedSourcePaths: maintained,
    reachedSourcePaths: reached,
    missingSourcePaths: missingSources,
    extraSourcePaths: extraSources,
  };

  const nativeClaims = nodesOf(native, 'claim');
  const candidateClaims = nodesOf(candidate, 'claim');
  const nativeClaimIds = ids(nativeClaims);
  const candidateClaimIds = ids(candidateClaims);
  const nativeClaimSet = new Set(nativeClaimIds);
  const candidateClaimSet = new Set(candidateClaimIds);
  const missingClaimIds = nativeClaimIds.filter(id => !candidateClaimSet.has(id));
  const extraClaimIds = candidateClaimIds.filter(id => !nativeClaimSet.has(id));
  const nativeGroundedClaims = nativeClaims.filter(claim => evidenceIds(native, claim.id).length > 0).length;
  const candidateGroundedClaims = candidateClaims.filter(claim => evidenceIds(candidate, claim.id).length > 0).length;
  const grounding = {
    ...gate(nativeGroundedClaims === nativeClaims.length && candidateGroundedClaims === candidateClaims.length,
      candidateGroundedClaims, candidateClaims.length, [
        ...(nativeGroundedClaims !== nativeClaims.length ? [`native grounding is ${nativeGroundedClaims}/${nativeClaims.length}`] : []),
        ...(candidateGroundedClaims !== candidateClaims.length ? [`candidate grounding is ${candidateGroundedClaims}/${candidateClaims.length}`] : []),
      ]),
    nativeGroundedClaims, nativeClaims: nativeClaims.length, candidateGroundedClaims, candidateClaims: candidateClaims.length,
  };
  const nativeClaimRetention = {
    ...gate(missingClaimIds.length === 0 && extraClaimIds.length === 0, nativeClaimIds.length - missingClaimIds.length, nativeClaimIds.length, [
      ...missingClaimIds.map(id => `candidate dropped native claim: ${id}`),
      ...extraClaimIds.map(id => `candidate added claim without native counterpart: ${id}`),
    ]),
    nativeClaimIds, candidateClaimIds, missingClaimIds, extraClaimIds,
  };

  const evidenceMismatches: string[] = [];
  const dispositionMismatches: string[] = [];
  const claimDataMismatches: string[] = [];
  for (const id of nativeClaimIds) {
    const left = nativeClaims.find(node => node.id === id);
    const right = candidateClaims.find(node => node.id === id);
    if (!left || !right) continue;
    if (canonicalize(evidenceIds(native, id)) !== canonicalize(evidenceIds(candidate, id))) evidenceMismatches.push(id);
    if (claimDisposition(left) !== claimDisposition(right)) dispositionMismatches.push(id);
    if (canonicalize(left.data) !== canonicalize(right.data)) claimDataMismatches.push(id);
  }
  const exactClaimData = {
    ...gate(evidenceMismatches.length === 0 && dispositionMismatches.length === 0 && claimDataMismatches.length === 0,
      nativeClaimIds.length - evidenceMismatches.length - dispositionMismatches.length - claimDataMismatches.length, nativeClaimIds.length, [
        ...evidenceMismatches.map(id => `claim evidence IDs changed: ${id}`),
        ...dispositionMismatches.map(id => `claim disposition changed: ${id}`),
        ...claimDataMismatches.map(id => `claim data changed: ${id}`),
      ]),
    evidenceMismatches, dispositionMismatches, claimDataMismatches,
  };

  const aliases = compareNodeSet(native, candidate, 'alias', 'alias');
  const canonicalKeys = compareNodeSet(native, candidate, 'canonical-key', 'canonical key');
  const pageStatements = compareNodeSet(native, candidate, 'page-statement', 'page statement');
  const graphEdges = compareEdgeSet(native, candidate);
  const customTags = compareTags(native, candidate, input.nativePages, input.candidatePages);
  const qualifications = compareQualifications(native, candidate, input.nativePages, input.candidatePages);
  const pages = comparePages(native, candidate, input.nativePages, input.candidatePages);

  const materialDeltas = buildDeltas({
    native, candidate, missingClaimIds, extraClaimIds, evidenceMismatches, dispositionMismatches, claimDataMismatches,
    aliases, canonicalKeys, pageStatements, pages, graphEdges, customTags, qualifications,
  });
  const materiality = {
    ...gate(materialDeltas.length === 0, 0, 0, materialDeltas.map(delta => delta.issue)),
    deltas: materialDeltas,
  };
  const allGates: readonly ComparisonGate[] = [sourceReach, grounding, nativeClaimRetention, exactClaimData, aliases,
    customTags, canonicalKeys, pageStatements, pages, graphEdges, qualifications, materiality];
  return {
    accepted: allGates.every(item => item.passed), sourceReach, grounding, nativeClaimRetention, exactClaimData,
    aliases, customTags, canonicalKeys, pageStatements, pages, graphEdges, qualifications, materiality,
    missingPages: pages.missingIds, extraPages: pages.extraIds, materialDeltas,
  };
}

export const compareSemanticProjections = compareNativeCandidate;

function gate(passed: boolean, observed: number, expected: number, issues: readonly string[]): ComparisonGate {
  return { passed, observed, expected, issues: [...issues] };
}

function flattenProjection(projection: ComparisonProjection): FlatProjection {
  if ('schema_version' in projection) {
    return {
      nodes: projection.nodes.map(node => ({ id: node.id, type: node.type, data: { ...node.data } })),
      edges: projection.edges.map(edge => ({ id: edge.id, type: edge.type, sourceId: edge.source_id, targetId: edge.target_id, data: { ...edge.data } })),
    };
  }
  return {
    nodes: projection.nodes.map(node => {
      const { nodeType, id, ...data } = node;
      return { id, type: nodeType, data: { ...data } };
    }),
    edges: projection.edges.map(edge => ({ id: edge.id, type: edge.edgeKind, sourceId: edge.sourceId, targetId: edge.targetId, data: { ...edge.payload } })),
  };
}

function maintainedSources(input: SemanticComparisonInput, native: FlatProjection): string[] {
  const explicit = input.maintainedSources?.map(source => safePath(source.normalizedPath))
    ?? input.requiredSourcePaths?.map(safePath);
  if (explicit) return sortedUnique(explicit);
  return [...sourcePaths(native)].sort();
}

function sourcePaths(projection: FlatProjection): Set<string> {
  return new Set(nodesOf(projection, 'source').map(node => {
    const path = stringField(node.data, 'normalizedPath', 'normalized_path', 'path', 'sourcePath', 'source_path');
    return path ? safePath(path) : node.id;
  }));
}

function safePath(path: string): string {
  try { return normalizePath(path); } catch { return path.replaceAll('\\', '/'); }
}

function nodesOf(projection: FlatProjection, type: FlatNode['type']): FlatNode[] {
  return projection.nodes.filter(node => node.type === type).sort((left, right) => left.id.localeCompare(right.id));
}

function ids(nodes: readonly FlatNode[]): string[] { return nodes.map(node => node.id).sort(); }

function stringField(data: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof data[key] === 'string' && data[key]) return data[key] as string;
  return undefined;
}

function arrayField(data: Record<string, unknown>, ...keys: readonly string[]): unknown[] {
  for (const key of keys) if (Array.isArray(data[key])) return data[key] as unknown[];
  return [];
}

function stringArrayField(data: Record<string, unknown>, ...keys: readonly string[]): string[] {
  return sortedUnique(arrayField(data, ...keys).filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function claimDisposition(node: FlatNode): string | undefined {
  const value = stringField(node.data, 'disposition');
  return value && isDisposition(value) ? value : value;
}

function evidenceIds(projection: FlatProjection, claimId: string): string[] {
  const claim = projection.nodes.find(node => node.id === claimId && node.type === 'claim');
  const idsFromNode = claim ? stringArrayField(claim.data, 'evidence_ids', 'evidenceIds', 'evidence') : [];
  const idsFromEdges = projection.edges.filter(edge => edge.type === 'evidences' && edge.targetId === claimId)
    .flatMap(edge => stringArrayField(edge.data, 'evidence_ids', 'evidenceIds'));
  return sortedUnique([...idsFromNode, ...idsFromEdges]);
}

function compareNodeSet(native: FlatProjection, candidate: FlatProjection, type: FlatNode['type'], label: string): SemanticComparisonResult['aliases'] {
  const left = nodesOf(native, type).map(node => node.id);
  const right = nodesOf(candidate, type).map(node => node.id);
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const missingIds = left.filter(id => !rightSet.has(id));
  const extraIds = right.filter(id => !leftSet.has(id));
  const changed = left.filter(id => {
    const a = native.nodes.find(node => node.id === id && node.type === type);
    const b = candidate.nodes.find(node => node.id === id && node.type === type);
    return Boolean(a && b && canonicalize(a.data) !== canonicalize(b.data));
  });
  return {
    ...gate(missingIds.length === 0 && extraIds.length === 0 && changed.length === 0, left.length - missingIds.length - changed.length, left.length, [
      ...missingIds.map(id => `${label} missing: ${id}`), ...extraIds.map(id => `${label} extra: ${id}`), ...changed.map(id => `${label} changed: ${id}`),
    ]),
    missingIds: [...missingIds, ...changed], extraIds,
  };
}

function compareEdgeSet(native: FlatProjection, candidate: FlatProjection): SemanticComparisonResult['graphEdges'] {
  const left = new Map(native.edges.map(edge => [edge.id, edge]));
  const right = new Map(candidate.edges.map(edge => [edge.id, edge]));
  const missingIds = [...left.keys()].filter(id => !right.has(id) || canonicalize(left.get(id)) !== canonicalize(right.get(id))).sort();
  const extraIds = [...right.keys()].filter(id => !left.has(id)).sort();
  return {
    ...gate(missingIds.length === 0 && extraIds.length === 0, left.size - missingIds.length, left.size, [
      ...missingIds.map(id => `graph edge missing or changed: ${id}`), ...extraIds.map(id => `graph edge extra: ${id}`),
    ]),
    missingIds, extraIds,
  };
}

function tagEntries(projection: FlatProjection, pages?: readonly PageRecord[]): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const node of projection.nodes) {
    const values = TAG_KEYS.flatMap(key => stringArrayField(node.data, key));
    if (values.length) entries.set(`${node.type}:${node.id}`, sortedUnique(values));
  }
  for (const page of pages ?? []) if (page.customTags?.length) entries.set(`page:${page.id}`, sortedUnique(page.customTags.filter(tag => typeof tag === 'string')));
  return entries;
}

function compareTags(native: FlatProjection, candidate: FlatProjection, nativePages?: readonly PageRecord[], candidatePages?: readonly PageRecord[]): SemanticComparisonResult['customTags'] {
  const left = tagEntries(native, nativePages);
  const right = tagEntries(candidate, candidatePages);
  const keys = sortedUnique([...left.keys(), ...right.keys()]);
  const mismatches = keys.filter(key => canonicalize(left.get(key) ?? []) !== canonicalize(right.get(key) ?? []));
  return { ...gate(mismatches.length === 0, keys.length - mismatches.length, keys.length, mismatches.map(key => `custom tags changed: ${key}`)), mismatches };
}

function qualificationEntries(projection: FlatProjection, pages?: readonly PageRecord[]): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const edge of projection.edges.filter(edge => edge.type === 'renders' && edge.data.render_role === 'qualifies')) entries.set(edge.id, edge.data);
  for (const node of projection.nodes) for (const key of ['qualifications', 'qualification']) {
    if (node.data[key] !== undefined) entries.set(`${node.id}:${key}`, node.data[key]);
  }
  for (const page of pages ?? []) if (page.qualifications !== undefined) entries.set(`page:${page.id}`, page.qualifications);
  return entries;
}

function compareQualifications(native: FlatProjection, candidate: FlatProjection, nativePages?: readonly PageRecord[], candidatePages?: readonly PageRecord[]): SemanticComparisonResult['qualifications'] {
  const left = qualificationEntries(native, nativePages);
  const right = qualificationEntries(candidate, candidatePages);
  const keys = sortedUnique([...left.keys(), ...right.keys()]);
  const mismatches = keys.filter(key => canonicalize(left.get(key) ?? null) !== canonicalize(right.get(key) ?? null));
  return { ...gate(mismatches.length === 0, keys.length - mismatches.length, keys.length, mismatches.map(key => `qualification changed: ${key}`)), mismatches };
}

function pageIds(projection: FlatProjection, pages?: readonly PageRecord[]): string[] {
  if (pages) return pages.map(page => page.id).sort();
  return nodesOf(projection, 'canonical-key').map(node => node.id);
}

function comparePages(native: FlatProjection, candidate: FlatProjection, nativePages?: readonly PageRecord[], candidatePages?: readonly PageRecord[]): SemanticComparisonResult['pages'] {
  const left = pageIds(native, nativePages);
  const right = pageIds(candidate, candidatePages);
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const missingIds = left.filter(id => !rightSet.has(id));
  const extraIds = right.filter(id => !leftSet.has(id));
  return { ...gate(missingIds.length === 0 && extraIds.length === 0, left.length - missingIds.length, left.length, [
    ...missingIds.map(id => `page missing: ${id}`), ...extraIds.map(id => `page extra: ${id}`),
  ]), missingIds, extraIds };
}

interface DeltaInput {
  readonly native: FlatProjection;
  readonly candidate: FlatProjection;
  readonly missingClaimIds: readonly string[];
  readonly extraClaimIds: readonly string[];
  readonly evidenceMismatches: readonly string[];
  readonly dispositionMismatches: readonly string[];
  readonly claimDataMismatches: readonly string[];
  readonly aliases: SemanticComparisonResult['aliases'];
  readonly canonicalKeys: SemanticComparisonResult['canonicalKeys'];
  readonly pageStatements: SemanticComparisonResult['pageStatements'];
  readonly pages: SemanticComparisonResult['pages'];
  readonly graphEdges: SemanticComparisonResult['graphEdges'];
  readonly customTags: SemanticComparisonResult['customTags'];
  readonly qualifications: SemanticComparisonResult['qualifications'];
}

function buildDeltas(input: DeltaInput): ComparisonDelta[] {
  const deltas: ComparisonDelta[] = [];
  const add = (materiality: Materiality, subject: string, nativeValue: unknown, candidateValue: unknown, issue: string, node?: FlatNode): void => {
    const explicit = explicitDisposition(input.candidate, node?.id, subject);
    const adjudicationId = explicit.adjudicationId;
    deltas.push({
      id: createDeltaId(materiality, subject, nativeValue, candidateValue), materiality, subject,
      nativeValue, candidateValue, explicitDisposition: explicit.value, disposition: explicit.disposition,
      adjudicationId, issue: explicit.value ? issue : `${issue}; material delta lacks explicit disposition/adjudication`,
    });
  };
  for (const id of input.missingClaimIds) add('semantic-removal', `claim:${id}`, input.native.nodes.find(node => node.id === id)?.data, undefined, `native claim removed: ${id}`);
  for (const id of input.extraClaimIds) add('semantic-addition', `claim:${id}`, undefined, input.candidate.nodes.find(node => node.id === id)?.data, `candidate claim added: ${id}`, input.candidate.nodes.find(node => node.id === id));
  for (const id of input.evidenceMismatches) add('provenance-change', `claim-evidence:${id}`, evidenceIds(input.native, id), evidenceIds(input.candidate, id), `claim evidence changed: ${id}`);
  for (const id of input.dispositionMismatches) add('disposition-change', `claim-disposition:${id}`, input.native.nodes.find(node => node.id === id)?.data.disposition, input.candidate.nodes.find(node => node.id === id)?.data.disposition, `claim disposition changed: ${id}`, input.candidate.nodes.find(node => node.id === id));
  for (const id of input.claimDataMismatches) add('provenance-change', `claim-data:${id}`, input.native.nodes.find(node => node.id === id)?.data, input.candidate.nodes.find(node => node.id === id)?.data, `claim data changed: ${id}`, input.candidate.nodes.find(node => node.id === id));
  addNodeDeltas(input, deltas, 'alias', input.aliases, 'identity-change', 'alias');
  addNodeDeltas(input, deltas, 'canonical-key', input.canonicalKeys, 'identity-change', 'canonical key');
  addNodeDeltas(input, deltas, 'page-statement', input.pageStatements, 'semantic-removal', 'page statement');
  for (const id of input.pages.missingIds) add('semantic-removal', `page:${id}`, id, undefined, `page removed: ${id}`);
  for (const id of input.pages.extraIds) add('semantic-addition', `page:${id}`, undefined, id, `page added: ${id}`);
  for (const id of input.graphEdges.missingIds) add('semantic-removal', `edge:${id}`, id, undefined, `graph edge removed: ${id}`);
  for (const id of input.graphEdges.extraIds) add('semantic-addition', `edge:${id}`, undefined, id, `graph edge added: ${id}`);
  for (const key of input.customTags.mismatches) add('semantic-addition', `tags:${key}`, undefined, undefined, `custom tags changed: ${key}`);
  for (const key of input.qualifications.mismatches) add('qualification-change', `qualification:${key}`, undefined, undefined, `qualification changed: ${key}`);
  return dedupeDeltas(deltas);
}

function addNodeDeltas(input: DeltaInput, deltas: ComparisonDelta[], type: FlatNode['type'], result: { missingIds: readonly string[]; extraIds: readonly string[] }, materiality: Materiality, label: string): void {
  for (const id of result.missingIds) {
    const node = input.native.nodes.find(item => item.id === id && item.type === type);
    deltas.push(makeDelta(materiality, `${label}:${id}`, node?.data, undefined, `${label} removed: ${id}`, false));
  }
  for (const id of result.extraIds) {
    const node = input.candidate.nodes.find(item => item.id === id && item.type === type);
    deltas.push(makeDelta(materiality === 'semantic-removal' ? 'semantic-addition' : materiality, `${label}:${id}`, undefined, node?.data, `${label} added: ${id}`, explicitDisposition(input.candidate, id, `${label}:${id}`).value));
  }
}

function explicitDisposition(projection: FlatProjection, id: string | undefined, subject: string): { value: boolean; disposition?: string; adjudicationId?: string } {
  const node = id ? projection.nodes.find(item => item.id === id) : undefined;
  const disposition = node ? stringField(node.data, 'disposition') : undefined;
  const adjudicationId = node ? stringField(node.data, 'adjudication_id', 'adjudicationId') : undefined;
  const resolves = projection.edges.find(edge => edge.type === 'resolves' && edge.targetId === id);
  const resolvedBy = resolves ? resolves.sourceId : undefined;
  const adjudication = projection.nodes.find(item => item.type === 'adjudication' && (item.id === adjudicationId || item.id === resolvedBy));
  void subject;
  return { value: (Boolean(disposition && isDisposition(disposition) && disposition !== 'unknown') || Boolean(adjudication)), disposition, adjudicationId: adjudication?.id ?? adjudicationId };
}

function makeDelta(materiality: Materiality, subject: string, nativeValue: unknown, candidateValue: unknown, issue: string, explicit: boolean): ComparisonDelta {
  const allowed = isMaterialityAllowed(materiality, explicit);
  return {
    id: createDeltaId(materiality, subject, nativeValue, candidateValue), materiality, subject, nativeValue, candidateValue,
    explicitDisposition: explicit, issue: allowed ? issue : `${issue}; material delta lacks explicit disposition/adjudication`,
  };
}

function createDeltaId(materiality: Materiality, subject: string, nativeValue: unknown, candidateValue: unknown): string {
  return createHash('sha256').update(`spm-brain/comparison-delta/v1\0${canonicalize({ materiality, subject, nativeValue: nativeValue ?? null, candidateValue: candidateValue ?? null })}`).digest('hex');
}

function dedupeDeltas(deltas: readonly ComparisonDelta[]): ComparisonDelta[] {
  const seen = new Set<string>();
  return deltas.filter(delta => !seen.has(delta.id) && seen.add(delta.id)).sort((a, b) => a.id.localeCompare(b.id));
}
