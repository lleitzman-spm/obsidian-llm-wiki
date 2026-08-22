import { TEXTS } from '../../../texts';
import { getText } from '../../../core/i18n';
import { fixDoubleNestedWikiLinks } from '../utils';
import { scanPollutedSources, fixPollutedSources } from '../../../core/sources-normalizer';
import { parseFrontmatter } from '../../../core/frontmatter';
import { LINT_PREP_BATCH_READ } from '../../../constants';
import { LintPhaseContext, ScannerPage } from '../types';
import { isInFolderScope } from '../../../core/folder-scope';
import { normalizePath } from 'obsidian';
import { getVaultPathWriteQueue, notifyVaultWrite } from '../../../core/path-write-safety';

export interface PreparationResult {
  wikiFiles: Array<{ path: string; basename: string }>;
  pageMap: Map<string, ScannerPage>;
  /**
   * Source bodies available to quote-grounding. This includes wiki source
   * pages and raw vault notes explicitly cited by a Mentions entry. Keeping
   * this separate from pageMap avoids treating every vault note as a wiki
   * page while still letting the scanner resolve raw-note links.
   */
  sourceMap: Map<string, ScannerPage>;
  knownTargets: Set<string>;
  knownTargetsLower: Set<string>;
  doubleNestFixes: number;
  sourcesNormalizedFiles: number;
  sourcesNormalizedEntries: number;
}

export async function runPreparationPhase(
  ctx: LintPhaseContext,
): Promise<PreparationResult> {
  const wikiFiles = ctx.app.vault.getMarkdownFiles()
    .filter(f => isInFolderScope(f.path, ctx.settings.wikiFolder, false) &&
                 !f.path.includes('index.md') &&
                 !f.path.includes('log.md') &&
                 !f.path.includes('/schema/') &&
                 !f.path.includes('/contradictions/'));

  const allVaultFiles = ctx.app.vault.getMarkdownFiles();
  const { known: knownTargets, knownLower: knownTargetsLower } = buildKnownTargets(allVaultFiles);

  const pageMap = new Map<string, ScannerPage>();
  const writeQueue = getVaultPathWriteQueue(
    ctx.app.vault,
    allVaultFiles.map(file => file.path),
  );
  ctx.stageNotice?.setMessage(
    getText(ctx.settings.language, 'lintReadingPages').replace('{count}', String(wikiFiles.length))
  );
  ctx.wikiEngine.updateStatusBar(getText(ctx.settings.language, 'lintStagePrep'));
  console.debug(`lintWiki: reading ${wikiFiles.length} wiki pages in parallel`);

  const BATCH_READ = LINT_PREP_BATCH_READ;
  for (let i = 0; i < wikiFiles.length; i += BATCH_READ) {
    ctx.checkCancelled();
    const batch = wikiFiles.slice(i, i + BATCH_READ);
    const batchResults = await Promise.all(
      batch.map(async file => {
        const content = await ctx.app.vault.read(file);
        return { path: file.path, content, basename: file.basename };
      })
    );
    for (const r of batchResults) {
      pageMap.set(r.path, r);
    }
  }

  // Quote grounding needs the body behind both canonical wiki source links
  // and raw-note links emitted by the page factory. The old preparation phase
  // only retained wiki pages, so a valid citation such as
  // `[[10 Sources/approved/note]]` was reported as ungrounded during lint.
  // Read only explicitly cited raw notes rather than making the whole vault
  // a fallback source corpus (which would make bare legacy quotes pass on
  // unrelated notes).
  const sourceMap = new Map<string, ScannerPage>();
  for (const [path, page] of pageMap) {
    if (path.startsWith(`${ctx.settings.wikiFolder}/sources/`)) {
      sourceMap.set(path, page);
    }
  }
  const rawSourceTargets = new Set<string>();
  const mentionLinkPattern = /^[-*]\s+"[^"]+"(?:\s*[—-]\s*\[\[([^\]]+)\]\])?\s*$/gm;
  for (const page of pageMap.values()) {
    let match: RegExpExecArray | null;
    while ((match = mentionLinkPattern.exec(page.content)) !== null) {
      const target = (match[1] ?? '').split('|')[0].trim();
      if (!target || target.startsWith('sources/') || target.startsWith(`${ctx.settings.wikiFolder}/sources/`)) {
        continue;
      }
      const normalized = normalizePath(target).replace(/\\/g, '/');
      rawSourceTargets.add(normalized);
      if (!normalized.toLowerCase().endsWith('.md')) rawSourceTargets.add(`${normalized}.md`);
    }
  }
  const vaultFilesByPath = new Map(
    allVaultFiles.map(file => [normalizePath(file.path).replace(/\\/g, '/'), file]),
  );
  const rawSourceFiles = [...rawSourceTargets]
    .map(path => vaultFilesByPath.get(path))
    .filter((file): file is (typeof allVaultFiles)[number] => file !== undefined)
    .filter(file => !file.path.startsWith(`${ctx.settings.wikiFolder}/`));
  for (let i = 0; i < rawSourceFiles.length; i += BATCH_READ) {
    const batch = rawSourceFiles.slice(i, i + BATCH_READ);
    const batchResults = await Promise.all(batch.map(async file => {
      const content = await ctx.app.vault.read(file);
      return {
        path: normalizePath(file.path).replace(/\\/g, '/'),
        content,
        basename: file.basename,
      };
    }));
    for (const source of batchResults) sourceMap.set(source.path, source);
  }
  ctx.stageNotice?.setMessage(
    getText(ctx.settings.language, 'lintReadingPagesProgress')
      .replace('{current}', String(wikiFiles.length))
      .replace('{total}', String(wikiFiles.length))
  );
  console.debug(`lintWiki: read ${wikiFiles.length}/${wikiFiles.length} pages`);

  // Double-nested wiki-link fix
  ctx.stageNotice?.setMessage(getText(ctx.settings.language, 'lintScanningLinks'));
  let doubleNestFixes = 0;
  for (const [path, info] of pageMap) {
    const abstractFile = ctx.app.vault.getAbstractFileByPath(path);
    if (abstractFile) {
      await runPreparationWrite(ctx, writeQueue, path, async () => {
        const data = await ctx.app.vault.read(abstractFile as { path: string });
        const { fixed, content } = fixDoubleNestedWikiLinks(data);
        if (fixed <= 0) return false;
        await ctx.app.vault.process(abstractFile, () => content);
        await verifyPreparationWrite(ctx, abstractFile as { path: string }, content);
        doubleNestFixes += fixed;
        info.content = content;
        console.debug(`lintWiki: fixed ${fixed} double-nested link(s) in ${path}`);
        return true;
      });
    }
  }
  const logPath = `${ctx.settings.wikiFolder}/log.md`;
  const logFile = ctx.app.vault.getAbstractFileByPath(logPath);
  if (logFile) {
    await runPreparationWrite(ctx, writeQueue, logPath, async () => {
      const data = await ctx.app.vault.read(logFile as { path: string });
      const { fixed, content } = fixDoubleNestedWikiLinks(data);
      if (fixed > 0) {
        await ctx.app.vault.process(logFile, () => content);
        await verifyPreparationWrite(ctx, logFile as { path: string }, content);
        doubleNestFixes += fixed;
        console.debug(`lintWiki: fixed ${fixed} double-nested link(s) in log.md`);
        return true;
      }
      return false;
    });
  }
  if (doubleNestFixes > 0) {
    console.debug(`lintWiki: total ${doubleNestFixes} double-nested link(s) fixed`);
  }

  // Sources field normalize
  let sourcesNormalizedFiles = 0;
  let sourcesNormalizedEntries = 0;
  const sourcesPreserveCase = ctx.settings.slugCase === 'preserve';
  for (const [path, info] of pageMap) {
    if (!scanPollutedSources(info.content, ctx.settings.wikiFolder, sourcesPreserveCase)) continue;
    const abstractFile = ctx.app.vault.getAbstractFileByPath(path);
    if (abstractFile) {
      await runPreparationWrite(ctx, writeQueue, path, async () => {
        const current = await ctx.app.vault.read(abstractFile as { path: string });
        const { fixed, content } = fixPollutedSources(current, ctx.settings.wikiFolder, sourcesPreserveCase);
        if (fixed <= 0) return false;
        await ctx.app.vault.process(abstractFile, () => content);
        await verifyPreparationWrite(ctx, abstractFile as { path: string }, content);
        sourcesNormalizedFiles += 1;
        sourcesNormalizedEntries += fixed;
        info.content = content;
        console.debug(`lintWiki: normalized ${fixed} sources entry(ies) in ${path}`);
        return true;
      });
    }
  }
  if (sourcesNormalizedFiles > 0) {
    console.debug(`lintWiki: sources normalized in ${sourcesNormalizedFiles} files (${sourcesNormalizedEntries} entries)`);
  }

  // v1.23.0 P0-2 follow-up: exclude Welcome notes from Lint.
  //
  // Welcome notes have `type: welcome` frontmatter and live in
  // `${wikiFolder}/${getWelcomeFileName(lang)}.md` — the filename is
  // localized to the user's wiki language, so we cannot filter by
  // filename. Filter by frontmatter instead. This is the only
  // robust signal that a page is a Welcome note.
  //
  // Without this filter, Lint would treat the welcome note as a
  // regular wiki page and report false positives:
  //   - "dead link" for every [[link]] in the welcome body
  //   - "orphan" because the welcome page has no incoming links
  //   - "ungrounded quote" for any quoted phrases in the welcome
  //     template
  //   - "tag violation" if the welcome note doesn't conform to
  //     entity/concept tag vocab
  //
  // The same welcome-filter must apply to Ingest and Query Wiki's
  // `getExistingWikiPages` (which also uses `wikiFolder/` filter).
  // Search for `type: welcome` in those call sites — if missed, the
  // LLM would treat welcome as an existing entity and try to update
  // it during ingestion.
  let welcomeSkipped = 0;
  for (const [path, info] of pageMap) {
    const fm = parseFrontmatter(info.content);
    // Defensive: parseFrontmatter returns null for malformed
    // frontmatter. Only skip pages with a valid `type: welcome` —
    // any other shape (no frontmatter, malformed, no type) is
    // kept for Lint to surface as a separate issue.
    if (fm && fm.type === 'welcome') {
      pageMap.delete(path);
      welcomeSkipped += 1;
      console.debug(`lintWiki: skipped welcome page ${path}`);
    }
  }
  const filteredWikiFiles = wikiFiles.filter(f => pageMap.has(f.path));
  console.debug(
    `lintWiki: ${wikiFiles.length} wiki files, ${welcomeSkipped} welcome skipped, ` +
    `${filteredWikiFiles.length} linted`
  );

  return {
    wikiFiles: filteredWikiFiles,
    pageMap,
    sourceMap,
    knownTargets,
    knownTargetsLower,
    doubleNestFixes,
    sourcesNormalizedFiles,
    sourcesNormalizedEntries,
  };
}

type PreparationWriteContext = {
  withPathWriteLock?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
  onFileWrite?: (path: string) => void;
};

async function runPreparationWrite(
  ctx: LintPhaseContext,
  queue: ReturnType<typeof getVaultPathWriteQueue>,
  path: string,
  operation: () => Promise<boolean>,
): Promise<void> {
  const engine = ctx.wikiEngine as unknown as PreparationWriteContext;
  if (engine.withPathWriteLock) {
    const wrote = await engine.withPathWriteLock(path, operation);
    if (wrote) notifyVaultWrite(
      engine.onFileWrite ?? (ctx.app.vault as unknown as { onFileWrite?: (p: string) => void }).onFileWrite,
      queue,
      path,
    );
    return;
  }
  return queue.run(path, async held => {
    const wrote = await held.runRaw(path, operation);
    if (wrote) notifyVaultWrite(
        engine.onFileWrite ?? (ctx.app.vault as unknown as { onFileWrite?: (p: string) => void }).onFileWrite,
        queue,
        path,
      );
  });
}

async function verifyPreparationWrite(
  ctx: LintPhaseContext,
  file: { path: string },
  expected: string,
): Promise<void> {
  const actual = await ctx.app.vault.read(file);
  if (actual !== expected) {
    throw new Error(`Lint preparation write verification failed: ${file.path}`);
  }
}

function buildKnownTargets(
  allVaultFiles: Array<{ basename: string; path: string }>
): { known: Set<string>; knownLower: Set<string> } {
  const known = new Set<string>();
  const knownLower = new Set<string>();
  const addTarget = (t: string) => { known.add(t); knownLower.add(t.toLowerCase()); };
  for (const file of allVaultFiles) {
    const nameWithoutExt = file.basename.replace('.md', '');
    addTarget(file.basename);
    addTarget(nameWithoutExt);
    const relPath = file.path.replace('.md', '');
    addTarget(relPath);
    addTarget(file.path);
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const subPath = parts.slice(i).join('/');
      addTarget(subPath);
      addTarget(subPath + '.md');
    }
  }
  return { known, knownLower };
}

export { TEXTS };
