import { describe, expect, it } from 'vitest';

import {
  BOILERPLATE_POLICY_HASH,
  decodeStrictUtf8,
  normalizeInlineText,
  parseProjectionPage,
  segmentSentences,
} from '../../../../../tools/llm-wiki-cli/src/headless/projection-parser';

describe('projection-parser/v1', () => {
  it('rejects malformed UTF-8 and normalizes CRLF before parsing', () => {
    expect(() => decodeStrictUtf8(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/i);

    const result = parseProjectionPage(Buffer.from('# Title\r\n\r\nBody one.\r\nBody two.', 'utf8'));
    expect(result.source).toBe('# Title\n\nBody one.\nBody two.');
    expect(result.statements.map((statement) => statement.canonicalText)).toEqual([
      'Body one.',
      'Body two.',
    ]);
  });

  it('renders inline Markdown canonically while preserving case and punctuation', () => {
    expect(normalizeInlineText('**Bold** [label](https://example.test) [[Target|Alias]] `x` \\* yes'))
      .toBe('Bold label Alias x * yes');
  });

  it('segments paragraph sentences and retains normalized UTF-8 byte offsets', () => {
    const result = parseProjectionPage(Buffer.from('Café works. It is ready.\n', 'utf8'));
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0]).toMatchObject({
      kind: 'paragraph',
      canonicalText: 'Café works.',
      startOffset: 0,
      endOffset: Buffer.byteLength('Café works.'),
    });
    expect(result.statements[1].canonicalText).toBe('It is ready.');
    expect(result.statements[1].startOffset).toBe(Buffer.byteLength('Café works. '));
  });

  it('emits headings, list items, and table cells deterministically', () => {
    const result = parseProjectionPage(Buffer.from(
      '# Page title\n\n## Scope\nA first sentence. A second sentence.\n\n- One item. Two item.\n- **Two**\n\n| Name | Value |\n| --- | --- |\n| Alpha | `42` |\n',
      'utf8',
    ));
    expect(result.statements.map((statement) => [statement.kind, statement.canonicalText])).toEqual([
      ['heading', 'Scope'],
      ['paragraph', 'A first sentence.'],
      ['paragraph', 'A second sentence.'],
      ['list-item', 'One item.'],
      ['list-item', 'Two item.'],
      ['list-item', 'Two'],
      ['table-cell', 'Name'],
      ['table-cell', 'Value'],
      ['table-cell', 'Alpha'],
      ['table-cell', '42'],
    ]);
    expect(result.statements.every((statement) => statement.startOffset < statement.endOffset)).toBe(true);
  });

  it('segments list and table cells when a cell contains multiple sentences', () => {
    const result = parseProjectionPage(Buffer.from('- First. Second.\n\n| Cell |\n| --- |\n| One. Two. |\n', 'utf8'));
    expect(result.statements.map((statement) => [statement.kind, statement.canonicalText])).toEqual([
      ['list-item', 'First.'],
      ['list-item', 'Second.'],
      ['table-cell', 'Cell'],
      ['table-cell', 'One.'],
      ['table-cell', 'Two.'],
    ]);
  });

  it('applies only the checked-in boilerplate policy', () => {
    const result = parseProjectionPage(Buffer.from(
      '---\ntitle: A title\ncustom: Keep me.\n---\n\n# A title\n\n## Navigation\n- [[Home]]\n\n## Body\nMeaning survives.\n',
      'utf8',
    ));
    expect(result.statements.map((statement) => statement.canonicalText)).toEqual(['custom: Keep me.', 'Body', 'Meaning survives.']);
    expect(result.excluded.map((statement) => statement.exclusionReason)).toEqual([
      'frontmatter-key:title',
      'title-heading',
      'navigation-section',
    ]);
    expect(result.policyHash).toBe(BOILERPLATE_POLICY_HASH);
  });

  it('exposes the deterministic sentence segmenter as a pure helper', () => {
    expect(segmentSentences('One. Two!')).toEqual([
      { start: 0, end: 4, text: 'One.' },
      { start: 4, end: 9, text: ' Two!' },
    ]);
  });
});
