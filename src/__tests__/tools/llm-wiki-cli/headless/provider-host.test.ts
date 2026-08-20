import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallParams } from '../../../../../tools/llm-wiki-cli/src/headless/provider';
import {
  CodexHostCancelledError,
  CodexHostProviderBridge,
  CodexHostProviderError,
  CodexHostQueueFullError,
  createCodexHostIdentity,
  createCodexHostProviderFactory,
  createDeterministicCodexHost,
  type CodexHostRequest,
  type CodexHostResponse,
} from '../../../../../tools/llm-wiki-cli/src/headless/provider-host';

const identity = createCodexHostIdentity({
  id: 'codex-desktop-test',
  authorize: async () => undefined,
});

const params: ProviderCallParams = {
  model: 'gpt-5.6-luna',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'source text is transient' }],
};

function responseFor(request: CodexHostRequest, overrides: Partial<CodexHostResponse> = {}): CodexHostResponse {
  return {
    protocol_version: 'codex-host/v1',
    request_id: request.request_id,
    status: 'succeeded',
    text: 'ok',
    output_mode: request.output_mode ?? 'text_prompt',
    finish_reason: 'stop',
    ...overrides,
  };
}

describe('CodexHostProviderBridge', () => {
  it('uses only an injected capability and emits metadata without prompt or response content', async () => {
    const events: unknown[] = [];
    const host = createDeterministicCodexHost({
      handler: async request => responseFor(request, {
        text: 'response contains a secret-looking value: sk-test-not-for-logs',
      }),
    });
    const bridge = new CodexHostProviderBridge({
      capability: host.capability,
      context: { runId: 'run-1', workerId: 'worker-1' },
      identity,
      requestIdFactory: () => 'request-1',
      onEvent: event => events.push(event),
    });

    const result = await bridge.call({
      ...params,
      messages: [{ role: 'user', content: 'source text is transient and must not enter logs' }],
    });

    expect(result.text).toContain('secret-looking');
    expect(host.requests[0]).toMatchObject({
      request_id: 'request-1',
      run_id: 'run-1',
      worker_id: 'worker-1',
      provider: 'openai-codex',
    });
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain('source text is transient');
    expect(eventText).not.toContain('sk-test-not-for-logs');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'queued', request_id: 'request-1' }),
      expect.objectContaining({ type: 'started', request_id: 'request-1', request_bytes: expect.any(Number) }),
      expect.objectContaining({ type: 'completed', request_id: 'request-1', response_bytes: expect.any(Number) }),
    ]));
  });

  it('is compatible with HeadlessProviderAdapter through the injected factory', async () => {
    const host = createDeterministicCodexHost({
      handler: async request => responseFor(request, {
        output_mode: 'json_schema',
        text: '{"entity":"Luna"}',
        output: { entity: 'Luna' },
      }),
    });
    const factory = createCodexHostProviderFactory({
      capability: host.capability,
      context: { runId: 'run-2', workerId: 'worker-2' },
      identity,
    });
    const client = await factory.createClient({ provider: 'openai-codex', identity });
    const typed = await client.createMessageWithOutput!({
      ...params,
      response_format: { type: 'json_object', schema: { type: 'object' } },
      outputModeOverride: 'json_schema',
    });

    expect(typed.output).toEqual({ entity: 'Luna' });
    expect(host.requests[0]?.response_format).toEqual({ type: 'json_object', schema: { type: 'object' } });
  });

  it('fails closed on cyclic or non-JSON content before invoking the host', async () => {
    const invoke = vi.fn();
    const bridge = new CodexHostProviderBridge({
      capability: { invoke },
      context: { runId: 'run-3', workerId: 'worker-3' },
      identity,
    });
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);

    await expect(bridge.call({
      ...params,
      messages: [{ role: 'user', content: cyclic }],
    })).rejects.toThrow(/cyclic|JSON/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('bounds in-flight work and rejects beyond the configured queue', async () => {
    let active = 0;
    let peak = 0;
    const waiters: Array<() => void> = [];
    const host = {
      invoke: vi.fn(async request => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>(resolve => waiters.push(resolve));
        active -= 1;
        return responseFor(request);
      }),
    };
    const bridge = new CodexHostProviderBridge({
      capability: host,
      context: { runId: 'run-4', workerId: 'worker-4' },
      identity,
      limits: { maxInFlight: 2, maxQueued: 1 },
    });
    const calls = [0, 1, 2].map(index => bridge.call({ ...params, seed: index }));
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(2));
    const fourth = bridge.call({ ...params, seed: 3 });
    await expect(fourth).rejects.toBeInstanceOf(CodexHostQueueFullError);
    waiters.splice(0).forEach(resolve => resolve());
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(3));
    waiters.splice(0).forEach(resolve => resolve());
    await expect(Promise.all(calls.slice(0, 3))).resolves.toHaveLength(3);
    expect(peak).toBe(2);
  });

  it('cancels an active host call and invokes the host cancellation hook', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const host = {
      cancel,
      invoke: vi.fn(async (_request: CodexHostRequest, options: { signal: AbortSignal }) => new Promise<CodexHostResponse>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })),
    };
    const bridge = new CodexHostProviderBridge({
      capability: host,
      context: { runId: 'run-5', workerId: 'worker-5' },
      identity,
      requestIdFactory: () => 'cancel-me',
    });
    const call = bridge.call(params, { signal: controller.signal });
    await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(CodexHostCancelledError);
    expect(cancel).toHaveBeenCalledWith('cancel-me');
  });

  it('maps a bounded host rate-limit response to a retryable provider error', async () => {
    const host = createDeterministicCodexHost({
      handler: async request => ({
        protocol_version: 'codex-host/v1',
        request_id: request.request_id,
        status: 'failed',
        output_mode: request.output_mode ?? 'text_prompt',
        finish_reason: 'error',
        error: { code: 'RATE_LIMITED', retryable: true, status: 429, retry_after_ms: 1200 },
      }),
    });
    const bridge = new CodexHostProviderBridge({
      capability: host.capability,
      context: { runId: 'run-6', workerId: 'worker-6' },
      identity,
    });

    await expect(bridge.call(params)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 1200,
    });
    await expect(bridge.call(params)).rejects.toBeInstanceOf(CodexHostProviderError);
  });
});
