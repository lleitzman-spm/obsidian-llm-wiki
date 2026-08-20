import { createHash } from 'node:crypto';

/** RFC-8785-shaped JSON serialization for the JSON data used by v1 IDs. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value);
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (isUnpairedSurrogate(value)) throw new TypeError('JCS does not support unpaired UTF-16 surrogates');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not permit non-finite numbers');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('JCS does not permit this number');
    return encoded;
  }
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`JCS does not permit ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JCS only supports plain JSON objects');
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    return `{${keys.map(key => {
      if (record[key] === undefined) throw new TypeError(`JCS does not permit undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalValue(record[key])}`;
    }).join(',')}}`;
  }
  throw new TypeError(`Unsupported JCS value: ${typeof value}`);
}

function isUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The v1 normal form: NFKC, default Unicode case-fold approximation, ASCII spaces. */
export function normalizeLabel(value: string): string {
  if (typeof value !== 'string') throw new TypeError('label must be a string');
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u00df\u1e9e]/gu, 'ss')
    .replace(/ς/gu, 'σ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function normalizePath(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('normalized path must be non-empty');
  const normalized = value.replaceAll('\\', '/').normalize('NFKC');
  if (normalized.startsWith('/') || normalized.includes('\0')) throw new TypeError(`Unsafe source path: ${value}`);
  const parts = normalized.split('/').filter(part => part !== '');
  if (parts.some(part => part === '.' || part === '..')) throw new TypeError(`Unsafe source path: ${value}`);
  if (parts.length === 0) throw new TypeError('normalized path must be non-empty');
  return parts.join('/');
}

export function assertSha256Hex(value: string, name = 'SHA-256 digest'): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${name} must be lowercase 64-character SHA-256 hex`);
}

export function sortedUnique(values: readonly string[]): string[] {
  const result = [...new Set(values)];
  result.sort(compareUtf16);
  return result;
}

export function hashDomain(domain: string, value: unknown): string {
  if (!domain.endsWith('\0')) throw new Error(`Domain must end in NUL: ${domain}`);
  const hash = createHash('sha256');
  hash.update(Buffer.from(domain, 'utf8'));
  hash.update(Buffer.from(canonicalize(value), 'utf8'));
  return hash.digest('hex');
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertNonEmpty(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be non-empty`);
}

export function assertByteRange(range: { start: number; end: number }): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start) {
    throw new TypeError('byte range must contain safe integer start/end with 0 <= start <= end');
  }
}
