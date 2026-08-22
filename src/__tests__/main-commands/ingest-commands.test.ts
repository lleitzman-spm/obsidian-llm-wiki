import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { IngestQueue } from '../../core/ingest-queue';
import {
  ingestCommands,
  ingestPhysicalSingleSource,
  type IngestHost,
} from '../../main-commands/ingest-commands';
import type { WikiEngine } from '../../wiki/wiki-engine';
import { DEFAULT_SETTINGS } from '../__support__/engine-context';
import type { IngestOptions, IngestReport } from '../../types';

function file(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    basename: name.slice(0, dot),
    extension: name.slice(dot + 1),
  });
}

function report(sourceFile: string): IngestReport {
  return {
    sourceFile,
    createdPages: [],
    updatedPages: [],
    entitiesCreated: 0,
    conceptsCreated: 0,
    failedItems: [],
    contradictionsFound: 0,
    success: true,
  };
}

function hostWithExists(exists: (path: string) => Promise<boolean>) {
  const ingestSource = vi.fn().mockResolvedValue(undefined);
  const queue = new IngestQueue();
  const productionEffects = {
    modalOpens: vi.fn(),
    graphInvalidations: vi.fn(),
    progressFinalizations: vi.fn(),
  };
  const initialDoneCallback = vi.fn((_report: IngestReport) => {
    productionEffects.modalOpens();
    productionEffects.graphInvalidations();
    productionEffects.progressFinalizations();
  });
  let doneCallback: ((report: IngestReport) => void) | null = initialDoneCallback;
  const host = {
    app: { vault: { adapter: { exists } } } as unknown as App,
    settings: DEFAULT_SETTINGS,
    llmClient: null,
    wikiEngine: {
      setDoneCallback: vi.fn((callback: ((report: IngestReport) => void) | null) => {
        doneCallback = callback;
      }),
      getDoneCallback: vi.fn(() => doneCallback),
      createBatchContext: vi.fn().mockReturnValue({ hashes: new Set<string>() }),
      ingestSource,
      wasCancelled: false,
    } as unknown as WikiEngine,
    ingestQueue: queue,
    batchProgress: null,
    requireLLMReady: () => true,
    showProgressFor: vi.fn(),
    dismissProgress: vi.fn(),
    preparePdfCacheForBatchIngest: vi.fn().mockResolvedValue(undefined),
    isAlreadyIngested: vi.fn().mockResolvedValue(false),
  } satisfies IngestHost;
  return {
    host,
    ingestSource,
    queue,
    initialDoneCallback,
    productionEffects,
    emitDone: (report: IngestReport) => doneCallback?.(report),
  };
}

describe('runBatchIngest physical authority', () => {
  it('rechecks immediately before ingest and fails the aligned job on a TOCTOU disappearance', async () => {
    const exists = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { host, ingestSource, queue } = hostWithExists(exists);
    const source = file('sources/vanishing.md');
    const ids = queue.enqueue([source]);

    await ingestCommands.runBatchIngest.call(host, [source], ids, 'one file');

    expect(ingestSource).not.toHaveBeenCalled();
    expect(queue.getSnapshot()[0]).toMatchObject({ id: ids[0], status: 'failed' });
  });

  it('aligns pre-issued jobs by path even when the file order differs', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const first = file('sources/first.md');
    const second = file('sources/second.md');
    const ids = queue.enqueue([first, second]);
    ingestSource.mockImplementation(async (source: TFile) => {
      if (source.path === second.path) throw new Error('second failed');
    });

    await ingestCommands.runBatchIngest.call(host, [second, first], ids, 'two files');

    expect(queue.getSnapshot().map(job => ({ id: job.id, status: job.status }))).toEqual([
      { id: ids[0], status: 'completed' },
      { id: ids[1], status: 'failed' },
    ]);
  });

  it('fails a pre-issued job that does not match any supplied source', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const queued = file('sources/queued.md');
    const supplied = file('sources/different.md');
    const ids = queue.enqueue([queued]);

    await ingestCommands.runBatchIngest.call(host, [supplied], ids, 'mismatched file');

    expect(ingestSource).not.toHaveBeenCalled();
    expect(queue.getSnapshot()[0]).toMatchObject({
      id: ids[0],
      status: 'failed',
      error: expect.stringContaining('does not match'),
    });
  });

  it('preserves every live source through both checks', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const sources = Array.from({ length: 4 }, (_, index) => file(`sources/live-${index}.md`));
    const ids = queue.enqueue(sources);

    await ingestCommands.runBatchIngest.call(host, sources, ids, 'four files');

    expect(ingestSource).toHaveBeenCalledTimes(4);
    expect(queue.getSnapshot().map(job => job.status)).toEqual([
      'completed', 'completed', 'completed', 'completed',
    ]);
  });

  it('marks the correct pre-issued jobs failed for adapter false and error results', async () => {
    const exists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('disk unavailable'));
    const { host, ingestSource, queue } = hostWithExists(exists);
    const sources = [file('sources/gone.md'), file('sources/unknown.md')];
    const ids = queue.enqueue(sources);

    await ingestCommands.runBatchIngest.call(host, sources, ids, 'two unavailable files');

    expect(ingestSource).not.toHaveBeenCalled();
    expect(queue.getSnapshot().map(job => ({ id: job.id, status: job.status, error: job.error })))
      .toEqual([
        expect.objectContaining({ id: ids[0], status: 'failed', error: expect.stringContaining('gone.md') }),
        expect.objectContaining({ id: ids[1], status: 'failed', error: expect.stringContaining('disk unavailable') }),
      ]);
  });

  it('reports aggregate failure when physical verification fails', async () => {
    const { host, queue, initialDoneCallback } = hostWithExists(async () => false);
    const source = file('sources/gone.md');
    const ids = queue.enqueue([source]);

    await ingestCommands.runBatchIngest.call(host, [source], ids, 'failed batch');

    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(initialDoneCallback.mock.calls[0][0]).toMatchObject({
      success: false,
      errorMessage: expect.stringContaining('failed physical verification'),
    });
  });

  it('cancels the running job, preserves its failure, and skips removed pending jobs', async () => {
    const { host, ingestSource, queue, initialDoneCallback } = hostWithExists(async () => true);
    const sources = [file('sources/running.md'), file('sources/pending.md')];
    const ids = queue.enqueue(sources);
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    ingestSource.mockImplementation(async (_source: TFile, opts?: IngestOptions) => {
      await blocker;
      expect(opts?.abortSignal?.aborted).toBe(true);
    });
    const run = ingestCommands.runBatchIngest.call(host, sources, ids, 'cancelled batch');
    await vi.waitFor(() => expect(queue.getSnapshot()[0]?.status).toBe('running'));
    for (const job of queue.getSnapshot()) {
      if (job.status === 'pending' || job.status === 'running') queue.remove(job.id);
    }
    release();
    await run;

    expect(ingestSource).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toEqual([
      expect.objectContaining({ id: ids[0], status: 'failed', error: 'Cancelled by user' }),
    ]);
    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(initialDoneCallback.mock.calls[0][0]).toMatchObject({
      success: false,
      totalFilesInFolder: 2,
      errorMessage: expect.stringContaining('2 source file(s) cancelled'),
    });
  });

  it('serializes overlapping batch calls and leaves later jobs visibly pending', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const first = file('sources/first-batch.md');
    const second = file('sources/second-batch.md');
    const [firstId] = queue.enqueue([first]);
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>(resolve => { releaseFirst = resolve; });
    ingestSource.mockImplementation(async (source: TFile) => {
      if (source.path === first.path) await firstBlocker;
    });

    const firstRun = ingestCommands.runBatchIngest.call(host, [first], [firstId], 'first batch');
    await vi.waitFor(() => expect(ingestSource).toHaveBeenCalledTimes(1));
    const [secondId] = queue.enqueue([second]);
    const secondRun = ingestCommands.runBatchIngest.call(host, [second], [secondId], 'second batch');
    await Promise.resolve();

    expect(ingestSource).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().find(job => job.id === secondId)?.status).toBe('pending');

    releaseFirst();
    await Promise.all([firstRun, secondRun]);

    expect(ingestSource.mock.calls.map(call => (call[0] as TFile).path)).toEqual([
      first.path,
      second.path,
    ]);
    expect(queue.getSnapshot().find(job => job.id === secondId)?.status).toBe('completed');
  });

  it('counts cancellation during the awaited second disk check as non-success', async () => {
    let releaseSecondCheck!: () => void;
    const secondCheck = new Promise<boolean>(resolve => { releaseSecondCheck = () => resolve(true); });
    const exists = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => secondCheck);
    const { host, ingestSource, queue, initialDoneCallback } = hostWithExists(exists);
    const source = file('sources/cancel-during-check.md');
    const [id] = queue.enqueue([source]);
    const run = ingestCommands.runBatchIngest.call(host, [source], [id], 'race batch');
    await vi.waitFor(() => expect(exists).toHaveBeenCalledTimes(2));
    queue.remove(id);
    releaseSecondCheck();
    await run;

    expect(ingestSource).not.toHaveBeenCalled();
    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(initialDoneCallback.mock.calls[0][0]).toMatchObject({
      success: false,
      errorMessage: expect.stringContaining('1 source file(s) cancelled'),
    });
  });

  it('suppresses per-file production effects, dispatches one aggregate, and restores later direct ingest', async () => {
    const {
      host,
      ingestSource,
      queue,
      initialDoneCallback,
      productionEffects,
      emitDone,
    } = hostWithExists(async () => true);
    const batchSource = file('sources/report-batch.md');
    const laterSource = file('sources/report-later.md');
    const [batchId] = queue.enqueue([batchSource]);
    ingestSource.mockImplementation(async (source: TFile) => {
      emitDone(report(source.path));
    });

    await ingestCommands.runBatchIngest.call(host, [batchSource], [batchId], 'report batch');

    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(initialDoneCallback.mock.calls[0][0]).toMatchObject({
      sourceFile: 'report batch',
      totalFilesInFolder: 1,
      success: true,
    });
    expect(initialDoneCallback).not.toHaveBeenCalledWith(report(batchSource.path));
    expect(productionEffects.modalOpens).toHaveBeenCalledOnce();
    expect(productionEffects.graphInvalidations).toHaveBeenCalledOnce();
    expect(productionEffects.progressFinalizations).toHaveBeenCalledOnce();
    expect(host.wikiEngine.getDoneCallback()).toBe(initialDoneCallback);

    await ingestPhysicalSingleSource(host, laterSource, 'later failed');

    expect(initialDoneCallback).toHaveBeenCalledWith(report(laterSource.path));
    expect(initialDoneCallback).toHaveBeenCalledTimes(2);
    expect(productionEffects.modalOpens).toHaveBeenCalledTimes(2);
    expect(productionEffects.graphInvalidations).toHaveBeenCalledTimes(2);
    expect(productionEffects.progressFinalizations).toHaveBeenCalledTimes(2);
  });

  it('restores the main dispatch when a batch ingest reports then throws', async () => {
    const {
      host,
      ingestSource,
      queue,
      initialDoneCallback,
      productionEffects,
      emitDone,
    } = hostWithExists(async () => true);
    const source = file('sources/report-error.md');
    const [id] = queue.enqueue([source]);
    ingestSource.mockImplementationOnce(async () => {
      emitDone({ ...report(source.path), success: false, errorMessage: 'engine failed' });
      throw new Error('engine failed');
    });

    await ingestCommands.runBatchIngest.call(host, [source], [id], 'error batch');

    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(initialDoneCallback.mock.calls[0][0]).toMatchObject({
      sourceFile: 'error batch',
      success: false,
    });
    expect(productionEffects.modalOpens).toHaveBeenCalledOnce();
    expect(productionEffects.graphInvalidations).toHaveBeenCalledOnce();
    expect(productionEffects.progressFinalizations).toHaveBeenCalledOnce();
    expect(host.wikiEngine.getDoneCallback()).toBe(initialDoneCallback);
    emitDone(report('sources/auto-after-error.md'));
    expect(initialDoneCallback).toHaveBeenLastCalledWith(report('sources/auto-after-error.md'));
    expect(initialDoneCallback).toHaveBeenCalledTimes(2);
  });

  it('restores the production callback before aggregate dispatch even when that callback throws', async () => {
    const {
      host,
      ingestSource,
      queue,
      initialDoneCallback,
      emitDone,
    } = hostWithExists(async () => true);
    const source = file('sources/callback-throws.md');
    const [id] = queue.enqueue([source]);
    ingestSource.mockImplementationOnce(async () => {
      emitDone(report(source.path));
    });
    initialDoneCallback.mockImplementationOnce(() => {
      throw new Error('production callback failed');
    });

    await expect(ingestCommands.runBatchIngest.call(host, [source], [id], 'throwing callback'))
      .rejects.toThrow('production callback failed');

    expect(initialDoneCallback).toHaveBeenCalledOnce();
    expect(host.wikiEngine.getDoneCallback()).toBe(initialDoneCallback);
    emitDone(report('sources/after-callback-error.md'));
    expect(initialDoneCallback).toHaveBeenCalledTimes(2);
  });
});

describe('single-source physical authority', () => {
  it('refuses a cached ghost before the single-file ingest engine runs', async () => {
    const { host, ingestSource } = hostWithExists(async () => false);

    await expect(ingestPhysicalSingleSource(host, file('sources/ghost.md'), 'single failed'))
      .resolves.toBe(false);

    expect(ingestSource).not.toHaveBeenCalled();
    expect(host.dismissProgress).toHaveBeenCalled();
  });

  it('refuses a single or active source when disk verification errors', async () => {
    const { host, ingestSource } = hostWithExists(async () => {
      throw new Error('adapter unavailable');
    });

    await expect(ingestPhysicalSingleSource(host, file('sources/unknown.md'), 'single failed'))
      .resolves.toBe(false);

    expect(ingestSource).not.toHaveBeenCalled();
  });

  it('runs a physically present single or active source interactively', async () => {
    const { host, ingestSource } = hostWithExists(async () => true);
    const source = file('sources/live.md');

    await expect(ingestPhysicalSingleSource(host, source, 'single failed')).resolves.toBe(true);

    expect(ingestSource).toHaveBeenCalledWith(source, { interactive: true });
  });

  it('serializes a direct single ingest behind an active batch', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const batchSource = file('sources/batch.md');
    const singleSource = file('sources/single.md');
    const [batchId] = queue.enqueue([batchSource]);
    let releaseBatch!: () => void;
    const batchBlocker = new Promise<void>(resolve => { releaseBatch = resolve; });
    ingestSource.mockImplementation(async (source: TFile) => {
      if (source.path === batchSource.path) await batchBlocker;
    });

    const batch = ingestCommands.runBatchIngest.call(host, [batchSource], [batchId], 'batch');
    await vi.waitFor(() => expect(ingestSource).toHaveBeenCalledTimes(1));
    const single = ingestPhysicalSingleSource(host, singleSource, 'single failed');
    await Promise.resolve();
    expect(ingestSource).toHaveBeenCalledTimes(1);

    releaseBatch();
    await Promise.all([batch, single]);

    expect(ingestSource.mock.calls.map(call => (call[0] as TFile).path)).toEqual([
      batchSource.path,
      singleSource.path,
    ]);
  });

  it('releases the shared lease after a direct ingest rejection', async () => {
    const { host, ingestSource, queue } = hostWithExists(async () => true);
    const rejected = file('sources/rejected.md');
    const later = file('sources/later.md');
    ingestSource
      .mockRejectedValueOnce(new Error('single rejected'))
      .mockResolvedValueOnce(undefined);

    const single = ingestPhysicalSingleSource(host, rejected, 'single failed');
    const [laterId] = queue.enqueue([later]);
    const batch = ingestCommands.runBatchIngest.call(host, [later], [laterId], 'later batch');

    await expect(single).resolves.toBe(false);
    await batch;

    expect(ingestSource.mock.calls.map(call => (call[0] as TFile).path)).toEqual([
      rejected.path,
      later.path,
    ]);
    expect(queue.getSnapshot().find(job => job.id === laterId)?.status).toBe('completed');
  });
});
