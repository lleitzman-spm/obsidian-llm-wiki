import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMClient } from '../../../../../src/types';
import {
  createContractSignature,
  createKeyRegistry,
  createSigner,
  digestHex,
  DOMAINS,
  generateEd25519KeyPair,
  hashCanonical,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { captureSnapshot } from '../../../../../tools/llm-wiki-cli/src/headless/copy-snapshot';
import { canonicalJsonSha256, sha256Hex, snapshotTreeHash, sourceIdentityDigest } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';
import {
  COPIED_VAULT_MARKER_SIGNING_SCOPE,
  COPIED_VAULT_MARKER_VERSION,
  bindNativeCanaryIsolatedRunner,
  createIsolatedNativeReferenceRunner,
  NATIVE_CANARY_HOST_ACTIVATION,
  NATIVE_CANARY_HOST_SIGNING_SCOPE,
  LIVE_OBSERVATION_SIGNING_SCOPE,
  TRUSTED_LIVE_ROOT_SIGNING_SCOPE,
  prepareNativeCanaryHost,
  runNativeCanaryHost,
  verifyNativeCanaryHostReceiptInput,
  type CopiedVaultMarkerBody,
  type NativeCanaryHostInput,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-canary/host';
import { NATIVE_CANARY_ISOLATED_RUNNER_BRAND } from '../../../../../tools/llm-wiki-cli/src/headless/native-canary';
import type { NativeCanaryInput, NativeCanaryResult } from '../../../../../tools/llm-wiki-cli/src/headless/native-canary';
import type { NativeMapClient } from '../../../../../tools/llm-wiki-cli/src/headless/native-map';
import type { SourceInventory } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/source-inventory';
import { createIsolatedInjectedRunner } from '../../../../../tools/llm-wiki-cli/src/headless/isolation';
import { NATIVE_REFERENCE_SIGNING_SCOPE } from '../../../../../tools/llm-wiki-cli/src/headless/native-reference';
import type { NativeReferenceInput } from '../../../../../tools/llm-wiki-cli/src/headless/native-reference';

vi.mock('../../../../../tools/llm-wiki-cli/src/headless/native-canary/coordinator', () => ({
  runNativeCanary: vi.fn(),
}));

import { runNativeCanary } from '../../../../../tools/llm-wiki-cli/src/headless/native-canary/coordinator';

const AUTHORITY_TREE = 'a'.repeat(64);
const roots: string[] = [];

async function fixture(): Promise<{
  input: NativeCanaryHostInput;
  signer: ReturnType<typeof createSigner>;
  registry: ReturnType<typeof createKeyRegistry>;
  credential: string;
  runnerRequestPath: string;
  acceptedWorkerScript: string;
}> {
  // The managed test sandbox denies realpath on parts of the OS temp parent;
  // keep the disposable fixture below the repository root instead.
  const base = await mkdtemp(join(process.cwd(), '.tmp-native-canary-host-'));
  roots.push(base);
  const liveRoot = join(base, 'live');
  const nativeRoot = join(base, 'native');
  const candidateRoot = join(base, 'candidate');
  const artifactRoot = join(base, 'artifacts');
  await Promise.all([liveRoot, nativeRoot, candidateRoot, artifactRoot].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(liveRoot, 'docs.md'), '# Source\n', 'utf8');

  const live = await captureSnapshot({ root: liveRoot, exclusions: ['run', 'lease'] });
  const sourceBytes = new TextEncoder().encode('# Source\n');
  const sourceHash = sha256Hex(sourceBytes);
  const sourcePath = 'docs.md';
  const source = {
    path: sourcePath,
    byteLength: sourceBytes.byteLength,
    byteSha256: sourceHash,
    sourceIdentity: sourceIdentityDigest(AUTHORITY_TREE, sourcePath, sourceHash),
  };
  const inventoryBody = {
    version: 'source-inventory/v1' as const,
    authorityTree: AUTHORITY_TREE,
    selectorVersion: 'test/v1',
    includes: ['*.md'],
    exclusions: [],
    sources: [source],
    snapshotTreeHash: snapshotTreeHash([{ path: sourcePath, byteSha256: sourceHash }]),
  };
  const sourceInventory: SourceInventory = {
    ...inventoryBody,
    inventorySha256: canonicalJsonSha256(inventoryBody),
  };
  const signer = createSigner(generateEd25519KeyPair().privateKey, {
    scopes: [COPIED_VAULT_MARKER_SIGNING_SCOPE, NATIVE_CANARY_HOST_SIGNING_SCOPE, LIVE_OBSERVATION_SIGNING_SCOPE, NATIVE_REFERENCE_SIGNING_SCOPE],
  });
  const rootSigner = createSigner(generateEd25519KeyPair().privateKey, {
    scopes: [TRUSTED_LIVE_ROOT_SIGNING_SCOPE],
  });
  const registry = createKeyRegistry({ trustedKeys: [signer, rootSigner] });
  const writerAuthority = {
    version: 'single-writer-authority/v1' as const,
    ownerId: 'host-test-owner',
    runId: 'host-test-run',
    fence: 7,
    roots: { native: nativeRoot, candidate: candidateRoot },
    assertCurrent: async () => undefined,
  };
  const marker = (role: 'native' | 'candidate', copyRoot: string): Record<string, unknown> => {
    const body: CopiedVaultMarkerBody = {
      version: COPIED_VAULT_MARKER_VERSION,
      runId: writerAuthority.runId,
      role,
      copyRoot,
      sourceSnapshotTreeSha256: live.treeSha256,
      sourceInventorySha256: sourceInventory.inventorySha256,
      authorityTree: AUTHORITY_TREE,
      writerOwnerId: writerAuthority.ownerId,
      writerFence: writerAuthority.fence,
    };
    const markerSha256 = canonicalJsonSha256(body);
    const signedDigest = digestHex(hashCanonical(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, body));
    return {
      ...body,
      markerSha256,
      signedDigest,
      signature: createContractSignature(DOMAINS.PREFLIGHT_CAPTURE_SIGNATURE, signedDigest, signer),
    };
  };
  await writeFile(`${nativeRoot}.spm-copy-marker.json`, `${JSON.stringify(marker('native', nativeRoot))}\n`, 'utf8');
  await writeFile(`${candidateRoot}.spm-copy-marker.json`, `${JSON.stringify(marker('candidate', candidateRoot))}\n`, 'utf8');

  const trustedLiveRootBody = {
    version: 'trusted-live-root/v1' as const,
    runId: writerAuthority.runId,
    windowId: 'host-test-window',
    root: liveRoot,
    rootIdentitySha256: sha256Hex(liveRoot),
  };
  const trustedLiveRootSignedDigest = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, trustedLiveRootBody));
  const trustedLiveRoot = {
    ...trustedLiveRootBody,
    signedDigest: trustedLiveRootSignedDigest,
    signature: createContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, trustedLiveRootSignedDigest, rootSigner),
  };
  const observedAt = new Date().toISOString();
  const observationBody = {
    version: 'spm-brain/live-idle-observation/v1' as const,
    runId: writerAuthority.runId,
    windowId: 'host-test-window',
    liveRoot,
    observedAt,
    idle: true as const,
    mutationSurface: 'read-only' as const,
    statusDigest: '3'.repeat(64),
  };
  const observationSignedDigest = digestHex(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, observationBody));
  const observation = {
    ...observationBody,
    signedDigest: observationSignedDigest,
    signature: createContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, observationSignedDigest, signer),
  };

  const client: LLMClient = { createMessage: async () => '' };
  const mapClient: NativeMapClient = { createMessage: async () => '' };
  const canary = {
    runId: writerAuthority.runId,
    liveRoot,
    nativeRoot,
    candidateRoot,
    artifactRoot,
    sourceInventory,
    authority: {
      repositoryUrl: 'https://example.invalid/authority',
      commit: 'b'.repeat(40),
      tree: AUTHORITY_TREE,
    },
    windowId: 'host-test-window',
    observeLive: async () => observation,
    policy: {} as NativeCanaryInput['policy'],
    provider: {
      provider: 'injected-provider',
      model: 'injected-model',
      authorizationRef: 'opaque-grant-must-not-appear',
      createClient: () => client,
      mapClient,
    },
    signer,
    trustedRegistry: registry,
    global: {
      wikiFolder: 'wiki',
      indexPath: 'wiki/index.md',
      logPath: 'wiki/log.md',
      schemaPath: 'wiki/schema.md',
      date: '2026-08-20',
    },
  } satisfies NativeCanaryInput;
  const nativeArtifactRoot = join(artifactRoot, 'native-reference');
  const workerScript = join(base, 'isolated-runner-worker.mjs');
  const runnerRequestPath = join(base, 'runner-request.json');
  const acceptedWorkerScript = join(base, 'accepted-isolated-runner-worker.mjs');
  await mkdir(nativeArtifactRoot, { recursive: true });
  await writeFile(workerScript, [
    "import { createInterface } from 'node:readline';",
    "import { writeFile } from 'node:fs/promises';",
    "const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', async line => {",
    "  const request = JSON.parse(line);",
    `  await writeFile(${JSON.stringify(runnerRequestPath)}, JSON.stringify(request));`,
    "  process.stdout.write(JSON.stringify({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'rejected', error: { code: 'TEST_NOT_ACTIVATED', message: 'test runner' } }) + '\\n');",
    "});",
    ].join('\n'), 'utf8');
  await writeFile(acceptedWorkerScript, [
    "import { createInterface } from 'node:readline';",
    "import { writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', async line => {",
    "  const request = JSON.parse(line);",
    `  await writeFile(${JSON.stringify(runnerRequestPath)}, JSON.stringify(request));`,
    "  const digest = 'a'.repeat(64);",
    "  const sourceIdentities = request.source_inventory.sources.map(source => source.sourceIdentity);",
    "  const result = {",
    "    version: 'native-reference/v1', runId: request.run_id, mode: request.mode, status: 'accepted',",
    "    preflight: {",
    "      roots: { copyRoots: [{ resolved: request.copied_vault_root }, { resolved: request.artifact_root }] },",
    "      copiedVaultRoot: request.copied_vault_root, artifactRoot: request.artifact_root,",
    "      sourceInventory: request.source_inventory, selectedSources: request.source_inventory.sources,",
    "      settings: { fullSha256: request.settings.full_sha256, safeProjectionSha256: request.settings.safe_projection_sha256 },",
    "      effectiveSettings: {}, beforeSnapshot: {},",
    "    },",
    "    beforeSnapshot: {}, afterSnapshot: {}, projection: {}, reports: [], writes: [],",
    "    receipt: {",
    "      contract_version: 'headless-ingest/v1', receipt_id: 'native/' + request.run_id, receipt_type: 'native',",
    "      run_id: request.run_id, created_at: '2026-08-20T12:00:00.000Z', status: 'accepted', writer_fence: 1,",
    "      target_snapshot_sha256: digest, counts: { sources: 1 },",
    "    },",
    "    binding: {",
    "      version: 'native-reference-binding/v1', runId: request.run_id, mode: request.mode,",
    "      copiedVaultRoot: request.copied_vault_root, artifactRoot: request.artifact_root,",
    "      sourceInventorySha256: request.source_inventory.inventorySha256, sourceIdentities,",
    "      settings: { fullSha256: request.settings.full_sha256, safeProjectionSha256: request.settings.safe_projection_sha256 },",
    "      provider: { provider: request.provider.provider, model: request.provider.model, authorizationRefSha256: request.provider.authorization_ref_sha256 },",
    "      beforeSnapshotTreeSha256: digest, afterSnapshotTreeSha256: digest, projectionSha256: digest,",
    "    },",
    "    artifactDirectory: join(request.artifact_root, request.run_id),",
    "  };",
    "  process.stdout.write(JSON.stringify({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result }) + '\\n');",
    "});",
  ].join('\n'), 'utf8');
  const rawIsolatedRunner = await createIsolatedInjectedRunner({
    workerScript,
    copiedVaultRoot: nativeRoot,
    artifactRoot: nativeArtifactRoot,
    workerId: 'host-test-worker',
    killTree: async pid => {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  });
  return {
    input: {
      canary,
      trustedLiveRoot,
      isolatedRunner: bindNativeCanaryIsolatedRunner(rawIsolatedRunner),
      writerAuthority,
    },
    signer,
    registry,
    credential: canary.provider.authorizationRef,
    runnerRequestPath,
    acceptedWorkerScript,
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function activatedCoordinatorResult(input: NativeCanaryHostInput): Promise<NativeCanaryResult> {
  const observation = await input.canary.observeLive();
  const [live, native, candidate] = await Promise.all([
    captureSnapshot({ root: input.canary.liveRoot, exclusions: ['run', 'lease'] }),
    captureSnapshot({ root: input.canary.nativeRoot, exclusions: ['run', 'lease'] }),
    captureSnapshot({ root: input.canary.candidateRoot, exclusions: ['run', 'lease'] }),
  ]);
  const writerBinding = {
    ownerId: input.writerAuthority.ownerId,
    runId: input.canary.runId,
    fence: input.writerAuthority.fence + 1,
    candidateRootSha256: sha256Hex(input.canary.candidateRoot),
  };
  return {
    version: 'native-canary/v1',
    runId: input.canary.runId,
    observation,
    terminalObservation: observation,
    copies: { live, native, candidate },
    native: { preflight: { sourceInventory: input.canary.sourceInventory } },
    transactionPlan: { fence: writerBinding.fence },
    writerBinding,
    hostWriterBinding: {
      ownerId: input.writerAuthority.ownerId,
      runId: input.writerAuthority.runId,
      fence: input.writerAuthority.fence,
      candidateRootSha256: sha256Hex(input.canary.candidateRoot),
    },
  } as unknown as NativeCanaryResult;
}

describe('authorized native canary host', () => {
  it('is inert by default and never invokes the injected runner', async () => {
    const { input } = await fixture();
    await expect(runNativeCanaryHost(input)).rejects.toMatchObject({ code: 'inactive' });
  });

  it('requires both signed copy markers and one current writer authority', async () => {
    const { input, registry } = await fixture();
    const receipt = await prepareNativeCanaryHost({ ...input, activation: NATIVE_CANARY_HOST_ACTIVATION });
    verifyNativeCanaryHostReceiptInput(receipt, registry);
    expect(receipt.phase).toBe('pre-execution');
    expect(receipt.markers.map(marker => marker.role)).toEqual(['native', 'candidate']);
    expect(receipt.provider.authorizationRefSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('opaque-grant-must-not-appear');
  });

  it('refuses a missing marker before any runner can be invoked', async () => {
    const { input } = await fixture();
    await rm(`${input.canary.nativeRoot}.spm-copy-marker.json`);
    await expect(prepareNativeCanaryHost({ ...input, activation: NATIVE_CANARY_HOST_ACTIVATION }))
      .rejects.toMatchObject({ code: 'marker-missing' });
  });

  it('requires explicit copied-vault activation even when all dependencies are injected', async () => {
    const { input } = await fixture();
    await expect(runNativeCanaryHost({ ...input, activation: 'live' as never }))
      .rejects.toMatchObject({ code: 'inactive' });
    expect(NATIVE_CANARY_HOST_ACTIVATION).toBe('copied-vault-shadow-canary/v1');
  });

  it('passes only the isolated JSON contract to the subprocess runner', async () => {
    const { input, runnerRequestPath } = await fixture();
    const isolated = createIsolatedNativeReferenceRunner(input);
    const nativeInput = {
      runId: input.canary.runId,
      mode: 'ingest' as const,
      liveRoot: input.canary.liveRoot,
      copiedVaultRoot: input.canary.nativeRoot,
      artifactRoot: join(input.canary.artifactRoot, 'native-reference'),
      sourceInventory: input.canary.sourceInventory,
      settings: { fullSha256: '1'.repeat(64), safeProjectionSha256: '2'.repeat(64) },
      provider: input.canary.provider,
      signer: input.canary.signer,
      trustedRegistry: input.canary.trustedRegistry,
      forceReingest: true,
    } as NativeReferenceInput;
    await expect(isolated.run(nativeInput)).rejects.toMatchObject({ code: 'runner-refused' });
    const request = JSON.parse(await readFile(runnerRequestPath, 'utf8')) as Record<string, unknown>;
    expect(request).not.toHaveProperty('live_root');
    expect(request).not.toHaveProperty('candidate_root');
    expect(request).not.toHaveProperty('signer');
    expect(request).not.toHaveProperty('authorizationRef');
    expect(request).not.toHaveProperty('createClient');
    const provider = request.provider as Record<string, unknown>;
    expect(provider).not.toHaveProperty('authorization_ref');
    expect(provider.authorization_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.artifact_root).toBe(join(input.canary.artifactRoot, 'native-reference'));
    expect(request.writer).toMatchObject({
      owner_id: input.writerAuthority.ownerId,
      run_id: input.canary.runId,
      fence: input.writerAuthority.fence,
    });
  });

  it('rejects writer loss during activation-gated preparation', async () => {
    const { input } = await fixture();
    const lost = {
      ...input,
      activation: NATIVE_CANARY_HOST_ACTIVATION,
      writerAuthority: { ...input.writerAuthority, assertCurrent: async () => { throw new Error('lost'); } },
    };
    await expect(prepareNativeCanaryHost(lost)).rejects.toMatchObject({ code: 'writer-authority-lost' });
  });

  it('rejects a forged trusted live-root binding even when the caller root is unchanged', async () => {
    const { input } = await fixture();
    await expect(prepareNativeCanaryHost({
      ...input,
      activation: NATIVE_CANARY_HOST_ACTIVATION,
      trustedLiveRoot: { ...input.trustedLiveRoot, root: input.canary.candidateRoot },
    })).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('rejects a copied runner shape that was not produced by the isolation factory adapter', async () => {
    const { input } = await fixture();
    const fakeRunner = {
      copiedVaultRoot: input.canary.nativeRoot,
      artifactRoot: join(input.canary.artifactRoot, 'native-reference'),
      workerId: 'fake-runner',
      run: input.isolatedRunner.run,
      [NATIVE_CANARY_ISOLATED_RUNNER_BRAND]: 'native-canary-isolated-runner/v1' as const,
    } as NativeCanaryHostInput['isolatedRunner'];
    await expect(prepareNativeCanaryHost({
      ...input,
      activation: NATIVE_CANARY_HOST_ACTIVATION,
      isolatedRunner: fakeRunner,
    })).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('seals the inventory before the real subprocess runner sees it', async () => {
    const { input, runnerRequestPath } = await fixture();
    const isolated = createIsolatedNativeReferenceRunner(input);
    await expect(isolated.run({
      runId: input.canary.runId,
      mode: 'ingest',
      liveRoot: input.canary.liveRoot,
      copiedVaultRoot: input.canary.nativeRoot,
      artifactRoot: join(input.canary.artifactRoot, 'native-reference'),
      sourceInventory: input.canary.sourceInventory,
      settings: { fullSha256: '1'.repeat(64), safeProjectionSha256: '2'.repeat(64) },
      provider: input.canary.provider,
      signer: input.canary.signer,
      trustedRegistry: input.canary.trustedRegistry,
      forceReingest: true,
    } as NativeReferenceInput)).rejects.toMatchObject({ code: 'runner-refused' });
    const request = JSON.parse(await readFile(runnerRequestPath, 'utf8')) as Record<string, unknown>;
    expect(request.source_inventory).toEqual(input.canary.sourceInventory);
  });

  it('accepts and host-rebinds a native result returned by the real child process', async () => {
    const { input, acceptedWorkerScript, runnerRequestPath } = await fixture();
    const nativeArtifactRoot = join(input.canary.artifactRoot, 'native-reference');
    const child = await createIsolatedInjectedRunner({
      workerScript: acceptedWorkerScript,
      copiedVaultRoot: input.canary.nativeRoot,
      artifactRoot: nativeArtifactRoot,
      workerId: 'host-test-accepted-worker',
      provider: {
        provider: input.canary.provider.provider,
        model: input.canary.provider.model,
        authorizationRef: input.canary.provider.authorizationRef,
        call: async () => ({ status: 'failed' as const, error_code: 'TEST_PROVIDER_UNUSED' }),
      },
      killTree: async pid => {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      },
    });
    const isolated = createIsolatedNativeReferenceRunner({
      ...input,
      isolatedRunner: bindNativeCanaryIsolatedRunner(child),
    });
    const native = await isolated.run({
      runId: input.canary.runId,
      mode: 'ingest',
      liveRoot: input.canary.liveRoot,
      copiedVaultRoot: input.canary.nativeRoot,
      artifactRoot: nativeArtifactRoot,
      sourceInventory: input.canary.sourceInventory,
      settings: { fullSha256: '1'.repeat(64), safeProjectionSha256: '2'.repeat(64) },
      provider: input.canary.provider,
      signer: input.canary.signer,
      trustedRegistry: input.canary.trustedRegistry,
      forceReingest: true,
    } as NativeReferenceInput);

    expect(native.status).toBe('accepted');
    expect(native.binding.liveRoot).toBe(input.canary.liveRoot);
    expect(native.binding.artifactRoot).toBe(nativeArtifactRoot);
    expect(native.binding.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(native.receipt.signature.key_id).toBe(input.canary.signer.keyId);
    expect(native.preflight.roots.liveRoot.resolved).toBe(input.canary.liveRoot);
    expect(native.preflight.effectiveSettings).toEqual({});
    const request = JSON.parse(await readFile(runnerRequestPath, 'utf8')) as Record<string, unknown>;
    expect(request).not.toHaveProperty('live_root');
    expect(request).not.toHaveProperty('signer');
    expect(request).not.toHaveProperty('authorizationRef');
    expect(request).not.toHaveProperty('createClient');
    expect(JSON.stringify(native.preflight.effectiveSettings)).not.toMatch(/api[_-]?key|secret|token|password/i);
  });

  it('activates the host-to-coordinator path with the sealed writer binding', async () => {
    const { input } = await fixture();
    const result = await activatedCoordinatorResult(input);
    const coordinator = vi.mocked(runNativeCanary);
    coordinator.mockResolvedValue(result);

    const hostResult = await runNativeCanaryHost({ ...input, activation: NATIVE_CANARY_HOST_ACTIVATION });

    expect(hostResult.canary).toBe(result);
    expect(coordinator).toHaveBeenCalledTimes(1);
    const coordinatorInput = coordinator.mock.calls[0]?.[0];
    expect(coordinatorInput?.writerBinding).toEqual({
      ownerId: input.writerAuthority.ownerId,
      runId: input.canary.runId,
      fence: input.writerAuthority.fence,
      candidateRootSha256: sha256Hex(input.canary.candidateRoot),
    });
    expect(coordinatorInput?.assertWriterCurrent).toEqual(expect.any(Function));
    expect(coordinatorInput?.nativeReference?.run).toEqual(expect.any(Function));
  });

  it('refuses an activated coordinator result with a mismatched candidate-root binding', async () => {
    const { input } = await fixture();
    const result = await activatedCoordinatorResult(input);
    const coordinator = vi.mocked(runNativeCanary);
    coordinator.mockResolvedValue({
      ...result,
      writerBinding: { ...result.writerBinding, candidateRootSha256: 'f'.repeat(64) },
    });

    await expect(runNativeCanaryHost({ ...input, activation: NATIVE_CANARY_HOST_ACTIVATION }))
      .rejects.toMatchObject({ code: 'writer-authority-lost' });
    expect(coordinator).toHaveBeenCalledTimes(1);
  });

  it('rejects marker body tampering and receipt root collisions', async () => {
    const { input } = await fixture();
    const active = { ...input, activation: NATIVE_CANARY_HOST_ACTIVATION };
    const markerPath = `${active.canary.nativeRoot}.spm-copy-marker.json`;
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker.copyRoot = active.canary.candidateRoot;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    await expect(prepareNativeCanaryHost(active)).rejects.toMatchObject({ code: 'marker-invalid' });
    await expect(prepareNativeCanaryHost({
      ...active,
      canary: { ...active.canary, nativeRoot: active.canary.candidateRoot },
    })).rejects.toMatchObject({ code: 'writer-authority-missing' });
    const second = await fixture();
    const receipt = await prepareNativeCanaryHost({ ...second.input, activation: NATIVE_CANARY_HOST_ACTIVATION });
    expect(() => verifyNativeCanaryHostReceiptInput({
      ...receipt,
      roots: { ...receipt.roots, artifact: receipt.roots.native },
    }, second.registry)).toThrow(/roots overlap/);
  });
});
