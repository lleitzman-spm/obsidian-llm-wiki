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
- body-merge and reviewed-append planning can use a provider response only
  when it is explicitly bound with the page type, sealed settings, and source
  revision; the seam then applies the native clean/canonicalize/link/
  completeness/title/mentions tail and preserves native `NO_NEW_CONTENT`
  no-write behavior;
- index planning mirrors `IndexGenerator`'s three sections, summaries,
  aliases, localized labels, and empty-state output;
- ingest and lint log planning mirrors `LogWriter`, including page
  de-duplication, metrics formatting, header creation, and the 512 KiB trim.

The seam fails closed for the parts that cannot be proven from deterministic
inputs. Native body merge and reviewed append require an explicitly bound
provider response; missing or ambiguous source-scoped responses remain
`canApply: false` with a `native-llm-seam-required` reason. Complementary
append remains LLM-owned because its per-section triage/anchor sequence is not
represented by the headless IR. Index source entries require the raw source
path and reject a basename that does not equal the native fingerprinted slug.
The planners return bytes and paths only; callers still need the existing
lease, transaction, independent readback, lint, provenance, and receipt gates.
