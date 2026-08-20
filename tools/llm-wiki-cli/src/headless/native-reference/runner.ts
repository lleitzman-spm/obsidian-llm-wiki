import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { TFile, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { applySettingsMigrations } from '../../../../../src/core/settings-migrations';
import { resolveModelForTask } from '../../../../../src/core/model-resolver';
import type { IngestReport, LLMClient, LLMWikiSettings } from '../../../../../src/types';
import { SchemaManager } from '../../../../../src/schema/schema-manager';
import { WikiEngine } from '../../../../../src/wiki/wiki-engine';
import { runLintWiki } from '../../../../../src/wiki/lint/controller';
import { parseFrontmatter } from '../../../../../src/core/frontmatter';
import { installObsidianGlobals } from '../../node-globals';
import { createVaultApp, type VaultApp, type VaultWriteRecord } from '../../vault';
import { canonicalJson, createContractSignature, DOMAINS } from '../crypto';
import { validateContract } from '../contracts';
import type { Receipt } from '../contracts';
import type { ContractSemanticProjection } from '../provenance/types';
import {
  captureSettingsHashes,
  projectSafeSettings,
} from '../preflight/settings';
import { assertSafeCopyRoots, type SafeCopyRoots } from '../preflight/roots';
import { captureSnapshot, type CopySnapshotManifest } from '../copy-snapshot';
import { canonicalJsonSha256 as canonicalHash, sha256Hex, sourceIdentityDigest } from '../preflight/hashing';
import { canonicalJsonSha256 } from '../preflight/hashing';
import { normalizePath as normalizeContractPath } from '../provenance/canonical';
import { buildNativeReferenceProjection } from './projection';
import {
  NATIVE_REFERENCE_SIGNING_SCOPE,
  NATIVE_REFERENCE_VERSION,
  type AuthorizedProviderIdentity,
  type NativeReferenceBinding,
  type NativeReferenceInput,
  type NativeReferencePreflight,
  type NativeReferenceRefusalCode,
  NativeReferenceRefusal,
  type NativeReferenceResult,
} from './types';

const SETTINGS_RELATIVE_PATH = '.obsidian/plugins/karpathywiki/data.json';
const ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function refuse(code: NativeReferenceRefusalCode, message: string, details: readonly string[] = []): never {
  throw new NativeReferenceRefusal(code, message, details);
}

function assertDigest(value: string, name: string): void {
  if (!DIGEST_PATTERN.test(value)) refuse('invalid-source-inventory', `${name} must be a lowercase SHA-256 digest`);
}

function assertRunId(runId: string): void {
  if (!ID_PATTERN.test(runId)) refuse('invalid-run-id', 'runId must contain only letters, numbers, dot, underscore, and hyphen');
}

function assertVaultRelativePath(value: string, name: string): string {
  try {
    return normalizeContractPath(value);
  } catch (error) {
    refuse('unsafe-wiki-folder', `${name} is not a safe vault-relative path`, [String(error)]);
  }
}

function inventoryBody(inventory: NativeReferenceInput['sourceInventory']): Record<string, unknown> {
  const { inventorySha256: _ignored, ...body } = inventory;
  return body;
}

function validateInventory(input: NativeReferenceInput): void {
  const inventory = input.sourceInventory;
  if (inventory.version !== 'source-inventory/v1') refuse('invalid-source-inventory', 'Unsupported source inventory version');
  if (!inventory.authorityTree || inventory.authorityTree.includes('\0')) {
    refuse('invalid-source-inventory', 'Source inventory authority tree is empty or contains NUL');
  }
  assertDigest(inventory.inventorySha256, 'Source inventory hash');
  if (canonicalHash(inventoryBody(inventory)) !== inventory.inventorySha256) {
    refuse('invalid-source-inventory', 'Source inventory hash does not bind its contents');
  }
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const source of inventory.sources) {
    let normalized: string;
    try {
      normalized = normalizeContractPath(source.path);
    } catch (error) {
      refuse('invalid-source-inventory', `Unsafe source path: ${source.path}`, [String(error)]);
    }
    if (normalized !== source.path) refuse('invalid-source-inventory', `Source path is not normalized: ${source.path}`);
    assertDigest(source.byteSha256, `Source hash for ${source.path}`);
    assertDigest(source.sourceIdentity, `Source identity for ${source.path}`);
    const expectedIdentity = sourceIdentityDigest(inventory.authorityTree, source.path, source.byteSha256);
    if (expectedIdentity !== source.sourceIdentity) {
      refuse('invalid-source-inventory', `Source identity does not bind ${source.path}`);
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
      refuse('invalid-source-inventory', `Invalid byte length for ${source.path}`);
    }
    if (paths.has(source.path)) refuse('invalid-source-inventory', `Duplicate source path: ${source.path}`);
    if (identities.has(source.sourceIdentity)) refuse('invalid-source-inventory', `Duplicate source identity: ${source.sourceIdentity}`);
    paths.add(source.path);
    identities.add(source.sourceIdentity);
  }
}

function selectedSources(input: NativeReferenceInput): NativeReferencePreflight['selectedSources'] {
  const byPath = new Map(input.sourceInventory.sources.map(source => [source.path, source]));
  const paths = input.sourcePaths ?? input.sourceInventory.sources.map(source => source.path);
  const unique = new Set<string>();
  const result = [];
  for (const path of paths) {
    let normalized: string;
    try {
      normalized = normalizeContractPath(path);
    } catch (error) {
      refuse('invalid-source-inventory', `Unsafe selected source path: ${path}`, [String(error)]);
    }
    if (unique.has(normalized)) refuse('invalid-source-inventory', `Duplicate selected source path: ${normalized}`);
    const source = byPath.get(normalized);
    if (!source) refuse('invalid-source-inventory', `Selected source is not in the inventory: ${normalized}`);
    unique.add(normalized);
    result.push(source);
  }
  result.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return result;
}

async function ensureArtifactDirectory(root: string, runId: string): Promise<string> {
  const directory = nodePath.join(root, runId);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      refuse('artifact-directory-not-empty', `Artifact run directory is not a plain directory: ${directory}`);
    }
    const children = await readdir(directory);
    if (children.length > 0) refuse('artifact-directory-not-empty', `Artifact run directory is not empty: ${directory}`);
  } catch (error) {
    if (error instanceof NativeReferenceRefusal) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
  }
  return directory;
}

async function writeArtifact(directory: string, name: string, value: unknown): Promise<void> {
  const path = nodePath.join(directory, name);
  try {
    await writeFile(path, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    refuse('artifact-write-failed', `Unable to write native-reference artifact ${name}`, [String(error)]);
  }
}

async function readSettings(root: string): Promise<{
  raw: Uint8Array;
  effective: LLMWikiSettings;
  safeSha256: string;
}> {
  const path = nodePath.join(root, ...SETTINGS_RELATIVE_PATH.split('/'));
  let raw: Uint8Array;
  try {
    raw = await readFile(path);
  } catch (error) {
    refuse('settings-unavailable', `Native reference settings are not readable: ${path}`, [String(error)]);
  }
  let saved: Record<string, unknown> | null;
  try {
    saved = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown> | null;
  } catch (error) {
    refuse('settings-unavailable', `Native reference settings are not valid JSON: ${path}`, [String(error)]);
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    refuse('settings-unavailable', 'Native reference settings must be a JSON object');
  }
  const { settings } = applySettingsMigrations(saved);
  const hashes = captureSettingsHashes(raw, projectSafeSettings(settings));
  return { raw, effective: settings, safeSha256: hashes.safeSettingsProjectionSha256 };
}

function assertProvider(input: NativeReferenceInput, settings: LLMWikiSettings): void {
  const provider: AuthorizedProviderIdentity | undefined = input.provider;
  if (!provider || typeof provider.provider !== 'string' || !provider.provider.trim()
    || typeof provider.model !== 'string' || !provider.model.trim()
    || typeof provider.authorizationRef !== 'string' || !provider.authorizationRef.trim()) {
    refuse('provider-identity-missing', 'An external provider identity and authorization reference are required');
  }
  if (typeof provider.createClient !== 'function') refuse('provider-client-missing', 'An externally-created LLM client is required');
  const task = input.mode === 'ingest' ? 'ingest' : 'lint';
  const expectedModel = resolveModelForTask(settings, task);
  if (settings.provider !== provider.provider || expectedModel !== provider.model) {
    refuse('provider-settings-mismatch', `Provider identity does not match copied settings for ${task}`, [
      `settings provider=${settings.provider} model=${expectedModel}`,
      `identity provider=${provider.provider} model=${provider.model}`,
    ]);
  }
  if (!input.signer.scopes.includes(NATIVE_REFERENCE_SIGNING_SCOPE)) {
    refuse('signer-scope-missing', `Signer lacks ${NATIVE_REFERENCE_SIGNING_SCOPE}`);
  }
}

function assertSettings(input: NativeReferenceInput, settings: { raw: Uint8Array; safeSha256: string }): void {
  assertDigest(input.settings.fullSha256, 'Expected settings hash');
  assertDigest(input.settings.safeProjectionSha256, 'Expected safe settings projection hash');
  const actual = sha256Hex(settings.raw);
  if (actual !== input.settings.fullSha256 || settings.safeSha256 !== input.settings.safeProjectionSha256) {
    refuse('settings-mismatch', 'Copied-vault settings do not match the exact preflight binding', [
      `expected full=${input.settings.fullSha256} actual full=${actual}`,
      `expected safe=${input.settings.safeProjectionSha256} actual safe=${settings.safeSha256}`,
    ]);
  }
}

async function verifySelectedSources(root: string, selected: NativeReferencePreflight['selectedSources']): Promise<void> {
  for (const source of selected) {
    const path = nodePath.join(root, ...source.path.split('/'));
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error) {
      refuse('source-not-found', `Selected source is not readable in copied vault: ${source.path}`, [String(error)]);
    }
    if (bytes.byteLength !== source.byteLength || sha256Hex(bytes) !== source.byteSha256) {
      refuse('source-drift', `Selected source does not match the authority inventory: ${source.path}`);
    }
  }
}

export async function preflightNativeReference(input: NativeReferenceInput): Promise<NativeReferencePreflight> {
  assertRunId(input.runId);
  validateInventory(input);
  if (!input.provider || !input.signer) refuse('provider-identity-missing', 'Provider identity and signer are required');
  let roots: SafeCopyRoots;
  try {
    roots = await assertSafeCopyRoots({
      liveRoot: input.liveRoot,
      copyRoots: [input.copiedVaultRoot, input.artifactRoot],
      syncRoots: input.syncRoots,
    });
  } catch (error) {
    refuse('unsafe-copy-root', 'Native reference roots failed containment/reparse checks', [String(error)]);
  }
  const copiedVaultRoot = roots.copyRoots[0].resolved;
  const artifactRoot = roots.copyRoots[1].resolved;
  const beforeSnapshot = await captureSnapshot({ root: copiedVaultRoot });
  const settings = await readSettings(copiedVaultRoot);
  assertSettings(input, settings);
  const wikiFolder = assertVaultRelativePath(settings.effective.wikiFolder, 'settings.wikiFolder');
  settings.effective.wikiFolder = wikiFolder;
  assertProvider(input, settings.effective);
  if (input.mode === 'lint' && settings.effective.autoSmartFix) {
    refuse('lint-smart-fix-enabled', 'Native reference lint refuses autoSmartFix because the controller would perform unreviewed mutations');
  }
  const selected = selectedSources(input);
  await verifySelectedSources(copiedVaultRoot, selected);
  return {
    roots,
    copiedVaultRoot,
    artifactRoot,
    sourceInventory: input.sourceInventory,
    selectedSources: selected,
    settings: input.settings,
    effectiveSettings: settings.effective as unknown as Record<string, unknown>,
    beforeSnapshot,
  };
}

interface NativeExecutionContext {
  readonly app: VaultApp;
  readonly client: LLMClient;
  readonly engine: WikiEngine;
  readonly settings: LLMWikiSettings;
  readonly reports: IngestReport[];
}

async function createExecutionContext(
  root: string,
  settingsValue: Record<string, unknown>,
  provider: AuthorizedProviderIdentity,
): Promise<NativeExecutionContext> {
  await installObsidianGlobals();
  const settings = settingsValue as unknown as LLMWikiSettings;
  // The native reference accepts credentials only through the injected client.
  // Prevent a legacy plaintext apiKey in copied data.json from reaching any
  // accidental client factory or output surface.
  settings.apiKey = '';
  const client = await provider.createClient();
  if (!client || typeof client.createMessage !== 'function') {
    refuse('provider-client-missing', 'External provider did not return an LLM client');
  }
  const app = createVaultApp(root, false);
  const reports: IngestReport[] = [];
  const schemaManager = new SchemaManager(app as unknown as App, settings, () => client);
  const engine = new WikiEngine(
    app as unknown as App,
    settings,
    () => client,
    schemaManager,
    () => { /* writes are collected from app.vault.writes */ },
    () => { /* native reference has no UI progress surface */ },
    report => { reports.push(report); },
    crypto.subtle,
  );
  return { app, client, engine, settings, reports };
}

function sourceFile(app: VaultApp, path: string): TFile {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (file instanceof TFile) return file;
  refuse('source-not-found', `Selected source is not indexed as a file: ${normalized}`);
}

async function executeIngest(
  context: NativeExecutionContext,
  selected: NativeReferencePreflight['selectedSources'],
  forceReingest: boolean,
): Promise<void> {
  const batchCtx = { seen: new Set<string>(), ingested: new Set<string>() };
  for (const source of selected) {
    await context.engine.ingestSource(sourceFile(context.app, source.path), {
      interactive: false,
      forceReingest,
      trigger: 'auto',
      batchCtx,
    });
    const report = context.reports.at(-1);
    if (report && !report.success) {
      refuse('native-execution-failed', `Native ingest failed for ${source.path}`, [report.errorMessage ?? 'report.success=false']);
    }
  }
}

async function executeLint(context: NativeExecutionContext): Promise<void> {
  // The native controller's manual path opens LintReportModal, which has no
  // Node equivalent.  Auto mode is the supported non-UI path; autoSmartFix is
  // rejected during preflight so this call only scans, logs its report, and
  // regenerates the index in the copied vault.
  const writesBefore = context.app.vault.writes.length;
  await runLintWiki({
    app: context.app as unknown as App,
    settings: context.settings,
    llmClient: context.client,
    wikiEngine: context.engine,
    buildSystemPrompt: task => context.engine.buildSystemPrompt(task as never),
    onAnalyzeSchema: async () => { /* no interactive schema action in reference mode */ },
  }, undefined, 'auto');
  const writes = context.app.vault.writes.slice(writesBefore);
  const lintLog = `${context.settings.wikiFolder}/log.md`;
  if (!writes.some(write => write.path === lintLog)) {
    refuse('lint-native-seam-unavailable', 'Native lint returned without writing its report; controller failure/UI seam is unverified');
  }
}

function counts(
  projection: ContractSemanticProjection,
  writes: readonly VaultWriteRecord[],
  durationMs: number,
  error: boolean,
): Record<string, number> {
  const count = (type: string) => projection.nodes.filter(node => node.type === type).length;
  return {
    sources: count('source'),
    claims: count('claim'),
    evidences: projection.edges.filter(edge => edge.type === 'evidences').length,
    pages: count('canonical-key'),
    statements: count('page-statement'),
    edges: projection.edges.length,
    creates: writes.filter(write => write.action === 'create').length,
    replaces: writes.filter(write => write.action === 'update').length,
    deletes: writes.filter(write => write.action === 'delete').length,
    attempts: 0,
    retries: 0,
    input_tokens: 0,
    output_tokens: 0,
    billed_tokens: 0,
    duration_ms: Math.max(0, Math.round(durationMs)),
    errors: error ? 1 : 0,
  };
}

function makeReceipt(
  input: NativeReferenceInput,
  afterSnapshot: CopySnapshotManifest,
  projection: ContractSemanticProjection,
  writes: readonly VaultWriteRecord[],
  durationMs: number,
  error: boolean,
): Receipt {
  const unsigned: Omit<Receipt, 'signature'> = {
    contract_version: 'headless-ingest/v1',
    receipt_id: `native/${input.runId}`,
    receipt_type: 'native',
    run_id: input.runId,
    created_at: new Date(input.now?.() ?? Date.now()).toISOString(),
    status: error ? 'rejected' : 'accepted',
    writer_fence: 1,
    target_snapshot_sha256: afterSnapshot.treeSha256,
    projection_sha256: canonicalJsonSha256(projection),
    counts: counts(projection, writes, durationMs, error),
  };
  const signedDigest = canonicalJsonSha256(unsigned);
  const signature = createContractSignature(DOMAINS.NATIVE_RECEIPT_SIGNATURE, signedDigest, input.signer);
  const receipt: Receipt = { ...unsigned, signature };
  const validation = validateContract<Receipt>('receipt', receipt);
  if (!validation.valid) {
    throw new Error(`Native receipt failed contract validation: ${validation.errors.map(errorItem => errorItem.message).join('; ')}`);
  }
  return receipt;
}

function makeBinding(
  input: NativeReferenceInput,
  preflight: NativeReferencePreflight,
  afterSnapshot: CopySnapshotManifest,
  projection: ContractSemanticProjection,
  receipt: Receipt,
): NativeReferenceBinding {
  return {
    version: 'native-reference-binding/v1',
    runId: input.runId,
    mode: input.mode,
    liveRoot: preflight.roots.liveRoot.resolved,
    copiedVaultRoot: preflight.copiedVaultRoot,
    artifactRoot: preflight.artifactRoot,
    sourceInventorySha256: input.sourceInventory.inventorySha256,
    sourceIdentities: preflight.selectedSources.map(source => source.sourceIdentity),
    settings: input.settings,
    provider: {
      provider: input.provider.provider,
      model: input.provider.model,
      authorizationRefSha256: sha256Hex(input.provider.authorizationRef),
    },
    beforeSnapshotTreeSha256: preflight.beforeSnapshot.treeSha256,
    afterSnapshotTreeSha256: afterSnapshot.treeSha256,
    projectionSha256: canonicalJsonSha256(projection),
    receiptSha256: canonicalJsonSha256(receipt),
  };
}

/**
 * Run the production WikiEngine against a verified copy only.  A rejected
 * native execution still receives a signed rejected receipt when the artifact
 * root remains writable; the caller receives the result rather than an
 * untyped success signal.
 */
export async function runNativeReference(input: NativeReferenceInput): Promise<NativeReferenceResult> {
  const preflight = await preflightNativeReference(input);
  const artifactDirectory = await ensureArtifactDirectory(preflight.artifactRoot, input.runId);
  await writeArtifact(artifactDirectory, 'native-before-snapshot.json', preflight.beforeSnapshot);

  const startedAt = Date.now();
  let executionError: string | undefined;
  let context: NativeExecutionContext | undefined;
  try {
    context = await createExecutionContext(preflight.copiedVaultRoot, preflight.effectiveSettings, input.provider);
    if (input.mode === 'ingest') {
      await executeIngest(context, preflight.selectedSources, input.forceReingest ?? true);
    } else {
      await executeLint(context);
    }
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }

  const afterSnapshot = await captureSnapshot({ root: preflight.copiedVaultRoot });
  const app = context?.app ?? createVaultApp(preflight.copiedVaultRoot, true);
  const projection = await buildNativeReferenceProjection({
    runId: input.runId,
    authorityTree: input.sourceInventory.authorityTree,
    wikiFolder: String(preflight.effectiveSettings.wikiFolder),
    sourceInventory: preflight.selectedSources,
    vault: app.vault,
  });
  const writes = context?.app.vault.writes ?? [];
  const receipt = makeReceipt(input, afterSnapshot, projection, writes, Date.now() - startedAt, executionError !== undefined);
  const binding = makeBinding(input, preflight, afterSnapshot, projection, receipt);

  await writeArtifact(artifactDirectory, 'native-after-snapshot.json', afterSnapshot);
  await writeArtifact(artifactDirectory, 'native-projection.json', projection);
  await writeArtifact(artifactDirectory, 'native-receipt.json', receipt);
  await writeArtifact(artifactDirectory, 'native-reference-binding.json', binding);

  return {
    version: NATIVE_REFERENCE_VERSION,
    runId: input.runId,
    mode: input.mode,
    status: executionError ? 'rejected' : 'accepted',
    preflight,
    beforeSnapshot: preflight.beforeSnapshot,
    afterSnapshot,
    projection,
    receipt,
    binding,
    artifactDirectory,
    reports: context?.reports ?? [],
    writes,
    ...(executionError ? { errorMessage: executionError } : {}),
  };
}
