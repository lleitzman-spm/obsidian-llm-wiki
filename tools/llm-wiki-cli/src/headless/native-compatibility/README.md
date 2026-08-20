# Native v1.26.4 compatibility adapters

This directory is a read-only compatibility seam for the installed Karpathy
LLM Wiki `1.26.4` runtime.  It does not own a vault writer and it is not an
activation path for `native-compatible` execution.

The adapters cover the deterministic portions whose native implementations
are available as pure functions:

- source-page paths use `resolveSourceSlug`, including the basename plus
  six-hex FNV-1a fingerprint of the normalized source path;
- legacy mapper provenance can be re-stamped with that slug and its IR hash is
  recomputed rather than leaving a stale content address;
- source-page and entity/concept render planners apply the native
  post-processing tail only after a provider response is supplied;
- frontmatter-only merge planning uses native `mergeFrontmatter` field order,
  passthrough fields, source-link shape, and explicit run dates;
- index planning mirrors `IndexGenerator`'s three sections, summaries,
  aliases, localized labels, and empty-state output;
- ingest and lint log planning mirrors `LogWriter`, including page
  de-duplication, metrics formatting, header creation, and the 512 KiB trim.

The seam fails closed for the parts that cannot be proven from deterministic
inputs.  Native body merge, reviewed append, and complementary append remain
LLM-owned; their plans are returned with `canApply: false` and a
`native-llm-seam-required` reason.  Index source entries require the raw source
path and reject a basename that does not equal the native fingerprinted slug.
The planners return bytes and paths only; callers still need the existing
lease, transaction, independent readback, lint, provenance, and receipt gates.
