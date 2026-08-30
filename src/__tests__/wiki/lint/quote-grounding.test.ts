import { describe, it, expect } from 'vitest';
import { scanQuoteGrounding, ScannerPage } from '../../../wiki/lint/scanners';

function makePage(path: string, content: string): ScannerPage {
  return { path, content, basename: path.split('/').pop() || '' };
}

function makeSourceMap(entries: Record<string, string>): Map<string, ScannerPage> {
  const m = new Map<string, ScannerPage>();
  for (const [path, content] of Object.entries(entries)) {
    m.set(path, makePage(path, content));
  }
  return m;
}

function makePageMap(entries: Record<string, string>): Map<string, ScannerPage> {
  const m = new Map<string, ScannerPage>();
  for (const [path, content] of Object.entries(entries)) {
    m.set(path, makePage(path, content));
  }
  return m;
}

function generatedSourcePage(
  rawPath: string,
  body: string,
  type = 'source',
  generatedPath = 'wiki/sources/article.md',
): [string, string] {
  return [generatedPath, `---\ntype: ${type}\nsource_file: "[[${rawPath}]]"\n---\n\n# Article\n\n${body}`];
}

describe('scanQuoteGrounding', () => {
  it('returns empty when there are no wiki pages', () => {
    const result = scanQuoteGrounding(new Map(), new Map(), 'wiki');
    expect(result).toEqual([]);
  });

  it('returns empty when pages have no Mentions section', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': '# Foo\n\nSome body without mentions.',
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': '# Article\n\nSome body without mentions.',
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('passes a quote that exists verbatim in the linked source', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "The quick brown fox" — [[sources/article]]`,
      [generatedSourcePage('notes/article.md', 'generated summary only')[0]]: generatedSourcePage('notes/article.md', 'generated summary only')[1],
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': generatedSourcePage('notes/article.md', 'generated summary only')[1],
      'notes/article.md': `---\nkind: note\n---\n\nThe quick brown fox jumps over the lazy dog.`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('flags a quote that does not exist in the linked source', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "this sentence is fabricated" — [[sources/article]]`,
      [generatedSourcePage('notes/article.md', 'generated summary only')[0]]: generatedSourcePage('notes/article.md', 'generated summary only')[1],
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': generatedSourcePage('notes/article.md', 'generated summary only')[1],
      'notes/article.md': `# Article\n\nThe quick brown fox jumps over the lazy dog.`,
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pagePath: 'wiki/entities/Foo.md',
      sourcePath: 'wiki/sources/article.md',
      quote: 'this sentence is fabricated',
      hasSourceLink: true,
    });
  });

  it('flags a quote whose linked source file does not exist', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "anything" — [[sources/missing]]`,
    });
    const sources = makeSourceMap({});
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0].sourcePath).toBe('wiki/sources/missing.md');
  });

  it('passes a historical bare quote when it exists in any source', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "the quick brown fox"`,
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': `# Article\n\nThe quick brown fox jumps over the lazy dog.`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('does not use a raw linked note for legacy bare-quote fallback', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "raw-only quote"`,
    });
    const sources = makeSourceMap({
      '10 Sources/ingest-queue/article.md': '# Article\n\nraw-only quote',
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0].hasSourceLink).toBe(false);
  });

  it('flags a historical bare quote when it exists in no source', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "this sentence is fabricated"`,
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': `# Article\n\nThe quick brown fox jumps over the lazy dog.`,
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pagePath: 'wiki/entities/Foo.md',
      quote: 'this sentence is fabricated',
      hasSourceLink: false,
    });
  });

  it('normalizes quotes for case and punctuation on direct raw-note links (Tier 2)', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "The Quick Brown Fox!" — [[notes/article]]`,
    });
    const sources = makeSourceMap({
      'notes/article.md': `# Article\n\nthe quick brown fox jumps over the lazy dog`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('skips pages outside the wiki folder', () => {
    const pages = makePageMap({
      'other/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "the quick brown fox" — [[sources/article]]`,
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': `# Article\n\nThe quick brown fox jumps over the lazy dog.`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('sorts results by page path then quote for deterministic reports', () => {
    const pages = makePageMap({
      'wiki/entities/Z.md': `# Z\n\n## Mentions in Source\n- "zzz" — [[sources/article]]`,
      'wiki/entities/A.md': `# A\n\n## Mentions in Source\n- "aaa" — [[sources/article]]`,
    });
    const sources = makeSourceMap({
      'wiki/sources/article.md': `# Article\n\nbody`,
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result.map(r => r.pagePath)).toEqual(['wiki/entities/A.md', 'wiki/entities/Z.md']);
  });

  // ─── Issue #244 — raw-note-path link targets ─────────────────────────────

  it('passes when link target is a raw note path and the quote exists in that note', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "verbatim quote text" — [[notes/source|source]]`,
    });
    // The note is a raw vault note (not under wiki/), so it's not in sourceMap
    // by wiki folder. The scanner must fall back to looking it up by raw path.
    const sources = makeSourceMap({
      'notes/source.md': `# Source\n\nContains the verbatim quote text in body.`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('flags when link target is a raw note path and the quote is NOT in that note', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "fabricated quote" — [[notes/source|source]]`,
    });
    const sources = makeSourceMap({
      'notes/source.md': `# Source\n\nDifferent content here.`,
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0].hasSourceLink).toBe(true);
  });

  it('still flags an ungrounded quote when the raw-note link target does not exist in sourceMap', () => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "any quote" — [[notes/missing-note|missing-note]]`,
    });
    const sources = makeSourceMap({}); // empty
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0].hasSourceLink).toBe(true);
  });

  it('treats raw note path with .md extension and bare path as equivalent', () => {
    const pages = makePageMap({
      'wiki/entities/A.md': `# A\n\n## Mentions in Source\n- "present" — [[notes/source|src]]`,
      'wiki/entities/B.md': `# B\n\n## Mentions in Source\n- "present" — [[notes/source.md|src]]`,
    });
    const sources = makeSourceMap({
      'notes/source.md': `# Source\n\npresent`,
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it.each(['', '   '])('flags an empty or whitespace-only linked quote (%j)', (rawQuote) => {
    const pages = makePageMap({
      'wiki/entities/Foo.md': `# Foo\n\n## Mentions in Source\n- "${rawQuote}" — [[notes/article]]`,
    });
    const sources = makeSourceMap({
      'notes/article.md': '# Article\n\nA real source sentence.',
    });
    const result = scanQuoteGrounding(pages, sources, 'wiki');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pagePath: 'wiki/entities/Foo.md',
      quote: '',
      hasSourceLink: true,
    });
  });

  it('grounds a sources link only through its generated source page and raw source_file note', () => {
    const [generatedPath, generated] = generatedSourcePage(
      'notes/article.md',
      'The projection summary repeats the quote but is not authoritative.',
    );
    const pages = makePageMap({
      'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "raw quote" — [[sources/article]]',
      [generatedPath]: generated,
    });
    const sources = makeSourceMap({
      [generatedPath]: generated,
      'notes/article.md': '# Raw note\n\nraw quote',
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('matches contiguous multiline raw body text and does not use generated projection text', () => {
    const [generatedPath, generated] = generatedSourcePage('notes/article.md', 'line one\nline two');
    const pages = makePageMap({
      'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "line one\nline two" — [[sources/article]]',
      [generatedPath]: generated,
    });
    const sources = makeSourceMap({
      [generatedPath]: generated,
      'notes/article.md': '---\nkind: note\n---\n\nline one\nline two',
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('accepts an omission marker only when that marker is literal raw text', () => {
    const [generatedPath, generated] = generatedSourcePage('notes/article.md', 'projection');
    const pages = makePageMap({
      'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "before [...] after" — [[sources/article]]',
      [generatedPath]: generated,
    });
    const sources = makeSourceMap({
      [generatedPath]: generated,
      'notes/article.md': 'before [...] after',
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it('supports legacy grouped blockquote mentions with multiline quotes', () => {
    const [generatedPath, generated] = generatedSourcePage('notes/article.md', 'projection');
    const pages = makePageMap({
      'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n> **Source: [[sources/article|Article]]**\n> - "line one\n> line two"',
      [generatedPath]: generated,
    });
    const sources = makeSourceMap({
      [generatedPath]: generated,
      'notes/article.md': 'line one\nline two',
    });
    expect(scanQuoteGrounding(pages, sources, 'wiki')).toEqual([]);
  });

  it.each([
    ['missing generated page', () => ({
      pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]' }),
      sources: makeSourceMap({ 'notes/article.md': 'quote' }),
    })],
    ['generated page has wrong type', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'quote', 'entity');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['generated page omits source_file', () => {
      const path = 'wiki/sources/article.md';
      const content = '---\ntype: source\n---\n\nprojection quote';
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['source_file is not one complete wikilink', () => {
      const path = 'wiki/sources/article.md';
      const content = '---\ntype: source\nsource_file: notes/article.md\n---\n\nprojection quote';
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['source_file has multiple links', () => {
      const path = 'wiki/sources/article.md';
      const content = '---\ntype: source\nsource_file: "[[notes/a.md]] and [[notes/b.md]]"\n---\n\nprojection quote';
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/a.md': 'quote', 'notes/b.md': 'quote' }),
      };
    }],
    ['source_file raw note is missing', () => {
      const [path, content] = generatedSourcePage('notes/missing.md', 'projection quote');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content }),
      };
    }],
    ['source_file resolves ambiguously by path casing', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'projection quote');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote', 'notes/ARTICLE.md': 'quote' }),
      };
    }],
    ['source_file points at a generated page', () => {
      const path = 'wiki/sources/article.md';
      const content = '---\ntype: source\nsource_file: "[[wiki/sources/other]]"\n---\n\nprojection quote';
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'wiki/sources/other.md': 'quote' }),
      };
    }],
    ['basename fallback is refused', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'quote', 'source', 'wiki/sources/article_version.md');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['version fallback is refused', () => {
      const [path, content] = generatedSourcePage('notes/article_v2.md', 'quote', 'source', 'wiki/sources/article_v2.md');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article_v2.md': 'quote' }),
      };
    }],
    ['projection-only quote is not raw grounding', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'quote');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'different raw text' }),
      };
    }],
    ['case normalization is not generated-source grounding', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'projection');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "QUOTE" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['punctuation normalization is not raw grounding', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'projection');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote!" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'quote' }),
      };
    }],
    ['quote in raw frontmatter is not body grounding', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'projection');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': '---\nquote: quote\n---\n\nother body' }),
      };
    }],
    ['ellipsis omission is not inferred', () => {
      const [path, content] = generatedSourcePage('notes/article.md', 'projection');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "before [...] after" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/article.md': 'before and after' }),
      };
    }],
    ['bound raw note wins over another raw note', () => {
      const [path, content] = generatedSourcePage('notes/bound.md', 'projection');
      return {
        pages: makePageMap({ 'wiki/entities/Foo.md': '# Foo\n\n## Mentions in Source\n- "quote from another note" — [[sources/article]]', [path]: content }),
        sources: makeSourceMap({ [path]: content, 'notes/bound.md': 'bound note', 'notes/other.md': 'quote from another note' }),
      };
    }],
  ])('%s refuses unsafe projection grounding', (_name, build) => {
    const fixture = (build as () => { pages: Map<string, ScannerPage>; sources: Map<string, ScannerPage> })();
    expect(scanQuoteGrounding(fixture.pages, fixture.sources, 'wiki')).toHaveLength(1);
  });
});
