/**
 * Write-free native source map.
 *
 * This is deliberately a map seam, not a second WikiEngine.  It reuses the
 * native analyze-source prompt and the native batch-limit policy, but owns all
 * per-source accumulation locally.  No Obsidian object, vault read/write,
 * page factory, index, cache, or global mutable state is reachable here.
 */

import { basename, extname } from 'node:path';

import { PROMPTS } from '../../../../../src/prompts';
import { calculateBatchLimits, adjustBatchSizeForResponse, getCustomTypeCaps } from '../../../../../src/core/batch-limits';
import { parseJsonResult } from '../../../../../src/core/json';
import { coerceToArray } from '../../../../../src/core/arrays';
import { checkCumulativeLimits, checkEmptyBatch, detectConvergence } from '../../../../../src/core/convergence-detector';
import { matchExtractedToExisting } from '../../../../../src/core/index-search';
import { decideSourceLemma } from '../../../../../src/core/source-lemma';
import { renderTemplate } from '../../../../../src/core/template-renderer';
import { TOKENS_PER_ITEM_BUDGET, MAX_TOKENS_BATCH, SOURCE_ANALYZER_RETRY_MULTIPLIER, TOKENS_LEMMA_CLASSIFY } from '../../../../../src/constants';
import { canonicalJson, canonicalJsonSha256, sha256Hex } from '../preflight/hashing';
import { normalizeLabel, hashDomain } from '../provenance/canonical';
import type { ProviderCallParams, ProviderTypedResponse } from '../provider';

import {
  NATIVE_MAP_CONTRACT_VERSION,
  NATIVE_MAP_DEFAULT_EXTRACTED_AT,
  NATIVE_MAP_PROMPT_VERSION,
  NativeMapProtocolError,
  type NativeAliasProposal,
  type NativeClaimProposal,
  type NativeConceptProposal,
  type NativeContradictionProposal,
  type NativeEntityProposal,
  type NativeMapArtifact,
  type NativeMapArtifactKind,
  type NativeMapClient,
  type NativeMapExistingPage,
  type NativeMapInput,
  type NativeMapIR,
  type NativeMapPolicy,
  type NativeMapPolicyInput,
  type NativeMapSettings,
  type NativeMapSource,
  type NativeMention,
  type NativeRelatedProposal,
} from './types';

const ARTIFACT_DOMAIN = 'spm-brain/native-map-artifact/v1\0';

const DEFAULT_ENTITY_TAGS = Object.freeze([
  'person', 'organization', 'project', 'product', 'event', 'place', 'other',
]);
const DEFAULT_CONCEPT_TAGS = Object.freeze([
  'theory', 'method', 'field', 'phenomenon', 'standard', 'term', 'other',
]);

const WIKI_LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  en: 'English', zh: '中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português', it: 'Italiano',
  ru: 'Русский',
});

function getWikiLanguageName(language: string): string {
  return WIKI_LANGUAGE_NAMES[language] ?? language;
}

function normalizeSourceLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function isCrossLanguage(sourceLanguage: string | null, wikiLanguage: string): boolean {
  if (sourceLanguage !== null) {
    const language = sourceLanguage.toLowerCase();
    const wikiName = getWikiLanguageName(wikiLanguage).toLowerCase();
    return language !== wikiLanguage.toLowerCase() && language !== wikiName;
  }
  return wikiLanguage !== 'en';
}

function nativeGranularityInstruction(settings: Pick<NativeMapSettings, 'extractionGranularity' | 'customEntityLimit' | 'customConceptLimit'>): string {
  if (settings.extractionGranularity === 'custom') {
    return `Extract at most ${settings.customEntityLimit ?? 5} entities and at most ${settings.customConceptLimit ?? 5} concepts from the source. If you reach either limit, stop extracting that type.`;
  }
  const instructions: Record<Exclude<NativeMapSettings['extractionGranularity'], 'custom'>, string> = {
    fine: 'Extract ALL entities and concepts worth recording from the source, including those mentioned only once or tangentially.',
    standard: 'Extract important and moderately important entities and concepts from the source. Ignore minor items mentioned only in passing.',
    coarse: 'Extract only the most essential entities and concepts from the source — those without which the text cannot be understood. Quality over quantity.',
    minimal: 'Extract only the most critical entities and concepts from the source — maximum 3 total items. Extreme selectivity for cost control.',
  };
  return instructions[settings.extractionGranularity];
}

const SOURCE_ANALYSIS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: ['entities', 'concepts'],
  additionalProperties: true,
  properties: {
    source_title: { type: 'string' },
    summary: { type: 'string' },
    entities: { type: 'array' },
    concepts: { type: 'array' },
    contradictions: { type: 'array' },
    related_pages: { type: 'array' },
    key_points: { type: 'array' },
  },
});

const LEMMA_CLASSIFY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: ['kind'],
  additionalProperties: true,
  properties: {
    kind: { type: 'string' },
  },
});

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new NativeMapProtocolError('invalid-source', 'Native source bytes must be a Uint8Array');
  }
  return new Uint8Array(value);
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw new NativeMapProtocolError(
      'invalid-source',
      `Native source bytes are not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    // Typed-array views with elements cannot be Object.freeze()'d in Node.
    // Source bytes are copied at the boundary and never exposed through the
    // returned IR, so freezing the containing record is sufficient here.
    if (ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value)) {
      for (const item of value) freeze(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  field: string,
  code: NativeMapProtocolError['code'] = 'invalid-policy',
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new NativeMapProtocolError(code, `${field} must be a non-empty string without NUL`);
  }
  return value.trim();
}

function safeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new NativeMapProtocolError('invalid-policy', `${field} must be a string without NUL`);
  }
  return value;
}

function normalizeTagList(values: readonly string[], field: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = nonEmptyString(value, `${field} entry`);
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  if (result.length === 0) throw new NativeMapProtocolError('invalid-policy', `${field} must not be empty`);
  return result;
}

function csvTags(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function expectedTags(settings: NativeMapSettings, page: 'entity' | 'concept'): string[] {
  const custom = page === 'entity' ? csvTags(settings.customEntityTags) : csvTags(settings.customConceptTags);
  if (settings.tagVocabularyMode === 'custom' && custom.length > 0) return normalizeTagList(custom, `${page} tags`);
  return [...(page === 'entity' ? DEFAULT_ENTITY_TAGS : DEFAULT_CONCEPT_TAGS)];
}

function assertHash(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new NativeMapProtocolError('invalid-policy', `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function freezePolicy(input: NativeMapPolicy | NativeMapPolicyInput): NativeMapPolicy {
  const settings = input.settings;
  const safeSettings: NativeMapSettings = {
    provider: nonEmptyString(settings.provider, 'settings.provider'),
    model: nonEmptyString(settings.model, 'settings.model'),
    ...(typeof settings.ingestModel === 'string' && settings.ingestModel.trim()
      ? { ingestModel: settings.ingestModel.trim() }
      : {}),
    wikiLanguage: nonEmptyString(settings.wikiLanguage, 'settings.wikiLanguage'),
    extractionGranularity: settings.extractionGranularity,
    ...(settings.customEntityLimit === undefined ? {} : { customEntityLimit: settings.customEntityLimit }),
    ...(settings.customConceptLimit === undefined ? {} : { customConceptLimit: settings.customConceptLimit }),
    tagVocabularyMode: settings.tagVocabularyMode,
    customEntityTags: safeString(settings.customEntityTags, 'settings.customEntityTags'),
    customConceptTags: safeString(settings.customConceptTags, 'settings.customConceptTags'),
    ...(settings.disableThinking === undefined ? {} : { disableThinking: settings.disableThinking }),
  };
  if (!['fine', 'standard', 'coarse', 'minimal', 'custom'].includes(safeSettings.extractionGranularity)) {
    throw new NativeMapProtocolError('invalid-policy', 'settings.extractionGranularity is unsupported');
  }
  if (!['default', 'custom'].includes(safeSettings.tagVocabularyMode)) {
    throw new NativeMapProtocolError('invalid-policy', 'settings.tagVocabularyMode is unsupported');
  }
  const limitsToCheck: ReadonlyArray<readonly [string, number | undefined]> = [
    ['customEntityLimit', safeSettings.customEntityLimit],
    ['customConceptLimit', safeSettings.customConceptLimit],
  ];
  for (const [field, value] of limitsToCheck) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 500)) {
      throw new NativeMapProtocolError('invalid-policy', `${field} must be an integer between 1 and 500`);
    }
  }

  const entityTags = normalizeTagList(input.entityTags, 'entityTags');
  const conceptTags = normalizeTagList(input.conceptTags, 'conceptTags');
  const expectedEntity = expectedTags(safeSettings, 'entity');
  const expectedConcept = expectedTags(safeSettings, 'concept');
  if (canonicalJson(entityTags) !== canonicalJson(expectedEntity)) {
    throw new NativeMapProtocolError('invalid-policy', 'entityTags do not match the frozen native tag vocabulary');
  }
  if (canonicalJson(conceptTags) !== canonicalJson(expectedConcept)) {
    throw new NativeMapProtocolError('invalid-policy', 'conceptTags do not match the frozen native tag vocabulary');
  }

  const schemaContext = input.schemaContext === undefined ? undefined : safeString(input.schemaContext, 'schemaContext');
  const systemPrompt = input.systemPrompt === undefined ? undefined : safeString(input.systemPrompt, 'systemPrompt');
  const promptVersion = input.promptVersion === undefined ? NATIVE_MAP_PROMPT_VERSION : nonEmptyString(input.promptVersion, 'promptVersion');
  const settingsSha256 = 'settingsSha256' in input && input.settingsSha256
    ? assertHash(input.settingsSha256, 'settingsSha256')
    : canonicalJsonSha256(safeSettings);
  const vocabularySha256 = 'vocabularySha256' in input && input.vocabularySha256
    ? assertHash(input.vocabularySha256, 'vocabularySha256')
    : canonicalJsonSha256({ entityTags, conceptTags });
  const policyPackSha256 = 'policyPackSha256' in input && input.policyPackSha256
    ? assertHash(input.policyPackSha256, 'policyPackSha256')
    : canonicalJsonSha256({ schemaContext: schemaContext ?? null, promptVersion, entityTags, conceptTags });
  const policySha256 = canonicalJsonSha256({
    contractVersion: NATIVE_MAP_CONTRACT_VERSION,
    promptVersion,
    settings: safeSettings,
    entityTags,
    conceptTags,
    schemaContext: schemaContext ?? null,
    systemPrompt: systemPrompt ?? null,
    settingsSha256,
    vocabularySha256,
    policyPackSha256,
  });
  return freeze({
    contractVersion: NATIVE_MAP_CONTRACT_VERSION,
    promptVersion,
    settings: freeze(safeSettings),
    entityTags: freeze(entityTags),
    conceptTags: freeze(conceptTags),
    ...(schemaContext === undefined ? {} : { schemaContext }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    policyPackSha256,
    settingsSha256,
    vocabularySha256,
    policySha256,
  });
}

/** Public helper for hosts that need the policy hash before scheduling. */
export function createNativeMapPolicy(input: NativeMapPolicyInput): NativeMapPolicy {
  return freezePolicy(input);
}

function normalizeSourcePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').normalize('NFKC');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new NativeMapProtocolError('invalid-source', `Unsafe source path: ${path}`);
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    throw new NativeMapProtocolError('invalid-source', `Unsafe source path: ${path}`);
  }
  return parts.join('/');
}

function frontmatterBody(content: string): string {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---', 4);
  return end === -1 ? normalized : normalized.slice(end + 4);
}

function readFrontmatter(content: string): { aliases: string[]; language: string | null } {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) return { aliases: [], language: null };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { aliases: [], language: null };
  const lines = normalized.slice(4, end).split('\n');
  const aliases: string[] = [];
  let current: 'aliases' | null = null;
  let language: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && current === 'aliases') {
      const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/gu, '');
      if (value) aliases.push(value);
      continue;
    }
    current = null;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'language') {
      language = value.replace(/^['"]|['"]$/gu, '') || null;
    } else if (key === 'aliases') {
      current = 'aliases';
      if (value.startsWith('[') && value.endsWith(']')) {
        for (const alias of value.slice(1, -1).split(',')) {
          const clean = alias.trim().replace(/^['"]|['"]$/gu, '');
          if (clean) aliases.push(clean);
        }
        current = null;
      }
    }
  }
  return { aliases: uniqueStrings(aliases), language: normalizeSourceLanguage(language) };
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

function sourceSlug(path: string): string {
  const raw = basenameWithoutExtension(path).normalize('NFKC').trim();
  const slug = raw.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase();
  return slug || 'source';
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === 'string')) : [];
}

function normalizeRelatedPageLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^\[\[(?:[^\]|]+\|)?([^\]]+)\]\]$/u.exec(trimmed);
  return match ? match[1].trim() || null : trimmed;
}

function assertSource(source: NativeMapSource): { source: NativeMapSource; content: string; byteSha256: string; path: string } {
  if (!source || typeof source !== 'object') throw new NativeMapProtocolError('invalid-source', 'Native source is required');
  const sourceId = nonEmptyString(source.sourceId, 'source.sourceId', 'invalid-source');
  const path = normalizeSourcePath(nonEmptyString(source.sourcePath, 'source.sourcePath', 'invalid-source'));
  const bytes = cloneBytes(source.sourceBytes);
  const content = decodeUtf8(bytes);
  if (frontmatterBody(content).trim().length === 0) {
    throw new NativeMapProtocolError('blank-source', `Source ${path} has no extractable body`);
  }
  const extractedAt = source.extractedAt ?? NATIVE_MAP_DEFAULT_EXTRACTED_AT;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(extractedAt)) {
    throw new NativeMapProtocolError('invalid-source', 'source.extractedAt must be an ISO UTC timestamp');
  }
  return {
    source: freeze({ sourceId, sourcePath: path, sourceBytes: bytes, extractedAt }),
    content,
    byteSha256: sha256Hex(bytes),
    path,
  };
}

function activeTag(tags: readonly string[], candidate: unknown, fallback: string): string {
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return tags.includes(fallback) ? fallback : tags[0] ?? fallback;
}

function normalizeMention(
  raw: unknown,
  source: { path: string; content: string; slug: string; extractedAt: string },
): NativeMention {
  if (!isRecord(raw)) throw new NativeMapProtocolError('invalid-provenance', 'mentions_with_provenance entry must be an object');
  const quote = nonEmptyString(raw.quote, 'mention.quote', 'invalid-provenance');
  if (!source.content.includes(quote)) {
    throw new NativeMapProtocolError('invalid-provenance', `Mention quote is not an exact substring of ${source.path}`);
  }
  if (raw.source_path !== undefined && raw.source_path !== '' && raw.source_path !== source.path) {
    throw new NativeMapProtocolError('invalid-provenance', `Mention source_path does not match ${source.path}`);
  }
  const translation = typeof raw.translation === 'string' && raw.translation.trim() ? raw.translation.trim() : undefined;
  return freeze({
    quote,
    ...(translation === undefined ? {} : { translation }),
    source_path: source.path,
    source_slug: source.slug,
    extracted_at: source.extractedAt,
  });
}

function normalizeMentions(
  raw: JsonRecord,
  source: { path: string; content: string; slug: string; extractedAt: string },
): NativeMention[] {
  const structured = Array.isArray(raw.mentions_with_provenance)
    ? raw.mentions_with_provenance.map(item => normalizeMention(item, source))
    : [];
  const legacy = asStringArray(raw.mentions_in_source).map(quote => normalizeMention({ quote }, source));
  const result: NativeMention[] = [];
  const seen = new Set<string>();
  for (const mention of [...structured, ...legacy]) {
    const key = `${mention.quote}\u0000${mention.source_path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mention);
  }
  return result;
}

function normalizeItem(
  raw: unknown,
  page: 'entity' | 'concept',
  policy: NativeMapPolicy,
  source: { path: string; content: string; slug: string; extractedAt: string },
): NativeEntityProposal | NativeConceptProposal {
  if (!isRecord(raw)) throw new NativeMapProtocolError('invalid-response', `${page} proposal must be an object`);
  const name = nonEmptyString(raw.name, `${page}.name`, 'invalid-response');
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const mentions = normalizeMentions(raw, source);
  const aliases = asStringArray(raw.aliases).filter(alias => normalizeLabel(alias) !== normalizeLabel(name));
  const relatedEntities = asStringArray(raw.related_entities);
  const relatedConcepts = asStringArray(raw.related_concepts);
  const type = activeTag(page === 'entity' ? policy.entityTags : policy.conceptTags, raw.type, page === 'entity' ? 'other' : 'term');
  if (page === 'entity') {
    return freeze({
      name, type, aliases, summary,
      mentions_in_source: freeze(mentions.map(mention => mention.quote)),
      mentions_with_provenance: freeze(mentions),
      related_entities: relatedEntities,
      related_concepts: relatedConcepts,
    });
  }
  return freeze({
    name, type, aliases, summary,
    mentions_in_source: freeze(mentions.map(mention => mention.quote)),
    mentions_with_provenance: freeze(mentions),
    related_concepts: relatedConcepts,
    related_entities: relatedEntities,
  });
}

function mergeItems<T extends NativeEntityProposal | NativeConceptProposal>(items: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    const key = normalizeLabel(item.name);
    const prior = byName.get(key);
    if (!prior) {
      byName.set(key, item);
      continue;
    }
    const mentions = [...prior.mentions_with_provenance];
    const seenMentions = new Set(mentions.map(mention => `${mention.quote}\u0000${mention.source_path}`));
    for (const mention of item.mentions_with_provenance) {
      const mentionKey = `${mention.quote}\u0000${mention.source_path}`;
      if (!seenMentions.has(mentionKey)) {
        mentions.push(mention);
        seenMentions.add(mentionKey);
      }
    }
    const merged = {
      ...prior,
      aliases: uniqueStrings([...prior.aliases, ...item.aliases]),
      mentions_in_source: freeze(mentions.map(mention => mention.quote)),
      mentions_with_provenance: freeze(mentions),
      related_entities: uniqueStrings([...prior.related_entities, ...item.related_entities]),
      related_concepts: uniqueStrings([...prior.related_concepts, ...item.related_concepts]),
      summary: prior.summary || item.summary,
    } as T;
    byName.set(key, freeze(merged));
  }
  return [...byName.values()];
}

function batchContext(
  batch: number,
  entities: readonly NativeEntityProposal[],
  concepts: readonly NativeConceptProposal[],
): string {
  if (batch === 0) return 'This is the first extraction round. Extract the most important entities and concepts from the source.';
  const lines = [...entities, ...concepts].map(item => item.aliases.length
    ? `${item.name} (aliases: ${item.aliases.join(', ')})`
    : item.name);
  const already = lines.length
    ? `\n\nAlready extracted from this source:\n  [${lines.join('; ')}]\n  (including abbreviations, synonyms, and translations of these names)\nDo NOT extract them again. If a candidate name is equivalent to any of the above — including their aliases — skip it.`
    : '';
  return `This is round ${batch + 1} of extraction. Extract the next batch of most important entities and concepts from the remaining content. If no more items are worth extracting, return empty arrays [] for entities and concepts.${already}`;
}

function buildTagVocabularySection(policy: NativeMapPolicy): string {
  return [
    '## Active Tag Vocabulary (runtime)',
    '',
    'When assigning `type` to an entity or concept, you MUST use one of the following allowed values. Do NOT invent new types.',
    '',
    '**Entity types** (entity_type field — one of):',
    ...policy.entityTags.map(tag => `- ${tag}`),
    '',
    '**Concept types** (concept_type field — one of):',
    ...policy.conceptTags.map(tag => `- ${tag}`),
    '',
    'If a discovered item does not clearly fit any of the above, choose the closest match. Do NOT emit a free-form type string — the frontmatter validator will reject it.',
  ].join('\n');
}

function buildSystemPrompt(policy: NativeMapPolicy): string | undefined {
  const parts = [
    policy.systemPrompt,
    policy.schemaContext,
    `IMPORTANT: You MUST write ALL content in ${getWikiLanguageName(policy.settings.wikiLanguage)}. Every summary, description, source title, and key point must be in that language. Entity and concept names remain in their original source language.`,
    buildTagVocabularySection(policy),
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join('\n\n') : undefined;
}

function languageHints(policy: NativeMapPolicy, sourceLanguage: string | null): string {
  const wikiName = getWikiLanguageName(policy.settings.wikiLanguage);
  const crossLanguage = isCrossLanguage(sourceLanguage, policy.settings.wikiLanguage);
  const translation = crossLanguage
    ? `\n\nTRANSLATION (cross-language wikis): For each entry in mentions_with_provenance, ALSO add a 'translation' field containing a ${wikiName} translation of the quote text. The 'quote' field MUST stay verbatim in the source's original language; the translation goes in a separate 'translation' field.`
    : '';
  return `\n\nCRITICAL LANGUAGE REQUIREMENT: Summaries, descriptions, source_title, and key_points in your JSON output MUST be written in ${wikiName}. HOWEVER: entity names and concept names MUST be preserved in their original source language -- NEVER translate names. mentions_in_source MUST be verbatim quotes from the source (preserve original language).${translation}`;
}

function asProviderParams(
  policy: NativeMapPolicy,
  prompt: string,
  maxTokens: number,
  task = 'extract',
  includeThinking = true,
  maxTokensPerCall = maxTokens * SOURCE_ANALYZER_RETRY_MULTIPLIER,
): ProviderCallParams {
  return {
    task,
    model: policy.settings.ingestModel?.trim() || policy.settings.model,
    max_tokens: maxTokens,
    maxTokensPerCall,
    system: buildSystemPrompt(policy),
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object', schema: SOURCE_ANALYSIS_JSON_SCHEMA },
    ...(includeThinking && policy.settings.disableThinking === true ? { enableThinking: false } : {}),
  };
}

function asLemmaParams(policy: NativeMapPolicy, prompt: string): ProviderCallParams {
  return {
    task: 'lemma-classify',
    model: policy.settings.ingestModel?.trim() || policy.settings.model,
    max_tokens: TOKENS_LEMMA_CLASSIFY,
    system: buildSystemPrompt(policy),
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object', schema: LEMMA_CLASSIFY_JSON_SCHEMA },
    ...(policy.settings.disableThinking === true ? { enableThinking: false } : {}),
  };
}

async function callProvider(
  client: NativeMapClient,
  params: ProviderCallParams,
): Promise<{ text: string; finishReason?: string; inputTokens?: number; outputTokens?: number }> {
  if (client.createMessageWithOutput) {
    const result: ProviderTypedResponse<unknown> = await client.createMessageWithOutput(params);
    const text = result.text || (result.output === undefined ? '' : JSON.stringify(result.output));
    return {
      text,
      finishReason: result.finishReason,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
  }
  return { text: await client.createMessage(params) };
}

function copyExistingPages(value: readonly NativeMapExistingPage[] | undefined): Array<{ title: string; aliases?: string[] }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new NativeMapProtocolError('invalid-source', 'existingPages must be an array');
  }
  const pages: Array<{ title: string; aliases?: string[] }> = [];
  for (const page of value) {
    if (!isRecord(page)) throw new NativeMapProtocolError('invalid-source', 'existingPages entry must be an object');
    const title = nonEmptyString(page.title, 'existingPages.title', 'invalid-source');
    const aliases = asStringArray(page.aliases);
    pages.push(freeze({ title, ...(aliases.length ? { aliases: freeze(aliases) } : {}) }));
  }
  return pages;
}

async function classifySourceLemma(
  policy: NativeMapPolicy,
  client: NativeMapClient,
  name: string,
  summary: string,
): Promise<'entity' | 'concept' | null> {
  const prompt = `A wiki page must be created for "${name}". Decide which kind it is.

entity  — a thing that exists: a substance, gene, protein, organism, product, person, organization, place.
concept — a thing that is the case: a process, mechanism, method, theory, condition, field of study.

Summary of the source describing it:
${summary}

Respond with this JSON object and nothing else: {"kind": "entity"} or {"kind": "concept"}`;
  try {
    const response = await callProvider(client, asLemmaParams(policy, prompt));
    const parsed = await parseJsonResult(response.text, undefined, { expectedSchemaFields: ['kind'] });
    if (!parsed.ok) return null;
    const kind = typeof parsed.value.kind === 'string' ? parsed.value.kind.trim().toLowerCase() : '';
    return kind === 'entity' || kind === 'concept' ? kind : null;
  } catch (error) {
    console.warn('[Lemma guarantee] type classification call failed:', error);
    return null;
  }
}

function firstActiveTag(policy: NativeMapPolicy, target: 'entity' | 'concept'): string {
  const tags = target === 'entity' ? policy.entityTags : policy.conceptTags;
  return tags[0] ?? (target === 'entity' ? 'other' : 'term');
}

function normalizeBatch(
  value: Record<string, unknown>,
  policy: NativeMapPolicy,
  source: { path: string; content: string; slug: string; extractedAt: string },
): {
  validity: 'valid' | 'empty' | 'unusable';
  entities: NativeEntityProposal[];
  concepts: NativeConceptProposal[];
  sourceTitle: string | null;
  summary: string | null;
  contradictions: NativeContradictionProposal[];
  relatedPages: string[];
  keyPoints: string[];
  empty: boolean;
} {
  // Match SourceAnalyzer.normalizeBatchResponse: non-array values are
  // coerced to empty arrays, and malformed array members are ignored when
  // they do not carry a usable name.  This keeps harmless model-shape drift
  // from aborting an otherwise valid source while preserving strict
  // provenance checks for members that are actually extracted.
  const rawEntities = coerceToArray<unknown>(value.entities);
  const rawConcepts = coerceToArray<unknown>(value.concepts);
  const entities = rawEntities
    .filter((item): item is JsonRecord => isRecord(item) && typeof item.name === 'string' && item.name.trim().length > 0)
    .map(item => normalizeItem(item, 'entity', policy, source) as NativeEntityProposal);
  const concepts = rawConcepts
    .filter((item): item is JsonRecord => isRecord(item) && typeof item.name === 'string' && item.name.trim().length > 0)
    .map(item => normalizeItem(item, 'concept', policy, source) as NativeConceptProposal);
  const contradictions: NativeContradictionProposal[] = [];
  if (Array.isArray(value.contradictions)) {
    for (const item of coerceToArray<unknown>(value.contradictions)) {
      if (!isRecord(item)) throw new NativeMapProtocolError('invalid-response', 'Contradiction proposal must be an object');
      contradictions.push(freeze({
        claim: nonEmptyString(item.claim, 'contradiction.claim', 'invalid-response'),
        source_page: safeString(item.source_page ?? '', 'contradiction.source_page'),
        contradicted_by: safeString(item.contradicted_by ?? '', 'contradiction.contradicted_by'),
        resolution: safeString(item.resolution ?? '', 'contradiction.resolution'),
      }));
    }
  }
  return {
    entities,
    concepts,
    sourceTitle: typeof value.source_title === 'string' && value.source_title.trim() ? value.source_title.trim() : null,
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : null,
    contradictions,
    relatedPages: uniqueStrings(coerceToArray<unknown>(value.related_pages)
      .map(normalizeRelatedPageLabel)
      .filter((item): item is string => item !== null)),
    keyPoints: uniqueStrings(coerceToArray<unknown>(value.key_points)
      .filter((item): item is string => typeof item === 'string')),
    empty: entities.length === 0 && concepts.length === 0,
    validity: value.entities === undefined && value.concepts === undefined
      ? 'unusable'
      : entities.length === 0 && concepts.length === 0
        ? 'empty'
        : 'valid',
  };
}

function claimFor(
  sourceId: string,
  sourcePath: string,
  subject: NativeClaimProposal['subject'],
  predicate: NativeClaimProposal['predicate'],
  statement: string,
  disposition: NativeClaimProposal['disposition'],
  evidenceQuotes: readonly string[],
): NativeClaimProposal {
  const claimId = hashDomain(`${ARTIFACT_DOMAIN}claim\0`, {
    sourceId,
    sourcePath,
    subject,
    predicate,
    statement,
    disposition,
    evidenceQuotes: [...evidenceQuotes],
  });
  return freeze({ claimId, subject, predicate, statement, disposition, evidenceQuotes: freeze([...evidenceQuotes]), sourcePath });
}

function artifact(
  sourceId: string,
  sourceByteSha256: string,
  kind: NativeMapArtifactKind,
  pageType: NativeMapArtifact['pageType'],
  label: string,
  data: Record<string, unknown>,
): NativeMapArtifact {
  const normalizedLabel = normalizeLabel(label);
  const body = { contractVersion: NATIVE_MAP_CONTRACT_VERSION, sourceId, sourceByteSha256, kind, pageType, label, normalizedLabel, data };
  const artifactId = hashDomain(ARTIFACT_DOMAIN, body);
  return freeze({ artifactId, sourceId, sourceByteSha256, kind, pageType, label, normalizedLabel, data: freeze(data) });
}

function aliasProposals(
  sourcePath: string,
  sourceTitle: string,
  sourceAliases: readonly string[],
  entities: readonly NativeEntityProposal[],
  concepts: readonly NativeConceptProposal[],
): NativeAliasProposal[] {
  const result: NativeAliasProposal[] = [];
  for (const alias of sourceAliases) result.push(freeze({ alias, targetPageType: 'source', targetLabel: sourceTitle, sourcePath }));
  for (const item of entities) for (const alias of item.aliases) result.push(freeze({ alias, targetPageType: 'entity', targetLabel: item.name, sourcePath }));
  for (const item of concepts) for (const alias of item.aliases) result.push(freeze({ alias, targetPageType: 'concept', targetLabel: item.name, sourcePath }));
  const seen = new Set<string>();
  return result.filter(item => {
    const key = `${item.targetPageType}\0${normalizeLabel(item.targetLabel)}\0${normalizeLabel(item.alias)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relatedProposals(
  sourcePath: string,
  sourceTitle: string,
  entities: readonly NativeEntityProposal[],
  concepts: readonly NativeConceptProposal[],
  relatedPages: readonly string[],
): NativeRelatedProposal[] {
  const result: NativeRelatedProposal[] = [];
  for (const item of entities) {
    for (const label of item.related_entities) result.push(freeze({ sourcePath, pageType: 'entity', label, resolution: 'unresolved-source-proposal' }));
    for (const label of item.related_concepts) result.push(freeze({ sourcePath, pageType: 'concept', label, resolution: 'unresolved-source-proposal' }));
  }
  for (const item of concepts) {
    for (const label of item.related_entities) result.push(freeze({ sourcePath, pageType: 'entity', label, resolution: 'unresolved-source-proposal' }));
    for (const label of item.related_concepts) result.push(freeze({ sourcePath, pageType: 'concept', label, resolution: 'unresolved-source-proposal' }));
  }
  for (const label of relatedPages) result.push(freeze({ sourcePath, pageType: 'unknown', label, resolution: 'unresolved-source-proposal' }));
  void sourceTitle;
  const seen = new Set<string>();
  return result.filter(item => {
    const key = `${item.pageType}\0${normalizeLabel(item.label)}`;
    if (!item.label.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectMentions(items: readonly (NativeEntityProposal | NativeConceptProposal)[]): NativeMention[] {
  const result: NativeMention[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const mention of item.mentions_with_provenance) {
      const key = `${mention.quote}\0${mention.source_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(mention);
    }
  }
  return result;
}

function buildArtifacts(
  sourceId: string,
  sourceByteSha256: string,
  sourcePath: string,
  sourceTitle: string,
  summary: string,
  sourceAliases: readonly string[],
  keyPoints: readonly string[],
  entities: readonly NativeEntityProposal[],
  concepts: readonly NativeConceptProposal[],
  claims: readonly NativeClaimProposal[],
  aliases: readonly NativeAliasProposal[],
  related: readonly NativeRelatedProposal[],
): NativeMapArtifact[] {
  const result: NativeMapArtifact[] = [];
  const sourceClaim = claims.find(claim => claim.predicate === 'source-summary');
  result.push(artifact(sourceId, sourceByteSha256, 'summary', 'source', sourceTitle, {
    kind: 'summary', source_path: sourcePath, source_title: sourceTitle, summary,
    source_aliases: [...sourceAliases], key_points: [...keyPoints],
    claims: sourceClaim ? [sourceClaim] : [],
  }));
  for (const item of entities) {
    const itemClaims = claims.filter(claim => claim.subject.pageType === 'entity' && normalizeLabel(claim.subject.label) === normalizeLabel(item.name));
    result.push(artifact(sourceId, sourceByteSha256, 'entity', 'entity', item.name, {
      kind: 'entity', source_path: sourcePath, proposal: item, claims: itemClaims,
    }));
  }
  for (const item of concepts) {
    const itemClaims = claims.filter(claim => claim.subject.pageType === 'concept' && normalizeLabel(claim.subject.label) === normalizeLabel(item.name));
    result.push(artifact(sourceId, sourceByteSha256, 'concept', 'concept', item.name, {
      kind: 'concept', source_path: sourcePath, proposal: item, claims: itemClaims,
    }));
  }
  for (const claim of claims) result.push(artifact(sourceId, sourceByteSha256, 'claim', 'claim', `${claim.subject.pageType}:${claim.subject.label}`, { kind: 'claim', claim }));
  for (const proposal of aliases) result.push(artifact(sourceId, sourceByteSha256, 'alias', 'alias', `${proposal.targetPageType}:${proposal.targetLabel}:${proposal.alias}`, { kind: 'alias', proposal }));
  for (const proposal of related) result.push(artifact(sourceId, sourceByteSha256, 'related', 'related', `${proposal.pageType}:${proposal.label}`, { kind: 'related', proposal }));
  return result;
}

/**
 * Analyze one immutable source revision.  Every mutable collection is local
 * to this invocation; concurrent calls cannot share extraction context.
 */
export async function mapNativeSource(input: NativeMapInput): Promise<NativeMapIR> {
  const policy = freezePolicy(input.policy);
  const checked = assertSource(input.source);
  const source = checked.source;
  const content = checked.content;
  const sourceMeta = readFrontmatter(content);
  const sourceLanguage = sourceMeta.language;
  const slug = sourceSlug(checked.path);
  // Copy the catalog at the boundary.  The worker never retains a host
  // object or reads a live vault while extracting this source.
  const existingPages = copyExistingPages(input.existingPages);
  const limits = calculateBatchLimits(content.length, policy.settings.extractionGranularity, {
    entityCap: policy.settings.customEntityLimit,
    conceptCap: policy.settings.customConceptLimit,
  });
  const configuredMaxBatches = input.maxBatches ?? limits.maxBatches;
  if (!Number.isSafeInteger(configuredMaxBatches) || configuredMaxBatches < 1 || configuredMaxBatches > limits.maxBatches) {
    throw new NativeMapProtocolError('invalid-policy', `maxBatches must be an integer in [1, ${limits.maxBatches}]`);
  }
  const customCaps = getCustomTypeCaps({
    extractionGranularity: policy.settings.extractionGranularity,
    customEntityLimit: policy.settings.customEntityLimit,
    customConceptLimit: policy.settings.customConceptLimit,
  });
  // Keep the batch markers intact while filling only the two source-bound
  // placeholders.  Calling renderTemplate here would correctly warn about
  // the intentionally deferred `batch_context`, `batch_size`, and
  // `granularity_instruction` markers on every source.
  const templateUntouched = PROMPTS.analyzeSource
    .replaceAll('{{content}}', content)
    .replaceAll('{{source_path}}', checked.path);
  const marker = '{{batch_context}}';
  const markerIndex = templateUntouched.indexOf(marker);
  if (markerIndex < 0) throw new NativeMapProtocolError('unsupported-output', 'Native analyze-source prompt no longer exposes batch_context');
  const staticPrefix = templateUntouched.slice(0, markerIndex);
  const suffixTemplate = templateUntouched.slice(markerIndex + marker.length);
  const sourceRef = { path: checked.path, content, slug, extractedAt: source.extractedAt ?? NATIVE_MAP_DEFAULT_EXTRACTED_AT };
  let currentBatchSize = limits.initialBatchSize;
  let retriedAtSize = false;
  let batchSizeHalved = false;
  let placeholderRetried = false;
  let firstBatchAccepted = false;
  let firstTitle: string | null = null;
  let firstSummary: string | null = null;
  let entities: NativeEntityProposal[] = [];
  let concepts: NativeConceptProposal[] = [];
  let contradictions: NativeContradictionProposal[] = [];
  let relatedPages: string[] = [];
  let keyPoints: string[] = [];
  const baseMaxTokens = Math.max(MAX_TOKENS_BATCH, limits.initialBatchSize * TOKENS_PER_ITEM_BUDGET);
  const retryCap = baseMaxTokens * SOURCE_ANALYZER_RETRY_MULTIPLIER;
  for (let batch = 0; batch < configuredMaxBatches; batch += 1) {
    const first = batch === 0;
    const prompt = renderTemplate(
      staticPrefix + batchContext(batch, entities, concepts) + suffixTemplate + languageHints(policy, sourceLanguage),
      {
          granularity_instruction: nativeGranularityInstruction({
          extractionGranularity: policy.settings.extractionGranularity,
          customEntityLimit: policy.settings.customEntityLimit,
          customConceptLimit: policy.settings.customConceptLimit,
        }),
        batch_size: String(currentBatchSize),
      },
    );
    const maxTokens = Math.max(MAX_TOKENS_BATCH, currentBatchSize * TOKENS_PER_ITEM_BUDGET);
    const response = await callProvider(input.client, asProviderParams(policy, prompt, maxTokens));
    const canHalve = !retriedAtSize && currentBatchSize > limits.minBatchSize;
    // Keep parity with SourceAnalyzer: a length-truncated response is first
    // given a bounded halve-and-retry opportunity. Once that opportunity is
    // spent (or for a normal malformed response), JSON repair is the final
    // salvage path and may only rewrite syntax, never source values.
    const repairFn = response.finishReason === 'length' && canHalve
      ? undefined
      : async (malformedJson: string): Promise<string> => {
        const repairPrompt = `Fix the following malformed JSON. Only fix JSON syntax errors (unescaped quotes, trailing commas, missing brackets). Do NOT change any values or content. Output ONLY the fixed JSON, no other text.\n\n${malformedJson}`;
        const repaired = await callProvider(
          input.client,
          asProviderParams(policy, repairPrompt, retryCap, 'extract-retry', false, retryCap),
        );
        return repaired.text;
      };
    const parsed = await parseJsonResult(response.text, repairFn, { expectedSchemaFields: ['entities', 'concepts'] });
    const parseReason = parsed.ok ? undefined : ('reason' in parsed ? parsed.reason : 'unknown');
    if (!parsed.ok) {
      if (response.finishReason === 'length' && canHalve) {
        currentBatchSize = Math.max(limits.minBatchSize, Math.floor(currentBatchSize * 0.5));
        retriedAtSize = true;
        batch -= 1;
        continue;
      }
      if (first && !placeholderRetried && parseReason === 'thinking-block-only') {
        placeholderRetried = true;
        batch -= 1;
        continue;
      }
      if (first) {
        throw new NativeMapProtocolError('invalid-response', `Native extraction batch ${batch + 1} could not be parsed (${parseReason})`);
      }
      break;
    }
    const normalized = normalizeBatch(parsed.value, policy, sourceRef);
    if (first) {
      if (normalized.validity === 'unusable') {
        throw new NativeMapProtocolError('invalid-response', 'Native extraction first batch contained neither entities nor concepts');
      }
      firstBatchAccepted = true;
      firstTitle = normalized.sourceTitle;
      firstSummary = normalized.summary;
      contradictions = normalized.contradictions;
      relatedPages = normalized.relatedPages;
      keyPoints = normalized.keyPoints;
    }
    const priorCount = entities.length + concepts.length;
    entities = mergeItems([...entities, ...normalized.entities]) as NativeEntityProposal[];
    concepts = mergeItems([...concepts, ...normalized.concepts]) as NativeConceptProposal[];
    retriedAtSize = false;
    if (customCaps.entityCap !== null) entities = entities.slice(0, customCaps.entityCap);
    if (customCaps.conceptCap !== null) concepts = concepts.slice(0, customCaps.conceptCap);
    const rawTotal = normalized.entities.length + normalized.concepts.length;
    const newTotal = entities.length + concepts.length - priorCount;
    if (first) {
      if (normalized.validity === 'empty') break;
      continue;
    }

    const emptyCheck = checkEmptyBatch(rawTotal, newTotal);
    if (emptyCheck.shouldStop) break;

    currentBatchSize = adjustBatchSizeForResponse(currentBatchSize, response.text.length, limits.responseFullnessThreshold);
    const convergence = detectConvergence(rawTotal, currentBatchSize, batchSizeHalved, limits.minBatchSize);
    if (convergence.shouldStop) break;
    if (convergence.newBatchSizeHalved) {
      batchSizeHalved = true;
      currentBatchSize = convergence.newBatchSize;
    }
    const cumulativeCheck = checkCumulativeLimits(entities.length, concepts.length, {
      customEntityCap: customCaps.entityCap,
      customConceptCap: customCaps.conceptCap,
      maxTotalItems: limits.maxTotalItems,
    });
    if (cumulativeCheck.shouldStop) break;
  }
  if (!firstBatchAccepted) throw new NativeMapProtocolError('invalid-response', `Native extraction did not produce a first batch for ${checked.path}`);
  const sourceTitle = firstTitle || basenameWithoutExtension(checked.path);
  const summary = firstSummary ?? '';

  // SourceAnalyzer deliberately performs related-page matching after all
  // extraction rounds and outside the model prompt.  The optional catalog is
  // an immutable host projection, so this remains source-isolated while
  // avoiding fabricated/unresolvable LLM page labels.  Keep the legacy
  // unresolved proposals only when no catalog was supplied at all.
  if (existingPages !== undefined) {
    const allExtractedNames = [
      ...entities.map(item => item.name),
      ...concepts.map(item => item.name),
    ];
    relatedPages = matchExtractedToExisting(allExtractedNames, existingPages);
  }

  // Patch 16 parity: extraction asks what a source mentions, not what the
  // source itself is about.  Decide the missing source lemma deterministically
  // and spend one bounded classification call only when the summary is usable.
  // As in SourceAnalyzer, the candidate is named after the filename rather
  // than trusting a model-supplied source_title, and no mention is invented.
  const lemmaName = basenameWithoutExtension(checked.path);
  const lemmaDecision = decideSourceLemma({
    sourceTitle: lemmaName,
    sourceAliases: sourceMeta.aliases,
    entities: entities.map(item => ({ name: item.name, aliases: [...item.aliases] })),
    concepts: concepts.map(item => ({ name: item.name, aliases: [...item.aliases] })),
  });
  if (lemmaDecision.action === 'add' && summary.trim().length > 0) {
    const target = await classifySourceLemma(policy, input.client, lemmaDecision.name, summary);
    const capHit = target === 'entity'
      ? customCaps.entityCap !== null && entities.length >= customCaps.entityCap
      : target === 'concept'
        ? customCaps.conceptCap !== null && concepts.length >= customCaps.conceptCap
        : false;
    if (target !== null && !capHit) {
      const candidate = freeze({
        name: lemmaDecision.name,
        type: firstActiveTag(policy, target),
        aliases: freeze([] as string[]),
        summary,
        mentions_in_source: freeze([] as string[]),
        mentions_with_provenance: freeze([] as NativeMention[]),
        related_entities: freeze([] as string[]),
        related_concepts: freeze([] as string[]),
      });
      if (target === 'entity') entities = [...entities, candidate as NativeEntityProposal];
      else concepts = [...concepts, candidate as NativeConceptProposal];
    }
  }

  const allItems = [...entities, ...concepts];
  const mentions = collectMentions(allItems);
  const claims: NativeClaimProposal[] = [claimFor(
    source.sourceId,
    checked.path,
    { pageType: 'source', label: sourceTitle },
    'source-summary',
    summary,
    'proposed',
    [],
  )];
  for (const item of entities) claims.push(claimFor(source.sourceId, checked.path, { pageType: 'entity', label: item.name }, 'item-summary', item.summary, 'proposed', item.mentions_in_source));
  for (const item of concepts) claims.push(claimFor(source.sourceId, checked.path, { pageType: 'concept', label: item.name }, 'item-summary', item.summary, 'proposed', item.mentions_in_source));
  for (const contradiction of contradictions) claims.push(claimFor(source.sourceId, checked.path, { pageType: 'source', label: sourceTitle }, 'contradiction', contradiction.claim, 'contested', []));
  const aliases = aliasProposals(checked.path, sourceTitle, sourceMeta.aliases, entities, concepts);
  const related = relatedProposals(checked.path, sourceTitle, entities, concepts, relatedPages);
  const artifacts = buildArtifacts(
    source.sourceId, checked.byteSha256, checked.path, sourceTitle, summary,
    sourceMeta.aliases, keyPoints, entities, concepts, claims, aliases, related,
  );
  const body = {
    contractVersion: NATIVE_MAP_CONTRACT_VERSION,
    source: { sourceId: source.sourceId, sourcePath: checked.path, byteSha256: checked.byteSha256, byteCount: source.sourceBytes.byteLength },
    sourceTitle, summary, sourceAliases: sourceMeta.aliases, keyPoints,
    entities, concepts, mentions, claims, aliases, related, contradictions, artifacts,
    policySha256: policy.policySha256,
  };
  const irSha256 = canonicalJsonSha256(body);
  return freeze({ ...body, irSha256 });
}

/** Structural alias for callers that use the map/analyze vocabulary. */
export const analyzeNativeSource = mapNativeSource;
