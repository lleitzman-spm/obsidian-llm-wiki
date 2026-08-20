/**
 * Hand-authored v1.26.4 compatibility fixture.
 *
 * The values in this file are deliberately independent of the implementation
 * under test. They are the concrete paths, frontmatter, and markdown shapes
 * described by the native plugin sources at tag 1.26.4. A headless runner may
 * consume this fixture, but it must not replace the native behavior with a
 * plausible approximation when one of these assertions fails.
 */

export const NATIVE_V1264_COMPAT_FIXTURE = {
  sources: {
    firstPath: 'sources/Lease Management/Lease Standards.md',
    secondPath: 'sources/Operations/Lease Standards.md',
    firstFingerprint: '92ebf9',
    secondFingerprint: '980663',
    firstSlug: 'lease-standards_92ebf9',
    secondSlug: 'lease-standards_980663',
    maxLengthPath:
      'sources/Lease Management/Lease Standards With An Exceptionally Long Basename That Must Be Trimmed Before The Fingerprint.md',
  },

  pagePaths: {
    entityName: 'Lease Coordinator',
    entityPath: 'wiki/entities/lease-coordinator.md',
    conceptName: 'Lease Policy',
    conceptPath: 'wiki/concepts/lease-policy.md',
    sourcePath: 'wiki/sources/lease-standards_92ebf9.md',
  },

  /** A model-shaped reply; only deterministic native post-processing is asserted. */
  modelPageReply: `---
type: entity
created: 1999-01-01
updated: 1999-01-01
tags: [person, invented-tag, person]
aliases:
  - "LC"
  - "Lease Coordinator"
  - "LC"
redirect_to: "[[entities/Legacy Coordinator]]"
---

# Lease Coordinator

## Description
Coordinates lease standards.

## Related Entities
- [[sources/Vendor Manager]]

## Related Concepts
- [[Lease Policy]]

## Mentions in Source
- "A citation from the source" — [[sources/lease-standards_92ebf9|Lease Standards]]
`,

  existingPage: `---
type: entity
created: 2026-01-04
updated: 2026-08-19
sources:
  - "[[sources/lease-standards_92ebf9]]"
tags:
  - person
aliases:
  - "LC"
reviewed: true
redirect_to: "[[entities/Legacy Coordinator]]"
owner: "operations"
---

# Lease Coordinator

## Description
Curated description that must remain available.

## Related Entities
- [[entities/Existing Coordinator]]

## Mentions in Source
- "A curated earlier citation" — [[sources/lease-standards_92ebf9|Lease Standards]]
`,

  newSourceSlug: 'lease-standards_980663',
  newSourcePage: 'sources/lease-standards_980663',

  index: {
    entity: {
      path: 'wiki/entities/Lease Coordinator.md',
      basename: 'Lease Coordinator',
      content: `---
aliases:
  - "LC"
---

# Lease Coordinator

Owns lease standards for the portfolio.
`,
    },
    concept: {
      path: 'wiki/concepts/Lease Policy.md',
      basename: 'Lease Policy',
      content: `---
aliases:
  - "Policy"
---

# Lease Policy

Policy content.
`,
    },
    source: {
      path: 'wiki/sources/lease-standards_92ebf9.md',
      basename: 'lease-standards_92ebf9',
      content: `---
aliases:
  - "Lease Standards"
tags:
  - notes
---

# Lease Standards

Long source summary.
`,
    },
    expected: `# Wiki Index

> Auto-generated knowledge base directory

> Note: Text in backticks after page names shows aliases — alternative names, abbreviations, or translations.


## Entities

- [[entities/Lease Coordinator|Lease Coordinator]] \`aliases: LC\` - Owns lease standards for the portfolio.

## Concepts

- [[concepts/Lease Policy|Lease Policy]] \`aliases: Policy\` - Policy content.

## Sources

- [[sources/lease-standards_92ebf9|lease-standards_92ebf9]] \`aliases: Lease Standards\`
`,
  },

  /**
   * These operations are deterministic in native v1.26.4 and are covered
   * below. Extraction, semantic dedup, and the generated body are not; their
   * acceptance status must remain fail-closed until a real provider-backed
   * run is compared against the native plugin.
   */
  modelBoundary: {
    deterministicAcceptance: 'fixture-covered',
    extraction: 'requires-native-provider-run',
    semanticDedup: 'requires-native-provider-run',
    generatedBody: 'requires-native-provider-run',
  },
} as const;

export type NativeV1264CompatFixture = typeof NATIVE_V1264_COMPAT_FIXTURE;
