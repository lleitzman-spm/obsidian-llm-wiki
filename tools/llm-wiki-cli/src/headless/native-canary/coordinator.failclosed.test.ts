import { describe, expect, it } from 'vitest';

import type { LLMClient } from '../../../../../src/types';
import { buildExtractionPolicyPack } from '../policy-pack';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../preflight/hashing';
import {
  createKeyRegistry,
  createSigner,
  generateEd25519KeyPair,
} from '../crypto';
import type { NativeMapClient } from '../native-map';
import {
  runNativeCanary,
} from './coordinator';
import type { LiveIdleObservation, NativeCanaryInput } from './types';
import { NativeCanaryRefusal } from './types';

const AUTHORITY_TREE = 'a'.repeat(64);
const SOURCE_PATH = 'docs/one.md';

async function malformedObservationInput(): Promise<NativeCanaryInput> {
  const sourceBytes = new TextEncoder().encode('# One\n');
  const sourceHash = sha256Hex(sourceBytes);
  const source = {
    path: SOURCE_PATH,
    byteLength: sourceBytes.byteLength,
    byteSha256: sourceHash,
    sourceIdentity: sourceIdentityDigest(AUTHORITY_TREE, SOURCE_PATH, sourceHash),
  };
  const inventoryBody = {
    version: 'source-inventory/v1' as const,
    authorityTree: AUTHORITY_TREE,
    selectorVersion: 'test-selector/v1',
    includes: ['docs/**/*.md'],
    exclusions: [],
    sources: [source],
    snapshotTreeHash: snapshotTreeHash([{ path: SOURCE_PATH, byteSha256: sourceHash }]),
  };
  const sourceInventory = { ...inventoryBody, inventorySha256: canonicalJsonSha256(inventoryBody) };
  const projection = {
    customEntityTags: ['person'],
    customConceptTags: ['term'],
    tagVocabularyMode: 'custom',
    granularity: 'standard',
    output: {},
    concurrency: {},
  } as const;
  const settingsDigest = canonicalJsonSha256(projection);
  const policyPack = await buildExtractionPolicyPack({
    policy: { version: 'test-policy/v1' },
    settings: {
      version: 'extraction-settings/v1',
      projection,
      projectionSha256: settingsDigest,
      signature: {
        keyId: 'test-settings-key',
        algorithm: 'test',
        signature: 'test-signature',
        signedDigest: settingsDigest,
      },
    },
    verifySettingsSignature: () => true,
  });
  const keyPair = generateEd25519KeyPair();
  const signer = createSigner(keyPair.privateKey, { scopes: [] });
  const trustedRegistry = createKeyRegistry({ trustedKeys: [signer] });
  const observation: LiveIdleObservation = {
    version: 'spm-brain/live-idle-observation/v1',
    runId: 'canary-test',
    windowId: 'window-test',
    liveRoot: 'C:/live-vault',
    observedAt: new Date().toISOString(),
    idle: true,
    mutationSurface: 'read-only',
    statusDigest: '0'.repeat(64),
    signedDigest: '0'.repeat(64),
    signature: {
      key_id: signer.keyId,
      algorithm: 'Ed25519',
      signature: 'not-a-signature',
      signed_digest: '0'.repeat(64),
    },
  };
  const client: LLMClient = { createMessage: async () => '' };
  const mapClient: NativeMapClient = { createMessage: async () => '' };
  return {
    runId: 'canary-test',
    liveRoot: 'C:/live-vault',
    nativeRoot: 'C:/native-copy',
    candidateRoot: 'C:/candidate-copy',
    artifactRoot: 'C:/canary-artifacts',
    sourceInventory,
    authority: {
      repositoryUrl: 'https://example.invalid/sources',
      commit: 'b'.repeat(40),
      tree: AUTHORITY_TREE,
    },
    windowId: 'window-test',
    observeLive: async () => observation,
    policy: {
      fullSettingsBytes: new TextEncoder().encode('{}'),
      safeSettingsProjection: projection,
      policyPack,
      verifySettingsSignature: () => true,
      nativeMapSettings: {
        provider: 'test-provider',
        model: 'test-model',
        wikiLanguage: 'en',
        extractionGranularity: 'standard',
        tagVocabularyMode: 'custom',
        customEntityTags: 'person',
        customConceptTags: 'term',
      },
    },
    provider: {
      provider: 'test-provider',
      model: 'test-model',
      authorizationRef: 'test-grant',
      createClient: () => client,
      mapClient,
    },
    signer,
    trustedRegistry,
    global: {
      wikiFolder: 'wiki',
      indexPath: 'wiki/index.md',
      logPath: 'wiki/log.md',
      schemaPath: 'wiki/schema.md',
      date: '2026-08-20',
    },
  };
}

describe('native canary coordinator fail-closed boundaries', () => {
  it('refuses an unsigned or incorrectly bound idle observation before touching roots', async () => {
    const input = await malformedObservationInput();
    try {
      await runNativeCanary(input);
      throw new Error('expected native canary to refuse the malformed observation');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeCanaryRefusal);
      expect(error).toMatchObject({ code: 'live-observation-invalid' });
    }
  });
});
