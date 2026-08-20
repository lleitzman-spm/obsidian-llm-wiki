import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '../../../../types';
import { buildExtractionPolicyPack } from '../../../../../tools/llm-wiki-cli/src/headless/policy-pack';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';
import {
  createKeyRegistry,
  createSigner,
  generateEd25519KeyPair,
  createContractSignature,
  DOMAINS,
  digestHex,
  hashCanonical,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { assertSafeCopyRoots } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/roots';
import { captureSnapshot } from '../../../../../tools/llm-wiki-cli/src/headless/copy-snapshot';
import type { NativeMapClient } from '../../../../../tools/llm-wiki-cli/src/headless/native-map';
import {
  runNativeCanary,
  validateTerminalLiveObservation,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-canary/coordinator';
import type { LiveIdleObservation, NativeCanaryCopies, NativeCanaryInput } from '../../../../../tools/llm-wiki-cli/src/headless/native-canary/types';
import { NativeCanaryRefusal } from '../../../../../tools/llm-wiki-cli/src/headless/native-canary/types';

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

function signedObservation(
  input: NativeCanaryInput,
  liveRoot: string,
  observedAt: string,
  statusDigest: string,
): LiveIdleObservation {
  const body = {
    version: 'spm-brain/live-idle-observation/v1' as const,
    runId: input.runId,
    windowId: input.windowId,
    liveRoot,
    observedAt,
    idle: true as const,
    mutationSurface: 'read-only' as const,
    statusDigest,
  };
  const signedDigest = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, body));
  return {
    ...body,
    signedDigest,
    signature: createContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, signedDigest, input.signer),
  };
}

interface TerminalFixture {
  readonly input: NativeCanaryInput;
  readonly roots: Awaited<ReturnType<typeof assertSafeCopyRoots>>;
  readonly copies: NativeCanaryCopies;
  readonly initial: LiveIdleObservation;
  readonly liveRoot: string;
  setObservation(observation: LiveIdleObservation): void;
  cleanup(): Promise<void>;
}

async function terminalFixture(): Promise<TerminalFixture> {
  const base = await malformedObservationInput();
  const baseDirectory = await mkdtemp(join(tmpdir(), 'spm-native-canary-terminal-'));
  const liveRoot = join(baseDirectory, 'live');
  const nativeRoot = join(baseDirectory, 'native');
  const candidateRoot = join(baseDirectory, 'candidate');
  const artifactRoot = join(baseDirectory, 'artifacts');
  await Promise.all([liveRoot, nativeRoot, candidateRoot, artifactRoot].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(liveRoot, 'notes.md'), 'stable\n', 'utf8');
  const roots = await assertSafeCopyRoots({ liveRoot, copyRoots: [nativeRoot, candidateRoot, artifactRoot] });
  const copies: NativeCanaryCopies = {
    live: await captureSnapshot({ root: roots.liveRoot.resolved }),
    native: await captureSnapshot({ root: roots.copyRoots[0].resolved }),
    candidate: await captureSnapshot({ root: roots.copyRoots[1].resolved }),
  };
  const now = Date.parse('2026-08-20T00:00:00.000Z');
  let currentObservation: LiveIdleObservation;
  const input: NativeCanaryInput = {
    ...base,
    liveRoot,
    nativeRoot,
    candidateRoot,
    artifactRoot,
    now: () => now,
    observeLive: async () => currentObservation,
  };
  const initial = signedObservation(input, roots.liveRoot.resolved, new Date(now).toISOString(), '1'.repeat(64));
  currentObservation = initial;
  return {
    input,
    roots,
    copies,
    initial,
    liveRoot,
    setObservation: observation => { currentObservation = observation; },
    cleanup: () => rm(baseDirectory, { recursive: true, force: true }),
  };
}

async function withTerminalFixture(run: (fixture: TerminalFixture) => Promise<void>): Promise<void> {
  const fixture = await terminalFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
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

  it('accepts a fresh signed terminal observation when status and live bytes are unchanged', async () => {
    await withTerminalFixture(async fixture => {
      const terminal = await validateTerminalLiveObservation(fixture.input, fixture.roots, fixture.copies, fixture.initial);
      expect(terminal.statusDigest).toBe(fixture.initial.statusDigest);
    });
  });

  it('rejects terminal status drift even when the live snapshot bytes are unchanged', async () => {
    await withTerminalFixture(async fixture => {
      fixture.setObservation(signedObservation(
        fixture.input,
        fixture.roots.liveRoot.resolved,
        fixture.initial.observedAt,
        '2'.repeat(64),
      ));
      await expect(validateTerminalLiveObservation(fixture.input, fixture.roots, fixture.copies, fixture.initial))
        .rejects.toMatchObject({ code: 'live-drift' });
    });
  });

  it('rejects live byte drift even when the signed terminal status is unchanged', async () => {
    await withTerminalFixture(async fixture => {
      await writeFile(join(fixture.liveRoot, 'notes.md'), 'changed\n', 'utf8');
      await expect(validateTerminalLiveObservation(fixture.input, fixture.roots, fixture.copies, fixture.initial))
        .rejects.toMatchObject({ code: 'live-drift' });
    });
  });
});
