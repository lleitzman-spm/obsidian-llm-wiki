/** Closed v1 vocabularies from ADR-0001. Keep these tuples append-only by version. */
export const EVIDENCE_KINDS = [
  'quote', 'heading', 'list-item', 'table-cell', 'frontmatter-field', 'code-block',
] as const;

export const EVIDENCE_REASONS = [
  'direct-quote', 'defines-relationship', 'defines-scope', 'defines-status',
  'defines-obligation', 'defines-exception', 'defines-control', 'defines-metric',
] as const;

export const DISPOSITIONS = ['unknown', 'asserted', 'evidenced', 'contested'] as const;
export const ALIAS_STATES = ['speculative', 'grounded', 'adjudicated'] as const;

export const ADJUDICATION_DECISIONS = [
  'confirm-left', 'confirm-right', 'preserve-both', 'merge-equivalent',
  'supersede-with-new-claim', 'defer-unresolved',
] as const;

export const ADJUDICATION_RATIONALES = [
  'stronger-primary-evidence', 'newer-authority-revision', 'scope-distinction',
  'terminology-equivalence', 'non-equivalent-conflict', 'insufficient-evidence',
] as const;

export const MATERIALITIES = [
  'semantic-preserving', 'semantic-addition', 'semantic-removal',
  'qualification-change', 'disposition-change', 'identity-change',
  'provenance-change', 'render-only', 'boilerplate-only',
] as const;

export const NORMALIZATION_VERSION = 'unicode-nfkc-casefold-ws/v1' as const;
export const PROJECTION_SCHEMA = 'semantic-projection/v1' as const;

export function isEvidenceKind(value: unknown): value is (typeof EVIDENCE_KINDS)[number] {
  return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function isEvidenceReason(value: unknown): value is (typeof EVIDENCE_REASONS)[number] {
  return typeof value === 'string' && (EVIDENCE_REASONS as readonly string[]).includes(value);
}

export function isDisposition(value: unknown): value is (typeof DISPOSITIONS)[number] {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value);
}

export function isAliasState(value: unknown): value is (typeof ALIAS_STATES)[number] {
  return typeof value === 'string' && (ALIAS_STATES as readonly string[]).includes(value);
}

export function isAdjudicationDecision(value: unknown): value is (typeof ADJUDICATION_DECISIONS)[number] {
  return typeof value === 'string' && (ADJUDICATION_DECISIONS as readonly string[]).includes(value);
}

export function isAdjudicationRationale(value: unknown): value is (typeof ADJUDICATION_RATIONALES)[number] {
  return typeof value === 'string' && (ADJUDICATION_RATIONALES as readonly string[]).includes(value);
}

export function isMateriality(value: unknown): value is (typeof MATERIALITIES)[number] {
  return typeof value === 'string' && (MATERIALITIES as readonly string[]).includes(value);
}
