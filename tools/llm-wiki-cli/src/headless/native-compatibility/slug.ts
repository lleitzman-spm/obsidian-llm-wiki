import { resolveSourceSlug, sourceFingerprint, sourceBaseSlug } from '../../../../../src/core/source-slug';
import type { NativeSourceSlugOptions } from './types';

/** A refusal is intentionally a normal Error: callers must not turn it into a write. */
export class NativeCompatibilityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeCompatibilityError';
    this.code = code;
  }
}

/**
 * Obsidian stores vault paths with `/` separators.  Normalizing before the
 * fingerprint is essential on Windows: the native plugin fingerprints the
 * normalized `TFile.path`, not the host's display spelling.
 */
export function normalizeNativeVaultPath(value: string, name = 'path'): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new NativeCompatibilityError('invalid-path', `${name} must be a non-empty vault-relative path`);
  }
  const normalized = value.replaceAll('\\', '/').normalize('NFKC');
  if (
    normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new NativeCompatibilityError('invalid-path', `${name} must be a normalized vault-relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function normalizeNativeWikiFolder(value: string): string {
  const normalized = normalizeNativeVaultPath(value, 'wikiFolder');
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * The exact v1.26.4 source slug: `<slugified-basename>_<FNV-1a-6-hex>`.
 * This wrapper is the only source slug entry point in the compatibility lane.
 */
export function nativeSourceSlug(sourcePath: string, options: NativeSourceSlugOptions = {}): string {
  const normalized = normalizeNativeVaultPath(sourcePath, 'sourcePath');
  const slug = resolveSourceSlug(normalized, {
    preserveCase: options.preserveCase ?? false,
    maxLen: options.maxLen,
  });
  if (!/^[^/\\]+_[0-9a-f]{6}$/u.test(slug)) {
    throw new NativeCompatibilityError('invalid-path', `Native source slug is not safe: ${slug}`);
  }
  return slug;
}

export function nativeSourcePagePath(
  wikiFolder: string,
  sourcePath: string,
  options: NativeSourceSlugOptions = {},
): string {
  const folder = normalizeNativeWikiFolder(wikiFolder);
  return `${folder}/sources/${nativeSourceSlug(sourcePath, options)}.md`;
}

export function nativeSourceLink(sourcePath: string, options: NativeSourceSlugOptions = {}): string {
  return `[[sources/${nativeSourceSlug(sourcePath, options)}]]`;
}

/** Exposed for tests and manifests that need the exact native identity inputs. */
export { sourceBaseSlug, sourceFingerprint };

