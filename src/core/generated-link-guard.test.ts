import { describe, expect, it } from 'vitest';
import { ensureGeneratedPageLinks, guardGeneratedWikiLinks } from './generated-link-guard';

const options = {
  wikiFolder: 'wiki',
  pages: [
    {
      path: 'wiki/entities/Language-Model.md',
      title: 'Language Model',
      aliases: ['LM', 'Sprachmodell'],
    },
  ],
};

describe('guardGeneratedWikiLinks', () => {
  it('canonicalizes existing titles and aliases while preserving display text and anchors', () => {
    const result = guardGeneratedWikiLinks(
      '[[LM]] [[Sprachmodell|the German term]] [[entities/Language Model#History]]',
      options,
    );

    expect(result).toBe(
      '[[entities/Language-Model|LM]] [[entities/Language-Model|the German term]] [[entities/Language-Model#History|Language Model]]',
    );
  });

  it('accepts same-run pages and removes unresolved markup using visible text', () => {
    const result = guardGeneratedWikiLinks(
      'See [[concepts/Planned Concept|planned]] and [[Unknown Page]] for context.',
      {
        ...options,
        additionalPages: [{
          path: 'wiki/concepts/planned-concept.md',
          title: 'Planned Concept',
          aliases: ['Plan'],
        }],
      },
    );

    expect(result).toBe('See [[concepts/planned-concept|planned]] and Unknown Page for context.');
  });

  it('does not guess when an alias is ambiguous', () => {
    const result = guardGeneratedWikiLinks(
      '[[Shared Alias]] [[entities/Language-Model]]',
      {
        wikiFolder: 'wiki',
        pages: [
          ...options.pages,
          { path: 'wiki/concepts/Other.md', title: 'Other', aliases: ['Shared Alias'] },
          { path: 'wiki/entities/Second.md', title: 'Second', aliases: ['Shared Alias'] },
        ],
      },
    );

    expect(result).toBe('Shared Alias [[entities/Language-Model]]');
  });

  it('canonicalizes namespace-qualified aliases instead of inventing alias-shaped paths', () => {
    const result = guardGeneratedWikiLinks(
      [
        '[[entities/spm|SPM]]',
        '[[concepts/lease-loop|lease loop]]',
        '[[concepts/per-session-permissions]]',
        '[[concepts/connector-inheritance-limitation]]',
        '[[concepts/money-action-restriction]]',
        '[[entities/claude-code-remote]]',
      ].join(' '),
      {
        wikiFolder: 'wiki',
        pages: [
          { path: 'wiki/entities/strategic-property-management.md', title: 'Strategic Property Management', aliases: ['SPM'] },
          { path: 'wiki/concepts/session-lease-loop.md', title: 'Session lease loop', aliases: ['Lease loop'] },
          { path: 'wiki/concepts/permission-boundaries.md', title: 'Permission boundaries', aliases: ['Per-session permissions'] },
          { path: 'wiki/concepts/fresh-session-connector-attachment.md', title: 'Fresh-session connector attachment', aliases: ['Connector inheritance limitation'] },
          { path: 'wiki/concepts/human-click-in-appfolio.md', title: 'human click in AppFolio', aliases: ['Money action restriction'] },
          { path: 'wiki/entities/claude_code_remote.md', title: 'Claude_Code_Remote', aliases: [] },
        ],
      },
    );

    expect(result).toBe(
      [
        '[[entities/strategic-property-management|SPM]]',
        '[[concepts/session-lease-loop|lease loop]]',
        '[[concepts/permission-boundaries|per-session-permissions]]',
        '[[concepts/fresh-session-connector-attachment|connector-inheritance-limitation]]',
        '[[concepts/human-click-in-appfolio|money-action-restriction]]',
        '[[entities/claude_code_remote|claude-code-remote]]',
      ].join(' '),
    );
  });

  it('keeps namespace-qualified aliases isolated by page type', () => {
    const result = guardGeneratedWikiLinks(
      '[[concepts/shared]] [[entities/shared]]',
      {
        wikiFolder: 'wiki',
        pages: [
          { path: 'wiki/concepts/concept-page.md', title: 'Concept page', aliases: ['shared'] },
          { path: 'wiki/entities/entity-page.md', title: 'Entity page', aliases: ['shared'] },
        ],
      },
    );

    expect(result).toBe(
      '[[concepts/concept-page|shared]] [[entities/entity-page|shared]]',
    );
  });

  it('prefers an existing alias target over a guessed same-run path', () => {
    const result = guardGeneratedWikiLinks(
      '[[entities/claude-code-cli|Claude Code CLI]]',
      {
        wikiFolder: 'wiki',
        pages: [
          { path: 'wiki/entities/claude-code.md', title: 'Claude Code', aliases: ['Claude Code CLI'] },
        ],
        additionalPages: [
          { path: 'wiki/entities/claude-code-cli.md', title: 'claude-code-cli' },
        ],
      },
    );

    expect(result).toBe('[[entities/claude-code|Claude Code CLI]]');
  });

  it('only rewrites live Markdown links, preserving frontmatter, code, comments, and escapes', () => {
    const content = [
      '---',
      'description: "[[Unknown Page]]"',
      '---',
      '',
      'Live [[LM]].',
      '',
      '`[[Unknown Page]]`',
      '',
      '<!-- [[Unknown Page]] -->',
      '',
      '\\[[Unknown Page]]',
      '',
      '```markdown',
      '[[Unknown Page]]',
      '```',
    ].join('\n');

    expect(guardGeneratedWikiLinks(content, options)).toBe([
      '---',
      'description: "[[Unknown Page]]"',
      '---',
      '',
      'Live [[entities/Language-Model|LM]].',
      '',
      '`[[Unknown Page]]`',
      '',
      '<!-- [[Unknown Page]] -->',
      '',
      '\\[[Unknown Page]]',
      '',
      '```markdown',
      '[[Unknown Page]]',
      '```',
    ].join('\n'));
  });
});

describe('ensureGeneratedPageLinks', () => {
  it('adds exact missing resolver paths once and preserves links already in prose', () => {
    const result = ensureGeneratedPageLinks(
      '## Key Entities\n\n- [[entities/existing|Existing]]',
      [
        'wiki/entities/existing.md',
        'wiki/concepts/resolved-target.md',
        'wiki/concepts/resolved-target.md',
      ],
      'wiki',
    );
    expect(result).toContain('[[entities/existing|Existing]]');
    expect(result).toContain('## Generated Pages\n\n- [[concepts/resolved-target]]');
    expect(result.match(/concepts\/resolved-target/g)).toHaveLength(1);
  });

  it('does not treat code-only, commented, frontmatter, or escaped links as inbound edges', () => {
    const result = ensureGeneratedPageLinks(
      [
        '---',
        'related: "[[entities/code-only]]"',
        '---',
        '',
        '`[[entities/code-only]]`',
        '',
        '<!-- [[entities/code-only]] -->',
        '',
        '\\[[entities/code-only]]',
        '',
        '```md',
        '[[entities/code-only]]',
        '```',
      ].join('\n'),
      ['wiki/entities/code-only.md'],
      'wiki',
    );

    expect(result).toContain('## Generated Pages\n\n- [[entities/code-only]]');
    expect(result.match(/## Generated Pages/g)).toHaveLength(1);
  });
});
