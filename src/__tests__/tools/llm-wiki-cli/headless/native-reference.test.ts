import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { applySettingsMigrations } from '../../../../../src/core/settings-migrations';
import { resolveSourceSlug } from '../../../../../src/core/source-slug';
import { captureSettingsHashes, projectSafeSettings } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/settings';
import { canonicalJsonSha256, sha256Hex, sourceIdentityDigest } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';
import { generateEd25519KeyPair, createSigner } from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { validateContract } from '../../../../../tools/llm-wiki-cli/src/headless/contracts';
import { buildNativeReferenceProjection } from '../../../../../tools/llm-wiki-cli/src/headless/native-reference/projection';
import {
  NATIVE_REFERENCE_SIGNING_SCOPE,
  preflightNativeReference,
  type NativeReferenceInput,
} from '../../../../../tools/llm-wiki-cli/src/headless/native-reference';
import type { SourceInventory } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/source-inventory';

const roots: string[] = [];
const AUTHORITY_TREE = 'a'.repeat(64);

async function fixture(autoSmartFix = false): Promise<{
  input: NativeReferenceInput;
  sourceInventory: SourceInventory;
  pageContent: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'spm-native-reference-'));
  roots.push(base);
  const liveRoot = join(base, 'live');
  const copiedVaultRoot = join(base, 'copy');
  const artifactRoot = join(base, 'artifacts');
  await Promise.all([liveRoot, copiedVaultRoot, artifactRoot].map(path => mkdir(path, { recursive: true })));

  const sourcePath = 'docs/alpha.md';
  const sourceContent = '# Alpha\n\nAlpha is a governed entity.\n';
  const settingsRaw = JSON.stringify({
    provider: 'test-provider',
    model: 'test-model',
    wikiFolder: 'wiki',
    autoSmartFix,
    apiKey: 'must-not-leave-the-settings-hash',
  });
  await mkdir(join(copiedVaultRoot, '.obsidian/plugins/karpathywiki'), { recursive: true });
  await mkdir(join(copiedVaultRoot, 'docs'), { recursive: true });
  await mkdir(join(copiedVaultRoot, 'wiki'), { recursive: true });
  await writeFile(join(copiedVaultRoot, '.obsidian/plugins/karpathywiki/data.json'), settingsRaw);
  await writeFile(join(copiedVaultRoot, sourcePath), sourceContent);
  const effectiveSettings = applySettingsMigrations(JSON.parse(settingsRaw)).settings;
  const settingsHashes = captureSettingsHashes(
    new TextEncoder().encode(settingsRaw),
    projectSafeSettings(effectiveSettings),
  );
  const sourceHash = sha256Hex(sourceContent);
  const sourceIdentity = sourceIdentityDigest(AUTHORITY_TREE, sourcePath, sourceHash);
  const inventoryBody = {
    version: 'source-inventory/v1' as const,
    authorityTree: AUTHORITY_TREE,
    selectorVersion: 'test-selector/v1',
    includes: ['docs/**/*.md'],
    exclusions: [],
    sources: [{ path: sourcePath, byteLength: new TextEncoder().encode(sourceContent).byteLength, byteSha256: sourceHash, sourceIdentity }],
    snapshotTreeHash: sha256Hex('source-snapshot'),
  };
  const sourceInventory: SourceInventory = { ...inventoryBody, inventorySha256: canonicalJsonSha256(inventoryBody) };
  const pageContent = `---\ntype: entity\nsources:\n  - "[[sources/${resolveSourceSlug(sourcePath)}]]"\ntags:\n  - person\n---\n# Alpha\n\nAlpha is a governed entity.\n`;
  await writeFile(join(copiedVaultRoot, 'wiki/Alpha.md'), pageContent);
  const signer = createSigner(generateEd25519KeyPair().privateKey, { scopes: [NATIVE_REFERENCE_SIGNING_SCOPE] });
  const input: NativeReferenceInput = {
    runId: 'native-test',
    mode: 'ingest',
    liveRoot,
    copiedVaultRoot,
    artifactRoot,
    sourceInventory,
    settings: {
      fullSha256: settingsHashes.fullSettingsSha256,
      safeProjectionSha256: settingsHashes.safeSettingsProjectionSha256,
    },
    provider: {
      provider: 'test-provider',
      model: 'test-model',
      authorizationRef: 'test-grant-1',
      createClient: () => ({ createMessage: async () => '' }),
    },
    signer,
    sourcePaths: [sourcePath],
  };
  return { input, sourceInventory, pageContent };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('native reference preflight', () => {
  it('binds copied settings and source bytes before opening the native engine', async () => {
    const { input } = await fixture();
    const result = await preflightNativeReference(input);
    expect(result.copiedVaultRoot).toContain('copy');
    expect(result.selectedSources.map(source => source.path)).toEqual(['docs/alpha.md']);
    expect(result.beforeSnapshot.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a copied root that is the live root', async () => {
    const { input } = await fixture();
    await expect(preflightNativeReference({ ...input, copiedVaultRoot: input.liveRoot }))
      .rejects.toMatchObject({ code: 'unsafe-copy-root' });
  });

  it('refuses source drift before any native write', async () => {
    const { input } = await fixture();
    await writeFile(join(input.copiedVaultRoot, 'docs/alpha.md'), 'changed');
    await expect(preflightNativeReference(input)).rejects.toMatchObject({ code: 'source-drift' });
  });

  it('refuses Smart Fix lint because the native manual UI seam is unavailable', async () => {
    const { input } = await fixture(true);
    await expect(preflightNativeReference({ ...input, mode: 'lint' }))
      .rejects.toMatchObject({ code: 'lint-smart-fix-enabled' });
  });

  it('refuses a provider identity that does not match the copied settings', async () => {
    const { input } = await fixture();
    await expect(preflightNativeReference({
      ...input,
      provider: { ...input.provider, model: 'wrong-model' },
    })).rejects.toMatchObject({ code: 'provider-settings-mismatch' });
  });
});

describe('native reference projection', () => {
  it('projects native Markdown pages with source-bound evidence and no settings secrets', async () => {
    const { input, sourceInventory, pageContent } = await fixture();
    const projection = await buildNativeReferenceProjection({
      runId: input.runId,
      authorityTree: sourceInventory.authorityTree,
      wikiFolder: 'wiki',
      sourceInventory: sourceInventory.sources,
      vault: {
        getMarkdownFiles: () => [{ path: 'wiki/Alpha.md', name: 'Alpha.md' }],
        read: async () => pageContent,
      },
    });
    const validation = validateContract('semanticProjection', projection);
    expect(validation.valid).toBe(true);
    expect(projection.nodes.some(node => node.type === 'source')).toBe(true);
    expect(projection.nodes.some(node => node.type === 'page-statement')).toBe(true);
    expect(projection.edges.some(edge => edge.type === 'evidences')).toBe(true);
    expect(JSON.stringify(projection)).not.toContain('must-not-leave-the-settings-hash');
  });

  it('grounds source pages at their generated wiki path and preserves page metadata and links', async () => {
    const { input, sourceInventory } = await fixture();
    const sourceSlug = resolveSourceSlug(sourceInventory.sources[0]!.path);
    const sourcePagePath = `wiki/sources/${sourceSlug}.md`;
    const files = new Map<string, string>([
      [sourcePagePath, `---
type: source
tags:
  - procedure
aliases:
  - Alpha Source
---
# Alpha

Source summary.
`],
      ['wiki/entities/Alpha.md', `---
type: entity
sources:
  - "[[sources/${sourceSlug}]]"
tags:
  - person
aliases:
  - A
---
# Alpha

See [[concepts/Governance]] and [[sources/${sourceSlug}]].
`],
      ['wiki/concepts/Governance.md', `---
type: concept
sources:
  - "[[sources/${sourceSlug}]]"
tags:
  - procedure
---
# Governance

See [[entities/Alpha]].
`],
      ['wiki/index.md', '# Wiki Index\n\nNavigation only.\n'],
    ]);
    const projection = await buildNativeReferenceProjection({
      runId: input.runId,
      authorityTree: sourceInventory.authorityTree,
      wikiFolder: 'wiki',
      sourceInventory: sourceInventory.sources,
      vault: {
        getMarkdownFiles: () => [...files.keys()].map(path => ({ path, name: path.split('/').pop()! })),
        read: async file => files.get(file.path) ?? '',
      },
    });

    const sourceNode = projection.nodes.find(node => node.type === 'source');
    expect(sourceNode?.data.sourcePagePath).toBe(sourcePagePath);
    expect(sourceNode?.data.normalizedPath).toBe('docs/alpha.md');

    const entity = projection.nodes.find(node => node.type === 'canonical-key' && node.data.pagePath === 'wiki/entities/Alpha.md');
    expect(entity?.data.aliases).toEqual(['A']);
    expect(entity?.data.tags).toEqual(['person']);
    expect(entity?.data.relatedLinks).toEqual(['wiki/concepts/Governance.md', sourcePagePath]);

    const aliases = projection.nodes.filter(node => node.type === 'alias');
    expect(aliases.map(node => node.data.normalizedAliasLabel).sort()).toEqual(['a', 'alpha source']);
    const alias = aliases.find(node => node.data.proposedCanonicalKeyId === entity?.id);
    expect(alias?.data.normalizedAliasLabel).toBe('a');
    expect(alias?.data.state).toBe('speculative');
    expect(projection.edges.some(edge => edge.type === 'nominates')).toBe(false);
    expect(projection.nodes.filter(node => node.type === 'canonical-key')).toHaveLength(4);
    expect(projection.nodes.some(node => node.type === 'canonical-key' && node.data.pagePath === 'wiki/index.md')).toBe(true);
  });
});
