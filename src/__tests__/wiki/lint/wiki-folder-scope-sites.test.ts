// Issue #383 follow-up regression coverage.
//
// PR #384 migrated 7 call sites from `f.path.startsWith(wikiFolder)` to
// `isInFolderScope(...)`. This file pins the BEHAVIOURAL contract for **six**
// of those call sites — preparation, get-existing-pages, delete-empty-stubs,
// normalizeSourcesInFolder (auto-maintain Phase 2), contradictions, and the
// follow-up fix on contradictions. The seventh site (merge-duplicates) is
// omitted on purpose: #386 (assigned to DocTpoint) rewrites that filter and
// owns its own production-function coverage.
//
// For each pinned site the test calls the production function with a minimal
// vault whose markdown files include both leak directions — sibling folder
// (`wiki-archive/x.md`) and adjacent file (`wiki.md`) — and asserts the
// filter excludes them. The shared helper (`src/core/folder-scope.ts`) has
// its own test file; the tests here exercise behaviour, not implementation.
//
// Centralisation note: the picker exclusion rule (wiki folder + config
// directory) lives in `isExcludedFromSourcePicker` (`folder-scope.ts`) and
// is shared by `FileSuggestModal`, `FolderSuggestModal`, and the multi-file
// variant. SourcePicker regressions belong in this file's follow-up
// coverage, not here.

import { describe, it, expect } from 'vitest';
import { App } from 'obsidian';
import { runPreparationPhase } from '../../../wiki/lint/phases/preparation';
import { LintPhaseContext } from '../../../wiki/lint/types';
import { LLMWikiSettings } from '../../../types';
import { getExistingWikiPages } from '../../../wiki/lint/get-existing-pages';
import { ContradictionManager } from '../../../wiki/contradictions';
import { deleteEmptyStubs } from '../../../wiki/lint/delete-empty-stubs';
import { normalizeSourcesInFolder } from '../../../core/sources-normalizer';
import type { EngineContext } from '../../../types';

// --- shared fixture builders ------------------------------------------------

interface MockVaultFile {
  path: string;
  basename: string;
  content?: string;
}

function makeVault(files: MockVaultFile[]) {
  const byPath = new Map<string, MockVaultFile>(files.map(f => [f.path, f]));
  return {
    vault: {
      getMarkdownFiles: () => Array.from(byPath.values()).map(f => ({
        path: f.path,
        basename: f.basename,
        extension: 'md',
        stat: { size: 0 },
        name: f.basename,
      })),
      read: async (file: { path: string }) => byPath.get(file.path)?.content ?? '',
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      process: async (file: { path: string }, fn: (data: string) => string | Promise<string>) => {
        const existing = byPath.get(file.path);
        if (!existing) return '';
        const next = await fn(existing.content ?? '');
        byPath.set(file.path, { ...existing, content: String(next) });
        return next;
      },
      adapter: {
        exists: async () => true,
        list: async () => Array.from(byPath.keys()),
        read: async (path: string) => byPath.get(path)?.content ?? '',
      },
      configDir: '.obsidian',
      getRoot: () => ({ path: '/', children: [] }),
    },
    app: {
      vault: {
        getMarkdownFiles: () => Array.from(byPath.values()).map(f => ({
          path: f.path,
          basename: f.basename,
          extension: 'md',
          stat: { size: 0 },
          name: f.basename,
        })),
        read: async (file: { path: string }) => byPath.get(file.path)?.content ?? '',
        getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
        process: async (file: { path: string }, fn: (data: string) => string | Promise<string>) => {
          const existing = byPath.get(file.path);
          if (!existing) return '';
          const next = await fn(existing.content ?? '');
          byPath.set(file.path, { ...existing, content: String(next) });
          return next;
        },
        configDir: '.obsidian',
        getRoot: () => ({ path: '/', children: [] }),
      },
    },
  };
}

function makeLintCtx(files: MockVaultFile[], settings: Partial<LLMWikiSettings> = {}): LintPhaseContext {
  return {
    app: makeVault(files) as unknown as LintPhaseContext['app'],
    settings: {
      wikiFolder: 'wiki',
      language: 'en',
      slugCase: 'lower',
      ...settings,
    } as LLMWikiSettings,
    llmClient: () => null,
    wikiEngine: { updateStatusBar: () => {} } as unknown as LintPhaseContext['wikiEngine'],
    checkCancelled: () => {},
    stageNotice: null,
    totalPages: 0,
    buildSystemPrompt: async () => undefined,
  };
}

function makeEngineCtx(files: MockVaultFile[], settings: Partial<LLMWikiSettings> = {}): EngineContext {
  return {
    app: makeVault(files).app as unknown as EngineContext['app'],
    settings: {
      wikiFolder: 'wiki',
      language: 'en',
      slugCase: 'lower',
      ...settings,
    } as LLMWikiSettings,
    llmClient: () => null,
  } as unknown as EngineContext;
}

// --- 1. preparation.ts (filter in runPreparationPhase) ---------------------

describe('PR #384 / #383 — preparation.ts leak guard', () => {
  it('excludes wiki-archive sibling and adjacent wiki.md', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Foo.md', basename: 'Foo', content: '# Foo\n\nBody' },
      { path: 'wiki-archive/old.md', basename: 'old', content: '# old\n\nBody' },
      { path: 'wiki.md', basename: 'wiki', content: '# wiki\n\nBody' },
    ];
    const ctx = makeLintCtx(files);
    const result = await runPreparationPhase(ctx);

    const paths = result.wikiFiles.map(f => f.path);
    expect(paths).toContain('wiki/entities/Foo.md');
    expect(paths).not.toContain('wiki-archive/old.md');
    expect(paths).not.toContain('wiki.md');
  });
});

// --- 2. get-existing-pages.ts ---------------------------------------------

describe('PR #384 / #383 — get-existing-pages.ts leak guard', () => {
  it('excludes wiki-archive sibling and adjacent wiki.md', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Foo.md', basename: 'Foo', content: '# Foo' },
      { path: 'wiki-archive/old.md', basename: 'old', content: '# old' },
      { path: 'wiki.md', basename: 'wiki', content: '# wiki' },
    ];
    const app = makeVault(files).app as unknown as Parameters<typeof getExistingWikiPages>[0];
    const pages = await getExistingWikiPages(app, 'wiki');

    const paths = pages.map(p => p.path);
    expect(paths).toContain('wiki/entities/Foo.md');
    expect(paths).not.toContain('wiki-archive/old.md');
    expect(paths).not.toContain('wiki.md');
  });
});

// --- 3. delete-empty-stubs.ts (sharp site — user-data-loss) ---------------
//
// Calls the production function with a deleteFile collector. Reverting the
// filter to `startsWith(wikiFolder)` makes `wiki-archive/Empty.md` and
// `wiki.md` enter the delete set and fails every case below.

describe('PR #384 / #383 — delete-empty-stubs.ts (production function)', () => {
  it('deletes only empty stubs inside the wiki folder', async () => {
    const deleted: string[] = [];
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Empty.md', basename: 'Empty', content: '# Empty' },
      { path: 'wiki-archive/Empty.md', basename: 'Empty', content: '# Empty' },
      { path: 'wiki.md', basename: 'wiki', content: '# wiki' },
    ];
    const ctx = {
      ...makeEngineCtx(files),
      deleteFile: async (p: string) => {
        deleted.push(p);
      },
    } as unknown as EngineContext;

    const result = await deleteEmptyStubs(ctx, 'wiki');

    expect(result.deleted).toBe(1);
    expect(deleted).toEqual(['wiki/entities/Empty.md']);
  });

  it('keeps a non-empty wiki file', async () => {
    const deleted: string[] = [];
    const files: MockVaultFile[] = [
      // MIN_SUBSTANTIVE_CHARS = 50; pad so textBody length crosses the threshold.
      { path: 'wiki/entities/Substantive.md', basename: 'Substantive', content: '# Title\n\n' + 'word '.repeat(30) },
    ];
    const ctx = {
      ...makeEngineCtx(files),
      deleteFile: async (p: string) => {
        deleted.push(p);
      },
    } as unknown as EngineContext;

    const result = await deleteEmptyStubs(ctx, 'wiki');

    expect(result.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('keeps an empty stub carrying reviewed: true', async () => {
    const deleted: string[] = [];
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/Reviewed.md', basename: 'Reviewed', content: '---\nreviewed: true\n---\n# Empty' },
    ];
    const ctx = {
      ...makeEngineCtx(files),
      deleteFile: async (p: string) => {
        deleted.push(p);
      },
    } as unknown as EngineContext;

    const result = await deleteEmptyStubs(ctx, 'wiki');

    expect(result.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });

  it.each([
    ['wiki/sources/Empty.md'],
    ['wiki/schema/Empty.md'],
    ['wiki/index.md'],
    ['wiki/log.md'],
    ['wiki/entities/sub/log.md'],
  ])('keeps the protected wiki file %s', async (path) => {
    const deleted: string[] = [];
    const files: MockVaultFile[] = [
      { path, basename: path.split('/').pop()!, content: '# Empty' },
    ];
    const ctx = {
      ...makeEngineCtx(files),
      deleteFile: async (p: string) => {
        deleted.push(p);
      },
    } as unknown as EngineContext;

    const result = await deleteEmptyStubs(ctx, 'wiki');

    expect(result.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('records the failure when deleteFile throws and continues', async () => {
    const deleted: string[] = [];
    const files: MockVaultFile[] = [
      { path: 'wiki/entities/A.md', basename: 'A', content: '# A' },
      { path: 'wiki/entities/B.md', basename: 'B', content: '# B' },
    ];
    const ctx = {
      ...makeEngineCtx(files),
      deleteFile: async (p: string) => {
        deleted.push(p);
        throw new Error('disk full');
      },
    } as unknown as EngineContext;

    const result = await deleteEmptyStubs(ctx, 'wiki');

    expect(deleted).toEqual(['wiki/entities/A.md', 'wiki/entities/B.md']);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/^wiki\/entities\/A\.md: disk full$/);
  });
});

// --- 4. merge-duplicates.ts -------------------------------------------------
//
// No regression test lives here. The original pinned the filter expression by
// rebuilding it inside the test file — it did not exercise the production
// function, so a regression stayed green (DocTpoint, #383 follow-up).
//
// The filter itself is slated for replacement: #386 (assigned to DocTpoint)
// rewrites the rewrite to sweep the whole vault and handle the bare-title
// `[[Foo]]` link form, with a resolve-before-replace safeguard. The real
// regression coverage for this site belongs to that implementation, which
// rewrites the function and will assert against its own production code.

// --- 5. auto-maintain.ts (Phase 2 source-pollution scan) -------------------
//
// Phase 2 previously lived inline in `runStartupCheck` (which sleeps 3s
// and needs the whole startup surface), so it is extracted into the
// module-level `normalizeSourcesInFolder` (src/core/sources-normalizer.ts)
// — the same module-function shape as Phase 3 (`findIncompletePages`).

describe('PR #384 / #383 — normalizeSourcesInFolder (production function)', () => {
  it('serializes concurrent normalizers on one vault and keeps the second read current', async () => {
    const processed: string[] = [];
    const byPath = new Map<string, string>([
      ['wiki/sources/Race.md', '---\nsources: ["[[Notizen/Race.md]]"]\n---\n# Race\n'],
    ]);
    const app = makeVaultNormalizerApp(byPath, processed);
    const originalProcess = app.vault.process;
    app.vault.process = async (file, fn) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      await originalProcess(file, fn);
    };

    const [first, second] = await Promise.all([
      normalizeSourcesInFolder(app as unknown as App, 'wiki', false),
      normalizeSourcesInFolder(app as unknown as App, 'wiki', false),
    ]);

    expect(processed).toEqual(['wiki/sources/Race.md']);
    expect(first.filesCleaned + second.filesCleaned).toBe(1);
    expect(byPath.get('wiki/sources/Race.md')).toContain('[[sources/race]]');
  });

  it('processes only polluted files inside the wiki folder', async () => {
    const processed: string[] = [];
    const byPath = new Map<string, string>([
      ['wiki/sources/Polluted.md', '---\nsources: ["[[Notizen/Foo.md]]"]\n---\n# Polluted\n'],
      ['wiki-archive/Polluted.md', '---\nsources: ["[[Notizen/Foo.md]]"]\n---\n# Polluted\n'],
      ['wiki.md', '---\nsources: ["[[Notizen/Foo.md]]"]\n---\n# wiki\n'],
    ]);
    const app = makeVaultNormalizerApp(byPath, processed);

    const result = await normalizeSourcesInFolder(app as unknown as App, 'wiki', false);

    expect(processed).toEqual(['wiki/sources/Polluted.md']);
    expect(result).toEqual({ filesCleaned: 1, entriesCleaned: 1 });
  });

  it('does not process a clean wiki file', async () => {
    const processed: string[] = [];
    const byPath = new Map<string, string>([
      ['wiki/sources/Clean.md', '---\nsources: ["[[sources/Foo]]"]\n---\n# Clean\n'],
    ]);
    const app = makeVaultNormalizerApp(byPath, processed);

    const result = await normalizeSourcesInFolder(app as unknown as App, 'wiki', false);

    expect(processed).toEqual([]);
    expect(result).toEqual({ filesCleaned: 0, entriesCleaned: 0 });
  });

  it('returns 0 counts when vault.read throws', async () => {
    const app = {
      vault: {
        getMarkdownFiles: () => [{ path: 'wiki/sources/X.md', basename: 'X', extension: 'md' }],
        read: async () => {
          throw new Error('IO error');
        },
        process: async () => {},
      },
    };

    const result = await normalizeSourcesInFolder(app as unknown as App, 'wiki', false);

    expect(result).toEqual({ filesCleaned: 0, entriesCleaned: 0 });
  });
});

function makeVaultNormalizerApp(
  byPath: Map<string, string>,
  processed: string[]
): {
  vault: {
    getMarkdownFiles: () => Array<{ path: string; basename: string; extension: string }>;
    read: (file: { path: string }) => Promise<string>;
    process: (file: { path: string }, fn: (d: string) => string | Promise<string>) => Promise<void>;
  };
} {
  return {
    vault: {
      getMarkdownFiles: () => Array.from(byPath.keys()).map(p => ({
        path: p,
        basename: p.split('/').pop() ?? p,
        extension: 'md',
      })),
      read: async (f: { path: string }) => byPath.get(f.path) ?? '',
      process: async (f: { path: string }, fn: (d: string) => string | Promise<string>) => {
        processed.push(f.path);
        byPath.set(f.path, String(await fn(byPath.get(f.path) ?? '')));
      },
    },
  };
}

// --- 6. contradictions.ts (missed site fixed in follow-up) ----------------

describe('PR #384 follow-up — contradictions.ts leak guard', () => {
  it('excludes wiki/contradictions-old sibling from the contradictions inventory', async () => {
    const files: MockVaultFile[] = [
      { path: 'wiki/contradictions/Real.md', basename: 'Real', content: '# Real\n\n## Status\nopen' },
      { path: 'wiki/contradictions-old/Fake.md', basename: 'Fake', content: '# Fake\n\n## Status\nopen' },
    ];
    const ctx = makeEngineCtx(files);
    const cm = new ContradictionManager(ctx);
    const results = await cm.getOpenContradictions();

    const paths = results.map(r => r.path);
    expect(paths).toContain('wiki/contradictions/Real.md');
    expect(paths).not.toContain('wiki/contradictions-old/Fake.md');
  });

  it('excludes adjacent file at the wiki folder boundary', async () => {
    // isInFolderScope('wiki', 'wiki/contradictions', false) === false
    const files: MockVaultFile[] = [
      { path: 'wiki/contradictions/Real.md', basename: 'Real', content: '# Real\n\n## Status\nopen' },
      // The folder-itself path: TFile-style is not what getMarkdownFiles returns,
      // but if a file had been named identically to the boundary check it
      // would leak under the old unanchored form. This pins the boundary.
      { path: 'wiki/contradictions.md', basename: 'contradictions', content: '# contradictions\n\n## Status\nopen' },
    ];
    const ctx = makeEngineCtx(files);
    const cm = new ContradictionManager(ctx);
    const results = await cm.getOpenContradictions();

    const paths = results.map(r => r.path);
    expect(paths).toContain('wiki/contradictions/Real.md');
    expect(paths).not.toContain('wiki/contradictions.md');
  });
});
