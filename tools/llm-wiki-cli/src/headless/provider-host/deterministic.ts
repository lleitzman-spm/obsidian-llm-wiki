import {
  CODEX_HOST_PROTOCOL_VERSION,
  type CodexHostCapability,
  type CodexHostResponse,
  type DeterministicCodexHost,
  type DeterministicCodexHostOptions,
} from './types';

function defaultResponse(request: Parameters<NonNullable<DeterministicCodexHostOptions['handler']>>[0]): CodexHostResponse {
  const structured = request.output_mode === 'json_object' || request.output_mode === 'json_schema';
  return {
    protocol_version: CODEX_HOST_PROTOCOL_VERSION,
    request_id: request.request_id,
    status: 'succeeded',
    text: structured ? '{}' : 'deterministic codex host response',
    ...(structured ? { output: {} } : {}),
    output_mode: request.output_mode ?? 'text_prompt',
    finish_reason: 'stop',
  };
}

/**
 * In-memory host for protocol tests. It deliberately has no environment,
 * filesystem, SDK, SecretStorage, or network access.
 */
export function createDeterministicCodexHost(options: DeterministicCodexHostOptions = {}): DeterministicCodexHost {
  const transcript: Parameters<NonNullable<DeterministicCodexHostOptions['handler']>>[0][] = [];
  const cancelled = new Set<string>();
  const handler = options.handler ?? (request => defaultResponse(request));
  const capability: CodexHostCapability = {
    invoke: async (request, invocationOptions) => {
      if (invocationOptions.signal.aborted || cancelled.has(request.request_id)) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      transcript.push(request);
      return handler(request, invocationOptions);
    },
    cancel: requestId => {
      cancelled.add(requestId);
    },
  };
  return {
    capability,
    get requests() {
      return transcript.slice();
    },
    reset: () => {
      transcript.length = 0;
      cancelled.clear();
    },
  };
}

