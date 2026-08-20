/**
 * Provider boundary for headless workers.
 *
 * The boundary deliberately carries an opaque runtime identity, not a token,
 * API key, SecretStorage handle, or credential store. A host that is allowed
 * to authorize a provider injects a client factory; the worker never discovers
 * or serializes that authorization itself.
 */

export type ProviderReasoningEffort = 'low' | 'medium' | 'high';
export type ProviderOutputMode = 'json_schema' | 'json_object' | 'text_prompt';
export type ProviderMessageRole = 'user' | 'assistant';

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string | readonly unknown[];
}

export interface AuthorizedRuntimeIdentity {
  /** Provider this runtime identity is authorized to use. */
  readonly provider: string;
  /** Human-readable identity class, never a credential value. */
  readonly kind: string;
  /** Stable, non-secret runtime identity reference for receipts/accounting. */
  readonly id: string;
  /**
   * Optional capability held by the authorized host. The adapter never calls,
   * inspects, or serializes its result; the injected client factory may use it
   * to authorize requests. Codex requires this capability.
   */
  readonly authorize?: (request: unknown) => Promise<unknown>;
}

export interface ProviderOutputSettings {
  mode?: ProviderOutputMode;
  /** Provider-neutral schema passed opaquely to the injected client. */
  schema?: unknown;
}

export interface ProviderReasoningSettings {
  enabled?: boolean;
  effort?: ProviderReasoningEffort;
}

export interface ProviderCallSettings {
  model: string;
  maxTokens: number;
  maxTokensPerCall?: number;
  system?: string;
  messages: ProviderMessage[];
  task?: string;
  output?: ProviderOutputSettings;
  reasoning?: ProviderReasoningSettings;
  /** Flat aliases ease injection from existing LLMClient call settings. */
  enableThinking?: boolean;
  reasoningEffort?: ProviderReasoningEffort;
  outputModeOverride?: ProviderOutputMode;
  temperature?: number;
  topP?: number;
  seed?: number;
}

export interface ProviderCallParams {
  model: string;
  max_tokens: number;
  maxTokensPerCall?: number;
  system?: string;
  messages: ProviderMessage[];
  task?: string;
  response_format?: { type: 'json_object'; schema?: unknown };
  outputModeOverride?: ProviderOutputMode;
  enableThinking?: boolean;
  reasoningEffort?: ProviderReasoningEffort;
  temperature?: number;
  top_p?: number;
  seed?: number;
  onFinish?: (meta: ProviderFinishMeta) => void;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ProviderFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown';

export interface ProviderFinishMeta {
  finishReason: ProviderFinishReason;
  usage?: ProviderUsage;
}

export interface ProviderTypedResponse<T = unknown> extends ProviderFinishMeta {
  text: string;
  output?: T;
  outputMode: ProviderOutputMode;
}

export interface HeadlessProviderClient {
  createMessage(params: ProviderCallParams): Promise<string>;
  createMessageWithOutput?<T = unknown>(params: ProviderCallParams): Promise<ProviderTypedResponse<T>>;
}

export interface HeadlessProviderFactoryInput {
  provider: string;
  /** Undefined is valid for local/no-auth providers; Codex is not. */
  identity?: AuthorizedRuntimeIdentity;
}

export interface HeadlessProviderClientFactory {
  createClient(
    input: HeadlessProviderFactoryInput,
  ): HeadlessProviderClient | Promise<HeadlessProviderClient>;
}

export type ProviderAttemptMethod = 'createMessage' | 'createMessageWithOutput';
export type ProviderAttemptStatus = 'succeeded' | 'failed';

export interface ProviderAttempt {
  attempt: number;
  retry: boolean;
  retryable: boolean;
  method: ProviderAttemptMethod;
  status: ProviderAttemptStatus;
  provider: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
  /** Scheduler-facing aliases keep attempt records lossless at the boundary. */
  latencyMs: number;
  retryAttempt: boolean;
  statusCode?: number;
  timedOut?: boolean;
  rateLimited?: boolean;
  retryAfterMs?: number;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  usage?: ProviderUsage;
  finishReason?: ProviderFinishReason;
  error?: string;
}

export interface ProviderCallResult<T = unknown> extends ProviderTypedResponse<T> {
  attempts: ProviderAttempt[];
}

export interface ProviderRetrySettings {
  /** Total provider calls, including the initial call. Defaults to one. */
  maxAttempts?: number;
  delayMs?: number | ((retryNumber: number, error: unknown) => number);
  shouldRetry?: (error: unknown, retryNumber: number) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface HeadlessSourceAnalyzer<TSource, TResult> {
  analyzeSource(
    source: TSource,
    options?: { contentOverride?: string },
  ): Promise<TResult | null>;
}

export interface HeadlessProviderAdapterOptions<TSource = unknown, TResult = unknown> {
  provider: string;
  identity?: AuthorizedRuntimeIdentity;
  clientFactory: HeadlessProviderClientFactory;
  retry?: ProviderRetrySettings;
  onAttempt?: (attempt: ProviderAttempt) => void;
  sourceAnalyzer?: HeadlessSourceAnalyzer<TSource, TResult>;
}
