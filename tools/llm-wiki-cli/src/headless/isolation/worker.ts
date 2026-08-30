import { createInterface } from 'node:readline';

import { DOMAINS } from '../crypto';
import {
  ISOLATED_RUNNER_PROTOCOL_VERSION,
  type IsolatedJsonRecord,
  type IsolatedJsonValue,
  type IsolatedProviderCallRequest,
  type IsolatedProviderCallResponse,
  type IsolatedRunnerRequest,
  type IsolatedRunnerResultMessage,
  type IsolatedSignerRequest,
  type IsolatedSignerResponse,
} from './types';

export interface IsolatedWorkerCapabilities {
  readonly provider: {
    readonly call: (
      input: Omit<IsolatedProviderCallRequest, 'type' | 'protocol_version' | 'request_id' | 'run_id' | 'worker_id' | 'provider' | 'model'>,
    ) => Promise<IsolatedProviderCallResponse>;
  };
  readonly signer: {
    readonly sign: (
      input: Omit<IsolatedSignerRequest, 'type' | 'protocol_version' | 'request_id' | 'run_id' | 'worker_id' | 'writer'>,
    ) => Promise<IsolatedSignerResponse>;
  };
}

export type IsolatedWorkerHandler = (
  request: IsolatedRunnerRequest,
  capabilities: IsolatedWorkerCapabilities,
) => IsolatedJsonRecord | Promise<IsolatedJsonRecord>;

const MAX_JSON_DEPTH = 32;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|authori[sz]ation|authentication|credential|password|secret|private[_-]?key|cookie)/iu;

function credentialShapedKey(key: string): boolean {
  if (/authorization.*sha256/iu.test(key)) return false;
  return CREDENTIAL_KEY.test(key);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finiteJson(value: unknown, label: string, depth = 0, seen = new WeakSet<object>()): asserts value is IsolatedJsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds JSON depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error(`${label} is not plain JSON`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((child, index) => finiteJson(child, `${label}[${index}]`, depth + 1, seen));
  else {
    if (!record(value)) throw new Error(`${label} is not a plain object`);
    for (const [key, child] of Object.entries(value)) {
      if (credentialShapedKey(key)) throw new Error(`${label} contains a credential-shaped key`);
      finiteJson(child, `${label}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function frame(value: unknown): string {
  finiteJson(value, 'IPC frame');
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_FRAME_BYTES) throw new Error('IPC frame exceeds the size limit');
  return `${json}\n`;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function safeId(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
}

function safeDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SAFE_DIGEST.test(value)) throw new Error(`${label} is invalid`);
}

function request(value: unknown): IsolatedRunnerRequest {
  if (!record(value) || !onlyKeys(value, [
    'type', 'protocol_version', 'request_id', 'run_id', 'worker_id', 'operation', 'mode',
    'copied_vault_root', 'artifact_root', 'source_inventory', 'source_paths', 'settings', 'provider', 'signer_domains', 'writer',
  ])) throw new Error('Initial worker request contains an unknown field');
  if (value.type !== 'run' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION
    || value.operation !== 'native-reference' || (value.mode !== 'ingest' && value.mode !== 'lint')) {
    throw new Error('Initial worker request is unsupported');
  }
  for (const key of ['request_id', 'run_id', 'worker_id']) {
    if (typeof value[key] !== 'string' || !SAFE_ID.test(value[key])) throw new Error(`Initial worker ${key} is invalid`);
  }
  for (const key of ['copied_vault_root', 'artifact_root']) {
    if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].includes('\0')) throw new Error(`Initial worker ${key} is invalid`);
  }
  if (!record(value.provider) || !onlyKeys(value.provider, ['provider', 'model', 'authorization_ref_sha256'])) {
    throw new Error('Initial worker provider identity is invalid');
  }
  safeId(value.provider.provider, 'Provider');
  safeId(value.provider.model, 'Model');
  safeDigest(value.provider.authorization_ref_sha256, 'Authorization reference hash');
  if (!record(value.writer) || !onlyKeys(value.writer, ['owner_id', 'run_id', 'fence', 'candidate_root_sha256'])) {
    throw new Error('Initial worker writer binding is invalid');
  }
  safeId(value.writer.owner_id, 'Writer owner');
  safeId(value.writer.run_id, 'Writer run');
  if (typeof value.writer.fence !== 'number' || !Number.isSafeInteger(value.writer.fence) || value.writer.fence < 1) throw new Error('Writer fence is invalid');
  safeDigest(value.writer.candidate_root_sha256, 'Candidate root binding hash');
  if (value.writer.run_id !== value.run_id) throw new Error('Writer binding is not bound to the run');
  if (!Array.isArray(value.signer_domains) || value.signer_domains.length > Object.values(DOMAINS).length) {
    throw new Error('Initial worker signer domains are invalid');
  }
  const signerDomains = new Set<string>();
  for (const domain of value.signer_domains) {
    if (typeof domain !== 'string' || !Object.values(DOMAINS).includes(domain as never) || signerDomains.has(domain)) {
      throw new Error('Initial worker signer domains are invalid');
    }
    signerDomains.add(domain);
  }
  finiteJson(value.source_inventory, 'source_inventory');
  finiteJson(value.source_paths, 'source_paths');
  finiteJson(value.settings, 'settings');
  finiteJson(value.provider, 'provider');
  return value as unknown as IsolatedRunnerRequest;
}

function providerResponse(value: unknown, requestId: string): IsolatedProviderCallResponse {
  if (!record(value) || !onlyKeys(value, [
    'type', 'protocol_version', 'request_id', 'status', 'text', 'output', 'output_mode',
    'finish_reason', 'usage', 'error_code',
  ])) throw new Error('Provider response contains an unknown field');
  if (value.type !== 'provider_response' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION || value.request_id !== requestId) {
    throw new Error('Provider response is not bound to the pending call');
  }
  if (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'cancelled') throw new Error('Provider response status is invalid');
  finiteJson(value, 'provider_response');
  return value as unknown as IsolatedProviderCallResponse;
}

function signerResponse(value: unknown, requestId: string): IsolatedSignerResponse {
  if (!record(value) || !onlyKeys(value, ['type', 'protocol_version', 'request_id', 'status', 'key_id', 'signature', 'error_code'])) {
    throw new Error('Signer response contains an unknown field');
  }
  if (value.type !== 'sign_response' || value.protocol_version !== ISOLATED_RUNNER_PROTOCOL_VERSION || value.request_id !== requestId) {
    throw new Error('Signer response is not bound to the pending call');
  }
  if (value.status !== 'succeeded' && value.status !== 'failed') throw new Error('Signer response status is invalid');
  finiteJson(value, 'sign_response');
  return value as unknown as IsolatedSignerResponse;
}

function result(value: IsolatedJsonRecord, requestId: string): IsolatedRunnerResultMessage {
  return {
    type: 'result',
    protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
    request_id: requestId,
    status: 'accepted',
    result: value,
  };
}

/**
 * Start a child-side runner. The worker writes protocol frames only to
 * stdout; diagnostics and exception text are intentionally not serialized.
 * A worker entry module should call this function once at process startup.
 */
export function startIsolatedInjectedWorker(handler: IsolatedWorkerHandler): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialRequest: IsolatedRunnerRequest | undefined;
  let terminal = false;
  let outputClosed = false;
  let sequence = 0;
  const pending = new Map<string, {
    readonly kind: 'provider' | 'signer';
    readonly resolve: (value: IsolatedProviderCallResponse | IsolatedSignerResponse) => void;
    readonly reject: (error: Error) => void;
  }>();

  const write = (value: unknown): void => {
    if (outputClosed || process.stdout.destroyed) return;
    try {
      process.stdout.write(frame(value));
    } catch {
      outputClosed = true;
      terminal = true;
      process.exitCode = 1;
    }
  };
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${initialRequest?.run_id ?? 'worker'}-${prefix}-${sequence}`;
  };
  const capabilityResponse = <T extends IsolatedProviderCallResponse | IsolatedSignerResponse>(
    id: string,
    kind: 'provider' | 'signer',
  ): Promise<T> => new Promise<T>((resolve, reject) => {
    pending.set(id, { kind, resolve: resolve as (value: IsolatedProviderCallResponse | IsolatedSignerResponse) => void, reject });
  });
  const capabilities = (): IsolatedWorkerCapabilities => ({
    provider: {
      call: async input => {
        if (!initialRequest || terminal || outputClosed) throw new Error('Worker is not running');
        const requestId = nextId('provider');
        const message: IsolatedProviderCallRequest = {
          ...input,
          type: 'provider_call',
          protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
          request_id: requestId,
          run_id: initialRequest.run_id,
          worker_id: initialRequest.worker_id,
          provider: initialRequest.provider.provider,
          model: initialRequest.provider.model,
        };
        const response = capabilityResponse<IsolatedProviderCallResponse>(requestId, 'provider');
        write(message);
        return response;
      },
    },
    signer: {
      sign: async input => {
        if (!initialRequest || terminal || outputClosed) throw new Error('Worker is not running');
        const requestId = nextId('sign');
        const message: IsolatedSignerRequest = {
          ...input,
          type: 'sign_request',
          protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
          request_id: requestId,
          run_id: initialRequest.run_id,
          worker_id: initialRequest.worker_id,
          writer: initialRequest.writer,
        };
        const response = capabilityResponse<IsolatedSignerResponse>(requestId, 'signer');
        write(message);
        return response;
      },
    },
  });

  process.stdin.once('error', () => {
    terminal = true;
    process.exitCode = 1;
  });
  process.stdout.once('error', () => {
    outputClosed = true;
    terminal = true;
    process.exitCode = 1;
  });
  process.stdout.once('close', () => {
    outputClosed = true;
    terminal = true;
  });
  rl.on('line', line => {
    if (terminal) return;
    let value: unknown;
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('IPC frame is too large');
      value = JSON.parse(line) as unknown;
      finiteJson(value, 'IPC frame');
    } catch {
      terminal = true;
      process.exitCode = 1;
      return;
    }
    if (record(value) && value.type === 'provider_response') {
      try {
        if (typeof value.request_id !== 'string') throw new Error('Provider response request ID is invalid');
        const response = providerResponse(value, value.request_id);
        const waiting = pending.get(response.request_id);
        if (!waiting || waiting.kind !== 'provider') throw new Error('Unknown provider response');
        pending.delete(response.request_id);
        waiting.resolve(response);
      } catch {
        terminal = true;
        process.exitCode = 1;
      }
      return;
    }
    if (record(value) && value.type === 'sign_response') {
      try {
        if (typeof value.request_id !== 'string') throw new Error('Signer response request ID is invalid');
        const response = signerResponse(value, value.request_id);
        const waiting = pending.get(response.request_id);
        if (!waiting || waiting.kind !== 'signer') throw new Error('Unknown signer response');
        pending.delete(response.request_id);
        waiting.resolve(response);
      } catch {
        terminal = true;
        process.exitCode = 1;
      }
      return;
    }
    if (initialRequest) {
      terminal = true;
      process.exitCode = 1;
      return;
    }
    try {
      initialRequest = request(value);
    } catch {
      terminal = true;
      process.exitCode = 1;
      return;
    }
    void Promise.resolve(handler(initialRequest, capabilities())).then(payload => {
      if (terminal || !initialRequest) return;
      finiteJson(payload, 'worker.result');
      terminal = true;
      write(result(payload, initialRequest.request_id));
    }).catch(() => {
      if (terminal || !initialRequest) return;
      terminal = true;
      write({
        type: 'result',
        protocol_version: ISOLATED_RUNNER_PROTOCOL_VERSION,
        request_id: initialRequest.request_id,
        status: 'rejected',
        error: { code: 'WORKER_HANDLER_FAILED', message: 'Injected worker failed' },
      });
    });
  });
  rl.on('close', () => {
    terminal = true;
    for (const waiting of pending.values()) waiting.reject(new Error('Worker IPC closed'));
    pending.clear();
  });
}
