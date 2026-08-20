import { createHash } from 'node:crypto';

import { computeSlug } from '../../../../../src/core/slug';
import { canonicalPartitionKey, partitionKeyString } from '../engine/partition';
import { NativeCompatibilityError, nativeSourceSlug } from '../native-compatibility';
import type { NativeMapIR } from '../native-map/types';
import type {
  NativeCanonicalKey,
  NativeDesiredAction,
  NativeDesiredFile,
  NativeEvidence,
  NativeExistingPage,
  NativeGlobalPhase,
  NativePageCandidate,
  NativePageKind,
  NativePageProposal,
  NativePageType,
  NativeReductionPlan,
  NativeRelatedProposal,
  NativeReducerOptions,
  NativeSourcePage,
  NativeSourceScopedIR,
  NativeStatement,
} from './types';

const KEY_SEPARATOR = '\u001f';
const ROLE_ORDER: Readonly<Record<'supports' | 'qualifies' | 'contests', number>> = {
  supports: 0,
  qualifies: 1,
  contests: 2,
};

export class NativeReductionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NativeReductionError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function normalizeLabel(value: string): string {
  return text(value).replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function canonicalKey(pageType: NativePageType, label: string): NativeCanonicalKey {
  const [type, normalizedLabel] = canonicalPartitionKey(pageType, label);
  return {
    pageType: type as NativePageType,
    normalizedLabel,
    keyString: partitionKeyString([type, normalizedLabel]),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uniqueSorted(values: Iterable<string>): string[] {
  const candidates = [...values]
    .map(text)
    .filter(Boolean)
    .sort((left, right) => normalizeLabel(left).localeCompare(normalizeLabel(right)) || left.localeCompare(right));
  const byKey = new Map<string, string>();
  for (const value of candidates) {
    const key = normalizeLabel(value);
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()].sort((left, right) => normalizeLabel(left).localeCompare(normalizeLabel(right)) || left.localeCompare(right));
}

function nativeMapSourceSlug(path: string, preserveCase = false): string {
  try {
    return nativeSourceSlug(path, { preserveCase });
  } catch (error) {
    const detail = error instanceof NativeCompatibilityError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    throw new NativeReductionError(`native source slug refused for ${JSON.stringify(path)}: ${detail}`);
  }
}

function compareIds(left: { readonly sourceId?: string; readonly evidenceId?: string; readonly statementId?: string }, right: typeof left): number {
  return (left.sourceId ?? '').localeCompare(right.sourceId ?? '')
    || (left.evidenceId ?? left.statementId ?? '').localeCompare(right.evidenceId ?? right.statementId ?? '');
}

function safeSlug(label: string, preserveCase: boolean): string {
  const trimmed = text(label);
  if (!trimmed || /[\u0000-\u001f/\\]/u.test(trimmed)) {
    throw new NativeReductionError(`unsafe canonical label: ${JSON.stringify(label)}`);
  }
  const slug = computeSlug(trimmed, preserveCase);
  // computeSlug historically has time-based fallbacks for punctuation-only
  // input.  A headless plan must never contain a time-dependent path.
  if (!slug || /^untitled-\d+$/u.test(slug) || slug.includes('/') || slug.includes('\\') || slug === '.' || slug === '..') {
    throw new NativeReductionError(`label cannot produce a deterministic native path: ${JSON.stringify(label)}`);
  }
  return slug;
}

function normalizeFolder(value: string, name: string): string {
  const raw = text(value).replace(/\\/gu, '/');
  const folder = raw.replace(/^\/+|\/+$/gu, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw) || folder.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new NativeReductionError(`${name} must be a relative vault path: ${JSON.stringify(value)}`);
  }
  return folder;
}

function assertRelativePath(value: string, name: string): string {
  const raw = text(value).replace(/\\/gu, '/');
  const path = raw.replace(/^\/+|\/+$/gu, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//u.test(raw) || path.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new NativeReductionError(`${name} must be a relative vault path: ${JSON.stringify(value)}`);
  }
  return path;
}

/**
 * Obsidian's vault is commonly hosted on a case-insensitive filesystem.  A
 * reducer running outside that filesystem must still refuse two desired
 * files which differ only by slash spelling or case; otherwise a later
 * transaction can overwrite one of them nondeterministically.
 */
function pathCollisionKey(value: string): string {
  return value.replace(/\\/gu, '/').normalize('NFKC').toLocaleLowerCase('en-US');
}

function existingFileContent(existingFiles: ReadonlyMap<string, string> | undefined, path: string): string | undefined {
  if (!existingFiles) return undefined;
  const key = pathCollisionKey(path);
  let match: string | undefined;
  let matchPath: string | undefined;
  for (const [candidatePath, content] of existingFiles.entries()) {
    if (pathCollisionKey(candidatePath) !== key) continue;
    if (matchPath !== undefined && candidatePath !== matchPath) {
      throw new NativeReductionError(`existing files contain a case-insensitive path collision: ${path}`);
    }
    matchPath = candidatePath;
    match = content;
  }
  return match;
}

function assertSourceReference(value: string, name: string): string {
  const path = assertRelativePath(value, name);
  if (path.includes('[') || path.includes(']') || path.includes('|')) {
    throw new NativeReductionError(`${name} contains unsafe wikilink syntax: ${JSON.stringify(value)}`);
  }
  return path;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function yamlList(name: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [name + ':', ...values.map(value => `  - ${quoteYaml(value)}`)];
}

function parseFrontmatter(content: string): { reviewed: boolean; type?: string; aliases: string[]; sources: string[]; tags: string[]; body: string } {
  if (!content.startsWith('---\n')) return { reviewed: false, aliases: [], sources: [], tags: [], body: content.trim() };
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { reviewed: false, aliases: [], sources: [], tags: [], body: content.trim() };
  const lines = content.slice(4, end).split('\n');
  const fields: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const item = /^-\s+(.*)$/u.exec(trimmed);
    if (item && current) {
      fields[current] ??= [];
      fields[current].push(item[1].replace(/^['"]|['"]$/gu, ''));
      continue;
    }
    const field = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/u.exec(line);
    if (!field) {
      current = undefined;
      continue;
    }
    current = field[1];
    const value = field[2]?.trim() ?? '';
    if (value === 'true' && current === 'reviewed') fields[current] = ['true'];
    else if (value.startsWith('[') && value.endsWith(']')) {
      fields[current] = value.slice(1, -1).split(',').map(itemValue => itemValue.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean);
    } else if (value) fields[current] = [value.replace(/^['"]|['"]$/gu, '')];
    else fields[current] = [];
  }
  return {
    reviewed: fields.reviewed?.[0] === 'true',
    type: fields.type?.[0],
    aliases: fields.aliases ?? [],
    sources: fields.sources ?? [],
    tags: fields.tags ?? [],
    body: content.slice(end + 4).trim(),
  };
}

function stripProviderFrontmatter(body: string): { body: string; unsupported: string[] } {
  if (!body.startsWith('---\n')) return { body: body.trim(), unsupported: [] };
  const parsed = parseFrontmatter(body);
  const unsupported: string[] = [];
  const end = body.indexOf('\n---', 4);
  if (end >= 0) {
    for (const line of body.slice(4, end).split('\n')) {
      const field = /^([A-Za-z][\w-]*):/u.exec(line)?.[1];
      if (field && !['type', 'created', 'updated', 'sources', 'tags', 'reviewed', 'aliases'].includes(field)) {
        unsupported.push(`provider-frontmatter:${field}`);
      }
    }
  }
  return { body: parsed.body, unsupported };
}

function evidenceRole(value: NativeEvidence | NativeStatement): 'supports' | 'qualifies' | 'contests' {
  return value.role ?? 'supports';
}

function evidenceKey(item: NativeEvidence): string {
  return item.evidenceId || `${item.sourceId ?? ''}:${item.sourcePath ?? ''}:${item.quote ?? ''}`;
}

function statementKey(item: NativeStatement): string {
  return item.statementId || `${evidenceRole(item)}:${normalizeLabel(item.text)}`;
}

function relatedKey(item: NativeRelatedProposal): string {
  return `${item.pageType}${KEY_SEPARATOR}${normalizeLabel(item.label)}`;
}

function sourceLink(sourceSlug: string, preserveCase = true): string {
  return `[[sources/${safeSlug(sourceSlug, preserveCase)}]]`;
}

function renderEvidenceLine(item: NativeEvidence, fallbackSource: NativeSourceScopedIR): string {
  const role = evidenceRole(item);
  const quote = text(item.quote);
  const sourcePath = assertSourceReference(text(item.sourcePath) || fallbackSource.sourcePath, 'evidence.sourcePath');
  const display = sourcePath.split('/').pop() || sourcePath;
  const link = `[[${sourcePath.replace(/\\/gu, '/').replace(/\.md$/iu, '')}|${display.replace(/\.md$/iu, '')}]]`;
  const range = item.byteRange ? ` [${item.byteRange.start}-${item.byteRange.end}]` : '';
  return `- ${role}: ${quote ? `${quoteYaml(quote)} — ` : ''}${link}${range}`;
}

function renderStatementLine(statement: NativeStatement): string {
  const role = evidenceRole(statement);
  return `- ${role}: ${text(statement.text)}`;
}

function renderBody(
  label: string,
  body: string,
  summaries: readonly string[],
  statements: readonly NativeStatement[],
  qualifications: readonly NativeStatement[],
  evidence: readonly NativeEvidence[],
  related: readonly NativeRelatedProposal[],
  source: NativeSourceScopedIR,
): string {
  const stripped = stripProviderFrontmatter(body);
  const base = stripped.body;
  const sections: string[] = [];
  if (base) sections.push(base.replace(/\s+$/u, ''));
  else sections.push(`# ${label}`);
  if (summaries.length > 0) {
    sections.push(`## Summary\n${summaries.map(summary => `- ${summary}`).join('\n')}`);
  }
  const groupedStatements = statements.filter(item => evidenceRole(item) === 'supports');
  const qualifyingStatements = [...qualifications, ...statements.filter(item => evidenceRole(item) === 'qualifies')];
  const contestingStatements = statements.filter(item => evidenceRole(item) === 'contests');
  if (groupedStatements.length > 0) sections.push(`## Statements\n${groupedStatements.map(renderStatementLine).join('\n')}`);
  if (qualifyingStatements.length > 0) sections.push(`## Qualifications\n${qualifyingStatements.map(renderStatementLine).join('\n')}`);
  if (contestingStatements.length > 0) sections.push(`## Contested Evidence\n${contestingStatements.map(renderStatementLine).join('\n')}`);
  if (evidence.length > 0) {
    const byRole = new Map<string, NativeEvidence[]>();
    for (const item of evidence) {
      const list = byRole.get(evidenceRole(item)) ?? [];
      list.push(item);
      byRole.set(evidenceRole(item), list);
    }
    const evidenceSections: string[] = [];
    for (const role of ['supports', 'qualifies', 'contests'] as const) {
      const values = byRole.get(role);
      if (values?.length) evidenceSections.push(`### ${role[0].toUpperCase()}${role.slice(1)}\n${values.map(item => renderEvidenceLine(item, source)).join('\n')}`);
    }
    sections.push(`## Evidence\n${evidenceSections.join('\n\n')}`);
  }
  const entities = related.filter(item => item.pageType === 'entity');
  const concepts = related.filter(item => item.pageType === 'concept');
  if (entities.length > 0) sections.push(`## Related Entities\n${entities.map(item => `- [[entities/${safeSlug(item.label, false)}|${text(item.label)}]]`).join('\n')}`);
  if (concepts.length > 0) sections.push(`## Related Concepts\n${concepts.map(item => `- [[concepts/${safeSlug(item.label, false)}|${text(item.label)}]]`).join('\n')}`);
  return `${sections.join('\n\n').trim()}\n`;
}

function renderFrontmatter(
  pageType: NativePageType | 'source',
  date: string,
  sources: readonly string[],
  tags: readonly string[],
  aliases: readonly string[],
  reviewed: boolean,
): string {
  const lines = ['---', `type: ${pageType}`, `created: ${date}`, `updated: ${date}`];
  lines.push(...yamlList('sources', sources));
  lines.push(...yamlList('tags', tags));
  if (reviewed) lines.push('reviewed: true');
  lines.push(...yamlList('aliases', aliases));
  lines.push('---', '');
  return lines.join('\n');
}

function renderPage(
  pageType: NativePageType,
  label: string,
  date: string,
  sourceLinks: readonly string[],
  tags: readonly string[],
  aliases: readonly string[],
  reviewed: boolean,
  body: string,
  summaries: readonly string[],
  statements: readonly NativeStatement[],
  qualifications: readonly NativeStatement[],
  evidence: readonly NativeEvidence[],
  related: readonly NativeRelatedProposal[],
  source: NativeSourceScopedIR,
): string {
  return `${renderFrontmatter(pageType, date, sourceLinks, tags, aliases, reviewed)}${renderBody(label, body, summaries, statements, qualifications, evidence, related, source)}`;
}

function renderSourcePage(source: NativeSourceScopedIR, options: NativeReducerOptions): string {
  const page = source.sourcePage;
  const title = text(page?.title) || text(source.sourceTitle) || source.sourceSlug;
  const aliases = uniqueSorted([...(source.sourceAliases ?? []), ...(page?.aliases ?? [])]);
  const tags = uniqueSorted([...(source.sourceTags ?? []), ...(page?.tags ?? [])]);
  const body = text(page?.body) || text(source.sourceBody) || text(source.sourceSummary) || `# ${title}`;
  return `${renderFrontmatter('source', options.date, [], tags, aliases, page?.reviewed === true)}${body.trim()}\n`;
}

function desiredFile(
  path: string,
  kind: NativePageKind,
  phase: 'partition' | 'serialized-global',
  content: string,
  sourceIds: readonly string[],
  existingFiles?: ReadonlyMap<string, string>,
  canonicalKey?: NativeCanonicalKey,
): NativeDesiredFile {
  const current = existingFileContent(existingFiles, path);
  let action: NativeDesiredAction = current === undefined ? 'create' : current === content ? 'unchanged' : 'replace';
  return {
    path,
    kind,
    phase,
    action,
    content,
    desiredSha256: sha256(content),
    ...(current === undefined ? {} : { currentSha256: sha256(current) }),
    sourceIds: Object.freeze([...sourceIds].sort()),
    ...(canonicalKey ? { canonicalKey } : {}),
  };
}

function inferExistingPages(options: NativeReducerOptions): NativeExistingPage[] {
  if (options.existingPages) return [...options.existingPages];
  return [];
}

function normalizeProposal(proposal: NativePageProposal, source: NativeSourceScopedIR): NativePageProposal {
  if (proposal.sourceId !== source.sourceId) throw new NativeReductionError(`proposal ${proposal.proposalId} escaped source ${source.sourceId}`);
  if (!text(proposal.proposalId)) throw new NativeReductionError(`source ${source.sourceId} has an empty proposal id`);
  if (proposal.pageType !== 'entity' && proposal.pageType !== 'concept') throw new NativeReductionError(`unsupported native page type: ${String(proposal.pageType)}`);
  if (!text(proposal.label)) throw new NativeReductionError(`proposal ${proposal.proposalId} has an empty label`);
  for (const related of proposal.related ?? []) {
    if (related.pageType !== 'entity' && related.pageType !== 'concept') {
      throw new NativeReductionError(`proposal ${proposal.proposalId} has an unsupported related page type`);
    }
    if (!text(related.label)) throw new NativeReductionError(`proposal ${proposal.proposalId} has an empty related label`);
  }
  return proposal;
}

interface ProposalExtras {
  statements: NativeStatement[];
  qualifications: NativeStatement[];
  evidence: NativeEvidence[];
  aliases: string[];
}

function mapMentionEvidence(
  source: NativeMapIR,
  mention: { readonly quote: string; readonly source_path: string; readonly source_slug: string },
  ordinal: number,
  preserveCase = false,
): NativeEvidence {
  const quote = text(mention.quote);
  const sourcePath = assertSourceReference(mention.source_path || source.source.sourcePath, 'native-map mention.source_path');
  return {
    evidenceId: `mention:${sha256(`${source.source.sourceId}\u0000${ordinal}\u0000${quote}\u0000${sourcePath}`)}`,
    role: 'supports',
    quote,
    sourcePath,
    // The provider-supplied slug is not an identity field.  Native derives
    // this from the normalized source path so duplicate basenames remain
    // distinct and every source link points at the same page.
    sourceSlug: nativeMapSourceSlug(sourcePath, preserveCase),
    sourceId: source.source.sourceId,
  };
}

/**
 * Adapt the native-map/v1 output into the reducer's source-scoped IR.  The
 * adapter keeps claims, contested claims, aliases, and related proposals
 * typed; it never collapses them into an untyped string bag.
 */
export function nativeMapIRToSourceScopedIR(
  source: NativeMapIR,
  slugCase: 'lower' | 'preserve' = 'lower',
): NativeSourceScopedIR {
  const unsupported: string[] = [];
  const sourceId = text(source.source.sourceId);
  if (!sourceId) throw new NativeReductionError('native-map IR source id is empty');
  const sourcePath = assertSourceReference(source.source.sourcePath, 'native-map source.sourcePath');
  const sourceSlug = nativeMapSourceSlug(sourcePath, slugCase === 'preserve');
  const sourceTitle = text(source.sourceTitle) || sourceSlug;
  const sourceSummary = text(source.summary);
  // A later extraction failure preserves earlier proposals, but it is not a
  // complete map.  Carry the typed adapter signal into the reducer's existing
  // refusal surface without copying provider error text or source evidence.
  for (const degradation of source.degradations ?? []) {
    unsupported.push(degradation.code === 'later-batch-provider-failure'
      ? 'native-map-degradation:later-batch-provider-failure'
      : 'native-map-degradation:unknown');
  }
  let sourceAliases = uniqueSorted(source.sourceAliases ?? []);
  const extras = new Map<string, ProposalExtras>();
  const getExtras = (pageType: NativePageType, label: string): ProposalExtras => {
    const key = partitionKeyString(canonicalPartitionKey(pageType, label));
    const current = extras.get(key);
    if (current) return current;
    const created: ProposalExtras = { statements: [], qualifications: [], evidence: [], aliases: [] };
    extras.set(key, created);
    return created;
  };
  const entityLabels = new Set(source.entities.map(item => normalizeLabel(item.name)));
  const conceptLabels = new Set(source.concepts.map(item => normalizeLabel(item.name)));
  const proposals: NativePageProposal[] = [];
  const makeProposal = (
    pageType: NativePageType,
    item: { readonly name: string; readonly type: string; readonly aliases: readonly string[]; readonly summary: string; readonly mentions_with_provenance: readonly { readonly quote: string; readonly source_path: string; readonly source_slug: string }[]; readonly related_entities: readonly string[]; readonly related_concepts: readonly string[] },
    ordinal: number,
  ): void => {
    const key = partitionKeyString(canonicalPartitionKey(pageType, item.name));
    const extra = getExtras(pageType, item.name);
    const evidence = item.mentions_with_provenance.map((mention, index) => mapMentionEvidence(source, mention, ordinal * 1000 + index, slugCase === 'preserve'));
    extra.evidence.push(...evidence);
    const mentions = evidence.map((itemEvidence, index) => ({
      statementId: `mention-statement:${sha256(`${itemEvidence.evidenceId}\u0000${index}`)}`,
      text: text(item.mentions_with_provenance[index]?.quote),
      role: 'supports' as const,
      evidenceIds: [itemEvidence.evidenceId],
    })).filter(itemStatement => itemStatement.text);
    extra.statements.push(...mentions);
    proposals.push({
      proposalId: `${pageType}:${sourceId}:${ordinal}:${normalizeLabel(item.name)}`,
      sourceId,
      pageType,
      label: item.name,
      typeTag: item.type,
      aliases: item.aliases,
      summary: item.summary,
      statements: mentions,
      evidence,
      related: [
        ...item.related_entities.map(label => ({ pageType: 'entity' as const, label })),
        ...item.related_concepts.map(label => ({ pageType: 'concept' as const, label })),
      ],
    });
    void key;
  };
  source.entities.forEach((item, index) => makeProposal('entity', item, index));
  source.concepts.forEach((item, index) => makeProposal('concept', item, source.entities.length + index));

  for (const claim of source.claims) {
    const claimPath = assertSourceReference(claim.sourcePath, `claim ${claim.claimId}.sourcePath`);
    const claimSourceMismatch = pathCollisionKey(claimPath) !== pathCollisionKey(sourcePath);
    if (claim.subject.pageType === 'source') {
      // Native analyze-source always emits one source-summary claim.  The
      // summary is already represented by sourceSummary/sourceBody, and
      // source-level contradiction claims are reduced from `contradictions`
      // below.  Both are safely reduced only after their source binding,
      // target title, disposition, and statement agree with native output.
      if (claimSourceMismatch) unsupported.push(`native-map-claim-source-mismatch:${claim.claimId}`);
      const targetMatches = normalizeLabel(claim.subject.label) === normalizeLabel(sourceTitle);
      const sourceContradictionMatches = claim.predicate === 'contradiction'
        && claim.disposition === 'contested'
        && claim.evidenceQuotes.length === 0
        && source.contradictions.some(item => text(item.claim) === text(claim.statement));
      if (sourceContradictionMatches && targetMatches && !claimSourceMismatch) continue;
      if (claim.predicate !== 'source-summary' || claim.disposition !== 'proposed' || claim.evidenceQuotes.length > 0) {
        unsupported.push(`native-map-claim-source-subject:${claim.claimId}`);
        continue;
      }
      if (!targetMatches) {
        unsupported.push(`native-map-claim-source-subject:${claim.claimId}`);
        unsupported.push(`native-map-source-summary-target-mismatch:${claim.claimId}`);
        continue;
      }
      if (text(claim.statement) !== sourceSummary) {
        unsupported.push(`native-map-claim-source-subject:${claim.claimId}`);
        unsupported.push(`native-map-source-summary-mismatch:${claim.claimId}`);
      }
      continue;
    }
    if (claim.subject.pageType !== 'entity' && claim.subject.pageType !== 'concept') {
      unsupported.push(`native-map-claim-source-subject:${claim.claimId}`);
      continue;
    }
    const key = partitionKeyString(canonicalPartitionKey(claim.subject.pageType, claim.subject.label));
    const extra = getExtras(claim.subject.pageType, claim.subject.label);
    const role = claim.disposition === 'contested' ? 'contests' as const : 'supports' as const;
    if (claimSourceMismatch) unsupported.push(`native-map-claim-source-mismatch:${claim.claimId}`);
    const evidence = claim.evidenceQuotes.map((quote, index) => ({
      evidenceId: `claim:${sha256(`${claim.claimId}\u0000${index}\u0000${quote}`)}`,
      role,
      quote: text(quote),
      sourcePath: claimPath,
      sourceSlug,
      sourceId,
    })).filter(item => item.quote);
    extra.evidence.push(...evidence);
    const statement: NativeStatement = {
      statementId: claim.claimId,
      text: claim.statement,
      role,
      evidenceIds: evidence.map(item => item.evidenceId),
    };
    if (!entityLabels.has(normalizeLabel(claim.subject.label)) && !conceptLabels.has(normalizeLabel(claim.subject.label))) {
      unsupported.push(`native-map-claim-target-missing:${claim.claimId}`);
    }
    extra.statements.push(statement);
  }

  for (const alias of source.aliases) {
    const aliasSourcePath = assertSourceReference(alias.sourcePath, `alias ${alias.alias}.sourcePath`);
    const aliasSourceMismatch = pathCollisionKey(aliasSourcePath) !== pathCollisionKey(sourcePath);
    if (alias.targetPageType === 'source') {
      if (aliasSourceMismatch) {
        unsupported.push(`native-map-alias-source-mismatch:${alias.alias}`);
        unsupported.push(`native-map-alias-target:${alias.alias}`);
      }
      if (normalizeLabel(alias.targetLabel) !== normalizeLabel(sourceTitle)) {
        unsupported.push(`native-map-alias-target:${alias.alias}`);
        unsupported.push(`native-map-alias-source-target-mismatch:${alias.alias}`);
      } else if (!text(alias.alias)) {
        unsupported.push(`native-map-alias-target:${alias.alias}`);
        unsupported.push('native-map-alias-empty');
      } else if (!aliasSourceMismatch) {
        sourceAliases = uniqueSorted([...sourceAliases, alias.alias]);
      }
      continue;
    }
    if (alias.targetPageType === 'entity' || alias.targetPageType === 'concept') {
      if (aliasSourceMismatch) unsupported.push(`native-map-alias-source-mismatch:${alias.alias}`);
      const targetLabels = alias.targetPageType === 'entity' ? entityLabels : conceptLabels;
      const targetLabel = normalizeLabel(alias.targetLabel);
      if (!targetLabel || !targetLabels.has(targetLabel)) {
        unsupported.push(`native-map-alias-target-missing:${alias.alias}`);
      } else if (text(alias.alias)) {
        getExtras(alias.targetPageType, alias.targetLabel).aliases.push(alias.alias);
      } else {
        unsupported.push('native-map-alias-empty');
      }
    } else {
      unsupported.push(`native-map-alias-target:${alias.alias}`);
    }
  }
  for (const related of source.related) {
    const relatedSourcePath = assertSourceReference(related.sourcePath, `related ${related.label}.sourcePath`);
    if (pathCollisionKey(relatedSourcePath) !== pathCollisionKey(sourcePath)) {
      unsupported.push(`native-map-related-source-mismatch:${related.label}`);
    }
    if (related.pageType !== 'entity' && related.pageType !== 'concept') {
      unsupported.push(`native-map-related-target:${related.label}`);
      continue;
    }
    const targetLabels = related.pageType === 'entity' ? entityLabels : conceptLabels;
    if (!normalizeLabel(related.label) || !targetLabels.has(normalizeLabel(related.label))) {
      unsupported.push(`native-map-related-target-missing:${related.label}`);
    }
  }
  for (const contradiction of source.contradictions) {
    const normalized = normalizeLabel(contradiction.source_page.split('/').pop()?.replace(/\.md$/iu, '') ?? contradiction.source_page);
    const pageType = entityLabels.has(normalized) ? 'entity' : conceptLabels.has(normalized) ? 'concept' : null;
    if (!pageType) {
      unsupported.push(`native-map-contradiction-target:${contradiction.source_page}`);
      continue;
    }
    const extra = getExtras(pageType, normalized);
    const evidenceId = `contradiction:${sha256(`${sourceId}\u0000${contradiction.claim}\u0000${contradiction.contradicted_by}`)}`;
    extra.evidence.push({
      evidenceId,
      role: 'contests',
      quote: contradiction.contradicted_by,
      sourcePath,
      sourceSlug,
      sourceId,
    });
    extra.statements.push({ statementId: `contradiction:${sha256(contradiction.claim)}`, text: contradiction.claim, role: 'contests', evidenceIds: [evidenceId] });
    extra.qualifications.push({ statementId: `resolution:${sha256(contradiction.resolution)}`, text: contradiction.resolution, role: 'qualifies' });
  }
  const adapted = proposals.map(proposal => {
    const key = partitionKeyString(canonicalPartitionKey(proposal.pageType, proposal.label));
    const extra = extras.get(key);
    return {
      ...proposal,
      aliases: uniqueSorted([...(proposal.aliases ?? []), ...(extra?.aliases ?? [])]),
      statements: extra?.statements ?? proposal.statements,
      qualifications: extra?.qualifications ?? [],
      evidence: extra?.evidence ?? proposal.evidence,
    };
  });
  const sourceBody = sourceSummary
    ? `# ${sourceTitle}\n\n${sourceSummary}\n`
    : `# ${sourceTitle}\n`;
  return {
    sourceId,
    sourcePath,
    sourceSlug,
    sourceTitle,
    sourceSummary: source.summary,
    sourceBody,
    sourceAliases,
    sourcePage: { title: sourceTitle, body: sourceBody, aliases: sourceAliases },
    proposals: adapted,
    unsupported,
  };
}

interface Group {
  readonly key: NativeCanonicalKey;
  readonly proposals: NativePageProposal[];
  readonly sources: NativeSourceScopedIR[];
  existing?: NativeExistingPage;
  crossTypeAlias: boolean;
}

function dedupeStatements(values: readonly NativeStatement[]): NativeStatement[] {
  const byKey = new Map<string, NativeStatement>();
  const ordered = [...values].sort((left, right) => {
    const leftText = text(left.text);
    const rightText = text(right.text);
    return statementKey(left).localeCompare(statementKey(right))
      || ROLE_ORDER[evidenceRole(left)] - ROLE_ORDER[evidenceRole(right)]
      || normalizeLabel(leftText).localeCompare(normalizeLabel(rightText))
      || leftText.localeCompare(rightText)
      || left.statementId.localeCompare(right.statementId);
  });
  for (const statement of ordered) {
    const normalized = text(statement.text);
    if (!normalized) continue;
    const next = { ...statement, text: normalized, role: evidenceRole(statement) };
    const key = statementKey(next);
    if (!byKey.has(key)) byKey.set(key, next);
  }
  return [...byKey.values()].sort((left, right) => ROLE_ORDER[evidenceRole(left)] - ROLE_ORDER[evidenceRole(right)] || normalizeLabel(left.text).localeCompare(normalizeLabel(right.text)) || left.statementId.localeCompare(right.statementId));
}

function dedupeEvidence(values: readonly NativeEvidence[]): NativeEvidence[] {
  const byKey = new Map<string, NativeEvidence>();
  const ordered = [...values].sort((left, right) => {
    const leftRange = left.byteRange ? `${left.byteRange.start}:${left.byteRange.end}` : '';
    const rightRange = right.byteRange ? `${right.byteRange.start}:${right.byteRange.end}` : '';
    return evidenceKey(left).localeCompare(evidenceKey(right))
      || ROLE_ORDER[evidenceRole(left)] - ROLE_ORDER[evidenceRole(right)]
      || (left.sourceId ?? '').localeCompare(right.sourceId ?? '')
      || (left.sourcePath ?? '').localeCompare(right.sourcePath ?? '')
      || text(left.quote).localeCompare(text(right.quote))
      || leftRange.localeCompare(rightRange);
  });
  for (const item of ordered) {
    const id = text(item.evidenceId);
    if (!id) continue;
    const next = { ...item, evidenceId: id, ...(item.role ? { role: item.role } : {}) };
    const key = evidenceKey(next);
    if (!byKey.has(key)) byKey.set(key, next);
  }
  return [...byKey.values()].sort((left, right) => ROLE_ORDER[evidenceRole(left)] - ROLE_ORDER[evidenceRole(right)] || compareIds(left, right));
}

function dedupeRelated(values: readonly NativeRelatedProposal[]): NativeRelatedProposal[] {
  const byKey = new Map<string, NativeRelatedProposal>();
  const ordered = [...values].sort((left, right) => relatedKey(left).localeCompare(relatedKey(right)) || text(left.label).localeCompare(text(right.label)));
  for (const item of ordered) {
    if (item.pageType !== 'entity' && item.pageType !== 'concept') continue;
    const label = text(item.label);
    if (!label) continue;
    const next = { pageType: item.pageType, label };
    byKey.set(relatedKey(next), next);
  }
  return [...byKey.values()].sort((left, right) => relatedKey(left).localeCompare(relatedKey(right)));
}

function candidateForGroup(
  group: Group,
  options: NativeReducerOptions,
  globalReasons: string[],
): NativePageCandidate {
  const proposals = [...group.proposals].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.proposalId.localeCompare(right.proposalId));
  const first = proposals[0];
  if (!first) throw new NativeReductionError(`empty reducer group: ${group.key.keyString}`);
  // A cross-type collision may merge a concept proposal into an existing
  // entity (or vice versa).  The reducer key, not the lexicographically first
  // source proposal, owns the native page type in that case.
  const pageType = group.key.pageType;
  const label = group.existing?.label ? text(group.existing.label) : first.label;
  const preserveCase = options.slugCase === 'preserve';
  const slug = safeSlug(label, preserveCase);
  const folder = pageType === 'entity' ? 'entities' : 'concepts';
  const computedPath = `${normalizeFolder(options.wikiFolder, 'wikiFolder')}/${folder}/${slug}.md`;
  const path = group.existing ? assertRelativePath(group.existing.path, `existing page ${group.key.keyString}`) : computedPath;
  const sourceIds = uniqueSorted(group.sources.map(source => source.sourceId));
  const sourceLinks = sourceIds.map(sourceId => {
    const source = group.sources.find(item => item.sourceId === sourceId);
    if (!source) throw new NativeReductionError(`missing source ${sourceId} for ${group.key.keyString}`);
    return sourceLink(source.sourceSlug, options.slugCase === 'preserve');
  }).sort();
  const aliases = uniqueSorted([
    ...proposals.flatMap(item => item.aliases ?? []),
    ...(group.existing?.label && group.existing.label !== first.label ? [group.existing.label] : []),
  ]).filter(alias => normalizeLabel(alias) !== group.key.normalizedLabel);
  const tags = uniqueSorted([
    first.typeTag ?? '',
    ...proposals.map(item => item.typeTag ?? ''),
  ]);
  const related = dedupeRelated([
    ...proposals.flatMap(item => item.related ?? []),
    ...proposals.flatMap(item => (item.relatedEntities ?? []).map(label => ({ pageType: 'entity' as const, label }))),
    ...proposals.flatMap(item => (item.relatedConcepts ?? []).map(label => ({ pageType: 'concept' as const, label }))),
  ]);
  const statements = dedupeStatements(proposals.flatMap(item => item.statements ?? []));
  const qualifications = dedupeStatements(proposals.flatMap(item => item.qualifications ?? []));
  const evidence = dedupeEvidence([
    ...proposals.flatMap(item => item.evidence ?? []),
    ...proposals.flatMap(item => item.mentions ?? []),
  ]);
  const summaries = uniqueSorted(proposals.map(item => item.summary ?? ''));
  const bodyParts = proposals.map(item => stripProviderFrontmatter(item.body ?? '').body).filter(Boolean);
  const existing = group.existing;
  const existingMeta = existing ? parseFrontmatter(existing.content) : undefined;
  const reviewed = existing?.reviewed === true || existingMeta?.reviewed === true || proposals.some(item => item.reviewed === true);
  const bodyPolicy: NativePageCandidate['bodyPolicy'] = existing && reviewed
    ? (statements.length || qualifications.length || evidence.length || summaries.length ? 'append-reviewed' : 'preserve-reviewed')
    : existing ? 'preserve-existing' : 'generated';
  const body = existing && reviewed
    ? existingMeta?.body ?? ''
    : existing
      ? [existingMeta?.body ?? '', ...bodyParts].filter(Boolean).join('\n\n')
      : bodyParts.join('\n\n');
  const localReasons: string[] = [];
  const providerUnsupported = proposals.flatMap(item => stripProviderFrontmatter(item.body ?? '').unsupported);
  localReasons.push(...providerUnsupported);
  if (group.crossTypeAlias) localReasons.push(`cross-type-alias:${group.key.normalizedLabel}`);
  if (existing && !reviewed && bodyParts.length > 0) localReasons.push(`native-merge-required:${path}`);
  if (existing && reviewed && (statements.length || qualifications.length || evidence.length || summaries.length)) localReasons.push(`reviewed-append-requires-native-comparison:${path}`);
  const uniqueReasons = uniqueSorted(localReasons);
  globalReasons.push(...uniqueReasons);
  const sourceForRendering = group.sources[0];
  if (!sourceForRendering) throw new NativeReductionError(`group has no source: ${group.key.keyString}`);
  const content = renderPage(
    pageType,
    label,
    options.date,
    sourceLinks,
    tags,
    aliases,
    reviewed,
    body,
    summaries,
    statements,
    qualifications,
    evidence,
    related,
    sourceForRendering,
  );
  return Object.freeze({
    key: group.key,
    path,
    pageType,
    label,
    sourceIds: Object.freeze(sourceIds),
    sourceLinks: Object.freeze(sourceLinks),
    aliases: Object.freeze(aliases),
    tags: Object.freeze(tags),
    related: Object.freeze(related),
    statements: Object.freeze(statements),
    qualifications: Object.freeze(qualifications),
    evidence: Object.freeze(evidence),
    reviewed,
    bodyPolicy,
    content,
    comparisonReasons: Object.freeze(uniqueReasons),
  });
}

function sourcePath(source: NativeSourceScopedIR, options: NativeReducerOptions): string {
  return `${normalizeFolder(options.wikiFolder, 'wikiFolder')}/sources/${safeSlug(source.sourceSlug, options.slugCase === 'preserve')}.md`;
}

function renderIndex(options: NativeReducerOptions, pages: readonly NativePageCandidate[], sources: readonly NativeSourceScopedIR[]): string {
  const entities = pages.filter(page => page.pageType === 'entity').sort((left, right) => left.path.localeCompare(right.path));
  const concepts = pages.filter(page => page.pageType === 'concept').sort((left, right) => left.path.localeCompare(right.path));
  const sourceRows = [...sources].sort((left, right) => sourcePath(left, options).localeCompare(sourcePath(right, options)));
  const lines = ['# Wiki Index', ''];
  const section = (heading: string, rows: readonly string[]) => {
    lines.push(`## ${heading}`);
    if (rows.length) lines.push(...rows.map(row => `- ${row}`));
    else lines.push('- None');
    lines.push('');
  };
  section('Entities', entities.map(page => `[[${page.path.slice(normalizeFolder(options.wikiFolder, 'wikiFolder').length + 1, -3)}|${page.label}]]`));
  section('Concepts', concepts.map(page => `[[${page.path.slice(normalizeFolder(options.wikiFolder, 'wikiFolder').length + 1, -3)}|${page.label}]]`));
  section('Sources', sourceRows.map(source => `[[sources/${safeSlug(source.sourceSlug, options.slugCase === 'preserve')}|${text(source.sourceTitle) || source.sourceSlug}]]`));
  return `${lines.join('\n').trim()}\n`;
}

function renderLog(options: NativeReducerOptions, pages: readonly NativePageCandidate[], sources: readonly NativeSourceScopedIR[]): string {
  const existing = options.global.existing?.get(options.global.paths.log) ?? options.existingFiles?.get(options.global.paths.log) ?? '';
  const lines = [
    `## Headless ingest ${options.global.runId}`,
    '',
    `- Sources: ${sources.length}`,
    `- Canonical pages: ${pages.length}`,
    `- Entities: ${pages.filter(page => page.pageType === 'entity').length}`,
    `- Concepts: ${pages.filter(page => page.pageType === 'concept').length}`,
    '',
  ];
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${lines.join('\n')}`;
}

function checkAliasCollisions(pages: readonly NativePageCandidate[], reasons: string[]): void {
  const pageLabels = new Map<string, string>();
  for (const page of pages) {
    const key = normalizeLabel(page.label);
    const prior = pageLabels.get(key);
    if (prior && prior !== page.key.keyString) reasons.push(`duplicate-page-label:${key}:${prior}:${page.key.keyString}`);
    else pageLabels.set(key, page.key.keyString);
  }
  const owners = new Map<string, string>();
  for (const page of pages) {
    for (const alias of page.aliases) {
      const key = normalizeLabel(alias);
      const pageOwner = pageLabels.get(key);
      if (pageOwner && pageOwner !== page.key.keyString) {
        reasons.push(`ambiguous-alias:${alias}:${pageOwner}:${page.key.keyString}`);
      }
      const prior = owners.get(key);
      if (prior && prior !== page.key.keyString) reasons.push(`ambiguous-alias:${alias}:${prior}:${page.key.keyString}`);
      else owners.set(key, page.key.keyString);
    }
  }
}

function checkSourceAliasCollisions(
  sources: readonly NativeSourceScopedIR[],
  pages: readonly NativePageCandidate[],
  reasons: string[],
): void {
  const sourceTitleOwners = new Map<string, string>();
  const pageOwners = new Map<string, string>();
  for (const source of sources) {
    const owner = `source:${source.sourceId}`;
    const titleKey = normalizeLabel(text(source.sourceTitle));
    if (titleKey && !sourceTitleOwners.has(titleKey)) sourceTitleOwners.set(titleKey, owner);
  }
  for (const page of pages) {
    const owner = `page:${page.key.keyString}`;
    const labelKey = normalizeLabel(page.label);
    if (labelKey && !pageOwners.has(labelKey)) pageOwners.set(labelKey, owner);
    for (const alias of page.aliases) {
      const key = normalizeLabel(alias);
      if (key && !pageOwners.has(key)) pageOwners.set(key, owner);
    }
  }
  const sourceAliasOwners = new Map<string, string>();
  for (const source of sources) {
    const owner = `source:${source.sourceId}`;
    for (const alias of source.sourceAliases ?? []) {
      const key = normalizeLabel(alias);
      if (!key) continue;
      const priorAlias = sourceAliasOwners.get(key);
      if (priorAlias && priorAlias !== owner) reasons.push(`ambiguous-source-alias:${alias}:${priorAlias}:${owner}`);
      else sourceAliasOwners.set(key, owner);
      const priorTitle = sourceTitleOwners.get(key);
      if (priorTitle && priorTitle !== owner) reasons.push(`ambiguous-source-alias:${alias}:${priorTitle}:${owner}`);
      const pageOwner = pageOwners.get(key);
      if (pageOwner) reasons.push(`ambiguous-source-alias:${alias}:${owner}:${pageOwner}`);
    }
  }
}

function compareExistingPath(existing: NativeExistingPage, candidate: NativePageCandidate, reasons: string[]): void {
  const existingMeta = parseFrontmatter(existing.content);
  if (existing.pageType !== candidate.pageType) reasons.push(`existing-page-type-mismatch:${candidate.path}`);
  if (existingMeta.type && existingMeta.type !== candidate.pageType) reasons.push(`existing-frontmatter-type-mismatch:${candidate.path}`);
}

/**
 * Reduce source-local IR into a deterministic, write-free native candidate.
 *
 * The reducer intentionally does not call the native page factory: its body
 * merge and reviewed append paths are LLM-owned.  Those cases remain visible
 * in `comparisonReasons` and make the returned plan non-applyable.
 */
export function reduceNativeSourceIR(
  input: readonly NativeSourceScopedIR[],
  options: NativeReducerOptions,
): NativeReductionPlan {
  if (!Array.isArray(input) || input.length === 0) throw new NativeReductionError('at least one source-scoped IR record is required');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.date)) throw new NativeReductionError(`date must be YYYY-MM-DD: ${options.date}`);
  if (!text(options.global.schemaContent)) throw new NativeReductionError('global schema content is required for a complete desired-state plan');
  const wikiFolder = normalizeFolder(options.wikiFolder, 'wikiFolder');
  const sourceIds = new Set<string>();
  const sourcePaths = new Map<string, string>();
  const sources = [...input].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const preserveSourceCase = options.slugCase === 'preserve';
  for (const source of sources) {
    if (!text(source.sourceId) || sourceIds.has(source.sourceId)) throw new NativeReductionError(`duplicate or empty source id: ${source.sourceId}`);
    sourceIds.add(source.sourceId);
    if (!text(source.sourcePath) || !text(source.sourceSlug)) throw new NativeReductionError(`source ${source.sourceId} lacks source path or slug`);
    const normalizedSourcePath = assertSourceReference(source.sourcePath, `source ${source.sourceId}.sourcePath`);
    const expectedSourceSlug = nativeMapSourceSlug(normalizedSourcePath, preserveSourceCase);
    if (text(source.sourceSlug) !== expectedSourceSlug) {
      throw new NativeReductionError(`source ${source.sourceId} source slug does not match native path fingerprint: expected ${expectedSourceSlug}, received ${JSON.stringify(source.sourceSlug)}`);
    }
    const sourcePathKey = pathCollisionKey(normalizedSourcePath);
    const priorSourceId = sourcePaths.get(sourcePathKey);
    if (priorSourceId && priorSourceId !== source.sourceId) {
      throw new NativeReductionError(`duplicate source path across source ids: ${normalizedSourcePath}`);
    }
    sourcePaths.set(sourcePathKey, source.sourceId);
    safeSlug(source.sourceSlug, true);
  }
  const groups = new Map<string, Group>();
  for (const source of sources) {
    const proposalIds = new Set<string>();
    for (const raw of source.proposals) {
      const proposal = normalizeProposal(raw, source);
      const proposalId = text(proposal.proposalId);
      if (proposalIds.has(proposalId)) throw new NativeReductionError(`duplicate proposal id in source ${source.sourceId}: ${proposalId}`);
      proposalIds.add(proposalId);
      const key = canonicalKey(proposal.pageType, proposal.label);
      const existing = groups.get(key.keyString);
      if (existing) {
        existing.proposals.push(proposal);
        if (!existing.sources.some(item => item.sourceId === source.sourceId)) existing.sources.push(source);
      } else {
        groups.set(key.keyString, { key, proposals: [proposal], sources: [source], crossTypeAlias: false });
      }
    }
  }
  const existingPages = inferExistingPages(options);
  const existingByKey = new Map<string, NativeExistingPage>();
  const existingByPath = new Map<string, NativeExistingPage>();
  for (const existing of existingPages) {
    const normalizedPath = assertRelativePath(existing.path, `existing page ${existing.path}`);
    const pathKey = pathCollisionKey(normalizedPath);
    const priorPath = existingByPath.get(pathKey);
    if (priorPath) throw new NativeReductionError(`duplicate existing page path: ${normalizedPath}`);
    existingByPath.set(pathKey, existing);
    const label = text(existing.label) || normalizedPath.split('/').pop()?.replace(/\.md$/iu, '') || '';
    if (existing.pageType === 'entity' || existing.pageType === 'concept') {
      const key = canonicalKey(existing.pageType, label);
      if (existingByKey.has(key.keyString)) throw new NativeReductionError(`duplicate existing page key: ${key.keyString}`);
      existingByKey.set(key.keyString, existing);
      const group = groups.get(key.keyString);
      if (group) group.existing = existing;
    }
  }
  const byLabel = new Map<string, Group[]>();
  for (const group of groups.values()) {
    const list = byLabel.get(group.key.normalizedLabel) ?? [];
    list.push(group);
    byLabel.set(group.key.normalizedLabel, list);
  }
  const structuralReasons: string[] = [];
  for (const [label, sameLabel] of byLabel.entries()) {
    const types = new Set(sameLabel.map(group => group.key.pageType));
    if (types.size <= 1) continue;
    const existingMatches = sameLabel.filter(group => group.existing);
    if (existingMatches.length === 1) {
      const target = existingMatches[0];
      if (!target) continue;
      for (const group of sameLabel) {
        if (group !== target) {
          target.proposals.push(...group.proposals);
          for (const source of group.sources) if (!target.sources.some(item => item.sourceId === source.sourceId)) target.sources.push(source);
          target.crossTypeAlias = true;
          groups.delete(group.key.keyString);
        }
      }
    } else {
      structuralReasons.push(`unresolved-cross-type-collision:${label}`);
      for (const group of sameLabel) group.crossTypeAlias = true;
    }
  }
  // Adapter-level refusals are authoritative.  They must remain in both the
  // comparison reasons and the explicit unsupported list; dropping one here
  // would let a partially understood native-map result become applyable.
  const sourceUnsupported = sources.flatMap(source => source.unsupported ?? []).map(text).filter(Boolean);
  const comparisonReasons = [...sourceUnsupported, ...structuralReasons];
  const pages = [...groups.values()].sort((left, right) => left.key.keyString.localeCompare(right.key.keyString)).map(group => candidateForGroup(group, options, comparisonReasons));
  checkAliasCollisions(pages, comparisonReasons);
  checkSourceAliasCollisions(sources, pages, comparisonReasons);
  const pathOwners = new Map<string, string>();
  for (const page of pages) {
    const pagePathKey = pathCollisionKey(page.path);
    const prior = pathOwners.get(pagePathKey);
    if (prior && prior !== page.key.keyString) comparisonReasons.push(`path-collision:${page.path}:${prior}:${page.key.keyString}`);
    pathOwners.set(pagePathKey, page.key.keyString);
    const existing = existingByPath.get(pagePathKey);
    if (existing) {
      const existingForKey = existingByKey.get(page.key.keyString);
      if (existingForKey !== existing) comparisonReasons.push(`existing-path-collision:${page.path}:${existing.path}`);
      compareExistingPath(existing, page, comparisonReasons);
    }
  }
  const desiredPages = pages.map(page => desiredFile(page.path, page.pageType, 'partition', page.content, page.sourceIds, options.existingFiles, page.key));
  const sourceFiles = sources.map(source => desiredFile(sourcePath(source, { ...options, wikiFolder }), 'source', 'serialized-global', renderSourcePage(source, options), [source.sourceId], options.existingFiles));
  const indexPath = assertRelativePath(options.global.paths.index, 'global.index');
  const logPath = assertRelativePath(options.global.paths.log, 'global.log');
  const schemaPath = assertRelativePath(options.global.paths.schema, 'global.schema');
  const globalFiles = [
    desiredFile(indexPath, 'index', 'serialized-global', renderIndex(options, pages, sources), sources.map(source => source.sourceId), options.existingFiles),
    desiredFile(logPath, 'log', 'serialized-global', renderLog(options, pages, sources), sources.map(source => source.sourceId), options.existingFiles),
    desiredFile(schemaPath, 'schema', 'serialized-global', options.global.schemaContent, sources.map(source => source.sourceId), options.existingFiles),
  ];
  // Source pages are part of the serialized global phase because entity and
  // concept frontmatter links point at them.  Keep the phase order explicit:
  // sources first, then the native global trio in index/log/schema order.
  const serializedGlobalFiles = [...sourceFiles.sort((left, right) => left.path.localeCompare(right.path)), ...globalFiles];
  for (const file of serializedGlobalFiles) {
    const existing = existingByPath.get(pathCollisionKey(file.path));
    if (existing && existing.pageType !== file.kind) {
      comparisonReasons.push(`existing-file-kind-mismatch:${file.path}:${existing.pageType}:${file.kind}`);
    }
  }
  const globalPhase: NativeGlobalPhase = Object.freeze({
    serialized: true,
    serializationOrder: Object.freeze(serializedGlobalFiles.map(file => file.path)),
    files: Object.freeze(serializedGlobalFiles),
  });
  const allPathOwners = new Map<string, string>();
  for (const file of [...desiredPages, ...serializedGlobalFiles]) {
    const filePathKey = pathCollisionKey(file.path);
    const owner = allPathOwners.get(filePathKey);
    const nextOwner = `${file.kind}:${file.sourceIds.join(',')}`;
    if (owner && owner !== nextOwner) comparisonReasons.push(`global-path-collision:${file.path}:${owner}:${nextOwner}`);
    allPathOwners.set(filePathKey, nextOwner);
  }
  const desiredState = Object.freeze([...desiredPages, ...serializedGlobalFiles].sort((left, right) => left.path.localeCompare(right.path)));
  const reasons = uniqueSorted(comparisonReasons);
  const unsupported = uniqueSorted([
    ...sourceUnsupported,
    ...reasons.filter(reason => reason.startsWith('unresolved-cross-type-collision:')
      || reason.startsWith('ambiguous-alias:')
      || reason.startsWith('ambiguous-source-alias:')
      || reason.startsWith('path-collision:')
      || reason.startsWith('global-path-collision:')
      || reason.startsWith('existing-path-collision:')
      || reason.startsWith('provider-frontmatter:')),
  ]);
  const status = reasons.length > 0 ? 'requires-native-comparison' as const : 'candidate' as const;
  return Object.freeze({
    version: 'native-reducer/v1' as const,
    status,
    complete: true as const,
    canApply: reasons.length === 0,
    reasons: Object.freeze(reasons),
    unsupported: Object.freeze(unsupported),
    pages: Object.freeze(pages),
    desiredState,
    globalPhase,
  });
}

export const reduceNative = reduceNativeSourceIR;

/** Reduce the source-scoped native-map/v1 IR directly. */
export function reduceNativeMapIR(
  input: readonly NativeMapIR[],
  options: NativeReducerOptions,
): NativeReductionPlan {
  if (!Array.isArray(input) || input.length === 0) throw new NativeReductionError('at least one native-map IR record is required');
  return reduceNativeSourceIR(input.map(source => nativeMapIRToSourceScopedIR(source, options.slugCase)), options);
}
