import type {
  AuthorizedRuntimeIdentity,
  HeadlessProviderClient,
  HeadlessProviderClientFactory,
  ProviderCallParams,
  ProviderFinishReason,
  ProviderOutputMode,
  ProviderTypedResponse,
  ProviderUsage,
} from '../provider';

/** Wire version for the injected Codex/Luna host boundary. */
export const CODEX_HOST_PROTOCOL_VERSION = 'codex-host/v1' as const;
export type CodexHostProtocolVersion = typeof CODEX_HOST_PROTOCOL_VERSION;

/** The host is intentionally narrower than the provider-neutral boundary. */
export const CODEX_HOST_PROVIDER = 'openai-codex' as const;
export type CodexHostProvider = typeof CODEX_HOST_PROVIDER;

/** JSON values are the only values allowed to cross the host process boundary. */
export type HostJsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: HostJsonValue }
  | readonly HostJsonValue[];

export type CodexHostMessageContent = string | readonly HostJsonValue[];

export interface CodexHostMessage {
  readonly role: 'user' | 'assistant';
  readonly content: CodexHostMessageContent;
}

export interface CodexHostResponseFormat {
  readonly type: 'json_object';
  readonly schema?: HostJsonValue;
}

/** A JSON-only request. Prompt and source bytes are transient request data. */
export interface CodexHostRequest {
  readonly protocol_version: CodexHostProtocolVersion;
  readonly request_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  readonly provider: CodexHostProvider;
  readonly model: string;
  readonly max_tokens: number;
  readonly max_tokens_per_call?: number;
  readonly system?: string;
  readonly messages: readonly CodexHostMessage[];
  readonly task?: string;
  readonly response_format?: CodexHostResponseFormat;
  readonly output_mode?: ProviderOutputMode;
  readonly enable_thinking?: boolean;
  readonly reasoning_effort?: 'low' | 'medium' | 'high';
  readonly temperature?: number;
  readonly top_p?: number;
  readonly seed?: number;
}

export type CodexHostResponseStatus = 'succeeded' | 'failed' | 'cancelled';

export type CodexHostErrorCode =
  | 'ABORTED'
  | 'AUTHORIZATION_REQUIRED'
  | 'CAPACITY_EXHAUSTED'
  | 'HOST_PROTOCOL_ERROR'
  | 'HOST_TRANSPORT'
  | 'INVALID_REQUEST'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR';

export interface CodexHostError {
  readonly code: CodexHostErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retry_after_ms?: number;
  /** This is deliberately bounded and must not contain response/request data. */
  readonly message?: string;
}

export interface CodexHostResponse {
  readonly protocol_version: CodexHostProtocolVersion;
  readonly request_id: string;
  readonly status: CodexHostResponseStatus;
  readonly text?: string;
  readonly output?: HostJsonValue;
  readonly output_mode: ProviderOutputMode;
  readonly finish_reason: ProviderFinishReason;
  readonly usage?: ProviderUsage;
  readonly error?: CodexHostError;
}

/** Capability supplied by an authorized host; this module never discovers credentials. */
export interface CodexHostCapability {
  /**
   * Invoke the host while the request is in flight. The capability owns any
   * Codex session, browser login, SecretStorage, or network credential.
   */
  readonly invoke: (
    request: Readonly<CodexHostRequest>,
    options: { readonly signal: AbortSignal },
  ) => Promise<CodexHostResponse>;
  /** Best-effort cancellation hook for hosts with an explicit request handle. */
  readonly cancel?: (requestId: string) => void | Promise<void>;
  /** Optional live capacity signal used by an outer adaptive scheduler. */
  readonly capacity?: () => number | Promise<number>;
}

export interface CodexHostCallContext {
  readonly runId: string;
  readonly workerId: string;
  /** A non-secret source identity for host-side correlation only. */
  readonly sourceId?: string;
}

export interface CodexHostRequestOptions extends Partial<CodexHostCallContext> {
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface CodexHostLimits {
  /** Maximum simultaneous host calls. Defaults to four. */
  readonly maxInFlight?: number;
  /** Maximum queued calls beyond active calls. Defaults to 64. */
  readonly maxQueued?: number;
  /** Minimum delay between starts, useful for provider-side rate shaping. */
  readonly minIntervalMs?: number;
  /** Maximum serialized request size. Defaults to four MiB. */
  readonly maxRequestBytes?: number;
  /** Maximum serialized response size. Defaults to four MiB. */
  readonly maxResponseBytes?: number;
}

export type CodexHostLogEvent =
  | {
    readonly type: 'queued';
    readonly request_id: string;
    readonly provider: CodexHostProvider;
    readonly model: string;
    readonly queue_depth: number;
  }
  | {
    readonly type: 'started';
    readonly request_id: string;
    readonly provider: CodexHostProvider;
    readonly model: string;
    readonly request_bytes: number;
    readonly in_flight: number;
  }
  | {
    readonly type: 'completed';
    readonly request_id: string;
    readonly provider: CodexHostProvider;
    readonly model: string;
    readonly status: CodexHostResponseStatus | 'transport-error';
    readonly elapsed_ms: number;
    readonly response_bytes?: number;
    readonly error_code?: CodexHostErrorCode;
  }
  | {
    readonly type: 'rejected';
    readonly request_id: string;
    readonly provider: CodexHostProvider;
    readonly model: string;
    readonly reason: 'queue-full' | 'cancelled' | 'invalid-request' | 'oversize';
  };

export interface CodexHostBridgeOptions {
  readonly capability: CodexHostCapability;
  readonly context: CodexHostCallContext;
  readonly identity?: AuthorizedRuntimeIdentity;
  readonly limits?: CodexHostLimits;
  readonly requestIdFactory?: () => string;
  readonly now?: () => number;
  /** Receives metadata only; request messages and response content never enter events. */
  readonly onEvent?: (event: CodexHostLogEvent) => void;
}

export interface CodexHostProviderClient extends HeadlessProviderClient {
  /** Direct cancellable call for hosts that need cancellation before adapter plumbing. */
  readonly call: (
    params: ProviderCallParams,
    options?: CodexHostRequestOptions,
  ) => Promise<ProviderTypedResponse<HostJsonValue>>;
}

export interface CodexHostProviderFactory extends HeadlessProviderClientFactory {
  readonly bridge: CodexHostProviderBridgeLike;
}

/** Public surface used to avoid exposing implementation details in callers. */
export interface CodexHostProviderBridgeLike {
  readonly identity?: AuthorizedRuntimeIdentity;
  readonly capability: CodexHostCapability;
  readonly client: CodexHostProviderClient;
  readonly call: CodexHostProviderClient['call'];
}

export interface DeterministicCodexHostOptions {
  readonly handler?: (
    request: Readonly<CodexHostRequest>,
    options: { readonly signal: AbortSignal },
  ) => CodexHostResponse | Promise<CodexHostResponse>;
}

export interface DeterministicCodexHost {
  readonly capability: CodexHostCapability;
  /** Test-only transcript; never use this adapter for production artifacts. */
  readonly requests: readonly CodexHostRequest[];
  readonly reset: () => void;
}

/** A host factory lets callers inject the capability into HeadlessProviderAdapter. */
export type CodexHostFactoryBuilder = (
  options: CodexHostBridgeOptions,
) => CodexHostProviderFactory;
