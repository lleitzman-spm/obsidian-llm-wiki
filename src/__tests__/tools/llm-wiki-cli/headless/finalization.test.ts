import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSigner,
  type Signer,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import {
  finalizeRun,
  prepareFinalization,
  recoverFinalization,
  writeAtomically,
  type FinalizeRunInput,
  type ReplayAppender,
} from '../../../../../tools/llm-wiki-cli/src/headless/finalization';

const HASH = 'a'.repeat(64);

interface Fixture {
  root: string;
  live: string;
  artifact: string;
  state: string;
  signer: Signer;
  input: Omit<FinalizeRunInput, 'transaction' | 'replayAppender' | 'files' | 'replay'>;
}

const roots: string[] = [];

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'spm-finalization-'));
  roots.push(root);
  const signer = createSigner(generateKeyPairSync('ed25519').privateKey, {
    scopes: ['spm-brain-run-terminalize', 'spm-brain-replay-append'],
  });
  const artifact = join(root, 'evidence', 'run-1');
  const state = join(root, 'state', 'run-1');
  return {
    root,
    live: join(root, 'live-vault'),
    artifact,
    state,
    signer,
    input: {
      runId: 'run-1',
      transactionId: 'tx-1',
      planHash: HASH,
      fence: 7,
      artifactRoot: artifact,
      stateRoot: state,
      forbiddenRoots: [join(root, 'live-vault')],
      signer,
      manifestHash: HASH,
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    },
  };
}

function files() {
  return [
    { path: 'run-manifest.json', bytes: '{"run":"run-1"}\n' },
    { path: 'candidate-receipt.json', bytes: '{"status":"accepted"}\n' },
    { path: 'candidate-receipt-envelope.json', bytes: '{"signed":true}\n' },
  ];
}

function appender(artifactRoot: string, failAfterWrite = false): ReplayAppender & { calls: number } {
  let calls = 0;
  let durable = false;
  return {
    get calls() { return calls; },
    async ensureAppended(intent) {
      calls += 1;
      const path = join(artifactRoot, intent.artifactPath);
      if (!durable) {
        durable = true;
        writeAtomically(path, '{"entry":"one"}\n');
        if (failAfterWrite) throw new Error('crash after replay fsync');
      }
      const content = await readFile(path);
      const hash = createHash('sha256').update(content).digest('hex');
      return { entryHash: HASH, ledgerRootHash: hash, artifactPath: intent.artifactPath, artifactSha256: hash };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('crash-safe evidence finalization', () => {
  it('durably prepares signed pending state and finalizes only after commit', async () => {
    const f = await fixture();
    const replay = appender(f.artifact);
    prepareFinalization({ ...f.input, files: files(), replay: { nonce: 'nonce-run-1-0001', artifactPath: 'replay-ledger.jsonl' } });
    const result = await finalizeRun({
      ...f.input,
      files: files(),
      replay: { nonce: 'nonce-run-1-0001', artifactPath: 'replay-ledger.jsonl' },
      transaction: { status: 'committed', transactionId: 'tx-1', planHash: HASH, fence: 7 },
      replayAppender: replay,
    });
    expect(result.state).toBe('terminal');
    expect(replay.calls).toBe(1);
    expect(await readFile(join(f.artifact, 'terminal-run-root.json'), 'utf8')).toContain('run-1');
    const recovered = await recoverFinalization({ ...f.input, transaction: { status: 'committed', transactionId: 'tx-1', planHash: HASH, fence: 7 }, replayAppender: replay });
    expect(recovered.state).toBe('terminal');
    expect(replay.calls).toBe(1);
  });

  it('does not write accepted evidence when the transaction has no commit', async () => {
    const f = await fixture();
    const replay = appender(f.artifact);
    prepareFinalization({ ...f.input, files: files(), replay: { nonce: 'nonce-run-1-0002', artifactPath: 'replay-ledger.jsonl' } });
    const result = await finalizeRun({
      ...f.input,
      files: files(),
      replay: { nonce: 'nonce-run-1-0002', artifactPath: 'replay-ledger.jsonl' },
      transaction: { status: 'no-commit', transactionId: 'tx-1', planHash: HASH, fence: 7, reason: 'restored' },
      replayAppender: replay,
    });
    expect(result.state).toBe('failed');
    await expect(readFile(join(f.artifact, 'candidate-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(replay.calls).toBe(0);
  });

  it('leaves an active transaction in progress and recovers a crash after replay fsync', async () => {
    const f = await fixture();
    const replay = appender(f.artifact, true);
    const intent = { nonce: 'nonce-run-1-0003', artifactPath: 'replay-ledger.jsonl' };
    prepareFinalization({ ...f.input, files: files(), replay: intent });
    const active = await finalizeRun({
      ...f.input,
      files: files(),
      replay: intent,
      transaction: { status: 'in-progress', transactionId: 'tx-1', planHash: HASH, fence: 7 },
      replayAppender: replay,
    });
    expect(active.state).toBe('in-progress');
    const crashed = await finalizeRun({
      ...f.input,
      files: files(),
      replay: intent,
      transaction: { status: 'committed', transactionId: 'tx-1', planHash: HASH, fence: 7 },
      replayAppender: replay,
    });
    expect(crashed.state).toBe('frozen');
    const recovered = await recoverFinalization({ ...f.input, transaction: { status: 'committed', transactionId: 'tx-1', planHash: HASH, fence: 7 }, replayAppender: replay });
    expect(recovered.state).toBe('terminal');
    expect(replay.calls).toBe(2);
  });

  it('rejects evidence roots overlapping the live vault and traversal paths', async () => {
    const f = await fixture();
    expect(() => prepareFinalization({ ...f.input, artifactRoot: f.live, files: files(), replay: { nonce: 'nonce-run-1-0004', artifactPath: 'replay-ledger.jsonl' } })).toThrow(/forbidden|overlap/i);
    expect(() => prepareFinalization({ ...f.input, files: [{ path: '../outside.json', bytes: 'x' }], replay: { nonce: 'nonce-run-1-0004', artifactPath: 'replay-ledger.jsonl' } })).toThrow(/parent|relative|path/i);
  });
});
