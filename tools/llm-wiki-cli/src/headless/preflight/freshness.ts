export interface PreflightTimestamp {
  capturedAt?: string;
  captured_at?: string;
}

export interface FreshnessResult {
  capturedAt: string;
  now: number;
  ageMs: number;
  maxAgeMs: number;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid preflight capture timestamp: ${value}`);
  return parsed;
}

export function verifyPreflightFreshness(
  capture: PreflightTimestamp,
  now = Date.now(),
  maxAgeMs = 60_000,
): FreshnessResult {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('Invalid freshness clock or limit');
  const capturedAtText = capture.capturedAt ?? capture.captured_at;
  if (!capturedAtText) throw new Error('Preflight capture timestamp is required');
  const capturedAt = timestamp(capturedAtText);
  const ageMs = now - capturedAt;
  if (ageMs < 0) throw new Error(`Preflight capture timestamp is in the future by ${Math.abs(ageMs)}ms`);
  if (ageMs > maxAgeMs) throw new Error(`Preflight capture is stale by ${ageMs - maxAgeMs}ms`);
  return { capturedAt: capturedAtText, now, ageMs, maxAgeMs };
}

export function isFreshPreflight(capture: PreflightTimestamp, now = Date.now(), maxAgeMs = 60_000): boolean {
  try {
    verifyPreflightFreshness(capture, now, maxAgeMs);
    return true;
  } catch {
    return false;
  }
}

export const assertFreshPreflight = verifyPreflightFreshness;
