import type { MentionWithProvenance } from '../types';
import { normalizePath } from 'obsidian';
import {
  isAuthoritativeSourceSnapshot,
  type AuthoritativeSourceSnapshot,
} from './physical-source-authority';

/**
 * Normalize text for the plugin's quote-grounding match: case-fold, remove
 * punctuation, and collapse whitespace.
 */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tier 1 + Tier 2 quote-grounding check shared by lint and write-time guards.
 */
export function isQuoteGrounded(quote: string, sourceBody: string): boolean {
  if (sourceBody.includes(quote)) return true;
  const normalizedQuote = normalizeQuote(quote);
  if (normalizedQuote.length === 0) return false;
  return normalizeQuote(sourceBody).includes(normalizedQuote);
}

function extractSourceBody(sourceContent: string): string {
  return sourceContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

/**
 * Keep only quotes grounded in the current authoritative source body. The
 * source path is taken from the read-bound snapshot, so a model cannot pair a
 * valid quote with a fabricated attribution path or caller-supplied body.
 */
export function filterGroundedMentions(
  mentions: MentionWithProvenance[] | string[] | undefined,
  source: AuthoritativeSourceSnapshot | string,
  sourcePath?: string,
): MentionWithProvenance[] | string[] | undefined {
  if (!mentions) return mentions;

  if (mentions.length === 0) return mentions;
  // The string overload is retained only so older callers remain source
  // compatible.  It is not trusted for grounding: caller-supplied text is
  // precisely the snapshot-forgery boundary this guard is meant to close.
  if (typeof source === 'string' || !isAuthoritativeSourceSnapshot(source)) return [];
  const expectedPath = sourcePath === undefined ? source.path : normalizePath(sourcePath).replace(/\\/g, '/');
  if (expectedPath !== source.path) return [];
  const sourceBody = extractSourceBody(source.content);
  if (typeof mentions[0] === 'string') {
    return (mentions as string[]).filter(quote => isQuoteGrounded(quote, sourceBody));
  }

  return (mentions as MentionWithProvenance[])
    .filter(mention => isQuoteGrounded(mention.quote, sourceBody))
    .map(mention => ({ ...mention, source_path: source.path }));
}

/**
 * Compatibility helper for direct page-factory callers that predate the
 * read-bound snapshot contract. Engine ingestion never uses this path: it
 * passes an AuthoritativeSourceSnapshot. Keeping the legacy adapter isolated
 * here lets old integrations retain quote filtering without weakening the
 * branded `filterGroundedMentions` boundary.
 */
export function filterLegacyGroundedMentions(
  mentions: MentionWithProvenance[] | string[] | undefined,
  sourceContent: string,
  sourcePath: string,
): MentionWithProvenance[] | string[] | undefined {
  if (!mentions) return mentions;
  const sourceBody = extractSourceBody(sourceContent);
  if (mentions.length === 0) return mentions;
  if (typeof mentions[0] === 'string') {
    return (mentions as string[]).filter(quote => isQuoteGrounded(quote, sourceBody));
  }
  return (mentions as MentionWithProvenance[])
    .filter(mention => isQuoteGrounded(mention.quote, sourceBody))
    .map(mention => ({ ...mention, source_path: normalizePath(sourcePath).replace(/\\/g, '/') }));
}
