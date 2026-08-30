/**
 * Canonical, immutable retention for complete native lint reports.
 *
 * The log is intentionally a bounded index. The report artifact is the
 * durable record that survives log rotation, so its bytes and all hashes are
 * computed from the exact UTF-8 strings that are written.
 */

export interface LintReportSectionDigest {
  heading: string;
  sha256: string;
  byteLength: number;
}

export interface LintReportArtifact {
  artifactVersion: 'spm-brain/lint-report/v1';
  encoding: 'utf-8';
  timestamp: string;
  runId: string;
  pluginVersion?: string;
  previousLogSha256: string;
  previousLogByteLength: number;
  reportSha256: string;
  reportByteLength: number;
  sections: LintReportSectionDigest[];
  report: string;
}

export interface SerializedLintReportArtifact {
  artifact: LintReportArtifact;
  content: string;
  reportPath: string;
}

export type Sha256Text = (text: string) => Promise<string>;

/** Return the exact UTF-8 byte count used by the artifact and log cap. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Normalize a vault-relative path and reject traversal/absolute forms. */
export function canonicalVaultPath(input: string): string {
  const raw = input.replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.startsWith('//') || raw.includes('\0')) {
    throw new Error(`Archive path must be vault-relative: ${input}`);
  }
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`Archive path traversal refused: ${input}`);
    parts.push(part);
  }
  return parts.join('/');
}

/** Case-insensitive containment for canonical adapter paths. */
export function assertCanonicalContained(root: string, candidate: string, label: string): void {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalizedRoot || (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}/`))) {
    throw new Error(`${label} escaped archive root`);
  }
}

/**
 * Hash UTF-8 text with the host's Web Crypto implementation. Obsidian
 * provides this in the desktop and mobile runtimes; tests inject a
 * deterministic implementation so this module remains host-independent.
 */
export async function sha256Utf8(text: string): Promise<string> {
  const crypto = typeof activeWindow !== 'undefined' ? activeWindow.crypto : undefined;
  const subtle = crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Split a Markdown report into deterministic heading sections. Each section
 * includes its heading and body exactly as supplied, preserving Unicode and
 * line endings for hashing.
 */
export function splitLintReportSections(report: string): string[] {
  // Keep the line terminator in each slice without lookbehind, which is not
  // available on iOS versions before 16.4.
  const lines = report.split('\n');
  const starts: number[] = [];
  for (let i = 0, offset = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{2,6} .+(?:\r)?$/.test(line)) starts.push(offset);
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return starts.map((start, index) => report.slice(start, starts[index + 1] ?? report.length));
}

function sectionHeading(section: string): string {
  return section.match(/^#{2,6} .+(?:\r?\n|$)/)?.[0].trimEnd() ?? '';
}

function safePathPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'run';
}

export function defaultRunId(): string {
  const crypto = typeof activeWindow !== 'undefined' ? activeWindow.crypto : undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function serializeLintReportArtifact(input: {
  timestamp: string;
  runId: string;
  pluginVersion?: string;
  previousLog: string;
  report: string;
  reportRoot: string;
  sha256?: Sha256Text;
}): Promise<SerializedLintReportArtifact> {
  const hash = input.sha256 ?? sha256Utf8;
  const sectionTexts = splitLintReportSections(input.report);
  const sections: LintReportSectionDigest[] = [];
  for (const section of sectionTexts) {
    sections.push({
      heading: sectionHeading(section),
      sha256: await hash(section),
      byteLength: utf8ByteLength(section),
    });
  }

  const artifact: LintReportArtifact = {
    artifactVersion: 'spm-brain/lint-report/v1',
    encoding: 'utf-8',
    timestamp: input.timestamp,
    runId: input.runId,
    ...(input.pluginVersion ? { pluginVersion: input.pluginVersion } : {}),
    previousLogSha256: await hash(input.previousLog),
    previousLogByteLength: utf8ByteLength(input.previousLog),
    reportSha256: await hash(input.report),
    reportByteLength: utf8ByteLength(input.report),
    sections,
    report: input.report,
  };

  // Object insertion order above is part of the v1 canonical representation.
  // The terminal newline is deliberate: the persisted file is complete UTF-8
  // text and can be safely inspected with line-oriented tools.
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  const filename = `${safePathPart(input.timestamp)}-${safePathPart(input.runId)}.json`;
  return { artifact, content, reportPath: `${input.reportRoot}/${filename}` };
}
