import { canonicalJsonSha256 } from '../preflight/hashing';
import type { NativeMapIR, NativeMention } from '../native-map/types';
import { nativeSourceSlug } from './slug';
import type { NativeSourceSlugOptions } from './types';

function stampedMention(mention: NativeMention, sourceSlug: string): NativeMention {
  return { ...mention, source_slug: sourceSlug };
}

/**
 * Repair the source-slug field emitted by the legacy source-isolated mapper
 * without changing any extracted semantic value.  Because NativeMapIR is
 * content-addressed, this returns a new IR with a recomputed `irSha256`; it
 * never mutates an artifact in place.
 */
export function normalizeNativeMapSourceSlugs(
  source: NativeMapIR,
  options: NativeSourceSlugOptions = {},
): NativeMapIR {
  const sourceSlug = nativeSourceSlug(source.source.sourcePath, options);
  const entities = source.entities.map(entity => ({
    ...entity,
    mentions_with_provenance: entity.mentions_with_provenance.map(mention => stampedMention(mention, sourceSlug)),
  }));
  const concepts = source.concepts.map(concept => ({
    ...concept,
    mentions_with_provenance: concept.mentions_with_provenance.map(mention => stampedMention(mention, sourceSlug)),
  }));
  const body = {
    contractVersion: source.contractVersion,
    source: source.source,
    sourceTitle: source.sourceTitle,
    summary: source.summary,
    sourceAliases: source.sourceAliases,
    keyPoints: source.keyPoints,
    entities,
    concepts,
    mentions: source.mentions.map(mention => stampedMention(mention, sourceSlug)),
    claims: source.claims,
    aliases: source.aliases,
    related: source.related,
    contradictions: source.contradictions,
    artifacts: source.artifacts,
    policySha256: source.policySha256,
  };
  return Object.freeze({ ...body, irSha256: canonicalJsonSha256(body) });
}

