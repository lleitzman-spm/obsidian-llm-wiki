import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSourceInventory,
  type SourceInventory,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight';
import {
  createSigner,
  createKeyRegistry,
  generateEd25519KeyPair,
  independentlyVerifyRun,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { StalePreconditionError } from '../../../../../tools/llm-wiki-cli/src/headless/transaction';
import {
  runHeadlessCanary,
  type HeadlessCanaryInput,
} from '../../../../../tools/llm-wiki-cli/src/headless/orchestrator';
import { independentlyVerifyRunArtifacts } from '../../../../../tools/llm-wiki-cli/src/headless/verification';

const roots: string[] = [];
const AUTHORITY_TREE = 'a'.repeat(64);
const AUTHORITY_COMMIT = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);
const SCOPES = [
  'spm-brain-preflight-sign',
  'spm-brain-run-manifest-sign',
  'spm-brain-worker-artifact-sign',
  'spm-brain-candidate-plan-sign',
  'spm-brain-candidate-receipt-sign',
  'spm-brain-replay-append',
  'spm-brain-run-terminalize',
];

async function fixture(): Promise<{
  input: HeadlessCanaryInput;
  base: string;
  sourceInventory: SourceInventory;
}> {
  const base = await mkdtemp(join(tmpdir(), 'spm-headless-orchestrator-'));
  roots.push(base);
  const liveRoot = join(base, 'live-vault');
  const nativeRoot = join(base, 'native-copy');
  const candidateRoot = join(base, 'candidate-copy');
  const artifactRoot = join(base, 'headless-artifacts');
  await Promise.all([liveRoot, nativeRoot, candidateRoot, artifactRoot].map(path => mkdir(path, { recursive: true })));
  // The production snapshot contract rejects an empty tree. Keep the live
  // fixture deterministic while exercising the real copied-vault path.
  await writeFile(join(liveRoot, 'vault-seed.md'), '# Test vault seed\n', 'utf8');
  const contents = new Map([
    ['docs/alpha.md', '# Alpha\nAlpha is an entity.\n'],
    ['docs/beta.md', '# Beta\nBeta is a procedure.\n'],
    ['docs/gamma.md', '# Gamma\nGamma is a control.\n'],
  ]);
  const git = async (args: readonly string[]) => {
    if (args[0] === 'ls-tree') {
      const records = [...contents.entries()].map(([path, content], index) => `100644 blob ${String(index + 1).padStart(40, '0')}\t${new TextEncoder().encode(content).byteLength}\t${path}`).join('\0');
      return { status: 0, stdout: `${records}\0` };
    }
    if (args[0] === 'show') {
      const path = String(args[1]).slice(AUTHORITY_TREE.length + 1);
      return { status: 0, stdout: contents.get(path) ?? '' };
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  const sourceInventory = await buildSourceInventory({
    authorityTree: AUTHORITY_TREE,
    git,
    selector: { version: 'spm-test-selector/v1', include: ['docs/**/*.md'], exclude: [] },
  });
  const keyPair = generateEd25519KeyPair();
  const signer = createSigner(keyPair.privateKey, { scopes: SCOPES });
  const trustedRegistry = createKeyRegistry({ trustedKeys: [signer] });
  const sourceDescriptors = new Map([
    ['docs/alpha.md', { pageType: 'entity' as const, label: 'Alpha' }],
    ['docs/beta.md', { pageType: 'concept' as const, label: 'Beta' }],
    ['docs/gamma.md', { pageType: 'concept' as const, label: 'Gamma' }],
  ]);
  const input: HeadlessCanaryInput = {
    activationMode: 'synthetic-scaffold-only',
    runId: 'run-three-source',
    jobId: 'job-three-source',
    windowId: 'window-test',
    vaultIdentity: 'spm-test-vault',
    liveRoot,
    nativeRoot,
    candidateRoot,
    artifactRoot,
    idle: true,
    authority: { repositoryUrl: 'https://github.com/example/spm-sources', commit: AUTHORITY_COMMIT, tree: AUTHORITY_TREE },
    sourceInventory,
    sourceContents: contents,
    sourceDescriptors,
    runtime: {
      engineVersion: 'headless-test/v1', bundleSha256: DIGEST, schemaSha256: DIGEST,
      vocabularySha256: DIGEST, policyPackSha256: DIGEST, promptVersion: 'prompt-test/v1',
    },
    settings: {
      fullSettingsBytes: new TextEncoder().encode('{"apiKey":"must-not-appear","pageGenerationConcurrency":5}'),
      value: { pageGenerationConcurrency: 5, apiKey: 'must-not-appear', entityTags: ['person', 'property'], conceptTags: ['procedure', 'control'] },
    },
    providerName: 'deterministic-test-provider',
    model: 'test-model',
    workerIds: ['worker-a', 'worker-b', 'worker-c'],
    scheduler: {
      schedule: async jobs => {
        const results = [];
        for (const job of jobs) results.push(await job.run());
        return results;
      },
    },
    trustedRegistry,
    provider: {
      map: async source => [{
        artifactId: `artifact-${source.sourceId.slice(0, 16)}`,
        sourceId: source.sourceId,
        pageType: source.pageType,
        label: source.label,
        data: { content: source.content },
      }],
    },
    signer,
    now: () => Date.parse('2026-08-20T04:00:00.000Z'),
  };
  return { input, base, sourceInventory };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('headless canary orchestrator', () => {
  it('runs a three-source copied-vault canary through preflight, map/reduce, transaction, projection, and independent verification', async () => {
    const { input } = await fixture();
    const result = await runHeadlessCanary(input);

    expect(result.sources).toHaveLength(3);
    expect(result.enginePlan.complete).toBe(true);
    expect(result.workerArtifacts).toHaveLength(3);
    expect(result.transactionReceipt.status).toBe('committed');
    expect(result.correctness.semanticEquivalent).toBe(true);
    expect(result.correctness.matchedStatementIds.length).toBeGreaterThan(0);
    expect(result.independentVerification.ok).toBe(true);
    expect(result.independentVerification.terminalRootCrypto?.rootHash).toBe(result.terminalRoot.rootHash);
    expect(result.copySnapshots.native.treeSha256).toBe(result.copySnapshots.source.treeSha256);
    expect(result.copySnapshots.candidate.treeSha256).toBe(result.copySnapshots.source.treeSha256);
    expect(result.preflight.snapshotTreeHash).toBe(result.copySnapshots.source.treeSha256);
    expect(result.activationMode).toBe('synthetic-scaffold-only');
    expect(result.preflightCapture.capture_type).toBe('live');
    expect(result.runManifest.target_vault.copy_roots.native).toBe(result.preflightCapture.copy_roots.native);
    expect(result.runManifest.target_vault.copy_roots.candidate).toBe(result.preflightCapture.copy_roots.candidate);
    const persistedPreflight = JSON.parse(await readFile(join(result.artifactDirectory, 'preflight-capture.json'), 'utf8')) as { capture_type: string; run_id: string };
    expect(persistedPreflight).toMatchObject({ capture_type: 'live', run_id: input.runId });

    const liveEntries = await readdir(input.liveRoot);
    expect(liveEntries).toEqual(['vault-seed.md']);
    const receiptText = await readFile(join(result.artifactDirectory, 'run-manifest.json'), 'utf8');
    expect(receiptText).not.toContain('must-not-appear');
    const generated = await readdir(join(input.candidateRoot, 'headless-generated', 'entity'));
    expect(generated).toHaveLength(1);
    expect(await readFile(join(input.candidateRoot, 'headless-generated', 'entity', generated[0]), 'utf8')).toContain('Alpha is an entity');
  });

  it('requires an explicit injected scheduler instead of silently using Promise.all', async () => {
    const { input } = await fixture();
    const missingScheduler = { ...input, scheduler: undefined } as unknown as HeadlessCanaryInput;
    await expect(runHeadlessCanary(missingScheduler)).rejects.toThrow(/injected scheduler|Promise\.all/i);
  });

  it('rejects non-opaque run IDs before creating an artifact path', async () => {
    const { input } = await fixture();
    const unsafe = { ...input, runId: '../escaped-run' };
    await expect(runHeadlessCanary(unsafe)).rejects.toThrow(/opaque|path-safe/i);
    expect(await readdir(input.candidateRoot)).toEqual([]);
    expect(await readdir(input.artifactRoot)).toEqual([]);
  });

  it('refuses a non-fresh candidate root instead of accepting without a copied-vault snapshot', async () => {
    const { input } = await fixture();
    await writeFile(join(input.candidateRoot, 'preexisting.md'), 'must not be overwritten\n', 'utf8');
    await expect(runHeadlessCanary({ ...input, runId: 'run-non-fresh-copy' })).rejects.toThrow(/destination must be empty/i);
    expect(await readFile(join(input.candidateRoot, 'preexisting.md'), 'utf8')).toBe('must not be overwritten\n');
    expect(await readdir(input.artifactRoot)).toEqual([]);
  });

  it('copies the observed live vault into both isolated roots before candidate work', async () => {
    const { input } = await fixture();
    await writeFile(join(input.liveRoot, 'existing-note.md'), '# Existing note\n', 'utf8');
    await runHeadlessCanary({ ...input, runId: 'run-copied-vault' });
    expect(await readFile(join(input.nativeRoot, 'existing-note.md'), 'utf8')).toBe('# Existing note\n');
    expect(await readFile(join(input.candidateRoot, 'existing-note.md'), 'utf8')).toBe('# Existing note\n');
  });

  it('fails closed when native-compatible activation lacks native snapshots and comparison', async () => {
    const { input } = await fixture();
    const nativeMode = { ...input, activationMode: 'native-compatible' as const };
    await expect(runHeadlessCanary(nativeMode)).rejects.toThrow(/native.*candidate.*snapshot.*comparison|fail-closed/i);
  });

  it('requires a signer present in the pinned trusted registry', async () => {
    const { input } = await fixture();
    const untrustedSigner = createSigner(generateEd25519KeyPair().privateKey, { scopes: SCOPES });
    const untrusted = { ...input, signer: untrustedSigner };
    await expect(runHeadlessCanary(untrusted)).rejects.toThrow(/unknown signing key|trusted registry|pinned/i);
  });

  it('rejects an artifact that escapes its source lane before any generated candidate write', async () => {
    const { input } = await fixture();
    const wrongSource: HeadlessCanaryInput = {
      ...input,
      runId: 'run-wrong-source',
      provider: {
        map: async source => [{
          artifactId: `artifact-${source.sourceId.slice(0, 16)}`,
          sourceId: 'not-an-inventory-source',
          pageType: source.pageType,
          label: source.label,
          data: { content: source.content },
        }],
      },
    };
    await expect(runHeadlessCanary(wrongSource)).rejects.toThrow(/escaped source|inventory-bound/i);
    expect(await readdir(input.candidateRoot)).toEqual(['vault-seed.md']);
  });

  it('uses the real filesystem lease and restores prior writes on a stale compare-and-swap', async () => {
    const { input } = await fixture();
    let injected = false;
    const stale: HeadlessCanaryInput = {
      ...input,
      runId: 'run-stale-cas',
      transactionFaults: {
        beforeCompareAndSwap: async ({ operation, operationIndex }) => {
          if (!injected && operationIndex === 1 && operation) {
            injected = true;
            await writeFile(join(input.candidateRoot, operation.path), 'outside-writer');
          }
        },
      },
    };
    await expect(runHeadlessCanary(stale)).rejects.toBeInstanceOf(StalePreconditionError);
    expect(injected).toBe(true);
    const generated = join(input.candidateRoot, 'headless-generated');
    const files: string[] = [];
    const remaining: string[] = [];
    for (const type of ['entity', 'concept']) {
      for (const file of await readdir(join(generated, type)).catch(() => [])) {
        files.push(file);
        remaining.push(await readFile(join(generated, type, file), 'utf8'));
      }
    }
    expect(files).toHaveLength(1);
    expect(remaining).toContain('outside-writer');
  });

  it('rejects receipt substitution when the independently verified terminal root no longer matches', async () => {
    const { input } = await fixture();
    const result = await runHeadlessCanary({ ...input, runId: 'run-substitution' });
    const receiptPath = join(result.artifactDirectory, 'candidate-receipt.json');
    const original = await readFile(receiptPath, 'utf8');
    await writeFile(receiptPath, original.replace('"status": "accepted"', '"status": "rejected"'), 'utf8');
    await expect(Promise.resolve().then(() => independentlyVerifyRun({
      directory: result.artifactDirectory,
      registry: createKeyRegistry({ trustedKeys: [input.signer] }),
      expectedRunId: 'run-substitution',
    }))).rejects.toThrow(/root|artifact|hash/i);
  });

  it('does not accept a durable run when the full artifact set is incomplete', async () => {
    const { input } = await fixture();
    const result = await runHeadlessCanary({ ...input, runId: 'run-missing-artifact' });
    await rm(join(result.artifactDirectory, 'worker-artifacts.json'));
    await expect(Promise.resolve().then(() => independentlyVerifyRunArtifacts({
      directory: result.artifactDirectory,
      registry: input.trustedRegistry,
      expectedRunId: input.runId,
    }))).rejects.toThrow(/worker-artifacts|missing|artifact/i);
  });
});
