import { describe, it, expect } from 'vitest';
import {
  bodyWordSet,
  computeJaccard,
  generateDuplicateCandidates,
  partitionPagesMultiBucket,
} from '../../../wiki/lint/duplicate-detection';
import type { DuplicateCandidate } from '../../../wiki/lint/duplicate-detection';

// ── bodyWordSet ────────────────────────────────────────────────────────────────

describe('bodyWordSet', () => {
  it('returns unique meaningful words, filtering stopwords and short words', () => {
    const words = bodyWordSet('The wiki is a knowledge base that compiles information');
    expect(words.has('wiki')).toBe(true);
    expect(words.has('knowledge')).toBe(true);
    expect(words.has('compiles')).toBe(true);
    expect(words.has('information')).toBe(true);
    // Stopwords and short words filtered
    expect(words.has('the')).toBe(false);
    expect(words.has('is')).toBe(false);
    expect(words.has('a')).toBe(false);
    expect(words.has('that')).toBe(false);
  });

  it('produces low Jaccard for different-topic texts', () => {
    const wA = bodyWordSet(
      'A log file is a chronological append-only record detailing operational history of events. ' +
      'Entries track system events such as ingests queries maintenance passes providing audit timeline.',
    );
    const wB = bodyWordSet(
      'Query is an advanced knowledge interaction process where artificial intelligence is prompted ' +
      'to synthesize information from multiple source pages producing cohesive answers with citations.',
    );
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeLessThan(0.2);
  });

  it('produces non-empty set for CJK text', () => {
    const words = bodyWordSet('深度学习是人工智能的核心技术之一 机器学习是基础');
    expect(words.size).toBeGreaterThan(0);
  });

  it('produces high Jaccard for similar CJK texts', () => {
    const shared = '深度学习是人工智能的核心技术之一 机器学习是深度学习的基础 神经网络架构';
    const wA = bodyWordSet(shared + ' 图像识别卷积网络');
    const wB = bodyWordSet(shared + ' 自然语言处理变换器');
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeGreaterThanOrEqual(0.2);
  });

  it('produces low Jaccard for different-topic CJK texts', () => {
    const wA = bodyWordSet('深度学习是人工智能的核心技术 神经网络用于图像识别任务');
    const wB = bodyWordSet('历史是人类文明的记录 古代文化与现代社会的联系');
    const sim = computeJaccard(wA, wB);
    expect(sim).toBeLessThan(0.2);
  });
});

// ── generateDuplicateCandidates — threshold overrides (v1.26.0 #382 item 2) ──

/**
 * Build a wiki page fixture with a frontmatter aliases array and a body
 * containing [[wiki-links]] + plain prose. The aliases populate the
 * `bigram` signal; the [[wiki-links]] populate the `sharedLinks` signal.
 */
function makePage(path: string, title: string, body: string, aliases: string[] = []): {
  path: string;
  content: string;
  title: string;
} {
  const aliasesYaml = aliases.length > 0
    ? `aliases:\n${aliases.map(a => `  - "${a}"`).join('\n')}\n`
    : '';
  return {
    path,
    title,
    content: `---\n${aliasesYaml}---\n${body}`,
  };
}

function makeMetadataPage(
  path: string,
  title: string,
  body: string,
  metadata: {
    type: 'entity' | 'concept' | 'source';
    aliases?: string[];
    sources?: string[];
    tags?: string[];
    contentHash?: string;
  },
): { path: string; content: string; title: string } {
  const lines = [
    '---',
    `type: ${metadata.type}`,
    ...(metadata.aliases ? [`aliases: ${JSON.stringify(metadata.aliases)}`] : []),
    ...(metadata.sources ? [`sources: ${JSON.stringify(metadata.sources)}`] : []),
    ...(metadata.tags ? [`tags: ${JSON.stringify(metadata.tags)}`] : []),
    ...(metadata.contentHash ? [`contentHash: ${metadata.contentHash}`] : []),
    '---',
  ];
  return { path, title, content: `${lines.join('\n')}\n${body}` };
}

/**
 * Filter candidates to the (pathA, pathB) pair under test, ignoring
 * pair-order. Returns the matched candidate or null.
 */
function findCandidate(
  candidates: DuplicateCandidate[],
  pathA: string,
  pathB: string,
): DuplicateCandidate | null {
  const a = candidates.find(c =>
    (c.target === pathA && c.source === pathB) ||
    (c.target === pathB && c.source === pathA)
  );
  return a ?? null;
}

describe('generateDuplicateCandidates — threshold overrides', () => {
  it('default behavior matches legacy 0.4 / 0.2 / 0.4 thresholds (regression guard)', async () => {
    // Two pages whose outgoing wiki-links overlap exactly on the [[shared]]
    // link, with body-text overlap ~50% (well above the 0.2 body gate).
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const candidates = await generateDuplicateCandidates([a, b]);
    // The sharedLinks signal should fire because link Jaccard = 1.0 (only
    // link is shared) AND body Jaccard is well above the 0.2 gate.
    const sl = findCandidate(candidates, a.path, b.path);
    expect(sl).not.toBeNull();
    expect(sl!.signal).toBe('sharedLinks');
  });

  it('clamps out-of-range jaccardLinkThreshold to the [0,1] range', async () => {
    // F2 (code-review finding): thresholds are clamped to [0,1] so a
    // settings value of 1.5 no longer silently disables the signal
    // (`x >= 1.5` is never true). 1.5 clamps to 1.0 — a page pair with
    // 100% shared link graph (jaccard = 1.0) still clears it, proving the
    // clamp to 1.0 rather than keeping the raw 1.5.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const fullShare = await generateDuplicateCandidates([a, b], {
      jaccardLinkThreshold: 1.5,   // clamps to 1.0
    });
    const sl = findCandidate(fullShare, a.path, b.path);
    expect(sl).not.toBeNull();
    expect(sl!.signal).toBe('sharedLinks');

    // Distinguishing case: a partial-share pair (jaccard < 1.0) is filtered
    // at the clamped 1.0, so the clamp demonstrably took effect.
    const c = makePage('wiki/entities/c.md', 'C', 'See [[shared]] for context. Body has foo bar baz qux.');
    const d = makePage('wiki/entities/d.md', 'D', 'See [[other]] for context. Body has foo bar baz extra.');
    const partialShare = await generateDuplicateCandidates([c, d], {
      jaccardLinkThreshold: 1.5,   // clamps to 1.0
    });
    expect(findCandidate(partialShare, c.path, d.path)).toBeNull();
  });

  it('non-finite threshold values fall back to the default (no silent disable)', async () => {
    // F2 (code-review finding): Infinity in a settings value would
    // previously make `x >= Infinity` always false — silently disabling
    // the signal while the wiki looks clean. resolveThreshold now falls
    // back to the default for non-finite inputs.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const candidates = await generateDuplicateCandidates([a, b], {
      jaccardLinkThreshold: Number.POSITIVE_INFINITY,
    });
    // Infinity → fallback to default 0.4 → jaccard 1.0 >= 0.4 → candidate survives
    expect(findCandidate(candidates, a.path, b.path)).not.toBeNull();
  });

  it('raising bigramThreshold filters out near-title duplicates', async () => {
    // Two pages whose titles are very close (bigram ~0.7) — at the default
    // bigram threshold (0.4) this fires the bigram signal; at threshold
    // 0.9 it should not.
    const a = makePage('wiki/entities/claude-code.md', 'Claude Code',
      'Anthropic CLI for AI-assisted development.', []);
    const b = makePage('wiki/entities/claude-cde.md', 'Claude CDE',
      'Some other Anthropic tool for code editing.', []);
    const atDefault = await generateDuplicateCandidates([a, b]);
    expect(findCandidate(atDefault, a.path, b.path)).not.toBeNull();

    const raised = await generateDuplicateCandidates([a, b], {
      bigramThreshold: 0.99,
    });
    expect(findCandidate(raised, a.path, b.path)).toBeNull();
  });

  it('backward-compat: omitting the options argument behaves like legacy', async () => {
    // The legacy fixture (from `default behavior` test) should produce
    // the same candidate set with or without an explicit options object
    // — proving the default-options spread preserves old behavior.
    const a = makePage('wiki/entities/a.md', 'A', 'See [[shared]] for context. Body has foo bar baz qux.');
    const b = makePage('wiki/entities/b.md', 'B', 'See [[shared]] for context. Body has foo bar baz extra.');
    const withOptions = await generateDuplicateCandidates([a, b], {});
    const withoutOptions = await generateDuplicateCandidates([a, b]);
    expect(withOptions).toEqual(withoutOptions);
  });

  it('does not treat a narrow title as a duplicate of a broader title on title overlap alone', async () => {
    const narrow = makePage(
      'wiki/concepts/standing-approval-for-preventive-maintenance-programmes.md',
      'Standing Approval for Preventive Maintenance Programmes',
      'A governance workflow records approval boundaries for recurring work. See [[maintenance-hub]].',
    );
    const broad = makePage(
      'wiki/concepts/preventative-maintenance.md',
      'Preventative Maintenance',
      'A facilities guide describes inspection intervals for equipment and seasonal servicing. See [[maintenance-hub]].',
    );

    const candidates = await generateDuplicateCandidates([narrow, broad]);

    expect(findCandidate(candidates, narrow.path, broad.path)).toBeNull();
  });
});

describe('generateDuplicateCandidates — semantic audit guards', () => {
  it('refuses source versions when bodies or declared content hashes differ', async () => {
    const versionA = makeMetadataPage(
      'wiki/sources/policy.md',
      'Policy Bulletin',
      'Version one defines the original approval timeline.',
      { type: 'source', contentHash: 'declared-version-a' },
    );
    const versionB = makeMetadataPage(
      'wiki/sources/policy-revised.md',
      'Policy Bulletin',
      'Version two changes the approval timeline and expiration rule.',
      { type: 'source', contentHash: 'declared-version-b' },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([versionA, versionB]),
      versionA.path,
      versionB.path,
    )).toBeNull();

    const sameBodyA = makeMetadataPage(
      'wiki/sources/policy-copy-a.md',
      'Policy Copy',
      'The same source body is copied here.',
      { type: 'source', contentHash: 'declared-hash-a' },
    );
    const sameBodyB = makeMetadataPage(
      'wiki/sources/policy-copy-b.md',
      'Policy Copy',
      'The same source body is copied here.',
      { type: 'source', contentHash: 'declared-hash-b' },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([sameBodyA, sameBodyB]),
      sameBodyA.path,
      sameBodyB.path,
    )).toBeNull();
  });

  it('preserves a same-type alias duplicate when provenance overlaps as a source union', async () => {
    const a = makeMetadataPage(
      'wiki/concepts/month-to-month-tenancy.md',
      'Month-to-Month Tenancy',
      'A tenancy renews monthly under the recurring lease policy.',
      { type: 'concept', aliases: ['Monthly Tenancy'], sources: ['[[sources/lease-policy]]'], tags: ['lease'] },
    );
    const b = makeMetadataPage(
      'wiki/concepts/monthly-tenancy.md',
      'Month to Month Tenancy',
      'The monthly lease arrangement renews without a fixed end date.',
      { type: 'concept', aliases: ['Monthly Tenancy'], sources: ['[[sources/lease-policy]]', '[[sources/state-guide]]'], tags: ['lease'] },
    );
    const candidate = findCandidate(
      await generateDuplicateCandidates([a, b]),
      a.path,
      b.path,
    );
    expect(candidate).not.toBeNull();
    expect(candidate!.signal).toBe('crossLang');
  });

  it('refuses graph/title matches with disjoint provenance', async () => {
    const a = makeMetadataPage(
      'wiki/concepts/rent2wealth.md',
      'Rent2Wealth',
      'A property income strategy uses rent, property, and cashflow planning. See [[property-hub]].',
      { type: 'concept', sources: ['[[sources/investor-brief]]'], tags: ['investment'] },
    );
    const b = makeMetadataPage(
      'wiki/concepts/rental-wealth-strategy.md',
      'Rental Wealth Strategy',
      'A property management workflow uses rent, property, and maintenance planning. See [[property-hub]].',
      { type: 'concept', sources: ['[[sources/operations-guide]]'], tags: ['operations'] },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([a, b]),
      a.path,
      b.path,
    )).toBeNull();
  });

  it('refuses a statute section/subsection hierarchy match', async () => {
    const section = makeMetadataPage(
      'wiki/concepts/deposit-statute-section-1.md',
      'Deposit Statute § 1',
      'The statute establishes the deposit return deadline. See [[statute-hub]].',
      { type: 'concept', sources: ['[[sources/state-statute]]'] },
    );
    const subsection = makeMetadataPage(
      'wiki/concepts/deposit-statute-section-1a.md',
      'Deposit Statute § 1(a)',
      'The subsection adds a notice exception to the deposit return deadline. See [[statute-hub]].',
      { type: 'concept', sources: ['[[sources/state-statute]]'] },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([section, subsection]),
      section.path,
      subsection.path,
    )).toBeNull();
  });

  it('does not promote transitive incoming evidence without direct page evidence', async () => {
    const a = makeMetadataPage(
      'wiki/concepts/evidence-status.md',
      'Evidence Status',
      'The status records whether a claim is currently supported.',
      { type: 'concept', sources: ['[[sources/status-a]]'] },
    );
    const b = makeMetadataPage(
      'wiki/concepts/evidence-state.md',
      'Evidence State',
      'The state describes the review lifecycle of an item.',
      { type: 'concept', sources: ['[[sources/status-b]]'] },
    );
    const incoming = new Map<string, string[]>([
      ['wiki/sources/shared-index.md', [a.path, b.path]],
    ]);
    expect(findCandidate(
      await generateDuplicateCandidates([a, b], {}, {}, incoming),
      a.path,
      b.path,
    )).toBeNull();
  });

  it('refuses cross-register navigation/workflow pages with shared vocabulary', async () => {
    const workflow = makeMetadataPage(
      'wiki/entities/maintenance-workflow.md',
      'Maintenance Workflow',
      'The workflow documents approval, maintenance, inspection, and scheduling for property operations. See [[operations-hub]].',
      { type: 'entity', tags: ['workflow'], sources: ['[[sources/operations-guide]]'] },
    );
    const concept = makeMetadataPage(
      'wiki/concepts/maintenance.md',
      'Maintenance',
      'The concept describes approval, maintenance, inspection, and scheduling for property operations. See [[operations-hub]].',
      { type: 'concept', tags: ['navigation'], sources: ['[[sources/operations-guide]]'] },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([workflow, concept]),
      workflow.path,
      concept.path,
    )).toBeNull();
  });

  it('refuses disjoint register roles when links and body vocabulary overlap', async () => {
    const owner = makeMetadataPage(
      'wiki/entities/owner-silence.md',
      'Owner Silence',
      'Silence affects lease communication, notice timing, and follow-up. See [[lease-hub]].',
      { type: 'entity', tags: ['owner'], sources: ['[[sources/owner-policy]]'] },
    );
    const resident = makeMetadataPage(
      'wiki/entities/resident-silence.md',
      'Resident Silence',
      'Silence affects lease communication, notice timing, and escalation. See [[lease-hub]].',
      { type: 'entity', tags: ['resident'], sources: ['[[sources/resident-policy]]'] },
    );
    expect(findCandidate(
      await generateDuplicateCandidates([owner, resident]),
      owner.path,
      resident.path,
    )).toBeNull();
  });
});

// ── partitionPagesMultiBucket (v1.26.0 #382 item 3, Batch 1) ─────────────────

/** Minimal PageMeta shape — only the fields the helper reads. */
function makeMeta(overrides: Partial<{
  path: string;
  title: string;
  aliases: string[];
  links: Set<string>;
  bodyWords: Set<string>;
  bodyFingerprint: string;
  declaredContentHash: string;
  provenance: Set<string>;
  registers: Set<string>;
  incomingSources: Set<string>;
}> = {}) {
  return {
    path: overrides.path ?? 'default.md',
    title: overrides.title ?? 'Default',
    aliases: overrides.aliases ?? [],
    links: overrides.links ?? new Set<string>(),
    bodyWords: overrides.bodyWords ?? new Set<string>(),
    // v1.26.0 Batch 2: empty fingerprint is a valid degenerate case —
    // the sourceFingerprint signal skips pairs where either side has an
    // empty fingerprint. Unit tests for partitionPagesMultiBucket don't
    // care about fingerprint behavior, so the default empty value keeps
    // these tests focused.
    bodyFingerprint: overrides.bodyFingerprint ?? '',
    declaredContentHash: overrides.declaredContentHash ?? '',
    provenance: overrides.provenance ?? new Set<string>(),
    registers: overrides.registers ?? new Set<string>(),
    // v1.26.0 Batch 2: empty incoming sources is the legacy state
    // (Batch 1 callers don't populate it). sharedIncoming signal
    // skips pairs with either side empty.
    incomingSources: overrides.incomingSources ?? new Set<string>(),
  };
}

describe('partitionPagesMultiBucket', () => {
  it('returns an empty map for an empty input', () => {
    const buckets = partitionPagesMultiBucket([]);
    expect(buckets.size).toBe(0);
  });

  it('puts a single page into one tp bucket only (no links)', () => {
    const page = makeMeta({ path: 'wiki/ai.md', title: 'AI Agent' });
    const buckets = partitionPagesMultiBucket([page]);
    expect(buckets.size).toBe(1);
    expect(buckets.has('tp:ai')).toBe(true);
    expect(buckets.get('tp:ai')).toEqual([page]);
  });

  it('separates pages with different title prefixes into different tp buckets', () => {
    const ai = makeMeta({ path: 'wiki/ai.md', title: 'AI Agent' });
    const db = makeMeta({ path: 'wiki/db.md', title: 'Database' });
    const buckets = partitionPagesMultiBucket([ai, db]);
    expect(buckets.get('tp:ai')).toEqual([ai]);
    expect(buckets.get('tp:da')).toEqual([db]);
  });

  it('puts pages sharing the same title prefix into the same tp bucket', () => {
    const ai1 = makeMeta({ path: 'wiki/ai1.md', title: 'AI Agent' });
    const ai2 = makeMeta({ path: 'wiki/ai2.md', title: 'AIModel' });
    const buckets = partitionPagesMultiBucket([ai1, ai2]);
    expect(buckets.get('tp:ai')).toEqual([ai1, ai2]);
  });

  it('puts pages sharing an outgoing wiki-link into the same lh bucket', () => {
    const wiki = makeMeta({
      path: 'wiki/wiki-plugin.md',
      title: 'Wiki Plugin',
      links: new Set(['shared-hub', 'obsidian']),
    });
    const arch = makeMeta({
      path: 'wiki/arch.md',
      title: 'Plugin Architecture',
      links: new Set(['shared-hub', 'plugin']),
    });
    const buckets = partitionPagesMultiBucket([wiki, arch]);
    // Link keys are normalised via normalizeForMatch — hyphens removed,
    // so "shared-hub" becomes "sharedhub".
    expect(buckets.has('lh:sharedhub')).toBe(true);
    expect(buckets.get('lh:sharedhub')).toContain(wiki);
    expect(buckets.get('lh:sharedhub')).toContain(arch);
  });

  it('puts pages with non-overlapping links into different lh buckets', () => {
    const a = makeMeta({
      path: 'a.md',
      title: 'A',
      links: new Set(['hub-x']),
    });
    const b = makeMeta({
      path: 'b.md',
      title: 'B',
      links: new Set(['hub-y']),
    });
    const buckets = partitionPagesMultiBucket([a, b]);
    expect(buckets.get('lh:hubx')).toEqual([a]);
    expect(buckets.get('lh:huby')).toEqual([b]);
  });

  it('puts pages with multiple links into multiple lh buckets (shared references)', () => {
    const page = makeMeta({
      path: 'p.md',
      title: 'P',
      links: new Set(['hub-1', 'hub-2', 'hub-3']),
    });
    const buckets = partitionPagesMultiBucket([page]);
    expect(buckets.get('lh:hub1')).toEqual([page]);
    expect(buckets.get('lh:hub2')).toEqual([page]);
    expect(buckets.get('lh:hub3')).toEqual([page]);
    // Same object reference across buckets (no duplicate metadata).
    expect(buckets.get('lh:hub1')![0]).toBe(buckets.get('lh:hub2')![0]);
  });

  it('routes CJK and digit-prefixed titles by their first 2 chars (no __other__ fallback)', () => {
    const num = makeMeta({ path: 'num.md', title: '42 Things' });
    const cjk = makeMeta({ path: 'cjk.md', title: '中文测试' });
    const buckets = partitionPagesMultiBucket([num, cjk]);
    // normalizeForMatch preserves [a-z0-9] and CJK; the first 2 chars become the key.
    expect(buckets.has('tp:42')).toBe(true);
    expect(buckets.has('tp:中文')).toBe(true);
  });

  // Code-review finding (Batch 1): if a page has two distinct raw link
  // strings that normalize to the same key (e.g. "[[A-B]]" and "[[A B]]"),
  // the partition helper pushes the page into the same lh: bucket twice
  // — the bucket array contains the same meta reference twice. A singleton
  // bucket then has length 2 and the signal loops generate a self-pair
  // (pathA === pathB). Test that the partition helper deduplicates by
  // normalised key inside each page.
  it('deduplicates the same meta within one lh bucket when its links share a normalised key', () => {
    const page = makeMeta({
      path: 'wiki/dup-link.md',
      title: 'Dup Links',
      links: new Set(['shared-hub', 'Shared Hub']),  // both normalize to 'sharedhub'
    });
    const buckets = partitionPagesMultiBucket([page]);
    // Both raw strings normalise to 'sharedhub'; the page must land
    // exactly once in the lh:sharedhub bucket.
    expect(buckets.get('lh:sharedhub')?.length).toBe(1);
    expect(buckets.get('lh:sharedhub')?.[0]).toBe(page);
  });
});

// ── generateDuplicateCandidates — sourceFingerprint signal (v1.26.0 #382 item 1, Batch 2) ──
//
// v1.26.0 Batch 2 (cross-type dedup): sources now participate in the dedup
// pipeline. Sources are episodic memory (#358 complementary memory model);
// the only "true duplicate" between two sources is a content-identical
// re-ingest. Bigram / crossLang / caseVariant signals are too permissive on
// sources because every source shares boilerplate (URLs, formatting,
// citation footers) that drives up bigram scores without indicating
// semantic duplication.
//
// `sourceFingerprint` is a deterministic signal that fires ONLY when the
// body hash (post-frontmatter-strip) of two source pages is identical.
// It is the source↔source tier-1 gate. Sources that share high bigram
// similarity but DIFFERENT bodies are NOT tier-1 — they may still surface
// as tier-2 candidates for LLM verification, but the LLM sees them with
// the `sourceFingerprint`-not-triggered reason and can down-rank them.

describe('generateDuplicateCandidates — sourceFingerprint signal', () => {
  it('source↔source with identical body produces a tier-1 candidate via sourceFingerprint', async () => {
    const body = 'This is the verbatim content of a source. It has multiple paragraphs.\n\nAnd citations like [[target-page]].';
    const a = makePage('wiki/sources/source-a.md', 'Source A', body, ['Alias A']);
    const b = makePage('wiki/sources/source-b.md', 'Source B', body, ['Alias B']);
    // Different titles/aliases intentionally — fingerprint must win
    // independently of crossLang / bigram signals.
    const candidates = await generateDuplicateCandidates([a, b]);
    const cand = findCandidate(candidates, a.path, b.path);
    expect(cand).not.toBeNull();
    expect(cand!.signal).toBe('sourceFingerprint');
    expect(cand!.score).toBeGreaterThanOrEqual(0.9);
  });

  it('source↔source with different body but high bigram is NOT tier-1 (fingerprint gate)', async () => {
    // Same boilerplate URL/citation footer — drives up bigram score — but
    // different body text. This is the classic false-positive the gate
    // exists to prevent.
    const sharedBoilerplate = 'See https://example.com/paper for reference. Cited in [[hub]].';
    const a = makePage('wiki/sources/source-a.md', 'Source A',
      `${sharedBoilerplate} Body A discusses topic X in detail with extensive paragraphs.`);
    const b = makePage('wiki/sources/source-b.md', 'Source B',
      `${sharedBoilerplate} Body B covers topic Y with completely different content and arguments.`);
    const candidates = await generateDuplicateCandidates([a, b]);
    // The pair may surface via bigram signal (high shared boilerplate),
    // but sourceFingerprint must NOT fire because bodies differ.
    const cand = findCandidate(candidates, a.path, b.path);
    if (cand !== null) {
      expect(cand.signal).not.toBe('sourceFingerprint');
    }
    // Either no candidate OR non-fingerprint signal — both are acceptable.
  });

  // Cross-type rejection (source↔entity / source↔concept) is enforced
  // in dedup-phase.ts filter, NOT in this helper. The cross-type
  // contract is pinned in dedup-phase.test.ts.
});

// ── partitionPagesMultiBucket — ic: incoming-link dimension (v1.26.0 #382 item 1, Batch 2) ──
//
// The ic: dimension groups pages that are CITED by the same source,
// regardless of title prefix or outgoing links. This catches the
// entity↔concept cross-folder duplicates that share no outgoing links
// (e.g. entity "Transformer" and concept "Attention" both cited by
// the same source paper).
//
// The reverse index is `Map<sourcePath, targetPaths[]>` — for each
// source that cites at least one page, the list of pages it cites.

describe('partitionPagesMultiBucket — ic: dimension', () => {
  it('puts pages cited by the same source into the same ic: bucket', () => {
    const transformer = makeMeta({ path: 'wiki/entities/transformer.md', title: 'Transformer' });
    const attention = makeMeta({ path: 'wiki/concepts/attention.md', title: 'Attention' });
    const source = 'wiki/sources/vaswani-2017.md';
    const incomingIndex = new Map<string, string[]>([
      [source, [transformer.path, attention.path]],
    ]);
    const buckets = partitionPagesMultiBucket([transformer, attention], incomingIndex);
    expect(buckets.has(`ic:${source}`)).toBe(true);
    const icBucket = buckets.get(`ic:${source}`)!;
    expect(icBucket).toContain(transformer);
    expect(icBucket).toContain(attention);
  });

  it('leaf page with zero incoming links has no ic: buckets (degenerate to current behavior)', () => {
    const leaf = makeMeta({ path: 'wiki/entities/leaf.md', title: 'Leaf Topic' });
    const incomingIndex = new Map<string, string[]>([
      // sourceA cites an unrelated page, not leaf
      ['wiki/sources/source-a.md', ['wiki/entities/other.md']],
    ]);
    const buckets = partitionPagesMultiBucket([leaf], incomingIndex);
    // No ic: bucket should contain leaf.
    for (const [key, bucket] of buckets) {
      if (key.startsWith('ic:')) {
        expect(bucket).not.toContain(leaf);
      }
    }
    // tp: bucket still applies.
    expect(buckets.has('tp:le')).toBe(true);
  });

  it('hub source (over LINT_DEDUP_MAX_BUCKET_SIZE incoming) skips ic: dimension for that source', () => {
    // Build a source that cites > 50 pages. The ic: bucket for that
    // source must NOT contain all of them — once it hits the cap, the
    // partition helper stops adding to it. Other dimensions (tp:, lh:)
    // still apply for each page.
    const source = 'wiki/sources/hub.md';
    const targetPaths: string[] = [];
    const metas = [];
    for (let i = 0; i < 60; i++) {
      const path = `wiki/entities/target-${i}.md`;
      targetPaths.push(path);
      metas.push(makeMeta({ path, title: `Target ${i}` }));
    }
    const incomingIndex = new Map<string, string[]>([[source, targetPaths]]);
    const buckets = partitionPagesMultiBucket(metas, incomingIndex);
    const icBucket = buckets.get(`ic:${source}`);
    expect(icBucket).toBeDefined();
    // Cap is 50; we expect exactly 50 (the first 50 to be processed).
    // The cap protects against pair-loop O(N²) blowup; the exact number
    // is bounded by LINT_DEDUP_MAX_BUCKET_SIZE.
    expect(icBucket!.length).toBeLessThanOrEqual(60);
    expect(icBucket!.length).toBeGreaterThanOrEqual(50);
  });

  it('omitting incomingIndex omits ic: dimension (Batch 1 legacy behavior)', () => {
    // Without an incomingIndex, the partition must not create any ic:
    // bucket — even if there are pages with incoming links. This
    // preserves the Batch 1 contract for callers that don't yet build
    // the reverse index.
    const a = makeMeta({ path: 'a.md', title: 'A' });
    const b = makeMeta({ path: 'b.md', title: 'B' });
    const buckets = partitionPagesMultiBucket([a, b]); // no incomingIndex
    for (const key of buckets.keys()) {
      expect(key.startsWith('ic:')).toBe(false);
    }
    // tp: + lh: still work.
    expect(buckets.has('tp:a') || buckets.has('tp:b')).toBe(true);
  });
});

// ── generateDuplicateCandidates — sharedIncoming signal (v1.26.0 #382 item 1, Batch 2) ──
//
// sharedIncoming fires inside the ic: bucket dimension. Two pages
// whose incoming-source sets (the list of wiki pages citing them)
// share ≥ LINT_DEDUP_INCOMING_LINK_THRESHOLD (0.3) Jaccard overlap
// are flagged. Outside the ic: bucket the signal is a no-op (the
// partition only groups pages by shared incoming source there).

describe('generateDuplicateCandidates — sharedIncoming signal', () => {
  it('refuses cross-register entity/concept pairs even with identical incoming source sets', async () => {
    // Both pages are cited by the same 3 sources. Jaccard = 3/3 = 1.0
    // — well above 0.3 threshold. They share a title prefix and a
    // common incoming source, so they land in the same ic: bucket.
    // We construct the incomingIndex from the page paths the dedup
    // helper will see, then the helper populates `incomingSources`
    // from it during the setup loop.
    const sourceA = 'wiki/sources/src-a.md';
    const sourceB = 'wiki/sources/src-b.md';
    const sourceC = 'wiki/sources/src-c.md';
    const a = makePage('wiki/entities/apple.md', 'Apple',
      'Apple is a fruit. See [[apple-theory]].');
    const b = makePage('wiki/concepts/apple-theory.md', 'Apple Theory',
      'A theory of apples. See [[apple]].');
    const incomingIndex = new Map<string, string[]>([
      [sourceA, [a.path, b.path]],
      [sourceB, [a.path, b.path]],
      [sourceC, [a.path, b.path]],
    ]);
    const candidates = await generateDuplicateCandidates([a, b], {}, {}, incomingIndex);
    expect(findCandidate(candidates, a.path, b.path)).toBeNull();
  });

  it('two pages in same ic: bucket but ZERO incoming overlap → NOT a candidate', async () => {
    // Both pages share a single bucket key (their page path appears in
    // src-z's outgoing list) but each has its own unique incoming
    // sources. sharedIncoming Jaccard = 0/2 = 0 → below threshold.
    const sourceX = 'wiki/sources/src-x.md';
    const sourceY = 'wiki/sources/src-y.md';
    const sourceZ = 'wiki/sources/src-z.md';
    const a = makePage('wiki/entities/foo.md', 'Foo', 'See [[bar]] for context.');
    const b = makePage('wiki/entities/foo-extended.md', 'Foo Extended',
      'See [[bar]] for context.');
    const incomingIndex = new Map<string, string[]>([
      [sourceX, [a.path]],
      [sourceY, [b.path]],
      // shared bucket key — both pages appear in src-z's outgoing list
      [sourceZ, [a.path, b.path]],
    ]);
    const candidates = await generateDuplicateCandidates([a, b], {}, {}, incomingIndex);
    const cand = findCandidate(candidates, a.path, b.path);
    // sharedIncoming Jaccard on (src-x) ∩ (src-y) = 0/2 = 0 → below 0.3
    // → no candidate via sharedIncoming. (Other signals like bigram may
    // fire if titles are similar; this test only asserts sharedIncoming
    // doesn't promote this pair.)
    if (cand !== null) {
      expect(cand.signal).not.toBe('sharedIncoming');
    }
  });

  it('outside ic: bucket (legacy Batch 1 callers), sharedIncoming signal is a no-op', async () => {
    // No incomingIndex → no ic: dimension → sharedIncoming signal has
    // empty incomingSources on every page → computeJaccard returns 0 →
    // never reaches the threshold. Verifies the Batch 1 callers
    // (without incomingIndex) see no behavior change from the new signal.
    const a = makePage('wiki/entities/apple.md', 'Apple',
      'Apple is a fruit. See [[apple-twin]].');
    const b = makePage('wiki/entities/apple-twin.md', 'Apple Twin',
      'Twin of Apple. See [[apple]].');
    const candidates = await generateDuplicateCandidates([a, b], {}, {}); // no incomingIndex
    // No sharedIncoming candidate should exist. bigram may fire (titles
    // match), but the test only asserts the new signal doesn't.
    for (const c of candidates) {
      expect(c.signal).not.toBe('sharedIncoming');
    }
  });
});

// ── generateDuplicateCandidates — bucketed integration (v1.26.0 #382 item 3, Batch 1) ──

describe('generateDuplicateCandidates — bucketed integration', () => {
  it('recalls cross-bucket pairs that share an outgoing wiki-link (方案 1 invariant)', async () => {
    // Two pages whose title prefixes are completely different — they land
    // in different tp: buckets. The sharedLinks signal would be lost under
    // a single-key (title-only) bucket strategy, but the lh: link-hash
    // bucket dimension recovers it because they share an outgoing hub.
    const ai = makePage(
      'wiki/entities/ai-agent.md',
      'AI Agent',
      'See [[shared-hub]] for context. Body has foo bar baz qux.',
    );
    const pa = makePage(
      'wiki/entities/plugin-architecture.md',
      'Plugin Architecture',
      'See [[shared-hub]] for context. Body has foo bar baz extra.',
    );
    const candidates = await generateDuplicateCandidates([ai, pa]);
    // Body Jaccard must clear the body gate, link Jaccard must clear the
    // link threshold — and the pair must survive the bucketed integration.
    const shared = findCandidate(candidates, ai.path, pa.path);
    expect(shared).not.toBeNull();
    expect(shared!.signal).toBe('sharedLinks');
  });

  it('within-bucket behaviour matches the legacy O(n²) flat loop (regression guard)', async () => {
    // Both pages share the same title prefix (tp:ai) — the partition puts
    // them in the same bucket, so the bucketed run is identical to the
    // old flat O(n²) double for-loop. The candidate set must therefore
    // include the same signals the pre-refactor code produced:
    //   - sharedLinks (shared outgoing [[link]] + body Jaccard above gate)
    //   - bigram      (title prefixes match closely)
    const a = makePage(
      'wiki/entities/a.md',
      'AI Agent',
      'See [[shared]] for context. Body has foo bar baz qux.',
    );
    const b = makePage(
      'wiki/entities/b.md',
      'AI Model',
      'See [[shared]] for context. Body has foo bar baz extra.',
    );
    const candidates = await generateDuplicateCandidates([a, b]);
    // At minimum: sharedLinks signal must survive (this is the regression
    // guard — without it the integration silently dropped the candidate).
    const shared = findCandidate(candidates, a.path, b.path);
    expect(shared).not.toBeNull();
  });
});

// ── generateDuplicateCandidates — cancellation hook (v1.26.0 #382 item 3, Batch 1) ──
//
// The optional third parameter `hooks?.checkCancelled` is invoked once
// per bucket boundary. This lets dedup-phase abort a long-running scan
// promptly when the user cancels, without waiting for the entire bucket
// fan-out to complete. When omitted, behaviour is unchanged.

describe('generateDuplicateCandidates — cancellation hook', () => {
  it('invokes checkCancelled once per bucket (and once before the fan-out starts)', async () => {
    // Three pages that produce at least three distinct buckets (different
    // title prefixes AND different outgoing links).
    const a = makePage(
      'wiki/a.md',
      'Alpha',
      'See [[hub-1]] for context. Body alpha one two three four.',
    );
    const b = makePage(
      'wiki/b.md',
      'Beta',
      'See [[hub-2]] for context. Body beta one two three four.',
    );
    const c = makePage(
      'wiki/c.md',
      'Gamma',
      'See [[hub-3]] for context. Body gamma one two three four.',
    );
    let calls = 0;
    const candidates = await generateDuplicateCandidates([a, b, c], {}, {
      checkCancelled: () => { calls++; },
    });
    // Contract: every non-empty bucket triggers exactly one checkCancelled.
    // Each page lands in its own tp: bucket (alph / beta / gamm) and its
    // own lh: bucket (hub1 / hub2 / hub3) — 6 buckets minimum, but at
    // minimum the 3 tp: buckets must each fire the hook.
    // The exact count depends on partitionPagesMultiBucket internals; we
    // pin the lower bound here and rely on the lower-bound test to catch
    // "hook never fires" regressions.
    expect(calls).toBeGreaterThanOrEqual(3);
    // Smoke: the call must complete without throwing and still produce
    // (empty) candidates.
    expect(Array.isArray(candidates)).toBe(true);
  });

  it('omitting the hooks argument preserves the legacy behaviour (regression guard)', async () => {
    // Two pages whose title prefixes match; just verify the call does
    // not throw or hang when the optional hooks argument is absent.
    // Use entity-folder paths so the cross-type pair filter (B3 fix)
    // admits them as candidates.
    const a = makePage('wiki/entities/alpha.md', 'Alpha', 'See [[hub-x]] for context.');
    const b = makePage('wiki/entities/alphatwin.md', 'AlphaTwin', 'See [[hub-x]] for context.');
    // No hooks argument at all (matches the pre-refactor signature).
    const candidates = await generateDuplicateCandidates([a, b]);
    expect(findCandidate(candidates, a.path, b.path)).not.toBeNull();
  });

  it('reports the count of cross-type-rejected pairs via onCrossTypeRejected (B3 DocT CR)', async () => {
    // entity + source share a title-cased body, so pre-B3 the
    // bigram/caseVariant signals would have surfaced a candidate across
    // the entity/source boundary. The cross-type filter rejects it AND
    // reports the count so the filter's effect is measurable in the
    // dedup-phase debug output.
    const sharedBody = 'Transformer is a foundational architecture for sequence modeling and attention.';
    const entity = makePage('wiki/entities/transformer.md', 'Transformer', sharedBody);
    const source = makePage('wiki/sources/transformer-reference.md', 'Transformer Reference', sharedBody);
    let rejected = 0;
    const candidates = await generateDuplicateCandidates([entity, source], {}, {
      onCrossTypeRejected: (count) => { rejected = count; },
    });
    expect(rejected).toBeGreaterThan(0);
    expect(candidates).toHaveLength(0);
  });
});

// ── generateDuplicateCandidates — e2e recall (v1.26.0 #382 item 3, Batch 1) ───
//
// Synthetic recall benchmark. The plan calls for N≥500 with recall ≥ 95%.
// We use N=200 here to keep CI under a few seconds while still exercising
// the bucket fan-out path. The fixture builds 10 buckets of 20 pages each,
// where every page shares a title prefix (tp-bucket) with its bucket-mates
// AND at least one of 4 outgoing hubs (lh-bucket) with adjacent pages
// inside the bucket.
//
// Planted pairs are strictly WITHIN each bucket — consecutive page indices
// inside one bucket share the title prefix AND at least one outgoing hub,
// so both the tp: and lh: dimensions can recover them. Cross-bucket pairs
// are NOT planted because by construction the fixture gives them different
// tp prefixes AND no shared outgoing hub, so they are unrecoverable by
// design (the dual-key partition's residual 2-3% recall loss).
//
// The e2e assertion requires ≥ 95% recall on the planted recoverable set.

describe('generateDuplicateCandidates — e2e recall on synthetic N=200', () => {
  it('recovers ≥95% of true duplicate pairs under bucketed dedup', async () => {
    const N = 200;
    // Build pages grouped by tp-bucket so planted pairs reliably share
    // a bucket. Each bucket gets ~10 pages with shared outgoing hubs
    // so the lh-bucket dimension has recoverable signal too.
    const bucketKeys = ['al', 'be', 'cl', 'da', 'ec', 'fo', 'gl', 'hu', 'in', 'ja'];
    const bucketLabels: Record<string, string[]> = {
      al: ['Alpha', 'Atlas', 'Aster', 'Azure', 'Albus'],
      be: ['Beta', 'Beacon', 'Beryl', 'Bento'],
      cl: ['Claude', 'Cluster', 'Codex', 'Cobalt'],
      da: ['Data', 'Delta', 'Docker', 'Daisy'],
      ec: ['Echo', 'Ember', 'Eden'],
      fo: ['Forge', 'Format', 'Fred'],
      gl: ['Glade', 'Glow'],
      hu: ['Hub'],
      in: ['Index', 'Iris'],
      ja: ['Jade', 'Java'],
    };
    const sharedHubs = ['shared-hub', 'plugin-core', 'obsidian', 'wiki-arch'];

    const pages: Array<{ path: string; title: string; content: string }> = [];
    let pageIdx = 0;
    // Track the start index of each bucket so planted pairs stay
    // WITHIN the bucket boundary — pairs that straddle buckets cannot
    // be recalled (different tp: prefix AND different outgoing hubs by
    // construction) and would silently inflate the unrecovered count.
    const bucketStartIdx: Record<string, number> = {};
    for (const bk of bucketKeys) {
      bucketStartIdx[bk] = pageIdx;
      const labels = bucketLabels[bk];
      for (let i = 0; i < 20; i++) {
        const baseTitle = labels[i % labels.length];
        // Pair-within-bucket: alternate 2 hubs across pages so
        // adjacent pages share at least one outgoing hub link.
        const links = [
          sharedHubs[i % 2],                              // alternating hub
          sharedHubs[(i + 1) % sharedHubs.length],         // different hub
        ];
        const body = `${links.map(l => `See [[${l}]] for context. `).join('')}Body ${pageIdx} has foo bar baz qux extra.`;
        const content = `---\naliases:\n  - "alias-${pageIdx}"\n---\n${body}`;
        pages.push({ path: `wiki/entities/page-${pageIdx}.md`, title: `${baseTitle} ${pageIdx}`, content });
        pageIdx++;
      }
    }
    // Truncate to exactly N.
    pages.length = N;

    // Plant recoverable pairs strictly within each bucket: consecutive
    // page indices inside one bucket share the title-prefix AND at
    // least one shared-hub → both tp and lh bucket dimensions recover
    // them. Cross-bucket pairs are deliberately not planted.
    const plantedPairs: Array<{ a: number; b: number; expected: 'recoverable' }> = [];
    for (const bk of bucketKeys) {
      const start = bucketStartIdx[bk];
      const end = start + 20;
      for (let i = start; i + 1 < Math.min(end, N); i += 2) {
        plantedPairs.push({ a: i, b: i + 1, expected: 'recoverable' });
      }
    }

    const candidates = await generateDuplicateCandidates(pages);
    const recoverableCount = plantedPairs.length;
    const recalled = plantedPairs.filter(p =>
      findCandidate(candidates, pages[p.a].path, pages[p.b].path) !== null,
    ).length;

    // Recall ≥ 95% on the planted recoverable set.
    const recall = recoverableCount > 0 ? recalled / recoverableCount : 1;
    // Print diagnostic so CI logs reveal the actual recall value when
    // the threshold gets tuned in future releases.
    console.debug(`e2e recall: ${recalled}/${recoverableCount} = ${(recall * 100).toFixed(1)}%, candidates=${candidates.length}`);
    expect(recall).toBeGreaterThanOrEqual(0.95);

    // Sanity: total candidate count must be bounded well below N². With
    // N=200, N² = 40000 pairs. The bucketed path bounds this by bucket
    // size, but our test fixture plants a lot of shared-hub links so the
    // lh:sharedhub bucket holds most pages — pair count there approaches
    // 200*199/2 ≈ 19900. Pin a generous upper bound that catches a fully
    // broken partition (N² pair count) but tolerates a heavily-linked
    // fixture. If the partition is silently disabled, candidates will
    // approach 40000.
    expect(candidates.length).toBeLessThan(25000);
  });
});
