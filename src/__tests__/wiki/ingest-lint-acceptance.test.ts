import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import { createWikiEngineHarness } from '../__support__/wiki-engine-harness';
import { DEFAULT_SETTINGS } from '../__support__/engine-context';
import { runPreparationPhase } from '../../wiki/lint/phases/preparation';
import { runProgrammaticPhase } from '../../wiki/lint/phases/programmatic';
import { buildGraphFromContent } from '../../core/build-graph';
import type { LintPhaseContext } from '../../wiki/lint/types';

function sourceFile(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : 'md',
  });
}

describe('ingest-to-lint acceptance contract', () => {
  it('reports a failed page-generation item as an unsuccessful ingest', async () => {
    const rawPath = '10 Sources/approved/partial-ingest.md';
    const analysis = {
      source_title: 'Partial ingest',
      summary: 'A source whose generated page will fail validation.',
      key_points: [],
      entities: [{
        name: 'Broken Entity',
        type: 'organization',
        summary: 'An entity used to exercise failure reporting.',
        aliases: [],
        mentions_in_source: [],
        mentions_with_provenance: [],
        related_entities: [],
        related_concepts: [],
      }],
      concepts: [],
      related_pages: [],
      contradictions: [],
      created_pages: [],
      updated_pages: [],
    };
    const emptyExtraction = JSON.stringify({ entities: [], concepts: [] });
    const summaryPage = '---\ntype: source\ntags: [notes]\n---\n\n# Partial ingest\n';
    // `method` is a concept-only tag. Returning it twice makes both the first
    // page-generation attempt and its single retry fail in the real runner.
    const invalidEntityPage = '---\ntype: entity\ntags: [method]\n---\n\n## Description\nInvalid taxonomy.\n';
    const settings = {
      ...DEFAULT_SETTINGS,
      createWelcomeNote: false,
      pageGenerationConcurrency: 1,
      batchDelayMs: 0,
    };
    const h = createWikiEngineHarness({
      files: { [rawPath]: 'A source body for the partial-ingest regression.\n' },
      settings,
      llmResponses: [
        JSON.stringify(analysis),
        emptyExtraction,
        // Source-lemma classification runs once between extraction and the
        // source-page generation call. Its response is intentionally
        // non-JSON; the engine keeps the source basename in that case.
        summaryPage,
        summaryPage,
        invalidEntityPage,
        invalidEntityPage,
      ],
    });

    await expect(h.engine.ingestSource(sourceFile(rawPath))).resolves.toBeUndefined();

    const report = h.reports.at(-1);
    expect(report?.failedItems).toHaveLength(1);
    expect(report?.success).toBe(false);
    expect(report?.errorMessage).toBe('Ingestion completed with 1 failed item(s)');
    expect(h.files.has('wiki/entities/broken-entity.md')).toBe(false);
  });

  it('materializes a traceable zero-defect wiki and skips an identical re-ingest at zero cost', async () => {
    const rawPath = '10 Sources/approved/spm-operations.md';
    const groundedQuote = 'Every operational claim must remain traceable to its source.';
    const sourceBody = `# Operations note\n\n${groundedQuote}\n`;
    const analysis = {
      source_title: 'Evidence-bound operations',
      summary: 'A compact operating rule for traceable work.',
      key_points: ['Claims retain source provenance.'],
      entities: [{
        name: 'SPM Operations',
        type: 'organization',
        summary: 'The operating organization applying the rule.',
        aliases: ['Operations team'],
        mentions_in_source: [groundedQuote],
        mentions_with_provenance: [groundedQuote],
        related_entities: [],
        related_concepts: ['Evidence Bound Practice'],
      }],
      concepts: [{
        name: 'Evidence Bound Practice',
        type: 'method',
        summary: 'A method that keeps claims tied to evidence.',
        aliases: ['Traceable practice'],
        mentions_in_source: [groundedQuote],
        mentions_with_provenance: [groundedQuote],
        related_entities: ['SPM Operations'],
        related_concepts: [],
      }],
      related_pages: [],
      contradictions: [],
      created_pages: [],
      updated_pages: [],
    };
    const emptyExtraction = JSON.stringify({ entities: [], concepts: [] });
    const summaryPage = `---
type: source
tags:
  - notes
aliases:
  - "Evidence operations note"
---

# Evidence-bound operations

## Summary
Traceable work.

## Entities
- \`[[entities/spm-operations|SPM Operations]]\`

## Concepts
- \`[[concepts/evidence-bound-practice|Evidence Bound Practice]]\`
`;
    const entityPage = `---
type: entity
tags:
  - organization
aliases:
  - "Operations team"
---

# SPM Operations

## Description
The operating organization.

## Related Concepts
- [[concepts/evidence-bound-practice|Evidence Bound Practice]]
- [[concepts/fabricated-target|Fabricated target]]
`;
    const conceptPage = `---
type: concept
tags:
  - method
aliases:
  - "Traceable practice"
---

# Evidence Bound Practice

## Description
A traceable method.

## Related Entities
- [[entities/spm-operations|SPM Operations]]
`;
    const settings = {
      ...DEFAULT_SETTINGS,
      createWelcomeNote: false,
      pageGenerationConcurrency: 1,
      batchDelayMs: 0,
    };
    const h = createWikiEngineHarness({
      files: { [rawPath]: sourceBody },
      settings,
      // Source analysis is iterative: the empty second response closes it.
      // Summary, entity, and concept generation follow in that order.
      llmResponses: [JSON.stringify(analysis), emptyExtraction, summaryPage, entityPage, conceptPage],
    });

    await expect(h.engine.ingestSource(sourceFile(rawPath))).resolves.toBeUndefined();
    const report = h.reports.at(-1);
    expect(report?.skipped).not.toBe(true);
    expect(report?.failedItems ?? []).toEqual([]);

    const sourcePagePath = [...h.files.keys()].find(path => path.startsWith('wiki/sources/'));
    expect(sourcePagePath).toBeDefined();
    expect(h.files.has('wiki/entities/spm-operations.md')).toBe(true);
    expect(h.files.has('wiki/concepts/evidence-bound-practice.md')).toBe(true);
    const sourcePage = h.files.get(sourcePagePath ?? '') ?? '';
    expect(sourcePage).toContain('## Generated Pages');
    expect(sourcePage).toContain('- [[entities/spm-operations]]');
    expect(sourcePage).toContain('- [[concepts/evidence-bound-practice]]');

    const entityContent = h.files.get('wiki/entities/spm-operations.md') ?? '';
    expect(entityContent).toContain(groundedQuote);
    expect(entityContent).toContain(`[[${rawPath.replace(/\.md$/i, '')}`);
    expect(entityContent).not.toContain('[[concepts/fabricated-target');
    expect(entityContent).toContain('Fabricated target');

    const lintCtx: LintPhaseContext = {
      app: h.app,
      settings,
      llmClient: () => null,
      wikiEngine: h.engine,
      checkCancelled: () => {},
      stageNotice: null,
      totalPages: 0,
      buildSystemPrompt: async () => undefined,
    };
    const prepared = await runPreparationPhase(lintCtx);
    const graph = buildGraphFromContent(
      [...prepared.pageMap.values()].map(page => ({ path: page.path, content: page.content })),
      new Set(prepared.pageMap.keys()),
      settings.wikiFolder,
    );
    const findings = runProgrammaticPhase(lintCtx, { ...prepared, graph });

    expect(findings.deadLinks).toEqual([]);
    expect(findings.ungroundedQuotes).toEqual([]);
    expect(findings.tagViolations).toEqual([]);
    expect(findings.aliasDeficientPages).toEqual([]);
    expect(findings.orphans).toEqual([]);
    expect(findings.pollutedPages).toEqual([]);

    const callsAfterFirstIngest = h.stats.llmCalls;
    await expect(h.engine.ingestSource(sourceFile(rawPath))).resolves.toBeUndefined();
    expect(h.reports.at(-1)?.skipped).toBe(true);
    expect(h.stats.llmCalls).toBe(callsAfterFirstIngest);
  });
});
