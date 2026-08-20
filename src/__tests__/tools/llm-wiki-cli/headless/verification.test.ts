import { describe, expect, it } from 'vitest';

import {
  buildMerkleTree,
  createKeyRegistry,
  createSigner,
  createTerminalRoot,
  generateEd25519KeyPair,
} from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import {
  createTerminalRootContract,
  verifyTerminalRootContract,
} from '../../../../../tools/llm-wiki-cli/src/headless/verification';

const HASH = 'a'.repeat(64);

describe('independent run-artifact verification bridges', () => {
  it('creates and verifies the canonical snake_case terminal-run-root contract', () => {
    const signer = createSigner(generateEd25519KeyPair().privateKey, {
      scopes: ['spm-brain-run-terminalize'],
    });
    const root = createTerminalRoot({
      runId: 'bridge-run',
      signer,
      artifacts: [{ path: 'candidate-receipt.json', bytes: new TextEncoder().encode('{"status":"accepted"}\n') }],
      ledgerRootHash: HASH,
    });
    const contract = createTerminalRootContract(root, {
      journalSha256: HASH,
      replayLedgerSha256: HASH,
      projectionComparisonSha256: HASH,
    }, { signer });

    expect(contract.contract_version).toBe('headless-ingest/v1');
    expect(contract.root_sha256).toBe(root.rootHash);
    expect(contract.signature.signed_digest).toBe(root.rootHash);
    expect(verifyTerminalRootContract(contract, {
      registry: createKeyRegistry({ trustedKeys: [signer] }),
      artifacts: [{ path: 'candidate-receipt.json', bytes: new TextEncoder().encode('{"status":"accepted"}\n') }],
      expectedRunId: 'bridge-run',
      expectedJournalSha256: HASH,
      expectedReplayLedgerSha256: HASH,
      expectedProjectionComparisonSha256: HASH,
    })).toMatchObject({ ok: true, rootSha256: root.rootHash, leafCount: 1 });
  });

  it('rejects a signed-but-invalid root substitution before accepting the tree', () => {
    const signer = createSigner(generateEd25519KeyPair().privateKey, {
      scopes: ['spm-brain-run-terminalize'],
    });
    const artifacts = [{ path: 'candidate-receipt.json', bytes: new TextEncoder().encode('one\n') }];
    const root = createTerminalRoot({ runId: 'tamper-run', signer, artifacts });
    const contract = createTerminalRootContract(root, {
      journalSha256: HASH,
      replayLedgerSha256: HASH,
      projectionComparisonSha256: HASH,
    }, { signer });
    const tampered = {
      ...contract,
      leaves: contract.leaves.map(leaf => ({ ...leaf, artifact_sha256: 'b'.repeat(64) })),
    };

    expect(() => verifyTerminalRootContract(tampered, {
      registry: createKeyRegistry({ trustedKeys: [signer] }),
      artifacts,
    })).toThrow(/leaf|root|signature|hash/i);
  });

  it('keeps the Merkle bridge rooted in the exact sorted tree rather than a caller digest', () => {
    const tree = buildMerkleTree([
      { path: 'b.json', bytes: new TextEncoder().encode('b') },
      { path: 'a.json', bytes: new TextEncoder().encode('a') },
    ]);
    expect(tree.leaves.map(leaf => leaf.path)).toEqual(['a.json', 'b.json']);
  });
});
