import type {
  AuthorizedRuntimeIdentity,
  ProviderCallParams,
  ProviderTypedResponse,
} from '../provider';
import {
  assertCodexHostRequest,
  assertCodexHostResponse,
  assertHostJsonValue,
  CodexHostProtocolError,
  serializeHostJson,
} from './protocol';
import {
  CODEX_HOST_PROTOCOL_VERSION,
  type CodexHostBridgeOptions,
  type CodexHostCallContext,
  type CodexHostCapability,
  type CodexHostErrorCode,
  type CodexHostError,
  type CodexHostLimits,
  type CodexHostLogEvent,
  type CodexHostProviderBridgeLike,
  type CodexHostProviderClient,
  type CodexHostProviderFactory,
  type CodexHostRequest,
  type CodexHostRequestOptions,
  type CodexHostResponse,
  type HostJsonValue,
} from './types';

const DEFAULT_LIMITS: Required<CodexHostLimits> = {
  maxInFlight: 4,
  maxQueued: 64,
  minIntervalMs: 0,
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
};

const ERROR_MESSAGES: Record<string, string> = {
  ABORTED: 'Codex host call cancelled',
  AUTHORIZATION_REQUIRED: 'Codex host authorization is unavailable',
  CAPACITY_EXHAUSTED: 'Codex host capacity is exhausted',
  HOST_PROTOCOL_ERROR: 'Codex host returned an invalid response',
  HOST_TRANSPORT: 'Codex host transport failed',
  INVALID_REQUEST: 'Codex host rejected the request',
  MODEL_UNAVAILABLE: 'Codex host model is unavailable',
  RATE_LIMITED: 'Codex host rate limited the request',
  TIMEOUT: 'Codex host request timed out',
  UPSTREAM_ERROR: 'Codex host upstream failed',
};

type HostErrorLike = {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly retryAfterMs?: unknown;
  readonly retry_after_ms?: unknown;
};

/** A provider error with no raw host payload or message attached. */
export class CodexHostProviderError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(ERROR_MESSAGES[code] ?? 'Codex host call failed');
    this.name = 'CodexHostProviderError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export class CodexHostQueueFullError extends CodexHostProviderError {
  constructor() {
    super('CAPACITY_EXHAUSTED', { status: 429 });
    this.name = 'CodexHostQueueFullError';
  }
}

export class CodexHostCancelledError extends CodexHostProviderError {
  constructor() {
    super('ABORTED', { status: 499 });
    this.name = 'CodexHostCancelledError';
  }
}

function safeLog(onEvent: CodexHostBridgeOptions['onEvent'], event: CodexHostLogEvent): void {
  try {
    onEvent?.(event);
  } catch {
    // Logging is observability only and can never change provider semantics.
  }
}

function assertPositiveLimit(value: number, name: string, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
}

function normalizeLimits(limits: CodexHostLimits | undefined): Required<CodexHostLimits> {
  const result = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  assertPositiveLimit(result.maxInFlight, 'maxInFlight');
  assertPositiveLimit(result.maxQueued, 'maxQueued', true);
  if (!Number.isFinite(result.minIntervalMs) || result.minIntervalMs < 0 || result.minIntervalMs > 60_000) throw new RangeError('minIntervalMs must be between 0 and 60000');
  assertPositiveLimit(result.maxRequestBytes, 'maxRequestBytes');
  assertPositiveLimit(result.maxResponseBytes, 'maxResponseBytes');
  return result;
}

function abortError(signal: AbortSignal): CodexHostCancelledError {
  if (!signal.aborted) return new CodexHostCancelledError();
  return new CodexHostCancelledError();
}

interface QueueWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  onAbort?: () => void;
  removed: boolean;
}

/** Small fair gate shared by all workers created from one host bridge. */
class BoundedStartGate {
  private active = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending: QueueWaiter[] = [];

  constructor(private readonly limits: Required<CodexHostLimits>) {}

  get activeCount(): number {
    return this.active;
  }

  get queueDepth(): number {
    return this.pending.length;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.active >= this.limits.maxInFlight && this.pending.length >= this.limits.maxQueued) {
      return Promise.reject(new CodexHostQueueFullError());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, signal, removed: false };
      const onAbort = () => {
        waiter.removed = true;
        const index = this.pending.indexOf(waiter);
        if (index >= 0) this.pending.splice(index, 1);
        reject(abortError(signal));
      };
      waiter.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined || this.active >= this.limits.maxInFlight) return;
    while (this.active < this.limits.maxInFlight && this.pending.length > 0) {
      const waiter = this.pending.shift();
      if (!waiter || waiter.removed) continue;
      if (waiter.signal.aborted) {
        waiter.onAbort && waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      const delay = Math.max(0, this.lastStart + this.limits.minIntervalMs - Date.now());
      if (delay > 0) {
        this.pending.unshift(waiter);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, delay);
        return;
      }
      this.active += 1;
      this.lastStart = Date.now();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.pump();
      };
      if (waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(release);
    }
  }
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof CodexHostCancelledError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR' || candidate.code === 'ABORTED';
}

function knownHostCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return [
    'ABORTED', 'AUTHORIZATION_REQUIRED', 'CAPACITY_EXHAUSTED', 'HOST_PROTOCOL_ERROR',
    'HOST_TRANSPORT', 'INVALID_REQUEST', 'MODEL_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT',
    'UPSTREAM_ERROR',
  ].includes(value) ? value : undefined;
}

function hostError(error: unknown): CodexHostProviderError {
  if (error instanceof CodexHostProviderError) return error;
  if (error instanceof CodexHostProtocolError) return new CodexHostProviderError('HOST_PROTOCOL_ERROR', { status: 502 });
  if (isAbortLike(error)) return new CodexHostCancelledError();
  const candidate = typeof error === 'object' && error !== null ? error as HostErrorLike : {};
  const code = knownHostCode(candidate.code) ?? 'HOST_TRANSPORT';
  const rawStatus = typeof candidate.status === 'number' && Number.isSafeInteger(candidate.status)
    && candidate.status >= 100 && candidate.status <= 599 ? candidate.status : undefined;
  const rawRetryAfter = typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs
    : (typeof candidate.retry_after_ms === 'number' ? candidate.retry_after_ms : undefined);
  const retryAfterMs = rawRetryAfter !== undefined && Number.isSafeInteger(rawRetryAfter) && rawRetryAfter >= 0 && rawRetryAfter <= 60_000
    ? rawRetryAfter : undefined;
  const status = code === 'HOST_TRANSPORT' ? 503 : rawStatus;
  return new CodexHostProviderError(code, { ...(status !== undefined ? { status } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}

function jsonValue(value: unknown, label: string): HostJsonValue {
  assertHostJsonValue(value, label);
  return value;
}

function jsonContent(value: unknown, label: string): string | readonly HostJsonValue[] {
  if (!Array.isArray(value)) throw new CodexHostProtocolError(`${label} must be a JSON array`);
  assertHostJsonValue(value, label);
  return value as readonly HostJsonValue[];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) value.forEach(child => { deepFreeze(child, seen); });
  else Object.values(value as Record<string, unknown>).forEach(child => deepFreeze(child, seen));
  return Object.freeze(value);
}

function defaultRequestId(): string {
  requestSequence += 1;
  return `codex-${requestSequence.toString(36)}`;
}

let requestSequence = 0;

function identityMatches(expected: AuthorizedRuntimeIdentity | undefined, actual: AuthorizedRuntimeIdentity | undefined): boolean {
  if (!expected || !actual) return true;
  return expected.provider === actual.provider && expected.id === actual.id;
}

/**
 * Converts an injected Codex/Luna host capability into the provider-neutral
 * client expected by the headless adapter. No SDK, SecretStorage, or env
 * lookup occurs here.
 */
export class CodexHostProviderBridge implements CodexHostProviderBridgeLike {
  readonly capability: CodexHostCapability;
  readonly identity?: AuthorizedRuntimeIdentity;
  readonly client: CodexHostProviderClient;
  private readonly context: CodexHostCallContext;
  private readonly limits: Required<CodexHostLimits>;
  private readonly gate: BoundedStartGate;
  private readonly requestIdFactory: () => string;
  private readonly now: () => number;
  private readonly onEvent?: CodexHostBridgeOptions['onEvent'];

  constructor(options: CodexHostBridgeOptions) {
    this.capability = options.capability;
    this.context = options.context;
    this.identity = options.identity;
    this.limits = normalizeLimits(options.limits);
    this.gate = new BoundedStartGate(this.limits);
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestId;
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;
    if (!this.capability || typeof this.capability.invoke !== 'function') throw new TypeError('A Codex host capability must be injected');
    this.client = {
      createMessage: params => this.createMessage(params),
      createMessageWithOutput: <T>(params: ProviderCallParams) => this.call(params) as Promise<ProviderTypedResponse<T>>,
      call: (params, callOptions) => this.call(params, callOptions),
    };
  }

  get capacity(): number | Promise<number> {
    const value = this.capability.capacity?.();
    return value ?? this.limits.maxInFlight;
  }

  async call(params: ProviderCallParams, options: CodexHostRequestOptions = {}): Promise<ProviderTypedResponse<HostJsonValue>> {
    const request = this.toRequest(params, options);
    const serializedRequest = serializeHostJson(request, this.limits.maxRequestBytes, 'request');
    const signal = options.signal ?? new AbortController().signal;
    const requestId = request.request_id;
    if (signal.aborted) {
      safeLog(this.onEvent, { type: 'rejected', request_id: requestId, provider: 'openai-codex', model: request.model, reason: 'cancelled' });
      throw abortError(signal);
    }
    safeLog(this.onEvent, {
      type: 'queued', request_id: requestId, provider: 'openai-codex', model: request.model, queue_depth: this.gate.queueDepth,
    });
    let release: (() => void) | undefined;
    try {
      release = await this.gate.acquire(signal);
    } catch (error) {
      safeLog(this.onEvent, {
        type: 'rejected', request_id: requestId, provider: 'openai-codex', model: request.model,
        reason: error instanceof CodexHostQueueFullError ? 'queue-full' : 'cancelled',
      });
      throw error;
    }
    const started = this.now();
    safeLog(this.onEvent, {
      type: 'started', request_id: requestId, provider: 'openai-codex', model: request.model,
      request_bytes: serializedRequest.bytes, in_flight: this.gate.activeCount,
    });
    let onAbort: (() => void) | undefined;
    try {
      onAbort = () => {
        try {
          const cancellation = this.capability.cancel?.(requestId);
          if (cancellation) void cancellation.catch(() => undefined);
        } catch {
          // Best effort only; the signal remains authoritative for cooperative hosts.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let response: CodexHostResponse;
      try {
        response = await this.capability.invoke(deepFreeze(request), { signal });
      } catch (error) {
        const normalized = hostError(error);
        safeLog(this.onEvent, {
          type: 'completed', request_id: requestId, provider: 'openai-codex', model: request.model,
          status: 'transport-error', elapsed_ms: Math.max(0, this.now() - started), error_code: normalized.code as CodexHostErrorCode,
        });
        throw normalized;
      }
      if (signal.aborted) throw abortError(signal);
      try {
        assertCodexHostResponse(response, requestId);
        const serializedResponse = serializeHostJson(response, this.limits.maxResponseBytes, 'response');
        safeLog(this.onEvent, {
          type: 'completed', request_id: requestId, provider: 'openai-codex', model: request.model,
          status: response.status, elapsed_ms: Math.max(0, this.now() - started), response_bytes: serializedResponse.bytes,
          ...(response.error ? { error_code: response.error.code } : {}),
        });
        if (response.status !== 'succeeded') throw hostResponseError(response);
        return {
          text: response.text ?? '',
          ...(response.output !== undefined ? { output: response.output } : {}),
          outputMode: response.output_mode,
          finishReason: response.finish_reason,
          ...(response.usage ? { usage: response.usage } : {}),
        };
      } catch (error) {
        if (error instanceof CodexHostProviderError) throw error;
        throw hostError(error);
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      release();
    }
  }

  private async createMessage(params: ProviderCallParams): Promise<string> {
    const response = await this.call(params);
    return response.text;
  }

  private toRequest(params: ProviderCallParams, options: CodexHostRequestOptions): CodexHostRequest {
    const runId = options.runId ?? this.context.runId;
    const workerId = options.workerId ?? this.context.workerId;
    const request: CodexHostRequest = {
      protocol_version: CODEX_HOST_PROTOCOL_VERSION,
      request_id: options.requestId ?? this.requestIdFactory(),
      run_id: runId,
      worker_id: workerId,
      provider: 'openai-codex',
      model: params.model,
      max_tokens: params.max_tokens,
      ...(params.maxTokensPerCall !== undefined ? { max_tokens_per_call: params.maxTokensPerCall } : {}),
      ...(params.system !== undefined ? { system: params.system } : {}),
      messages: params.messages.map((message, index) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : jsonContent(message.content, `messages[${index}].content`),
      })),
      ...(params.task !== undefined ? { task: params.task } : {}),
      ...(params.response_format ? {
        response_format: {
          type: 'json_object' as const,
          ...(params.response_format.schema !== undefined ? { schema: jsonValue(params.response_format.schema, 'response_format.schema') } : {}),
        },
      } : {}),
      ...(params.outputModeOverride !== undefined ? { output_mode: params.outputModeOverride } : {}),
      ...(params.enableThinking !== undefined ? { enable_thinking: params.enableThinking } : {}),
      ...(params.reasoningEffort !== undefined ? { reasoning_effort: params.reasoningEffort } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
    };
    try {
      assertCodexHostRequest(request);
    } catch (error) {
      throw error instanceof CodexHostProtocolError ? error : new CodexHostProtocolError();
    }
    return request;
  }
}

function hostResponseError(response: CodexHostResponse): CodexHostProviderError {
  const error: CodexHostError = response.error ?? { code: 'HOST_PROTOCOL_ERROR', retryable: false, status: 502 };
  // Do not expose a 5xx status to the legacy adapter when the host explicitly
  // says the operation is not retryable; the adapter's default policy uses
  // 5xx as a retry signal.
  const status = error.retryable
    ? (error.status ?? (error.code === 'RATE_LIMITED' ? 429 : error.code === 'TIMEOUT' ? 504 : 503))
    : (error.status !== undefined && error.status < 500 ? error.status : undefined);
  return new CodexHostProviderError(error.code, {
    ...(status !== undefined ? { status } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  });
}

export function createCodexHostProviderFactory(options: CodexHostBridgeOptions): CodexHostProviderFactory {
  const bridge = new CodexHostProviderBridge(options);
  const factory: CodexHostProviderFactory = {
    bridge,
    createClient(input) {
      if (input.provider !== 'openai-codex') throw new CodexHostProviderError('INVALID_REQUEST', { status: 400 });
      if (!identityMatches(bridge.identity, input.identity)) throw new CodexHostProviderError('AUTHORIZATION_REQUIRED', { status: 401 });
      return bridge.client;
    },
  };
  return factory;
}

export function createCodexHostIdentity(options: {
  readonly id: string;
  readonly kind?: string;
  readonly authorize: NonNullable<AuthorizedRuntimeIdentity['authorize']>;
}): AuthorizedRuntimeIdentity {
  return {
    provider: 'openai-codex',
    kind: options.kind ?? 'authorized-codex-host',
    id: options.id,
    authorize: options.authorize,
  };
}
