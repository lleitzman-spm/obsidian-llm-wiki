import {
  extractBody,
  extractPassthroughLines,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../../../../src/core/frontmatter';
import { nativeSourceLink, nativeSourceSlug, normalizeNativeVaultPath, normalizeNativeWikiFolder } from './slug';
import type {
  NativeCompatibilityReason,
  NativeMergeInput,
  NativeMergePlan,
} from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function normalizeSourceEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) return trimmed.slice(2, -2).trim();
  return trimmed;
}

function nativeMergeFrontmatter(existingContent: string, sourcePath: string, date: string): { frontmatter: string; body: string; wasMerged: boolean } {
  const fm = parseFrontmatter(existingContent);
  const body = extractBody(existingContent);
  if (!fm) return { frontmatter: '', body: existingContent, wasMerged: false };

  const sourceSet = new Set<string>();
  for (const source of Array.isArray(fm.sources) ? fm.sources : []) {
    sourceSet.add(normalizeSourceEntry(String(source)));
  }
  sourceSet.add(sourcePath);
  const mergedSources = Array.from(sourceSet).map(source => `[[${source}]]`);
  const created = fm.created || date;
  const passthroughLines = extractPassthroughLines(existingContent);
  const frontmatter = serializeFrontmatter(
    {
      type: fm.type,
      created,
      updated: date,
      sources: mergedSources,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      reviewed: fm.reviewed,
      aliases: Array.isArray(fm.aliases) ? fm.aliases : undefined,
    },
    { tagStyle: 'block', emitEmptyTags: true, passthroughLines },
  );
  return { frontmatter, body, wasMerged: true };
}

function reason(code: string, message: string): NativeCompatibilityReason {
  return { code, message };
}

function action(current: string, next: string): 'replace' | 'unchanged' {
  return current === next ? 'unchanged' : 'replace';
}

/**
 * Plan the deterministic portion of a native merge.  Native `mergePage`,
 * reviewed append, and complementary append all make an LLM decision about
 * body bytes; those modes therefore return a candidate plus a refusal reason.
 * Only the no-new-info/frontmatter-only path is safe to apply here.
 */
export function planNativeMerge(input: NativeMergeInput): NativeMergePlan {
  const pagePath = normalizeNativeVaultPath(input.pagePath, 'pagePath');
  const sourcePath = normalizeNativeVaultPath(input.sourcePath, 'sourcePath');
  const wikiFolder = normalizeNativeWikiFolder(input.wikiFolder);
  const reasons: NativeCompatibilityReason[] = [];
  if (!ISO_DATE.test(input.date)) reasons.push(reason('invalid-date', `Native merge date is invalid: ${input.date}`));
  if (input.existingContent === undefined) reasons.push(reason('missing-page-body', 'Native merge requires the existing page bytes'));

  const expectedSlug = nativeSourceSlug(sourcePath, input.slug);
  if (input.sourceSlug !== undefined && input.sourceSlug !== expectedSlug) {
    reasons.push(reason('source-slug-mismatch', `Expected ${expectedSlug} for ${sourcePath}, received ${input.sourceSlug}`));
  }

  const sourceRef = nativeSourceLink(sourcePath, input.slug).slice(2, -2);
  const merged = reasons.length === 0
    ? nativeMergeFrontmatter(input.existingContent, sourceRef, input.date)
    : { frontmatter: '', body: input.existingContent, wasMerged: false };
  const frontmatterOnly = merged.wasMerged ? `${merged.frontmatter}\n\n${merged.body}` : input.existingContent;
  const bodyChanged = input.proposedBody !== undefined && input.proposedBody !== merged.body;

  if (input.mode !== 'frontmatter-only') {
    reasons.push(reason(
      'native-llm-seam-required',
      `Native ${input.mode} requires PageFactory triage/body generation and cannot be applied by a deterministic planner`,
    ));
  }
  if (!merged.wasMerged && reasons.length === 0) {
    reasons.push(reason('missing-page-body', 'Native merge frontmatter was not parseable; preserving bytes is not a proven merge'));
  }
  if (bodyChanged) {
    reasons.push(reason('native-llm-seam-required', 'A proposed body is not trusted without the native merge/append path'));
  }

  const canApply = reasons.length === 0;
  return Object.freeze({
    status: canApply ? 'ready' : 'requires-native-comparison',
    canApply,
    reasons,
    path: pagePath,
    action: canApply ? action(input.existingContent, frontmatterOnly) : 'replace',
    content: frontmatterOnly,
    currentContent: input.existingContent,
    mode: input.mode,
    sourceSlug: expectedSlug,
    frontmatterChanged: frontmatterOnly !== input.existingContent && merged.wasMerged,
    bodyChanged,
  });
}
