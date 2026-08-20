import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DOMAINS,
  ReplayLedger,
  buildMerkleTree,
  buildMerkleTreeFromDirectory,
  canonicalizeJson,
  createKeyDelegation,
  createKeyRegistry,
  createSigner,
  createTerminalRoot,
  domainBytes,
  generateEd25519KeyPair,
  independentlyVerifyRun,
  verifyTerminalRoot,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';

describe('headless crypto contracts', () => {
  it('canonicalizes supported JSON values deterministically and rejects non-JSON numbers', () => {
    expect(canonicalizeJson({ b: 1, a: 'x', nested: [true, null, -0] })).toBe(
      '{"a":"x","b":1,"nested":[true,null,0]}',
    );
    expect(canonicalizeJson({ 'é': 1, é: 2 })).toBe('{"é":2,"é":1}');
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/finite|JSON/i);
    expect(() => canonicalizeJson({ value: undefined })).toThrow(/JSON|JCS/i);
  });

  it('exposes only ADR domains and appends exactly one NUL byte', () => {
    expect(Object.values(DOMAINS)).toHaveLength(26);
    const bytes = domainBytes(DOMAINS.REPLAY_ENTRY);
    expect(bytes.subarray(0, -1).toString('utf8')).toBe(DOMAINS.REPLAY_ENTRY);
    expect(bytes[bytes.length - 1]).toBe(0);
    expect(() => domainBytes('spm-brain/replay-entry/v2')).toThrow(/domain/i);
  });

  it('binds Ed25519 key IDs and delegated scopes to an independently verified terminal root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'spm-crypto-root-'));
    try {
      await writeFile(join(rootDir, 'native-receipt.json'), '{"ok":true}\n');
      await writeFile(join(rootDir, 'replay-ledger.jsonl'), 'ledger\n');

      const authority = generateEd25519KeyPair();
      const coordinator = generateEd25519KeyPair();
      const authoritySigner = createSigner(authority.privateKey, {
        scopes: ['spm-brain-key-delegate', 'spm-brain-run-terminalize'],
      });
      const coordinatorSigner = createSigner(coordinator.privateKey, {
        scopes: ['spm-brain-run-terminalize'],
      });
      const delegation = createKeyDelegation({
        parentSigner: authoritySigner,
        childPublicKey: coordinator.publicKey,
        scopes: ['spm-brain-run-terminalize'],
        runId: 'run-1',
      });
      const registry = createKeyRegistry({
        trustedKeys: [authoritySigner],
        delegations: [delegation],
      });

      const root = createTerminalRoot({
        runId: 'run-1',
        directory: rootDir,
        signer: coordinatorSigner,
      });
      await writeFile(join(rootDir, 'terminal-run-root.json'), JSON.stringify(root));

      expect(verifyTerminalRoot(root, { directory: rootDir, registry })).toMatchObject({
        ok: true,
        rootHash: root.rootHash,
      });
      expect(
        independentlyVerifyRun({ directory: rootDir, registry }),
      ).toMatchObject({ ok: true, rootHash: root.rootHash });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects terminal-root tampering, unknown keys, and an unscoped signer', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'spm-crypto-tamper-'));
    try {
      await writeFile(join(rootDir, 'candidate-receipt.json'), '{"candidate":1}\n');
      const authority = generateEd25519KeyPair();
      const coordinator = generateEd25519KeyPair();
      const authoritySigner = createSigner(authority.privateKey, {
        scopes: ['spm-brain-key-delegate', 'spm-brain-run-terminalize'],
      });
      const coordinatorSigner = createSigner(coordinator.privateKey, {
        scopes: ['spm-brain-run-terminalize'],
      });
      const delegation = createKeyDelegation({
        parentSigner: authoritySigner,
        childPublicKey: coordinator.publicKey,
        scopes: ['spm-brain-run-terminalize'],
        runId: 'run-2',
      });
      const registry = createKeyRegistry({ trustedKeys: [authoritySigner], delegations: [delegation] });
      const root = createTerminalRoot({ runId: 'run-2', directory: rootDir, signer: coordinatorSigner });
      await writeFile(join(rootDir, 'terminal-run-root.json'), JSON.stringify(root));

      expect(() => verifyTerminalRoot({ ...root, manifestHash: 'tampered' }, { directory: rootDir, registry })).toThrow(/signature|digest|hash/i);

      await writeFile(join(rootDir, 'candidate-receipt.json'), '{"candidate":2}\n');
      expect(() => verifyTerminalRoot(root, { directory: rootDir, registry })).toThrow(/Merkle|artifact|root|hash/i);

      await writeFile(join(rootDir, 'candidate-receipt.json'), '{"candidate":1}\n');
      const unknownRegistry = createKeyRegistry({ trustedKeys: [authoritySigner] });
      expect(() => verifyTerminalRoot(root, { directory: rootDir, registry: unknownRegistry })).toThrow(/unknown|key/i);

      const unscoped = createSigner(generateEd25519KeyPair().privateKey);
      expect(() => createTerminalRoot({ runId: 'run-2', directory: rootDir, signer: unscoped })).toThrow(/scope/i);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('attenuates delegated scopes and run/fence/source/partition constraints', () => {
    const authorityPair = generateEd25519KeyPair();
    const authority = createSigner(authorityPair.privateKey, {
      scopes: ['spm-brain-key-delegate', 'spm-brain-run-terminalize'],
      constraints: {
        runId: 'run-attenuation',
        fence: 11,
        sourceIdentity: 'source-a',
        partition: 'partition-a',
      },
    });
    const childPair = generateEd25519KeyPair();
    const constrained = {
      runId: 'run-attenuation',
      fence: 11,
      sourceIdentity: 'source-a',
      partition: 'partition-a',
    } as const;

    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize', 'spm-brain-replay-append'],
      ...constrained,
    })).toThrow(/scope|attenuat|recursive/i);
    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
      runId: 'different-run',
    })).toThrow(/runId|attenuat|constraint/i);
    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
      fence: 12,
    })).toThrow(/fence|attenuat|constraint/i);
    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
      sourceIdentity: 'source-b',
    })).toThrow(/source|attenuat|constraint/i);
    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
      partition: 'partition-b',
    })).toThrow(/partition|attenuat|constraint/i);
    expect(() => createKeyDelegation({
      parentSigner: authority,
      childPublicKey: authority.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
    })).toThrow(/self|delegat/i);

    // A signed overclaim from a replacement Signer object must still be
    // rejected against the narrower parent record held by the registry.
    const registry = createKeyRegistry({ trustedKeys: [authority] });
    const overclaimingAuthority = createSigner(authorityPair.privateKey, {
      scopes: ['spm-brain-key-delegate', 'spm-brain-run-terminalize', 'spm-brain-replay-append'],
      constraints: constrained,
    });
    expect(() => createKeyRegistry({ trustedKeys: [authority, overclaimingAuthority] })).toThrow(/replac|collision/i);
    const overclaim = createKeyDelegation({
      parentSigner: overclaimingAuthority,
      childPublicKey: childPair.publicKey,
      scopes: ['spm-brain-run-terminalize', 'spm-brain-replay-append'],
      ...constrained,
    });
    expect(() => registry.addDelegation(overclaim)).toThrow(/scope|attenuat|recursive/i);

    // A delegated child cannot recursively grant a scope absent from its own
    // registry record, even if a caller supplies a replacement broad Signer.
    const delegatedChildPair = generateEd25519KeyPair();
    const firstDelegation = createKeyDelegation({
      parentSigner: authority,
      childPublicKey: delegatedChildPair.publicKey,
      scopes: ['spm-brain-key-delegate'],
      ...constrained,
    });
    const recursiveRegistry = createKeyRegistry({
      trustedKeys: [authority],
      delegations: [firstDelegation],
    });
    const replacementChild = createSigner(delegatedChildPair.privateKey, {
      scopes: ['spm-brain-key-delegate', 'spm-brain-run-terminalize'],
      constraints: constrained,
    });
    const grandchildPair = generateEd25519KeyPair();
    const recursiveEscalation = createKeyDelegation({
      parentSigner: replacementChild,
      childPublicKey: grandchildPair.publicKey,
      scopes: ['spm-brain-run-terminalize'],
      ...constrained,
    });
    expect(() => recursiveRegistry.addDelegation(recursiveEscalation)).toThrow(/scope|attenuat|recursive/i);
  });

  it('hash-chains the replay ledger and rejects duplicate tuples and tampering', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'spm-crypto-ledger-'));
    try {
      const keyPair = generateEd25519KeyPair();
      const signer = createSigner(keyPair.privateKey, { scopes: ['spm-brain-replay-append'] });
      const registry = createKeyRegistry({ trustedKeys: [signer] });
      const ledgerPath = join(rootDir, 'replay-ledger.jsonl');
      const ledger = new ReplayLedger(ledgerPath, {
        registry,
        lockPath: join(rootDir, 'replay-ledger.lock'),
      });

      ledger.append({ runId: 'run-3', nonce: 'nonce-1', fence: 7, payload: { source: 'a' } }, signer);
      expect(() => ledger.append({ runId: 'run-3', nonce: 'nonce-1', fence: 7 }, signer)).toThrow(/duplicate|replay/i);
      expect(ledger.verify()).toMatchObject({ ok: true, entryCount: 1 });

      const original = await readFile(ledgerPath, 'utf8');
      await writeFile(ledgerPath, original.replace('"fence":7', '"fence":8'));
      expect(() => ledger.verify()).toThrow(/chain|hash|signature|replay/i);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('requires an explicit ledger lock and rejects cross-process contention', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'spm-crypto-ledger-lock-'));
    try {
      const keyPair = generateEd25519KeyPair();
      const signer = createSigner(keyPair.privateKey, { scopes: ['spm-brain-replay-append'] });
      const registry = createKeyRegistry({ trustedKeys: [signer] });
      const ledgerPath = join(rootDir, 'replay-ledger.jsonl');
      const lockPath = join(rootDir, 'replay-ledger.lock');
      const unlocked = new ReplayLedger(ledgerPath, { registry });
      expect(() => unlocked.append({ runId: 'run-lock', nonce: 'n', fence: 1 }, signer)).toThrow(/lock/i);

      const holderScript = [
        "const fs = require('node:fs');",
        "const fd = fs.openSync(process.env.SPM_CRYPTO_LOCK, 'wx', 0o600);",
        "process.stdout.write('ready');",
        "setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(process.env.SPM_CRYPTO_LOCK); }, 300);",
      ].join('\n');
      const holder = spawn(process.execPath, ['-e', holderScript], {
        env: { ...process.env, SPM_CRYPTO_LOCK: lockPath },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      await new Promise<void>((resolve, reject) => {
        holder.stdout?.once('data', data => data.toString() === 'ready' ? resolve() : reject(new Error('lock holder did not signal readiness')));
        holder.once('error', reject);
      });
      const contended = new ReplayLedger(ledgerPath, { registry, lockPath, lockTimeoutMs: 0 });
      expect(() => contended.append({ runId: 'run-lock', nonce: 'same-nonce', fence: 1 }, signer)).toThrow(/lock/i);
      await new Promise<void>(resolve => holder.once('close', () => resolve()));

      const ledger = new ReplayLedger(ledgerPath, { registry, lockPath });
      ledger.append({ runId: 'run-lock', nonce: 'same-nonce', fence: 1 }, signer);
      expect(ledger.verify()).toMatchObject({
        ok: true,
        entryCount: 1,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects reserved or cyclic terminal artifacts and duplicate normalized paths', () => {
    expect(() => buildMerkleTree([
      { path: 'terminal-run-root.json', bytes: new Uint8Array([1]) },
    ])).toThrow(/leaf|terminal|reserved/i);
    expect(() => buildMerkleTree([
      { path: 'a/../receipt.json', bytes: new Uint8Array([1]) },
      { path: 'receipt.json', bytes: new Uint8Array([2]) },
    ])).toThrow(/path|duplicate|normalized/i);
  });

  it('rejects a symlinked Merkle root before following it', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'spm-crypto-target-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'spm-crypto-link-'));
    const linkPath = join(linkParent, 'root-junction');
    try {
      try {
        await symlink(targetDir, linkPath, 'junction');
      } catch (error) {
        // Windows can disable junction creation in hardened CI.  Do not turn
        // that host policy into a false crypto failure.
        if (['EPERM', 'EACCES', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
      }
      expect(() => buildMerkleTreeFromDirectory(linkPath)).toThrow(/symlink|reparse|root/i);
    } finally {
      await rm(linkParent, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
