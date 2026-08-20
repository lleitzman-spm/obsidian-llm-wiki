import { describe, expect, it, vi } from 'vitest';
import {
  HeadlessProviderAdapter,
  MissingAuthorizedRuntimeIdentityError,
  getProviderAttempts,
  type AuthorizedRuntimeIdentity,
  type HeadlessProviderClient,
} from '../../../../../tools/llm-wiki-cli/src/headless/provider';

const identity: AuthorizedRuntimeIdentity = {
  provider: 'openai-codex',
  kind: 'authorized-runtime',
  id: 'worker-runtime-1',
  authorize: vi.fn(),
};

function factoryFor(client: HeadlessProviderClient) {
  return {
    createClient: vi.fn(() => client),
  };
}

describe('HeadlessProviderAdapter', () => {
  it('fails closed for openai-codex without an injected authorized runtime identity', () => {
    expect(() => new HeadlessProviderAdapter({
      provider: 'openai-codex',
      clientFactory: factoryFor({ createMessage: vi.fn() }),
    })).toThrow(MissingAuthorizedRuntimeIdentityError);
    expect(() => new HeadlessProviderAdapter({
      provider: 'openai-codex',
      clientFactory: factoryFor({ createMessage: vi.fn() }),
    })).toThrow(/authorized runtime identity/i);
    expect(() => new HeadlessProviderAdapter({
      provider: 'openai-codex',
      identity: { provider: 'openai-codex', kind: 'metadata-only', id: 'not-authorized' },
      clientFactory: factoryFor({ createMessage: vi.fn() }),
    })).toThrow(/authorized runtime identity/i);
  });

  it('uses typed output and records the typed provider attempt with model settings', async () => {
    const createMessage = vi.fn();
    const createMessageWithOutput = vi.fn().mockResolvedValue({
      text: '{"ok":true}',
      output: { ok: true },
      outputMode: 'json_schema',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const clientFactory = factoryFor({ createMessage, createMessageWithOutput });
    const onAttempt = vi.fn();
    const adapter = new HeadlessProviderAdapter({
      provider: 'openai-codex',
      identity,
      clientFactory,
      onAttempt,
    });

    const result = await adapter.createMessage({
      model: 'gpt-5.6-luna',
      maxTokens: 700,
      task: 'extract',
      messages: [{ role: 'user', content: 'hello' }],
      output: { mode: 'json_schema', schema: { type: 'object' } },
      reasoning: { enabled: true, effort: 'high' },
      temperature: 0.1,
      topP: 0.9,
      seed: 42,
    });

    expect(result.output).toEqual({ ok: true });
    expect(createMessage).not.toHaveBeenCalled();
    expect(createMessageWithOutput).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna',
      max_tokens: 700,
      task: 'extract',
      enableThinking: true,
      reasoningEffort: 'high',
      temperature: 0.1,
      top_p: 0.9,
      seed: 42,
      response_format: { type: 'json_object', schema: { type: 'object' } },
    }));
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attempt: 1,
      method: 'createMessageWithOutput',
      status: 'succeeded',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('counts failed calls and recovered retries, including typed-output calls', async () => {
    const transient = Object.assign(new Error('busy'), { status: 429 });
    const createMessageWithOutput = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ text: 'ok', outputMode: 'json_object', finishReason: 'stop' });
    const adapter = new HeadlessProviderAdapter({
      provider: 'openai-codex',
      identity,
      clientFactory: factoryFor({ createMessage: vi.fn(), createMessageWithOutput }),
      retry: { maxAttempts: 2, delayMs: 0 },
    });

    const result = await adapter.createMessage({
      model: 'gpt-5.6-luna',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'retry' }],
      output: { mode: 'json_object', schema: { type: 'object' } },
    });

    expect(createMessageWithOutput).toHaveBeenCalledTimes(2);
    expect(result.attempts.map(attempt => attempt.status)).toEqual(['failed', 'succeeded']);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, retryable: true, error: 'busy' });
    expect(result.attempts[1]).toMatchObject({ attempt: 2, retry: true });
  });

  it('attaches all attempt evidence to a terminal provider error without replacing the provider error', async () => {
    const failure = Object.assign(new Error('down'), { status: 503 });
    const adapter = new HeadlessProviderAdapter({
      provider: 'openai-codex',
      identity,
      clientFactory: factoryFor({ createMessage: vi.fn().mockRejectedValue(failure) }),
      retry: { maxAttempts: 1 },
    });

    await expect(adapter.createMessage({
      model: 'gpt-5.6-luna',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'fail' }],
    })).rejects.toBe(failure);
    expect(getProviderAttempts(failure)).toHaveLength(1);
    expect(getProviderAttempts(failure)[0]).toMatchObject({ status: 'failed', retryable: true });
  });

  it('keeps only bounded low-risk terminal messages in attempt evidence', async () => {
    const unsafeMessages = [
      'Bearer sk-proj-super-secret-token',
      'x-api-key: arbitrary-provider-key-123456789',
      'Contact alice@example.com for access',
      'Call me at 555-867-5309',
      'Cookie: session=private-cookie-value',
      'Authorization: Basic dXNlcjpwYXNz',
      'upstream failure AKIAIOSFODNN7EXAMPLE',
      'upstream failure abcd-efgh-ijkl',
      `provider response: ${'x'.repeat(500)}`,
    ];

    for (const message of unsafeMessages) {
      const failure = Object.assign(new Error(message), { status: 400 });
      const adapter = new HeadlessProviderAdapter({
        provider: 'openai-codex',
        identity,
        clientFactory: factoryFor({ createMessage: vi.fn().mockRejectedValue(failure) }),
        retry: { maxAttempts: 1 },
      });

      await expect(adapter.createMessage({
        model: 'gpt-5.6-luna',
        maxTokens: 10,
        messages: [{ role: 'user', content: 'unsafe evidence' }],
      })).rejects.toBe(failure);
      const evidence = getProviderAttempts(failure)[0];
      expect(evidence?.error).toBe('Provider call failed');
      expect(evidence?.error).not.toContain(message);
    }
  });

  it('retains a short allowlisted provider message while preserving typed status/code metadata', async () => {
    const failure = Object.assign(new Error('upstream busy'), {
      status: 503,
      code: 'ETIMEDOUT',
      retryAfterMs: 1200,
    });
    const adapter = new HeadlessProviderAdapter({
      provider: 'openai-codex',
      identity,
      clientFactory: factoryFor({ createMessage: vi.fn().mockRejectedValue(failure) }),
      retry: { maxAttempts: 1 },
    });

    await expect(adapter.createMessage({
      model: 'gpt-5.6-luna',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'safe evidence' }],
    })).rejects.toBe(failure);
    expect(getProviderAttempts(failure)[0]).toMatchObject({
      error: 'upstream busy',
      errorCode: 'ETIMEDOUT',
      statusCode: 503,
      retryAfterMs: 1200,
      timedOut: true,
    });
  });

  it('delegates source analysis through an injected analyzer and never creates credentials', async () => {
    const analyzer = {
      analyzeSource: vi.fn().mockResolvedValue({ entities: [] }),
    };
    const clientFactory = factoryFor({ createMessage: vi.fn() });
    const adapter = new HeadlessProviderAdapter({
      provider: 'openai',
      identity: { provider: 'openai', kind: 'authorized-runtime', id: 'runtime-2', authorize: vi.fn() },
      clientFactory,
      sourceAnalyzer: analyzer,
    });

    await expect(adapter.analyzeSource({ path: 'source.md' }, { contentOverride: 'body' }))
      .resolves.toEqual({ entities: [] });
    expect(analyzer.analyzeSource).toHaveBeenCalledWith(
      { path: 'source.md' },
      { contentOverride: 'body' },
    );
    expect(clientFactory.createClient).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      identity: expect.objectContaining({ id: 'runtime-2' }),
    }));
  });
});
