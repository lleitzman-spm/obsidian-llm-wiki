/**
 * LogWriter unit tests — wiki operation log appender + size cap.
 *
 * Extracted from WikiEngine (2026-07-19). Verifies:
 *   - appendIngest writes H2 entry with date/time, deduped created pages,
 *     updated pages, contradictions, and metrics suffix
 *   - appendLintFix writes H2 entry with details
 *   - log file size cap (512 KB) trims oldest entries while preserving header
 *   - formatBytes via LogWriter's exposed helper
 */

import { describe, it, expect, vi } from 'vitest';
import { LogWriter } from '../../../wiki/engine-internals/log-writer';
import { utf8ByteLength } from '../../../wiki/engine-internals/report-retention';
import type { SourceAnalysis } from '../../../types';

function makeAnalysis(overrides: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    source_file: 'sources/test.md',
    source_title: 'Test Source',
    summary: '',
    entities: [],
    concepts: [],
    related_pages: [],
    key_points: [],
    created_pages: ['wiki/sources/test.md'],
    updated_pages: ['wiki/concepts/c1.md'],
    contradictions: [],
    source_note_aliases: [],
    ...overrides,
  };
}

describe('LogWriter', () => {
  it('appendIngest writes H2 entry with date + time + source_title + metrics', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue('# Wiki Operation Log\n');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendIngest('ingest', makeAnalysis({ source_title: 'Paper X' }), {
      durationSec: 28,
      model: 'claude-sonnet-4-5-20250929',
      sourceBytes: 4400,
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('wiki/log.md');
    expect(content).toContain('## [');
    expect(content).toContain('ingest | Paper X');
    expect(content).toContain(' · 28s');
    expect(content).toContain(' · claude-sonnet-4-5'); // trailing 8-digit date stripped
    expect(content).toContain(' · 4.3KB'); // 4400 bytes → 4.3KB
  });

  it('appendIngest with no metrics omits the suffix entirely', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue('# Header\n');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendIngest('ingest', makeAnalysis({ source_title: 'X' }));

    const content = (writeFile.mock.calls[0] as [string, string])[1];
    expect(content).toContain('ingest | X\n');
    expect(content).not.toContain(' · ');
  });

  it('appendIngest deduplicates created_pages', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue('');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendIngest('ingest', makeAnalysis({
      created_pages: ['wiki/sources/p.md', 'wiki/sources/p.md', 'wiki/sources/q.md'],
    }));

    const content = (writeFile.mock.calls[0] as [string, string])[1];
    // LogWriter strips the `wiki/` prefix; the wiki link keeps the `.md`
    // suffix (the rendered log link points to the on-disk path).
    expect(content).toContain('[[sources/p.md]]');
    expect(content).toContain('[[sources/q.md]]');
    // Two occurrences of [[sources/p.md]], NOT three
    const occurrences = (content.match(/\[\[sources\/p\.md\]\]/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('appendIngest with contradictions includes them', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue('');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendIngest('ingest', makeAnalysis({
      contradictions: [
        { claim: 'Sky is blue', source_page: 'page-a', contradicted_by: 'page-b', resolution: '' },
        { claim: 'Sky is green', source_page: 'page-c', contradicted_by: 'page-d', resolution: '' },
      ],
    }));

    const content = (writeFile.mock.calls[0] as [string, string])[1];
    expect(content).toContain('Contradictions found');
    expect(content).toContain('- Sky is blue vs page-a');
    expect(content).toContain('- Sky is green vs page-c');
  });

  it('appendIngest writes header when log file does not exist', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue(null); // file missing
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendIngest('ingest', makeAnalysis());
    const content = (writeFile.mock.calls[0] as [string, string])[1];
    // buildLogHeader produces a header line; we just verify it doesn't crash
    // and the entry is appended after the header
    expect(content).toContain('## [');
    expect(content).toContain('ingest | Test Source');
  });

  it('appendLintFix writes H2 entry with details', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue('# Header\n');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendLintFix('fix: dead link', 'Resolved [[broken]] → [[fixed]]');
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('wiki/log.md');
    expect(content).toContain('## [');
    expect(content).toContain('fix: dead link');
    expect(content).toContain('Resolved [[broken]] → [[fixed]]');
  });

  it('appendLintFix trims log when projected size exceeds 512 KB', async () => {
    // Build a "fat" existing log that's well over the 512 KB threshold.
    // We need fatLog.length + entry.length * 2 > 512 KB to engage the trim path.
    // Each chunk is ~600 bytes; 1200 chunks ≈ 720 KB.
    const fatHeader = '# Wiki Operation Log\n\n';
    const chunk = '## [2026-01-01 12:00] old entry\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. '.padEnd(600, 'x') + '\n\n';
    const chunks: string[] = [];
    for (let i = 0; i < 1200; i++) chunks.push(chunk);
    const fatLog = fatHeader + chunks.join('');

    const writeFile = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue(fatLog);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await writer.appendLintFix('fix: fresh entry', 'small content');
    const content = (writeFile.mock.calls[0] as [string, string])[1];
    // Trim happened — header preserved
    expect(content).toContain('# Wiki Operation Log');
    // Fresh entry appended
    expect(content).toContain('fix: fresh entry');
    // Old entries trimmed (size shrunk substantially)
    expect(content.length).toBeLessThan(fatLog.length);
  });

  it('appendLintFix re-throws write errors (caller surfaces)', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const readFile = vi.fn().mockResolvedValue('');
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      readFile,
      writeFile,
    });

    await expect(writer.appendLintFix('op', 'details')).rejects.toThrow('disk full');
  });

  it('appendLintReport archives canonical UTF-8 report metadata before indexing the log', async () => {
    const writes: Array<[string, string]> = [];
    let archiveContent: string | null = null;
    const readFile = vi.fn(async (path: string) => path.endsWith('/log.md') ? '# Header\n' : archiveContent);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      pluginVersion: '1.26.4',
      now: () => new Date('2026-08-20T10:03:04.000Z'),
      runIdFactory: () => 'run-123',
      sha256: async text => `hash-${text.length}`,
      readFile,
      writeFile: async (path, content) => { writes.push([path, content]); },
      createArchiveFile: async (path, content) => { archiveContent = content; writes.push([path, content]); },
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path,
    });

    const report = '# Wiki Lint Report\n\n> 1 finding\n\n## Dead links\n\n- Café → [[target]]\n\n## Quotes\n\n- none\n';
    const retained = await writer.appendLintReport('Wiki Lint Report', report);
    expect(retained.reportPath).toBe('wiki/lint-reports/2026-08-20T10-03-04.000Z-run-123.json');
    expect(writes[0]?.[0]).toBe(retained.reportPath);
    expect(writes[1]?.[0]).toBe('wiki/log.md');
    const artifact = JSON.parse(writes[0]?.[1] ?? '') as {
      timestamp: string;
      runId: string;
      pluginVersion: string;
      previousLogSha256: string;
      reportSha256: string;
      sections: Array<{ heading: string; sha256: string; byteLength: number }>;
      report: string;
    };
    expect(artifact).toMatchObject({ timestamp: '2026-08-20T10:03:04.000Z', runId: 'run-123', pluginVersion: '1.26.4' });
    expect(artifact.report).toBe(report);
    expect(artifact.sections.map(section => section.heading)).toEqual(['## Dead links', '## Quotes']);
    expect(artifact.sections[0]?.byteLength).toBe(utf8ByteLength('## Dead links\n\n- Café → [[target]]\n\n'));
    expect(writes[1]?.[1]).toContain('**Report artifact**: wiki/lint-reports/2026-08-20T10-03-04.000Z-run-123.json');
  });

  it('fails closed when the immutable archive path already exists', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const ids = ['run-existing', 'run-unique'];
    let archiveContent: string | null = null;
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      now: () => new Date('2026-08-20T10:03:04.000Z'),
      runIdFactory: () => ids.shift() ?? 'run-fallback',
      sha256: async () => 'hash',
      readFile: vi.fn().mockResolvedValue('# Header\n'),
      readArchiveFile: vi.fn(async path => path.includes('run-existing') ? '{"immutable":true}\n' : archiveContent),
      writeFile,
      createArchiveFile: async (_path, content) => { archiveContent = content; },
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path,
    });

    await writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n');
    expect(archiveContent).toContain('"runId": "run-unique"');
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('retries a direct EEXIST create race with a fresh immutable artifact ID', async () => {
    const ids = ['run-create-race', 'run-after-race'];
    let archiveContent: string | null = null;
    let archivedPath: string | null = null;
    let createAttempts = 0;
    const createArchiveFile = vi.fn(async (path: string, content: string) => {
      createAttempts++;
      if (createAttempts === 1) {
        const error = Object.assign(new Error('archive file already exists'), { code: 'EEXIST' });
        throw error;
      }
      archivedPath = path;
      archiveContent = content;
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      now: () => new Date('2026-08-20T10:03:04.000Z'),
      runIdFactory: () => ids.shift() ?? 'run-fallback',
      sha256: async () => 'hash',
      readFile: vi.fn().mockResolvedValue('# Header\n'),
      readArchiveFile: vi.fn(async path => path === archivedPath ? archiveContent : null),
      writeFile,
      createArchiveFile,
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path,
    });

    await writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n');

    expect(createArchiveFile).toHaveBeenCalledTimes(2);
    expect(archiveContent).toContain('"runId": "run-after-race"');
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('archives before a trim and leaves the log untouched when archive writing fails', async () => {
    const fatHeader = '# Wiki Operation Log\n\n';
    const chunk = '## [2026-01-01 12:00] old entry\n\n' + 'é'.repeat(900) + '\n\n';
    const fatLog = fatHeader + chunk.repeat(900);
    const writeLog = vi.fn().mockResolvedValue(undefined);
    const writeArchive = vi.fn().mockRejectedValue(new Error('archive disk full'));
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      now: () => new Date('2026-08-20T10:03:04.000Z'),
      runIdFactory: () => 'run-fails',
      sha256: async () => 'hash',
      readFile: vi.fn().mockResolvedValue(fatLog),
      readArchiveFile: vi.fn().mockResolvedValue(null),
      writeFile: writeLog,
      createArchiveFile: writeArchive,
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path,
    });

    await expect(writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n'))
      .rejects.toThrow('archive disk full');
    expect(writeArchive).toHaveBeenCalledTimes(1);
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('refuses an archive resolver result that escapes the canonical report root', async () => {
    const createArchive = vi.fn().mockResolvedValue(undefined);
    const writeLog = vi.fn().mockResolvedValue(undefined);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      runIdFactory: () => 'run-escape',
      sha256: async () => 'hash',
      readFile: vi.fn().mockResolvedValue('# Header\n'),
      readArchiveFile: vi.fn().mockResolvedValue(null),
      createArchiveFile: createArchive,
      writeFile: writeLog,
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path.endsWith('/lint-reports')
        ? 'C:/vault/wiki/lint-reports'
        : 'C:/vault/escaped/report.json',
    });

    await expect(writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n'))
      .rejects.toThrow('escaped archive root');
    expect(createArchive).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('refuses rewritten archive bytes on post-create readback', async () => {
    let reads = 0;
    const writeLog = vi.fn().mockResolvedValue(undefined);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      runIdFactory: () => 'run-rewritten',
      sha256: async text => `hash-${text}`,
      readFile: vi.fn().mockResolvedValue('# Header\n'),
      readArchiveFile: vi.fn(async () => reads++ === 0 ? null : 'rewritten'),
      createArchiveFile: vi.fn().mockResolvedValue(undefined),
      writeFile: writeLog,
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => path,
    });

    await expect(writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n'))
      .rejects.toThrow('readback mismatch');
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('revalidates the resolved root after folder creation before creating the artifact', async () => {
    let rootReads = 0;
    const createArchive = vi.fn().mockResolvedValue(undefined);
    const writeLog = vi.fn().mockResolvedValue(undefined);
    const writer = new LogWriter({
      wikiFolder: 'wiki',
      wikiLanguage: 'en',
      runIdFactory: () => 'run-junction-swap',
      sha256: async () => 'hash',
      readFile: vi.fn().mockResolvedValue('# Header\n'),
      readArchiveFile: vi.fn().mockResolvedValue(null),
      createArchiveFile: createArchive,
      writeFile: writeLog,
      ensureArchiveFolder: vi.fn().mockResolvedValue(undefined),
      resolveArchivePath: async path => {
        if (path.endsWith('/lint-reports')) {
          rootReads++;
          return rootReads === 1 ? 'C:/vault/wiki/lint-reports' : 'C:/vault/escaped';
        }
        return 'C:/vault/escaped/report.json';
      },
    });

    await expect(writer.appendLintReport('Wiki Lint Report', '# Report\n\n## Findings\n\n- x\n'))
      .rejects.toThrow('escaped archive root');
    expect(createArchive).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });
});
