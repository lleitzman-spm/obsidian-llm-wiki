import { createHash } from 'node:crypto';

import { canonicalJson, canonicalJsonBytes } from '../crypto/canonical-json';
import type {
  EmittedTagFields,
  ExtractionPolicyPack,
  ExtractionSettingsProjection,
  SettingsProjectionMapping,
  SettingsSignature,
  SignedSettingsProjection,
  TagValidationError,
  TagValidationResult,
  TagVocabulary,
  SettingsSignatureVerifier,
} from './types';

const SETTINGS_KEYS = [
  'customEntityTags',
  'customConceptTags',
  'tagVocabularyMode',
  'granularity',
  'output',
  'concurrency',
] as const;

const HEX_256 = /^[0-9a-f]{64}$/u;
const TAG_NORMALIZATION = 'unicode-nfkc-casefold-ws/v1' as const;

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_256.test(value)) {
    throw new TypeError(`${label} must be lowercase 64-character SHA-256 hex`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTag(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function parseTags(value: unknown, field: string): string[] {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (!raw) throw new TypeError(`${field} must be a comma-separated string or string array`);
  const result = raw.map((tag, index) => {
    if (typeof tag !== 'string') throw new TypeError(`${field}[${index}] must be a string`);
    const normalized = normalizeTag(tag);
    if (!normalized) throw new TypeError(`${field}[${index}] must not be empty`);
    return normalized;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${field} must not contain duplicate tags`);
  return [...result].sort();
}

function exactProjection(value: unknown): asserts value is ExtractionSettingsProjection {
  if (!isRecord(value)) throw new TypeError('Extraction settings projection must be a plain object');
  const keys = Object.keys(value).sort();
  const expected = [...SETTINGS_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Extraction settings projection must contain exactly ${SETTINGS_KEYS.join(', ')}`);
  }
  for (const key of ['tagVocabularyMode', 'granularity'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') throw new TypeError(`${key} must be a non-empty string`);
  }
  if (!isRecord(value.output) && !Array.isArray(value.output) && value.output === null) {
    throw new TypeError('output must be a JSON value');
  }
  if (!isRecord(value.concurrency) && !Array.isArray(value.concurrency) && value.concurrency === null) {
    throw new TypeError('concurrency must be a JSON value');
  }
  // Parse here so malformed tag values fail before a signature can be accepted.
  parseTags(value.customEntityTags, 'customEntityTags');
  parseTags(value.customConceptTags, 'customConceptTags');
}

/**
 * Convert an arbitrary safe-settings object into the exact, versioned surface
 * signed by a policy-pack authority. The mapping is explicit so this module
 * does not assume the host's private settings names or values.
 */
export function projectExtractionSettings(
  safeSettings: unknown,
  mapping: SettingsProjectionMapping,
): ExtractionSettingsProjection {
  if (!isRecord(safeSettings)) throw new TypeError('Safe settings projection must be a plain object');
  for (const key of [mapping.granularity, ...mapping.output, ...mapping.concurrency]) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('Settings mapping keys must be non-empty strings');
  }
  const pick = (keys: readonly string[]): Record<string, unknown> => {
    const output: Record<string, unknown> = {};
    for (const key of [...new Set(keys)].sort()) {
      if (!Object.prototype.hasOwnProperty.call(safeSettings, key)) throw new TypeError(`Safe settings projection is missing mapped key ${key}`);
      output[key] = safeSettings[key];
    }
    return output;
  };
  if (!Object.prototype.hasOwnProperty.call(safeSettings, mapping.granularity)) {
    throw new TypeError(`Safe settings projection is missing mapped key ${mapping.granularity}`);
  }
  const projection: ExtractionSettingsProjection = {
    customEntityTags: safeSettings.customEntityTags as string | readonly string[],
    customConceptTags: safeSettings.customConceptTags as string | readonly string[],
    tagVocabularyMode: safeSettings.tagVocabularyMode as string,
    granularity: safeSettings[mapping.granularity] as string,
    output: pick(mapping.output),
    concurrency: pick(mapping.concurrency),
  };
  exactProjection(projection);
  return projection;
}

export function canonicalSettingsProjectionSha256(projection: ExtractionSettingsProjection): string {
  exactProjection(projection);
  return sha256Canonical(projection);
}

export async function verifySignedSettingsProjection(
  signed: SignedSettingsProjection,
  verify: SettingsSignatureVerifier,
): Promise<void> {
  if (signed.version !== 'extraction-settings/v1') throw new TypeError('Unsupported extraction settings version');
  exactProjection(signed.projection);
  const expected = canonicalSettingsProjectionSha256(signed.projection);
  assertDigest(signed.projectionSha256, 'settings projection hash');
  if (signed.projectionSha256 !== expected) throw new Error('Signed settings projection hash does not match canonical projection');
  assertSignature(signed.signature, signed.projectionSha256);
  if (!(await verify(signed.projectionSha256, signed.signature))) throw new Error('Signed settings projection signature is invalid');
}

function assertSignature(signature: SettingsSignature, digest: string): void {
  if (!isRecord(signature) || typeof signature.keyId !== 'string' || !signature.keyId || typeof signature.algorithm !== 'string' || !signature.algorithm || typeof signature.signature !== 'string' || !signature.signature) {
    throw new TypeError('Signed settings projection requires a complete signature');
  }
  assertDigest(signature.signedDigest, 'signed settings digest');
  if (signature.signedDigest !== digest) throw new Error('Settings signature is not bound to the projection hash');
}

export function buildTagVocabulary(projection: ExtractionSettingsProjection): TagVocabulary {
  exactProjection(projection);
  const vocabularyBody = {
    version: 'tag-vocabulary/v1' as const,
    mode: projection.tagVocabularyMode,
    entityTags: parseTags(projection.customEntityTags, 'customEntityTags'),
    conceptTags: parseTags(projection.customConceptTags, 'customConceptTags'),
    normalization: TAG_NORMALIZATION,
  };
  return { ...vocabularyBody, vocabularySha256: sha256Canonical(vocabularyBody) };
}

function assertTagVocabulary(vocabulary: TagVocabulary): void {
  if (vocabulary.version !== 'tag-vocabulary/v1' || vocabulary.normalization !== TAG_NORMALIZATION || typeof vocabulary.mode !== 'string' || !vocabulary.mode) {
    throw new Error('Tag vocabulary has an unsupported or incomplete version');
  }
  const body = {
    version: 'tag-vocabulary/v1' as const,
    mode: vocabulary.mode,
    entityTags: [...vocabulary.entityTags],
    conceptTags: [...vocabulary.conceptTags],
    normalization: TAG_NORMALIZATION,
  };
  const expected = buildTagVocabulary({
    customEntityTags: body.entityTags,
    customConceptTags: body.conceptTags,
    tagVocabularyMode: body.mode,
    granularity: 'unused',
    output: {},
    concurrency: {},
  });
  if (vocabulary.vocabularySha256 !== expected.vocabularySha256 || canonicalJson(body) !== canonicalJson({
    ...body,
    entityTags: expected.entityTags,
    conceptTags: expected.conceptTags,
  })) {
    throw new Error('Tag vocabulary hash or canonical ordering is invalid');
  }
}

export async function buildExtractionPolicyPack(input: {
  policy: unknown;
  settings: SignedSettingsProjection;
  verifySettingsSignature: SettingsSignatureVerifier;
}): Promise<ExtractionPolicyPack> {
  await verifySignedSettingsProjection(input.settings, input.verifySettingsSignature);
  // canonicalJson is called explicitly to reject undefined, exotic prototypes,
  // symbols, and other non-JSON policy values before hashing or signing.
  canonicalJson(input.policy);
  const vocabulary = buildTagVocabulary(input.settings.projection);
  const policySha256 = sha256Canonical(input.policy);
  const body = {
    version: 'extraction-policy-pack/v1' as const,
    policy: input.policy,
    policySha256,
    settings: input.settings,
    vocabulary,
  };
  return { ...body, policyPackSha256: sha256Canonical(body) };
}

function validateTagList(value: unknown, allowed: ReadonlySet<string>, path: string): TagValidationError[] {
  if (!Array.isArray(value)) return [{ path, message: 'emitted tags must be an array' }];
  const errors: TagValidationError[] = [];
  const seen = new Set<string>();
  value.forEach((tag, index) => {
    if (typeof tag !== 'string' || !tag.trim()) {
      errors.push({ path: `${path}/${index}`, message: 'emitted tag must be a non-empty string' });
      return;
    }
    const normalized = normalizeTag(tag);
    if (seen.has(normalized)) errors.push({ path: `${path}/${index}`, message: 'duplicate emitted tag', tag });
    seen.add(normalized);
    if (!allowed.has(normalized)) errors.push({ path: `${path}/${index}`, message: 'unknown tag for the signed vocabulary', tag });
  });
  return errors;
}

/** Validate only explicit entityTags/conceptTags fields; entity labels remain unrestricted. */
export function validateEmittedTags(output: EmittedTagFields, vocabulary: TagVocabulary): TagValidationResult {
  const errors: TagValidationError[] = [];
  try {
    assertTagVocabulary(vocabulary);
  } catch (error) {
    errors.push({ path: '/vocabulary', message: error instanceof Error ? error.message : 'invalid tag vocabulary' });
    return { valid: false, errors };
  }
  const entity = new Set(vocabulary.entityTags.map(normalizeTag));
  const concept = new Set(vocabulary.conceptTags.map(normalizeTag));
  if (output.entityTags !== undefined) errors.push(...validateTagList(output.entityTags, entity, '/entityTags'));
  if (output.conceptTags !== undefined) errors.push(...validateTagList(output.conceptTags, concept, '/conceptTags'));
  return { valid: errors.length === 0, errors };
}

export function assertEmittedTags(output: EmittedTagFields, vocabulary: TagVocabulary): void {
  const result = validateEmittedTags(output, vocabulary);
  if (!result.valid) throw new Error(`Emitted tags violate signed vocabulary: ${result.errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
}
