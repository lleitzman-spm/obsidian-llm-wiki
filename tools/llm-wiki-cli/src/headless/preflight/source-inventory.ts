import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from './hashing';

export interface GitCommandResult {
  status?: number;
  code?: number;
  stdout: string | Uint8Array;
  stderr?: string | Uint8Array;
  sha256?: string;
}

/** Injectable command boundary keeps inventory tests independent of a checkout. */
export interface GitCommand {
  run?(args: readonly string[]): GitCommandResult | Promise<GitCommandResult>;
  execute?(args: readonly string[]): GitCommandResult | Promise<GitCommandResult>;
}

export type GitCommandInput = GitCommand | ((args: readonly string[]) => GitCommandResult | Promise<GitCommandResult>);

export interface SourceSelector {
  version: string;
  include: readonly string[];
  exclude: readonly string[];
}

export interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  byteLength: number;
  path: string;
}

export interface SourceInventoryEntry {
  path: string;
  byteLength: number;
  byteSha256: string;
  sourceIdentity: string;
}

export interface SourceInventory {
  version: 'source-inventory/v1';
  authorityTree: string;
  selectorVersion: string;
  includes: string[];
  exclusions: string[];
  sources: SourceInventoryEntry[];
  snapshotTreeHash: string;
  inventorySha256: string;
}

export interface ContractSourceInventoryOptions {
  repositoryUrl: string;
  commit: string;
  inventoryId: string;
}

export interface BuildSourceInventoryOptions {
  authorityTree: string;
  git: GitCommandInput;
  selector: SourceSelector;
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function asText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFKC');
  if (normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`Unsafe Git path: ${path}`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..') || parts.length === 0) {
    throw new Error(`Unsafe Git path: ${path}`);
  }
  return parts.join('/');
}

function globRegex(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      i += 1;
      if (normalized[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

function selected(path: string, selector: SourceSelector): boolean {
  const includes = selector.include.map(globRegex);
  const excludes = selector.exclude.map(globRegex);
  return includes.some(pattern => pattern.test(path)) && !excludes.some(pattern => pattern.test(path));
}

function checkedResult(result: GitCommandResult, operation: string): GitCommandResult {
  const status = result.status ?? result.code ?? 0;
  if (status !== 0) {
    const stderr = asText(result.stderr ?? '');
    throw new Error(`Git ${operation} failed (${status}): ${stderr}`);
  }
  return result;
}

async function runGit(git: GitCommandInput, args: readonly string[]): Promise<GitCommandResult> {
  if (typeof git === 'function') return git(args);
  if (git.run) return git.run(args);
  if (git.execute) return git.execute(args);
  throw new Error('Git command adapter must expose run or execute');
}

function parseTree(stdout: string | Uint8Array): GitTreeEntry[] {
  const records = asText(stdout).split('\0').filter(Boolean);
  return records.map(record => {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error(`Invalid Git tree record: ${record}`);
    const [mode, type, objectId] = record.slice(0, firstTab).split(' ');
    const byteLength = Number(record.slice(firstTab + 1, secondTab));
    const path = normalizePath(record.slice(secondTab + 1));
    if (!mode || !type || !objectId || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`Invalid Git tree record: ${record}`);
    }
    return { mode, type, objectId, byteLength, path };
  });
}

function validateTree(value: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw new Error(`Invalid authority tree: ${value}`);
}

export async function buildSourceInventory(options: BuildSourceInventoryOptions): Promise<SourceInventory> {
  validateTree(options.authorityTree);
  if (!options.selector.version) throw new Error('Source selector version is required');
  if (options.selector.include.length === 0) throw new Error('Source selector must include at least one pattern');

  const treeResult = checkedResult(await runGit(options.git, [
    'ls-tree', '-r', '-l', '-z', '--full-tree', options.authorityTree, '--',
  ]), 'ls-tree');
  const entries = parseTree(treeResult.stdout)
    .filter(entry => entry.type === 'blob')
    .filter(entry => selected(entry.path, options.selector));

  const sources: SourceInventoryEntry[] = [];
  for (const entry of entries) {
    const blobResult = checkedResult(await runGit(options.git, [
      'show', `${options.authorityTree}:${entry.path}`,
    ]), `show ${entry.path}`);
    const content = asBytes(blobResult.stdout);
    if (content.byteLength !== entry.byteLength) {
      throw new Error(`Git source byte length mismatch for ${entry.path}: expected ${entry.byteLength}, got ${content.byteLength}`);
    }
    const byteSha256 = sha256Hex(content);
    if (blobResult.sha256 !== undefined && blobResult.sha256.toLowerCase() !== byteSha256) {
      throw new Error(`Git source hash mismatch for ${entry.path}`);
    }
    const sourceIdentity = sourceIdentityDigest(options.authorityTree, entry.path, byteSha256);
    sources.push({ path: entry.path, byteLength: content.byteLength, byteSha256, sourceIdentity });
  }

  sources.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const snapshot = snapshotTreeHash(sources);
  const body = {
    version: 'source-inventory/v1',
    authorityTree: options.authorityTree,
    selectorVersion: options.selector.version,
    includes: [...options.selector.include].map(normalizePath).sort(),
    exclusions: [...options.selector.exclude].map(normalizePath).sort(),
    sources,
    snapshotTreeHash: snapshot,
  } as const;
  return { ...body, inventorySha256: canonicalJsonSha256(body) };
}

export const createSourceInventory = buildSourceInventory;

/** Adapt the verified preflight inventory to the checked-in headless contract shape. */
export function toContractSourceInventory(
  inventory: SourceInventory,
  options: ContractSourceInventoryOptions,
): {
  contract_version: 'headless-ingest/v1';
  inventory_id: string;
  authority: { repository_url: string; commit: string; tree: string };
  selector: { version: string; include: string; exclusions: string[] };
  sources: Array<{
    authority_tree: string;
    path: string;
    byte_sha256: string;
    source_identity_sha256: string;
    byte_count: number;
  }>;
  inventory_sha256: string;
} {
  return {
    contract_version: 'headless-ingest/v1',
    inventory_id: options.inventoryId,
    authority: { repository_url: options.repositoryUrl, commit: options.commit, tree: inventory.authorityTree },
    selector: {
      version: inventory.selectorVersion,
      include: inventory.includes.join(','),
      exclusions: inventory.exclusions,
    },
    sources: inventory.sources.map(source => ({
      authority_tree: inventory.authorityTree,
      path: source.path,
      byte_sha256: source.byteSha256,
      source_identity_sha256: source.sourceIdentity,
      byte_count: source.byteLength,
    })),
    inventory_sha256: inventory.inventorySha256,
  };
}

export function matchesSourceSelector(path: string, selector: SourceSelector): boolean {
  return selected(normalizePath(path), selector);
}
