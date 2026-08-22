import { describe, expect, it, vi } from 'vitest';
import { ConversationIngestor, type ConversationOrchestration } from '../../wiki/conversation-ingest';

function makeConversationFixture(options: { withWriteGate?: boolean } = {}) {
  const files = new Map<string, string>();
  // Occupy the failed candidate slug to prove final reconciliation does not
  // mistake stale preflight state for the page written by this run.
  files.set('wiki/concepts/rejected-concept.md', 'Stale page from an earlier run.');
  const writes: string[] = [];
  const settings = {
    provider: 'mock', language: 'en', wikiLanguage: 'English', wikiFolder: 'wiki',
    slugCase: 'lower', disableThinking: false, model: 'mock-model',
  } as never;
  const client = {
    createMessage: vi.fn(async (params: { task?: string }) => {
      if (params.task === 'conversation-extract') {
        return JSON.stringify({
          source_title: 'Integrity Conversation', summary: 'A useful conversation',
          // A model-supplied path list must never become provenance.
          created_pages: ['wiki/concepts/fabricated.md'],
          updated_pages: ['wiki/entities/stale.md'],
          entities: [{ name: 'Good Entity', type: 'person', summary: 'A real entity', mentions_in_source: [] }],
          concepts: [{ name: 'Rejected Concept', type: 'term', summary: 'Will fail', mentions_in_source: [], related_concepts: [] }],
        });
      }
      if (params.task === 'conversation-page') {
        return [
          'Live [[entities/good-entity|Good]], [[concepts/rejected-concept|Rejected]], and [[concepts/fabricated|Fabricated]].',
          '',
          'Code example `[[concepts/fabricated|Fabricated code target]]`.',
        ].join('\n');
      }
      return '{}';
    }),
  };
  const ctx = {
    app: {
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(path => ({
          path, basename: path.split('/').pop()?.replace(/\.md$/i, '') ?? path,
        })),
      },
    },
    settings,
    getClient: () => client,
    createOrUpdateFile: vi.fn(async (path: string, content: string) => {
      writes.push(path);
      files.set(path, content);
    }),
    tryReadFile: vi.fn(async (path: string) => files.get(path) ?? null),
    withPathWriteLock: async <T>(_path: string, operation: () => Promise<T>) => operation(),
    getExistingWikiPages: async () => [...files.entries()]
      .filter(([path]) => path.startsWith('wiki/'))
      .map(([path]) => ({ path, title: path.split('/').pop()?.replace(/\.md$/i, '') ?? path, wikiLink: path })),
    deleteFile: async () => {},
    buildSystemPrompt: async () => undefined,
    getSchemaContext: async () => undefined,
    getSectionLabels: () => ({}),
    onProgress: undefined,
    onDone: undefined,
  } as never;
  const orch = {
    ensureWikiStructure: async () => {},
    apiDelay: async () => {},
    generateIndex: vi.fn(async () => {}),
    updateLog: vi.fn(async () => {}),
    ...(options.withWriteGate ? {
      withWriteGate: async <T>(_paths: readonly string[], operation: (held: never) => Promise<T>) =>
        operation({} as never),
    } : {}),
  } as unknown as ConversationOrchestration;
  const pageFactory = {
    createOrUpdateEntityPage: vi.fn(async () => {
      const path = 'wiki/entities/good-entity.md';
      files.set(path, 'Good page [[concepts/fabricated]].');
      return { path, created: true };
    }),
    createOrUpdateConceptPage: vi.fn(async () => {
      throw new Error('simulated concept write failure');
    }),
  } as never;
  return { ctx, orch, pageFactory, files, writes };
}

describe('ConversationIngestor integrity boundaries', () => {
  it('strips hostile live links, preserves code examples, and reports partial failure', async () => {
    const fixture = makeConversationFixture();
    const ingestor = new ConversationIngestor(fixture.ctx, fixture.pageFactory, fixture.orch);

    const report = await ingestor.ingestConversation({
      messages: [{ role: 'user', content: 'save this', timestamp: Date.now() }],
    });

    expect(report.success).toBe(false);
    expect(report.failedItems).toEqual([{
      type: 'concept', name: 'Rejected Concept', reason: 'simulated concept write failure',
    }]);
    expect(report.createdPages).toEqual(['wiki/sources/integrity-conversation.md', 'wiki/entities/good-entity.md']);
    expect(report.createdPages).not.toContain('wiki/concepts/fabricated.md');

    const summary = fixture.files.get('wiki/sources/integrity-conversation.md') ?? '';
    expect(summary).toContain('[[entities/good-entity|Good]]');
    expect(summary).not.toContain('[[concepts/fabricated|Fabricated]]');
    expect(summary).not.toContain('[[concepts/rejected-concept|Rejected]]');
    expect(summary).toContain('`[[concepts/fabricated|Fabricated code target]]`');
    expect(fixture.files.get('wiki/entities/good-entity.md')).not.toContain('[[concepts/fabricated]]');
  });

  it('passes one held gate to index and log without re-entering it', async () => {
    const fixture = makeConversationFixture({ withWriteGate: true });
    const ingestor = new ConversationIngestor(fixture.ctx, fixture.pageFactory, fixture.orch);

    await ingestor.ingestConversation({
      messages: [{ role: 'user', content: 'save this', timestamp: Date.now() }],
    });

    expect(fixture.orch.generateIndex).toHaveBeenCalledWith(expect.anything());
    expect(fixture.orch.updateLog).toHaveBeenCalledWith('conversation', expect.anything(), expect.anything());
  });
});
