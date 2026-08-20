import { createHash } from 'node:crypto';

/** The only Markdown grammar supported by projection-parser/v1. */
export const PROJECTION_PARSER_VERSION = 'projection-parser/v1' as const;
export const NORMALIZATION_VERSION = 'unicode-nfkc-whitespace-v1' as const;

const POLICY = {
  version: 'boilerplate-policy/v1',
  frontmatterKeys: ['aliases', 'cssclasses', 'created', 'date', 'id', 'tags', 'title', 'type', 'updated'],
  titleHeading: { level: 1, position: 'first' },
  navigationHeadings: ['navigation', 'table of contents', 'contents'],
} as const;
export const BOILERPLATE_POLICY = POLICY;
const POLICY_CANONICAL = `${JSON.stringify(POLICY)}\n`;
/** SHA-256 of boilerplate-policy/v1.json (including its terminal LF). */
export const BOILERPLATE_POLICY_HASH = createHash('sha256').update(POLICY_CANONICAL, 'utf8').digest('hex');

export type StatementKind = 'heading' | 'paragraph' | 'list-item' | 'table-cell' | 'frontmatter-field';
export type PageStatementKind = 'sentence' | 'paragraph' | 'list-item' | 'table-cell' | 'heading';

export interface SentenceSegment {
  start: number;
  end: number;
  text: string;
}

export interface PageStatement {
  kind: StatementKind;
  statementKind: PageStatementKind;
  canonicalText: string;
  /** Alias retained for callers that use the semantic field name. */
  text: string;
  /** Exact source slice after CRLF normalization, before inline rendering. */
  rawText: string;
  /** UTF-8 byte offsets into `source` (end is exclusive). */
  startOffset: number;
  endOffset: number;
  /** Stable aliases for evidence consumers. */
  startByte: number;
  endByte: number;
  byteRange: { start: number; end: number };
  line: number;
  column: number;
  sectionPath: string[];
  ordinal: number;
}

export interface ExcludedStatement extends PageStatement {
  exclusionReason: string;
}

export interface ProjectionParseResult {
  version: typeof PROJECTION_PARSER_VERSION;
  normalizationVersion: typeof NORMALIZATION_VERSION;
  source: string;
  sourceBytes: Uint8Array;
  sourceHash: string;
  statements: PageStatement[];
  excluded: ExcludedStatement[];
  policyHash: string;
  boilerplatePolicyHash: string;
  grammarHash: string;
  unicodeHash: string;
}

export interface ParseProjectionOptions {
  /** Include the checked-in policy's excluded nodes in `excluded`. */
  includeExcluded?: boolean;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

interface PendingBlock {
  kind: StatementKind;
  start: number;
  end: number;
  textStart: number;
  text: string;
}

/** Decode bytes with no replacement-character fallback. */
export function decodeStrictUtf8(input: Uint8Array): string {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('projection-parser/v1 requires UTF-8 bytes (Uint8Array)');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (error) {
    throw new TypeError(`Invalid UTF-8 input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Render the small inline-Markdown subset used by the deterministic parser.
 * This deliberately does not interpret HTML, embeds, or link destinations as
 * semantic text: visible labels survive, syntax does not.
 */
export function normalizeInlineText(value: string): string {
  let text = value;
  const escaped: string[] = [];
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias ?? target);
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1');
  text = text.replace(/<[^>\n]+>/g, '');
  text = text.replace(/(`+)([\s\S]*?)\1/g, '$2');
  text = text.replace(/\\([\\`*_[\]{}()#+.!|~])/g, (_match, character: string) => `\uE000${escaped.push(character) - 1}\uE001`);
  text = text.replace(/[*_~]/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => escaped[Number(index)] ?? '');
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/**
 * Deterministic sentence segmentation for v1. A segment retains the source
 * whitespace at its start so its indexes remain source indexes; callers
 * canonicalize and trim the segment when producing a statement.
 */
export function segmentSentences(value: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint && codePoint > 0xffff) index += 1;
    if (!codePoint || !isSentenceTerminal(codePoint)) continue;
    const next = value[index + 1];
    if (next && !/\s/u.test(next)) continue;
    const end = index + 1;
    segments.push({ start, end, text: value.slice(start, end) });
    start = end;
  }
  if (start < value.length) segments.push({ start, end: value.length, text: value.slice(start) });
  return segments;
}

function isSentenceTerminal(codePoint: number): boolean {
  return codePoint === 0x2e || codePoint === 0x21 || codePoint === 0x3f || codePoint === 0x3002 || codePoint === 0xff01 || codePoint === 0xff1f;
}

/** Parse one normalized Markdown page into semantic page statements. */
export function parseProjectionPage(input: Uint8Array | string, options: ParseProjectionOptions = {}): ProjectionParseResult {
  const source = typeof input === 'string' ? normalizeLineEndings(input) : normalizeLineEndings(decodeStrictUtf8(input));
  const sourceBytes = new TextEncoder().encode(source);
  const byteOffsets = makeByteOffsets(source);
  const lines = splitLines(source);
  const statements: PageStatement[] = [];
  const excluded: ExcludedStatement[] = [];
  const sectionPath: string[] = [];
  let ordinal = 0;
  let firstHeadingSeen = false;
  let navigationDepth: number | null = null;
  let lineIndex = 0;

  const emit = (block: PendingBlock, text: string, start: number, end: number, reason?: string): void => {
    const canonicalText = normalizeInlineText(text);
    if (!canonicalText) return;
    const sourceStart = trimSourceStart(source, start, end);
    const sourceEnd = trimSourceEnd(source, sourceStart, end);
    if (sourceStart >= sourceEnd) return;
    const statement: PageStatement = {
      kind: block.kind,
      statementKind: block.kind === 'paragraph' ? 'sentence' : block.kind === 'frontmatter-field' ? 'paragraph' : block.kind,
      canonicalText,
      text: canonicalText,
      rawText: source.slice(sourceStart, sourceEnd),
      startOffset: byteOffsets[sourceStart],
      endOffset: byteOffsets[sourceEnd],
      startByte: byteOffsets[sourceStart],
      endByte: byteOffsets[sourceEnd],
      byteRange: { start: byteOffsets[sourceStart], end: byteOffsets[sourceEnd] },
      line: lineNumber(source, sourceStart),
      column: sourceStart - source.lastIndexOf('\n', sourceStart - 1) - 1,
      sectionPath: [...sectionPath],
      ordinal,
    };
    if (reason) {
      excluded.push({ ...statement, exclusionReason: reason });
    } else {
      statements.push(statement);
      ordinal += 1;
    }
  };

  if (lines[0]?.text.replace(/^\uFEFF/u, '') === '---') {
    const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)$/u.test(line.text.trim()));
    if (close > 0) {
      for (let index = 1; index < close; index += 1) {
        const line = lines[index];
        const match = /^\s*([A-Za-z][\w-]*)\s*:/u.exec(line.text);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const block: PendingBlock = { kind: 'frontmatter-field', start: line.start, end: line.end, textStart: line.start, text: line.text };
        if (POLICY.frontmatterKeys.includes(key as (typeof POLICY.frontmatterKeys)[number])) {
          emit(block, line.text, line.start, line.end, `frontmatter-key:${key}`);
        } else {
          emit(block, line.text, line.start, line.end);
        }
      }
      lineIndex = close + 1;
    }
  }

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (!line.text.trim()) {
      lineIndex += 1;
      continue;
    }
    if (/^\s*(`{3,}|~{3,})/u.test(line.text)) {
      const fence = /^\s*(`{3,}|~{3,})/u.exec(line.text)?.[1] ?? '```';
      lineIndex += 1;
      while (lineIndex < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`, 'u').test(lines[lineIndex].text)) lineIndex += 1;
      lineIndex += 1;
      continue;
    }
    const heading = /^( {0,3})(#{1,6})(?:[ \t]+(.*?)\s*#*\s*|[ \t]*)$/u.exec(line.text);
    if (heading) {
      const level = heading[2].length;
      const headingText = heading[3] ?? '';
      while (sectionPath.length >= level) sectionPath.pop();
      sectionPath.push(normalizeInlineText(headingText));
      const isFirstHeading = !firstHeadingSeen;
      firstHeadingSeen = true;
      const normalizedHeading = normalizeInlineText(headingText);
      const isNavigation = POLICY.navigationHeadings.includes(normalizedHeading.toLowerCase() as (typeof POLICY.navigationHeadings)[number]);
      if (isNavigation) navigationDepth = level;
      else if (navigationDepth !== null && level <= navigationDepth) navigationDepth = null;
      const block: PendingBlock = { kind: 'heading', start: line.start, end: line.end, textStart: line.start, text: headingText };
      if (navigationDepth === level && isNavigation) emit(block, headingText, line.start, line.end, 'navigation-section');
      else if (navigationDepth !== null) { /* navigation heading's descendants are excluded below */ }
      else if (level === 1 && isFirstHeading) emit(block, headingText, line.start, line.end, 'title-heading');
      else emit(block, headingText, line.start, line.end);
      lineIndex += 1;
      continue;
    }
    if (navigationDepth !== null) {
      lineIndex += 1;
      continue;
    }
    if (isTableHeader(lines, lineIndex)) {
      const header = lines[lineIndex];
      const delimiter = lines[lineIndex + 1];
      ordinal += emitTableCells(header, statements, excluded, sectionPath, byteOffsets, source, ordinal, false);
      lineIndex += 2;
      while (lineIndex < lines.length && isTableRow(lines[lineIndex].text)) {
        ordinal += emitTableCells(lines[lineIndex], statements, excluded, sectionPath, byteOffsets, source, ordinal, false);
        lineIndex += 1;
      }
      void delimiter;
      continue;
    }
    const list = listMarker(line.text);
    if (list) {
      const startLine = line;
      const textParts = [list.content];
      let end = line.end;
      lineIndex += 1;
      while (lineIndex < lines.length && /^\s{2,}\S/u.test(lines[lineIndex].text) && !listMarker(lines[lineIndex].text)) {
        textParts.push(lines[lineIndex].text.trim());
        end = lines[lineIndex].end;
        lineIndex += 1;
      }
      const block: PendingBlock = { kind: 'list-item', start: startLine.start, end, textStart: startLine.start + list.contentOffset, text: source.slice(startLine.start + list.contentOffset, end) };
      emitSentences(block, block.text, block.textStart, end, emit);
      continue;
    }
    const paragraphStart = line.start;
    const paragraphLines = [line.text];
    let paragraphEnd = line.end;
    lineIndex += 1;
    while (lineIndex < lines.length && lines[lineIndex].text.trim() && !isSpecialStart(lines, lineIndex)) {
      paragraphLines.push(lines[lineIndex].text);
      paragraphEnd = lines[lineIndex].end;
      lineIndex += 1;
    }
    const block: PendingBlock = { kind: 'paragraph', start: paragraphStart, end: paragraphEnd, textStart: paragraphStart, text: paragraphLines.join('\n') };
    emitSentences(block, block.text, paragraphStart, paragraphEnd, emit);
  }

  return {
    version: PROJECTION_PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    source,
    sourceBytes,
    sourceHash: createHash('sha256').update(sourceBytes).digest('hex'),
    statements,
    excluded: options.includeExcluded === false ? [] : excluded,
    policyHash: BOILERPLATE_POLICY_HASH,
    boilerplatePolicyHash: BOILERPLATE_POLICY_HASH,
    grammarHash: hashText('projection-parser-grammar/v1:atx-heading|paragraph|list|pipe-table|fenced-code'),
    unicodeHash: hashText('unicode-sentence-rules/v1:terminal=.?!。！？'),
  };
}

/** Descriptive aliases for callers that do not use the ADR name. */
export const parseMarkdownToPageStatements = parseProjectionPage;
export const parsePageStatements = parseProjectionPage;
export const parseMarkdown = parseProjectionPage;
export const normalizeCanonicalText = normalizeInlineText;

function emitSentences(block: PendingBlock, text: string, textStart: number, end: number, emit: (block: PendingBlock, text: string, start: number, end: number, reason?: string) => void): void {
  for (const segment of segmentSentences(text)) {
    const segmentStart = textStart + segment.start;
    const segmentEnd = textStart + segment.end;
    emit(block, segment.text, segmentStart, Math.min(segmentEnd, end));
  }
}

function emitTableCells(line: SourceLine, statements: PageStatement[], excluded: ExcludedStatement[], sectionPath: string[], byteOffsets: number[], source: string, ordinal: number, _unused: boolean): number {
  const firstOrdinal = ordinal;
  const pipes = [...line.text.matchAll(/\|/gu)].map((match) => match.index ?? 0);
  const boundaries = line.text.startsWith('|') ? pipes : [-1, ...pipes];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const rawStart = boundaries[index] + 1;
    const rawEnd = boundaries[index + 1];
    const start = trimSourceStart(line.text, rawStart, rawEnd) + line.start;
    const end = trimSourceEnd(line.text, start - line.start, rawEnd) + line.start;
    if (start >= end) continue;
    const rawCell = source.slice(start, end);
    const segments = segmentSentences(rawCell);
    for (const segment of segments) {
      const segmentStart = trimSourceStart(source, start + segment.start, start + segment.end);
      const segmentEnd = trimSourceEnd(source, segmentStart, start + segment.end);
      const canonicalText = normalizeInlineText(source.slice(segmentStart, segmentEnd));
      if (!canonicalText || /^:?-{3,}:?$/u.test(canonicalText)) continue;
      const statement: PageStatement = {
        kind: 'table-cell', statementKind: 'table-cell', canonicalText, text: canonicalText, rawText: source.slice(segmentStart, segmentEnd),
        startOffset: byteOffsets[segmentStart], endOffset: byteOffsets[segmentEnd], startByte: byteOffsets[segmentStart], endByte: byteOffsets[segmentEnd],
        byteRange: { start: byteOffsets[segmentStart], end: byteOffsets[segmentEnd] },
        line: lineNumber(source, segmentStart), column: segmentStart - source.lastIndexOf('\n', segmentStart - 1) - 1, sectionPath: [...sectionPath], ordinal,
      };
      statements.push(statement);
      ordinal += 1;
    }
  }
  void excluded;
  return ordinal - firstOrdinal;
}

function listMarker(text: string): { content: string; contentOffset: number } | null {
  const match = /^(\s{0,3})(?:[-+*]|\d+[.)])[ \t]+(.*)$/u.exec(text);
  return match ? { content: match[2], contentOffset: match[1].length + match[0].indexOf(match[2]) } : null;
}

function isTableHeader(lines: SourceLine[], index: number): boolean {
  return index + 1 < lines.length && isTableRow(lines[index].text) && isTableDelimiter(lines[index + 1].text);
}

function isTableRow(text: string): boolean { return text.includes('|') && text.trim().length > 0; }
function isTableDelimiter(text: string): boolean {
  if (!isTableRow(text)) return false;
  return text.split('|').filter((cell) => cell.trim()).every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}
function countNonEmptyCells(text: string): number { return text.split('|').filter((cell) => cell.trim()).length; }

function isSpecialStart(lines: SourceLine[], index: number): boolean {
  const text = lines[index].text;
  return /^( {0,3})#{1,6}(?:[ \t]+|$)/u.test(text) || listMarker(text) !== null || /^\s*(`{3,}|~{3,})/u.test(text) || isTableHeader(lines, index);
}

function normalizeLineEndings(value: string): string { return value.replace(/\r\n?/gu, '\n'); }

function splitLines(source: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source[index] !== '\n') continue;
    result.push({ start, end: index, text: source.slice(start, index) });
    start = index + 1;
  }
  return result;
}

function makeByteOffsets(source: string): number[] {
  const offsets = new Array<number>(source.length + 1).fill(0);
  let bytes = 0;
  for (let index = 0; index < source.length;) {
    const width = source.codePointAt(index)! > 0xffff ? 2 : 1;
    bytes += Buffer.byteLength(source.slice(index, index + width), 'utf8');
    for (let unit = 1; unit <= width; unit += 1) offsets[index + unit] = bytes;
    index += width;
  }
  return offsets;
}

function trimSourceStart(source: string, start: number, end: number): number {
  while (start < end && /\s/u.test(source[start])) start += 1;
  return start;
}
function trimSourceEnd(source: string, start: number, end: number): number {
  while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  return end;
}
function lineNumber(source: string, offset: number): number { return source.slice(0, offset).split('\n').length; }
function hashText(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
