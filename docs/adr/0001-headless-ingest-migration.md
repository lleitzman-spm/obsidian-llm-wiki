# ADR-0001: Migrate ingest to a parallel headless engine

**Status:** Accepted design; activation blocked until every implementation gate
and contract test in the canary specification is green.

**Date:** 2026-08-20

**Decider:** Luke Leitzman

## Context

SPM-Brain currently uses Karpathy LLM Wiki inside Obsidian as both the ingest
engine and the vault writer. The SPM03 program contains 485 maintained articles
in 13 ordered domain batches. A clean sample from the active lease-management
run averaged about 5.9 minutes per source because one source can trigger many
LLM calls: iterative extraction, summary generation, entity and concept page
generation, merges, link normalization, index work, and logging.

The installed plugin reports version 1.26.4. This fork starts from upstream tag
`1.26.4` at commit `b59bbfe2b4cdf1bf864fc0466a0a8c589ad607c4` and preserves
the upstream Apache-2.0 `LICENSE` and `NOTICE`. The clone was made from upstream
main at `7aed9ebe5e1582cb3f253a3a3bc1b2096f0a001f`; compatibility is
anchored to the release tag, not to later main-branch changes.

The upstream repository already contains a Node CLI that runs the production
`WikiEngine`, `SourceAnalyzer`, `PageFactory`, `SchemaManager`, and provider
clients against a disk-backed vault. It is a useful compatibility seam, but it
processes one source per command and its own documentation forbids concurrent
Obsidian and CLI ingest against the same vault. It also cannot read Obsidian
SecretStorage; the current `openai-codex` setup therefore needs a separate
authorized worker adapter instead of credential extraction.

## Decision

Build a general headless knowledge engine behind an Obsidian control-plane
plugin. Replace the current plugin by compatibility-preserving increments, not
by a one-time rewrite.

The ingest data flow is:

```text
immutable sources
      |
      v
durable job manifest ---> isolated map workers ---> source-scoped IR artifacts
                                                   |
                                                   v
                                      canonical-page partition/shuffle
                                                   |
                                                   v
                                     one reducer per canonical page
                                                   |
                                                   v
                                      deterministic transaction plan
                                                   |
                                                   v
                                           single vault writer
                                                   |
                                                   v
                                   lint + provenance + receipt gates
```

The map stage scales horizontally without a hardcoded worker ceiling. A
scheduler discovers the capacity available in its current runtime and starts
at `min(4, ready_sources, discovered_capacity)`. Every eight terminal source
attempts form a health window. Within that window, a provider-call attempt is
every initial or repeated network call, including typed-output calls; recovered
retries are counted once for each additional call. A healthy window has zero
provider-call attempts ending in 429/timeout, retry-attempt count divided by
all provider-call attempts at or below 5%, p95 latency at or below 1.5x the
calibration p95, and at least 20%
request/token-bucket headroom; it increases concurrency by
`max(1, floor(current / 4))`. Any 429, timeout, budget exhaustion, or p95 above
2x calibration halves concurrency, stops new dispatch, and honours
`Retry-After` or an exponential cooldown capped at 60 seconds. Ready sources
are scheduled oldest-first within the one active domain. The controller never
creates duplicate or dependency-blocked lanes merely to fill slots.
A worker may read one immutable source and emit a content-addressed intermediate
representation, but it may not write generated wiki pages. Page reducers own
disjoint canonical page keys. Exactly one transactional writer applies a
validated plan to a vault snapshot.

The engine will expose provider-neutral contracts for:

- source discovery and immutable source identities;
- job leases, retries, cancellation, and resumable checkpoints;
- source-scoped entities, concepts, mentions, quotes, and summaries;
- canonical-page reduction and reviewed-page preservation;
- transaction planning, precondition hashes, rollback, and receipts;
- adaptive worker, request, and token budgets with global backpressure;
- schema, vocabulary, provenance, privacy, lint, and acceptance policy packs;
- progress and failure events consumed by the Obsidian control plane.

SPM-specific rules remain a policy pack. Entity tags, concept tags, PII
handling, exact maintained-article provenance, contested-claim review, and the
SPM03 domain order must not be compiled into the generic engine.

## Invariants

1. There is never more than one writer for a vault. Obsidian ingest, the legacy
   headless CLI writer, and the new writer are mutually exclusive through an
   exclusive lease with an owner, monotonic fencing token, heartbeat, expiry,
   and compare-and-swap checks before every write and final commit.
2. Map workers never write `20 Brain`, `index.md`, `log.md`, or schema files.
3. Every generated claim retains an exact source path, source hash, and typed
   evidence record. A missing or wrong-source evidence record rejects the claim
   before reduction.
4. A reducer owns one typed canonical page key and fencing token at a time; two
   reducers cannot update the same page concurrently. Entity and concept
   namespaces never collide merely because their normalized labels match.
5. The writer applies a complete transaction plan only when a signed run
   manifest and complete target-file manifest still match. A durable
   write-ahead journal records staged content, creates, replacements, deletes,
   global resources, and restoration bytes. A stale fence, hash mismatch, or
   interrupted commit fails closed and is crash-recoverable. The exclusive
   lease remains held through independent readback. A readback mismatch triggers
   restoration under the same fence; restoration failure freezes writer
   acquisition and preserves the journal for recovery.
6. Reviewed content, qualifications, and evidenced/asserted/contested
   distinctions cannot be silently weakened by a merge.
7. No process reads or exports Obsidian SecretStorage credentials. Worker
   adapters use their own authorized runtime identity.
8. A successful model response is not completion. Lint, provenance, reach,
   transaction, and receipt gates all have to pass.
9. The transaction writer exclusively owns generated pages plus `index.md`,
   `log.md`, and schema mutations. Retained native lint/query/UI components are
   read-only while the lease is held; auto-watch, periodic lint, startup repair,
   sync writers, and individual fixes are disabled or mechanically lock-gated.

## Core artifact contracts

The source run manifest binds the authority repository URL, full commit and
tree IDs, ordered source paths and byte hashes, source normalization version,
installed runtime bundle,
settings hash and safe settings projection, schema hash, vocabulary/policy-pack
hashes, provider/model identity, prompt and contract versions, target-vault
snapshot, and the current writer fencing token. The final compare-and-swap
rechecks every bound value immediately before commit.

Each claim has a stable claim ID; a typed subject key, predicate, and object; a
disposition of `evidenced`, `asserted`, `contested`, or `unknown`; and an
evidence union. Quote evidence records the source path, original and canonical
source hashes, UTF-8 byte offsets, exact canonical bytes, and normalization
version. Structural/non-quote evidence carries the same path, hashes, UTF-8
byte offsets, and exact canonical bytes plus a closed-enum evidence kind and
reason code; free-form explanation is never a substitute for source bytes.
Reduction rejects missing, transformed, out-of-range, or wrong-source evidence.

`evidence_id/v1` is SHA-256 over domain-separated RFC 8785 JCS encoding of its
kind, authority tree, normalized path, source hashes, byte range, exact-byte
hash, normalization version, and reason code. `claim_id/v1` is run-independent:
SHA-256 over domain-separated JCS encoding of the typed subject key, versioned
predicate, canonical typed object, and the lexicographically sorted, duplicate-
free set of evidence IDs. The run ID and worker ID are never part of claim
identity. Any declared semantic equivalence between different IDs is a
separately signed adjudication edge, never an in-place ID rewrite.

The coordinator uses an ephemeral Ed25519 key per worker. A launch-authority
key whose public key and key ID are pinned by full hash in the authority
repository signs the coordinator public key and run manifest; private keys stay
in OS-protected storage. The manifest binds each worker public key to the
worker ID, run ID, source identity, and allowed partition. All signed JSON uses
RFC 8785 JCS, SHA-256, and the normative domains below. Workers sign the canonical artifact digest
including run ID, fence, source identity, partition, nonce, payload, and
terminal status. An append-only replay ledger stores key ID, run ID, nonce, and
fence. The independent verifier rejects an untrusted or unknown key, duplicate
ledger tuple, invalid signature, replay, source/partition substitution, and
self-reported digest rewrites.

The v1 hashing/signing domains are normative UTF-8 strings including the final
NUL byte: `spm-brain/evidence-id/v1\0`, `spm-brain/claim-id/v1\0`,
`spm-brain/source-identity/v1\0`, `spm-brain/source-node-id/v1\0`,
`spm-brain/alias-node-id/v1\0`,
`spm-brain/canonical-key-id/v1\0`, `spm-brain/page-statement-id/v1\0`,
`spm-brain/adjudication-node-id/v1\0`, `spm-brain/projection-edge-id/v1\0`,
`spm-brain/coordinator-delegation-signature/v1\0`,
`spm-brain/preflight-capture-signature/v1\0`,
`spm-brain/live-preflight-capture-signature/v1\0`,
`spm-brain/worker-artifact-signature/v1\0`,
`spm-brain/run-manifest-signature/v1\0`,
`spm-brain/journal-entry-signature/v1\0`,
`spm-brain/native-receipt-signature/v1\0`,
`spm-brain/candidate-receipt-signature/v1\0`,
`spm-brain/comparison-receipt-signature/v1\0`,
`spm-brain/adjudication-receipt-signature/v1\0`,
`spm-brain/terminal-root-signature/v1\0`,
`spm-brain/verifier-signature/v1\0`,
`spm-brain/release-decision-signature/v1\0`,
`spm-brain/failure-restore-receipt-signature/v1\0`,
`spm-brain/replay-entry/v1\0`,
`spm-brain/merkle-leaf/v1\0`, and `spm-brain/merkle-node/v1\0`. An ID is
`SHA-256(domain_bytes || JCS_bytes)`. A signature signs
`domain_bytes || raw_32_byte_digest`. Hex is lowercase only at serialization
boundaries and is never fed back as digest bytes.

Disposition merge follows a checked transition matrix. `unknown` may advance
to `asserted` only with an exact source evidence tuple, to `evidenced` only
with evidence that passes the eligible-kind and grounding validator, or to
`contested` only when a second valid, contradictory claim/evidence tuple is
present. `asserted` may advance to `evidenced` with the same evidence gate or to
`contested` with valid contradictory evidence. `evidenced` may advance only to
`contested` when valid conflict evidence appears. No state may regress to
`unknown` or `asserted`. A contested claim is
immutable. Resolution creates a separate adjudication record and active-view
edge while preserving every contested input. Its signed receipt binds the
adjudicator authority-snapshot ID and delegated scope, all claim IDs and
evidence hashes, source revision, decision code, rationale code, timestamp,
and superseding active-view edge. No principal lacking claim-adjudication scope
in the SPM authority registry may issue it. Conflicting records are preserved
as a set, not flattened into synthetic consensus.

Canonical page keys use `(page_type, normalized_label)`, where normalization is
versioned Unicode NFKC, case folding, and whitespace collapse. Aliases nominate
merge candidates but do not silently establish identity. Each alias proposal
has its own evidence identity and is `speculative`, `grounded`, or
`adjudicated`. Speculative aliases may guide a shadow comparison but cannot
merge keys, enter a writable plan, or persist to the vault. Grounded aliases
require exact evidence; adjudicated aliases bind the signed receipt. Cross-type
collisions remain distinct; same-type ambiguous collisions require an
adjudication record. The partition manifest names the one reducer and fence
that owns each key.

The canonical semantic projection is `semantic-projection/v1`. It persists
sorted source, claim, alias, canonical-key, page-statement, and adjudication nodes plus
typed `evidences`, `renders`, `nominates`, `contests`, and `resolves` edges.
Every sentence, list item, or table cell in maintained generated content is a
page-statement node; only versioned navigation/frontmatter boilerplate is
excluded. Native and candidate adapters must emit this same schema. Matching is
by stable ID; semantic-equivalence mappings require signed adjudication edges.
The native projection, candidate projection, and comparison are durable
artifacts so an independent verifier can recompute every denominator and delta.

Every projection ID is domain-separated SHA-256 over JCS: a source node uses
authority tree, normalized path, and byte hash; a canonical-key node uses page
type, normalization version, and normalized label; a page-statement node uses
canonical-key ID, versioned section path, statement kind, ordinal, and canonical
text hash; an adjudication node uses authority-snapshot ID, sorted claim and
evidence IDs, source revision, and decision/rationale codes. An edge ID covers
edge kind, source ID, target ID, and its typed payload. Projection files use JCS
and sort nodes and edges lexicographically by ID.

An alias node ID uses `alias-node-id/v1` over normalization version, normalized
alias label, target page type, proposed canonical-key ID, and the sorted,
duplicate-free evidence-ID set. Alias state is node data rather than identity;
state changes require a valid evidence or adjudication edge and cannot silently
replace the node ID.

The legal edge matrix is closed: `evidences` is source -> claim with a sorted,
duplicate-free `evidence_ids` payload; `renders` is claim -> page-statement with
`render_role` in `supports|qualifies|contests`; `nominates` is alias ->
canonical-key with alias state and evidence/adjudication ID; `contests` is claim
-> claim with sorted conflict-evidence IDs; `resolves` is adjudication -> claim
with decision code and boolean `active_view`. Self-edges are invalid except a
schema-declared equivalence adjudication; all other node-type/payload
combinations fail validation.

Projection parsing uses a checked-in `projection-parser/v1` whose source/build
hash, Markdown grammar hash, Unicode data hash, and
`boilerplate-policy/v1.json` hash are sealed in the run manifest. UTF-8 decoding
is strict; CRLF becomes LF; the pinned Markdown AST supplies source spans.
Paragraphs are segmented by the checked-in Unicode sentence rules; each list
item and table cell is one statement unless it contains multiple sentence
segments. Canonical text is obtained by rendering inline Markdown to plain
text, Unicode NFKC, replacing every Unicode whitespace run with one ASCII
space, and trimming; case and punctuation are preserved. The boilerplate
policy is a closed list of exact AST selectors and frontmatter keys; unmatched
text is always semantic. Its fixtures and hash make title, frontmatter, and
navigation exclusions independently reproducible.

Closed vocabularies for v1 are:

- evidence kind: `quote`, `heading`, `list-item`, `table-cell`,
  `frontmatter-field`, `code-block`;
- evidence reason: `direct-quote`, `defines-relationship`, `defines-scope`,
  `defines-status`, `defines-obligation`, `defines-exception`,
  `defines-control`, `defines-metric`;
- adjudication decision: `confirm-left`, `confirm-right`, `preserve-both`,
  `merge-equivalent`, `supersede-with-new-claim`, `defer-unresolved`;
- adjudication rationale: `stronger-primary-evidence`,
  `newer-authority-revision`, `scope-distinction`, `terminology-equivalence`,
  `non-equivalent-conflict`, `insufficient-evidence`;
- materiality: `semantic-preserving`, `semantic-addition`, `semantic-removal`,
  `qualification-change`, `disposition-change`, `identity-change`,
  `provenance-change`, `render-only`, `boilerplate-only`.

Schemas reject any unlisted value. Every materiality value except
`semantic-preserving`, `render-only`, and `boilerplate-only` requires a signed
disposition or adjudication edge.

The v1 evidence-eligibility matrix is closed. `quote/direct-quote` may establish
any predicate after exact grounding. `heading` may establish only
`defines-scope` or `defines-status`. `frontmatter-field` may establish only
`defines-relationship`, `defines-scope`, `defines-status`, or `defines-metric`
and only for a key recognized by the sealed schema. `list-item` and `table-cell`
may establish any `defines-*` reason. `code-block` may establish only
`defines-control` or `defines-metric`. Every other kind/reason combination is
ineligible for `evidenced`, though an exactly grounded tuple may remain
`asserted`. Contested status requires two independently eligible claim/evidence
tuples with the same versioned predicate whose canonical objects are mutually
exclusive under the checked-in `predicate-conflict/v1` table; a model's
unsupported conflict label is never sufficient. The conflict-table hash and
eligibility-matrix version are sealed in the run manifest.

## Options considered

| Option | Time to first result | Parallelism | Vault risk | Long-term ownership |
|---|---:|---:|---:|---:|
| Keep UI automation around the current plugin | Low | Low | Medium | Low |
| Run many copies of the existing CLI against the live vault | Low | High | Unacceptable | Low |
| Greenfield engine and plugin rewrite | High | High | Medium | High |
| Fork, separate map/reduce from writing, then replace components | Medium | High | Low | High |

The fourth option is selected. It preserves a working reference implementation
while creating clean ownership boundaries around parallel work and vault
mutation.

## Migration phases

1. **Compatibility freeze.** Record the installed plugin, settings, schema,
   source corpus, and upstream tag. Define IR, transaction, receipt, and policy
   contracts.
2. **Shadow canary.** Run the three-file `agent-operations` domain through
   source-isolated workers that emit artifacts only. Run both the current
   plugin reference and candidate writer against separate copied vaults, then
   compare results under the canary specification. This is a correctness
   canary; three independent sources cannot demonstrate 4-6x throughput.
3. **Transactional writer in a clone.** Reduce the accepted canary artifacts
   into a copied vault, run native and repository gates, and prove rollback.
4. **Dual engine.** Use `client-management` or another sufficiently large
   frozen domain as the first throughput canary, then progress to larger SPM03
   domains. The current plugin retains lint, query, and UI duties only while
   idle/read-only or lock-gated; the transaction writer owns all generated and
   global-file mutation.
5. **Replace lint and indexing.** Move deterministic checks and index creation
   into the headless engine after parity is measured.
6. **Replace query and UI last.** Ship the owned Obsidian plugin as the control
   plane; disable the legacy plugin only after stored-data compatibility and
   rollback are proven.

Every phase has an explicit accept/reject receipt. A rejected phase leaves the
current plugin and vault usable and does not advance writer authority.

## Consequences

Parallel extraction can use the useful capacity the runtime and provider expose
while page merges and vault writes remain deterministic. Capacity is discovered
and adaptive, not anchored to a prior agent count. The design supports other
vaults through policy and provider adapters instead of SPM-specific code forks.

The cost is additional artifact storage, reducer logic, leases, transaction
preconditions, and parity testing. The first canary intentionally prioritizes
truth and recoverability over maximum speed.

## Gate 4: Performance

| Dimension | Status | Notes |
|---|---|---|
| CPU | Planned improvement | Source extraction is parallel; canonical reduction avoids concurrent duplicate work. |
| Memory | Bounded by contract | Workers emit per-source artifacts; reducers load only their page partition. |
| IO | Planned improvement | Workers do not touch the vault; one transaction plan batches controlled writes. |
| Network | Adaptive and measured | The run config carries worker, request, RPM, TPM, and retry budgets. The controller honours `Retry-After`, uses a global semaphore/token bucket, grows after healthy completions, and multiplicatively backs off on 429, timeout, or sustained latency pressure. |
| Token | Attempt-level accounting | Every attempt, including typed-output calls and recovered retries, records input/output/billed tokens, reason, delay, provider, and terminal status. |

The three-source correctness canary makes no throughput claim. The first
performance canary is the exact 16-source manifest in
[`spm03-client-management-performance-manifest.json`](../fixtures/spm03-client-management-performance-manifest.json).
After one unmeasured calibration, run three native and three candidate trials
in alternating order on fresh copies with the same source/settings/prompt/model
manifest. Every trial must pass correctness with zero failed sources. Define
`speedup = median(native wall time) / median(candidate wall time)`; report all
six values plus p50/p95, map, reducer, global-index, and writer wall time;
max/mean partition load; p95/p99 reducer time; serial fraction; retry/429 rate;
and tokens/cost. Four-times median speedup is the acceptance target, six-times
is the stretch target, and the slowest candidate trial must remain at least 3x
the native median. A 4x result requires measured serial work at or below 25%;
6x requires at or below 16.7%. For each trial, define end-to-end wall time from
the sealed-snapshot start receipt through the terminal verification receipt.
Define serial-only time as the duration of the union of critical-path intervals
that require the single coordinator/global-resource owner/writer and during
which no map or disjoint-page reducer can make useful progress. Count overlaps
once and exclude single-owner work that overlaps useful parallel work. Define
`serial_fraction = serial_only_union_duration / end_to_end_wall_time`, and
retain the interval trace used to calculate it.

Performance acceptance additionally requires max/mean partition load at or
below 4, reducer p95 at or below 4x reducer median, 429 attempts at or below 2%,
all retry attempts at or below 10%, zero exhausted retry budgets, and candidate
all-in metered provider cost at or below 1.25x the native median. The 429 and
retry percentages use all provider-call attempts in that trial as their
denominator; each recovered retry is an additional attempt. All-in cost covers
input, output, reasoning, cache read/write, tool, and any other billed token or
request bucket exposed by the provider. Record both the native currency amount
and bucket counts. If the provider omits currency cost, calculate a
billed-equivalent amount using the versioned price table sealed in the run
manifest; an unaccounted billed bucket fails the cost gate. A threshold miss
routes to revise-and-repeat even if aggregate wall time reaches 4x. Correctness
gates remain absolute even when the speed target is missed.
