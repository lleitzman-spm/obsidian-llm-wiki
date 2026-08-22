import { describe, it, expect } from 'vitest';
import { acquireJournalFileLock, mergeDuplicatePages } from '../../../wiki/lint/merge-duplicates';
import { createFakeLinkVault } from '../../__support__/link-vault';
import type { EngineContext } from '../../../types';

// Issue #386 at the call site. PR #389 deliberately left the merge-duplicates
// site without leak-direction coverage because this issue replaces the filter
// outright — this is that coverage.
//
// The LLM client is absent on purpose: `mergeDuplicatePages` falls back to its
// programmatic merge, which is the path that matters for the link rewrite.

const TARGET = 'wiki/entities/Osteopontin.md';
const SOURCE = 'wiki/entities/Osteopontin-2.md';

function makeJournalAdapter() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const operations: string[] = [];
  const descendants = (path: string): string[] => [...files.keys()].filter(key => key.startsWith(`${path}/`));
  return {
    operations,
    exists: async (path: string) => files.has(path) || directories.has(path),
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing adapter path: ${path}`);
      return value;
    },
    write: async (path: string, content: string) => {
      operations.push(`write:${path}`);
      files.set(path, content);
    },
    mkdir: async (path: string) => {
      operations.push(`mkdir:${path}`);
      if (files.has(path) || directories.has(path)) throw new Error('already exists');
      directories.add(path);
    },
    rename: async (oldPath: string, newPath: string) => {
      operations.push(`rename:${oldPath}->${newPath}`);
      if (directories.has(newPath) || files.has(newPath)) throw new Error('destination exists');
      if (directories.has(oldPath)) {
        directories.delete(oldPath);
        directories.add(newPath);
        for (const child of descendants(oldPath)) {
          const moved = `${newPath}${child.slice(oldPath.length)}`;
          const content = files.get(child);
          files.delete(child);
          files.set(moved, content!);
        }
        return;
      }
      const content = files.get(oldPath);
      if (content === undefined) throw new Error('source missing');
      files.delete(oldPath);
      files.set(newPath, content);
    },
    remove: async (path: string) => {
      operations.push(`remove:${path}`);
      directories.delete(path);
      for (const child of descendants(path)) files.delete(child);
      files.delete(path);
    },
    seed: (path: string, content: string) => { files.set(path, content); },
    seedDirectory: (path: string) => { directories.add(path); },
  };
}

function makeCtx(files: Record<string, string>) {
  const fake = createFakeLinkVault(files);
  const deleted: string[] = [];
  const ctx = {
    app: { vault: fake.vault, metadataCache: fake.metadataCache },
    settings: { wikiFolder: 'wiki', language: 'en' },
    getClient: () => null,
    tryReadFile: async (path: string) => (files[path] === undefined ? fake.read(path) || null : fake.read(path)),
    createOrUpdateFile: async (path: string, content: string) => { fake.write(path, content); },
    deleteFile: async (path: string) => { deleted.push(path); },
    getSchemaContext: async () => undefined,
  } as unknown as EngineContext;
  return { ctx, fake, deleted };
}

function makeLeaseCtx(adapter: ReturnType<typeof makeJournalAdapter>, wikiFolder = 'wiki'): EngineContext {
  return {
    app: { vault: { adapter } },
    settings: { wikiFolder, language: 'en' },
  } as unknown as EngineContext;
}

describe('merge journal lease and path boundary', () => {
  it.each(['../outside', '/absolute/wiki', 'C:/outside/wiki', 'wiki/../outside', 'wiki\\junction\\..\\outside'])
    ('rejects unsafe wikiFolder %j before adapter access', async wikiFolder => {
      const adapter = makeJournalAdapter();
      const ctx = makeLeaseCtx(adapter, wikiFolder);

      await expect(mergeDuplicatePages(ctx, TARGET, SOURCE)).rejects.toThrow();
      expect(adapter.operations).toEqual([]);
    });

  it('keeps a long-running owner alive through heartbeat while a replacement waits', async () => {
    const adapter = makeJournalAdapter();
    const ctx = makeLeaseCtx(adapter);
    const first = await acquireJournalFileLock(ctx, 'wiki/.karpathywiki-merge-journal.json');
    await new Promise<void>(resolve => window.setTimeout(resolve, 2_100));
    let secondAcquired = false;
    const secondPromise = acquireJournalFileLock(ctx, 'wiki/.karpathywiki-merge-journal.json')
      .then(lease => { secondAcquired = true; return lease; });
    await new Promise<void>(resolve => window.setTimeout(resolve, 75));
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    await second.release();
  });

  it('recovers a stale lease by atomic replacement, never direct stale deletion', async () => {
    const adapter = makeJournalAdapter();
    const lockPath = 'wiki/.karpathywiki-merge-journal.json.lock';
    adapter.seedDirectory(lockPath);
    adapter.seed(`${lockPath}/lease.json`, JSON.stringify({
      version: 1,
      token: 'abandoned-owner',
      createdAt: Date.now() - 11 * 60 * 1000,
      heartbeatAt: Date.now() - 11 * 60 * 1000,
    }));
    const lease = await acquireJournalFileLock(makeLeaseCtx(adapter), 'wiki/.karpathywiki-merge-journal.json');
    const acquisitionOperations = [...adapter.operations];
    await lease.release();

    expect(acquisitionOperations.some(op => op === `remove:${lockPath}`)).toBe(false);
    expect(acquisitionOperations.some(op => op.startsWith(`rename:${lockPath}->${lockPath}.recovery-`))).toBe(true);
  });
});

describe('mergeDuplicatePages — link retargeting (#386)', () => {
  it('retargets a bare-title link in a user note outside the wiki folder', async () => {
    const { ctx, fake, deleted } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
      [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      'Notizen/Knochenstoffwechsel.md': 'Reguliert durch [[Osteopontin-2]].\n',
      'wiki/concepts/Knochenumbau.md': 'Reguliert durch [[entities/Osteopontin-2]].\n',
    });

    const summary = await mergeDuplicatePages(ctx, TARGET, SOURCE);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Reguliert durch [[Osteopontin]].\n');
    expect(fake.read('wiki/concepts/Knochenumbau.md')).toBe('Reguliert durch [[entities/Osteopontin]].\n');
    expect(deleted).toEqual([SOURCE]);
    expect(summary).toContain('2 links retargeted in 2 files');
  });

  it('does not write into a note whose links point elsewhere', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
      [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      'Notizen/Osteopontin-2.md': '# My own note\n',
      'Notizen/Knochenstoffwechsel.md': 'Siehe [[Osteopontin-2]].\n',
    });

    const summary = await mergeDuplicatePages(ctx, TARGET, SOURCE);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Siehe [[Osteopontin-2]].\n');
    expect(fake.processed).toEqual([]);
    expect(summary).toBe('merged entities/Osteopontin-2 → entities/Osteopontin');
  });
});

// #435 Item 2 — the sibling of #419 on the lint path. Here the LLM client is
// present on purpose: the programmatic fallback keeps the target's body verbatim
// and can never lose the title, so only the adopted-rewrite path can.
describe('mergeDuplicatePages — the merged body keeps the surviving page H1 (#435)', () => {
  function ctxWithMergeAnswer(files: Record<string, string>, body: string) {
    const { ctx, fake, deleted } = makeCtx(files);
    (ctx as unknown as { getClient: () => unknown }).getClient = () => ({
      createMessage: async () => JSON.stringify({ body, aliases: [] }),
    });
    return { ctx, fake, deleted };
  }

  it('restores the H1 when the merge answer drops it', async () => {
    const { ctx, fake } = ctxWithMergeAnswer(
      {
        [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
        [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      },
      '## Description\n\nA bone marker, and also a bone marker — merged prose long enough to clear the hundred-character floor this path applies.',
    );

    await mergeDuplicatePages(ctx, TARGET, SOURCE);

    const written = fake.read(TARGET) ?? '';
    expect(written).toContain('# Osteopontin\n');
    expect(written.indexOf('# Osteopontin')).toBeLessThan(written.indexOf('## Description'));
  });

  it('does not let the merge answer rename the surviving page', async () => {
    const { ctx, fake } = ctxWithMergeAnswer(
      {
        [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
        [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      },
      '# Osteopontin and Osteopontin-2\n\n## Description\n\nMerged prose, long enough to clear the hundred-character floor that this path applies before it parses.',
    );

    await mergeDuplicatePages(ctx, TARGET, SOURCE);

    const written = fake.read(TARGET) ?? '';
    expect(written).toContain('# Osteopontin\n');
    expect(written).not.toContain('# Osteopontin and Osteopontin-2');
  });
});
