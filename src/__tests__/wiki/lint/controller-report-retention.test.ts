import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildLintReport } from '../../../wiki/lint/report-builder';
import { extractProgReport } from '../../../wiki/lint/controller';
import {
  serializeLintReportArtifact,
  splitLintReportSections,
} from '../../../wiki/engine-internals/report-retention';
import { LLMWikiSettings } from '../../../types';
import { ProgrammaticFindings } from '../../../wiki/lint/types';

function makeSettings(): LLMWikiSettings {
  return {
    wikiFolder: 'wiki',
    language: 'en',
    slugCase: 'lower',
    tagVocabularyMode: 'default',
  } as LLMWikiSettings;
}

function makeFindings(overrides: Partial<ProgrammaticFindings> = {}): ProgrammaticFindings {
  return {
    aliasDeficientPages: [],
    emptyPages: [],
    orphans: [],
    tagViolations: [],
    pollutedPages: [],
    deadLinks: [],
    ungroundedQuotes: [],
    hubLinkDensityIssues: [],
    sourcesNormalizedFiles: 0,
    sourcesNormalizedEntries: 0,
    doubleNestFixes: 0,
    ...overrides,
  };
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function sha256(text: string): Promise<string> {
  return hashText(text);
}

describe('native lint report retention', () => {
  it('keeps the first finding heading, every dead-link row, and its section digest', async () => {
    const deadLinks = Array.from({ length: 288 }, (_, index) => ({
      source: `entities/source-${index + 1}`,
      target: `entities/missing-${index + 1}`,
    }));
    const report = buildLintReport({
      settings: makeSettings(),
      findings: makeFindings({
        deadLinks,
        ungroundedQuotes: [{
          pagePath: 'wiki/entities/quoted',
          quote: 'ungrounded quote',
          hasSourceLink: false,
        }],
        orphans: ['wiki/entities/orphan.md'],
      }),
      duplicates: [],
      contradictionsReport: '',
      elapsedSeconds: 1,
      totalPages: 973,
    });

    const summaryEnd = report.indexOf('\n\n', report.indexOf('> '));
    const nativeReport = report.slice(0, summaryEnd + 2) + extractProgReport(report);
    const retained = await serializeLintReportArtifact({
      timestamp: '2026-08-20T00:00:00.000Z',
      runId: 'regression',
      previousLog: '',
      report: nativeReport,
      reportRoot: 'wiki/lint-reports',
      sha256,
    });

    expect(nativeReport).toContain('## Dead links (detected) [288]');
    expect(nativeReport.match(/page does not exist/g)).toHaveLength(288);

    const sectionTexts = splitLintReportSections(nativeReport);
    expect(sectionTexts.map(section => section.match(/^#{2,6} .+/m)?.[0])).toEqual([
      '## Dead links (detected) [288]',
      '## Ungrounded quotes (detected) [1]',
      '## Orphan pages (detected) [1]',
    ]);
    expect(sectionTexts[0].match(/page does not exist/g)).toHaveLength(288);
    expect(retained.artifact.sections[0]).toEqual({
      heading: '## Dead links (detected) [288]',
      sha256: hashText(sectionTexts[0]),
      byteLength: Buffer.byteLength(sectionTexts[0], 'utf8'),
    });
  });
});
