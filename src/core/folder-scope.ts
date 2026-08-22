// Issue #364 — folder-boundary scoping for "ingest a folder".
//
// A bare `path.startsWith(folder.path)` treats a folder path as a plain string
// prefix, which is not the same as "is a descendant of this folder". Two things
// leak through:
//
//   * sibling folders sharing a name prefix — picking "Notizen" also matches
//     "Notizen-temp/x.md", because "Notizen-temp/x.md".startsWith("Notizen")
//   * a file sitting next to the folder — "Notizen.md" also matches "Notizen"
//
// Anchoring on a trailing slash makes the comparison mean what the caller
// intends. The vault root is the one folder with no prefix: every path is a
// descendant of it, and its own `path` is "/" rather than "".
//
// Pure and IO-free so the boundary rule can be unit-tested without an Obsidian
// vault — the call site only supplies two primitives.

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Normalize a vault-relative path to the identity Windows uses for ordinary
 * paths. Obsidian exposes `/` paths, but a path can still arrive from a
 * Windows-backed vault or a test double with `\\` separators. NFC and
 * case-folding make the comparison stable across filesystems; trimming
 * trailing dots/spaces mirrors Win32 name equivalence. Absolute/device paths,
 * ADS, traversal, control characters, and reserved device names are not vault
 * paths and must never be admitted by a scope predicate.
 */
function normalizeVaultPath(path: string, foldCase: boolean): string | null {
  if (typeof path !== 'string') return null;

  const source = path.normalize('NFC').replace(/\\/g, '/');
  if (source === '' || source === '/') return '';
  if (source.startsWith('/') || source.startsWith('//') || /^[A-Za-z]:/.test(source)) return null;

  const segments: string[] = [];
  for (const rawSegment of source.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue;
    if (rawSegment === '..') return null;
    // A colon in a relative segment is an alternate-data-stream separator;
    // it is never a legal Obsidian vault path component on Windows.
    // eslint-disable-next-line no-control-regex -- reject control characters in path identities
    if (/[\u0000-\u001f\u007f:]/.test(rawSegment)) return null;

    const segment = rawSegment.replace(/[ .]+$/g, '');
    if (segment.length === 0 || WINDOWS_RESERVED_SEGMENT.test(segment)) return null;
    segments.push(foldCase ? segment.toLowerCase() : segment);
  }

  return segments.join('/');
}

/**
 * The string prefix every descendant of a folder shares.
 * Returns '' for the vault root, so `startsWith` accepts every path.
 */
export function folderScopePrefix(folderPath: string, isRoot: boolean): string {
  if (isRoot) return '';
  const normalized = normalizeVaultPath(folderPath, false);
  if (!normalized) return '';
  return `${normalized}/`;
}

/**
 * True when `filePath` names a file inside the given folder, at any depth.
 * A folder is not a descendant of itself.
 */
export function isInFolderScope(
  filePath: string,
  folderPath: string,
  isRoot: boolean
): boolean {
  const normalizedFile = normalizeVaultPath(filePath, true);
  if (normalizedFile === null) return false;
  if (isRoot) return true;

  const normalizedFolder = normalizeVaultPath(folderPath, true);
  if (!normalizedFolder) return false;
  return normalizedFile.startsWith(`${normalizedFolder}/`);
}

/**
 * True when `filePath` names the folder itself OR anything inside it.
 * The sibling case is `isInFolderScope`; the identity case was previously
 * hand-rolled at every call site as `path === folder || isInFolderScope(...)`
 * (e.g. PR #384's `FolderSuggestModal`, where the missing identity clause
 * let the wiki folder itself leak back into the picker). Centralizing it
 * keeps the boundary semantics in one file with one test suite.
 *
 * `folderPath` is compared with trailing slashes stripped so a normalised
 * folder path and an unnormalised one with a trailing slash both match.
 */
export function isAtOrInFolderScope(
  filePath: string,
  folderPath: string,
  isRoot: boolean
): boolean {
  const normalizedFile = normalizeVaultPath(filePath, true);
  if (normalizedFile === null) return false;
  if (isRoot) return true;

  const normalizedFolder = normalizeVaultPath(folderPath, true);
  if (!normalizedFolder) return false;
  return normalizedFile === normalizedFolder || normalizedFile.startsWith(`${normalizedFolder}/`);
}

/**
 * Whether a path may be presented to the user as an ingest source folder
 * or watched folder. Combines the wiki boundary, the config directory, and
 * the wiki folder's own identity. Used by both `FileSuggestModal`,
 * `FolderSuggestModal` and the multi-file variant — one rule, three sites.
 */
export function isExcludedFromSourcePicker(
  path: string,
  wikiFolder: string,
  configDir: string
): boolean {
  const normalizedPath = normalizeVaultPath(path, false);
  if (normalizedPath === null) return true;
  const hasHiddenSegment = normalizedPath.split('/').some(segment => segment.startsWith('.'));
  return (
    hasHiddenSegment ||
    isAtOrInFolderScope(path, wikiFolder, false) ||
    isAtOrInFolderScope(path, configDir, false)
  );
}
