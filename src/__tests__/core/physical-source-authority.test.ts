import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import {
  checkPhysicalSource,
  readAuthoritativeSource,
  reconcilePhysicalFolderFiles,
} from '../../core/physical-source-authority';

function file(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    basename: name.slice(0, dot),
    extension: name.slice(dot + 1),
  });
}

describe('physical source authority', () => {
  it('binds authority to exact adapter bytes instead of reconstructed decoded text', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const adapter = {
      read: vi.fn().mockResolvedValue('a\r\n'),
      readBinary: vi.fn().mockResolvedValue(bytes.buffer),
    };

    const snapshot = await readAuthoritativeSource(adapter, 'sources/exact.md');
    expect([...snapshot.bytes]).toEqual([...bytes]);
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it('keeps the Obsidian DataAdapter receiver for authoritative disk reads', async () => {
    class ReceiverBoundAdapter {
      private readonly contents = new Map([['sources/live.md', 'bytes from disk']]);

      async read(path: string): Promise<string> {
        const content = this.contents.get(path);
        if (content === undefined) throw new Error(`missing: ${path}`);
        return content;
      }

      async exists(path: string): Promise<boolean> {
        return this.contents.has(path);
      }
    }

    const adapter = new ReceiverBoundAdapter();
    const snapshot = await readAuthoritativeSource(adapter, 'sources\\live.md');
    expect(snapshot.content).toBe('bytes from disk');

    const combined = await checkPhysicalSource(adapter, 'sources/live.md');
    expect(combined).toMatchObject({ exists: true, source: { content: 'bytes from disk' } });
  });

  it('preserves refusal semantics when a receiver-bound adapter cannot read the source', async () => {
    class RefusingAdapter {
      private readonly contents = new Map<string, string>();

      async read(path: string): Promise<string> {
        if (!this.contents.has(path)) throw new Error('source disappeared');
        return this.contents.get(path)!;
      }

      async exists(path: string): Promise<boolean> {
        return this.contents.has(path);
      }
    }

    const result = await checkPhysicalSource(new RefusingAdapter(), 'sources/gone.md');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('source disappeared');
  });

  it('intersects 15 cached files with the 4 files physically present', async () => {
    const cached = [
      file('sources/1.md'),
      file('sources/2.md'),
      file('sources/nested/3.md'),
      file('sources/nested/4.md'),
      ...Array.from({ length: 11 }, (_, index) => file(`sources/ghost-${index + 1}.md`)),
    ];
    const adapter = {
      list: vi.fn().mockImplementation(async (path: string) => path === 'sources'
        ? { files: ['sources/1.md', 'sources/2.md'], folders: ['sources/nested'] }
        : { files: ['sources/nested/3.md', 'sources/nested/4.md'], folders: [] }),
    };

    const result = await reconcilePhysicalFolderFiles(adapter, cached, 'sources', false, 'wiki', '.obsidian');

    expect(result.map(item => item.path)).toEqual(cached.slice(0, 4).map(item => item.path));
  });

  it('refuses a physical source that is absent from the Obsidian cache', async () => {
    const adapter = {
      list: vi.fn().mockResolvedValue({
        files: ['sources/live.md', 'sources/cache-missing.md'],
        folders: [],
      }),
    };

    await expect(reconcilePhysicalFolderFiles(
      adapter,
      [file('sources/live.md')],
      'sources',
      false,
      'wiki',
      '.obsidian',
    ))
      .rejects.toThrow('Vault cache is missing 1 physical source file');
  });

  it('excludes generated, config, trash, and hidden files from a root scan', async () => {
    const live = file('sources/nested/live.md');
    const excluded = [
      file('wiki/entities/generated.md'),
      file('.obsidian/plugins/config.md'),
      file('.trash/deleted.md'),
      file('sources/.draft/hidden.md'),
    ];
    const adapter = {
      list: vi.fn().mockImplementation(async (path: string) => {
        const listings: Record<string, { files: string[]; folders: string[] }> = {
          '': {
            files: [],
            folders: ['sources', 'wiki', '.obsidian', '.trash'],
          },
          sources: { files: [], folders: ['sources/nested', 'sources/.draft'] },
          'sources/nested': { files: [live.path], folders: [] },
          'sources/.draft': { files: ['sources/.draft/hidden.md'], folders: [] },
          wiki: { files: [], folders: ['wiki/entities'] },
          'wiki/entities': { files: ['wiki/entities/generated.md'], folders: [] },
          '.obsidian': { files: [], folders: ['.obsidian/plugins'] },
          '.obsidian/plugins': { files: ['.obsidian/plugins/config.md'], folders: [] },
          '.trash': { files: ['.trash/deleted.md'], folders: [] },
        };
        return listings[path];
      }),
    };

    const result = await reconcilePhysicalFolderFiles(
      adapter,
      [live, ...excluded],
      '/',
      true,
      'wiki',
      '.obsidian',
    );

    expect(result.map(item => item.path)).toEqual([live.path]);
    expect(adapter.list).not.toHaveBeenCalledWith('wiki');
    expect(adapter.list).not.toHaveBeenCalledWith('.obsidian');
    expect(adapter.list).not.toHaveBeenCalledWith('.trash');
    expect(adapter.list).not.toHaveBeenCalledWith('sources/.draft');
  });

  it('keeps a deeply nested selected source folder in scope', async () => {
    const nested = file('sources/selected/deep/live.md');
    const adapter = {
      list: vi.fn().mockImplementation(async (path: string) => path === 'sources/selected'
        ? { files: [], folders: ['sources/selected/deep'] }
        : { files: [nested.path], folders: [] }),
    };

    const result = await reconcilePhysicalFolderFiles(
      adapter,
      [nested],
      'sources/selected',
      false,
      'wiki',
      '.obsidian',
    );

    expect(result).toEqual([nested]);
  });

  it('accepts a normal source tree well below the traversal depth bound', async () => {
    const segments = Array.from({ length: 20 }, (_, index) => `level-${index}`);
    const finalPath = `sources/${segments.join('/')}/live.md`;
    const adapter = {
      list: vi.fn().mockImplementation(async (path: string) => {
        const depth = path === 'sources' ? 0 : path.split('/').length - 1;
        if (depth < segments.length) {
          return { files: [], folders: [`${path}/${segments[depth]}`] };
        }
        return { files: [finalPath], folders: [] };
      }),
    };

    const result = await reconcilePhysicalFolderFiles(
      adapter,
      [file(finalPath)],
      'sources',
      false,
      'wiki',
      '.obsidian',
    );

    expect(result.map(item => item.path)).toEqual([finalPath]);
  });

  it('fails closed on an endlessly expanding junction-like traversal', async () => {
    const adapter = {
      list: vi.fn().mockImplementation(async (path: string) => ({
        files: [],
        folders: [`${path}/loop`],
      })),
    };

    await expect(reconcilePhysicalFolderFiles(
      adapter,
      [],
      'sources',
      false,
      'wiki',
      '.obsidian',
    )).rejects.toThrow('possible junction cycle');
  });

  it('fails closed when an adapter returns an unbounded path listing', async () => {
    const adapter = {
      list: vi.fn().mockResolvedValue({
        files: Array.from({ length: 100_001 }, (_, index) => `sources/${index}.md`),
        folders: [],
      }),
    };

    await expect(reconcilePhysicalFolderFiles(
      adapter,
      [],
      'sources',
      false,
      'wiki',
      '.obsidian',
    )).rejects.toThrow('refusing an unbounded adapter traversal');
  });

  it('fails closed when adapter.exists returns false', async () => {
    const result = await checkPhysicalSource({ exists: vi.fn().mockResolvedValue(false) }, 'gone.md');

    expect(result.exists).toBe(false);
    expect(result.error).toContain('no longer present on disk');
  });

  it('fails closed when adapter.exists throws', async () => {
    const result = await checkPhysicalSource(
      { exists: vi.fn().mockRejectedValue(new Error('adapter offline')) },
      'unknown.md',
    );

    expect(result.exists).toBe(false);
    expect(result.error).toContain('adapter offline');
  });

  it('reads the authoritative source once and binds the returned snapshot to its normalized path', async () => {
    const read = vi.fn().mockResolvedValue('the authoritative bytes');

    const snapshot = await readAuthoritativeSource({ read }, 'notes\\source.md');

    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('notes/source.md');
    expect(snapshot.path).toBe('notes/source.md');
    expect(snapshot.content).toBe('the authoritative bytes');
    expect(snapshot.bytes).toEqual(new TextEncoder().encode('the authoritative bytes'));
  });

  it('does not perform a check-then-read sequence that can observe two different source states', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue('one read is the authority'),
    };

    await readAuthoritativeSource(adapter, 'notes/source.md');

    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.read).toHaveBeenCalledOnce();
  });

  it('returns the same read-bound snapshot from the combined physical check', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue('checked and read once'),
    };

    const result = await checkPhysicalSource(adapter, 'notes/source.md');

    expect(result).toMatchObject({ exists: true });
    expect(result.source?.content).toBe('checked and read once');
    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.read).toHaveBeenCalledOnce();
  });

  it('fails closed when the authoritative read disappears or errors', async () => {
    await expect(readAuthoritativeSource({
      read: vi.fn().mockRejectedValue(new Error('source disappeared')),
    }, 'notes/source.md')).rejects.toThrow('source disappeared');
  });
});
