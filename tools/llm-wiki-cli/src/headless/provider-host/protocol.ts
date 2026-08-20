import {
  CODEX_HOST_PROTOCOL_VERSION,
  type CodexHostError,
  type CodexHostRequest,
  type CodexHostResponse,
  type HostJsonValue,
} from './types';

export class CodexHostProtocolError extends Error {
  readonly code = 'HOST_PROTOCOL_ERROR' as const;
  readonly status = 502;

  constructor(message = 'Codex host protocol validation failed') {
    super(message);
    this.name = 'CodexHostProtocolError';
  }
}

const PROVIDER_OUTPUT_MODES = new Set(['json_schema', 'json_object', 'text_prompt']);
const FINISH_REASONS = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown']);
const ERROR_CODES = new Set([
  'ABORTED',
  'AUTHORIZATION_REQUIRED',
  'CAPACITY_EXHAUSTED',
  'HOST_PROTOCOL_ERROR',
  'HOST_TRANSPORT',
  'INVALID_REQUEST',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'UPSTREAM_ERROR',
]);
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_ERROR = /^[A-Za-z0-9][A-Za-z0-9 .,;:!?()/'-]{0,159}$/;
const MAX_JSON_DEPTH = 32;
const MAX_STRING_LENGTH = 4 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key));
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function nonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function fail(detail: string): never {
  throw new CodexHostProtocolError(detail);
}

/** Check that a value is plain, finite JSON and contains no cyclic objects. */
export function assertHostJsonValue(value: unknown, label = 'value', seen = new WeakSet<object>(), depth = 0): asserts value is HostJsonValue {
  if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds maximum JSON depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) fail(`${label} string is too large`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} must contain finite numbers`);
    return;
  }
  if (typeof value !== 'object') fail(`${label} must be JSON-compatible`);
  if (seen.has(value)) fail(`${label} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertHostJsonValue(value[i], `${label}[${i}]`, seen, depth + 1);
  } else {
    if (!record(value)) fail(`${label} must contain plain objects`);
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 256) fail(`${label} contains an oversized key`);
      assertHostJsonValue(child, `${label}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

/** Serialize only after validation, so untrusted toJSON/accessors cannot cross the boundary. */
export function serializeHostJson(value: unknown, maximumBytes: number, label: string): { json: string; bytes: number } {
  assertHostJsonValue(value, label);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    fail(`${label} could not be serialized`);
  }
  if (typeof json !== 'string') fail(`${label} could not be serialized`);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maximumBytes) fail(`${label} exceeds the configured size limit`);
  return { json, bytes };
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is not a safe identifier`);
}

function assertModel(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_MODEL.test(value)) fail('model is not a safe identifier');
}

function assertMessage(value: unknown, index: number): void {
  if (!record(value) || !onlyKeys(value, ['role', 'content'])) fail(`messages[${index}] has an invalid shape`);
  if (value.role !== 'user' && value.role !== 'assistant') fail(`messages[${index}].role is invalid`);
  if (typeof value.content === 'string') {
    if (value.content.length > MAX_STRING_LENGTH) fail(`messages[${index}].content is too large`);
  } else if (Array.isArray(value.content)) {
    assertHostJsonValue(value.content, `messages[${index}].content`);
  } else {
    fail(`messages[${index}].content is invalid`);
  }
}

function assertUsage(value: unknown): void {
  if (!record(value) || !onlyKeys(value, ['inputTokens', 'outputTokens', 'totalTokens'])) fail('usage has an invalid shape');
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (value[key] !== undefined && !nonNegativeInteger(value[key], 2_000_000_000)) fail(`usage.${key} is invalid`);
  }
}

function assertError(value: unknown): asserts value is CodexHostError {
  if (!record(value) || !onlyKeys(value, ['code', 'retryable', 'status', 'retry_after_ms', 'message'])) fail('error has an invalid shape');
  if (typeof value.code !== 'string' || !ERROR_CODES.has(value.code)) fail('error.code is not allowlisted');
  if (typeof value.retryable !== 'boolean') fail('error.retryable is invalid');
  if (value.status !== undefined && !nonNegativeInteger(value.status, 599) || (typeof value.status === 'number' && value.status < 100)) fail('error.status is invalid');
  if (value.retry_after_ms !== undefined && !nonNegativeInteger(value.retry_after_ms, 60_000)) fail('error.retry_after_ms is invalid');
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 160 || !SAFE_ERROR.test(value.message))) fail('error.message is not bounded');
}

export function assertCodexHostRequest(value: unknown): asserts value is CodexHostRequest {
  if (!record(value) || !onlyKeys(value, [
    'protocol_version', 'request_id', 'run_id', 'worker_id', 'provider', 'model', 'max_tokens',
    'max_tokens_per_call', 'system', 'messages', 'task', 'response_format', 'output_mode',
    'enable_thinking', 'reasoning_effort', 'temperature', 'top_p', 'seed',
  ])) fail('request has an invalid shape');
  if (value.protocol_version !== CODEX_HOST_PROTOCOL_VERSION) fail('request protocol version is unsupported');
  assertId(value.request_id, 'request_id');
  assertId(value.run_id, 'run_id');
  assertId(value.worker_id, 'worker_id');
  if (value.provider !== 'openai-codex') fail('request provider is unsupported');
  assertModel(value.model);
  if (!positiveInteger(value.max_tokens, 2_000_000_000)) fail('max_tokens is invalid');
  if (value.max_tokens_per_call !== undefined && !positiveInteger(value.max_tokens_per_call, 2_000_000_000)) fail('max_tokens_per_call is invalid');
  if (value.system !== undefined && (typeof value.system !== 'string' || value.system.length > MAX_STRING_LENGTH)) fail('system is invalid');
  if (!Array.isArray(value.messages) || value.messages.length > 128) fail('messages is invalid');
  value.messages.forEach((message, index) => assertMessage(message, index));
  if (value.task !== undefined && (typeof value.task !== 'string' || value.task.length > 4096)) fail('task is invalid');
  if (value.response_format !== undefined) {
    if (!record(value.response_format) || !onlyKeys(value.response_format, ['type', 'schema']) || value.response_format.type !== 'json_object') fail('response_format is invalid');
    if (value.response_format.schema !== undefined) assertHostJsonValue(value.response_format.schema, 'response_format.schema');
  }
  if (value.output_mode !== undefined && (typeof value.output_mode !== 'string' || !PROVIDER_OUTPUT_MODES.has(value.output_mode))) fail('output_mode is invalid');
  if (value.enable_thinking !== undefined && typeof value.enable_thinking !== 'boolean') fail('enable_thinking is invalid');
  if (value.reasoning_effort !== undefined && (typeof value.reasoning_effort !== 'string' || !['low', 'medium', 'high'].includes(value.reasoning_effort))) fail('reasoning_effort is invalid');
  if (value.temperature !== undefined && !finiteNumber(value.temperature, 0, 10)) fail('temperature is invalid');
  if (value.top_p !== undefined && !finiteNumber(value.top_p, 0, 1)) fail('top_p is invalid');
  if (value.seed !== undefined && !Number.isSafeInteger(value.seed)) fail('seed is invalid');
}

export function assertCodexHostResponse(value: unknown, requestId?: string): asserts value is CodexHostResponse {
  if (!record(value) || !onlyKeys(value, ['protocol_version', 'request_id', 'status', 'text', 'output', 'output_mode', 'finish_reason', 'usage', 'error'])) fail('response has an invalid shape');
  if (value.protocol_version !== CODEX_HOST_PROTOCOL_VERSION) fail('response protocol version is unsupported');
  assertId(value.request_id, 'response.request_id');
  if (requestId !== undefined && value.request_id !== requestId) fail('response request_id does not match request');
  if (!['succeeded', 'failed', 'cancelled'].includes(String(value.status))) fail('response.status is invalid');
  if (typeof value.text !== 'string' && value.text !== undefined) fail('response.text is invalid');
  if (typeof value.text === 'string' && value.text.length > MAX_STRING_LENGTH) fail('response.text is too large');
  if (value.output !== undefined) assertHostJsonValue(value.output, 'response.output');
  if (typeof value.output_mode !== 'string' || !PROVIDER_OUTPUT_MODES.has(value.output_mode)) fail('response.output_mode is invalid');
  if (typeof value.finish_reason !== 'string' || !FINISH_REASONS.has(value.finish_reason)) fail('response.finish_reason is invalid');
  if (value.usage !== undefined) assertUsage(value.usage);
  if (value.error !== undefined) assertError(value.error);
  if (value.status === 'succeeded' && value.error !== undefined) fail('successful response cannot contain an error');
  if ((value.status === 'failed' || value.status === 'cancelled') && value.error === undefined) fail('failed response must contain an error');
  if (value.status === 'cancelled' && value.error?.code !== 'ABORTED') fail('cancelled response must use ABORTED');
}

export function hostErrorFromResponse(response: CodexHostResponse): CodexHostError {
  if (response.error) return response.error;
  return { code: 'HOST_PROTOCOL_ERROR', retryable: false, status: 502 };
}
