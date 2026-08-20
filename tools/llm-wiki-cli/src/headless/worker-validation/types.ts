import type { KeyRegistry } from '../crypto';
import type { SourceIdentity, WorkerArtifact } from '../contracts';

export type WorkerBytes = string | Uint8Array;

/**
 * The authority facts against which one untrusted worker result is checked.
 * None of these values are taken from the worker artifact itself.
 */
export interface WorkerArtifactValidationContext {
  readonly registry: KeyRegistry;
  readonly runManifest?: {
    readonly run_id: string;
    readonly job_id: string;
    readonly authority: { readonly tree: string };
    readonly workers: ReadonlyArray<{
      readonly worker_id: string;
      readonly key_id: string;
      readonly public_key: string;
      readonly source_identity_sha256: string;
      readonly allowed_partition: string;
    }>;
    readonly target_vault: { readonly writer_fence: number };
  };
  readonly authorityTree?: string;
  readonly sources?: readonly SourceIdentity[];
  readonly runId?: string;
  readonly jobId?: string;
  readonly workerId?: string;
  readonly partition?: string;
  readonly fence?: number | string;
  readonly requiredScope?: string;
  /** Raw authority bytes, if available, for an independent hash/length check. */
  readonly sourceBytes?: WorkerBytes;
  /** Canonicalized source bytes, if available, for an exact evidence slice check. */
  readonly canonicalSourceBytes?: WorkerBytes;
  readonly now?: Date | string;
  readonly maxAgeSeconds?: number;
}

export interface WorkerArtifactValidationError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export type WorkerArtifactValidationResult =
  | { readonly valid: true; readonly data: WorkerArtifact; readonly errors: readonly [] }
  | { readonly valid: false; readonly data: WorkerArtifact; readonly errors: readonly WorkerArtifactValidationError[] };
