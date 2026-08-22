import { describe, expect, it } from 'vitest';
import { createWikiEngineHarness } from '../__support__/wiki-engine-harness';
import { readAuthoritativeSource } from '../../core/physical-source-authority';
import { GovernedReingestTransaction } from '../../core/governed-reingest';

const subtle = (globalThis as { crypto: { subtle: SubtleCrypto } }).crypto.subtle;

describe('governed force re-ingest durable recovery', () => {
  it('preserves and blocks on an unauthenticated bootstrap directory', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const adapter = h.app.vault.adapter;
    // A real begin() creates the custody key before the transaction directory.
    // Seed that durable key, then model a crash between mkdir and genesis.
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    await (await GovernedReingestTransaction.begin(h.app, source, subtle)).commit();
    for (const path of [
      '.obsidian',
      '.obsidian/plugins',
      '.obsidian/plugins/karpathywiki',
      '.obsidian/plugins/karpathywiki/governed-reingest-transactions',
      '.obsidian/plugins/karpathywiki/governed-reingest-transactions/orphan',
    ]) await adapter.mkdir(path);

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('Unauthenticated governed recovery directory preserved');
    expect(await adapter.exists('.obsidian/plugins/karpathywiki/governed-reingest-transactions/orphan')).toBe(true);
  });

  it('preserves active journals and artifacts when the custody key is missing', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/entities/new.md', 'transaction partial');
    h.files.set('wiki/entities/new.md', 'transaction partial');
    await adapter.remove('.obsidian/plugins/karpathywiki/governed-reingest.key');

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('custody key is missing');
    expect(h.files.get('wiki/entities/new.md')).toBe('transaction partial');
    const journals = await adapter.list('.obsidian/plugins/karpathywiki/governed-reingest-transactions');
    expect(journals.folders).toHaveLength(1);
  });

  it('treats a crash after custody capture but before mutation as an idempotent no-op', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'original' },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md');

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(1);
    expect(h.files.get('wiki/sources/source10.md')).toBe('original');
    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
  });

  it('fails before a later write when an existing artifact observably drifted', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'exact original' },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'first planned write');
    h.files.set('wiki/sources/source10.md', 'external edit before writer boundary');

    await expect(transaction.beforeFileMutation('wiki/sources/source10.md', 'second planned write'))
      .rejects.toThrow('drifted before governed mutation');
    expect(h.files.get('wiki/sources/source10.md')).toBe('external edit before writer boundary');
  });

  it('fails before a write when a pre-state-absent path is externally created with different bytes', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/entities/new.md', 'transaction planned write');
    h.files.set('wiki/entities/new.md', 'external creator bytes');

    await expect(transaction.beforeFileMutation('wiki/entities/new.md', 'transaction planned write'))
      .rejects.toThrow('drifted before governed mutation');
    expect(h.files.get('wiki/entities/new.md')).toBe('external creator bytes');
  });

  it('preserves and blocks on an existing-file postimage after restart', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'exact original' },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'partial overwrite');
    h.files.set('wiki/sources/source10.md', 'partial overwrite');

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
    expect(h.files.get('wiki/sources/source10.md')).toBe('partial overwrite');
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
  });

  it('preserves staged recovery custody after a same-process rollback crash', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'exact original' },
    });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'partial overwrite');
    h.files.set('wiki/sources/source10.md', 'partial overwrite');

    const originalRename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      if (from.endsWith('.restore')) throw new Error('simulated crash after staged preimage readback');
      return originalRename(from, to);
    };
    await expect(transaction.rollback())
      .rejects.toThrow('simulated crash after staged preimage readback');
    adapter.rename = originalRename;

    expect(h.files.has('wiki/sources/source10.md')).toBe(false);
    expect([...h.files.keys()].some(path => path.endsWith('.restore'))).toBe(true);
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('unresolved recovery custody');
    expect(h.files.has('wiki/sources/source10.md')).toBe(false);
    expect([...h.files.keys()].some(path => path.endsWith('.claimed'))).toBe(true);
  });

  it('restores exact originals and removes only transaction-created wiki/index/schema artifacts on owned rollback', async () => {
    const h = createWikiEngineHarness({
      files: {
        'sources/source10.md': 'authoritative source bytes',
        'wiki/sources/source10.md': 'exact original summary',
        'wiki/index.md': 'exact original index',
      },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);

    const partialOverwrite = '---\ngeneration_complete: false\n---\npartial overwrite';
    const partialNew = '---\ngeneration_complete: false\n---\npartial new page';
    await transaction.beforeFileMutation('wiki/sources/source10.md', partialOverwrite);
    h.files.set('wiki/sources/source10.md', partialOverwrite);
    await transaction.beforeFileMutation('wiki/entities/new.md', partialNew);
    h.files.set('wiki/entities/new.md', partialNew);
    await transaction.beforeFileMutation('wiki/index.md', 'partial index');
    h.files.set('wiki/index.md', 'partial index');
    await transaction.beforeFileMutation('wiki/schema/config.md', 'partial schema');
    h.files.set('wiki/schema/config.md', 'partial schema');

    await transaction.rollback();
    expect(h.files.get('wiki/sources/source10.md')).toBe('exact original summary');
    expect(h.files.has('wiki/entities/new.md')).toBe(false);
    expect(h.files.get('wiki/index.md')).toBe('exact original index');
    expect(h.files.has('wiki/schema/config.md')).toBe(false);
    expect([...h.files.keys()].some(path => path.startsWith('.trash/'))).toBe(false);

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
  });

  it('does not roll back a durably committed transaction when cleanup is interrupted', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'original' },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'completed replacement');
    h.files.set('wiki/sources/source10.md', 'completed replacement');

    const originalRmdir = h.app.vault.adapter.rmdir.bind(h.app.vault.adapter);
    let interrupted = false;
    h.app.vault.adapter.rmdir = async (path: string, recursive: boolean) => {
      if (!interrupted && recursive && path.includes('governed-reingest-transactions/')) {
        interrupted = true;
        throw new Error('simulated process stop before journal cleanup');
      }
      return originalRmdir(path, recursive);
    };
    await expect(transaction.commit()).rejects.toThrow('simulated process stop');
    h.app.vault.adapter.rmdir = originalRmdir;

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
    expect(h.files.get('wiki/sources/source10.md')).toBe('completed replacement');
  });

  it('removes an exactly owned empty folder and converges idempotently after restart', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(1);
    expect(await h.app.vault.adapter.exists('wiki/entities')).toBe(false);
    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
  });

  it('preserves an unrelated empty replacement folder that lacks the ownership marker', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');
    await adapter.rmdir('wiki/entities', true);
    await adapter.mkdir('wiki/entities');

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership is unproven');
    expect(await adapter.exists('wiki/entities')).toBe(true);
    expect((await adapter.list('wiki/entities')).files).toEqual([]);
  });

  it('resumes safely after a crash between owned-folder isolation and removal', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');

    const originalRmdir = adapter.rmdir.bind(adapter);
    adapter.rmdir = async (path: string, recursive: boolean) => {
      if (path.includes('.entities.reingest-')) throw new Error('simulated folder-removal crash');
      return originalRmdir(path, recursive);
    };
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('simulated folder-removal crash');
    adapter.rmdir = originalRmdir;

    expect(await adapter.exists('wiki/entities')).toBe(false);
    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(1);
    expect(await adapter.exists('wiki/entities')).toBe(false);
  });

  it('keeps committed folder contents when marker cleanup is interrupted', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');
    await transaction.beforeFileMutation('wiki/entities/new.md', 'committed');
    h.files.set('wiki/entities/new.md', 'committed');

    const originalRemove = adapter.remove.bind(adapter);
    let interrupted = false;
    adapter.remove = async (path: string) => {
      if (!interrupted && path.endsWith('/.karpathywiki-reingest-owner')) {
        interrupted = true;
        throw new Error('simulated committed marker cleanup crash');
      }
      return originalRemove(path);
    };
    await expect(transaction.commit()).rejects.toThrow('simulated committed marker cleanup crash');
    adapter.remove = originalRemove;

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
    expect(h.files.get('wiki/entities/new.md')).toBe('committed');
    expect([...h.files.keys()].some(path => path.endsWith('/.karpathywiki-reingest-owner'))).toBe(false);
  });

  it('finishes committed-folder cleanup after a crash before journal-directory rename', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');
    await transaction.beforeFileMutation('wiki/entities/new.md', 'committed');
    h.files.set('wiki/entities/new.md', 'committed');

    const originalRename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      if (from.includes('governed-reingest-transactions/')) {
        throw new Error('simulated crash before committed journal rename');
      }
      return originalRename(from, to);
    };
    await expect(transaction.commit()).rejects.toThrow('simulated crash before committed journal rename');
    adapter.rename = originalRename;

    await expect(h.engine.recoverGovernedForceTransactions()).resolves.toBe(0);
    expect(h.files.get('wiki/entities/new.md')).toBe('committed');
    expect([...h.files.keys()].some(path => path.endsWith('/.karpathywiki-reingest-owner'))).toBe(false);
  });

  it('refuses traversal, absolute, custody-key, and journal self-mutations before capture', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);

    await expect(transaction.beforeFileMutation('../outside.md', 'bad')).rejects.toThrow('Unsafe governed artifact path');
    await expect(transaction.beforeFileMutation('C:/outside.md', 'bad')).rejects.toThrow('Unsafe governed artifact path');
    await expect(transaction.beforeFileMutation('.obsidian/plugins/karpathywiki/governed-reingest.key', 'bad'))
      .rejects.toThrow('custody self-mutation');
    await expect(transaction.beforeFolderMutation('.obsidian/plugins/karpathywiki/governed-reingest-transactions'))
      .rejects.toThrow('custody self-mutation');
    await transaction.rollback();
  });

  it('preserves any restart-time file at a transaction-created path and fails closed', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/entities/new.md', 'transaction partial');
    h.files.set('wiki/entities/new.md', 'unrelated replacement after crash');

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
    expect(h.files.get('wiki/entities/new.md')).toBe('unrelated replacement after crash');
  });

  it('does not claim or rename an existing-file postimage during restart recovery', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/entities/existing.md': 'exact original' },
    });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/entities/existing.md', 'transaction partial');
    h.files.set('wiki/entities/existing.md', 'transaction partial');

    const originalRename = adapter.rename.bind(adapter);
    let targetRenameAttempted = false;
    adapter.rename = async (from: string, to: string) => {
      if (from === 'wiki/entities/existing.md') targetRenameAttempted = true;
      return originalRename(from, to);
    };
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
    adapter.rename = originalRename;
    expect(targetRenameAttempted).toBe(false);
    expect(h.files.get('wiki/entities/existing.md')).toBe('transaction partial');
  });

  it('preserves an unrelated replacement at an existing path after restart', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'exact original' },
    });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'transaction overwrite');
    h.files.set('wiki/sources/source10.md', 'transaction overwrite');

    h.files.set('wiki/sources/source10.md', 'replacement after crash');
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
    expect(h.files.get('wiki/sources/source10.md')).toBe('replacement after crash');
    expect([...h.files.keys()].some(path => path.endsWith('.claimed'))).toBe(false);
  });

  it('revalidates a claimed folder and preserves a replacement raced before rename', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source', 'wiki/keep.md': 'keep' } });
    const adapter = h.app.vault.adapter;
    const source = await readAuthoritativeSource(adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFolderMutation('wiki/entities');

    const originalRename = adapter.rename.bind(adapter);
    let raced = false;
    adapter.rename = async (from: string, to: string) => {
      if (!raced && from === 'wiki/entities') {
        raced = true;
        await adapter.rmdir(from, true);
        await adapter.mkdir(from);
      }
      return originalRename(from, to);
    };
    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership is unproven');
    adapter.rename = originalRename;
    expect(await adapter.exists('wiki/entities')).toBe(true);
    expect((await adapter.list('wiki/entities')).files).toEqual([]);
  });

  it('blocks rather than deleting after a restart lands on a created-file postimage intent', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'source' } });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/entities/new.md', 'generation_complete: false');
    h.files.set('wiki/entities/new.md', 'generation_complete: false');
    await transaction.beforeFileMutation('wiki/entities/new.md', 'generation_complete: true');
    // Crash before the second write: the first transaction-owned postimage is
    // still safe to remove even though a later intent is already durable.

    await expect(h.engine.recoverGovernedForceTransactions())
      .rejects.toThrow('ownership cannot be re-established after restart');
    expect(h.files.get('wiki/entities/new.md')).toBe('generation_complete: false');
  });

  it('refuses commit when a journaled artifact drifts after its final planned write', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/source10.md': 'source', 'wiki/sources/source10.md': 'exact original' },
    });
    const source = await readAuthoritativeSource(h.app.vault.adapter, 'sources/source10.md');
    const transaction = await GovernedReingestTransaction.begin(h.app, source, subtle);
    await transaction.beforeFileMutation('wiki/sources/source10.md', 'transaction final');
    h.files.set('wiki/sources/source10.md', 'external edit before commit');

    await expect(transaction.commit()).rejects.toThrow('drifted before commit');
    expect(h.files.get('wiki/sources/source10.md')).toBe('external edit before commit');
  });
});
