import type { DomainName } from '../crypto';
import type { SourceInventory } from '../preflight/source-inventory';

/**
 * The child process wire is deliberately narrower than the native runner's
 * in-process input. Functions, KeyObjects, clients, and opaque host handles
 * are not representable here and therefore cannot accidentally be serialized.
 */
export const ISOLATED_RUNNER_PROTOCOL_VERSION = 'headless-isolated-runner/v1' as const;

export type IsolatedRunnerProtocolVersion = typeof ISOLATED_RUNNER_PROTOCOL_VERSION;

export type IsolatedJsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: IsolatedJsonValue }
  | readonly IsolatedJsonValue[];

export interface IsolatedJsonRecord {
  readonly [key: string]: IsolatedJsonValue;
}

export interface IsolatedRunnerSettingsBinding {
  readonly full_sha256: string;
  readonly safe_projection_sha256: string;
}

export interface IsolatedRunnerProviderIdentity {
  readonly provider: string;
  readonly model: string;
  /** Hash binding only. The raw grant reference never crosses the process wire. */
  readonly authorization_ref_sha256: string;
}

/**
 * The writer fence is required on every isolated run.  The candidate path is
 * represented only by a hash because the native worker must not receive a
 * candidate-vault path or any live-root alias.
 */
export interface IsolatedRunnerWriterBinding {
  readonly owner_id: string;
  readonly run_id: string;
  readonly fence: number;
  readonly candidate_root_sha256: string;
}

export interface IsolatedRunnerRequest {
  readonly type: 'run';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  readonly operation: 'native-reference';
  readonly mode: 'ingest' | 'lint';
  /** The only vault root visible in the request. Never send a live root. */
  readonly copied_vault_root: string;
  /** Artifacts are a separate explicit root and are never inferred by worker input. */
  readonly artifact_root: string;
  readonly source_inventory: SourceInventory;
  readonly source_paths: readonly string[];
  readonly settings: IsolatedRunnerSettingsBinding;
  readonly provider: IsolatedRunnerProviderIdentity;
  /** Per-run signer attenuation; an empty set means no signer domain is allowed. */
  readonly signer_domains: readonly DomainName[];
  readonly writer: IsolatedRunnerWriterBinding;
}

export interface IsolatedProviderMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly IsolatedJsonValue[];
}

export interface IsolatedProviderCallRequest {
  readonly type: 'provider_call';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  readonly provider: string;
  readonly model: string;
  readonly max_tokens: number;
  readonly max_tokens_per_call?: number;
  readonly system?: string;
  readonly messages: readonly IsolatedProviderMessage[];
  readonly task?: string;
  readonly response_format?: {
    readonly type: 'json_object';
    readonly schema?: IsolatedJsonValue;
  };
  readonly output_mode?: 'json_schema' | 'json_object' | 'text_prompt';
  readonly enable_thinking?: boolean;
  readonly reasoning_effort?: 'low' | 'medium' | 'high';
  readonly temperature?: number;
  readonly top_p?: number;
  readonly seed?: number;
}

export interface IsolatedProviderCallResponse {
  readonly type: 'provider_response';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly text?: string;
  readonly output?: IsolatedJsonValue;
  readonly output_mode?: 'json_schema' | 'json_object' | 'text_prompt';
  readonly finish_reason?: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  /** Bounded, non-secret diagnostics only. */
  readonly error_code?: string;
}

export interface IsolatedSignerRequest {
  readonly type: 'sign_request';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  /** The sealed writer lease context copied from the initial run request. */
  readonly writer: IsolatedRunnerWriterBinding;
  readonly domain: DomainName;
  readonly digest: string;
}

/**
 * Host-only signer context.  This is deliberately not a credential or a
 * process-wire grant: it lets the host signer bind a request to the exact
 * worker lease that opened this run.
 */
export interface IsolatedSignerContext {
  readonly workerId: string;
  readonly runId: string;
  readonly writer: IsolatedRunnerWriterBinding;
  readonly fence: number;
  readonly domain: DomainName;
  readonly digest: string;
}

export interface IsolatedSignerResponse {
  readonly type: 'sign_response';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly status: 'succeeded' | 'failed';
  readonly key_id?: string;
  readonly signature?: string;
  readonly error_code?: string;
}

export interface IsolatedRunnerResultMessage {
  readonly type: 'result';
  readonly protocol_version: IsolatedRunnerProtocolVersion;
  readonly request_id: string;
  readonly status: 'accepted' | 'rejected';
  readonly result?: IsolatedJsonRecord;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type IsolatedChildMessage =
  | IsolatedProviderCallRequest
  | IsolatedSignerRequest
  | IsolatedRunnerResultMessage;

export type IsolatedHostMessage =
  | IsolatedRunnerRequest
  | IsolatedProviderCallResponse
  | IsolatedSignerResponse;

export interface IsolatedProviderCapability {
  readonly provider: string;
  readonly model: string;
  /** Host-only grant reference; the runner sends only its SHA-256 binding. */
  readonly authorizationRef: string;
  readonly call: (
    request: IsolatedProviderCallRequest,
    options: { readonly signal: AbortSignal },
  ) => Omit<IsolatedProviderCallResponse, 'type' | 'protocol_version' | 'request_id'>
    | Promise<Omit<IsolatedProviderCallResponse, 'type' | 'protocol_version' | 'request_id'>>;
}

export interface IsolatedSignerCapability {
  /** Optional capability-level ceiling; a run may only attenuate this set. */
  readonly allowedDomains?: readonly DomainName[];
  readonly sign: (
    request: IsolatedSignerRequest,
    options: { readonly signal: AbortSignal; readonly context: IsolatedSignerContext },
  ) => Omit<IsolatedSignerResponse, 'type' | 'protocol_version' | 'request_id'>
    | Promise<Omit<IsolatedSignerResponse, 'type' | 'protocol_version' | 'request_id'>>;
}

export type IsolatedResourceLimit =
  | { readonly memoryBytes?: number; readonly cpuTimeMs?: number };

export interface IsolatedRunnerResourceLimiter {
  /** Apply an OS-level limit to a live PID; return cleanup for normal exit. */
  readonly apply: (
    pid: number,
    limits: IsolatedResourceLimit,
    options?: { readonly signal: AbortSignal },
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface IsolatedRunnerEvent {
  readonly type:
    | 'started'
    | 'provider-requested'
    | 'provider-completed'
    | 'sign-requested'
    | 'sign-completed'
    | 'completed'
    | 'refused'
    | 'timeout'
    | 'cancelled';
  readonly request_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  readonly operation?: 'native-reference';
  readonly status?: 'accepted' | 'rejected';
  readonly error_code?: string;
}

export interface IsolatedRunnerInput {
  readonly runId: string;
  readonly sourceInventory: SourceInventory;
  readonly settings: {
    readonly fullSha256: string;
    readonly safeProjectionSha256: string;
  };
  readonly sourcePaths?: readonly string[];
  readonly mode?: 'ingest' | 'lint';
  /** The current host writer/lease binding; required for the isolated seam. */
  readonly writer: {
    readonly ownerId: string;
    readonly runId: string;
    readonly fence: number;
    readonly candidateRootSha256: string;
  };
  /** Per-run signer attenuation.  The host never signs outside this set. */
  readonly signer?: {
    readonly allowedDomains: readonly DomainName[];
  };
  /** Optional host identity override; it remains metadata, never a credential. */
  readonly provider?: {
    readonly provider: string;
    readonly model: string;
    /** Host-only grant reference; never serialized into the child request. */
    readonly authorizationRef: string;
    /** Deliberately ignored; functions never cross the process wire. */
    readonly createClient?: () => unknown;
  };
}

export interface IsolatedRunnerRunOptions {
  readonly signal?: AbortSignal;
}

export interface IsolatedRunnerOutcome {
  readonly status: 'accepted' | 'rejected';
  readonly result?: IsolatedJsonRecord;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
