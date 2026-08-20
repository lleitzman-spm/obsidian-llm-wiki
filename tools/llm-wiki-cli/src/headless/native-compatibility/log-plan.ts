import { formatBytes } from '../../../../../src/core/format';
import { buildLogHeader } from '../../../../../src/core/log-header';
import { TEXTS } from '../../../../../src/texts';
import { normalizeNativeWikiFolder } from './slug';
import type {
  NativeCompatibilityReason,
  NativeIngestLogInput,
  NativeLintLogInput,
  NativeLogPlan,
} from './types';

const MAX_LOG_BYTES = 512 * 1024;
const HEADER_TERMINATOR = '\n\n';
const HEADER_FALLBACK = '# Wiki Operation Log\n\n';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CLOCK = /^\d{2}:\d{2}$/u;

function reason(code: string, message: string): NativeCompatibilityReason {
  return { code, message };
}

function labelsFor(language: string): { createdPages: string; updatedPages: string; contradictionsFound: string } {
  const key = language in TEXTS.en.logLabels ? language as keyof typeof TEXTS.en.logLabels : 'en';
  return TEXTS.en.logLabels[key];
}

function dedupPages(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function metricsSuffix(metrics: NativeIngestLogInput['metrics']): string {
  if (!metrics) return '';
  const parts: string[] = [];
  if (typeof metrics.durationSec === 'number' && metrics.durationSec > 0) parts.push(`${metrics.durationSec}s`);
  if (metrics.model) parts.push(metrics.model.replace(/-\d{8}$/u, ''));
  if (typeof metrics.sourceBytes === 'number' && metrics.sourceBytes > 0) parts.push(formatBytes(metrics.sourceBytes));
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

function validateClock(date: string, time: string, reasons: NativeCompatibilityReason[]): void {
  if (!ISO_DATE.test(date)) reasons.push(reason('invalid-date', `Native log date is invalid: ${date}`));
  if (!CLOCK.test(time)) reasons.push(reason('invalid-time', `Native log time is invalid: ${time}`));
}

/** Exact LogWriter.appendIngest rendering with an explicit sealed timestamp. */
export function planNativeIngestLog(input: NativeIngestLogInput): NativeLogPlan {
  const reasons: NativeCompatibilityReason[] = [];
  let wikiFolder = '';
  try {
    wikiFolder = normalizeNativeWikiFolder(input.wikiFolder);
  } catch (error) {
    reasons.push(reason('invalid-path', error instanceof Error ? error.message : String(error)));
  }
  validateClock(input.date, input.time, reasons);
  if (!input.operation.trim()) reasons.push(reason('missing-page-body', 'Native ingest log operation must not be empty'));
  if (!input.sourceTitle.trim()) reasons.push(reason('missing-page-body', 'Native ingest log source title must not be empty'));

  const labels = labelsFor(input.wikiLanguage || 'en');
  const existing = input.existingContent || buildLogHeader(input.wikiLanguage || 'en');
  const suffix = metricsSuffix(input.metrics);
  let entry = `\n\n## [${input.date} ${input.time}] ${input.operation} | ${input.sourceTitle}${suffix}\n\n`;
  entry += `**${labels.createdPages}**：${dedupPages(input.createdPages)
    .map(page => `[[${page.replace(wikiFolder + '/', '')}]]`)
    .join(', ')}\n\n`;
  entry += `**${labels.updatedPages}**：${input.updatedPages.map(page => `[[${page}]]`).join(', ')}\n\n`;
  if (input.contradictions && input.contradictions.length > 0) {
    entry += `**${labels.contradictionsFound}**：\n`;
    for (const contradiction of input.contradictions) {
      entry += `- ${contradiction.claim} vs ${contradiction.source_page}\n`;
    }
  }
  const content = existing + entry;
  const canApply = reasons.length === 0;
  return Object.freeze({
    status: canApply ? 'ready' : 'refused',
    canApply,
    reasons,
    path: `${wikiFolder || input.wikiFolder}/log.md`,
    action: 'replace',
    content: canApply ? content : undefined,
    entryKind: 'ingest',
  });
}

function trimLog(existingLog: string, entry: string): string {
  const projectedSize = (existingLog.length + entry.length) * 2;
  if (projectedSize <= MAX_LOG_BYTES) return existingLog;
  const headerEnd = existingLog.indexOf(HEADER_TERMINATOR);
  const header = headerEnd > 0
    ? existingLog.substring(0, headerEnd + HEADER_TERMINATOR.length)
    : HEADER_FALLBACK;
  const keepBytes = MAX_LOG_BYTES / 2;
  const trimmed = existingLog.substring(existingLog.length - keepBytes);
  const h2Idx = trimmed.indexOf('\n## ');
  return header + (h2Idx > 0 ? trimmed.substring(h2Idx + 1) : trimmed);
}

/** Exact LogWriter.appendLintFix rendering, including the 512 KiB cap. */
export function planNativeLintLog(input: NativeLintLogInput): NativeLogPlan {
  const reasons: NativeCompatibilityReason[] = [];
  let wikiFolder = '';
  try {
    wikiFolder = normalizeNativeWikiFolder(input.wikiFolder);
  } catch (error) {
    reasons.push(reason('invalid-path', error instanceof Error ? error.message : String(error)));
  }
  validateClock(input.date, input.time, reasons);
  if (!input.operation.trim()) reasons.push(reason('missing-page-body', 'Native lint log operation must not be empty'));

  const existing = input.existingContent || buildLogHeader(input.wikiLanguage || 'en');
  const entry = `\n\n## [${input.date} ${input.time}] ${input.operation}\n\n${input.details}\n`;
  const content = trimLog(existing, entry) + entry;
  const canApply = reasons.length === 0;
  return Object.freeze({
    status: canApply ? 'ready' : 'refused',
    canApply,
    reasons,
    path: `${wikiFolder || input.wikiFolder}/log.md`,
    action: 'replace',
    content: canApply ? content : undefined,
    entryKind: 'lint',
  });
}

