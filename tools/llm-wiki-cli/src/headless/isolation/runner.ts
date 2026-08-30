import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { DOMAINS } from '../crypto';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../preflight/hashing';
import { assertSafeCopyRoots, pathsOverlap } from '../preflight/roots';
import type { SourceInventory } from '../preflight/source-inventory';
import {
  ISOLATED_RUNNER_PROTOCOL_VERSION,
  type IsolatedChildMessage,
  type IsolatedHostMessage,
  type IsolatedJsonValue,
  type IsolatedProviderCallRequest,
  type IsolatedProviderCallResponse,
  type IsolatedProviderCapability,
  type IsolatedResourceLimit,
  type IsolatedRunnerEvent,
  type IsolatedRunnerInput,
  type IsolatedRunnerOutcome,
  type IsolatedRunnerRequest,
  type IsolatedRunnerResultMessage,
  type IsolatedRunnerResourceLimiter,
  type IsolatedRunnerRunOptions,
  type IsolatedRunnerSettingsBinding,
  type IsolatedRunnerWriterBinding,
  type IsolatedSignerCapability,
  type IsolatedSignerContext,
  type IsolatedSignerRequest,
  type IsolatedSignerResponse,
} from './types';

export type IsolatedRunnerErrorCode =
  | 'invalid-input'
  | 'unsafe-path'
  | 'protocol-error'
  | 'worker-exited'
  | 'worker-failed'
  | 'response-too-large'
  | 'timeout'
  | 'cancelled'
  | 'kill-failed'
  | 'resource-limits-unavailable'
  | 'provider-refused'
  | 'signer-refused';

export class IsolatedRunnerError extends Error {
  readonly code: IsolatedRunnerErrorCode;
  readonly details: readonly string[];

  constructor(code: IsolatedRunnerErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'IsolatedRunnerError';
    this.code = code;
    this.details = [...details];
  }
}

interface SpawnedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

type SpawnProcess = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

type KillTree = (pid: number) => void | Promise<void>;

export interface IsolatedInjectedRunnerOptions {
  /** Absolute, regular-file worker entry point. It must implement the wire protocol. */
  readonly workerScript: string;
  /** The only vault root a child receives. A live root is intentionally absent. */
  readonly copiedVaultRoot: string;
  /** Explicit artifact root; it cannot overlap the copied vault root. */
  readonly artifactRoot: string;
  readonly syncRoots?: readonly string[];
  readonly workerId: string;
  readonly provider?: IsolatedProviderCapability;
  readonly signer?: IsolatedSignerCapability;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly resourceLimits?: IsolatedResourceLimit;
  /** Required whenever memory/cpu limits are requested. */
  readonly resourceLimiter?: IsolatedRunnerResourceLimiter;
  /** An explicit environment allowlist. The inherited environment is never copied. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Test/platform injection; production defaults to the current Node platform. */
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
  readonly killTree?: KillTree;
  /** Metadata-only observation. Never receives prompts, outputs, paths, or errors. */
  readonly onEvent?: (event: IsolatedRunnerEvent) => void;
  /** Metadata-only spawn observation; the explicit environment is never exposed. */
  readonly onSpawn?: (file: string, args: readonly string[], options: Omit<SpawnOptions, 'env'>) => void;
}

export interface IsolatedInjectedRunner {
  readonly copiedVaultRoot: string;
  readonly artifactRoot: string;
  readonly workerId: string;
  readonly run: (
    input: IsolatedRunnerInput,
    options?: IsolatedRunnerRunOptions,
  ) => Promise<IsolatedRunnerOutcome>;
}

const ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|authori[sz]ation|authentication|credential|password|secret|private[_-]?key|cookie)/iu;
const PROCESS_INJECTION_ENVIRONMENT_KEYS = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_V8_COVERAGE',
  'NODE_DEBUG', 'NODE_NO_WARNINGS', 'NODE_PENDING_DEPRECATION', 'ELECTRON_RUN_AS_NODE',
  'NODE_INSPECT', 'NODE_INSPECT_RESUME_ON_START', 'NODE_TLS_REJECT_UNAUTHORIZED',
]);
const LOADER_ENVIRONMENT_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT',
  'LD_ORIGIN_PATH', 'LD_ASSUME_KERNEL', 'LD_USE_LOAD_BIAS', 'LD_BIND_NOW',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES',
  'LIBPATH', 'SHLIB_PATH', 'PYTHONPATH', 'PYTHONHOME', 'RUBYLIB', 'PERL5LIB', 'CLASSPATH',
]);
const SECRET_ENVIRONMENT_KEY = /(?:^|[_-])(?:key|token|secret|password|passwd|pass|credential|auth(?:orization)?|cookie)(?:$|[_-])/iu;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_.-]{0,63}$/u;
const MAX_JSON_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_TEXT = 8 * 1024 * 1024;
const RESOURCE_CLEANUP_TIMEOUT_MS = 2_000;
const CLOSE_MESSAGE_GRACE_MS = 100;
const PROCESS_TREE_KILL_TIMEOUT_MS = 2_000;

function fail(code: IsolatedRunnerErrorCode, message: string, details: readonly string[] = []): never {
  throw new IsolatedRunnerError(code, message, details);
}

function describeSafeFailure(error: unknown): string {
  if (error instanceof IsolatedRunnerError) return error.message;
  return 'isolated runner operation failed';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function credentialShapedKey(key: string): boolean {
  // These two fields are non-secret protocol metadata. The authorization
  // binding hash is not a token.
  if (/authorization.*sha256/iu.test(key)) return false;
  return CREDENTIAL_KEY.test(key);
}

function assertFiniteJson(value: unknown, label: string, depth = 0, seen = new WeakSet<object>()): asserts value is IsolatedJsonValue {
  if (depth > MAX_JSON_DEPTH) fail('protocol-error', `${label} exceeds the JSON depth limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('protocol-error', `${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) fail('protocol-error', `${label} is not plain JSON`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertFiniteJson(child, `${label}[${index}]`, depth + 1, seen));
  } else {
    if (!record(value)) fail('protocol-error', `${label} is not a plain object`);
    for (const [key, child] of Object.entries(value)) {
      if (credentialShapedKey(key)) fail('protocol-error', `${label} contains a credential-shaped field`);
      assertFiniteJson(child, `${label}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function boundedJson(value: unknown, label: string, maximumBytes: number): string {
  assertFiniteJson(value, label);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    fail('protocol-error', `${label} could not be serialized`);
  }
  if (typeof json !== 'string') fail('protocol-error', `${label} could not be serialized`);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) fail('protocol-error', `${label} exceeds the IPC size limit`);
  return json;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('invalid-input', `${label} is not a safe identifier`);
  return value;
}

function safeDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail('invalid-input', `${label} is not a lowercase SHA-256 digest`);
  return value;
}

function authorizationRefHash(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    fail('invalid-input', 'Authorization reference is invalid');
  }
  return sha256Hex(value);
}

function safeAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('unsafe-path', `${label} is not an absolute NUL-free path`);
  // Do not resolve first: resolving would silently turn a caller-controlled
  // relative worker entry point into an apparently safe absolute path.
  if (!nodePath.isAbsolute(value)) fail('unsafe-path', `${label} is not absolute`);
  const resolved = nodePath.resolve(value);
  if (!nodePath.isAbsolute(resolved)) fail('unsafe-path', `${label} is not absolute`);
  return resolved;
}

function normalizedRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('unsafe-path', `${label} is not a safe relative path`);
  const normalized = value.replaceAll('\\', '/').normalize('NFKC');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) fail('unsafe-path', `${label} is not relative`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
    fail('unsafe-path', `${label} contains an unsafe path component`);
  }
  return parts.join('/');
}

function validateBoundedNumber(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('invalid-input', `${label} is outside the supported limit`);
  }
  return value;
}

function validateEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform,
): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(environment ?? {})) {
    const normalizedKey = key.normalize('NFKC');
    const foldedKey = normalizedKey.toUpperCase();
    // Environment names are case-insensitive on Windows.  Keep one policy on
    // every platform so a fixture cannot pass on POSIX and become ambiguous on
    // the production Windows host.
    if (!SAFE_ENVIRONMENT_KEY.test(normalizedKey) || seen.has(foldedKey)
      || CREDENTIAL_KEY.test(normalizedKey) || SECRET_ENVIRONMENT_KEY.test(normalizedKey)
      || PROCESS_INJECTION_ENVIRONMENT_KEYS.has(foldedKey) || LOADER_ENVIRONMENT_KEYS.has(foldedKey)) {
      fail('invalid-input', `Environment key ${key} is not allowlisted`);
    }
    if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) fail('invalid-input', `Environment value for ${key} is invalid`);
    seen.add(foldedKey);
    // Windows itself folds environment names; canonicalizing there avoids a
    // case alias being reintroduced by the child-process implementation.
    output[platform === 'win32' ? foldedKey : normalizedKey] = value;
  }
  return output;
}

function validateInventory(inventory: SourceInventory): void {
  if (!record(inventory) || inventory.version !== 'source-inventory/v1') fail('invalid-input', 'Source inventory version is unsupported');
  if (!onlyKeys(inventory, [
    'version', 'authorityTree', 'selectorVersion', 'includes', 'exclusions', 'sources',
    'snapshotTreeHash', 'inventorySha256',
  ])) fail('protocol-error', 'Source inventory contains an unknown field');
  if (typeof inventory.authorityTree !== 'string' || inventory.authorityTree.length === 0 || inventory.authorityTree.includes('\0')) {
    fail('invalid-input', 'Source inventory authority tree is invalid');
  }
  safeDigest(inventory.inventorySha256, 'Source inventory hash');
  const body = {
    version: inventory.version,
    authorityTree: inventory.authorityTree,
    selectorVersion: inventory.selectorVersion,
    includes: inventory.includes,
    exclusions: inventory.exclusions,
    sources: inventory.sources,
    snapshotTreeHash: inventory.snapshotTreeHash,
  };
  if (canonicalJsonSha256(body) !== inventory.inventorySha256) fail('invalid-input', 'Source inventory hash is not self-consistent');
  if (!Array.isArray(inventory.sources) || inventory.sources.length === 0) fail('invalid-input', 'Source inventory is empty');
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const [index, source] of inventory.sources.entries()) {
    if (!record(source) || !onlyKeys(source, ['path', 'byteLength', 'byteSha256', 'sourceIdentity'])) {
      fail('protocol-error', `Source inventory entry ${index} contains an unknown field`);
    }
    const path = normalizedRelativePath(source.path, `source_inventory.sources[${index}].path`);
    if (path !== source.path || paths.has(path)) fail('unsafe-path', `Source inventory path is not canonical or is duplicated: ${path}`);
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) fail('invalid-input', `Source byte length is invalid: ${path}`);
    const byteSha256 = safeDigest(source.byteSha256, `Source byte hash for ${path}`);
    const sourceIdentity = safeDigest(source.sourceIdentity, `Source identity for ${path}`);
    if (sourceIdentityDigest(inventory.authorityTree, path, byteSha256) !== sourceIdentity) fail('invalid-input', `Source identity is not bound: ${path}`);
    paths.add(path);
    if (identities.has(sourceIdentity)) fail('invalid-input', `Source identity is duplicated: ${path}`);
    identities.add(sourceIdentity);
  }
  safeDigest(inventory.snapshotTreeHash, 'Source inventory snapshot hash');
  if (snapshotTreeHash(inventory.sources.map(source => ({ path: source.path, byteSha256: source.byteSha256 }))) !== inventory.snapshotTreeHash) {
    fail('invalid-input', 'Source inventory snapshot hash is not self-consistent');
  }
}

function validateSourcePaths(inventory: SourceInventory, requested: readonly string[] | undefined): string[] {
  const available = new Set(inventory.sources.map(source => source.path));
  const values = requested ?? inventory.sources.map(source => source.path);
  if (!Array.isArray(values)) fail('invalid-input', 'Source paths must be an array');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const path = normalizedRelativePath(value, `source_paths[${index}]`);
    if (seen.has(path)) fail('unsafe-path', `Source path is duplicated: ${path}`);
    if (!available.has(path)) fail('unsafe-path', `Source path is not in the sealed inventory: ${path}`);
    seen.add(path);
    result.push(path);
  }
  if (result.length === 0) fail('invalid-input', 'At least one source path is required');
  return result;
}

function validateSettings(settings: IsolatedRunnerInput['settings']): IsolatedRunnerSettingsBinding {
  if (!record(settings)) fail('invalid-input', 'Settings binding is invalid');
  return {
    full_sha256: safeDigest(settings.fullSha256, 'Settings full hash'),
    safe_projection_sha256: safeDigest(settings.safeProjectionSha256, 'Settings safe projection hash'),
  };
}

function validateWriterBinding(writer: IsolatedRunnerInput['writer'], runId: string): IsolatedRunnerWriterBinding {
  if (!record(writer)) fail('invalid-input', 'Writer binding is invalid');
  const binding = {
    owner_id: safeId(writer.ownerId, 'Writer owner ID'),
    run_id: safeId(writer.runId, 'Writer run ID'),
    fence: validateBoundedNumber(writer.fence, 'Writer fence', 2 ** 53 - 1),
    candidate_root_sha256: safeDigest(writer.candidateRootSha256, 'Candidate root binding hash'),
  };
  if (binding.run_id !== runId) fail('invalid-input', 'Writer binding is not bound to the run');
  return binding;
}

function validateSignerDomains(
  requested: readonly IsolatedRunnerRequest['signer_domains'][number][] | undefined,
  capability: readonly IsolatedRunnerRequest['signer_domains'][number][] | undefined,
): readonly IsolatedRunnerRequest['signer_domains'][number][] {
  const ceiling = capability ?? [];
  if (!Array.isArray(ceiling) || ceiling.length > Object.values(DOMAINS).length) {
    fail('invalid-input', 'Signer capability domains are invalid');
  }
  const ceilingSet = new Set<string>();
  for (const value of ceiling) {
    if (typeof value !== 'string' || !Object.values(DOMAINS).includes(value as never) || ceilingSet.has(value)) {
      fail('invalid-input', 'Signer capability domains are invalid');
    }
    ceilingSet.add(value);
  }
  // A capability may supply a ceiling, but it may not silently become a
  // process-wide grant.  Every run carries its own explicit attenuation.
  const values = requested ?? [];
  if (!Array.isArray(values) || values.length > Object.values(DOMAINS).length) {
    fail('invalid-input', 'Signer allowed domains are invalid');
  }
  const result: IsolatedRunnerRequest['signer_domains'][number][] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !Object.values(DOMAINS).includes(value as never) || seen.has(value)) {
      fail('invalid-input', 'Signer allowed domains are invalid');
    }
    if (capability && !ceilingSet.has(value)) {
      fail('invalid-input', 'Run signer domains exceed the capability ceiling');
    }
    seen.add(value);
    result.push(value as IsolatedRunnerRequest['signer_domains'][number]);
  }
  return result;
}

function resultMessage(value: unknown, requestId: string): IsolatedRunnerResultMessage {
  if (!record(value) || !onlyKeys(value, ['type', 'protocol_version', 'request_id', 'status', 'result', 'error'])) {
    fail('protocol-error', 'Worker result contains an unknown field');
  }
  if (value.type !== 'result' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION || value.request_id !== requestId) {
    fail('protocol-error', 'Worker result is not bound to this request');
  }
  if (value.status !== 'accepted' && value.status !== 'rejected') fail('protocol-error', 'Worker result status is invalid');
  if (value.result !== undefined) {
    if (!record(value.result)) fail('protocol-error', 'Worker result payload must be a plain object');
    assertFiniteJson(value.result, 'worker.result');
  }
  if (value.error !== undefined) {
    if (!record(value.error) || !onlyKeys(value.error, ['code', 'message'])
      || typeof value.error.code !== 'string' || !SAFE_ERROR_CODE.test(value.error.code)
      || typeof value.error.message !== 'string' || value.error.message.length > 256) {
      fail('protocol-error', 'Worker error is not bounded and allowlisted');
    }
  }
  if (value.status === 'accepted' && value.error !== undefined) fail('protocol-error', 'Accepted worker result cannot contain an error');
  return {
    ...(value as unknown as IsolatedRunnerResultMessage),
    ...(value.error === undefined ? {} : {
      error: {
        code: typeof value.error?.code === 'string' ? value.error.code : 'WORKER_REJECTED',
        message: 'Worker rejected the isolated operation',
      },
    }),
  };
}

function providerMessage(value: unknown, request: IsolatedRunnerRequest): IsolatedProviderCallRequest {
  if (!record(value) || !onlyKeys(value, [
    'type', 'protocol_version', 'request_id', 'run_id', 'worker_id', 'provider', 'model',
    'max_tokens', 'max_tokens_per_call', 'system', 'messages', 'task', 'response_format',
    'output_mode', 'enable_thinking', 'reasoning_effort', 'temperature', 'top_p', 'seed',
  ])) fail('protocol-error', 'Provider IPC request contains an unknown field');
  if (value.type !== 'provider_call' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION
    || value.run_id !== request.run_id || value.worker_id !== request.worker_id
    || value.provider !== request.provider.provider || value.model !== request.provider.model) {
    fail('protocol-error', 'Provider IPC request is not bound to the sealed run/provider');
  }
  safeId(value.request_id, 'Provider request ID');
  validateBoundedNumber(value.max_tokens, 'Provider max_tokens', 2_000_000_000);
  if (value.max_tokens_per_call !== undefined) validateBoundedNumber(value.max_tokens_per_call, 'Provider max_tokens_per_call', 2_000_000_000);
  if (!Array.isArray(value.messages) || value.messages.length > 128) fail('protocol-error', 'Provider messages are invalid');
  for (const [index, message] of value.messages.entries()) {
    if (!record(message) || !onlyKeys(message, ['role', 'content']) || (message.role !== 'user' && message.role !== 'assistant')) {
      fail('protocol-error', `Provider message ${index} is invalid`);
    }
    if (typeof message.content === 'string') {
      if (message.content.length > MAX_PROVIDER_TEXT) fail('protocol-error', 'Provider message is too large');
    } else if (Array.isArray(message.content)) {
      assertFiniteJson(message.content, `provider.messages[${index}].content`);
    } else {
      fail('protocol-error', `Provider message ${index} content is invalid`);
    }
  }
  if (value.system !== undefined && (typeof value.system !== 'string' || value.system.length > MAX_PROVIDER_TEXT)) fail('protocol-error', 'Provider system text is invalid');
  if (value.task !== undefined && (typeof value.task !== 'string' || value.task.length > 4096)) fail('protocol-error', 'Provider task is invalid');
  if (value.response_format !== undefined) {
    if (!record(value.response_format) || !onlyKeys(value.response_format, ['type', 'schema']) || value.response_format.type !== 'json_object') {
      fail('protocol-error', 'Provider response format is invalid');
    }
    if (value.response_format.schema !== undefined) assertFiniteJson(value.response_format.schema, 'provider.response_format.schema');
  }
  if (value.output_mode !== undefined && (typeof value.output_mode !== 'string' || !['json_schema', 'json_object', 'text_prompt'].includes(value.output_mode))) fail('protocol-error', 'Provider output mode is invalid');
  if (value.reasoning_effort !== undefined && (typeof value.reasoning_effort !== 'string' || !['low', 'medium', 'high'].includes(value.reasoning_effort))) fail('protocol-error', 'Provider reasoning effort is invalid');
  if (value.enable_thinking !== undefined && typeof value.enable_thinking !== 'boolean') fail('protocol-error', 'Provider thinking flag is invalid');
  for (const key of ['temperature', 'top_p']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) fail('protocol-error', `Provider ${key} is invalid`);
  }
  if (value.seed !== undefined && !Number.isSafeInteger(value.seed)) fail('protocol-error', 'Provider seed is invalid');
  return value as unknown as IsolatedProviderCallRequest;
}

function signerMessage(value: unknown, request: IsolatedRunnerRequest): IsolatedSignerRequest {
  if (!record(value) || !onlyKeys(value, ['type', 'protocol_version', 'request_id', 'run_id', 'worker_id', 'writer', 'domain', 'digest'])) {
    fail('protocol-error', 'Signer IPC request contains an unknown field');
  }
  if (value.type !== 'sign_request' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION
    || value.run_id !== request.run_id || value.worker_id !== request.worker_id
    || typeof value.domain !== 'string' || !Object.values(DOMAINS).includes(value.domain as never)) {
    fail('protocol-error', 'Signer IPC request is not bound to an allowlisted domain/run');
  }
  if (!request.signer_domains.includes(value.domain as IsolatedRunnerRequest['signer_domains'][number])) {
    fail('signer-refused', 'Signer domain is not allowed for this run');
  }
  if (!record(value.writer) || !onlyKeys(value.writer, ['owner_id', 'run_id', 'fence', 'candidate_root_sha256'])) {
    fail('protocol-error', 'Signer IPC request writer binding is invalid');
  }
  const writer = value.writer;
  if (writer.owner_id !== request.writer.owner_id || writer.run_id !== request.writer.run_id
    || writer.fence !== request.writer.fence || writer.candidate_root_sha256 !== request.writer.candidate_root_sha256) {
    fail('protocol-error', 'Signer IPC request writer binding is not sealed to this run');
  }
  safeId(value.request_id, 'Signer request ID');
  safeDigest(value.digest, 'Signer digest');
  return value as unknown as IsolatedSignerRequest;
}

function providerResponse(value: unknown, requestId: string): IsolatedProviderCallResponse {
  if (!record(value) || !onlyKeys(value, [
    'type', 'protocol_version', 'request_id', 'status', 'text', 'output', 'output_mode',
    'finish_reason', 'usage', 'error_code',
  ])) fail('protocol-error', 'Provider IPC response contains an unknown field');
  if (value.type !== 'provider_response' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION || value.request_id !== requestId) {
    fail('protocol-error', 'Provider IPC response is not bound to the pending request');
  }
  if (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'cancelled') fail('protocol-error', 'Provider IPC response status is invalid');
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > MAX_PROVIDER_TEXT)) fail('protocol-error', 'Provider IPC response text is invalid');
  if (value.output !== undefined) assertFiniteJson(value.output, 'provider_response.output');
  if (value.output_mode !== undefined && (typeof value.output_mode !== 'string' || !['json_schema', 'json_object', 'text_prompt'].includes(value.output_mode))) fail('protocol-error', 'Provider IPC output mode is invalid');
  if (value.finish_reason !== undefined && (typeof value.finish_reason !== 'string' || !['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(value.finish_reason))) fail('protocol-error', 'Provider IPC finish reason is invalid');
  if (value.error_code !== undefined && (typeof value.error_code !== 'string' || !SAFE_ERROR_CODE.test(value.error_code))) fail('protocol-error', 'Provider IPC error code is invalid');
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!record(usage) || !onlyKeys(usage, ['inputTokens', 'outputTokens', 'totalTokens'])) fail('protocol-error', 'Provider usage is invalid');
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
      const usageValue = usage[key];
      if (usageValue !== undefined && (!Number.isSafeInteger(usageValue) || (usageValue as number) < 0)) fail('protocol-error', 'Provider usage value is invalid');
    }
  }
  return value as unknown as IsolatedProviderCallResponse;
}

function signerResponse(value: unknown, requestId: string): IsolatedSignerResponse {
  if (!record(value) || !onlyKeys(value, ['type', 'protocol_version', 'request_id', 'status', 'key_id', 'signature', 'error_code'])) {
    fail('protocol-error', 'Signer IPC response contains an unknown field');
  }
  if (value.type !== 'sign_response' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION || value.request_id !== requestId) {
    fail('protocol-error', 'Signer IPC response is not bound to the pending request');
  }
  if (value.status !== 'succeeded' && value.status !== 'failed') fail('protocol-error', 'Signer IPC response status is invalid');
  if (value.key_id !== undefined) safeId(value.key_id, 'Signer key ID');
  if (value.signature !== undefined && (typeof value.signature !== 'string' || value.signature.length > 512)) fail('protocol-error', 'Signer response signature is invalid');
  if (value.error_code !== undefined && (typeof value.error_code !== 'string' || !SAFE_ERROR_CODE.test(value.error_code))) fail('protocol-error', 'Signer IPC error code is invalid');
  if (value.status === 'succeeded' && (!value.key_id || !value.signature)) fail('protocol-error', 'Successful signer response is incomplete');
  return value as unknown as IsolatedSignerResponse;
}

function defaultKillTree(platform: NodeJS.Platform): KillTree {
  if (platform === 'win32') {
    return pid => new Promise<void>((resolve, reject) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
        if (!error) {
          resolve();
          return;
        }
        // A missing root PID does not prove that descendants are gone.  The
        // caller must fail closed unless taskkill itself proves the tree was
        // terminated (or a stronger Job Object adapter is injected).
        reject(new Error('Windows process-tree termination was not proved'));
      });
    });
  }
  return pid => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw new Error('Process-group termination failed');
    }
  };
}

function event(options: IsolatedInjectedRunnerOptions, value: IsolatedRunnerEvent): void {
  try {
    options.onEvent?.(value);
  } catch {
    // Metadata observers cannot weaken the isolation boundary or fail a run.
  }
}

function providerIdentityFromInput(
  input: IsolatedRunnerInput,
  configured: IsolatedProviderCapability | undefined,
): IsolatedRunnerRequest['provider'] {
  const candidate = input.provider;
  if (candidate) {
    return {
      provider: safeId(candidate.provider, 'Provider'),
      model: safeId(candidate.model, 'Model'),
      authorization_ref_sha256: authorizationRefHash(candidate.authorizationRef),
    };
  }
  if (configured) {
    return {
      provider: safeId(configured.provider, 'Provider'),
      model: safeId(configured.model, 'Model'),
      authorization_ref_sha256: authorizationRefHash(configured.authorizationRef),
    };
  }
  return {
    provider: 'injected-provider',
    model: 'injected-model',
    authorization_ref_sha256: sha256Hex('opaque-injected-grant'),
  };
}

function buildRequest(
  input: IsolatedRunnerInput,
  roots: { copiedVaultRoot: string; artifactRoot: string },
  workerId: string,
  requestId: string,
  provider: IsolatedProviderCapability | undefined,
  signer: IsolatedSignerCapability | undefined,
): IsolatedRunnerRequest {
  if (!record(input)) fail('invalid-input', 'Isolated runner input is invalid');
  safeId(input.runId, 'Run ID');
  validateInventory(input.sourceInventory);
  const sourcePaths = validateSourcePaths(input.sourceInventory, input.sourcePaths);
  const mode = input.mode ?? 'ingest';
  if (mode !== 'ingest' && mode !== 'lint') fail('invalid-input', 'Native reference mode is unsupported');
  return {
    type: 'run',
    protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
    request_id: requestId,
    run_id: input.runId,
    worker_id: workerId,
    operation: 'native-reference',
    mode,
    copied_vault_root: roots.copiedVaultRoot,
    artifact_root: roots.artifactRoot,
    source_inventory: input.sourceInventory,
    source_paths: sourcePaths,
    settings: validateSettings(input.settings),
    provider: providerIdentityFromInput(input, provider),
    signer_domains: validateSignerDomains(input.signer?.allowedDomains, signer?.allowedDomains),
    writer: validateWriterBinding(input.writer, input.runId),
  };
}

async function validateWorkerScript(
  path: string,
  copiedVaultRoot: string,
  artifactRoot: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const absolute = safeAbsolutePath(path, 'Worker script');
  if (pathsOverlap(absolute, copiedVaultRoot) || pathsOverlap(absolute, artifactRoot)) fail('unsafe-path', 'Worker script cannot live inside a copied-vault or artifact root');
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    fail('unsafe-path', 'Worker script is not readable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe-path', 'Worker script must be a plain file');
  let resolved: string;
  try {
    resolved = nodePath.resolve(await realpath(absolute));
  } catch {
    fail('unsafe-path', 'Worker script could not be resolved');
  }
  const samePath = platform === 'win32'
    ? resolved.toLowerCase() === absolute.toLowerCase()
    : resolved === absolute;
  if (!samePath) {
    fail('unsafe-path', 'Worker script resolves through a reparse point');
  }
  return resolved;
}

function normalizeResourceLimits(limits: IsolatedResourceLimit | undefined): IsolatedResourceLimit | undefined {
  if (!limits) return undefined;
  const memoryBytes = limits.memoryBytes === undefined ? undefined : validateBoundedNumber(limits.memoryBytes, 'memoryBytes', 2 ** 53 - 1);
  const cpuTimeMs = limits.cpuTimeMs === undefined ? undefined : validateBoundedNumber(limits.cpuTimeMs, 'cpuTimeMs', 2 ** 53 - 1);
  if (memoryBytes === undefined && cpuTimeMs === undefined) fail('invalid-input', 'Resource limits must contain memoryBytes or cpuTimeMs');
  return { ...(memoryBytes === undefined ? {} : { memoryBytes }), ...(cpuTimeMs === undefined ? {} : { cpuTimeMs }) };
}

function makeRequestId(runId: string, sequence: number): string {
  const requestId = `${runId}-run-${sequence}`;
  safeId(requestId, 'Request ID');
  return requestId;
}

async function cleanupResource(cleanup: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!cleanup) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => cleanup()).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, RESOURCE_CLEANUP_TIMEOUT_MS); }),
    ]);
  } catch {
    // A resource limiter cannot re-open a completed run; its failure is not
    // exposed as raw platform text or secret-bearing diagnostics.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function killTreeWithin(
  killTree: KillTree,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => killTree(pid))
        .then(() => true, () => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class IsolatedInjectedRunnerImpl implements IsolatedInjectedRunner {
  readonly copiedVaultRoot: string;
  readonly artifactRoot: string;
  readonly workerId: string;
  private sequence = 0;
  private readonly options: IsolatedInjectedRunnerOptions;
  private readonly workerScript: string;
  private readonly environment: Record<string, string>;
  private readonly resourceLimits: IsolatedResourceLimit | undefined;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly spawnProcess: SpawnProcess;
  private readonly killTree: KillTree;

  constructor(
    options: IsolatedInjectedRunnerOptions,
    workerScript: string,
    roots: { copiedVaultRoot: string; artifactRoot: string },
  ) {
    this.options = options;
    this.workerScript = workerScript;
    this.copiedVaultRoot = roots.copiedVaultRoot;
    this.artifactRoot = roots.artifactRoot;
    this.workerId = safeId(options.workerId, 'Worker ID');
    this.environment = validateEnvironment(options.environment, options.platform ?? process.platform);
    this.resourceLimits = normalizeResourceLimits(options.resourceLimits);
    this.timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validateBoundedNumber(options.timeoutMs, 'timeoutMs', 24 * 60 * 60 * 1000);
    this.maxRequestBytes = options.maxRequestBytes === undefined ? DEFAULT_REQUEST_BYTES : validateBoundedNumber(options.maxRequestBytes, 'maxRequestBytes', 128 * 1024 * 1024);
    this.maxResponseBytes = options.maxResponseBytes === undefined ? DEFAULT_RESPONSE_BYTES : validateBoundedNumber(options.maxResponseBytes, 'maxResponseBytes', 128 * 1024 * 1024);
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.killTree = options.killTree ?? defaultKillTree(options.platform ?? process.platform);
  }

  async run(input: IsolatedRunnerInput, runOptions: IsolatedRunnerRunOptions = {}): Promise<IsolatedRunnerOutcome> {
    const signal = runOptions.signal;
    if (signal?.aborted) throw new IsolatedRunnerError('cancelled', 'Isolated worker run was cancelled before launch');
    const requestId = makeRequestId(input.runId, ++this.sequence);
    const request = buildRequest(
      input,
      { copiedVaultRoot: this.copiedVaultRoot, artifactRoot: this.artifactRoot },
      this.workerId,
      requestId,
      this.options.provider,
      this.options.signer,
    );
    boundedJson(request, 'runner request', this.maxRequestBytes);
    const spawnOptions: SpawnOptions = {
      cwd: this.copiedVaultRoot,
      env: { ...this.environment },
      shell: false,
      windowsHide: true,
      detached: (this.options.platform ?? process.platform) !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(process.execPath, ['--no-warnings', this.workerScript], spawnOptions);
    } catch {
      throw new IsolatedRunnerError('worker-failed', 'Isolated worker could not be spawned');
    }
    const pid = child.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
      child.stdin.destroy();
      throw new IsolatedRunnerError('worker-failed', 'Isolated worker did not expose a process ID');
    }
    const runAbort = new AbortController();
    let resourceCleanup: void | (() => void | Promise<void>) = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let terminationStarted = false;
    let closed = false;
    let stdinEnded = false;
    let lineBuffer = '';
    let responseBytes = 0;
    let messageChain = Promise.resolve();
    let onAbort: (() => void) | undefined;
    let resolveClose: (() => void) | undefined;
    const closePromise = new Promise<void>(resolve => { resolveClose = resolve; });
    const seenCapabilities = new Set<string>();
    const cleanup = async () => {
      await cleanupResource(typeof resourceCleanup === 'function' ? resourceCleanup : undefined);
    };
    const send = (value: IsolatedHostMessage): void => {
      if (settled || closed || stdinEnded || terminationStarted || runAbort.signal.aborted) return;
      const json = boundedJson(value, 'runner IPC message', this.maxRequestBytes);
      try {
        if (!child.stdin.write(`${json}\n`, 'utf8')) {
          // Backpressure is safe: Node's Writable retains the validated frame;
          // no unbounded queue is created by this runner.
        }
      } catch {
        // Stream errors are reported through the installed error listener;
        // capability completions racing shutdown must not throw into the host.
      }
    };
    const terminate = async (error: IsolatedRunnerError): Promise<IsolatedRunnerError> => {
      if (terminationStarted) return error;
      terminationStarted = true;
      runAbort.abort();
      const killed = await killTreeWithin(
        this.killTree,
        pid,
        Math.min(PROCESS_TREE_KILL_TIMEOUT_MS, this.timeoutMs),
      );
      if (!killed) return new IsolatedRunnerError('kill-failed', 'Isolated worker process-tree termination was not proved');
      return error;
    };
    const promise = new Promise<IsolatedRunnerOutcome>((resolve, reject) => {
      const finish = async (error?: IsolatedRunnerError, outcome?: IsolatedRunnerOutcome): Promise<void> => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        stdinEnded = true;
        child.stdin.end();
        if (!error && outcome) {
          runAbort.abort();
          try {
            // A worker is untrusted code. A terminal frame is not permission
            // to leave a descendant alive with the copied vault as cwd.
            const killed = await killTreeWithin(
              this.killTree,
              pid,
              Math.min(PROCESS_TREE_KILL_TIMEOUT_MS, this.timeoutMs),
            );
            if (!killed) {
              error = new IsolatedRunnerError('kill-failed', 'Isolated worker process-tree termination was not proved');
            }
          } catch {
            error = new IsolatedRunnerError('kill-failed', 'Isolated worker process-tree termination was not proved');
          }
        }
        if (!closed && !error) {
          await Promise.race([
            closePromise,
            new Promise<void>(resolve => { setTimeout(resolve, 2_000); }),
          ]);
          if (!closed && !error) error = new IsolatedRunnerError('kill-failed', 'Isolated worker did not close after process-tree termination');
        }
        await cleanup();
        if (error) {
          event(this.options, {
            type: error.code === 'timeout' ? 'timeout' : error.code === 'cancelled' ? 'cancelled' : 'refused',
            request_id: request.request_id,
            run_id: request.run_id,
            worker_id: request.worker_id,
            operation: request.operation,
            error_code: error.code,
          });
          reject(error);
        } else if (outcome) {
          event(this.options, {
            type: 'completed',
            request_id: request.request_id,
            run_id: request.run_id,
            worker_id: request.worker_id,
            operation: request.operation,
            status: outcome.status,
          });
          resolve(outcome);
        }
      };
      const failRun = (error: IsolatedRunnerError): void => {
        if (settled || terminationStarted) return;
        void terminate(error).then(finalError => finish(finalError));
      };
      const sendProviderResponse = async (requestMessage: IsolatedProviderCallRequest): Promise<void> => {
        if (!this.options.provider) {
          send({
            type: 'provider_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
            request_id: requestMessage.request_id, status: 'failed', error_code: 'CAPABILITY_UNAVAILABLE',
          });
          return;
        }
        try {
          const response = await this.options.provider.call(requestMessage, { signal: runAbort.signal });
          if (settled || closed || terminationStarted || runAbort.signal.aborted) return;
          const checked = providerResponse({ ...response, type: 'provider_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION, request_id: requestMessage.request_id }, requestMessage.request_id);
          send(checked);
          if (!settled && !closed && !terminationStarted) {
            event(this.options, {
              type: 'provider-completed', request_id: requestMessage.request_id,
              run_id: request.run_id, worker_id: request.worker_id,
            });
          }
        } catch {
          send({
            type: 'provider_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
            request_id: requestMessage.request_id, status: 'failed', error_code: 'CAPABILITY_FAILED',
          });
          if (!settled && !closed && !terminationStarted) {
            event(this.options, {
              type: 'provider-completed', request_id: requestMessage.request_id,
              run_id: request.run_id, worker_id: request.worker_id, error_code: 'CAPABILITY_FAILED',
            });
          }
        }
      };
      const sendSignerResponse = async (requestMessage: IsolatedSignerRequest): Promise<void> => {
        if (!this.options.signer) {
          send({
            type: 'sign_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
            request_id: requestMessage.request_id, status: 'failed', error_code: 'CAPABILITY_UNAVAILABLE',
          });
          return;
        }
        try {
          const context: IsolatedSignerContext = {
            workerId: request.worker_id,
            runId: request.run_id,
            writer: {
              ...request.writer,
            },
            fence: request.writer.fence,
            domain: requestMessage.domain,
            digest: requestMessage.digest,
          };
          const response = await this.options.signer.sign(requestMessage, { signal: runAbort.signal, context });
          if (settled || closed || terminationStarted || runAbort.signal.aborted) return;
          const checked = signerResponse({ ...response, type: 'sign_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION, request_id: requestMessage.request_id }, requestMessage.request_id);
          send(checked);
          if (!settled && !closed && !terminationStarted) {
            event(this.options, {
              type: 'sign-completed', request_id: requestMessage.request_id,
              run_id: request.run_id, worker_id: request.worker_id,
            });
          }
        } catch {
          send({
            type: 'sign_response', protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
            request_id: requestMessage.request_id, status: 'failed', error_code: 'CAPABILITY_FAILED',
          });
          if (!settled && !closed && !terminationStarted) {
            event(this.options, {
              type: 'sign-completed', request_id: requestMessage.request_id,
              run_id: request.run_id, worker_id: request.worker_id, error_code: 'CAPABILITY_FAILED',
            });
          }
        }
      };
      const handleMessage = async (value: unknown): Promise<void> => {
        if (settled) return;
        let message: IsolatedChildMessage;
        if (record(value) && value.type === 'provider_call') message = providerMessage(value, request);
        else if (record(value) && value.type === 'sign_request') message = signerMessage(value, request);
        else if (record(value) && value.type === 'result') message = resultMessage(value, request.request_id);
        else fail('protocol-error', 'Worker IPC message type is not allowlisted');
        if (message.type === 'result') {
          await finish(undefined, {
            status: message.status,
            ...(message.result === undefined ? {} : { result: message.result }),
            ...(message.error === undefined ? {} : { error: message.error }),
          });
          return;
        }
        if (seenCapabilities.has(message.request_id)) fail('protocol-error', 'Worker reused a capability request ID');
        seenCapabilities.add(message.request_id);
        event(this.options, {
          type: message.type === 'provider_call' ? 'provider-requested' : 'sign-requested',
          request_id: message.request_id,
          run_id: request.run_id,
          worker_id: request.worker_id,
        });
        if (message.type === 'provider_call') await sendProviderResponse(message);
        else await sendSignerResponse(message);
      };
      const onData = (chunk: Buffer | string): void => {
        if (settled) return;
        responseBytes += Buffer.byteLength(chunk, 'utf8');
        if (responseBytes > this.maxResponseBytes) {
          failRun(new IsolatedRunnerError('response-too-large', 'Isolated worker response exceeded the configured limit'));
          return;
        }
        lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let newline = lineBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/u, '');
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line.length === 0) {
            failRun(new IsolatedRunnerError('protocol-error', 'Worker emitted a blank IPC frame'));
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(line) as unknown;
          } catch {
            failRun(new IsolatedRunnerError('protocol-error', 'Worker emitted malformed JSON'));
            return;
          }
          messageChain = messageChain.then(() => handleMessage(decoded)).catch(error => {
            failRun(error instanceof IsolatedRunnerError ? error : new IsolatedRunnerError('protocol-error', 'Worker IPC validation failed'));
          });
          newline = lineBuffer.indexOf('\n');
        }
      };
      const onError = () => failRun(new IsolatedRunnerError('worker-failed', 'Isolated worker process failed'));
      const onClose = () => {
        closed = true;
        resolveClose?.();
        if (!settled && !terminationStarted) {
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const grace = new Promise<void>(resolve => {
            graceTimer = setTimeout(resolve, CLOSE_MESSAGE_GRACE_MS);
          });
          void Promise.race([messageChain, grace]).then(() => {
            if (graceTimer) clearTimeout(graceTimer);
            if (!settled && !terminationStarted) failRun(new IsolatedRunnerError('worker-exited', 'Isolated worker exited before a terminal result'));
          });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', () => { /* stderr is drained and never logged */ });
      child.stdin.once('error', onError);
      child.stdout.once('error', onError);
      child.stderr.once('error', onError);
      child.once('error', onError);
      child.once('close', onClose);
      if (signal) {
        onAbort = () => {
          runAbort.abort();
          failRun(new IsolatedRunnerError('cancelled', 'Isolated worker run was cancelled'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      // Wire cancellation and the deadline before invoking an injected
      // limiter.  A limiter is host code and may block or return a never-
      // resolving promise; neither case may suspend the worker deadline.
      timeout = setTimeout(() => {
        failRun(new IsolatedRunnerError('timeout', 'Isolated worker exceeded its timeout'));
      }, this.timeoutMs);
      if (settled || terminationStarted) return;
      event(this.options, {
        type: 'started', request_id: request.request_id,
        run_id: request.run_id, worker_id: request.worker_id, operation: request.operation,
      });
      try {
        const spawnMetadata: Omit<SpawnOptions, 'env'> = {
          cwd: spawnOptions.cwd,
          shell: spawnOptions.shell,
          windowsHide: spawnOptions.windowsHide,
          detached: spawnOptions.detached,
          stdio: spawnOptions.stdio,
        };
        this.options.onSpawn?.(process.execPath, ['--no-warnings', this.workerScript], spawnMetadata);
      } catch {
        failRun(new IsolatedRunnerError('worker-failed', 'Isolated worker spawn observer failed'));
      }
      void (async () => {
        if (settled || terminationStarted || runAbort.signal.aborted) return;
        if (this.resourceLimits && this.options.resourceLimiter) {
          let applied: void | (() => void | Promise<void>);
          try {
            applied = await this.options.resourceLimiter.apply(
              pid,
              this.resourceLimits,
              { signal: runAbort.signal },
            );
          } catch {
            if (!settled) failRun(new IsolatedRunnerError('resource-limits-unavailable', 'Requested OS resource limits could not be applied'));
            return;
          }
          if (settled || terminationStarted || runAbort.signal.aborted) {
            await cleanupResource(typeof applied === 'function' ? applied : undefined);
            return;
          }
          resourceCleanup = applied;
        }
        if (settled || terminationStarted || runAbort.signal.aborted) return;
        try {
          send(request);
        } catch (error) {
          failRun(error instanceof IsolatedRunnerError ? error : new IsolatedRunnerError('protocol-error', 'Initial IPC frame could not be sent'));
        }
      })();
    });
    try {
      return await promise;
    } catch (error) {
      if (error instanceof IsolatedRunnerError) throw error;
      throw new IsolatedRunnerError('worker-failed', describeSafeFailure(error));
    }
  }
}

export async function createIsolatedInjectedRunner(
  options: IsolatedInjectedRunnerOptions,
): Promise<IsolatedInjectedRunner> {
  const platform = options.platform ?? process.platform;
  const roots = await assertSafeCopyRoots({
    liveRoot: options.copiedVaultRoot,
    copyRoots: [options.artifactRoot],
    syncRoots: options.syncRoots,
  }).catch(() => {
    throw new IsolatedRunnerError('unsafe-path', 'Copied-vault and artifact roots failed containment checks');
  });
  if (pathsOverlap(roots.liveRoot.resolved, roots.copyRoots[0].resolved)) {
    throw new IsolatedRunnerError('unsafe-path', 'Copied-vault and artifact roots overlap');
  }
  const workerScript = await validateWorkerScript(options.workerScript, roots.liveRoot.resolved, roots.copyRoots[0].resolved, platform);
  const resourceLimits = normalizeResourceLimits(options.resourceLimits);
  if (resourceLimits && !options.resourceLimiter) {
    // Windows has no portable child-process resource-limit primitive in Node.
    // Refusing here is important: a caller must not mistake protocol bounds
    // for a Job Object/cgroup guarantee.
    throw new IsolatedRunnerError('resource-limits-unavailable', platform === 'win32'
      ? 'Windows resource limits require an explicit Job Object adapter'
      : 'Requested OS resource limits require an explicit process limiter');
  }
  return new IsolatedInjectedRunnerImpl(options, workerScript, {
    copiedVaultRoot: roots.liveRoot.resolved,
    artifactRoot: roots.copyRoots[0].resolved,
  });
}

export const createIsolatedRunner = createIsolatedInjectedRunner;
