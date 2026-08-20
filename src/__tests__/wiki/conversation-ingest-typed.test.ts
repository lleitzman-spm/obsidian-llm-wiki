// typed-output migration tests for conversation-ingest extraction (Commit 4).
//
// The ConversationIngestor class wires many collaborators (PageFactory,
// orchestrator, wikiEngine) so direct unit testing is heavy. We test the
// migration in two complementary ways:
//   1. Schema-on-wire: spy on the mock client's createMessage, confirm the
//      analysis call carries response_format.schema = SourceAnalysisLLMSchema.
//   2. Typed path: monkey-patch createMessageWithOutput, confirm it is invoked
//      when the client implements it (legacy Anthropic/OpenAI/Codex fall back
//      to createMessage).

import { describe, it, expect, vi } from 'vitest';
import { ConversationIngestor } from '../../wiki/conversation-ingest';
import { SourceAnalysisLLMSchema, ConversationDedupStatusLLMSchema } from '../../llm-sdk/output-schemas';

// Minimal stub for the orchestrator + WikiEngine required by the
// ConversationIngestor constructor. We only exercise the extraction LLM
// call, so most collaborators can return empty values.
function makeContextStub(llmClient: unknown, opts: { indexMd?: string | null } = {}) {
  const ctx = {
    app: { vault: { getMarkdownFiles: () => [] } } as never,
    settings: {
      provider: 'mock',
      language: 'en',
      wikiLanguage: 'English',
      wikiFolder: 'wiki',
      slugCase: 'lower',
      disableThinking: false,
      model: 'mock-model',
    },
    getClient: () => llmClient,
    // Default: index.md absent (skip dedup). Tests that want to exercise
    // save-dedup pass `indexMd: '...'` to force checkDedup → LLM call.
    tryReadFile: async (_path: string) => opts.indexMd ?? null,
    buildSystemPrompt: async () => undefined,
    onProgress: undefined,
    onDone: undefined,
    getExistingWikiPages: async () => [],
    getSchemaContext: async () => undefined,
  } as never;
  const orch = {
    apiDelay: async () => {},
    ensureWikiStructure: async () => {},
    generateIndex: async () => {},
    updateLog: async () => {},
    getExistingWikiPages: async () => [],
  } as never;
  const pageFactory = {
    createOrUpdateEntityPage: async () => ({ path: '', created: true }),
    createOrUpdateConceptPage: async () => ({ path: '', created: true }),
  } as never;
  const wikiEngine = {} as never;
  return { ctx, orch, pageFactory, wikiEngine };
}

describe('ConversationIngestor — typed-output migration (#443 expanded scope)', () => {
  it('passes SourceAnalysisLLMSchema on the wire via response_format.schema (legacy client)', async () => {
    const spy = vi.fn(async (_params: unknown) => JSON.stringify({
      source_title: 'A conversation',
      summary: 'Conversation about X.',
      entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      concepts: [{ name: 'TopicA', type: 'theory', summary: 'A topic.', mentions_in_source: [], related_concepts: [] }],
    }));
    const client = { createMessage: spy };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // The stub's downstream collaborators throw / no-op; we only care that
      // the analysis LLM call was made with the schema attached.
    }

    expect(spy).toHaveBeenCalled();
    // The first call (conversation-extract) must carry the schema.
    const extractCall = spy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-extract'
    );
    expect(extractCall).toBeDefined();
    const args = extractCall![0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(SourceAnalysisLLMSchema);
  });

  it('uses createMessageWithOutput when the client implements it (Tier 0 path)', async () => {
    const legacySpy = vi.fn(async (_params: unknown) => '{"source_title":"x","entities":[],"concepts":[]}');
    const typedResult = {
      text: JSON.stringify({
        source_title: 'A conversation',
        summary: 'Conversation about X.',
        entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
        concepts: [],
      }),
      output: {
        source_title: 'A conversation',
        summary: 'Conversation about X.',
        entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      },
      outputMode: 'json_schema',
      finishReason: 'stop',
    };
    const typedSpy = vi.fn(async (_params: unknown) => typedResult);
    const client = {
      createMessage: legacySpy,
      createMessageWithOutput: typedSpy,
    };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(typedSpy).toHaveBeenCalled();
    // conversation-extract went through typed path; free-text callers
    // (summaryPageContent, free-form markdown body generation) remain
    // on legacy createMessage + cleanMarkdownResponse (out of schema
    // migration scope per the free-text exclusion).
    expect(typedSpy.mock.calls.some(c => (c[0] as { task?: string }).task === 'conversation-extract')).toBe(true);
    const extractCall = typedSpy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-extract'
    );
    expect(extractCall).toBeDefined();
  });

  it('falls back to createMessage + parseJsonResponse when client lacks createMessageWithOutput', async () => {
    const legacySpy = vi.fn(async (_params: unknown) => JSON.stringify({
      source_title: 'A conversation',
      summary: 'Conversation about X.',
      entities: [{ name: 'Alice', type: 'person', summary: 'A person.', mentions_in_source: [] }],
      concepts: [],
    }));
    const client = { createMessage: legacySpy }; // no createMessageWithOutput
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client);

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'Sample conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(legacySpy).toHaveBeenCalled();
  });
});

// === Commit 5 — save-dedup migration ===
// The save-dedup call runs before extract when an existing wiki index is
// present. It asks the LLM whether this conversation is already covered.
// Migrating it eliminates the silent-success + parse-failure corner where
// dedupStatus returns 'entirely_new' (fallback) instead of the model's
// actual verdict on cloud cohort.
describe('ConversationIngestor.checkDedup - typed-output migration', () => {
  it('passes ConversationDedupStatusLLMSchema on the wire (legacy client)', async () => {
    const spy = vi.fn(async (_params: unknown) => '{"status":"entirely_new"}');
    const client = { createMessage: spy };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client, {
      indexMd: '# Existing Wiki\n\n- entities: [Alice]\n',
    });

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'A conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(spy).toHaveBeenCalled();
    const dedupCall = spy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-save-dedup'
    );
    expect(dedupCall).toBeDefined();
    const args = dedupCall![0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(ConversationDedupStatusLLMSchema);
  });

  it('uses createMessageWithOutput for save-dedup when client implements it', async () => {
    const typedSpy = vi.fn(async (_params: unknown) => ({
      text: '{"status":"partial_overlap"}',
      output: { status: 'partial_overlap' },
      outputMode: 'json_schema',
      finishReason: 'stop',
    }));
    const legacySpy = vi.fn();
    const client = { createMessage: legacySpy, createMessageWithOutput: typedSpy };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client, {
      indexMd: '# Existing Wiki\n\n- entities: [Alice]\n',
    });

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'A conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(typedSpy).toHaveBeenCalled();
    const dedupCall = typedSpy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'conversation-save-dedup'
    );
    expect(dedupCall).toBeDefined();
  });

  it('falls back to createMessage when client lacks createMessageWithOutput', async () => {
    const legacySpy = vi.fn(async (_params: unknown) => '{"status":"entirely_new"}');
    const client = { createMessage: legacySpy };
    const { ctx, orch, pageFactory, wikiEngine } = makeContextStub(client, {
      indexMd: '# Existing Wiki\n\n- entities: [Alice]\n',
    });

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({ messages: [{ role: 'user', content: 'A conversation', timestamp: Date.now() }] });
    } catch {
      // ignore downstream stub failures
    }

    expect(legacySpy).toHaveBeenCalled();
  });

  it('forwards the active signal to dedup, extraction, repair, and summary calls', async () => {
    const controller = new AbortController();
    const calls: Array<{ task?: string; abortSignal?: AbortSignal }> = [];
    const validAnalysis = JSON.stringify({
      source_title: 'A conversation',
      summary: 'Conversation about X.',
      entities: [],
      concepts: [],
    });
    const client = {
      createMessage: vi.fn(async (params: { task?: string; abortSignal?: AbortSignal }) => {
        calls.push(params);
        if (params.task === 'conversation-save-dedup') return '{"status":"entirely_new"}';
        if (params.task === 'conversation-extract') return '{"source_title":"broken","summary":}';
        if (params.task === 'conversation-extract-retry') return validAnalysis;
        return '# Summary';
      }),
    };
    const { ctx, orch, pageFactory } = makeContextStub(client, {
      indexMd: '# Existing Wiki\n',
    });
    (ctx as { abortSignal?: AbortSignal }).abortSignal = controller.signal;

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    try {
      await ingestor.ingestConversation({
        messages: [{ role: 'user', content: 'A conversation', timestamp: Date.now() }],
      });
    } catch {
      // The minimal context intentionally omits vault-write collaborators;
      // all signal-bearing calls occur before that downstream boundary.
    }

    expect(calls.map(call => call.task)).toEqual([
      'conversation-save-dedup',
      'conversation-extract',
      'conversation-extract-retry',
      'conversation-page',
    ]);
    expect(calls.every(call => call.abortSignal === controller.signal)).toBe(true);
  });

  it('does not swallow an abort from the conversation dedup call', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const client = {
      createMessage: vi.fn(async () => { throw abort; }),
    };
    const { ctx, orch, pageFactory } = makeContextStub(client, {
      indexMd: '# Existing Wiki\n',
    });
    (ctx as { abortSignal?: AbortSignal }).abortSignal = controller.signal;

    const ingestor = new ConversationIngestor(ctx, pageFactory, orch);
    await expect(ingestor.ingestConversation({
      messages: [{ role: 'user', content: 'A conversation', timestamp: Date.now() }],
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
