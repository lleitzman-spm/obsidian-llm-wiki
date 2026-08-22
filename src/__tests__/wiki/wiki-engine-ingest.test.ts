import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian'; // mocked in setup.ts
import { vi } from 'vitest';
import { createWikiEngineHarness, wikiPagesWritten } from '../__support__/wiki-engine-harness';
import { hashBody } from '../../core/source-requirements';
import { withIngestionLease } from '../../core/ingestion-coordinator';
import type { IngestionLeaseContext } from '../../core/ingestion-coordinator';

// Build a TFile-shaped source file object. The engine reads path/basename/extension.
function sourceFile(path = 'sources/empty.md'): TFile {
  const name = path.split('/').pop() || path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : 'md',
  });
}

// A fabricated analysis as a small/local model would invent from a blank prompt.
const HALLUCINATED = JSON.stringify({
  source_title: 'Untitled',
  summary: 'fabricated from nothing',
  entities: [{ name: 'Some Hallucination', type: 'person', summary: '', mentions_in_source: [] }],
  concepts: [{ name: 'Made Up Concept', type: 'term', summary: '', mentions_in_source: [], related_concepts: [] }],
});

type SummaryLinkFinalizer = (summaryPath: string, actualPagePaths: string[], touchedPaths?: string[]) => Promise<void>;

function finalizeSummaryLinks(
  engine: import('../../wiki/wiki-engine').WikiEngine,
  summaryPath: string,
  actualPagePaths: string[],
  touchedPaths?: string[],
): Promise<void> {
  const internal = engine as unknown as {
    finalizeGeneratedPageLinks: SummaryLinkFinalizer;
  };
  return internal.finalizeGeneratedPageLinks.call(engine, summaryPath, actualPagePaths, touchedPaths);
}

function vaultFile(h: ReturnType<typeof createWikiEngineHarness>, path: string): TFile {
  const file = h.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`missing test vault file: ${path}`);
  return file;
}

describe('WikiEngine generated-page provenance reconciliation', () => {
  it('removes a preflight-only page when its write fails', async () => {
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/summary.md': 'Summary.\n\n[[concepts/rejected-page|Rejected page]]',
      },
    });

    await finalizeSummaryLinks(h.engine, 'wiki/sources/summary.md', []);

    const summary = h.files.get('wiki/sources/summary.md') ?? '';
    expect(summary).toContain('Rejected page');
    expect(summary).not.toContain('[[concepts/rejected-page');
  });

  it('links the actual successful path exactly once', async () => {
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/summary.md': 'Summary.\n\n[[concepts/planned-name|Planned name]]',
        'wiki/concepts/actual-page.md': `---
type: concept
aliases:
  - "Planned name"
---

Actual page.
`,
      },
    });

    await finalizeSummaryLinks(
      h.engine,
      'wiki/sources/summary.md',
      ['wiki/concepts/actual-page.md'],
    );

    const summary = h.files.get('wiki/sources/summary.md') ?? '';
    expect(summary.match(/concepts\/actual-page/g)).toHaveLength(1);
    expect(summary).not.toContain('concepts/planned-name');
  });

  it('reconciles failed planned links in every touched generated page', async () => {
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/summary.md': 'Summary.\n\n[[concepts/rejected-page|Rejected page]]',
        'wiki/entities/generated.md': 'Generated.\n\n[[concepts/rejected-page|Rejected page]]',
        'wiki/concepts/actual-page.md': 'Actual page.\n',
      },
    });

    await finalizeSummaryLinks(
      h.engine,
      'wiki/sources/summary.md',
      ['wiki/concepts/actual-page.md'],
      ['wiki/sources/summary.md', 'wiki/entities/generated.md'],
    );

    expect(h.files.get('wiki/sources/summary.md')).not.toContain('[[concepts/rejected-page');
    expect(h.files.get('wiki/entities/generated.md')).not.toContain('[[concepts/rejected-page');
  });

  it('preserves exact citations to existing raw source notes outside the wiki folder', async () => {
    const h = createWikiEngineHarness({
      files: {
        '10 Sources/approved/source-note.md': '# Raw source',
        'wiki/sources/summary.md': 'Summary.',
        'wiki/entities/generated.md':
          '## Mentions in Source\n\n- "Grounded quote" — [[10 Sources/approved/source-note|source-note]]',
      },
    });

    await finalizeSummaryLinks(
      h.engine,
      'wiki/sources/summary.md',
      ['wiki/entities/generated.md'],
      ['wiki/entities/generated.md'],
    );

    expect(h.files.get('wiki/entities/generated.md'))
      .toContain('[[10 Sources/approved/source-note|source-note]]');
  });

  it('reads and derives reconciliation inside the path lock', async () => {
    const summaryPath = 'wiki/sources/summary.md';
    const h = createWikiEngineHarness({
      files: { [summaryPath]: 'Original [[concepts/rejected|Rejected]].' },
    });
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const queue = (h.engine as unknown as {
      pathWriteQueue: { run<T>(path: string, operation: () => Promise<T>): Promise<T> };
    }).pathWriteQueue;
    const competingWrite = queue.run(summaryPath, async () => {
      await blocker;
      h.files.set(summaryPath, 'Competing marker. [[concepts/rejected|Rejected]].');
    });
    const reconciliation = finalizeSummaryLinks(h.engine, summaryPath, []);
    release();
    await Promise.all([competingWrite, reconciliation]);

    expect(h.files.get(summaryPath)).toContain('Competing marker.');
    expect(h.files.get(summaryPath)).not.toContain('[[concepts/rejected');
  });
});

describe('WikiEngine.deleteFile normalization-safe proof', () => {
  it('deletes an NFD/APFS filename reached through normalized fallback', async () => {
    const actual = 'wiki/entities/Cafe\u0301.md';
    const requested = 'wiki/entities/Caf\u00e9.md';
    const h = createWikiEngineHarness({ files: { [actual]: '# Cafe' } });

    await expect(h.engine.deleteFile(requested)).resolves.toBeUndefined();
    expect(h.files.has(actual)).toBe(false);
    await expect(h.engine.tryReadFile(requested)).resolves.toBeNull();
  });

  it('refuses ambiguous Unicode-normalized fallback candidates', async () => {
    const h = createWikiEngineHarness({ files: {
      'wiki/entities/\u00c5.md': '# NFC',
      'wiki/entities/A\u030a.md': '# NFD',
    } });

    await expect(h.engine.deleteFile('wiki/entities/\u212b.md'))
      .rejects.toThrow('Ambiguous normalized vault path');
    expect(h.files.size).toBe(2);
  });

  it('throws when the trash operation silently leaves the file present', async () => {
    const path = 'wiki/entities/Silent.md';
    const h = createWikiEngineHarness({ files: { [path]: '# Still here' } });
    h.app.fileManager.trashFile = async () => { /* simulate silent miss */ };

    await expect(h.engine.deleteFile(path)).rejects.toThrow('could not be verified');
    expect(h.files.has(path)).toBe(true);
  });
});

describe('WikiEngine.ingestSource — empty source (#164)', () => {
  it('creates NO wiki pages when ingesting an empty file (the real hallucination symptom)', async () => {
    // The bug was "an empty file yields >=1 wiki page". We assert the symptom
    // directly — no entity/concept/source page may be written — independent of
    // whatever name a model invents.
    const h = createWikiEngineHarness({
      files: { 'sources/empty.md': '' },
      llmResponses: [HALLUCINATED],
    });

    // Pre-gate code paths may throw ("analysis failed"); the symptom (zero
    // pages) must hold regardless of how the ingest terminates.
    try {
      await h.engine.ingestSource(sourceFile());
    } catch { /* tolerated — we assert on what was written, not on throwing */ }

    expect(wikiPagesWritten(h.writtenPaths)).toEqual([]);
  });

  it('skips cleanly (no throw) and reports a skip, without calling the LLM', async () => {
    // Drives the Phase C gate: an empty file must be a graceful skip, not an error.
    const h = createWikiEngineHarness({
      files: { 'sources/empty.md': '' },
      llmResponses: [HALLUCINATED],
    });
    let ingestionEnds = 0;
    h.engine.setIngestionCallbacks(() => {}, () => { ingestionEnds++; });

    await expect(h.engine.ingestSource(sourceFile())).resolves.toBeUndefined();

    const last = h.reports.at(-1);
    expect(last?.skipped).toBe(true);
    expect(last?.createdPages).toEqual([]);
    expect(h.stats.llmCalls).toBe(0);
    expect(h.engine.isIngesting()).toBe(false);
    expect(ingestionEnds).toBe(1);
  });
});

describe('WikiEngine.ingestSource — requirements gate (#164)', () => {
  it('rejects an unsupported file type without creating pages', async () => {
    // v1.25.0: PDFs are now supported (their own branch in ingestSource).
    // Use a still-unsupported binary type (PNG) to exercise the rejection path.
    const h = createWikiEngineHarness({ files: { 'sources/diagram.png': 'fake png bytes' } });
    let ingestionEnds = 0;
    h.engine.setIngestionCallbacks(() => {}, () => { ingestionEnds++; });
    await expect(h.engine.ingestSource(sourceFile('sources/diagram.png'))).resolves.toBeUndefined();
    expect(h.reports.at(-1)?.rejectedFiles?.[0]?.reason).toBe('incompatible-type');
    expect(wikiPagesWritten(h.writtenPaths)).toEqual([]);
    expect(h.stats.llmCalls).toBe(0);
    expect(h.engine.isIngesting()).toBe(false);
    expect(ingestionEnds).toBe(1);
  });

  it('skips a file whose content already exists in the wiki (cross-session dedup)', async () => {
    const dupBody = 'This exact body already lives in the wiki.';
    const h = createWikiEngineHarness({
      files: {
        // an existing source page carrying the content hash of dupBody
        'wiki/sources/old_abc123.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nold`,
        'sources/new-copy.md': dupBody,
      },
    });
    let ingestionEnds = 0;
    h.engine.setIngestionCallbacks(() => {}, () => { ingestionEnds++; });
    await expect(h.engine.ingestSource(sourceFile('sources/new-copy.md'))).resolves.toBeUndefined();
    expect(h.reports.at(-1)?.rejectedFiles?.[0]?.reason).toBe('duplicate');
    expect(wikiPagesWritten(h.writtenPaths)).toEqual([]);
    expect(h.stats.llmCalls).toBe(0);
    expect(h.engine.isIngesting()).toBe(false);
    expect(ingestionEnds).toBe(1);
  });

  it('flags a second identical file in the same batch as a duplicate', async () => {
    const h = createWikiEngineHarness();
    const ctx = h.engine.createBatchContext();
    expect(await h.engine.checkRequirements(sourceFile('sources/a.md'), 'identical body', ctx)).toBeNull();
    const dup = await h.engine.checkRequirements(sourceFile('sources/b.md'), 'identical body', ctx);
    expect(dup?.reason).toBe('duplicate');
  });

  it('prompts on a duplicate for interactive ingest and skips when the user declines', async () => {
    const dupBody = 'dup body';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/copy.md': dupBody,
      },
    });
    let prompted = false;
    h.engine.onConfirmReingest = async () => { prompted = true; return false; };

    await h.engine.ingestSource(sourceFile('sources/copy.md'), { interactive: true });

    expect(prompted).toBe(true);
    expect(h.reports.at(-1)?.skipped).toBe(true);
    expect(wikiPagesWritten(h.writtenPaths)).toEqual([]);
    expect(h.stats.llmCalls).toBe(0);
  });

  it('keeps generic interactive ingest fail-closed even when its prompt is confirmed', async () => {
    const dupBody = 'dup body text';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/copy.md': dupBody,
      },
      llmResponses: [JSON.stringify({ source_title: 't', summary: 's', entities: [], concepts: [] })],
    });
    h.engine.onConfirmReingest = async () => true;

    // A generic ingest caller cannot mint the governed force capability. The
    // command-owned force path below is the only path that may proceed.
    try { await h.engine.ingestSource(sourceFile('sources/copy.md'), { interactive: true }); } catch { /* mock edge */ }

    expect(h.stats.llmCalls).toBe(0);
    expect(h.reports.at(-1)?.skipped).toBe(true);
  });

  it('runs governed force re-ingest only for the confirmed active physical source', async () => {
    const dupBody = 'governed duplicate body';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/source10.md': dupBody,
      },
      llmResponses: [JSON.stringify({ source_title: 't', summary: 's', entities: [], concepts: [] })],
    });
    let confirmations = 0;
    h.engine.onConfirmReingest = async () => { confirmations++; return true; };

    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md'))).resolves.toBe(true);

    expect(confirmations).toBe(1);
    expect(h.stats.llmCalls).toBeGreaterThan(0);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.sourceFile).toBe('sources/source10.md');
    expect(h.writtenPaths.filter(path => path === 'wiki/log.md')).toHaveLength(1);
  });

  it('refuses a constructed path-bearing TFile instead of resolving by path alone', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'existing source' } });
    const constructed = sourceFile('sources/source10.md');

    await expect(h.engine.forceReingestSource(constructed))
      .rejects.toThrow('exact active TFile object');
    expect(h.stats.llmCalls).toBe(0);
    expect([...h.files.keys()]).toEqual(['sources/source10.md']);
  });

  it.each([
    'wiki/sources/generated.md',
    '.obsidian/plugins/karpathywiki/generated.md',
    'notes/.trash/recovered.md',
  ])('refuses generated/configuration/hidden Markdown as a force source: %s', async (path) => {
    const h = createWikiEngineHarness({ files: { [path]: 'not a physical source' } });

    await expect(h.engine.forceReingestSource(vaultFile(h, path)))
      .rejects.toThrow('refuses generated, configuration, hidden, and trash surfaces');
    expect(h.stats.llmCalls).toBe(0);
    expect(h.writtenPaths).toEqual([]);
  });

  it('refuses invalid UTF-8 and control-bearing bytes hidden behind a .md extension', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/source10.md': 'placeholder' } });
    const adapter = h.app.vault.adapter;
    const originalReadBinary = adapter.readBinary!.bind(adapter);
    adapter.readBinary = async (path: string) => path === 'sources/source10.md'
      ? Uint8Array.from([0xff, 0xfe, 0x00, 0x41]).buffer
      : originalReadBinary(path);

    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md')))
      .rejects.toThrow('refuses non-UTF-8 Markdown bytes');
    expect(h.stats.llmCalls).toBe(0);
    expect(h.writtenPaths).toEqual([]);
  });

  it('re-reads and rejects a source edited while confirmation is open', async () => {
    const dupBody = 'source body before confirmation';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/source10.md': dupBody,
      },
    });
    let confirmStarted!: () => void;
    let releaseConfirm!: () => void;
    const confirmationStarted = new Promise<void>(resolve => { confirmStarted = resolve; });
    const confirmation = new Promise<void>(resolve => { releaseConfirm = resolve; });
    h.engine.onConfirmReingest = async () => {
      confirmStarted();
      await confirmation;
      return true;
    };

    const run = h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md'));
    await confirmationStarted;
    h.files.set('sources/source10.md', 'edited after the modal opened');
    releaseConfirm();

    await expect(run).rejects.toThrow('Source changed while confirmation was open');
    expect(h.files.get('wiki/sources/x_1.md')).toContain('contentHash:');
    expect([...h.files.keys()].filter(path => path.startsWith('wiki/'))).toEqual(['wiki/sources/x_1.md']);
    expect(h.stats.llmCalls).toBe(0);
  });

  it('fails closed when the confirmed source is deleted', async () => {
    const dupBody = 'source body before deletion';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/source10.md': dupBody,
      },
    });
    let confirmStarted!: () => void;
    let releaseConfirm!: () => void;
    const confirmationStarted = new Promise<void>(resolve => { confirmStarted = resolve; });
    const confirmation = new Promise<void>(resolve => { releaseConfirm = resolve; });
    h.engine.onConfirmReingest = async () => {
      confirmStarted();
      await confirmation;
      return true;
    };

    const run = h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md'));
    await confirmationStarted;
    h.files.delete('sources/source10.md');
    releaseConfirm();

    await expect(run).rejects.toThrow('Could not read authoritative source file');
    expect(h.stats.llmCalls).toBe(0);
    expect([...h.files.keys()].filter(path => path.startsWith('wiki/'))).toEqual(['wiki/sources/x_1.md']);
  });

  it('re-reads authority before completion/index/log and rolls back when source bytes drift mid-generation', async () => {
    const body = 'stable source before generation';
    const originalSummary = `---\ntype: source\ncontentHash: ${hashBody(body)}\n---\n\noriginal summary`;
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/source10.md': originalSummary,
        'sources/source10.md': body,
      },
      llmResponses: [JSON.stringify({ source_title: 'source10', summary: 'changed', entities: [], concepts: [] })],
    });
    h.engine.onConfirmReingest = async () => true;
    const originalCreate = h.app.vault.create.bind(h.app.vault);
    let drifted = false;
    h.app.vault.create = async (path: string, content: string) => {
      const created = await originalCreate(path, content);
      if (!drifted && path.startsWith('wiki/')) {
        drifted = true;
        h.files.set('sources/source10.md', 'source changed during generation');
      }
      return created;
    };

    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md')))
      .rejects.toThrow('changed before governed completion');
    expect(h.files.get('wiki/sources/source10.md')).toBe(originalSummary);
    expect(h.files.has('wiki/index.md')).toBe(false);
    expect(h.files.has('wiki/log.md')).toBe(false);
  });

  it('revalidates source after index/log writes and before durable transaction commit', async () => {
    const body = 'stable until final log';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/source10.md': `---\ntype: source\ncontentHash: ${hashBody(body)}\n---\n\noriginal`,
        'sources/source10.md': body,
      },
      llmResponses: [JSON.stringify({ source_title: 'source10', summary: 's', entities: [], concepts: [] })],
    });
    h.engine.onConfirmReingest = async () => true;
    const originalCreate = h.app.vault.create.bind(h.app.vault);
    h.app.vault.create = async (path: string, content: string) => {
      const created = await originalCreate(path, content);
      if (path === 'wiki/log.md') h.files.set('sources/source10.md', 'changed at final commit boundary');
      return created;
    };

    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md')))
      .rejects.toThrow('changed before governed completion');
    expect(h.files.has('wiki/index.md')).toBe(false);
    expect(h.files.has('wiki/log.md')).toBe(false);
  });

  it('cancels before confirmation can mint a capability', async () => {
    const dupBody = 'source body cancellation';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/source10.md': dupBody,
      },
    });
    let confirmStarted!: () => void;
    let releaseConfirm!: () => void;
    const confirmationStarted = new Promise<void>(resolve => { confirmStarted = resolve; });
    const confirmation = new Promise<void>(resolve => { releaseConfirm = resolve; });
    h.engine.onConfirmReingest = async () => {
      confirmStarted();
      await confirmation;
      return true;
    };

    const run = h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md'));
    await confirmationStarted;
    h.engine.cancelIngestion();
    releaseConfirm();

    await expect(run).rejects.toThrow('Ingestion lease cancelled');
    expect(h.engine.isIngesting()).toBe(false);
    expect(h.stats.llmCalls).toBe(0);
    expect([...h.files.keys()].filter(path => path.startsWith('wiki/'))).toEqual(['wiki/sources/x_1.md']);
  });

  it('rolls back generated pages and leaves index/log untouched after a mid-batch transport failure', async () => {
    const dupBody = 'source body transport failure';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\noriginal`,
        'sources/source10.md': dupBody,
      },
      llmResponses: [
        JSON.stringify({
          entities: [{ name: 'Generated Entity', type: 'other', summary: 'generated', mentions_in_source: [] }],
          concepts: [],
        }),
        JSON.stringify({ source_title: 't', summary: 's', entities: [], concepts: [] }),
      ],
    });
    h.engine.onConfirmReingest = async () => true;
    const originalCreate = h.app.vault.create.bind(h.app.vault);
    h.app.vault.create = async (path: string, content: string) => {
      if (path.includes('/entities/')) throw new Error('simulated mid-batch transport failure');
      return originalCreate(path, content);
    };

    const before = new Map(h.files);
    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md')))
      .rejects.toThrow('Governed re-ingest page generation failed');

    const userFiles = [...h.files].filter(([path]) => !path.startsWith('.obsidian/'));
    expect(userFiles).toEqual([...before]);
    expect(h.files.has('wiki/index.md')).toBe(false);
    expect(h.files.has('wiki/log.md')).toBe(false);
    expect(h.engine.isIngesting()).toBe(false);
  });

  it('treats contradiction artifact failure as fatal and rolls governed writes back', async () => {
    const body = 'source body with a contradiction';
    const original = `---\ntype: source\ncontentHash: ${hashBody(body)}\n---\n\noriginal summary`;
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/source10.md': original,
        'sources/source10.md': body,
      },
      llmResponses: [JSON.stringify({
        source_title: 'source10',
        summary: 'replacement',
        entities: [],
        concepts: [],
        contradictions: [{
          claim: 'new claim',
          contradicted_by: 'old claim',
          source_page: 'wiki/concepts/existing.md',
          resolution: 'review',
        }],
      })],
    });
    h.engine.onConfirmReingest = async () => true;
    h.engine.noteContradiction = async () => { throw new Error('simulated contradiction write failure'); };

    await expect(h.engine.forceReingestSource(vaultFile(h, 'sources/source10.md')))
      .rejects.toThrow('simulated contradiction write failure');
    expect(h.files.get('wiki/sources/source10.md')).toBe(original);
    expect(h.files.has('wiki/index.md')).toBe(false);
    expect(h.files.has('wiki/log.md')).toBe(false);
  });

  it('rejects a generic or forged force flag without any mutation', async () => {
    const dupBody = 'forged duplicate body';
    const h = createWikiEngineHarness({
      files: {
        'wiki/sources/x_1.md': `---\ntype: source\ncontentHash: ${hashBody(dupBody)}\n---\n\nx`,
        'sources/source10.md': dupBody,
      },
    });
    const before = new Map(h.files);

    await expect(h.engine.ingestSource(sourceFile('sources/source10.md'), {
      forceReingest: true as never,
    })).rejects.toThrow('Refusing ungoverned force re-ingest');

    expect(h.stats.llmCalls).toBe(0);
    expect(h.writtenPaths).toEqual([]);
    expect([...h.files]).toEqual([...before]);
  });
});

describe('WikiEngine.ingestSource — caller cancellation', () => {
  it('prevents writes after a queued caller aborts during source IO', async () => {
    const sourcePath = 'sources/cancelled.md';
    const h = createWikiEngineHarness({
      files: { [sourcePath]: 'Content that must not be written after cancellation.' },
      llmResponses: [HALLUCINATED],
    });
    const originalRead = h.app.vault.read.bind(h.app.vault);
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const blocker = new Promise<void>(resolve => { releaseRead = resolve; });
    h.app.vault.read = async (source: TFile) => {
      if (source.path === sourcePath) {
        readStarted();
        await blocker;
      }
      return originalRead(source);
    };
    const controller = new AbortController();

    const ingest = h.engine.ingestSource(sourceFile(sourcePath), { abortSignal: controller.signal });
    await started;
    controller.abort();
    releaseRead();
    await ingest;

    expect(wikiPagesWritten(h.writtenPaths)).toEqual([]);
    expect(h.reports.at(-1)).toMatchObject({ success: false, cancelled: true });
    expect(h.engine.isIngesting()).toBe(false);
  });
});

describe('WikiEngine.ingestSource — lease context capability', () => {
  it('does not let a stale context bypass a concurrent live lease', async () => {
    const h = createWikiEngineHarness({ files: { 'sources/stale.md': 'must not ingest' } });
    let staleContext!: IngestionLeaseContext;
    await withIngestionLease(h.engine, async (_signal, context) => {
      staleContext = context!;
    });

    let releaseLive!: () => void;
    const liveBlocker = new Promise<void>(resolve => { releaseLive = resolve; });
    const liveLease = withIngestionLease(h.engine, async () => {
      await liveBlocker;
    });
    const internal = vi.spyOn(
      h.engine as unknown as {
        ingestSourceInternal: (file: TFile, opts?: object) => Promise<void>;
      },
      'ingestSourceInternal',
    ).mockResolvedValue(undefined);

    await expect(h.engine.ingestSource(sourceFile('sources/stale.md'), {
      ingestionContext: staleContext,
    })).rejects.toThrow('stale, forged, or not active');
    expect(internal).not.toHaveBeenCalled();

    releaseLive();
    await liveLease;
  });
});

describe('WikiEngine.buildIngestedHashes — TTL cache (#164 review)', () => {
  it('reuses one vault walk across back-to-back checks within the TTL window', () => {
    // createBatchContext() is the public entry to buildIngestedHashes(). The cache
    // should make a second call within the TTL window read the snapshot instead of
    // re-walking vault.getMarkdownFiles() — the reviewer's perf concern.
    const h = createWikiEngineHarness({
      files: { 'wiki/sources/a.md': `---\ntype: source\ncontentHash: abc\n---\n\na` },
    });

    h.engine.createBatchContext();
    h.engine.createBatchContext();

    expect(h.stats.vaultMarkdownScans).toBe(1);
  });

  it('rebuilds the snapshot after a write invalidates the cache', async () => {
    // A fresh ingest writes a source page → invalidatePageCaches() must drop the
    // hash cache so the next check sees the just-written content (correctness, not
    // just perf — a 5s-stale snapshot would miss an immediate duplicate).
    const h = createWikiEngineHarness({
      files: { 'wiki/sources/a.md': `---\ntype: source\ncontentHash: abc\n---\n\na` },
    });

    h.engine.createBatchContext();
    expect(h.stats.vaultMarkdownScans).toBe(1);

    // A write (happy path: create) invalidates the cache without scanning itself.
    await h.engine.createOrUpdateFile('wiki/sources/b.md', `---\ntype: source\ncontentHash: def\n---\n\nb`);
    expect(h.stats.vaultMarkdownScans).toBe(1);

    h.engine.createBatchContext();
    expect(h.stats.vaultMarkdownScans).toBe(2);
  });
});

describe('WikiEngine.createOrUpdateFile — NFC/NFD path resolution (#173 Symptom A)', () => {
  it('resolves an existing file via directory scan when getAbstractFileByPath returns null', async () => {
    // Simulate macOS NFC/NFD normalization: the file exists in the vault but
    // getAbstractFileByPath returns null (the resolved path uses a different
    // Unicode normalization form from the stored filename).
    const h = createWikiEngineHarness({
      files: { 'wiki/sources/existing.md': `---\ntype: source\n---\n\nexisting content` },
      nfcNfdPaths: ['wiki/sources/existing.md'],
    });

    // The file is in the vault; nfcNfdPaths makes getAbstractFileByPath return
    // null for it. createOrUpdateFile should resolve it via resolveFileInVault
    // (directory-level scan, not full getMarkdownFiles) and call process().
    await h.engine.createOrUpdateFile('wiki/sources/existing.md', `---\ntype: source\n---\n\nupdated content`);

    // Content was updated (process was called, not create).
    expect(h.files.get('wiki/sources/existing.md')).toContain('updated content');

    // resolveFileInVault does a parent-directory listing, NOT a full
    // vault.getMarkdownFiles() scan — so vaultMarkdownScans must stay 0.
    expect(h.stats.vaultMarkdownScans).toBe(0);
  });

  it('still creates a new file normally when the path genuinely does not exist', async () => {
    const h = createWikiEngineHarness({});

    await h.engine.createOrUpdateFile('wiki/sources/new.md', 'fresh content');

    // Completion stamping is awaited by the public write gate, so callers do
    // not observe a transient incomplete page after create resolves.
    expect(h.files.get('wiki/sources/new.md')).toContain('fresh content');
    // A new file creation should not trigger vaultMarkdownScans either.
    expect(h.stats.vaultMarkdownScans).toBe(0);
  });

  it('leaves a failed completion flip visibly incomplete instead of swallowing it', async () => {
    const path = 'wiki/sources/crashed.md';
    const h = createWikiEngineHarness({ files: { [path]: 'old' } });
    const originalProcess = h.app.vault.process;
    let processCalls = 0;
    h.app.vault.process = async (file, update) => {
      processCalls++;
      if (processCalls === 2) throw new Error('simulated completion crash');
      return originalProcess(file, update);
    };

    await expect(h.engine.createOrUpdateFile(path, 'new body'))
      .rejects.toThrow('simulated completion crash');
    expect(h.files.get(path)).toContain('generation_complete: false');
    expect(h.files.get(path)).toContain('new body');
  });

  it('serializes concurrent public writes on one canonical path', async () => {
    const h = createWikiEngineHarness({ files: { 'wiki/sources/race.md': 'old' } });
    let active = 0;
    let maxActive = 0;
    const originalProcess = h.app.vault.process;
    h.app.vault.process = async (file, update) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => window.setTimeout(resolve, 1));
      await originalProcess(file, update);
      active--;
      return h.files.get(file.path) ?? '';
    };

    await Promise.all([
      h.engine.createOrUpdateFile('wiki/sources/race.md', 'first'),
      h.engine.createOrUpdateFile('wiki/sources/race.md', 'second'),
    ]);

    expect(maxActive).toBe(1);
    expect(h.files.get('wiki/sources/race.md')).toMatch(/first|second/);
  });

});
