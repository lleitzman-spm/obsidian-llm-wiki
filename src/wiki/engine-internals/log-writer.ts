/**
 * LogWriter — wiki operation log (ingest + lint) writer.
 *
 * Extracted from WikiEngine (2026-07-19) as part of v1.25.1 Phase C-PR1.
 *
 * Responsibility:
 *   - Append ingest entries (## [date time] ingest | source_title · metrics)
 *     with deduplicated created-pages, updated-pages, and contradictions
 *   - Append lint-fix entries (## [date time] operation + details)
 *   - Trim the log file at 512 KB to avoid Obsidian choking on multi-MB files
 *     (trimming strategy: keep header + most-recent bytes aligned to H2 boundary)
 *   - Format byte counts (KB / MB) and metric suffix strings
 *
 * Non-responsibility:
 *   - The actual `vault.read` and `vault.process` calls live in WikiEngine's
 *     tryReadFile / createOrUpdateFile. LogWriter receives these as injected
 *     closures so it stays unit-testable.
 *   - Localized log label translation lives in TEXTS (per-locale logLabels table).
 *
 * Why extracted:
 *   - updateLog + logLintFix + formatIngestMetricsSuffix + formatBytes together
 *     totaled ~100 LOC with zero shared mutable state outside the log file
 *     itself. Composing them into a class makes the lifecycle (timestamp +
 *     header insertion + size cap) obvious.
 *   - Future log consumers (e.g. a "tail -f log.md" status indicator) can
 *     inject a custom writeFile and reuse the append-only invariants.
 */

import type { SourceAnalysis } from '../../types';
import { TEXTS } from '../../texts';
import { dedupPages } from './dedup-pages';
import { buildLogHeader } from '../../core/log-header';
import { formatBytes } from '../../core/format';
import {
  defaultRunId,
  assertCanonicalContained,
  canonicalVaultPath,
  serializeLintReportArtifact,
  sha256Utf8,
  utf8ByteLength,
  type Sha256Text,
  type SerializedLintReportArtifact,
} from './report-retention';

/** Metrics suffix for ingest log H2 line. */
export interface IngestMetrics {
  durationSec?: number;
  model?: string;
  sourceBytes?: number;
}

export interface LogWriterOptions {
  wikiFolder: string;
  wikiLanguage: string;
  /** Read the current log file content (returns null if not found). */
  readFile: (path: string) => Promise<string | null>;
  /** Write the full log content to the given path. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Optional plugin version included in retained lint report artifacts. */
  pluginVersion?: string;
  /** Optional clock and run-id source for deterministic retention tests. */
  now?: () => Date;
  runIdFactory?: () => string;
  sha256?: Sha256Text;
  /** Separate archive write/read hooks permit immutable collision checks. */
  readArchiveFile?: (path: string) => Promise<string | null>;
  /** Create-only raw writer. It must not normalize/rewrite content. */
  createArchiveFile?: (path: string, content: string) => Promise<void>;
  ensureArchiveFolder?: (path: string) => Promise<void>;
  /** Adapter/realpath resolver for reparse-point containment checks. */
  resolveArchivePath?: (path: string) => Promise<string | null>;
}

function isCreateCollision(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'EEXIST') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|file exists|EEXIST/i.test(message);
}

export class LogWriter {
  private readonly wikiFolder: string;
  private readonly wikiLanguage: string;
  private readonly readFile: LogWriterOptions['readFile'];
  private readonly writeFile: LogWriterOptions['writeFile'];
  private readonly pluginVersion: string | undefined;
  private readonly now: () => Date;
  private readonly runIdFactory: () => string;
  private readonly sha256: Sha256Text;
  private readonly readArchiveFile: NonNullable<LogWriterOptions['readArchiveFile']>;
  private readonly createArchiveFile: NonNullable<LogWriterOptions['createArchiveFile']>;
  private readonly ensureArchiveFolder: NonNullable<LogWriterOptions['ensureArchiveFolder']>;
  private readonly resolveArchivePath: LogWriterOptions['resolveArchivePath'];

  constructor(opts: LogWriterOptions) {
    this.wikiFolder = opts.wikiFolder;
    this.wikiLanguage = opts.wikiLanguage;
    this.readFile = opts.readFile;
    this.writeFile = opts.writeFile;
    this.pluginVersion = opts.pluginVersion;
    this.now = opts.now ?? (() => new Date());
    this.runIdFactory = opts.runIdFactory ?? defaultRunId;
    this.sha256 = opts.sha256 ?? sha256Utf8;
    this.readArchiveFile = opts.readArchiveFile ?? opts.readFile;
    this.createArchiveFile = opts.createArchiveFile ?? (async () => {
      throw new Error('Lint report retention requires a raw create-only archive writer');
    });
    this.ensureArchiveFolder = opts.ensureArchiveFolder ?? (async () => undefined);
    this.resolveArchivePath = opts.resolveArchivePath;
  }

  /**
   * Append an ingest entry. Format:
   *   ## [YYYY-MM-DD HH:MM] ingest | source_title · 28s · claude-sonnet-4-5 · 4.2KB
   *   **Created pages**: [[a]], [[b]]
   *   **Updated pages**: [[c]]
   *   **Contradictions found**:
   *   - claim1 vs page1
   */
  async appendIngest(
    operation: string,
    analysis: SourceAnalysis,
    metrics?: IngestMetrics,
  ): Promise<void> {
    const logPath = `${this.wikiFolder}/log.md`;
    const { date, time } = this.timestamp();
    const labels = this.labels();

    const h2Suffix = metrics ? this.formatIngestMetricsSuffix(metrics) : '';
    let entry = `\n\n## [${date} ${time}] ${operation} | ${analysis.source_title}${h2Suffix}\n\n`;
    entry += `**${labels.createdPages}**：${dedupPages(analysis.created_pages)
      .map(p => `[[${p.replace(this.wikiFolder + '/', '')}]]`)
      .join(', ')}\n\n`;
    entry += `**${labels.updatedPages}**：${analysis.updated_pages.map(p => `[[${p}]]`).join(', ')}\n\n`;

    if (analysis.contradictions.length > 0) {
      entry += `**${labels.contradictionsFound}**：\n`;
      for (const c of analysis.contradictions) {
        entry += `- ${c.claim} vs ${c.source_page}\n`;
      }
    }

    const existingLog = (await this.readFile(logPath)) || buildLogHeader(this.wikiLanguage);
    await this.writeFile(logPath, existingLog + entry);
  }

  /**
   * Append a lint-fix entry. Trims the log file at 512 KB to keep it manageable
   * in long-lived vaults. Trimming strategy: preserve the header + most-recent
   * bytes aligned to the next H2 boundary (so we never cut mid-entry).
   *
   * v1.25.1 Phase C-PR1.8 (Altitude #6): trim relies on the buildLogHeader
   * invariant that the header block is terminated by `\n\n`. If a future
   * change to `buildLogHeader` (in `src/core/log-header.ts`) breaks that
   * invariant — e.g. inserts a `---` separator or one-line subtitle — the
   * trim will silently drop real entries because `indexOf('\n\n')` returns
   * the FIRST occurrence anywhere in the file, not the bounded header. The
   * constants below document the seam: keep `buildLogHeader`'s terminator
   * in sync with `LogWriter.HEADER_TERMINATOR`.
   */
  private static readonly HEADER_TERMINATOR = '\n\n';
  private static readonly HEADER_FALLBACK = '# Wiki Operation Log\n\n';
  async appendLintFix(operation: string, details: string): Promise<void> {
    const logPath = `${this.wikiFolder}/log.md`;
    const { date, time } = this.timestamp();
    const entry = `\n\n## [${date} ${time}] ${operation}\n\n${details}\n`;

    try {
      let existingLog = await this.readFile(logPath);
      if (!existingLog) {
        existingLog = buildLogHeader(this.wikiLanguage);
      }

      // Cap at 512 KB to avoid Obsidian choking on multi-MB files.
      await this.writeBoundedLog(logPath, existingLog, entry);
    } catch (e) {
      console.error(`[logLintFix] failed to write ${logPath}:`, e);
      throw e; // re-throw so callers (e.g. runLintWiki) can surface the failure
    }
  }

  /**
   * Persist a complete lint report before appending its bounded-log index
   * entry. The archive is written first even when no trim is needed; if it
   * fails, this method throws and the log is left untouched.
   */
  async appendLintReport(operation: string, report: string): Promise<SerializedLintReportArtifact> {
    const logPath = `${this.wikiFolder}/log.md`;
    const reportRoot = canonicalVaultPath(`${this.wikiFolder}/lint-reports`);
    assertCanonicalContained(canonicalVaultPath(this.wikiFolder), reportRoot, 'Report archive root');
    const now = this.now();
    const timestamp = now.toISOString();
    const displayDate = timestamp.slice(0, 10);
    const displayTime = timestamp.slice(11, 16);
    const resolveArchivePath = this.resolveArchivePath;
    if (!resolveArchivePath) {
      throw new Error('Lint report retention requires a canonical archive path resolver');
    }
    // Validate the log path before reading it and again immediately before the
    // final write. The latter closes the same reparse/junction swap window as
    // the archive create path.
    await resolveArchivePath(logPath);
    const priorLog = await this.readFile(logPath);
    const existingLog = priorLog || buildLogHeader(this.wikiLanguage);
    const rootAdapterPath = await resolveArchivePath(reportRoot);
    if (!rootAdapterPath) throw new Error('Canonical archive path resolver returned no report root');

    let retained: SerializedLintReportArtifact | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const runId = this.runIdFactory();
      const candidate = await serializeLintReportArtifact({
        timestamp,
        runId,
        pluginVersion: this.pluginVersion,
        previousLog: priorLog ?? '',
        report,
        reportRoot,
        sha256: this.sha256,
      });
      assertCanonicalContained(reportRoot, candidate.reportPath, 'Report artifact');
      await this.ensureArchiveFolder(reportRoot);
      const rootAfterFolder = await resolveArchivePath(reportRoot);
      if (!rootAfterFolder) throw new Error('Canonical archive path resolver returned no report root after folder creation');
      assertCanonicalContained(rootAdapterPath, rootAfterFolder, 'Report archive root');
      assertCanonicalContained(rootAfterFolder, rootAdapterPath, 'Report archive root');
      const candidateAdapterPath = await resolveArchivePath(candidate.reportPath);
      if (!candidateAdapterPath) throw new Error('Canonical archive path resolver returned no report artifact');
      assertCanonicalContained(rootAfterFolder, candidateAdapterPath, 'Report artifact');
      if (await this.readArchiveFile(candidate.reportPath) !== null) continue;
      // The create-only call is the destructive boundary: resolve both paths
      // again immediately before it so a junction/reparse swap cannot move
      // the write after the earlier containment check.
      const rootBeforeCreate = await resolveArchivePath(reportRoot);
      const candidateBeforeCreate = await resolveArchivePath(candidate.reportPath);
      if (!rootBeforeCreate || !candidateBeforeCreate) throw new Error('Canonical archive path resolver lost report path before creation');
      assertCanonicalContained(rootAfterFolder, rootBeforeCreate, 'Report archive root');
      assertCanonicalContained(rootBeforeCreate, rootAfterFolder, 'Report archive root');
      assertCanonicalContained(rootBeforeCreate, candidateBeforeCreate, 'Report artifact');
      try {
        await this.createArchiveFile(candidate.reportPath, candidate.content);
      } catch (error) {
        if (isCreateCollision(error)) continue;
        throw error;
      }
      const rootAfterCreate = await resolveArchivePath(reportRoot);
      const candidateAfterCreate = await resolveArchivePath(candidate.reportPath);
      if (!rootAfterCreate || !candidateAfterCreate) throw new Error('Canonical archive path resolver lost report path after creation');
      assertCanonicalContained(rootAdapterPath, rootAfterCreate, 'Report archive root');
      assertCanonicalContained(rootAfterCreate, rootAdapterPath, 'Report archive root');
      assertCanonicalContained(rootAfterCreate, candidateAfterCreate, 'Report artifact');
      const persisted = await this.readArchiveFile(candidate.reportPath);
      if (persisted !== candidate.content) {
        throw new Error(`Lint report archive readback mismatch: ${candidate.reportPath}`);
      }
      if (await this.sha256(persisted) !== await this.sha256(candidate.content)) {
        throw new Error(`Lint report archive hash mismatch: ${candidate.reportPath}`);
      }
      retained = candidate;
      break;
    }
    if (!retained) throw new Error('Unable to allocate a collision-free lint report artifact ID');

    // The complete report lives in the immutable artifact. The operation log
    // is deliberately only a bounded, searchable index entry.
    const entry = `\n\n## [${displayDate} ${displayTime}] ${operation}\n\n` +
      `**Report artifact**: ${retained.reportPath}\n` +
      `**Report SHA256**: ${retained.artifact.reportSha256}\n` +
      `**Sections**: ${retained.artifact.sections.length}\n`;
    await resolveArchivePath(logPath);
    await this.writeBoundedLog(logPath, existingLog, entry);
    return retained;
  }

  private async writeBoundedLog(logPath: string, existingLog: string, entry: string): Promise<void> {
    const MAX_LOG_BYTES = 512 * 1024;
    const projectedSize = utf8ByteLength(existingLog + entry);
    if (projectedSize <= MAX_LOG_BYTES) {
      if (this.resolveArchivePath) await this.resolveArchivePath(logPath);
      await this.writeFile(logPath, existingLog + entry);
      return;
    }

    const headerEnd = existingLog.indexOf(LogWriter.HEADER_TERMINATOR);
    const header = headerEnd > 0
      ? existingLog.substring(0, headerEnd + LogWriter.HEADER_TERMINATOR.length)
      : LogWriter.HEADER_FALLBACK;
    const headerLength = header.length;
    const body = existingLog.slice(headerLength);
    const chunks = body.split(/(?=## )/).filter(chunk => chunk.length > 0);
    let suffix = '';
    for (let i = chunks.length - 1; i >= 0; i--) {
      const candidate = chunks[i] + suffix;
      if (utf8ByteLength(header + candidate + entry) > MAX_LOG_BYTES) break;
      suffix = candidate;
    }
    const trimmed = header + suffix;
    console.warn(`[logLintFix] ${logPath} exceeded ${MAX_LOG_BYTES} UTF-8 bytes; trimmed oldest entries`);
    if (this.resolveArchivePath) await this.resolveArchivePath(logPath);
    await this.writeFile(logPath, trimmed + entry);
  }

  /** Format an ingest metrics suffix: ` · 28s · claude-sonnet-4-5 · 4.2KB`. */
  private formatIngestMetricsSuffix(m: IngestMetrics): string {
    const parts: string[] = [];
    if (typeof m.durationSec === 'number' && m.durationSec > 0) {
      parts.push(`${m.durationSec}s`);
    }
    if (m.model) {
      // Strip trailing 8-digit date stamp: "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5".
      // Avoid leaking internal provider IDs into the user's log.
      parts.push(m.model.replace(/-\d{8}$/, ''));
    }
    if (typeof m.sourceBytes === 'number' && m.sourceBytes > 0) {
      parts.push(formatBytes(m.sourceBytes));
    }
    return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  }

  private timestamp(): { date: string; time: string } {
    const now = new Date();
    return {
      date: now.toISOString().split('T')[0],
      time: now.toTimeString().slice(0, 5), // HH:MM
    };
  }

  private labels(): { createdPages: string; updatedPages: string; contradictionsFound: string } {
    const lang = this.wikiLanguage || 'en';
    type LogLangKey = keyof typeof TEXTS.en.logLabels;
    const langKey: LogLangKey = (lang in TEXTS.en.logLabels) ? lang as LogLangKey : 'en';
    return TEXTS.en.logLabels[langKey];
  }
}

/**
 * Render byte count with KB / MB units.
 * Re-exported so wiki-engine.ts's legacy `formatBytes` import still resolves.
 * v1.25.1 Phase C-PR1.8 cleanup: the canonical implementation moved to
 * `src/core/format.ts`; this re-export preserves backward compatibility.
 */
export { formatBytes } from '../../core/format';
