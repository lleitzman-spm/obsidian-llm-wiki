import { describe, expect, it } from 'vitest';

import {
  assertEmittedTags,
  buildExtractionPolicyPack,
  buildTagVocabulary,
  canonicalSettingsProjectionSha256,
  projectExtractionSettings,
  validateEmittedTags,
} from '../../../../../tools/llm-wiki-cli/src/headless/policy-pack';
import { canonicalJsonBytes } from '../../../../../tools/llm-wiki-cli/src/headless/crypto/canonical-json';
import type { ExtractionSettingsProjection, SignedSettingsProjection } from '../../../../../tools/llm-wiki-cli/src/headless/policy-pack';

import { createHash } from 'node:crypto';

const h = (value: unknown): string => createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');

function projection(): ExtractionSettingsProjection {
  return {
    customEntityTags: 'person, organization, property',
    customConceptTags: ['procedure', 'policy', 'control'],
    tagVocabularyMode: 'custom',
    granularity: 'standard',
    output: { language: 'en', mode: 'json_schema' },
    concurrency: { pageGenerationConcurrency: 5, batchDelayMs: 500 },
  };
}

function signed(): SignedSettingsProjection {
  const value = projection();
  const digest = canonicalSettingsProjectionSha256(value);
  return {
    version: 'extraction-settings/v1',
    projection: value,
    projectionSha256: digest,
    signature: { keyId: 'settings-authority', algorithm: 'test-signature/v1', signature: 'valid', signedDigest: digest },
  };
}

const verifier = (digest: string, signature: { signature: string; signedDigest: string }): boolean => signature.signature === 'valid' && signature.signedDigest === digest;

describe('extraction policy-pack', () => {
  it('projects arbitrary host settings through an explicit mapping', () => {
    expect(projectExtractionSettings({
      customEntityTags: 'person, property', customConceptTags: 'procedure', tagVocabularyMode: 'custom',
      extractionGranularity: 'standard', outputLanguage: 'en', outputMode: 'json_schema',
      pageGenerationConcurrency: 5, batchDelayMs: 500,
    }, { granularity: 'extractionGranularity', output: ['outputLanguage', 'outputMode'], concurrency: ['pageGenerationConcurrency', 'batchDelayMs'] })).toEqual({
      customEntityTags: 'person, property', customConceptTags: 'procedure', tagVocabularyMode: 'custom', granularity: 'standard',
      output: { outputLanguage: 'en', outputMode: 'json_schema' }, concurrency: { batchDelayMs: 500, pageGenerationConcurrency: 5 },
    });
  });

  it('requires every exact extraction field and rejects drift/unknown keys', () => {
    const missing = { ...projection() } as Record<string, unknown>;
    delete missing.granularity;
    expect(() => canonicalSettingsProjectionSha256(missing as unknown as ExtractionSettingsProjection)).toThrow(/exactly/);
    expect(() => canonicalSettingsProjectionSha256({ ...projection(), futureSetting: true } as unknown as ExtractionSettingsProjection)).toThrow(/exactly/);
  });

  it('binds settings to the canonical hash and requires a valid signature', async () => {
    const value = signed();
    await expect(buildExtractionPolicyPack({ policy: { promptVersion: 'prompt/v1' }, settings: value, verifySettingsSignature: verifier })).resolves.toMatchObject({ version: 'extraction-policy-pack/v1' });
    await expect(buildExtractionPolicyPack({ policy: {}, settings: { ...value, projectionSha256: '0'.repeat(64) }, verifySettingsSignature: verifier })).rejects.toThrow(/hash/);
    await expect(buildExtractionPolicyPack({ policy: {}, settings: { ...value, signature: { ...value.signature, signature: 'bad' } }, verifySettingsSignature: verifier })).rejects.toThrow(/signature/);
  });

  it('canonicalizes vocabulary independent of input order and rejects duplicates', () => {
    const vocab = buildTagVocabulary(projection());
    expect(vocab.entityTags).toEqual(['organization', 'person', 'property']);
    expect(vocab.conceptTags).toEqual(['control', 'policy', 'procedure']);
    expect(() => buildTagVocabulary({ ...projection(), customConceptTags: 'policy, POLICY' })).toThrow(/duplicate/);
  });

  it('validates explicit entity/concept tags while leaving entity labels unrestricted', () => {
    const vocab = buildTagVocabulary(projection());
    expect(validateEmittedTags({ entityTags: ['PERSON', 'property'], conceptTags: ['control'] }, vocab).valid).toBe(true);
    const bad = validateEmittedTags({ entityTags: ['resident'], conceptTags: ['procedure', 'procedure'] }, vocab);
    expect(bad.valid).toBe(false);
    expect(bad.errors.map(error => error.message).join(' ')).toMatch(/unknown|duplicate/);
    expect(() => assertEmittedTags({ entityTags: ['resident'] }, vocab)).toThrow(/signed vocabulary/);
    expect(validateEmittedTags({ entityTags: ['person'] }, { ...vocab, vocabularySha256: '0'.repeat(64) }).valid).toBe(false);
  });

  it('binds the policy and vocabulary hashes to the final pack', async () => {
    const pack = await buildExtractionPolicyPack({ policy: { rules: ['evidence-required'] }, settings: signed(), verifySettingsSignature: verifier });
    expect(pack.policySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.vocabulary.vocabularySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.policyPackSha256).toBe(h({ version: pack.version, policy: pack.policy, policySha256: pack.policySha256, settings: pack.settings, vocabulary: pack.vocabulary }));
  });
});
