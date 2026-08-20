import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTransactionPlan,
  hashBytes,
  MutationBoundaryError,
  NodeTransactionFileSystem,
  ReadbackMismatchError,
  RestoreFailureError,
  StalePreconditionError,
  TransactionEngine,
  TransactionInterruptionError,
  TransactionJournal,
  WriterFrozenError,
  type FenceToken,
  type TransactionLease,
} from '../../../../../tools/llm-wiki-cli/src/headless/transaction';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(nodePath.join(process.env.TEMP ?? process.env.TMP ?? '.', 'transaction-engine-'));
  roots.push(root);
  return root;
}

async function bytes(path: string): Promise<string> {
  return (await readFile(path)).toString('utf8');
}

function leaseFor(log: { assert: FenceToken[]; starts: FenceToken[]; completes: FenceToken[]; freezes: FenceToken[] }): TransactionLease {
  return {
    assertFence: (fence) => { log.assert.push(fence); },
    onRollbackStart: (fence) => { log.starts.push(fence); },
    onRollbackComplete: (fence) => { log.completes.push(fence); },
    freeze: (fence) => { log.freezes.push(fence); },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transaction planner', () => {
  it('plans create, replace, delete, and global-file operations with staged bytes', () => {
    const plan = createTransactionPlan({
      fence: 12,
      transactionId: 'tx-plan',
      current: [
        { path: 'replace.md', bytes: 'old' },
        { path: 'delete.md', bytes: 'remove me' },
        { path: 'index.md', bytes: 'old index', scope: 'global' },
      ],
      desired: [
        { path: 'create.md', bytes: 'created' },
        { path: 'replace.md', bytes: 'new' },
        { path: 'delete.md', bytes: null },
        { path: 'index.md', bytes: 'new index', scope: 'global' },
      ],
    });

    expect(plan.operations.map((operation) => [operation.kind, operation.path, operation.scope])).toEqual([
      ['create', 'create.md', 'page'],
      ['delete', 'delete.md', 'page'],
      ['replace', 'index.md', 'global'],
      ['replace', 'replace.md', 'page'],
    ]);
    expect(plan.operations.find((operation) => operation.path === 'create.md')?.after.bytes).toEqual(new TextEncoder().encode('created'));
    expect(plan.operations.find((operation) => operation.path === 'delete.md')?.before.bytes).toEqual(new TextEncoder().encode('remove me'));
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an explicit precondition that is already stale in the captured snapshot', () => {
    expect(() => createTransactionPlan({
      fence: 'fence',
      transactionId: 'stale-at-plan',
      current: [{ path: 'note.md', bytes: 'current' }],
      desired: [{ path: 'note.md', bytes: 'next', preconditionHash: 'not-the-current-hash' }],
    })).toThrow(StalePreconditionError);
  });

  it('rejects drive-relative, rooted, UNC, and ADS-like target paths', () => {
    const badPaths = ['D:notes.md', '/rooted.md', '\\server\\share\\note.md', 'note.md::$DATA', 'folder:stream'];
    for (const path of badPaths) {
      expect(() => createTransactionPlan({
        fence: 1,
        transactionId: `bad-${path}`,
        current: [],
        desired: [{ path, bytes: 'blocked' }],
      })).toThrow();
    }
  });
});

describe('transaction WAL writer', () => {
  it('applies staged create/replace/delete/global files and writes a durable WAL', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'replace.md'), 'old');
    await writeFile(nodePath.join(root, 'delete.md'), 'delete');
    await writeFile(nodePath.join(root, 'index.md'), 'old index');
    const plan = createTransactionPlan({
      fence: 3,
      transactionId: 'tx-commit',
      current: [
        { path: 'replace.md', bytes: 'old' },
        { path: 'delete.md', bytes: 'delete' },
        { path: 'index.md', bytes: 'old index', scope: 'global' },
      ],
      desired: [
        { path: 'create.md', bytes: 'create' },
        { path: 'replace.md', bytes: 'new' },
        { path: 'delete.md', bytes: null },
        { path: 'index.md', bytes: 'new index', scope: 'global' },
      ],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const journalPath = nodePath.join(root, 'run', 'journal.jsonl');
    const result = await new TransactionEngine({ rootDir: root, journalPath, lease: leaseFor(log) }).apply(plan);

    expect(result.status).toBe('committed');
    expect(await bytes(nodePath.join(root, 'create.md'))).toBe('create');
    expect(await bytes(nodePath.join(root, 'replace.md'))).toBe('new');
    expect(await bytes(nodePath.join(root, 'index.md'))).toBe('new index');
    await expect(readFile(nodePath.join(root, 'delete.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const journal = await new TransactionEngine({ rootDir: root, journalPath, lease: leaseFor(log) }).journal.read();
    expect(journal.map((event) => event.kind)).toContain('prepared');
    expect(journal.map((event) => event.kind)).toContain('committed');
    const prepared = journal.find((event) => event.kind === 'prepared');
    expect(prepared?.plan?.operations.every((operation) => operation.before.bytes !== undefined)).toBe(true);
    expect(prepared?.plan?.operations.find((operation) => operation.path === 'index.md')?.scope).toBe('global');
  });

  it('restores prior operations on an injected stale compare-and-swap failure', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'a.md'), 'a-old');
    await writeFile(nodePath.join(root, 'b.md'), 'b-old');
    const plan = createTransactionPlan({
      fence: 7,
      transactionId: 'tx-stale-cas',
      current: [{ path: 'a.md', bytes: 'a-old' }, { path: 'b.md', bytes: 'b-old' }],
      desired: [{ path: 'a.md', bytes: 'a-new' }, { path: 'b.md', bytes: 'b-new' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    let injected = false;
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      faults: {
        beforeCompareAndSwap: async ({ operation }) => {
          if (!injected && operation?.path === 'b.md') {
            injected = true;
            await writeFile(nodePath.join(root, 'b.md'), 'outside-writer');
          }
        },
      },
    });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(StalePreconditionError);
    expect(await bytes(nodePath.join(root, 'a.md'))).toBe('a-old');
    // The writer never changed b.md after the CAS failed, so rollback does
    // not clobber the external change that caused the stale failure.
    expect(await bytes(nodePath.join(root, 'b.md'))).toBe('outside-writer');
    expect(log.starts).toEqual([7]);
    expect(log.completes).toEqual([7]);
  });

  it('rechecks every target at the final commit boundary', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'a.md'), 'a-old');
    const plan = createTransactionPlan({
      fence: 8,
      transactionId: 'tx-final-cas',
      current: [{ path: 'a.md', bytes: 'a-old' }],
      desired: [{ path: 'a.md', bytes: 'a-new' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      faults: {
        beforeCommit: async () => { await writeFile(nodePath.join(root, 'a.md'), 'outside-writer'); },
      },
    });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(RestoreFailureError);
    expect(await bytes(nodePath.join(root, 'a.md'))).toBe('outside-writer');
    expect((await engine.journal.read()).map((event) => event.kind)).toContain('commit-check-failed');
    expect(log.freezes).toEqual([8]);
    expect(log.starts).toEqual([8]);
    expect(log.completes).toEqual([]);
  });

  it('freezes instead of overwriting a foreign edit discovered during rollback CAS', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'note.md'), 'before');
    const plan = createTransactionPlan({
      fence: 10,
      transactionId: 'tx-foreign-rollback',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      readback: () => false,
      faults: {
        beforeRestore: async () => { await writeFile(nodePath.join(root, 'note.md'), 'foreign-edit'); },
      },
    });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(RestoreFailureError);
    expect(await bytes(nodePath.join(root, 'note.md'))).toBe('foreign-edit');
    expect(log.freezes).toEqual([10]);
  });

  it('leaves an interrupted transaction pending and restores it from the WAL', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'a.md'), 'a-old');
    await writeFile(nodePath.join(root, 'b.md'), 'b-old');
    const journalPath = nodePath.join(root, 'journal.jsonl');
    const plan = createTransactionPlan({
      fence: 'same-fence',
      transactionId: 'tx-interrupt',
      current: [{ path: 'a.md', bytes: 'a-old' }, { path: 'b.md', bytes: 'b-old' }],
      desired: [{ path: 'a.md', bytes: 'a-new' }, { path: 'b.md', bytes: 'b-new' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    let interrupted = false;
    const interruptedEngine = new TransactionEngine({
      rootDir: root,
      journalPath,
      lease: leaseFor(log),
      faults: {
        afterWrite: ({ plan: current }) => {
          if (!interrupted) {
            interrupted = true;
            throw new TransactionInterruptionError('simulated process interruption', current.transactionId);
          }
        },
      },
    });
    await expect(interruptedEngine.apply(plan)).rejects.toBeInstanceOf(TransactionInterruptionError);
    expect(await bytes(nodePath.join(root, 'a.md'))).toBe('a-new');

    const recovered = await new TransactionEngine({ rootDir: root, journalPath, lease: leaseFor(log) }).recover();
    expect(recovered.status).toBe('recovered');
    expect(await bytes(nodePath.join(root, 'a.md'))).toBe('a-old');
    expect(await bytes(nodePath.join(root, 'b.md'))).toBe('b-old');
    expect(log.starts.every((fence) => fence === 'same-fence')).toBe(true);
    expect(log.completes.every((fence) => fence === 'same-fence')).toBe(true);
  });

  it('restores on independent readback mismatch under the same fence', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'note.md'), 'before');
    const plan = createTransactionPlan({
      fence: 99,
      transactionId: 'tx-readback',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      readback: () => ({ ok: false, detail: 'independent verifier disagrees' }),
    });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(ReadbackMismatchError);
    expect(await bytes(nodePath.join(root, 'note.md'))).toBe('before');
    expect(log.starts).toEqual([99]);
    expect(log.completes).toEqual([99]);
    expect((await engine.journal.read()).map((event) => event.kind)).toContain('restored');
  });

  it('freezes acquisition and preserves the WAL when restoration fails', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'note.md'), 'before');
    const plan = createTransactionPlan({
      fence: 101,
      transactionId: 'tx-freeze',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      readback: () => false,
      faults: {
        beforeRestore: () => { throw new Error('restore device unavailable'); },
      },
    });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(RestoreFailureError);
    expect(log.freezes).toEqual([101]);
    expect((await engine.journal.read()).map((event) => event.kind)).toContain('frozen');
    await expect(new TransactionEngine({ rootDir: root, lease: leaseFor(log) }).apply(plan)).rejects.toBeInstanceOf(WriterFrozenError);
  });

  it('keeps a successful filesystem mutation rollback-visible if the applied WAL callback fails', async () => {
    const root = await tempRoot();
    await writeFile(nodePath.join(root, 'note.md'), 'before');
    const plan = createTransactionPlan({
      fence: 11,
      transactionId: 'tx-wal-failure',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    let callbackFailed = false;
    const engine = new TransactionEngine({
      rootDir: root,
      lease: leaseFor(log),
      onJournalEvent: (event) => {
        if (event.kind === 'applied' && !callbackFailed) {
          callbackFailed = true;
          throw new Error('journal append callback failed after mutation');
        }
      },
    });

    await expect(engine.apply(plan)).rejects.toThrow(/journal append callback failed/);
    expect(await bytes(nodePath.join(root, 'note.md'))).toBe('before');
    expect((await engine.journal.read()).map((event) => event.kind)).toContain('restored');
  });

  it('serializes concurrent journal instances and recovery append ordering', async () => {
    const root = await tempRoot();
    const journalPath = nodePath.join(root, 'journal.jsonl');
    const first = new TransactionJournal(journalPath);
    const second = new TransactionJournal(journalPath);
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const journal = index % 2 === 0 ? first : second;
      return journal.append({
        version: 'transaction-journal/v1',
        transactionId: `audit-${index}`,
        fence: 1,
        planHash: `hash-${index}`,
        kind: 'committed',
      });
    }));
    const events = await first.read();
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const recoveryRoot = await tempRoot();
    const recoveryJournalPath = nodePath.join(recoveryRoot, 'journal.jsonl');
    await writeFile(nodePath.join(recoveryRoot, 'note.md'), 'before');
    const recoveryPlan = createTransactionPlan({
      fence: 2,
      transactionId: 'tx-concurrent-recovery',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    let interrupt = true;
    const interrupting = new TransactionEngine({
      rootDir: recoveryRoot,
      journalPath: recoveryJournalPath,
      lease: leaseFor({ assert: [], starts: [], completes: [], freezes: [] }),
      faults: { afterWrite: () => { if (interrupt) { interrupt = false; throw new TransactionInterruptionError(); } } },
    });
    await expect(interrupting.apply(recoveryPlan)).rejects.toBeInstanceOf(TransactionInterruptionError);
    const recoveryLease = leaseFor({ assert: [], starts: [], completes: [], freezes: [] });
    const recoveryEngine = new TransactionEngine({ rootDir: recoveryRoot, journalPath: recoveryJournalPath, lease: recoveryLease });
    const concurrentAudit = new TransactionJournal(recoveryJournalPath);
    await Promise.all([
      recoveryEngine.recover(),
      concurrentAudit.append({
        version: 'transaction-journal/v1',
        transactionId: 'concurrent-audit',
        fence: 2,
        planHash: 'audit',
        kind: 'committed',
      }),
    ]);
    expect(await bytes(nodePath.join(recoveryRoot, 'note.md'))).toBe('before');
    const recoveryEvents = await concurrentAudit.read();
    expect(new Set(recoveryEvents.map((event) => event.sequence)).size).toBe(recoveryEvents.length);
  });

  it('rejects symlink or junction traversal at the vault root and descendants', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(nodePath.join(outside, 'secret.md'), 'secret');
    const link = nodePath.join(root, 'linked');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // Some locked-down Windows runners cannot create junctions. The test is
      // still retained and runs fully where the filesystem permits the setup.
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return;
      throw error;
    }
    const fileSystem = new NodeTransactionFileSystem(root);
    await expect(fileSystem.read('linked/secret.md')).rejects.toThrow(/symlink|junction|reparse/i);
    await expect(fileSystem.write('linked/new.md', new TextEncoder().encode('blocked'))).rejects.toThrow(/symlink|junction|reparse/i);

    const rootAlias = `${root}-alias`;
    try {
      await symlink(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return;
      throw error;
    }
    roots.push(rootAlias);
    const aliased = new NodeTransactionFileSystem(rootAlias);
    await expect(aliased.read('linked/secret.md')).rejects.toThrow(/symlink|junction|reparse/i);
  });

  it('rechecks the supplied CAS precondition inside write and remove boundaries', async () => {
    const root = await tempRoot();
    const target = nodePath.join(root, 'note.md');
    await writeFile(target, 'before');
    const fileSystem = new NodeTransactionFileSystem(root);

    await expect(fileSystem.write('note.md', new TextEncoder().encode('new'), hashBytes(new TextEncoder().encode('foreign'))))
      .rejects.toBeInstanceOf(StalePreconditionError);
    expect(await bytes(target)).toBe('before');

    await expect(fileSystem.remove('note.md', hashBytes(new TextEncoder().encode('foreign'))))
      .rejects.toBeInstanceOf(StalePreconditionError);
    expect(await bytes(target)).toBe('before');
  });

  it('serializes rooted mutations and rejects a second writer with a stale identity/CAS', async () => {
    const root = await tempRoot();
    const target = nodePath.join(root, 'note.md');
    await writeFile(target, 'before');
    const firstFileSystem = new NodeTransactionFileSystem(root);
    const secondFileSystem = new NodeTransactionFileSystem(root);
    const beforeHash = hashBytes(new TextEncoder().encode('before'));
    const results = await Promise.allSettled([
      firstFileSystem.write('note.md', new TextEncoder().encode('first'), beforeHash),
      secondFileSystem.write('note.md', new TextEncoder().encode('second'), beforeHash),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => result.reason)).toEqual([
      expect.any(StalePreconditionError),
    ]);
    expect(['first', 'second']).toContain(await bytes(target));
  });

  it('keeps a post-mutation identity failure visible to rollback', async () => {
    const root = await tempRoot();
    const target = nodePath.join(root, 'note.md');
    await writeFile(target, 'before');
    const plan = createTransactionPlan({
      fence: 17,
      transactionId: 'tx-boundary-visible',
      current: [{ path: 'note.md', bytes: 'before' }],
      desired: [{ path: 'note.md', bytes: 'after' }],
    });
    const store = new Map<string, Uint8Array>([['note.md', new TextEncoder().encode('before')]]);
    let failAfterMutation = true;
    const fileSystem = {
      read: async (path: string) => store.get(path) ?? null,
      write: async (path: string, value: Uint8Array) => {
        store.set(path, new Uint8Array(value));
        if (failAfterMutation) {
          failAfterMutation = false;
          throw new MutationBoundaryError(path, 'post-write identity changed', true);
        }
      },
      remove: async (path: string) => { store.delete(path); },
    };
    const log = { assert: [] as FenceToken[], starts: [] as FenceToken[], completes: [] as FenceToken[], freezes: [] as FenceToken[] };
    const engine = new TransactionEngine({ rootDir: root, lease: leaseFor(log), fileSystem });

    await expect(engine.apply(plan)).rejects.toBeInstanceOf(MutationBoundaryError);
    expect(new TextDecoder().decode(store.get('note.md'))).toBe('before');
    expect(log.starts).toEqual([17]);
    expect(log.completes).toEqual([17]);
  });
});
