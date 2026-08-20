import type { ContractSemanticProjection } from '../provenance/types';
import type { Materiality } from '../provenance/types';
import type { SemanticProjection } from '../provenance/types';

/** A source that must be present in both projections. Paths are authority paths. */
export interface MaintainedSource {
  readonly normalizedPath: string;
  readonly sourceId?: string;
}

/** Optional page census supplied by a caller that has a filesystem page index. */
export interface PageRecord {
  readonly id: string;
  readonly path?: string;
  readonly canonicalKeyId?: string;
  readonly pageType?: string;
  readonly normalizedLabel?: string;
  readonly statementIds?: readonly string[];
  readonly customTags?: readonly string[];
  readonly qualifications?: readonly unknown[];
}

export type ComparisonProjection = ContractSemanticProjection | SemanticProjection;

export interface SemanticComparisonInput {
  readonly native: ComparisonProjection;
  readonly candidate: ComparisonProjection;
  /** If omitted, all native source paths are treated as maintained. */
  readonly maintainedSources?: readonly MaintainedSource[];
  /** Convenience form for callers that only have authority paths. */
  readonly requiredSourcePaths?: readonly string[];
  /** When supplied, the source-reach gate must equal this numerator. */
  readonly expectedReach?: number;
  readonly nativePages?: readonly PageRecord[];
  readonly candidatePages?: readonly PageRecord[];
}

export interface ComparisonGate {
  readonly passed: boolean;
  readonly observed: number;
  readonly expected: number;
  readonly issues: readonly string[];
}

export interface ComparisonDelta {
  readonly id: string;
  readonly materiality: Materiality;
  readonly subject: string;
  readonly nativeValue?: unknown;
  readonly candidateValue?: unknown;
  readonly explicitDisposition: boolean;
  readonly disposition?: string;
  readonly adjudicationId?: string;
  readonly issue: string;
}

export interface SemanticComparisonResult {
  readonly accepted: boolean;
  readonly sourceReach: ComparisonGate & {
    readonly maintainedSourcePaths: readonly string[];
    readonly reachedSourcePaths: readonly string[];
    readonly missingSourcePaths: readonly string[];
    readonly extraSourcePaths: readonly string[];
  };
  readonly grounding: ComparisonGate & {
    readonly nativeGroundedClaims: number;
    readonly nativeClaims: number;
    readonly candidateGroundedClaims: number;
    readonly candidateClaims: number;
  };
  readonly nativeClaimRetention: ComparisonGate & {
    readonly nativeClaimIds: readonly string[];
    readonly candidateClaimIds: readonly string[];
    readonly missingClaimIds: readonly string[];
    readonly extraClaimIds: readonly string[];
  };
  readonly exactClaimData: ComparisonGate & {
    readonly evidenceMismatches: readonly string[];
    readonly dispositionMismatches: readonly string[];
    readonly claimDataMismatches: readonly string[];
  };
  readonly aliases: ComparisonGate & { readonly missingIds: readonly string[]; readonly extraIds: readonly string[] };
  readonly customTags: ComparisonGate & { readonly mismatches: readonly string[] };
  readonly canonicalKeys: ComparisonGate & { readonly missingIds: readonly string[]; readonly extraIds: readonly string[] };
  readonly pageStatements: ComparisonGate & { readonly missingIds: readonly string[]; readonly extraIds: readonly string[] };
  readonly pages: ComparisonGate & { readonly missingIds: readonly string[]; readonly extraIds: readonly string[] };
  readonly graphEdges: ComparisonGate & { readonly missingIds: readonly string[]; readonly extraIds: readonly string[] };
  readonly qualifications: ComparisonGate & { readonly mismatches: readonly string[] };
  readonly materiality: ComparisonGate & { readonly deltas: readonly ComparisonDelta[] };
  readonly missingPages: readonly string[];
  readonly extraPages: readonly string[];
  readonly materialDeltas: readonly ComparisonDelta[];
}
