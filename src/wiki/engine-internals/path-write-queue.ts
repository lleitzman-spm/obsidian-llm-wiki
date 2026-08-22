/** A read/modify/write callback guarded by one or more vault paths. */
export type PathWriteOperation<T> = () => Promise<T>;

export interface PathWriteQueueOptions {
  /** Paths currently present in the vault, used to preserve their casing. */
  existingPaths?: Iterable<string>;
}

/**
 * Operations that may be run while a lease is held. These deliberately do
 * not acquire another queue entry: acquiring a path already held by the same
 * callback would wait for itself forever.
 */
export interface HeldPathWriteOperations {
  <T>(path: string, operation: PathWriteOperation<T>): Promise<T>;
  readonly paths: readonly string[];
  run<T>(path: string, operation: PathWriteOperation<T>): Promise<T>;
  runRaw<T>(path: string, operation: PathWriteOperation<T>): Promise<T>;
  runHeld<T>(path: string, operation: PathWriteOperation<T>): Promise<T>;
  /** Run a path operation while an exclusive mutation boundary is held. */
  runAny<T>(path: string, operation: PathWriteOperation<T>): Promise<T>;
  release(): void;
}

export type PathWriteLease = HeldPathWriteOperations;

interface Tail {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

interface MutationBoundaryTicket {
  readonly turn: Promise<void>;
  readonly enter: () => void;
  readonly token: symbol;
}

interface ExistingPathIndex {
  readonly paths: Set<string>;
  readonly byFoldedPath: Map<string, Set<string>>;
}

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Convert a vault path to the identity used by the Windows filesystem.
 *
 * This is deliberately a validation boundary as well as a normalizer. A
 * path handed to the write queue is going to be used for a read/modify/write
 * lease, so accepting an absolute path, traversal, an ADS, or a device name
 * would make the lock protect a different resource than the caller intended.
 * The queue only accepts vault-relative file identities; the vault root is
 * not a writable file path.
 */
export function normalizeVaultPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Path write leases require a non-empty vault-relative path');
  }

  const source = path.normalize('NFC').replace(/\\/g, '/');
  if (
    source.startsWith('/') ||
    source.startsWith('//') ||
    /^[A-Za-z]:/.test(source)
  ) {
    throw new Error(`Unsafe absolute or drive path for write lease: ${path}`);
  }

  const segments: string[] = [];
  for (const segment of source.split('/')) {
    // Empty segments are harmless separator aliases (and are canonicalized
    // so `a//b` shares a lease with `a/b`). Dot segments are rejected rather
    // than resolved: resolving them can silently retarget a write.
    if (segment === '') continue;
    if (segment === '.' || segment === '..') {
      throw new Error(`Traversal path is not allowed for write lease: ${path}`);
    }
    // eslint-disable-next-line no-control-regex -- deliberate filesystem safety boundary
    if (/[\u0000-\u001f\u007f]/.test(segment)) {
      throw new Error(`Control character in write-lease path: ${path}`);
    }
    if (segment.includes(':')) {
      throw new Error(`Alternate data streams are not allowed for write lease: ${path}`);
    }
    if (/[ .]$/.test(segment)) {
      throw new Error(`Trailing dot or space in write-lease path: ${path}`);
    }
    if (WINDOWS_RESERVED_BASENAME.test(segment)) {
      throw new Error(`Reserved Windows device name in write-lease path: ${path}`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new TypeError('Path write leases require a non-empty vault-relative path');
  }
  return segments.join('/');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function asPathList(paths: string | readonly string[]): readonly string[] {
  return typeof paths === 'string' ? [paths] : paths;
}

/**
 * Serializes asynchronous read/modify/write operations per vault path.
 * Different paths do not share a queue and can continue concurrently.
 *
 * A multi-path operation obtains all of its locks in lexical order. The
 * caller receives a held/raw helper so operations on those paths can be
 * performed without re-entering this queue.
 */
export class PathWriteQueue {
  private readonly tails = new Map<string, Tail>();
  private readonly aliases = new Map<string, string>();
  private readonly existing: ExistingPathIndex = {
    paths: new Set<string>(),
    byFoldedPath: new Map<string, Set<string>>(),
  };
  private activeOperations = 0;
  private readonly mutationBoundaryQueue: MutationBoundaryTicket[] = [];
  private activeMutationBoundary: MutationBoundaryTicket | undefined;
  private stateWaiters: Array<() => void> = [];
  /**
   * This is intentionally only true while the user callback is entered. It
   * catches the synchronous form of a nested boundary without confusing a
   * separate caller which arrives while the owner is suspended.
   */
  private invokingMutationBoundary = false;

  constructor(options: PathWriteQueueOptions | Iterable<string> = {}) {
    const existingPaths = Symbol.iterator in Object(options)
      ? options as Iterable<string>
      : (options as PathWriteQueueOptions).existingPaths;
    if (existingPaths) this.setExistingPaths(existingPaths);
  }

  /** Replace the known vault-path index used for case-insensitive aliases. */
  setExistingPaths(paths: Iterable<string>): void {
    this.existing.paths.clear();
    this.existing.byFoldedPath.clear();
    this.aliases.clear();
    for (const path of paths) this.registerExistingPath(path);
  }

  /** Add one path to the known vault-path index. */
  registerExistingPath(path: string): void {
    const normalized = normalizeVaultPath(path);
    this.existing.paths.add(normalized);
    const folded = foldPath(normalized);
    const paths = this.existing.byFoldedPath.get(folded) ?? new Set<string>();
    paths.add(normalized);
    this.existing.byFoldedPath.set(folded, paths);
    // Keep one stable physical spelling even if a test double or a stale
    // index reports the same Windows identity more than once. This is what
    // makes `Foo`, `foo`, and an NFC/NFD spelling share one lease.
    if (!this.aliases.has(folded)) this.aliases.set(folded, paths.values().next().value as string);
  }

  /** Remove a physical path and forget its aliases after a verified delete. */
  unregisterExistingPath(path: string): void {
    const normalized = normalizeVaultPath(path);
    const folded = foldPath(normalized);
    this.existing.paths.delete(normalized);
    const paths = this.existing.byFoldedPath.get(folded);
    if (!paths) return;
    paths.delete(normalized);
    if (paths.size === 0) {
      this.existing.byFoldedPath.delete(folded);
      this.aliases.delete(folded);
    } else {
      this.aliases.set(folded, paths.values().next().value as string);
    }
  }

  /** Return the stable queue identity for a path alias. */
  canonicalPath(path: string): string {
    const normalized = normalizeVaultPath(path);
    const folded = foldPath(normalized);
    const existing = this.existing.byFoldedPath.get(folded);
    if (existing && existing.size > 0) {
      const identity = this.aliases.get(folded) ?? existing.values().next().value as string;
      this.aliases.set(folded, identity);
      return identity;
    }

    const alias = this.aliases.get(folded);
    if (alias) return alias;
    this.aliases.set(folded, normalized);
    return normalized;
  }

  run<T>(path: string, operation: (held: PathWriteLease) => Promise<T>): Promise<T>;
  run<T>(paths: readonly string[], operation: (held: PathWriteLease) => Promise<T>): Promise<T>;
  run<T>(paths: string | readonly string[], operation: (held: PathWriteLease) => Promise<T>): Promise<T> {
    return this.withPaths(paths, held => operation(held));
  }

  /** Execute a callback while holding every path in the supplied set. */
  async withPaths<T>(
    paths: string | readonly string[],
    operation: (held: PathWriteLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(paths);
    try {
      return await operation(lease);
    } finally {
      lease.release();
    }
  }

  /**
   * Drain admitted writes and then hold an exclusive boundary. New queue
   * operations wait until the boundary is released; its owner uses runAny for
   * the additional paths discovered during verification.
   */
  async withMutationBoundary<T>(
    paths: string | readonly string[],
    operation: (held: PathWriteLease) => Promise<T>,
  ): Promise<T> {
    if (this.invokingMutationBoundary) {
      throw new Error('Mutation boundaries are non-reentrant; use the held lease for nested work');
    }
    const rawPaths = asPathList(paths);
    if (rawPaths.length === 0) {
      throw new TypeError('Path write leases require at least one path');
    }
    // Validate before queueing a boundary ticket. A bad request must not hold
    // the global gate closed for all later callers.
    for (const path of rawPaths) normalizeVaultPath(path);

    const turn = deferred();
    const ticket: MutationBoundaryTicket = {
      turn: turn.promise,
      enter: turn.resolve,
      token: Symbol('mutation-boundary'),
    };
    this.mutationBoundaryQueue.push(ticket);
    this.pumpMutationBoundary();
    try {
      await ticket.turn;
      const lease = await this.acquire(paths, ticket.token);
      try {
        this.invokingMutationBoundary = true;
        let result: Promise<T>;
        try {
          result = operation(lease);
        } finally {
          this.invokingMutationBoundary = false;
        }
        return await result;
      } finally {
        lease.release();
      }
    } finally {
      this.releaseMutationBoundary(ticket);
    }
  }

  /** Acquire a sorted, deduplicated set of path leases. */
  async acquire(
    paths: string | readonly string[],
    boundaryToken?: symbol,
  ): Promise<PathWriteLease> {
    const rawPaths = asPathList(paths);
    if (rawPaths.length === 0) {
      throw new TypeError('Path write leases require at least one path');
    }
    // Validate before admitting an operation into the mutation accounting.
    // Otherwise a hostile path could throw after `activeOperations++` and
    // leave every future mutation boundary waiting forever.
    for (const path of rawPaths) normalizeVaultPath(path);
    const boundaryOwned = boundaryToken !== undefined;
    if (boundaryOwned) {
      if (this.activeMutationBoundary?.token !== boundaryToken) {
        throw new Error('Mutation boundary token is stale or not active');
      }
    } else {
      // Boundary tickets are admitted before this check and stay ahead of
      // every ordinary operation which arrives while they are pending.
      while (this.activeMutationBoundary || this.mutationBoundaryQueue.length > 0) {
        await new Promise<void>(resolve => this.stateWaiters.push(resolve));
      }
      this.activeOperations++;
    }

    let keys: string[] = [];
    let waiting: Array<{ key: string; previous: Promise<void>; tail: Tail }> = [];
    try {
      keys = [...new Set(rawPaths.map(path => this.canonicalPath(path)))].sort();
      waiting = keys.map(key => {
        const previous = this.tails.get(key)?.promise ?? Promise.resolve();
        const gate = deferred();
        const tail: Tail = {
          promise: previous.then(() => gate.promise),
          release: gate.resolve,
        };
        this.tails.set(key, tail);
        return { key, previous, tail };
      });

      await Promise.all(waiting.map(item => item.previous));
    } catch (error) {
      // Canonicalization or admission failures must never strand either the
      // path tail or the global ordinary-operation count.
      for (const item of waiting ?? []) {
        item.tail.release();
        if (this.tails.get(item.key) === item.tail) this.tails.delete(item.key);
      }
      if (!boundaryOwned) this.releaseOrdinaryOperation();
      throw error;
    }

    let released = false;
    const active = new Set<string>();
    const runRaw = async <T>(path: string, operation: PathWriteOperation<T>): Promise<T> => {
      if (released) throw new Error('Cannot run a raw operation after its path lease was released');
      const key = this.canonicalPath(path);
      if (!keys.includes(key)) {
        throw new Error(`Raw operation path is not held by this lease: ${path}`);
      }
      if (active.has(key)) {
        throw new Error(`Reentrant raw operation for held path: ${path}`);
      }
      active.add(key);
      try {
        return await operation();
      } finally {
        active.delete(key);
      }
    };
    const release = (): void => {
      if (released) return;
      released = true;
      for (const { key, tail } of waiting) {
        tail.release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
      if (!boundaryOwned) this.releaseOrdinaryOperation();
    };
    const runAny = async <T>(path: string, operation: PathWriteOperation<T>): Promise<T> => {
      if (released) throw new Error('Cannot run an operation after its path lease was released');
      this.canonicalPath(path);
      return operation();
    };
    const held = Object.assign(runRaw, {
      paths: keys,
      run: runRaw,
      runRaw,
      runHeld: runRaw,
      runAny,
      release,
    }) as PathWriteLease;
    return held;
  }

  private releaseOrdinaryOperation(): void {
    this.activeOperations--;
    if (this.activeOperations < 0) {
      throw new Error('Path write queue operation accounting underflow');
    }
    this.pumpMutationBoundary();
  }

  private releaseMutationBoundary(ticket: MutationBoundaryTicket): void {
    // A ticket which failed before becoming active was never removed by any
    // other owner. Removing it here makes future requests safe even if a
    // future cancellation path is added before admission.
    const queuedIndex = this.mutationBoundaryQueue.indexOf(ticket);
    if (queuedIndex >= 0) this.mutationBoundaryQueue.splice(queuedIndex, 1);
    if (this.activeMutationBoundary === ticket) this.activeMutationBoundary = undefined;
    this.pumpMutationBoundary();
  }

  private pumpMutationBoundary(): void {
    if (!this.activeMutationBoundary && this.activeOperations === 0) {
      const next = this.mutationBoundaryQueue.shift();
      if (next) {
        this.activeMutationBoundary = next;
        next.enter();
      }
    }
    const waiters = this.stateWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
