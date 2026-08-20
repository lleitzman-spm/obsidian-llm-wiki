# SPM agent-operations shadow canary

This is the acceptance boundary between the current Obsidian ingest engine and
the parallel headless successor described in
[`ADR-0001`](./adr/0001-headless-ingest-migration.md).

## Preconditions

- The active `lease-management` ingest is fully linted, archived, attested when
  required, and verified by the repository orchestrator.
- No ingest or lint is active, and the live-vault writer lease is unowned.
- A content-addressed snapshot of the verified post-lease live vault has been
  copied into two independent, non-synced vaults: native-reference and
  candidate. Neither canary writer targets the live vault.
- The repository orchestrator reports no owned SPM03 source in the live queue.
- An authorized worker adapter is available for the frozen provider/model. It
  uses its own runtime identity and does not read, export, log, or persist
  Obsidian SecretStorage credentials. If no such adapter is available, the
  canary is blocked rather than silently switching provider or model.
- A run manifest, exclusive lease/fencing implementation, write-ahead journal,
  crash recovery, rollback verifier, and independent receipt verifier exist
  and pass their contract tests before either copied vault is written.

## Frozen source set

The canary covers exactly three maintained articles from authority repository
`https://github.com/lleitzman-spm/SPM-Optimization.git` at commit
`37cc4d934482f87342a9dc45e60839f1dfc35a26` and tree
`f0eca985c293f0c813066533ef63bb42e781aac9`. `_index.md` is navigation and is
excluded.

| Source | Bytes | SHA-256 |
|---|---:|---|
| `wiki/agent-operations/worker-dispatch.md` | 4,837 | `c9dc4c859cbd645d0a88b2e603efd198065c1b1dfa759431bf4c3345665d878e` |
| `wiki/agent-operations/remote-session-control.md` | 3,360 | `7df881c2a1d1135e37e9cd49e00ab98bee6447a9e7337eeae0f57d48907845a3` |
| `wiki/agent-operations/cross-session-messaging.md` | 7,381 | `e3973d4ea9f7bb7a420b729473f82acf94b20633cb56fb87411e3d4fae8e0a57` |

Any byte change creates a new canary input and invalidates earlier review.

## Compatibility anchors

These hashes identify the live reference surface at migration approval. A
settings hash is recorded without copying or exposing settings content.

| Surface | Bytes | SHA-256 |
|---|---:|---|
| Installed `manifest.json` | 423 | `56183c0f95ddfae1e81762ddfcdc3e06c5e65f815eafcab712ebfdee8992d93a` |
| Installed `main.js` | 3,836,035 | `4599c00f1695738cc702c66df2354ab016100748a1e8b0d19e3034628b0c8779` |
| Installed `data.json` | 8,160 | `283f3db44c020ff0f8fb042c44c827daeb1bca0d905e897224d0d6e85206bae2` |
| `20 Brain/schema/config.md` | 5,883 | `ce2def66f791c8886a053108b4d300897aaecd881e2ab03a82242954448188a0` |

The installed and upstream tag manifests both identify plugin version 1.26.4.
The installed bundle hash is the runtime reference even if upstream main moves.

The reference implementation must be built from tag commit
`b59bbfe2b4cdf1bf864fc0466a0a8c589ad607c4`, not the moving upstream
checkout. The current upstream CLI imports the checkout's live `src/`, so a
build from another commit is not a valid native reference.

Safe settings projection at approval:

- provider `openai-codex`; model `gpt-5.6-luna`; default ingest model;
- extraction granularity `standard`; reasoning enabled;
- page-generation concurrency `5`; batch delay `500ms`;
- Smart Fix disabled; periodic lint off; source auto-watch off; no watched
  folders;
- entity tags: `person`, `role`, `team`, `organization`, `owner`, `resident`,
  `property`, `vendor`, `system`, `document`, `template`, `place`;
- concept tags: `procedure`, `policy`, `decision-rule`, `obligation`,
  `exception`, `escalation`, `workflow`, `service`, `compliance`, `control`,
  `metric`, `risk`, `status`, `term`.

The safe projection and its canonical JSON hash are stored in the run manifest.
The full settings file remains in place and is identified only by its SHA-256.
Before copying either vault, an independent preflight command must emit a
signed capture receipt containing the observed window/vault identity, idle
status, capture time, full authority/runtime/schema hashes, full settings-file
SHA-256 plus safe-settings projection hash, copy roots, and the assertion that
neither root resolves into the live vault or a synced folder. Hardcoded values
in this document are expectations, not proof of current state.

## Durable run surfaces

One run ID owns a content-addressed directory with these versioned artifacts:

- `preflight-capture.json`: signed live/copy identity and idle-state capture;
- `live-preflight-capture.json`: release-time recapture made at most 60 seconds
  before live-lease acquisition;
- `source-inventory.json`: Git-tree-derived maintained-source inventory,
  selector version, explicit exclusions, and path/byte hashes;
- `run-manifest.json`: authority commit, preflight-capture digest,
  source-inventory digest, selector version and explicit exclusions, sealed
  snapshot tree hash and copy roots, ordered sources, original/canonical
  hashes, runtime and contract versions, safe settings, policy/vocabulary
  hashes, projection-parser/grammar/Unicode/boilerplate hashes, copied-vault
  snapshot manifests, capacity budgets, lease fence, and prior global replay-
  ledger checkpoint hash;
- `workers/<source-identity-sha256>.json`: one terminal, worker-signed source
  artifact per authority path. The source identity digest is SHA-256 over the
  domain separator, authority tree, normalized UTF-8 path, and byte SHA-256, so
  distinct paths with identical bytes cannot collide;
- `partitions.json`: typed canonical keys, reducer owner, fencing token, and
  partition load;
- `candidate-plan.json`: complete copied-vault create/replace/delete plan plus
  target precondition hashes and plan hash;
- `journal.jsonl`: append-only prepare/stage/commit/restore/recover events;
- `replay-ledger.jsonl`: signed, hash-chained key-ID/run-ID/nonce/fence entries
  for this run, beginning at the manifest-bound global checkpoint;
- `native-receipt.json`, `candidate-receipt.json`, and `comparison-receipt.json`;
- `native-projection.json`, `candidate-projection.json`, and
  `projection-comparison.json` using `semantic-projection/v1`;
- `terminal-run-root.json`: coordinator-signed Merkle root over every completed
  run artifact except itself, `verify.json`, and later release/live-preflight
  receipts; it explicitly includes the terminal journal and replay-ledger
  hashes, copied-vault hashes, and projection comparison;
- `verify.json`: independent verifier result over the terminal root and copied-
  vault hashes, signed by a verifier key pinned in the authority repository and
  binding the verifier build artifact hash.

Before the canary may run, the implementation phase must check in every JSON
contract schema and its validator command. The coordinator creates an
ephemeral Ed25519 key per worker. A launch-authority public key/key ID pinned by
full hash in the authority repository authenticates the coordinator key and
run manifest; private keys remain in OS-protected storage. The manifest binds
each worker key, worker ID, run ID, source identity, and allowed partition. All
signatures use RFC 8785 JCS, SHA-256, and versioned domain separation. Each
worker signs run ID, fence, source identity, partition, nonce, payload, and
terminal status. The append-only replay ledger records key ID, run ID, nonce,
and fence. The verifier rejects an untrusted key, duplicate tuple, replay,
source/partition substitution, invalid signature, or self-reported digest
mismatch. A receipt is not acceptance evidence until the independent verifier
reconstructs every referenced hash and signature chain from disk.

Merkle leaves are sorted by normalized relative-path UTF-8 bytes and encoded as
`SHA-256(merkle_leaf_domain || path_utf8 || NUL || raw_artifact_sha256)`. Parent
nodes are `SHA-256(merkle_node_domain || left_raw || right_raw)`; an odd final
node is paired with itself, and an empty tree is invalid. The coordinator key
may sign the terminal root only when its manifest scope includes
`spm-brain-run-terminalize`. `verify.json` is created afterward and therefore
cannot be a leaf; it signs and verifies the root. The release receipt binds both
digests. The global replay ledger is also signed and hash-chained; successful
terminalization appends the run ledger root under the launch-authority fence,
and the next manifest must bind that checkpoint. Deletion, reordering, or edit
breaks the chain, terminal root, or global checkpoint.

## Execution

1. Build the reference runtime from the frozen release-tag commit and verify its
   artifact hash. Fix the CLI invocation/docs so the required `ingest`
   subcommand and real source import path are reproducible.
2. Copy the three immutable sources into a content-addressed shadow workspace
   and create native-reference and candidate vaults from the same post-lease
   snapshot manifest.
3. Dispatch one isolated Luna map worker per source. This three-source run is a
   correctness canary, so useful concurrency is three; no duplicate lane is
   created to chase a worker count. Each worker receives only its source, the
   frozen schema, vocabulary/policy pack, and output contract.
4. Each worker emits JSON IR and a receipt. It does not read or write any
   generated wiki. Validate IR shape, hashes, exact evidence, tag vocabulary,
   sensitive-data policy, and source coverage before reduction.
5. Partition entities and concepts with the versioned
   `(page_type, normalized_label)` key. Aliases nominate but do not decide a
   merge. Reduce each owned key once and build the complete candidate plan.
6. Run the frozen current plugin as the sole writer against the
   native-reference copy. Run its native lint without fixes and capture the
   semantic reference projection and copied-vault receipt.
7. Close the native reference writer and release its copy-specific lease. With
   Obsidian closed for the candidate copy, acquire a new fenced lease and apply
   the candidate plan through the write-ahead transaction journal. Global
   pages, index, log, and schema are owned by this writer.
8. Inject both a stale-precondition failure before commit and a process
   interruption during a disposable transaction. Prove create/replace/delete
   restoration and crash recovery before the measured candidate transaction.
9. Compare canonical claim/evidence/disposition graphs, not rendered Markdown
   or page counts. Record map/reducer/writer timing, calls, every attempt and
   backoff, input/output/billed tokens, failures, and every material delta.
10. After accept/revise/reject is recorded, perform the second independent
    preflight (maximum age 60 seconds before live-lease acquisition). The
    signed release-decision receipt binds the exact authority repository commit
    and tree, authority-snapshot hash, registry repository revision and
    objective ID, selected engine artifact hash, immutable run-manifest hash,
    terminal-run-root hash, signed `verify.json` hash and verifier build hash,
    live-preflight-capture hash, and expected live-vault snapshot hash. The
    matching current registry record must name those same values. Its signer
    key must be the pinned
    launch-authority key or a delegated key whose sealed authority snapshot
    grants `spm-brain-ingest-release` scope for that exact objective ID. The
    release verifier must freshly fetch the canonical authority repository,
    require the stable checkout to be on `master` with
    `HEAD == origin/master`, run the Funnel successfully, and seal the resulting
    HEAD, registry-file SHA-256, and objective-record hash into the receipt; any
    fetch, branch, equality, Funnel, scope, or signature failure blocks release.
    The live preflight must reverify idle state, full settings SHA-256, safe
    projection, runtime/schema hashes, authority and registry revisions, target
    tree, and engine/manifest hashes. Only after that decision verifies may
    release staging begin; the writer's final compare-and-swap repeats every
    bound value immediately before commit.
11. Both an accepted candidate and the native fallback first run against a
    fresh copy and emit a complete plan; neither writes live progressively. The
    same fenced write-ahead transactional writer applies the selected plan to
    live, retaining restoration bytes and its exclusive lease through
    independent native readback. Readback must reproduce all committed file
    hashes and the semantic verification receipt before the domain can close.
    On mismatch, the writer restores every create/replace/delete/global-file
    change under the same fence, verifies the restored snapshot, and emits a
    signed failure/restore receipt. A failed restoration freezes all writers
    and stops for recovery; a successful writer receipt alone never establishes
    closure.

## Worker artifact minimum

Every source artifact must carry:

- contract version, job ID, worker ID, model/provider identity, and timestamps;
- source path, byte count, SHA-256, and immutable source revision;
- source summary and typed entity/concept proposals;
- a stable claim ID; typed subject key, predicate, and object; aliases and
  permitted subtype tags; and explicit `evidenced`, `asserted`, `contested`, or
  `unknown` disposition;
- quote evidence with source path, original and canonical SHA-256, UTF-8 byte
  offsets, exact canonical bytes, and normalization version; or typed
  structural/non-quote evidence with the same path, hashes, offsets, and exact
  bytes plus a closed-enum evidence kind and reason code. Free-form reason text
  cannot substitute for source bytes;
- per-attempt provider/model, status, reason, delay, input/output/billed tokens,
  and terminal retry accounting, including typed-output calls and recovered
  retries;
- artifact SHA-256 and terminal status.

The claim ID is the run-independent `claim_id/v1` digest defined by ADR-0001.
Alias proposals are separate signed edges with their own evidence identity and
`speculative`, `grounded`, or `adjudicated` state. Speculative aliases cannot
merge, persist, or enter the transaction plan.

Free-form Markdown from a worker is evidence for review, not a writable page
plan. Only a schema-valid artifact can enter reduction.

## Acceptance gates

The canary passes only when all of the following are true:

1. `source-inventory.json` is reproduced from the authority tree with selector
   `all *.md under wiki/agent-operations except the explicitly classified
   navigation file _index.md`; it yields exactly the three frozen maintained
   paths. Each source identity has exactly one successful terminal worker
   artifact and no path is duplicated or omitted.
2. Every candidate claim resolves to an exact path/hash/evidence tuple. Quote
   bytes match the stated UTF-8 offsets in the stated canonical source; a quote
   found only in another source or after lossy transformation is rejected.
3. Candidate pages satisfy the frozen schema and active entity/concept tag
   vocabularies without inventing a subtype.
4. Monotonic merge fixtures and the actual result prove that reviewed content,
   qualifications, obligations, exceptions, escalations, risks, and contested
   claims do not weaken. Assertion cannot become evidence without evidence;
   contested cannot disappear without an adjudication receipt.
5. Native lint and repository acceptance checks show no material increase in
   duplicates, dead links, empty pages, ungrounded quotes, or tag violations.
6. The `semantic-projection/v1` census reports source reach as maintained
   inventory paths with at least one verified source node divided by all
   maintained inventory paths (`3/3`); output grounding as page-statement nodes
   reachable through `renders` to a claim and through `evidences` to exact
   source bytes divided by every non-boilerplate sentence/list-item/table-cell
   page-statement node (`100%`); and native retention as native claim IDs either
   present in the candidate or connected to a signed material-delta disposition
   divided by every native claim ID (`100%`). The excluded boilerplate schema is
   versioned and hashed. Missing nodes or edges fail closed.
7. The candidate transaction refuses a stale fence or precondition immediately
   before write and before commit. Injected interruption recovery restores all
   create/replace/delete/global-file hashes and produces a verified journal.
8. `native-projection.json`, `candidate-projection.json`, and
   `projection-comparison.json` validate against the canonical graph schema.
   Every semantic difference has a typed materiality decision and signed
   disposition or adjudication edge. A page-count or scalar self-assertion is
   not parity.
9. Candidate timing/cost accounting is complete, but this three-source canary
   makes no 4-6x claim: three independent workers have a theoretical speedup
   below 3x once serial work is included. Speed never overrides gates 1-8.

## Scale decision

- **Accept:** enable the new engine for the exact 16-source
  [`client-management` throughput manifest](./fixtures/spm03-client-management-performance-manifest.json)
  in fresh copies. Use ADR-0001's numeric health window, growth/backoff,
  repetition, speedup, skew, retry/429, serial-fraction, and token-cost gates.
  Capacity is discovered at runtime and is not hardcoded to 20 or any earlier
  observation. Four-times is the acceptance target and six-times the stretch
  target.
- **Revise and repeat:** preserve artifacts, fix the contract or reducer, and
  rerun the same workload that failed: the three frozen source hashes for a
  correctness failure, or the exact 16-source manifest and its full alternating
  three-native/three-candidate protocol for a throughput failure.
- **Reject:** keep the native ingest path for the remaining domains. No canary
  writer touched the live vault, so rollback is to retain receipts for diagnosis
  and discard or archive the two copied vaults. Live `agent-operations` then
  proceeds through the native fallback as a separately governed ingest.
