/**
 * RFC 8785-compatible JSON canonicalization for the value subset used by the
 * headless receipt protocol.
 *
 * This intentionally does not call JSON.stringify on the whole value: that
 * would invoke user supplied toJSON methods, retain insertion order for
 * object keys, and silently drop undefined properties. Receipt bytes must be
 * deterministic and must fail closed when a value is outside JSON.
 */

export type JsonPrimitive = null | boolean | number | string;
// The runtime canonicalizer validates the shape. `unknown` here deliberately
// lets named protocol interfaces (which do not carry an index signature) be
// signed without unsafe casts; unsupported objects still fail at runtime.
export type JsonValue = unknown;

function isUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalString(value: string): string {
  // RFC 8785 operates on well-formed Unicode strings. JSON.stringify's
  // escaping rules are the ECMAScript JSON serialization rules required by
  // JCS for quotes, backslashes, and control characters.
  if (isUnpairedSurrogate(value)) throw new TypeError('JCS does not support unpaired UTF-16 surrogates');
  return JSON.stringify(value);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('JCS only supports finite JSON numbers');
  // JSON.stringify already emits -0 as 0 and uses the ECMAScript shortest
  // round-trippable representation required by RFC 8785.
  return JSON.stringify(value);
}

function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return canonicalString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError(`JCS does not support sparse arrays at ${path}[${index}]`);
          }
          items.push(canonicalizeValue(value[index], `${path}[${index}]`));
        }
        return `[${items.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`JCS only supports plain JSON objects at ${path}`);
      }

      const record = value as Record<string, unknown>;
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`JCS does not support symbol keys at ${path}`);
      }
      const keys = Object.keys(record).sort();
      return `{${keys.map(key => {
        const child = record[key];
        if (child === undefined) throw new TypeError(`JCS does not support undefined at ${path}.${key}`);
        return `${canonicalString(key)}:${canonicalizeValue(child, `${path}.${key}`)}`;
      }).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS does not support ${typeof value} at ${path}`);
  }
}

/** Return the deterministic RFC 8785 JSON representation of a JSON value. */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, '$');
}

/** Return canonical JSON as UTF-8 bytes, ready for hashing. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}

export const canonicalize = canonicalizeJson;
export const canonicalJson = canonicalizeJson;
