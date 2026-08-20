import { canonicalJson, canonicalJsonSha256, sha256Hex } from './hashing';

export interface SettingsHashes {
  fullSettingsSha256: string;
  safeSettingsProjection: unknown;
  safeSettingsProjectionCanonicalJson: string;
  safeSettingsProjectionSha256: string;
}

export interface SafeSettingsOptions {
  /** Extra key names that are approved for a particular runtime contract. */
  allowedKeys?: ReadonlySet<string>;
  /** Replace the default deny-list only for a versioned, explicit contract. */
  secretKeyPattern?: RegExp;
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth|credential|password|private[_-]?key|secret|token|bearer)/iu;

function project(value: unknown, options: SafeSettingsOptions): unknown {
  if (Array.isArray(value)) return value.map(item => project(item, options)).filter(item => item !== undefined);
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (options.secretKeyPattern?.test(key) ?? SECRET_KEY_PATTERN.test(key)) continue;
    if (options.allowedKeys && !options.allowedKeys.has(key)) continue;
    const child = project((value as Record<string, unknown>)[key], options);
    if (child !== undefined) output[key] = child;
  }
  return output;
}

/**
 * Pure projection. It accepts already-provided settings data and never opens a
 * settings path, reads a vault, or asks a secret store for credentials.
 */
export function projectSafeSettings(settings: unknown, options: SafeSettingsOptions = {}): unknown {
  return project(settings, options);
}

export const safeSettingsProjection = projectSafeSettings;

/** Hash the exact settings bytes supplied by the caller plus a safe projection. */
export function captureSettingsHashes(
  fullSettingsBytes: Uint8Array,
  safeSettingsProjection: unknown,
): SettingsHashes {
  const safeSettingsProjectionCanonicalJson = canonicalJson(safeSettingsProjection);
  return {
    fullSettingsSha256: sha256Hex(fullSettingsBytes),
    safeSettingsProjection,
    safeSettingsProjectionCanonicalJson,
    safeSettingsProjectionSha256: canonicalJsonSha256(safeSettingsProjection),
  };
}
