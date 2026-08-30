import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Platform, TFile } from 'obsidian';
import { WikiEngine } from '../../wiki/wiki-engine';
import { createMockClient } from '../__support__/engine-context';

function buildEngineWithCanonicalAdapter(canonicalRoot = 'C:/vault') {
  const files = new Map<string, { path: string; content: string }>();
  const asTFile = (file: { path: string; content?: string }) => Object.assign(Object.create(TFile.prototype), file);
  const getAbstractFileByPath = vi.fn((path: string) => {
    const file = files.get(path);
    return file ? asTFile(file) : null;
  });
  const adapter = {
    root: canonicalRoot,
    getFullPath: vi.fn(function (this: { root: string }, path: string) {
      return join(this.root, ...path.split('/'));
    }),
  };
  const vault = {
    adapter,
    read: vi.fn(async (file: { path: string }) => files.get(file.path)?.content ?? ''),
    getAbstractFileByPath,
    getMarkdownFiles: () => [...files.values()].map(file => asTFile(file)),
    createFolder: vi.fn(async () => undefined),
    create: vi.fn(async (path: string, content: string) => {
      if (files.has(path)) throw new Error('File already exists');
      const file = { path, content };
      files.set(path, file);
      return asTFile(file);
    }),
    process: vi.fn(async (file: { path: string }, update: (content: string) => string) => {
      const current = files.get(file.path);
      if (current) current.content = update(current.content);
      return current?.content ?? '';
    }),
    modify: vi.fn(async () => undefined),
    getFiles: () => [...files.values()].map(file => asTFile(file)),
  };

  const app = { vault } as unknown as ConstructorParameters<typeof WikiEngine>[0];
  const settings = { wikiFolder: 'wiki', language: 'en', llmReady: true } as unknown as ConstructorParameters<typeof WikiEngine>[1];
  const client = createMockClient(['{"entities":[],"concepts":[]}']);
  const engine = new WikiEngine(
    app,
    settings,
    () => client,
    { ensureSchemaExists: async () => {}, getSchemaContext: async () => '' } as never,
    () => {},
    () => {},
    () => {},
  );
  return { engine, vault };
}

describe('WikiEngine lint-report retention wiring', () => {
  it('bundles desktop path safety through CommonJS builtins, not dynamic ESM imports', () => {
    const bundle = readFileSync('main.js', 'utf8');
    expect(bundle).not.toContain('import("node:fs/promises")');
    expect(bundle).not.toContain('import("node:path")');
    expect(/requireDesktopNodeModule\("node:fs\/promises"\)/.test(bundle)).toBe(true);
  });

  it('passes the production canonical adapter resolver and raw archive writer', async () => {
    (Platform as { isDesktop?: boolean }).isDesktop = true;
    const { engine, vault } = buildEngineWithCanonicalAdapter();

    await engine.logLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- ✅ retained\n');

    expect(vault.adapter.getFullPath).toHaveBeenCalledWith('wiki/lint-reports');
    expect(vault.adapter.getFullPath).toHaveBeenCalledWith(expect.stringMatching(/^wiki\/lint-reports\/.*\.json$/));
    expect(vault.create).toHaveBeenCalledWith(
      expect.stringMatching(/^wiki\/lint-reports\/.*\.json$/),
      expect.stringContaining('"artifactVersion": "spm-brain\/lint-report\/v1"'),
    );
    expect(vault.create).toHaveBeenCalledWith('wiki/log.md', expect.stringContaining('**Report artifact**:'));
  });

  it.skipIf(process.platform !== 'win32')('rejects an actual Windows junction in the archive path', async () => {
    const priorDesktop = Platform.isDesktop;
    // Keep the fixture under a realpath-readable root: the production
    // resolver checks every existing ancestor with lstat + realpath, and the
    // managed test sandbox may deny realpath on the user's profile root.
    const fixtureRoot = await mkdtemp(join('C:\\Users\\Public', 'spm-retention-junction-'));
    const vaultRoot = join(fixtureRoot, 'vault');
    const wikiRoot = join(vaultRoot, 'wiki');
    const junctionTarget = join(fixtureRoot, 'outside');
    const junctionPath = join(wikiRoot, 'lint-reports');
    await mkdir(wikiRoot, { recursive: true });
    await mkdir(junctionTarget);
    await symlink(junctionTarget, junctionPath, 'junction');

    try {
      (Platform as { isDesktop?: boolean }).isDesktop = true;
      const { engine, vault } = buildEngineWithCanonicalAdapter(vaultRoot);

      await expect(engine.logLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- junction\n'))
        .rejects.toThrow(/symlink\/junction\/reparse point/);
      expect(vault.create).not.toHaveBeenCalled();
      expect(vault.adapter.getFullPath).toHaveBeenCalledWith('wiki/log.md');
      expect(vault.adapter.getFullPath).toHaveBeenCalledWith('wiki/lint-reports');
    } finally {
      (Platform as { isDesktop?: boolean }).isDesktop = priorDesktop;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
