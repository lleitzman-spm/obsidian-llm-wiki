/**
 * Coordinates mutations which share one WikiEngine.
 *
 * This is deliberately a small, non-reentrant FIFO lease. Callers submit a
 * whole operation, rather than acquiring the lease and retaining it across
 * unrelated work. That keeps the boundary usable by command handlers and the
 * future conversation-save path without exposing a lock-release API.
 */

export const INGESTION_LEASE_MAX_ACTIVE = 1 as const;

export interface IngestionLeaseSnapshot {
  /** Number of operations currently inside their callback (0 or 1). */
  activeCount: number;
  /** Number of submitted operations waiting for the callback turn. */
  queuedCount: number;
  /** The hard serialization contract for this coordinator. */
  maxActive: typeof INGESTION_LEASE_MAX_ACTIVE;
}

export interface IngestionLeaseOptions {
  signal?: AbortSignal;
  /** The context supplied to an operation which already owns this lease. */
  context?: IngestionLeaseContext;
  /** Token-only shorthand for internal callers which retain the capability. */
  token?: symbol;
}

/**
 * Capability passed to the owner of a lease.  Async callbacks must carry this
 * capability when they deliberately call an API which normally acquires the
 * same lease; a missing capability is never treated as ownership.  This is
 * what makes re-entry fail fast even after an await, without confusing an
 * unrelated caller which arrived while the owner was suspended.
 */
export interface IngestionLeaseContext {
  readonly engineKey: object;
  readonly token: symbol;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface LeaseState {
  /** Completion of the last ticket; every ticket resolves this promise. */
  tail: Promise<void>;
  queuedCount: number;
  activeCount: number;
  /** True only while the active callback is being entered synchronously. */
  invoking: boolean;
  /** True only before the first ticket has entered its callback. */
  idle: boolean;
  context?: IngestionLeaseContext;
}

const ingestionLeaseStates = new WeakMap<object, LeaseState>();
// The public shape is intentionally small because callers need to thread a
// context through options, but the capability itself must not be forgeable by
// copying `engineKey` and `token`.  This brand never leaves this module.
const issuedIngestionContexts = new WeakSet<object>();

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

function abortError(): DOMException {
  return new DOMException('Ingestion lease cancelled', 'AbortError');
}

/**
 * Wait for the previous ticket, but do not make a cancelled caller wait for
 * an in-flight ingest. The ticket remains in the chain and is released only
 * after its predecessor completes, so cancellation cannot let the next
 * operation overtake the operation already holding the lease.
 */
async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw abortError();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Read-only coordination evidence for diagnostics and integration tests.
 * A fresh object is returned on every call; callers cannot alter the lease.
 */
export function getIngestionLeaseSnapshot(engineKey: object): IngestionLeaseSnapshot {
  const state = ingestionLeaseStates.get(engineKey);
  return {
    activeCount: state?.activeCount ?? 0,
    queuedCount: state?.queuedCount ?? 0,
    maxActive: INGESTION_LEASE_MAX_ACTIVE,
  };
}

/**
 * Check that a context is the currently-held capability for this engine.
 * Identity in the module-private WeakSet is part of the check: a structurally
 * identical object supplied by a caller is not an issued capability.
 */
export function isActiveIngestionLeaseContext(
  engineKey: object,
  context: IngestionLeaseContext | undefined,
): boolean {
  if (!context || !issuedIngestionContexts.has(context)) return false;
  const state = ingestionLeaseStates.get(engineKey);
  return state?.context === context
    && context.engineKey === engineKey
    && state.activeCount === INGESTION_LEASE_MAX_ACTIVE;
}

function isActiveIngestionLeaseToken(engineKey: object, token: symbol): boolean {
  const state = ingestionLeaseStates.get(engineKey);
  const context = state?.context;
  return state !== undefined
    && context !== undefined
    && issuedIngestionContexts.has(context)
    && context.token === token
    && state.activeCount === INGESTION_LEASE_MAX_ACTIVE;
}

/**
 * Run one ingestion operation in FIFO order for an engine.
 *
 * The optional signal cancels a queued ticket. Once the callback has begun,
 * cancellation is owned by the callback (the signal is passed through) and
 * its finally block still releases the shared ticket, including when the
 * callback throws or rejects.
 *
 * The callback is non-reentrant: it must not call withIngestionLease again for
 * the same engine. Callers that need multiple mutations should keep them in
 * this one callback.
 */
export async function withIngestionLease<T>(
  engineKey: object,
  operation: (signal?: AbortSignal, context?: IngestionLeaseContext) => Promise<T>,
  options?: IngestionLeaseOptions | AbortSignal,
): Promise<T> {
  const signal = options && 'aborted' in options ? options : options?.signal;
  const context = options && 'aborted' in options ? undefined : options?.context;
  const token = options && 'aborted' in options ? undefined : options?.token;
  if (signal?.aborted) throw abortError();

  if (context !== undefined && !isActiveIngestionLeaseContext(engineKey, context)) {
    throw new Error('Ingestion lease context is stale, forged, or not active for this engine');
  }
  if (token !== undefined && !isActiveIngestionLeaseToken(engineKey, token)) {
    throw new Error('Ingestion lease token is stale or not active for this engine');
  }

  let state = ingestionLeaseStates.get(engineKey);
  if (!state) {
    state = { tail: Promise.resolve(), queuedCount: 0, activeCount: 0, invoking: false, idle: true };
    ingestionLeaseStates.set(engineKey, state);
  }

  // An operation can submit another operation synchronously while its own
  // callback is being entered. Queueing that request would deadlock forever;
  // reject it at the boundary. Requests made by other event-loop turns still
  // queue normally and retain FIFO ordering.
  if (state.context && context?.token === state.context.token && context.engineKey === engineKey) {
    throw new Error('Ingestion lease is non-reentrant for this engine');
  }
  if (state.context && token === state.context.token) {
    throw new Error('Ingestion lease is non-reentrant for this engine');
  }
  if (state.invoking) {
    throw new Error('Ingestion lease is non-reentrant for this engine');
  }

  const previous = state.tail;
  const current = deferred();
  // Always recover from an unexpected predecessor rejection. A failed user
  // operation must never poison the FIFO for all later callers.
  const runTail = previous.then(() => current.promise, () => current.promise);
  state.tail = runTail;
  state.queuedCount++;
  const enterSynchronously = state.idle && state.activeCount === 0 && state.queuedCount === 1;
  if (enterSynchronously) state.idle = false;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    current.resolve();
  };

  // A cancelled queued ticket remains ordered behind `previous`; resolving it
  // early would allow a later ticket to overtake the operation holding the
  // lease.
  const releaseCancelledTicket = () => {
    previous.then(release, release);
  };

  let acquired = false;
  const runOwnedOperation = async (): Promise<T> => {
    state.queuedCount--;
    state.activeCount++;
    acquired = true;
    if (state.activeCount > INGESTION_LEASE_MAX_ACTIVE) {
      state.activeCount--;
      release();
      throw new Error('Ingestion lease serialization invariant violated');
    }

    let ownerContext: IngestionLeaseContext | undefined;
    let revokeContext: (() => void) | undefined;
    try {
      ownerContext = Object.freeze({ engineKey, token: Symbol('ingestion-lease') });
      issuedIngestionContexts.add(ownerContext);
      state.context = ownerContext;
      revokeContext = () => { issuedIngestionContexts.delete(ownerContext!); };
      if (signal) signal.addEventListener('abort', revokeContext, { once: true });
      if (signal?.aborted) revokeContext();
      state.invoking = true;
      let operationResult: Promise<T>;
      try {
        operationResult = operation(signal, ownerContext);
      } finally {
        state.invoking = false;
      }
      return await operationResult;
    } finally {
      // Remove the capability before releasing the FIFO ticket.  This also
      // makes cancellation invalidate it immediately via the abort listener,
      // even if an operation takes time to observe its signal.
      if (revokeContext) signal?.removeEventListener('abort', revokeContext);
      if (ownerContext) issuedIngestionContexts.delete(ownerContext);
      state.activeCount--;
      state.context = undefined;
      release();
      if (state.tail === runTail && state.queuedCount === 0 && state.activeCount === 0) {
        state.idle = true;
        ingestionLeaseStates.delete(engineKey);
      }
    }
  };
  try {
    // The first ticket is entered without a promise turn. This preserves
    // synchronous lifecycle setup (notably the ingest cancellation handle)
    // while queued callers still wait behind its released ticket.
    if (enterSynchronously) {
      if (signal?.aborted) throw abortError();
      return await runOwnedOperation();
    }
    await waitForTurn(previous, signal);
    // Abort may race the predecessor's final resolution. Do not enter the
    // callback after that cancellation, but still keep this ticket ordered.
    if (signal?.aborted) throw abortError();
    return await runOwnedOperation();
  } catch (error) {
    // If waiting failed for an unexpected reason, do not poison the shared
    // chain. The callback path above has already released its own ticket.
    if (!acquired && !released) {
      state.queuedCount--;
      if (enterSynchronously) state.idle = true;
      releaseCancelledTicket();
    }
    if (signal?.aborted) throw abortError();
    throw error;
  }
}
