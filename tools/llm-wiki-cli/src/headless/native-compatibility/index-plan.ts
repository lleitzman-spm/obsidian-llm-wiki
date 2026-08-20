import { parseFrontmatter } from '../../../../../src/core/frontmatter';
import { TEXTS } from '../../../../../src/texts';
import { nativeSourceSlug, normalizeNativeVaultPath, normalizeNativeWikiFolder } from './slug';
import type {
  NativeCompatibilityReason,
  NativeIndexInput,
  NativeIndexPage,
  NativeIndexPlan,
  NativePlannedFile,
  NativeSourceSlugOptions,
} from './types';

function reason(code: string, message: string): NativeCompatibilityReason {
  return { code, message };
}

function pageBasename(page: NativeIndexPage, name: string): string {
  if (typeof page.basename === 'string' && page.basename.trim()) return page.basename.trim();
  if (typeof page.path === 'string' && page.path.trim()) {
    const file = page.path.replaceAll('\\', '/').split('/').pop() ?? page.path;
    return file.replace(/\.md$/iu, '');
  }
  throw new Error(`${name} page has no basename or path`);
}

/** Byte-for-byte equivalent of IndexGenerator's private firstBodyLine. */
export function nativeIndexSummary(content: string): string {
  const fm = parseFrontmatter(content);
  let body = content;
  if (fm) {
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx > 0) body = content.substring(endIdx + 4);
  }
  const lines = body.split('\n').filter(line => line.trim() && !line.startsWith('#') && !line.startsWith('---'));
  return lines[0]?.substring(0, 100) || 'No summary';
}

/** Byte-for-byte equivalent of IndexGenerator's private parseAliases. */
export function nativeIndexAliases(content: string): string[] {
  const fm = parseFrontmatter(content);
  if (!fm?.aliases || !Array.isArray(fm.aliases) || fm.aliases.length === 0) return [];
  return fm.aliases
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    .map(alias => alias.trim());
}

function renderSection(
  label: string,
  pages: readonly NativeIndexPage[],
  folder: 'entities' | 'concepts',
): string {
  let section = `\n## ${label}\n\n`;
  for (const page of pages) {
    const basename = pageBasename(page, folder);
    const aliases = nativeIndexAliases(page.content);
    const aliasText = aliases.length > 0 ? ` \`aliases: ${aliases.join(', ')}\`` : '';
    const summary = nativeIndexSummary(page.content);
    section += `- [[${folder}/${basename}|${basename}]]${aliasText} - ${summary}\n`;
  }
  return section;
}

function renderSourceSection(
  label: string,
  pages: readonly NativeIndexInput['sources'][number][],
  slugOptions: NativeSourceSlugOptions | undefined,
): string {
  let section = `\n## ${label}\n\n`;
  for (const page of pages) {
    const basename = pageBasename(page, 'source');
    const expected = nativeSourceSlug(page.sourcePath, slugOptions);
    if (basename !== expected) {
      throw new Error(`source page basename ${basename} does not match native slug ${expected} for ${page.sourcePath}`);
    }
    const aliases = nativeIndexAliases(page.content);
    const aliasText = aliases.length > 0 ? ` \`aliases: ${aliases.join(', ')}\`` : '';
    // Native IndexGenerator intentionally omits summaries for source pages.
    section += `- [[sources/${basename}|${basename}]]${aliasText}\n`;
  }
  return section;
}

function labelsFor(language: string): { subtitle: string; entities: string; concepts: string; sources: string } {
  const key = language in TEXTS.en.indexLabels ? language as keyof typeof TEXTS.en.indexLabels : 'en';
  return TEXTS.en.indexLabels[key];
}

/**
 * Plan the exact three-section native index.  Source entries require their raw
 * source path so a basename-only candidate cannot accidentally reintroduce
 * pre-v1.26.4 collision-prone links.
 */
export function planNativeIndex(input: NativeIndexInput): NativeIndexPlan {
  const reasons: NativeCompatibilityReason[] = [];
  let path: string;
  try {
    path = `${normalizeNativeWikiFolder(input.wikiFolder)}/index.md`;
  } catch (error) {
    path = String(input.wikiFolder);
    reasons.push(reason('invalid-path', error instanceof Error ? error.message : String(error)));
  }

  let content = '';
  if (reasons.length === 0) {
    try {
      const labels = labelsFor(input.wikiLanguage || 'en');
      content = '# Wiki Index\n\n';
      content += `> ${labels.subtitle}\n\n`;
      content += '> Note: Text in backticks after page names shows aliases — alternative names, abbreviations, or translations.\n\n';
      content += renderSection(labels.entities, input.entities, 'entities');
      content += renderSection(labels.concepts, input.concepts, 'concepts');
      content += renderSourceSection(labels.sources, input.sources, input.slug);
    } catch (error) {
      reasons.push(reason('ambiguous-source-entry', error instanceof Error ? error.message : String(error)));
    }
  }
  const canApply = reasons.length === 0;
  return Object.freeze({
    status: canApply ? 'ready' : 'refused',
    canApply,
    reasons,
    path,
    action: 'replace',
    content: canApply ? content : undefined,
    sectionCounts: {
      entities: input.entities.length,
      concepts: input.concepts.length,
      sources: input.sources.length,
    },
  });
}

export function planNativeEmptyIndex(wikiFolder: string): NativePlannedFile {
  try {
    const path = `${normalizeNativeWikiFolder(wikiFolder)}/index.md`;
    return Object.freeze({
      status: 'ready',
      canApply: true,
      reasons: [],
      path,
      action: 'replace',
      content: '# Wiki Index\n\n> No pages yet. Ingest sources to populate the Wiki.\n',
    });
  } catch (error) {
    return Object.freeze({
      status: 'refused',
      canApply: false,
      reasons: [reason('invalid-path', error instanceof Error ? error.message : String(error))],
      path: wikiFolder,
      action: 'replace',
    });
  }
}
