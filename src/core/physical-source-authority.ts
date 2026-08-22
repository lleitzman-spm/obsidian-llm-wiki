import { normalizePath } from 'obsidian';
import type { DataAdapter, TFile } from 'obsidian';
import { COMPATIBLE_SOURCE_EXTENSIONS } from '../constants';
import { isExcludedFromSourcePicker, isInFolderScope } from './folder-scope';

export interface PhysicalSourceCheck {
  exists: boolean;
  error?: string;
  source?: AuthoritativeSourceSnapshot;
}

/**
 * The one source snapshot that may be used for quote grounding.
 *
 * The brand is intentionally runtime-backed by a WeakSet below.  A caller
 * cannot manufacture an object with these fields and make it authoritative;
 * it must come from `readAuthoritativeSource`, which reads the adapter once.
 */
export interface AuthoritativeSourceSnapshot {
  readonly path: string;
  readonly content: string;
  readonly bytes: Uint8Array;
}

export class PhysicalSourceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhysicalSourceAuthorityError';
  }
}

const MAX_PHYSICAL_SCAN_DEPTH = 64;
const MAX_PHYSICAL_SCAN_PATHS = 100_000;
const authoritativeSnapshots = new WeakSet<object>();

function normalizePhysicalPath(path: string): string {
  return normalizePath(path).replace(/\\/g, '/');
}

/** Vault paths are case-insensitive on the Windows vaults this plugin supports. */
function physicalPathIdentity(path: string): string {
  return normalizePhysicalPath(path).normalize('NFC').toLowerCase();
}

/** Runtime capability check for the unforgeable source snapshot brand. */
export function isAuthoritativeSourceSnapshot(value: unknown): value is AuthoritativeSourceSnapshot {
  return typeof value === 'object' && value !== null && authoritativeSnapshots.has(value);
}

/**
 * Read one normalized vault path and freeze the exact bytes used downstream.
 *
 * This deliberately does not call `exists` first.  A check followed by a
 * later read creates a TOCTOU window; the adapter read itself is the
 * authoritative presence check and the returned snapshot is the read result.
 */
export async function readAuthoritativeSource(
  adapter: Pick<DataAdapter, 'read'>,
  path: string,
): Promise<AuthoritativeSourceSnapshot> {
  const normalizedPath = normalizePhysicalPath(path);
  let content: string;
  try {
    content = await adapter.read(normalizedPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PhysicalSourceAuthorityError(
      `Could not read authoritative source file from disk: ${normalizedPath} (${reason})`,
    );
  }
  if (typeof content !== 'string') {
    throw new PhysicalSourceAuthorityError(
      `Authoritative source adapter returned non-text content: ${normalizedPath}`,
    );
  }

  const sourceBytes = new TextEncoder().encode(content);
  const snapshot = Object.freeze({
    path: normalizedPath,
    content,
    // Return a fresh copy on every access, so callers cannot mutate the bytes
    // held by the authority token after the read has completed.
    get bytes(): Uint8Array {
      return Uint8Array.from(sourceBytes);
    },
  });
  authoritativeSnapshots.add(snapshot);
  return snapshot;
}

export async function checkPhysicalSource(
  adapter: Pick<DataAdapter, 'exists'> & Partial<Pick<DataAdapter, 'read'>>,
  path: string,
): Promise<PhysicalSourceCheck> {
  const normalizedPath = normalizePhysicalPath(path);
  // When the adapter can read, the read result is the check.  This keeps
  // callers that need a preflight result from introducing an exists→read
  // TOCTOU window.  The exists-only fallback preserves compatibility with
  // narrow test adapters and older hosts.
  if (adapter.read) {
    try {
      const source = await readAuthoritativeSource({ read: adapter.read }, normalizedPath);
      return { exists: true, source };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        exists: false,
        error: reason,
      };
    }
  }
  try {
    const exists = await adapter.exists(normalizedPath);
    return exists
      ? { exists: true }
      : { exists: false, error: `Source file is no longer present on disk: ${normalizedPath}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      exists: false,
      error: `Could not verify source file on disk: ${normalizedPath} (${reason})`,
    };
  }
}

async function listPhysicalFilesRecursive(
  adapter: Pick<DataAdapter, 'list'>,
  folderPath: string,
  isExcluded: (path: string) => boolean,
): Promise<Set<string>> {
  const files = new Set<string>();
  const pending = [{ path: folderPath === '/' ? '' : normalizePath(folderPath), depth: 0 }];
  const visited = new Set<string>();
  let discoveredPaths = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current.path)) continue;
    if (current.depth > MAX_PHYSICAL_SCAN_DEPTH) {
      throw new PhysicalSourceAuthorityError(
        `Physical source scan exceeded the maximum depth of ${MAX_PHYSICAL_SCAN_DEPTH}; refusing a possible junction cycle.`,
      );
    }
    visited.add(current.path);

    let listing: Awaited<ReturnType<DataAdapter['list']>>;
    try {
      listing = await adapter.list(current.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PhysicalSourceAuthorityError(
        `Could not list source folder on disk: ${current.path || '/'} (${reason})`,
      );
    }
    discoveredPaths += listing.files.length + listing.folders.length;
    if (discoveredPaths > MAX_PHYSICAL_SCAN_PATHS) {
      throw new PhysicalSourceAuthorityError(
        `Physical source scan exceeded ${MAX_PHYSICAL_SCAN_PATHS} paths; refusing an unbounded adapter traversal.`,
      );
    }
    for (const file of listing.files) files.add(normalizePath(file));
    for (const folder of listing.folders) {
      const normalizedFolder = normalizePath(folder);
      if (!isExcluded(normalizedFolder)) {
        pending.push({ path: normalizedFolder, depth: current.depth + 1 });
      }
    }
  }

  return files;
}

export async function reconcilePhysicalFolderFiles(
  adapter: Pick<DataAdapter, 'list'>,
  cachedFiles: TFile[],
  folderPath: string,
  isRoot: boolean,
  wikiFolder: string,
  configDir: string,
): Promise<TFile[]> {
  const allowedExtensions: readonly string[] = COMPATIBLE_SOURCE_EXTENSIONS;
  const isExcluded = (path: string) => isExcludedFromSourcePicker(path, wikiFolder, configDir);
  const physicalFiles = await listPhysicalFilesRecursive(adapter, isRoot ? '' : folderPath, isExcluded);
  const physicalSources = new Map(
    [...physicalFiles]
      .filter(path => isInFolderScope(path, folderPath, isRoot))
      .filter(path => !isExcluded(path))
      .filter(path => {
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        return allowedExtensions.includes(extension);
      })
      .map(path => [physicalPathIdentity(path), path] as const),
  );
  const cachedByPath = new Map(
    cachedFiles
      .filter(file => allowedExtensions.includes(file.extension.toLowerCase()))
      .filter(file => isInFolderScope(file.path, folderPath, isRoot))
      .filter(file => !isExcluded(file.path))
      .map(file => [physicalPathIdentity(file.path), file]),
  );
  const missingFromCache = [...physicalSources.keys()].filter(path => !cachedByPath.has(path));
  if (missingFromCache.length > 0) {
    throw new PhysicalSourceAuthorityError(
      `Vault cache is missing ${missingFromCache.length} physical source file(s); refresh Obsidian before ingesting this folder.`,
    );
  }

  return [...physicalSources.keys()]
    .map(path => cachedByPath.get(path))
    .filter((file): file is TFile => file !== undefined);
}
