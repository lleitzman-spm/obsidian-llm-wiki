import type {
  AuthorizedRuntimeIdentity,
  HeadlessProviderAdapterOptions,
  HeadlessProviderClient,
  ProviderAttempt,
  ProviderCallParams,
  ProviderCallResult,
  ProviderCallSettings,
  ProviderFinishMeta,
  ProviderOutputMode,
  ProviderRetrySettings,
  ProviderTypedResponse,
} from './types';

/** A constitutive authorization precondition, not a recoverable provider error. */
export class MissingAuthorizedRuntimeIdentityError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `Authorized runtime identity is required for provider "${provider}". `
      + 'Inject a headless-authorized runtime identity with an authorization '
      + 'capability; Obsidian SecretStorage '
      + 'credentials are not available to this adapter.',
    );
    this.name = 'MissingAuthorizedRuntimeIdentityError';
    this.provider = provider;
  }
}

/** A supplied identity cannot authorize the provider selected for the worker. */
export class ProviderIdentityMismatchError extends Error {
  constructor(provider: string, identityProvider: string) {
    super(`Runtime identity for provider "${identityProvider}" cannot authorize provider "${provider}".`);
    this.name = 'ProviderIdentityMismatchError';
  }
}

/** The host forgot to inject the source analyzer required by this worker. */
export class MissingSourceAnalyzerError extends Error {
  constructor() {
    super('A source analyzer must be injected before analyzeSource can run.');
    this.name = 'MissingSourceAnalyzerError';
  }
}

/** Read attempt evidence from a terminal provider error without changing its type. */
export function getProviderAttempts(error: unknown): readonly ProviderAttempt[] {
  if (typeof error !== 'object' || error === null || !('attempts' in error)) return [];
  const attempts = (error as { attempts?: unknown }).attempts;
  return Array.isArray(attempts) ? attempts as readonly ProviderAttempt[] : [];
}

function rethrowWithAttempts(error: unknown, attempts: readonly ProviderAttempt[]): never {
  if (typeof error === 'object' && error !== null) {
    try {
      Object.defineProperty(error, 'attempts', {
        configurable: true,
        enumerable: false,
        value: Object.freeze([...attempts]),
        writable: false,
      });
    } catch {
      // Some provider SDK errors are frozen. Preserve the original error and
      // let the onAttempt sink remain the authoritative evidence path.
    }
  }
  throw error;
}

type AnyError = { status?: unknown; code?: unknown; name?: unknown; message?: unknown };

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as AnyError).status;
  return typeof status === 'number' ? status : undefined;
}

function errorNameOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as AnyError).name;
  return typeof name === 'string' ? name : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as AnyError).code;
  return typeof code === 'string' ? code : undefined;
}

function safeStatusOf(error: unknown): number | undefined {
  const status = statusOf(error);
  return status !== undefined && Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function safeRetryAfterMsOf(error: unknown): number | undefined {
  const value = retryAfterMs(error);
  return value !== undefined && value <= 60000 ? value : undefined;
}

const SAFE_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ERR_NETWORK',
  'ERR_TIMEOUT', 'ERR_BAD_RESPONSE', 'INVALID_REQUEST', 'RATE_LIMITED',
  'TIMEOUT', 'ABORTED',
]);

function safeErrorCodeOf(error: unknown): string | undefined {
  const code = errorCodeOf(error);
  if (code === undefined || code.length > 32) return undefined;
  const normalized = code.toUpperCase();
  // Error codes are provider-controlled too. Retain only transport/runtime
  // codes whose vocabulary is closed here; an arbitrary provider "code" may
  // be an opaque key, account identifier, or embedded response data.
  return SAFE_ERROR_CODES.has(normalized) ? normalized : undefined;
}

function timedOut(error: unknown): boolean {
  const name = errorNameOf(error);
  const code = errorCodeOf(error);
  return name === 'TimeoutError' || name === 'ETIMEDOUT' || code === 'ETIMEDOUT';
}

const SAFE_ERROR_FALLBACK = 'Provider call failed';
const SAFE_ERROR_MESSAGE = /^[A-Za-z0-9][A-Za-z0-9 .,;:!?()/'-]{0,159}$/;

function errorMessageOf(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : (typeof error === 'object' && error !== null && typeof (error as AnyError).message === 'string'
      ? (error as AnyError).message as string
      : SAFE_ERROR_FALLBACK);

  // Attempt artifacts are durable operational evidence. A pattern-based
  // replacement is unsafe because arbitrary provider keys and PII do not have
  // one universal prefix. Keep a message only when it is short, single-line,
  // ASCII, free of secret-bearing field names, identifiers, contact data,
  // URLs, and token-like runs. Everything else becomes one fixed sentence.
  if (raw === SAFE_ERROR_FALLBACK || raw.length > 160 || !SAFE_ERROR_MESSAGE.test(raw)) {
    return SAFE_ERROR_FALLBACK;
  }
  if (/(?:api|access|refresh|client|private|secret|auth(?:orization|entication)?|bearer|token|key|cookie|password|credential|session|jwt)/i.test(raw)) {
    return SAFE_ERROR_FALLBACK;
  }
  if (/https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/i.test(raw)) {
    return SAFE_ERROR_FALLBACK;
  }
  const digits = raw.replace(/\D/g, '');
  // A random provider key can be completely prefix-free. Reject long
  // identifier-like runs rather than pretending prefix redaction is complete.
  if (digits.length >= 7 || /[A-Za-z0-9_-]{12,}/.test(raw)) return SAFE_ERROR_FALLBACK;
  const tokens = raw.match(/[A-Za-z0-9_-]{8,}/g) ?? [];
  if (tokens.some(token => {
    const hasDigit = /\d/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    return hasDigit && (hasUpper || hasLower);
  })) return SAFE_ERROR_FALLBACK;
  return raw;
}

function defaultShouldRetry(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 425 || status === 429 || status >= 500;
  const name = errorNameOf(error);
  const code = errorCodeOf(error);
  return name === 'TimeoutError' || name === 'ETIMEDOUT' || name === 'ECONNRESET'
    || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function defaultRetryDelay(retryNumber: number, error: unknown): number {
  return Math.min(retryAfterMs(error) ?? (250 * (2 ** Math.max(0, retryNumber - 1))), 60000);
}

function validateRetrySettings(retry: ProviderRetrySettings | undefined): void {
  if (retry?.maxAttempts !== undefined
    && (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1)) {
    throw new RangeError('retry.maxAttempts must be a positive integer');
  }
  if (typeof retry?.delayMs === 'number' && (!Number.isFinite(retry.delayMs) || retry.delayMs < 0)) {
    throw new RangeError('retry.delayMs must be a non-negative number');
  }
}

function toProviderParams(settings: ProviderCallSettings, mode: ProviderOutputMode | undefined): ProviderCallParams {
  const output = settings.output;
  const effectiveMode = settings.outputModeOverride ?? mode ?? output?.mode;
  const effectiveThinking = settings.enableThinking ?? settings.reasoning?.enabled;
  const effectiveEffort = settings.reasoningEffort ?? settings.reasoning?.effort;
  const hasStructuredOutput = output !== undefined && effectiveMode !== 'text_prompt';
  const schema = output?.schema;
  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    ...(settings.maxTokensPerCall !== undefined ? { maxTokensPerCall: settings.maxTokensPerCall } : {}),
    ...(settings.system !== undefined ? { system: settings.system } : {}),
    messages: settings.messages,
    ...(settings.task !== undefined ? { task: settings.task } : {}),
    ...(hasStructuredOutput ? {
      response_format: {
        type: 'json_object' as const,
        ...(schema !== undefined ? { schema } : {}),
      },
    } : {}),
    ...(effectiveMode !== undefined ? { outputModeOverride: effectiveMode } : {}),
    ...(effectiveThinking !== undefined ? { enableThinking: effectiveThinking } : {}),
    ...(effectiveEffort !== undefined ? { reasoningEffort: effectiveEffort } : {}),
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
    ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
  };
}

export class HeadlessProviderAdapter<TSource = unknown, TResult = unknown> {
  private readonly provider: string;
  private readonly identity?: AuthorizedRuntimeIdentity;
  private readonly clientPromise: Promise<HeadlessProviderClient>;
  private readonly retry: ProviderRetrySettings;
  private readonly onAttempt?: (attempt: ProviderAttempt) => void;
  private readonly sourceAnalyzer?: HeadlessProviderAdapterOptions<TSource, TResult>['sourceAnalyzer'];

  constructor(options: HeadlessProviderAdapterOptions<TSource, TResult>) {
    this.provider = options.provider;
    this.identity = options.identity;
    this.onAttempt = options.onAttempt;
    this.sourceAnalyzer = options.sourceAnalyzer;
    validateRetrySettings(options.retry);
    this.retry = options.retry ?? {};

    // Codex has no API-key fallback and must never be guessed from a local
    // plugin installation. The factory remains injected so the authorized
    // host decides how to construct its client.
    if (this.provider === 'openai-codex' && (!this.identity || typeof this.identity.authorize !== 'function')) {
      throw new MissingAuthorizedRuntimeIdentityError(this.provider);
    }
    if (this.identity && this.identity.provider !== this.provider) {
      throw new ProviderIdentityMismatchError(this.provider, this.identity.provider);
    }
    this.clientPromise = Promise.resolve(options.clientFactory.createClient({
      provider: this.provider,
      ...(this.identity ? { identity: this.identity } : {}),
    }));
  }

  /** Exposes the opaque identity only for non-secret run metadata. */
  getRuntimeIdentity(): AuthorizedRuntimeIdentity | undefined {
    return this.identity;
  }

  async createMessage<T = unknown>(settings: ProviderCallSettings): Promise<ProviderCallResult<T>> {
    const client = await this.clientPromise;
    // Match the production dispatch contract: once a caller opts into an
    // output contract, prefer the typed method when the injected client has
    // it, even when a provider-specific schema is not available. This keeps
    // typed-output calls visible to attempt accounting instead of silently
    // moving an output-contract call onto the legacy path.
    const typed = settings.output !== undefined && client.createMessageWithOutput !== undefined;
    const params = toProviderParams(settings, settings.output?.mode);
    const attempts: ProviderAttempt[] = [];
    const maxAttempts = this.retry.maxAttempts ?? 1;
    let retryNumber = 0;

    while (true) {
      const attemptNumber = attempts.length + 1;
      const startedAt = new Date();
      const startMs = Date.now();
      const method = typed ? 'createMessageWithOutput' as const : 'createMessage' as const;
      let finish: ProviderFinishMeta | undefined;
      const attemptParams: ProviderCallParams = {
        ...params,
        onFinish: meta => {
          finish = meta;
          params.onFinish?.(meta);
        },
      };

      try {
        let response: string | ProviderTypedResponse<T>;
        if (typed) {
          response = await client.createMessageWithOutput!(attemptParams) as ProviderTypedResponse<T>;
        } else {
          response = await client.createMessage(attemptParams);
        }
        const elapsedMs = Date.now() - startMs;
        const typedResponse: ProviderTypedResponse<T> = typeof response === 'string'
          ? {
            text: response,
            outputMode: params.outputModeOverride ?? 'text_prompt',
            finishReason: finish?.finishReason ?? 'unknown',
            ...(finish?.usage ? { usage: finish.usage } : {}),
          }
          : response;
        const attempt: ProviderAttempt = {
          attempt: attemptNumber,
          retry: retryNumber > 0,
          retryable: false,
          method,
          status: 'succeeded',
          provider: this.provider,
          model: settings.model,
          startedAt: startedAt.toISOString(),
          elapsedMs,
          latencyMs: elapsedMs,
          retryAttempt: retryNumber > 0,
          ...(typedResponse.usage ? { usage: typedResponse.usage } : {}),
          ...(typedResponse.usage?.inputTokens !== undefined ? { inputTokens: typedResponse.usage.inputTokens } : {}),
          ...(typedResponse.usage?.outputTokens !== undefined ? { outputTokens: typedResponse.usage.outputTokens } : {}),
          ...(typedResponse.finishReason ? { finishReason: typedResponse.finishReason } : {}),
        };
        attempts.push(attempt);
        this.onAttempt?.(attempt);
        return { ...typedResponse, attempts };
      } catch (error) {
        const elapsedMs = Date.now() - startMs;
        const retryable = (this.retry.shouldRetry ?? ((candidate: unknown) => defaultShouldRetry(candidate)))(error, retryNumber + 1);
        const attempt: ProviderAttempt = {
          attempt: attemptNumber,
          retry: retryNumber > 0,
          retryable,
          method,
          status: 'failed',
          provider: this.provider,
          model: settings.model,
          startedAt: startedAt.toISOString(),
          elapsedMs,
          latencyMs: elapsedMs,
          retryAttempt: retryNumber > 0,
          ...(safeStatusOf(error) !== undefined ? { statusCode: safeStatusOf(error) } : {}),
          ...(timedOut(error) ? { timedOut: true } : {}),
          ...(safeStatusOf(error) === 429 ? { rateLimited: true } : {}),
          ...(safeRetryAfterMsOf(error) !== undefined ? { retryAfterMs: safeRetryAfterMsOf(error) } : {}),
          ...(safeErrorCodeOf(error) !== undefined ? { errorCode: safeErrorCodeOf(error) } : {}),
          ...(finish?.usage ? { usage: finish.usage } : {}),
          ...(finish?.usage?.inputTokens !== undefined ? { inputTokens: finish.usage.inputTokens } : {}),
          ...(finish?.usage?.outputTokens !== undefined ? { outputTokens: finish.usage.outputTokens } : {}),
          ...(finish?.finishReason ? { finishReason: finish.finishReason } : {}),
          error: errorMessageOf(error),
        };
        attempts.push(attempt);
        this.onAttempt?.(attempt);
        if (!retryable || attemptNumber >= maxAttempts) rethrowWithAttempts(error, attempts);
        retryNumber += 1;
        const delay = typeof this.retry.delayMs === 'function'
          ? this.retry.delayMs(retryNumber, error)
          : (this.retry.delayMs ?? defaultRetryDelay(retryNumber, error));
        if (!Number.isFinite(delay) || delay < 0) throw new RangeError('retry delay must be a non-negative number');
        await (this.retry.sleep ?? defaultSleep)(delay);
      }
    }
  }

  async analyzeSource(source: TSource, options?: { contentOverride?: string }): Promise<TResult | null> {
    if (!this.sourceAnalyzer) throw new MissingSourceAnalyzerError();
    return this.sourceAnalyzer.analyzeSource(source, options);
  }
}

export function createHeadlessProviderAdapter<TSource = unknown, TResult = unknown>(
  options: HeadlessProviderAdapterOptions<TSource, TResult>,
): HeadlessProviderAdapter<TSource, TResult> {
  return new HeadlessProviderAdapter(options);
}
