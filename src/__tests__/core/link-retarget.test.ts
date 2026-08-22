import { describe, it, expect } from 'vitest';
import { retargetLinksToPage } from '../../core/link-retarget';
import { createFakeLinkVault } from '../__support__/link-vault';

const FROM = 'wiki/entities/Osteopontin-2.md';
const TO = 'wiki/entities/Osteopontin.md';
const FROM_SECOND = 'wiki/entities/Calcium-2.md';
const TO_SECOND = 'wiki/entities/Calcium.md';

describe('retargetLinksToPage', () => {
  it('rewrites a bare-title link in a note outside the wiki folder', async () => {
    // The measured case: 1762 of 1762 incoming links from user notes were
    // written bare, and the previous rewrite visited wiki files only.
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]] for the marker.\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin]] for the marker.\n');
    expect(result).toMatchObject({ filesChanged: 1, linksRewritten: 1, stale: 0, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
  });

  it('leaves a same-named page elsewhere in the vault alone', async () => {
    // Resolve-before-replace: a bare `[[Osteopontin-2]]` next to the note's own
    // Osteopontin-2 addresses that file, not the wiki page being merged. A
    // string match would bend this link to a page it never referenced.
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Osteopontin-2.md': '# My own note\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin-2]].\n');
    expect(result).toMatchObject({ filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
    expect(fake.processed).toEqual([]);
  });

  it('keeps the link shape: a folder-prefixed link stays folder-prefixed', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'wiki/concepts/Knochenumbau.md': 'Regulated by [[entities/Osteopontin-2]].\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });

    await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('wiki/concepts/Knochenumbau.md')).toBe('Regulated by [[entities/Osteopontin]].\n');
    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin]].\n');
  });

  it('preserves display text, subpath and the embed marker', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md':
        'A [[Osteopontin-2|OPN]] and a section [[Osteopontin-2#Funktion]].\n' +
        '![[Osteopontin-2#Funktion|OPN]]\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe(
      'A [[Osteopontin|OPN]] and a section [[Osteopontin#Funktion]].\n' +
      '![[Osteopontin#Funktion|OPN]]\n'
    );
    expect(result.linksRewritten).toBe(3);
  });

  it('does not touch a link quoted inside a code block', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Plugin-Notizen.md': 'Example:\n\n```\n[[Osteopontin-2]]\n```\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Plugin-Notizen.md')).toContain('[[Osteopontin-2]]');
    expect(result.linksRewritten).toBe(0);
  });

  it('skips the page being deleted and files without references', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n\nSee [[Osteopontin-2]] and [[Osteopontin]].\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Unrelated.md': 'No links here.\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read(FROM)).toContain('[[Osteopontin-2]]');
    expect(fake.processed).toEqual([]);
    expect(result).toMatchObject({ filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
  });

  it('recovers a stale cache position from the locked current-content scan', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });
    // The cache is read first; the file then changes underneath, as it would if
    // the user edited the note between indexing and the merge.
    const cache = fake.metadataCache.getFileCache;
    let changed = false;
    fake.metadataCache.getFileCache = file => {
      const result = cache({ path: file.path });
      if (file.path === 'Notizen/Knochenstoffwechsel.md' && !changed) {
        changed = true;
        fake.write(file.path, 'Rewritten by hand. See [[Osteopontin-2]].\n');
      }
      return result;
    };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Rewritten by hand. See [[Osteopontin]].\n');
    expect(result).toMatchObject({ filesChanged: 1, linksRewritten: 1, stale: 1, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
  });

  it('rewrites several links in one file in a single write', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': '[[Osteopontin-2]] und [[Osteopontin-2|OPN]] und [[Osteopontin-2]].\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe(
      '[[Osteopontin]] und [[Osteopontin|OPN]] und [[Osteopontin]].\n'
    );
    expect(result).toMatchObject({ filesChanged: 1, linksRewritten: 3, stale: 0, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
    expect(fake.processed).toEqual(['Notizen/Knochenstoffwechsel.md']);
  });

  it('is a no-op when source and target are the same page', async () => {
    const fake = createFakeLinkVault({
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin]].\n',
    });

    const result = await retargetLinksToPage(fake, TO, TO);

    expect(result).toMatchObject({ filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0, remainingLinks: 0, unverifiedFiles: 0 });
    expect(fake.processed).toEqual([]);
  });

  it('rewrites frontmatter wikilinks and embeds from current markdown content', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notes/Mixed.md': '---\nrelated: "[[Osteopontin-2]]"\n---\n![[Osteopontin-2#Chart]]\n',
    });
    // Model Obsidian omitting frontmatter links from links/embeds cache. The
    // locked raw-Markdown scan must still discover and rewrite both forms.
    const original = fake.metadataCache.getFileCache;
    fake.metadataCache.getFileCache = file => file.path === 'Notes/Mixed.md' ? {} : original(file);

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/Mixed.md')).toBe(
      '---\nrelated: "[[Osteopontin]]"\n---\n![[Osteopontin#Chart]]\n'
    );
    expect(result).toMatchObject({ linksRewritten: 2, remainingLinks: 0, unverifiedFiles: 0 });
  });

  it('ignores inline code, Obsidian comments, and closed or unclosed fences', async () => {
    const content = [
      '`[[Osteopontin-2]]`',
      '%% [[Osteopontin-2]] %%',
      '```md', '[[Osteopontin-2]]', '```',
      '~~~', '[[Osteopontin-2]]',
    ].join('\n');
    const fake = createFakeLinkVault({ [FROM]: '# old', [TO]: '# new', 'Notes/Code.md': content });
    fake.metadataCache.getFileCache = file => file.path === 'Notes/Code.md' ? {} : { links: [], embeds: [] };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/Code.md')).toBe(content);
    expect(result).toMatchObject({ linksRewritten: 0, remainingLinks: 0 });
  });

  it('does not close four-character fences on inner triple markers', async () => {
    const content = [
      '````md', '```', '[[Osteopontin-2]]', '````',
      '~~~~', '~~~', '[[Osteopontin-2]]', '~~~~',
      'Live [[Osteopontin-2]].',
    ].join('\n');
    const fake = createFakeLinkVault({ [FROM]: '# old', [TO]: '# new', 'Notes/FourFence.md': content });
    fake.metadataCache.getFileCache = file => file.path === 'Notes/FourFence.md' ? {} : { links: [], embeds: [] };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/FourFence.md')).toContain('```\n[[Osteopontin-2]]\n````');
    expect(fake.read('Notes/FourFence.md')).toContain('~~~\n[[Osteopontin-2]]\n~~~~');
    expect(fake.read('Notes/FourFence.md')).toContain('Live [[Osteopontin]].');
    expect(result).toMatchObject({ linksRewritten: 1, remainingLinks: 0 });
  });

  it('matches equal-length multiline code-span delimiters and ignores unequal runs', async () => {
    const content = [
      '``multiline ` inner',
      '[[Osteopontin-2]]',
      '``',
      '` unmatched `` Live [[Osteopontin-2]].',
    ].join('\n');
    const fake = createFakeLinkVault({ [FROM]: '# old', [TO]: '# new', 'Notes/CodeSpans.md': content });
    fake.metadataCache.getFileCache = file => file.path === 'Notes/CodeSpans.md' ? {} : { links: [], embeds: [] };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/CodeSpans.md')).toContain('``multiline ` inner\n[[Osteopontin-2]]\n``');
    expect(fake.read('Notes/CodeSpans.md')).toContain('` unmatched `` Live [[Osteopontin]].');
    expect(result).toMatchObject({ linksRewritten: 1, remainingLinks: 0 });
  });

  it('does not pair backticks across tilde fences, frontmatter, or comments', async () => {
    const content = [
      '---', 'marker: "`"', 'related: "[[Osteopontin-2]]"', '---',
      '` Live-frontmatter [[Osteopontin-2]].',
      '~~~', '`', '~~~',
      '` Live-fence [[Osteopontin-2]].',
      '%% ` %%',
      '` Live-comment [[Osteopontin-2]].',
    ].join('\n');
    const fake = createFakeLinkVault({ [FROM]: '# old', [TO]: '# new', 'Notes/Contexts.md': content });
    fake.metadataCache.getFileCache = file => file.path === 'Notes/Contexts.md' ? {} : { links: [], embeds: [] };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/Contexts.md')).toContain('related: "[[Osteopontin]]"');
    expect(fake.read('Notes/Contexts.md')).toContain('Live-frontmatter [[Osteopontin]]');
    expect(fake.read('Notes/Contexts.md')).toContain('Live-fence [[Osteopontin]]');
    expect(fake.read('Notes/Contexts.md')).toContain('Live-comment [[Osteopontin]]');
    expect(result).toMatchObject({ linksRewritten: 4, remainingLinks: 0 });
  });

  it('takes a fresh cache snapshot after a length-changing retarget shifts later offsets', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      [FROM_SECOND]: '# Calcium-2\n',
      [TO_SECOND]: '# Calcium\n',
      'Notizen/Offsets.md': 'A [[Osteopontin-2]] then [[Calcium-2]].\n',
    });
    const originalGetFileCache = fake.metadataCache.getFileCache;
    const snapshots: string[] = [];
    fake.metadataCache.getFileCache = file => {
      if (file.path === 'Notizen/Offsets.md') snapshots.push(fake.read(file.path));
      return originalGetFileCache(file);
    };

    await retargetLinksToPage(fake, FROM, TO);
    await retargetLinksToPage(fake, FROM_SECOND, TO_SECOND);

    expect(fake.read('Notizen/Offsets.md')).toBe('A [[Osteopontin]] then [[Calcium]].\n');
    expect(snapshots).toEqual([
      'A [[Osteopontin-2]] then [[Calcium-2]].\n',
      'A [[Osteopontin]] then [[Calcium-2]].\n',
      'A [[Osteopontin]] then [[Calcium-2]].\n',
      'A [[Osteopontin]] then [[Calcium]].\n',
    ]);
  });

  it('does not lose either rewrite when same-note retargets run concurrently', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      [FROM_SECOND]: '# Calcium-2\n',
      [TO_SECOND]: '# Calcium\n',
      'Notizen/Concurrent.md': '[[Osteopontin-2]] + [[Calcium-2]]\n',
    });

    const [first, second] = await Promise.all([
      retargetLinksToPage(fake, FROM, TO),
      retargetLinksToPage(fake, FROM_SECOND, TO_SECOND),
    ]);

    expect(fake.read('Notizen/Concurrent.md')).toBe('[[Osteopontin]] + [[Calcium]]\n');
    expect(first.linksRewritten + second.linksRewritten).toBe(2);
    expect(first.stale + second.stale).toBe(0);
  });

  it('reports a metadata barrier timeout without pretending the rewrite is safe', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/NoRefresh.md': 'See [[Osteopontin-2]].\n',
    });
    const originalOn = fake.metadataCache.on;
    fake.metadataCache.on = () => ({ });
    const result = await retargetLinksToPage({
      ...fake,
      metadataBarrierTimeoutMs: 1,
    }, FROM, TO);
    fake.metadataCache.on = originalOn;

    expect(result).toMatchObject({ filesChanged: 1, linksRewritten: 1, stale: 0, barrierTimeouts: 1, remainingLinks: 0, unverifiedFiles: 0 });
  });

  it('drains every admitted write before surfacing cancellation', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notes/One.md': '[[Osteopontin-2]]\n',
      'Notes/Two.md': '[[Osteopontin-2]]\n',
    });
    const controller = new AbortController();
    const started: string[] = [];
    let cancelled = false;
    const originalProcess = fake.vault.process;
    fake.vault.process = async (file, fn) => {
      started.push(file.path);
      const result = await originalProcess(file, fn);
      if (!cancelled) {
        cancelled = true;
        controller.abort();
      }
      return result;
    };

    await expect(retargetLinksToPage({ ...fake, signal: controller.signal }, FROM, TO))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(started.sort()).toEqual(['Notes/One.md', 'Notes/Two.md']);
    expect(fake.read('Notes/One.md')).toBe('[[Osteopontin]]\n');
    expect(fake.read('Notes/Two.md')).toBe('[[Osteopontin]]\n');
  });

  it('requires a valid fence closer and keeps frontmatter links live', async () => {
    const content = [
      '---', 'related: "[[Osteopontin-2]]"', '...',
      '````md', '```not-a-closer', '[[Osteopontin-2]]', '````',
      'Live [[Osteopontin-2]].',
    ].join('\n');
    const fake = createFakeLinkVault({ [FROM]: '# old', [TO]: '# new', 'Notes/Safe.md': content });
    fake.metadataCache.getFileCache = file => file.path === 'Notes/Safe.md' ? {} : { links: [], embeds: [] };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notes/Safe.md')).toContain('related: "[[Osteopontin]]"');
    expect(fake.read('Notes/Safe.md')).toContain('Live [[Osteopontin]].');
    expect(fake.read('Notes/Safe.md')).toContain('[[Osteopontin-2]]');
    expect(result.linksRewritten).toBe(2);
  });
});
