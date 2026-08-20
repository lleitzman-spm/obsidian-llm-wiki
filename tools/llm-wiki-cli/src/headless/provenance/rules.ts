import {
  DISPOSITIONS,
  EVIDENCE_KINDS,
  EVIDENCE_REASONS,
  isEvidenceKind,
  isEvidenceReason,
  isMateriality,
} from './vocab';
import type { Disposition, EvidenceKind, EvidenceReason, Materiality } from './types';

/** Matrix is intentionally explicit: an absent pair is ineligible. */
export const EVIDENCE_ELIGIBILITY_MATRIX: Readonly<Record<EvidenceKind, readonly EvidenceReason[]>> = Object.freeze({
  quote: ['direct-quote'],
  heading: ['defines-scope', 'defines-status'],
  'frontmatter-field': ['defines-relationship', 'defines-scope', 'defines-status', 'defines-metric'],
  'list-item': EVIDENCE_REASONS.filter(reason => reason !== 'direct-quote'),
  'table-cell': EVIDENCE_REASONS.filter(reason => reason !== 'direct-quote'),
  'code-block': ['defines-control', 'defines-metric'],
});

export interface EvidenceEligibilityOptions {
  frontmatterKeyRecognized?: boolean;
}

export function isEvidenceEligible(
  kind: EvidenceKind,
  reason: EvidenceReason,
  options: EvidenceEligibilityOptions = {},
): boolean {
  if (!isEvidenceKind(kind) || !isEvidenceReason(reason)) return false;
  if (kind === 'frontmatter-field' && options.frontmatterKeyRecognized === false) return false;
  return EVIDENCE_ELIGIBILITY_MATRIX[kind].includes(reason);
}

export const canEstablishEvidence = isEvidenceEligible;

export interface DispositionTransitionContext {
  exactSourceEvidence?: boolean;
  eligibleEvidence?: boolean;
  contradictoryEvidence?: boolean;
}

export const DISPOSITION_TRANSITION_MATRIX: Readonly<Record<Disposition, readonly Disposition[]>> = Object.freeze({
  unknown: ['unknown', 'asserted', 'evidenced', 'contested'],
  asserted: ['asserted', 'evidenced', 'contested'],
  evidenced: ['evidenced', 'contested'],
  contested: ['contested'],
});

export function isValidDispositionTransition(
  from: Disposition,
  to: Disposition,
  context: DispositionTransitionContext = {},
): boolean {
  if (!DISPOSITIONS.includes(from) || !DISPOSITIONS.includes(to)) return false;
  if (!DISPOSITION_TRANSITION_MATRIX[from].includes(to)) return false;
  if (from === to) return true;
  if (to === 'asserted') return context.exactSourceEvidence === true;
  if (to === 'evidenced') return context.eligibleEvidence === true;
  if (to === 'contested') return context.contradictoryEvidence === true;
  return false;
}

export const canTransitionDisposition = isValidDispositionTransition;

const NON_MATERIAL_MATERIALITIES = new Set<Materiality>([
  'semantic-preserving', 'render-only', 'boilerplate-only',
]);

/** Material deltas require a signed disposition/adjudication edge in v1. */
export function isMaterialityAllowed(materiality: Materiality, hasSignedDispositionOrAdjudication: boolean): boolean {
  if (!isMateriality(materiality)) return false;
  return NON_MATERIAL_MATERIALITIES.has(materiality) || hasSignedDispositionOrAdjudication;
}

export const canRecordMateriality = isMaterialityAllowed;

export interface EligibilityValidation {
  eligible: boolean;
  reason: string;
}

export function validateEvidenceEligibility(
  kind: EvidenceKind,
  reason: EvidenceReason,
  options: EvidenceEligibilityOptions = {},
): EligibilityValidation {
  if (!isEvidenceKind(kind)) return { eligible: false, reason: 'unknown evidence kind' };
  if (!isEvidenceReason(reason)) return { eligible: false, reason: 'unknown evidence reason' };
  if (kind === 'frontmatter-field' && options.frontmatterKeyRecognized === false) {
    return { eligible: false, reason: 'frontmatter key is not in the sealed schema' };
  }
  if (!isEvidenceEligible(kind, reason, options)) return { eligible: false, reason: 'kind/reason pair is not eligible in v1' };
  return { eligible: true, reason: 'eligible' };
}
