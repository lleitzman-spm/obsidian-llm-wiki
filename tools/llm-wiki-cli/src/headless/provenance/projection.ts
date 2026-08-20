import { canonicalize, sortedUnique } from './canonical';
import { projectionEdgeId } from './ids';
import { PROJECTION_SCHEMA, isAdjudicationDecision } from './vocab';
import type {
  ContractSemanticProjection,
  ProjectionEdge,
  ProjectionEdgeKind,
  ProjectionNode,
  SemanticProjection,
} from './types';

type NodeType = ProjectionNode['nodeType'];

interface EdgeRule {
  source: NodeType;
  target: NodeType;
}

export const PROJECTION_EDGE_MATRIX: Readonly<Record<ProjectionEdgeKind, EdgeRule>> = Object.freeze({
  evidences: { source: 'source', target: 'claim' },
  renders: { source: 'claim', target: 'page-statement' },
  nominates: { source: 'alias', target: 'canonical-key' },
  contests: { source: 'claim', target: 'claim' },
  resolves: { source: 'adjudication', target: 'claim' },
});

export const EDGE_MATRIX = PROJECTION_EDGE_MATRIX;

export function isLegalProjectionEdge(
  edge: ProjectionEdge,
  nodes: readonly ProjectionNode[],
): boolean {
  const rule = PROJECTION_EDGE_MATRIX[edge.edgeKind];
  if (!rule || edge.sourceId === edge.targetId) return false;
  const source = nodes.find(node => node.id === edge.sourceId);
  const target = nodes.find(node => node.id === edge.targetId);
  if (!source || !target || source.nodeType !== rule.source || target.nodeType !== rule.target) return false;
  if (projectionEdgeId(edge) !== edge.id) return false;
  return isLegalPayload(edge.edgeKind, edge.payload);
}

export const isLegalEdge = isLegalProjectionEdge;

function isLegalPayload(kind: ProjectionEdgeKind, payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  switch (kind) {
    case 'evidences':
      return keys.length === 1 && keys[0] === 'evidence_ids' && isSortedUniqueStringArray(payload.evidence_ids);
    case 'renders':
      return keys.length === 1 && keys[0] === 'render_role'
        && (payload.render_role === 'supports' || payload.render_role === 'qualifies' || payload.render_role === 'contests');
    case 'nominates': {
      const hasEvidence = typeof payload.evidence_id === 'string' && payload.evidence_id.length > 0;
      const hasAdjudication = typeof payload.adjudication_id === 'string' && payload.adjudication_id.length > 0;
      const state = payload.alias_state;
      return keys.includes('alias_state') && (keys.includes('evidence_id') || keys.includes('adjudication_id'))
        && keys.length === 2 && (state === 'speculative' || state === 'grounded' || state === 'adjudicated')
        && (hasEvidence !== hasAdjudication)
        && (state === 'adjudicated' ? hasAdjudication : hasEvidence);
    }
    case 'contests':
      return keys.length === 1 && keys[0] === 'conflict_evidence_ids' && isSortedUniqueStringArray(payload.conflict_evidence_ids);
    case 'resolves':
      return keys.length === 2 && keys.includes('decision_code') && keys.includes('active_view')
        && isAdjudicationDecision(payload.decision_code)
        && typeof payload.active_view === 'boolean';
  }
}

function isSortedUniqueStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) return false;
  return JSON.stringify(value) === JSON.stringify(sortedUnique(value));
}

export interface ProjectionValidation {
  valid: boolean;
  errors: string[];
}

export function validateSemanticProjection(projection: SemanticProjection): ProjectionValidation {
  const errors: string[] = [];
  if (projection.schema !== PROJECTION_SCHEMA) errors.push(`schema must be ${PROJECTION_SCHEMA}`);
  const ids = new Set<string>();
  for (const node of projection.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node ID: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of projection.edges) {
    if (!isLegalProjectionEdge(edge, projection.nodes)) errors.push(`illegal edge: ${edge.edgeKind}/${edge.id}`);
  }
  return { valid: errors.length === 0, errors };
}

export function assertSemanticProjection(projection: SemanticProjection): void {
  const result = validateSemanticProjection(projection);
  if (!result.valid) throw new Error(`Invalid semantic projection: ${result.errors.join('; ')}`);
}

export function createSemanticProjection(input: {
  nodes: readonly ProjectionNode[];
  edges: readonly ProjectionEdge[];
}): SemanticProjection {
  const projection: SemanticProjection = {
    schema: PROJECTION_SCHEMA,
    nodes: [...input.nodes].sort(compareId),
    edges: [...input.edges].sort(compareId),
  };
  assertSemanticProjection(projection);
  return projection;
}

export const buildSemanticProjection = createSemanticProjection;

export function semanticProjectionJson(projection: SemanticProjection): string {
  assertSemanticProjection(projection);
  return canonicalize(projection);
}

export const serializeSemanticProjection = semanticProjectionJson;

export interface ContractProjectionInput {
  runId: string;
  parser: ContractSemanticProjection['parser'];
  nodes: readonly ProjectionNode[];
  edges: readonly ProjectionEdge[];
}

/** Convert the pure in-memory graph into the ADR/canary contract shape. */
export function createContractSemanticProjection(input: ContractProjectionInput): ContractSemanticProjection {
  const graph = createSemanticProjection({ nodes: input.nodes, edges: input.edges });
  const projection: ContractSemanticProjection = {
    schema_version: PROJECTION_SCHEMA,
    run_id: input.runId,
    parser: { ...input.parser },
    nodes: graph.nodes.map(node => {
      const { id, nodeType, ...data } = node;
      return { id, type: nodeType, data: data as Record<string, unknown> };
    }),
    edges: graph.edges.map(edge => ({
      id: edge.id,
      type: edge.edgeKind,
      source_id: edge.sourceId,
      target_id: edge.targetId,
      data: { ...edge.payload },
    })),
  };
  return projection;
}

export const buildContractSemanticProjection = createContractSemanticProjection;

export function contractSemanticProjectionJson(projection: ContractSemanticProjection): string {
  const result = validateContractSemanticProjection(projection);
  if (!result.valid) throw new Error(`Invalid contract semantic projection: ${result.errors.join('; ')}`);
  return canonicalize(projection);
}

export function validateContractSemanticProjection(projection: ContractSemanticProjection): ProjectionValidation {
  const errors: string[] = [];
  if (projection.schema_version !== PROJECTION_SCHEMA) errors.push(`schema_version must be ${PROJECTION_SCHEMA}`);
  const nodeIds = projection.nodes.map(node => node.id);
  const edgeIds = projection.edges.map(edge => edge.id);
  if (!isSortedUnique(nodeIds)) errors.push('nodes must be sorted by unique ID');
  if (!isSortedUnique(edgeIds)) errors.push('edges must be sorted by unique ID');
  const nodes: ProjectionNode[] = projection.nodes.map(node => ({ nodeType: node.type, id: node.id, ...node.data } as ProjectionNode));
  const edges: ProjectionEdge[] = projection.edges.map(edge => ({ edgeKind: edge.type, id: edge.id, sourceId: edge.source_id, targetId: edge.target_id, payload: edge.data }));
  for (const edge of edges) if (!isLegalProjectionEdge(edge, nodes)) errors.push(`illegal edge: ${edge.edgeKind}/${edge.id}`);
  return { valid: errors.length === 0, errors };
}

export const serializeContractSemanticProjection = contractSemanticProjectionJson;

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function compareId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
