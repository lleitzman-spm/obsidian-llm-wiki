export interface LeaseIdentity {
  ownerId: string;
  runId: string;
}

export interface LeaseRecord extends LeaseIdentity {
  protocol: 'spm-headless-filesystem-lease/v1';
  fence: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface FreezeMarker extends LeaseIdentity {
  protocol: 'spm-headless-filesystem-freeze/v1';
  fence: number;
  frozenAt: number;
  reason: string;
}

export interface LeaseOptions {
  /** Lease lifetime and heartbeat extension in milliseconds. */
  ttlMs?: number;
  /** Injectable wall clock for deterministic tests; production uses Date.now. */
  now?: () => number;
  /** Name of the metadata directory below the supplied root. */
  directoryName?: string;
  /**
   * Optional directory outside the protected root in which lease metadata is
   * kept. When omitted, metadata remains backwards-compatible beneath root.
   */
  metadataRoot?: string;
}

export interface LeaseHandle {
  readonly record: LeaseRecord;
  heartbeat(): Promise<LeaseRecord>;
  /** Transaction-writer compatible fence assertion. */
  assertFence(fence: number | string): Promise<void>;
  checkBeforeWrite(): Promise<LeaseRecord>;
  checkBeforeFinalCommit(): Promise<LeaseRecord>;
  withWriteFence<T>(operation: () => Promise<T>): Promise<T>;
  withFinalCommit<T>(operation: () => Promise<T>): Promise<T>;
  freeze(reason: string): Promise<FreezeMarker>;
  freeze(fence: number | string, reason: string): Promise<FreezeMarker>;
  release(): Promise<void>;
}
