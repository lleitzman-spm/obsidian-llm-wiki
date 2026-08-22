/**
 * v1.25.1 Phase C-PR3: Ingest commands.
 *
 * Extracted from main.ts (lines 587-927). Covers the 5 ingest
 * entry points and the batch pipeline.
 *
 * Cross-mixin dependencies:
 *   - requireLLMReady()          → ConnectionCommandsHost
 *   - preparePdfCacheForBatchIngest()  → PdfCacheHost
 *   - showProgressFor / dismissProgress → core methods (main retains)
 *   - ingestQueue / batchProgress        → core fields (promoted to public)
 *
 * WARNING: batchProgress = { current: i+1, total: ingestCount } is
 * read by the status-bar callback (registered in command-registry).
 * The shared mutation across async boundaries is intentional.
 */

import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { LLMWikiSettings, LLMClient, IngestReport } from '../types';
import type { WikiEngine } from '../wiki/wiki-engine';
import type { IngestQueue } from '../core/ingest-queue';
import type { BatchProgress } from '../core/status-bar';
import { TEXTS } from '../texts';
import { getText } from '../core/i18n';
import { slugify } from '../core/slug';
import { parseFrontmatter } from '../core/frontmatter';
import { NOTICE_NORMAL, NOTICE_ERROR } from '../constants';
import { FileSuggestModal, FolderSuggestModal, MultiFileSuggestModal } from '../ui/modals';
import { ProgressScope } from '../core/progress-notification';
import { checkPhysicalSource, reconcilePhysicalFolderFiles } from '../core/physical-source-authority';
import { withIngestionLease } from '../core/ingestion-coordinator';

export interface IngestHost {
  app: App;
  settings: LLMWikiSettings;
  llmClient: LLMClient | null;
  wikiEngine: WikiEngine;
  ingestQueue: IngestQueue;
  batchProgress: BatchProgress | null;
  requireLLMReady(): boolean;
  showProgressFor(scope: ProgressScope, msg: string): void;
  dismissProgress(): void;
  preparePdfCacheForBatchIngest(): Promise<void>;
  /** Self-references: co-members of this mixin. */
  runBatchIngest?(files: TFile[], jobIds: string[], sourceLabel: string): Promise<void>;
  isAlreadyIngested?(sourceFile: TFile): Promise<boolean>;
}

export interface IngestMethods {
  selectSourceToIngest(): void;
  ingestActiveFile(): void;
  selectFolderToIngest(): void;
  selectMultipleFilesToIngest(): void;
}

export async function ingestPhysicalSingleSource(
  host: IngestHost,
  file: TFile,
  errorContext: string,
): Promise<boolean> {
  const physicalCheck = await checkPhysicalSource(host.app.vault.adapter, file.path);
  if (!physicalCheck.exists) {
    new Notice(
      TEXTS[host.settings.language].errorIngestFailed + (physicalCheck.error ?? file.path),
      NOTICE_ERROR,
    );
    host.dismissProgress();
    return false;
  }

  try {
    await host.wikiEngine.ingestSource(file, {
      interactive: true,
      ...(physicalCheck.source ? { sourceSnapshot: physicalCheck.source } : {}),
    });
    return true;
  } catch (error) {
    console.error(errorContext, error);
    const errMsg = error instanceof Error ? error.message : String(error);
    new Notice(TEXTS[host.settings.language].errorIngestFailed + errMsg, NOTICE_ERROR);
    host.dismissProgress();
    return false;
  }
}

export const ingestCommands = {
  async isAlreadyIngested(this: IngestHost, sourceFile: TFile): Promise<boolean> {
    const slug = slugify(sourceFile.basename, this.settings.slugCase === 'preserve');
    const wikiPath = `${this.settings.wikiFolder}/sources/${slug}.md`;

    try {
      const file = this.app.vault.getAbstractFileByPath(wikiPath);
      if (!(file instanceof TFile)) return false;

      try {
        const content = await this.app.vault.read(file);
        const fm = parseFrontmatter(content);
        if (fm && fm.sources) {
          const normalizedSources = fm.sources.map(s => {
            const trimmed = s.trim();
            if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
              return trimmed.slice(2, -2).trim();
            }
            return trimmed;
          });
          return normalizedSources.includes(sourceFile.path);
        }
        return true;
      } catch {
        return true;
      }
    } catch {
      return false;
    }
  },

  selectSourceToIngest(this: IngestHost): void {
    if (!this.requireLLMReady()) return;
    if (!this.llmClient) {
      new Notice(TEXTS[this.settings.language].errorNoApiKey);
      return;
    }

    new FileSuggestModal(this.app, this.settings.wikiFolder, (file: TFile) => {
      // B2.5 follow-up (v1.26.3 PATCH): 'Ingesting: <file>' was hardcoded
      // English — route through getText so the Toast honors the locale.
      this.showProgressFor(ProgressScope.IngestManual,
        getText(this.settings.language, 'ingestSingleFileStart').replace('{filename}', file.basename));
      void ingestPhysicalSingleSource(this, file, 'Single ingest failed:');
    }).open();
  },

  ingestActiveFile(this: IngestHost): void {
    if (!this.requireLLMReady()) return;
    if (!this.llmClient) {
      new Notice(TEXTS[this.settings.language].errorNoApiKey);
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice(getText(this.settings.language, 'noActiveFile'), NOTICE_NORMAL);
      return;
    }

    this.showProgressFor(ProgressScope.IngestManual,
      getText(this.settings.language, 'ingestSingleFileStart').replace('{filename}', activeFile.basename));
    void ingestPhysicalSingleSource(this, activeFile, 'Ingest active file failed:');
  },

  selectFolderToIngest(this: IngestHost): void {
    if (!this.requireLLMReady()) return;
    if (!this.llmClient) {
      new Notice(TEXTS[this.settings.language].errorNoApiKey);
      return;
    }

    new FolderSuggestModal(this.app, this.settings.wikiFolder, (folder) => {
      void (async () => {
        let files: TFile[];
        try {
          files = await reconcilePhysicalFolderFiles(
            this.app.vault.adapter,
            this.app.vault.getFiles(),
            folder.path,
            folder.isRoot(),
            this.settings.wikiFolder,
            this.app.vault.configDir,
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          new Notice(TEXTS[this.settings.language].errorIngestFailed + errMsg, NOTICE_ERROR);
          return;
        }

        if (files.length === 0) {
          const msg = TEXTS[this.settings.language].selectFolderNoMdFiles.replace('{path}', folder.path);
          new Notice(msg);
          return;
        }

        void this.runBatchIngest!(files, [], `${files.length} files from ${folder.path}`);
      })();
    }).open();
  },

  selectMultipleFilesToIngest(this: IngestHost): void {
    if (!this.requireLLMReady()) return;
    if (!this.llmClient) {
      new Notice(TEXTS[this.settings.language].errorNoApiKey);
      return;
    }

    new MultiFileSuggestModal(
      this.app,
      this.settings,
      this.ingestQueue,
      (ids: string[], files: TFile[]) => {
        if (files.length === 0 || ids.length === 0) return;
        void this.runBatchIngest!(files, ids, `${files.length} manually-selected files`);
      },
    ).open();
  },

  async runBatchIngest(this: IngestHost, files: TFile[], jobIds: string[], sourceLabel: string): Promise<void> {
    // The completion callback is engine-global. Serialize the whole batch
    // orchestration (including callback installation and aggregate dispatch)
    // on the host object so overlapping batches cannot steal one another's
    // reports or restore the wrong callback.
    return withIngestionLease(this.wikiEngine, async (_signal, ingestionContext) => {
    const submittedJobIds = new Set(jobIds);
    const submittedPreissuedJobs = this.ingestQueue.getSnapshot()
      .filter(job => submittedJobIds.has(job.id));
    const reports: IngestReport[] = [];
    const previousDoneCallback = this.wikiEngine.getDoneCallback();
    let callbackRestored = false;
    const restoreDoneCallback = () => {
      if (callbackRestored) return;
      this.wikiEngine.setDoneCallback(previousDoneCallback);
      callbackRestored = true;
    };
    const dispatchAggregate = (report: IngestReport) => {
      restoreDoneCallback();
      if (previousDoneCallback) {
        previousDoneCallback(report);
      } else {
        this.dismissProgress();
      }
    };
    const batchPaths = new Set(files.map(file => file.path));
    this.wikiEngine.setDoneCallback((report: IngestReport) => {
      if (batchPaths.has(report.sourceFile)) {
        reports.push(report);
      } else {
        // A direct single-file ingest may be queued behind this batch. Route
        // its completion to the production callback instead of attributing it
        // to this aggregate.
        previousDoneCallback?.(report);
      }
    });

    try {
    await this.preparePdfCacheForBatchIngest();

    this.showProgressFor(ProgressScope.IngestManual,
      getText(this.settings.language, 'ingestCheckingExisting'));
    const alreadyIngestedFiles: TFile[] = [];
    const newFiles: TFile[] = [];
    const alignedJobIds: string[] = [];
    let physicalFailureCount = 0;
    let cancelledCount = 0;
    let coordinationFailureCount = 0;
    let engineAttemptCount = 0;
    const inputPaths = new Set(files.map(file => file.path));
    const preissuedJobs = submittedPreissuedJobs;
    const preissuedJobsByPath = new Map(
      preissuedJobs.map(job => [job.file.path, job.id]),
    );
    for (const job of preissuedJobs) {
      if (inputPaths.has(job.file.path)) continue;
      coordinationFailureCount++;
      const reason = `Pre-issued ingest job does not match any supplied source path: ${job.file.path}`;
      this.ingestQueue.start(job.id);
      this.ingestQueue.complete(job.id, false, reason);
      console.error(reason);
    }

    for (const file of files) {
      const jobId = preissuedJobsByPath.get(file.path) ?? '';
      if (jobIds.length > 0 && !jobId) {
        coordinationFailureCount++;
        console.error(`No pre-issued ingest job matches source path: ${file.path}`);
        continue;
      }
      if (jobId) {
        const currentJob = this.ingestQueue.getSnapshot().find(job => job.id === jobId);
        if (!currentJob || currentJob.status !== 'pending') {
          cancelledCount++;
          continue;
        }
      }
      const physicalCheck = await checkPhysicalSource(this.app.vault.adapter, file.path);
      if (!physicalCheck.exists) {
        physicalFailureCount++;
        if (jobId) {
          this.ingestQueue.start(jobId);
          this.ingestQueue.complete(jobId, false, physicalCheck.error);
        }
        new Notice(
          TEXTS[this.settings.language].errorIngestFailed + (physicalCheck.error ?? file.path),
          NOTICE_ERROR,
        );
        continue;
      }
      if (await this.isAlreadyIngested!(file)) {
        alreadyIngestedFiles.push(file);
        if (jobId) {
          this.ingestQueue.start(jobId);
          this.ingestQueue.complete(jobId, true);
        }
      } else {
        newFiles.push(file);
        alignedJobIds.push(jobId);
      }
    }

    const totalFiles = files.length;
    const skippedCount = alreadyIngestedFiles.length;
    const ingestCount = newFiles.length;

    if (skippedCount > 0) {
      const texts = TEXTS[this.settings.language];
      new Notice(
        texts.batchIngestSkipNotice
          .replace('{skipped}', String(skippedCount))
          .replace('{total}', String(totalFiles))
          .replace('{new}', String(ingestCount)),
        6000
      );
    }

    if (ingestCount === 0) {
      const success = physicalFailureCount === 0 && cancelledCount === 0 &&
        coordinationFailureCount === 0 && skippedCount === 0;
      dispatchAggregate({
        sourceFile: sourceLabel,
        createdPages: [],
        updatedPages: [],
        entitiesCreated: 0,
        conceptsCreated: 0,
        failedItems: [],
        contradictionsFound: 0,
        success,
        ...(!success ? { errorMessage: [
          physicalFailureCount > 0 ? `${physicalFailureCount} source file(s) failed physical verification` : '',
          cancelledCount > 0 ? `${cancelledCount} source file(s) cancelled` : '',
          coordinationFailureCount > 0 ? `${coordinationFailureCount} source file(s) failed queue coordination` : '',
          skippedCount > 0 ? `${skippedCount} source file(s) were already ingested and skipped` : '',
        ].filter(Boolean).join('; ') } : {}),
        skippedFiles: skippedCount,
        totalFilesInFolder: totalFiles,
        rejectedFiles: [],
      });
      return;
    }

    const texts = TEXTS[this.settings.language];
    this.showProgressFor(ProgressScope.IngestManual, texts.batchIngestStarting
      .replace('{count}', String(ingestCount))
      .replace('{folder}', sourceLabel));

    const batchCtx = this.wikiEngine.createBatchContext();

    let resolvedJobIds: string[];
    if (jobIds.length > 0) {
      resolvedJobIds = alignedJobIds;
    } else {
      resolvedJobIds = this.ingestQueue.enqueue(newFiles);
    }

    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i];
      const jobId = resolvedJobIds[i];

      try {
        let abortSignal: AbortSignal | undefined;
        if (jobId) {
          const queuedJob = this.ingestQueue.getSnapshot().find(job => job.id === jobId);
          if (!queuedJob || queuedJob.status !== 'pending') {
            cancelledCount++;
            continue;
          }
          this.ingestQueue.start(jobId);
          abortSignal = queuedJob.abortController.signal;
        }
        const physicalCheck = await checkPhysicalSource(this.app.vault.adapter, file.path);
        if (abortSignal?.aborted) {
          cancelledCount++;
          continue;
        }
        if (!physicalCheck.exists) {
          physicalFailureCount++;
          const reason = physicalCheck.error ?? `Source file is no longer present on disk: ${file.path}`;
          if (jobId) this.ingestQueue.complete(jobId, false, reason);
          new Notice(texts.errorIngestFailed + reason, NOTICE_ERROR);
          continue;
        }
        this.batchProgress = { current: i + 1, total: ingestCount };
        this.showProgressFor(ProgressScope.IngestManual, `[${i + 1}/${ingestCount}] ${file.basename}`);
        engineAttemptCount++;
        await this.wikiEngine.ingestSource(file, {
          batchCtx,
          abortSignal,
          ingestionContext,
          ...(physicalCheck.source ? { sourceSnapshot: physicalCheck.source } : {}),
        });
        if (abortSignal?.aborted || this.wikiEngine.wasCancelled) {
          cancelledCount++;
          if (jobId) {
            this.ingestQueue.complete(jobId, false, 'Cancelled by user');
          }
          continue;
        }
        if (jobId) {
          this.ingestQueue.complete(jobId, true);
        }
      } catch (error) {
        console.error(`(${i + 1}/${ingestCount}) ingestion failed: ${file.path}`, error);
        const errMsg = error instanceof Error ? error.message : String(error);
        new Notice(texts.errorIngestFailed + file.basename + ': ' + errMsg, NOTICE_ERROR);
        const priorReport = reports.find(report => report.sourceFile === file.path);
        if (priorReport) {
          priorReport.success = false;
          priorReport.errorMessage = priorReport.errorMessage
            ? `${priorReport.errorMessage}; ${errMsg}`
            : errMsg;
        } else {
          reports.push({
            sourceFile: file.path,
            createdPages: [],
            updatedPages: [],
            entitiesCreated: 0,
            conceptsCreated: 0,
            failedItems: [],
            contradictionsFound: 0,
            success: false,
            errorMessage: errMsg,
          });
        }
        if (jobId) this.ingestQueue.complete(jobId, false, errMsg);
      }
    }

    this.batchProgress = null;
    {
      const allCreated = [...new Set(reports.flatMap(r => r.createdPages))];
      const allUpdated = [...new Set(reports.flatMap(r => r.updatedPages))];
      const totalEntities = reports.reduce((sum, r) => sum + r.entitiesCreated, 0);
      const totalConcepts = reports.reduce((sum, r) => sum + r.conceptsCreated, 0);
      const totalContradictions = reports.reduce((sum, r) => sum + r.contradictionsFound, 0);
      const totalElapsed = reports.reduce((sum, r) => sum + (r.elapsedSeconds || 0), 0);
      const allFailedItems = reports.flatMap(r => r.failedItems);
      const allRejectedFiles = reports.flatMap(r => r.rejectedFiles || []);
      const missingReportCount = Math.max(0, engineAttemptCount - reports.length);
      const rejectedCount = allRejectedFiles.length;
      const allSuccess = physicalFailureCount === 0 && cancelledCount === 0 &&
        coordinationFailureCount === 0 && skippedCount === 0 && rejectedCount === 0 &&
        missingReportCount === 0 && reports.length === engineAttemptCount && reports.every(r => r.success);

      const aggregated: IngestReport = {
        sourceFile: sourceLabel,
        createdPages: allCreated,
        updatedPages: allUpdated,
        entitiesCreated: totalEntities,
        conceptsCreated: totalConcepts,
        failedItems: allFailedItems,
        contradictionsFound: totalContradictions,
        success: allSuccess,
        ...(!allSuccess
          ? { errorMessage: [
            physicalFailureCount > 0 ? `${physicalFailureCount} source file(s) failed physical verification` : '',
            cancelledCount > 0 ? `${cancelledCount} source file(s) cancelled` : '',
            coordinationFailureCount > 0 ? `${coordinationFailureCount} source file(s) failed queue coordination` : '',
            skippedCount > 0 ? `${skippedCount} source file(s) were already ingested and skipped` : '',
            rejectedCount > 0 ? `${rejectedCount} source file(s) were rejected` : '',
            missingReportCount > 0 ? `${missingReportCount} source ingest(s) produced no report` : '',
            reports.some(report => !report.success) ? 'One or more source ingests failed' : '',
          ].filter(Boolean).join('; ') }
          : {}),
        elapsedSeconds: totalElapsed,
        skippedFiles: skippedCount,
        totalFilesInFolder: totalFiles,
        rejectedFiles: allRejectedFiles,
      };

      dispatchAggregate(aggregated);
    }
    } finally {
      restoreDoneCallback();
    }
    });
  },
};
