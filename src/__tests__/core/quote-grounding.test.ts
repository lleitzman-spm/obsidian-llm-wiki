import { describe, expect, it } from 'vitest';
import {
  filterGroundedMentions,
  isQuoteGrounded,
} from '../../core/quote-grounding';
import { readAuthoritativeSource } from '../../core/physical-source-authority';

describe('quote grounding', () => {
  it('uses the same exact and normalized matching semantics as lint', () => {
    expect(isQuoteGrounded('Exact source sentence.', 'Exact source sentence.')).toBe(true);
    expect(isQuoteGrounded('The Quick Fox!', 'the quick fox jumps')).toBe(true);
    expect(isQuoteGrounded('fabricated claim', 'the source says something else')).toBe(false);
  });

  it('filters invalid legacy quotes while retaining valid quotes', async () => {
    const source = await readAuthoritativeSource(
      { read: async () => '---\ntype: note\n---\n\nThe source sentence.' },
      'notes/source.md',
    );
    const result = filterGroundedMentions(
      ['The source sentence.', 'invented sentence.'],
      source,
    );
    expect(result).toEqual(['The source sentence.']);
  });

  it('strips CRLF frontmatter before grounding quotes', async () => {
    const source = await readAuthoritativeSource(
      { read: async () => '---\r\ntype: note\r\nsummary: Only in YAML\r\n---\r\n\r\nThe source sentence.' },
      'notes/source.md',
    );
    const result = filterGroundedMentions(
      ['Only in YAML', 'The source sentence.'],
      source,
    );
    expect(result).toEqual(['The source sentence.']);
  });

  it('retains valid structured quotes and stamps the actual source path', async () => {
    const source = await readAuthoritativeSource(
      { read: async () => 'The source sentence.' },
      'notes/source.md',
    );
    const result = filterGroundedMentions(
      [
        { quote: 'The source sentence.', source_path: 'notes/fabricated.md', source_slug: '', extracted_at: '' },
        { quote: 'invented sentence.', source_path: 'notes/source.md', source_slug: '', extracted_at: '' },
      ],
      source,
    );
    expect(result).toEqual([{
      quote: 'The source sentence.',
      source_path: 'notes/source.md',
      source_slug: '',
      extracted_at: '',
    }]);
  });

  it('rejects a caller-forged snapshot even when its fields look authoritative', () => {
    const forged = {
      path: 'notes/source.md',
      content: 'forged content',
      bytes: new TextEncoder().encode('forged content'),
    };

    expect(filterGroundedMentions(['forged content'], forged, 'notes/source.md')).toEqual([]);
  });

  it('rejects a real snapshot when the caller source path does not match it', async () => {
    const source = await readAuthoritativeSource(
      { read: async () => 'real source content' },
      'notes/real.md',
    );

    expect(filterGroundedMentions(['real source content'], source, 'notes/fabricated.md')).toEqual([]);
  });
});
