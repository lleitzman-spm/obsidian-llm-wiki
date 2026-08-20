import {
  canonicalJsonSha256,
  snapshotTreeHash,
  type SnapshotHashEntry,
} from './hashing';
import {
  captureSettingsHashes,
  projectSafeSettings,
  type SettingsHashes,
} from './settings';
import {
  assertSafeCopyRoots,
  type RootProbe,
  type SafeCopyRoots,
} from './roots';
import type { SourceInventory } from './source-inventory';

export interface PreflightManifestInput {
  authorityTree: string;
  sourceInventory: SourceInventory;
  liveRoot: string;
  copyRoots: readonly string[];
  syncRoots?: readonly string[];
  rootProbe?: RootProbe;
  fullSettingsBytes: Uint8Array;
  settings: unknown;
  safeSettingsOptions?: Parameters<typeof projectSafeSettings>[1];
  snapshotEntries?: readonly SnapshotHashEntry[];
  runtimeHashes?: Readonly<Record<string, string>>;
  now?: number;
  capturedAt?: string;
}

export interface PreflightManifest {
  version: 'preflight-capture/v1';
  capturedAt: string;
  authorityTree: string;
  sourceInventorySha256: string;
  sourceInventory: SourceInventory;
  settings: SettingsHashes;
  roots: SafeCopyRoots;
  snapshotTreeHash: string;
  runtimeHashes: Record<string, string>;
  manifestSha256: string;
}

export interface PreflightCaptureInput {
  captureType: 'initial' | 'live';
  runId: string;
  windowId: string;
  capturedAt?: string;
  now?: number;
  vaultIdentity: string;
  liveRoot: string;
  copyRoots: { native: string; candidate: string };
  syncRoots?: readonly string[];
  rootProbe?: RootProbe;
  idle: boolean;
  authorityCommit: string;
  authorityTree: string;
  runtimeSha256: string;
  schemaSha256: string;
  fullSettingsBytes: Uint8Array;
  settings: unknown;
  safeSettingsOptions?: Parameters<typeof projectSafeSettings>[1];
  snapshotTreeSha256: string;
}

/** Capture the unsigned, contract-shaped facts that a caller may subsequently sign. */
export async function capturePreflightCapture(input: PreflightCaptureInput): Promise<{
  contract_version: 'headless-ingest/v1';
  capture_type: 'initial' | 'live';
  run_id: string;
  window_id: string;
  captured_at: string;
  vault: { identity: string; root: string; snapshot_tree_sha256: string };
  idle: boolean;
  hashes: {
    authority_commit: string;
    authority_tree: string;
    runtime_sha256: string;
    schema_sha256: string;
    settings_sha256: string;
    safe_settings_projection_sha256: string;
  };
  copy_roots: { native: string; candidate: string };
  roots_outside_live_and_sync: true;
}> {
  if (!input.idle) throw new Error('Preflight capture requires an idle runtime');
  const roots = await assertSafeCopyRoots({
    liveRoot: input.liveRoot,
    copyRoots: [input.copyRoots.native, input.copyRoots.candidate],
    syncRoots: input.syncRoots,
    probe: input.rootProbe,
  });
  const settings = captureSettingsHashes(
    input.fullSettingsBytes,
    projectSafeSettings(input.settings, input.safeSettingsOptions),
  );
  const capturedAt = input.capturedAt ?? new Date(input.now ?? Date.now()).toISOString();
  return {
    contract_version: 'headless-ingest/v1',
    capture_type: input.captureType,
    run_id: input.runId,
    window_id: input.windowId,
    captured_at: capturedAt,
    vault: {
      identity: input.vaultIdentity,
      root: roots.liveRoot.resolved,
      snapshot_tree_sha256: input.snapshotTreeSha256,
    },
    idle: input.idle,
    hashes: {
      authority_commit: input.authorityCommit,
      authority_tree: input.authorityTree,
      runtime_sha256: input.runtimeSha256,
      schema_sha256: input.schemaSha256,
      settings_sha256: settings.fullSettingsSha256,
      safe_settings_projection_sha256: settings.safeSettingsProjectionSha256,
    },
    copy_roots: {
      native: roots.copyRoots[0].resolved,
      candidate: roots.copyRoots[1].resolved,
    },
    roots_outside_live_and_sync: true,
  };
}

export async function capturePreflightManifest(input: PreflightManifestInput): Promise<PreflightManifest> {
  if (input.sourceInventory.authorityTree !== input.authorityTree) {
    throw new Error('Source inventory authority tree does not match preflight authority tree');
  }
  const roots = await assertSafeCopyRoots({
    liveRoot: input.liveRoot,
    copyRoots: input.copyRoots,
    syncRoots: input.syncRoots,
    probe: input.rootProbe,
  });
  const safeSettingsProjection = projectSafeSettings(input.settings, input.safeSettingsOptions);
  const settings = captureSettingsHashes(input.fullSettingsBytes, safeSettingsProjection);
  const capturedAt = input.capturedAt ?? new Date(input.now ?? Date.now()).toISOString();
  const snapshotHash = input.snapshotEntries
    ? snapshotTreeHash(input.snapshotEntries)
    : input.sourceInventory.snapshotTreeHash;
  const body = {
    version: 'preflight-capture/v1' as const,
    capturedAt,
    authorityTree: input.authorityTree,
    sourceInventorySha256: input.sourceInventory.inventorySha256,
    sourceInventory: input.sourceInventory,
    settings,
    roots,
    snapshotTreeHash: snapshotHash,
    runtimeHashes: Object.fromEntries(Object.entries(input.runtimeHashes ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
  return { ...body, manifestSha256: canonicalJsonSha256(body) };
}

export const capturePreflight = capturePreflightManifest;
export const captureManifest = capturePreflightManifest;
