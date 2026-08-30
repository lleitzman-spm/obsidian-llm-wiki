import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createContractSignature,
  createKeyRegistry,
  createSigner,
  createTerminalRoot,
  DOMAINS,
  generateEd25519KeyPair,
  hashCanonical,
  ReplayLedger,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { canonicalJsonSha256, sha256Hex, snapshotTreeHash, sourceIdentityDigest } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';
import { captureSnapshot } from '../../../../../tools/llm-wiki-cli/src/headless/copy-snapshot';
import { createTransactionPlan } from '../../../../../tools/llm-wiki-cli/src/headless/transaction';
import { TransactionJournal } from '../../../../../tools/llm-wiki-cli/src/headless/transaction/journal';
import { independentlyVerifyNativeCanaryArtifacts } from '../../../../../tools/llm-wiki-cli/src/headless/verification';

const TREE = 'a'.repeat(40);
const RUN = 'fixture-run';
const WINDOW = 'fixture-window';
const SOURCE_PATH = 'source.md';
const SOURCE_TEXT = '# Source\n';
const GENERATED_TEXT = '# Generated\n';
const SCOPES = [
  'spm-brain-run-terminalize',
  'spm-brain-replay-append',
  'spm-brain-native-reference-sign',
  'spm-brain-live-preflight-sign',
] as const;

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, json(value));
}

async function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'spm-native-canary-full-'));
  const liveRoot = join(base, 'live');
  const nativeRoot = join(base, 'native');
  const candidateRoot = join(base, 'candidate');
  const artifactRoot = join(base, 'artifacts');
  const nativeArtifactRoot = join(base, 'native-reference');
  for (const root of [liveRoot, nativeRoot, candidateRoot, artifactRoot, nativeArtifactRoot]) mkdirSync(root, { recursive: true });
  for (const root of [liveRoot, nativeRoot, candidateRoot]) writeFileSync(join(root, SOURCE_PATH), SOURCE_TEXT);

  const sourceHash = sha256Hex(SOURCE_TEXT);
  const sourceIdentity = sourceIdentityDigest(TREE, SOURCE_PATH, sourceHash);
  const inventoryBody = {
    version: 'source-inventory/v1' as const,
    authorityTree: TREE,
    selectorVersion: 'fixture-selector/v1',
    includes: ['**/*.md'],
    exclusions: [],
    sources: [{ path: SOURCE_PATH, byteLength: new TextEncoder().encode(SOURCE_TEXT).byteLength, byteSha256: sourceHash, sourceIdentity }],
    snapshotTreeHash: snapshotTreeHash([{ path: SOURCE_PATH, byteSha256: sourceHash }]),
  };
  const sourceInventory = { ...inventoryBody, inventorySha256: canonicalJsonSha256(inventoryBody) };
  const liveSnapshot = await captureSnapshot({ root: liveRoot });
  const nativeSnapshot = await captureSnapshot({ root: nativeRoot });
  const candidateSnapshot = await captureSnapshot({ root: candidateRoot });

  const settings = {
    provider: 'fixture-provider', model: 'fixture-model', wikiLanguage: 'en', extractionGranularity: 'standard' as const,
    tagVocabularyMode: 'custom' as const, customEntityTags: 'entity', customConceptTags: 'concept',
  };
  const settingsSha256 = canonicalJsonSha256(settings);
  const vocabularySha256 = canonicalJsonSha256({ entityTags: ['entity'], conceptTags: ['concept'] });
  const policyPackSha256 = 'b'.repeat(64);
  const policyBody = {
    contractVersion: 'native-map/v1' as const, promptVersion: 'fixture-policy/v1', settings,
    entityTags: ['entity'], conceptTags: ['concept'], schemaContext: null, systemPrompt: null,
    settingsSha256, vocabularySha256, policyPackSha256,
  };
  const mapPolicy = { ...policyBody, policySha256: canonicalJsonSha256(policyBody) };
  const mapBody = {
    contractVersion: 'native-map/v1' as const,
    source: { sourceId: sourceIdentity, sourcePath: SOURCE_PATH, byteSha256: sourceHash, byteCount: SOURCE_TEXT.length },
    sourceTitle: 'Source', summary: '', sourceAliases: [], keyPoints: [], entities: [], concepts: [], mentions: [], claims: [], aliases: [], related: [], contradictions: [], artifacts: [], policySha256: mapPolicy.policySha256,
  };
  const mapIR = { ...mapBody, irSha256: canonicalJsonSha256(mapBody) };
  const parser = { version: 'fixture-parser/v1', source_sha256: 'c'.repeat(64), grammar_sha256: 'd'.repeat(64), unicode_sha256: 'e'.repeat(64), boilerplate_policy_sha256: 'f'.repeat(64) };
  const projection = {
    schema_version: 'semantic-projection/v1' as const, run_id: RUN, parser,
    nodes: [{ id: `source:${sourceIdentity}`, type: 'source' as const, data: { authorityTree: TREE, normalizedPath: SOURCE_PATH, byteHash: sourceHash } }],
    edges: [],
  };
  const desiredState = [
    { path: 'generated.md', kind: 'source' as const, phase: 'partition' as const, action: 'create' as const, content: GENERATED_TEXT, desiredSha256: sha256Hex(GENERATED_TEXT), sourceIds: [sourceIdentity] },
    { path: SOURCE_PATH, kind: 'source' as const, phase: 'partition' as const, action: 'unchanged' as const, content: SOURCE_TEXT, desiredSha256: sourceHash, currentSha256: sourceHash, sourceIds: [sourceIdentity] },
  ];
  const reduction = {
    version: 'native-reducer/v1' as const, status: 'candidate' as const, complete: true as const, canApply: true, reasons: [], unsupported: [], pages: [], desiredState,
    globalPhase: { serialized: true as const, serializationOrder: [], files: [] },
  };
  writeFileSync(join(candidateRoot, 'generated.md'), GENERATED_TEXT);
  const plan = createTransactionPlan({
    transactionId: `tx-${RUN}`, fence: 1,
    current: desiredState.map(file => ({ path: file.path, bytes: file.path === SOURCE_PATH ? new TextEncoder().encode(SOURCE_TEXT) : null, scope: 'page' as const })),
    desired: desiredState.map(file => ({ path: file.path, bytes: new TextEncoder().encode(file.content), scope: 'page' as const })),
  });
  // The candidate is deliberately left in its committed post-state. The
  // planner's operation remains a create because the sealed initial snapshot
  // below predates this write.
  rmSync(join(candidateRoot, 'generated.md'));
  writeFileSync(join(candidateRoot, 'generated.md'), GENERATED_TEXT);
  const postSnapshot = await captureSnapshot({ root: candidateRoot });

  const keyPair = generateEd25519KeyPair();
  const signer = createSigner(keyPair.privateKey, { scopes: SCOPES });
  const registry = createKeyRegistry({ trustedKeys: [signer] });
  const now = Date.now();
  const observationBody = (observedAt: string) => ({ version: 'spm-brain/live-idle-observation/v1' as const, runId: RUN, windowId: WINDOW, liveRoot, observedAt, idle: true as const, mutationSurface: 'read-only' as const, statusDigest: '1'.repeat(64) });
  const signedObservation = (observedAt: string) => {
    const body = observationBody(observedAt);
    const signedDigest = digest(body);
    return { ...body, signedDigest, signature: createContractSignature(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, signedDigest, signer) };
  };
  const digest = (body: unknown) => Buffer.from(hashCanonical(DOMAINS.LIVE_PREFLIGHT_CAPTURE_SIGNATURE, body as never)).toString('hex');
  const observedAt = new Date(now).toISOString();
  const observation = signedObservation(observedAt);
  const terminalObservation = signedObservation(new Date(now + 1000).toISOString());
  const nativeReceiptBody = {
    contract_version: 'headless-ingest/v1' as const, receipt_id: `native/${RUN}`, receipt_type: 'native' as const, run_id: RUN, created_at: observedAt, status: 'accepted' as const,
    writer_fence: 1, target_snapshot_sha256: nativeSnapshot.treeSha256, projection_sha256: canonicalJsonSha256(projection),
    counts: { sources: 1, claims: 0, evidences: 0, pages: 0, statements: 0, edges: 0, creates: 0, replaces: 0, deletes: 0, attempts: 0, retries: 0, input_tokens: 0, output_tokens: 0, billed_tokens: 0, duration_ms: 0, errors: 0 },
  };
  const nativeReceipt = { ...nativeReceiptBody, signature: createContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, canonicalJsonSha256(nativeReceiptBody), signer) };
  const nativeBinding = {
    version: 'native-reference-binding/v1' as const, runId: RUN, mode: 'ingest' as const, liveRoot, copiedVaultRoot: nativeRoot, artifactRoot: nativeArtifactRoot,
    sourceInventorySha256: sourceInventory.inventorySha256, sourceIdentities: [sourceIdentity], settings: { fullSha256: '1'.repeat(64), safeProjectionSha256: '2'.repeat(64) },
    provider: { provider: 'fixture-provider', model: 'fixture-model', authorizationRefSha256: sha256Hex('fixture-auth') }, beforeSnapshotTreeSha256: nativeSnapshot.treeSha256,
    afterSnapshotTreeSha256: nativeSnapshot.treeSha256, projectionSha256: canonicalJsonSha256(projection), receiptSha256: canonicalJsonSha256(nativeReceipt),
  };
  const canaryBinding = {
    version: 'native-canary-binding/v1' as const, runId: RUN, windowId: WINDOW, authority: { repositoryUrl: 'https://example.invalid/repo', commit: '1'.repeat(40), tree: TREE },
    sourceInventorySha256: sourceInventory.inventorySha256, liveRoot, nativeRoot, candidateRoot, artifactRoot: nativeArtifactRoot, policySha256: mapPolicy.policySha256,
    provider: { provider: 'fixture-provider', model: 'fixture-model', authorizationRefSha256: sha256Hex('fixture-auth') },
  };
  const artifactDirectory = join(artifactRoot, RUN);
  mkdirSync(artifactDirectory);
  writeJson(join(artifactDirectory, 'live-idle-observation.json'), observation);
  writeJson(join(artifactDirectory, 'live-terminal-observation.json'), terminalObservation);
  writeJson(join(artifactDirectory, 'copy-manifests.json'), { live: liveSnapshot, native: nativeSnapshot, candidate: candidateSnapshot });
  writeJson(join(artifactDirectory, 'canary-binding.json'), canaryBinding);
  writeJson(join(artifactDirectory, 'native-receipt.json'), nativeReceipt);
  writeJson(join(artifactDirectory, 'native-binding.json'), nativeBinding);
  writeJson(join(artifactDirectory, 'native-projection.json'), projection);
  writeJson(join(artifactDirectory, 'candidate-projection.json'), projection);
  writeJson(join(artifactDirectory, 'map-policy.json'), mapPolicy);
  writeJson(join(artifactDirectory, 'map-ir.json'), [mapIR]);
  writeJson(join(artifactDirectory, 'reduction-plan.json'), reduction);
  writeJson(join(artifactDirectory, 'candidate-snapshot.json'), postSnapshot);
  const comparison = (await import('../../../../../tools/llm-wiki-cli/src/headless/comparison')).compareNativeCandidate({ native: projection, candidate: projection, requiredSourcePaths: [SOURCE_PATH] });
  writeJson(join(artifactDirectory, 'semantic-comparison.json'), comparison);
  writeJson(join(artifactDirectory, 'transaction-plan.json'), { ...plan, operations: plan.operations.map(operation => ({ ...operation, before: { ...operation.before, bytes: operation.before.bytes === null ? null : Buffer.from(operation.before.bytes).toString('base64') }, after: { ...operation.after, bytes: operation.after.bytes === null ? null : Buffer.from(operation.after.bytes).toString('base64') } })) });
  writeJson(join(artifactDirectory, 'transaction-receipt.json'), { transactionId: plan.transactionId, fence: plan.fence, planHash: plan.planHash, status: 'committed', restored: false });
  const journal = new TransactionJournal(join(artifactDirectory, 'transaction-journal.jsonl'));
  await journal.append({ version: 'transaction-journal/v1', transactionId: plan.transactionId, fence: plan.fence, planHash: plan.planHash, kind: 'prepared', plan });
  await journal.append({ version: 'transaction-journal/v1', transactionId: plan.transactionId, fence: plan.fence, planHash: plan.planHash, kind: 'cas-checked', operationIndex: 0 });
  await journal.append({ version: 'transaction-journal/v1', transactionId: plan.transactionId, fence: plan.fence, planHash: plan.planHash, kind: 'applied', operationIndex: 0 });
  await journal.append({ version: 'transaction-journal/v1', transactionId: plan.transactionId, fence: plan.fence, planHash: plan.planHash, kind: 'committed' });
  const ledger = new ReplayLedger(join(artifactDirectory, 'replay-ledger.jsonl'), { lockPath: join(artifactDirectory, 'replay.lock') });
  ledger.append({ runId: RUN, nonce: 'fixture', fence: 1, payload: { run_id: RUN, transaction_id: plan.transactionId, plan_sha256: plan.planHash } }, signer);
  const terminalRoot = createTerminalRoot({ runId: RUN, directory: artifactDirectory, signer, ledgerRootHash: ledger.rootHash() });
  writeJson(join(artifactDirectory, 'terminal-run-root.json'), terminalRoot);
  return { artifactDirectory, registry, options: { directory: artifactDirectory, registry, expectedRunId: RUN, expectedWindowId: WINDOW, expectedLiveRoot: liveRoot, expectedNativeRoot: nativeRoot, expectedCandidateRoot: candidateRoot, expectedArtifactRoot: nativeArtifactRoot, expectedAuthority: canaryBinding.authority, sourceInventory, expectedProvider: canaryBinding.provider, liveRoot, now: now + 2000 }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('native canary artifact verifier full fixture', () => {
  it('accepts a complete independently bound artifact set', async () => {
    const fixture = await makeFixture();
    try { const result = await independentlyVerifyNativeCanaryArtifacts(fixture.options); expect(result.ok).toBe(true); expect(result.liveUnchanged).toBe(true); }
    finally { fixture.cleanup(); }
  });

  it('rejects a post-snapshot mutation even when the terminal root is unchanged', async () => {
    const fixture = await makeFixture();
    try {
      const target = join(fixture.artifactDirectory, 'map-policy.json');
      writeFileSync(target, Buffer.from(`${readFileSync(target, 'utf8')} `));
      await expect(independentlyVerifyNativeCanaryArtifacts(fixture.options)).rejects.toMatchObject({ issues: [expect.objectContaining({ code: expect.stringMatching(/artifact-mutated|terminal-root-invalid/u) })] });
    } finally { fixture.cleanup(); }
  });

  it('rejects native/candidate copy drift during mandatory independent recapture', async () => {
    const fixture = await makeFixture();
    try {
      writeFileSync(join(fixture.options.expectedCandidateRoot, 'generated.md'), `${GENERATED_TEXT}tampered\n`);
      await expect(independentlyVerifyNativeCanaryArtifacts(fixture.options)).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'live-drift' })] });
    } finally { fixture.cleanup(); }
  });
});
