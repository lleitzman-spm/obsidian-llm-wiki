import type { JsonValue } from '../crypto/canonical-json';

/** Stable contract for the small, non-secret settings surface used by extraction. */
export interface ExtractionSettingsProjection {
  readonly customEntityTags: string | readonly string[];
  readonly customConceptTags: string | readonly string[];
  readonly tagVocabularyMode: string;
  readonly granularity: string;
  /** Provider/output settings selected by the caller; values are intentionally generic. */
  readonly output: JsonValue;
  /** Concurrency/throttling settings selected by the caller; values are intentionally generic. */
  readonly concurrency: JsonValue;
}

export interface SettingsSignature {
  readonly keyId: string;
  readonly algorithm: string;
  readonly signature: string;
  readonly signedDigest: string;
}

export interface SignedSettingsProjection {
  readonly version: 'extraction-settings/v1';
  readonly projection: ExtractionSettingsProjection;
  readonly projectionSha256: string;
  readonly signature: SettingsSignature;
}

export interface SettingsProjectionMapping {
  /** Source key containing the granularity value, for example extractionGranularity. */
  readonly granularity: string;
  /** Source keys to carry into the canonical output group. */
  readonly output: readonly string[];
  /** Source keys to carry into the canonical concurrency group. */
  readonly concurrency: readonly string[];
}

export interface TagVocabulary {
  readonly version: 'tag-vocabulary/v1';
  readonly mode: string;
  readonly entityTags: readonly string[];
  readonly conceptTags: readonly string[];
  readonly normalization: 'unicode-nfkc-casefold-ws/v1';
  readonly vocabularySha256: string;
}

export interface ExtractionPolicyPack {
  readonly version: 'extraction-policy-pack/v1';
  readonly policy: JsonValue;
  readonly policySha256: string;
  readonly settings: SignedSettingsProjection;
  readonly vocabulary: TagVocabulary;
  readonly policyPackSha256: string;
}

export interface TagValidationError {
  readonly path: string;
  readonly message: string;
  readonly tag?: string;
}

export interface TagValidationResult {
  readonly valid: boolean;
  readonly errors: readonly TagValidationError[];
}

export interface EmittedTagFields {
  readonly entityTags?: readonly string[];
  readonly conceptTags?: readonly string[];
}

export type SettingsSignatureVerifier = (
  digest: string,
  signature: SettingsSignature,
) => boolean | Promise<boolean>;
