# projection-parser/v1

This parser is intentionally narrow and deterministic. It accepts UTF-8 bytes,
rejects replacement-character decoding, normalizes CRLF/CR to LF, and emits
headings, sentence segments from paragraphs, list-item segments, and table
cells. Every emitted record carries a source slice and an exclusive UTF-8 byte
range into the normalized source.

Inline text is rendered to visible text, then normalized with Unicode NFKC and
one ASCII space per Unicode whitespace run. Case and punctuation remain
unchanged. The checked-in `boilerplate-policy/v1.json` excludes configured
frontmatter keys, the first H1 title, and navigation sections. Unknown
frontmatter keys remain semantic; unmatched body text is never inferred to be
boilerplate.

The policy hash is the SHA-256 of the exact policy file bytes (including its
terminal LF), recorded in `v1.sha256`. `fixtures/v1-basic.json` pins the
representative statement order and exclusion vocabulary.

This is not a full CommonMark/GFM implementation. Nested lists, HTML blocks,
reference-link definitions, callouts, and complex table escapes are outside
the v1 grammar. A future parser version must change the version and hashes.
