import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { ingestCommands, IngestHost } from '../../main-commands/ingest-commands';
import { IngestQueue } from '../../core/ingest-queue';
import { DEFAULT_SETTINGS } from '../__support__/engine-context';

function sourceFile(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  return Object.assign(new TFile(), {
    path,
    name,
    basename: name.replace(/\.[^.]+$/, ''),
    extension: name.split('.').pop() ?? 'md',
  });
}

describe('ingestCommands.runBatchIngest cancellation', () => {
  it('stops the batch after a cancelled file and does not start the next writer', async () => {
    const first = sourceFile('sources/first.pdf');
    const second = sourceFile('sources/second.md');
    const ingested: string[] = [];
    let cancelled = false;
    const wikiEngine = {
      get wasCancelled() { return cancelled; },
      setDoneCallback: () => { /* no-op */ },
      createBatchContext: () => ({ seen: new Set<string>(), ingested: new Set<string>() }),
      ingestSource: async (file: TFile) => {
        ingested.push(file.path);
        cancelled = true;
      },
    };
    const host = {
      app: {},
      settings: { ...DEFAULT_SETTINGS },
      llmClient: {},
      wikiEngine,
      ingestQueue: new IngestQueue(),
      batchProgress: null,
      requireLLMReady: () => true,
      showProgressFor: () => { /* no-op */ },
      dismissProgress: () => { /* no-op */ },
      preparePdfCacheForBatchIngest: async () => { /* no-op */ },
      isAlreadyIngested: async () => false,
    } as unknown as IngestHost;

    await ingestCommands.runBatchIngest.call(host, [first, second], [], '2 files');

    expect(ingested).toEqual(['sources/first.pdf']);
    const jobs = host.ingestQueue.getSnapshot();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[1].status).toBe('pending');
  });
});
