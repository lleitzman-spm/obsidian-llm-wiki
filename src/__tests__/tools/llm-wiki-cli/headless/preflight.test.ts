import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSourceInventory,
  type GitCommand,
  type GitCommandResult,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/source-inventory';
import {
  sha256Hex,
  sourceIdentityDigest,
  snapshotTreeHash,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';
import {
  captureSettingsHashes,
  projectSafeSettings,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/settings';
import {
  assertSafeCopyRoots,
  resolveSafeRoot,
  type RootProbe,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/roots';
import {
  assertFreshPreflight,
  isFreshPreflight,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/freshness';
import { capturePreflightCapture } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/manifest';

function result(stdout: string | Uint8Array, status = 0): GitCommandResult {
  return { status, stdout, stderr: '' };
}

function fakeGit(files: Record<string, Uint8Array>): GitCommand {
  return {
    run: async (args) => {
      if (args[0] === 'ls-tree') {
        const lines = Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, bytes]) => `100644 blob ${sha256Hex(bytes)}\t${bytes.byteLength}\t${path}`)
          .join('\0');
        return result(`${lines}\0`);
      }
      if (args[0] === 'show') {
        const spec = String(args.at(-1));
        const path = spec.slice(spec.indexOf(':') + 1);
        return result(files[path] ?? new Uint8Array());
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    },
  };
}

describe('headless preflight source inventory', () => {
  it('derives selected maintained sources from a Git tree and excludes navigation', async () => {
    const files = {
      'wiki/agent-operations/_index.md': new TextEncoder().encode('nav'),
      'wiki/agent-operations/worker-dispatch.md': new TextEncoder().encode('worker'),
      'wiki/agent-operations/remote-session-control.md': new TextEncoder().encode('remote'),
      'wiki/agent-operations/notes.txt': new TextEncoder().encode('skip'),
    };

    const inventory = await buildSourceInventory({
      authorityTree: 'a'.repeat(40),
      git: fakeGit(files),
      selector: {
        version: 'agent-operations-md/v1',
        include: ['wiki/agent-operations/**/*.md'],
        exclude: ['wiki/agent-operations/_index.md'],
      },
    });

    expect(inventory.sources.map(source => source.path)).toEqual([
      'wiki/agent-operations/remote-session-control.md',
      'wiki/agent-operations/worker-dispatch.md',
    ]);
    expect(inventory.sources[0]?.byteLength).toBe('remote'.length);
    expect(inventory.sources[0]?.byteSha256).toBe(sha256Hex(files['wiki/agent-operations/remote-session-control.md']));
    expect(inventory.selectorVersion).toBe('agent-operations-md/v1');
    expect(inventory.exclusions).toEqual(['wiki/agent-operations/_index.md']);
  });

  it('verifies Git-reported byte length and content hash before accepting a source', async () => {
    const files = { 'wiki/agent-operations/a.md': new TextEncoder().encode('actual') };
    const git: GitCommand = {
      run: async args => args[0] === 'ls-tree'
        ? result(`100644 blob ${'0'.repeat(64)}\t99\twiki/agent-operations/a.md\0`)
        : result(files['wiki/agent-operations/a.md']),
    };

    await expect(buildSourceInventory({
      authorityTree: 'b'.repeat(40),
      git,
      selector: { version: 'v1', include: ['wiki/agent-operations/**/*.md'], exclude: [] },
    })).rejects.toThrow(/byte length|hash/i);
  });

  it('binds source identity to path as well as identical bytes', () => {
    const bytes = new TextEncoder().encode('same');
    const byteHash = sha256Hex(bytes);
    expect(sourceIdentityDigest('tree', 'a/b.md', byteHash))
      .not.toBe(sourceIdentityDigest('tree', 'a/c.md', byteHash));
  });
});

describe('headless preflight snapshot/settings inputs', () => {
  it('hashes an order-independent snapshot tree and changes when a byte hash changes', () => {
    const a = [
      { path: 'vault/a.md', byteSha256: 'a'.repeat(64) },
      { path: 'vault/b.md', byteSha256: 'b'.repeat(64) },
    ];
    expect(snapshotTreeHash(a)).toBe(snapshotTreeHash([...a].reverse()));
    expect(snapshotTreeHash(a)).not.toBe(snapshotTreeHash([
      a[0],
      { path: 'vault/b.md', byteSha256: 'c'.repeat(64) },
    ]));
  });

  it('projects safe settings without carrying secret fields and hashes exact full bytes', () => {
    const settings = {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      apiKey: 'must-not-escape',
      nested: { accessToken: 'also-secret', enabled: true },
      pageGenerationConcurrency: 5,
    };
    const projection = projectSafeSettings(settings);
    expect(projection).toEqual({
      model: 'gpt-5.6-luna',
      nested: { enabled: true },
      pageGenerationConcurrency: 5,
      provider: 'openai-codex',
    });

    const fullBytes = new TextEncoder().encode('{"apiKey":"must-not-escape"}');
    const hashes = captureSettingsHashes(fullBytes, projection);
    expect(hashes.fullSettingsSha256).toBe(sha256Hex(fullBytes));
    expect(hashes.safeSettingsProjectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain('must-not-escape');
  });
});

describe('headless preflight copied-vault roots', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spm-preflight-'));
    await mkdir(join(root, 'live'), { recursive: true });
    await mkdir(join(root, 'copy-a'), { recursive: true });
    await mkdir(join(root, 'copy-b'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves roots and refuses live-root overlap and sync-folder paths', async () => {
    const probe: RootProbe = {};
    const safe = await assertSafeCopyRoots({
      liveRoot: join(root, 'live'),
      copyRoots: [join(root, 'copy-a'), join(root, 'copy-b')],
      probe,
      syncRoots: [join(root, 'sync-root')],
    });
    expect(safe.copyRoots).toHaveLength(2);

    await expect(assertSafeCopyRoots({
      liveRoot: join(root, 'live'),
      copyRoots: [join(root, 'live', 'nested')],
      probe,
    })).rejects.toThrow(/live vault/i);

    await expect(assertSafeCopyRoots({
      liveRoot: join(root, 'live'),
      copyRoots: [join(root, 'sync-root', 'copy')],
      probe,
      syncRoots: [join(root, 'sync-root')],
    })).rejects.toThrow(/sync/i);
  });

  it('refuses a symlink/reparse root even when its resolved target is otherwise safe', async () => {
    const link = join(root, 'copy-link');
    await symlink(join(root, 'copy-a'), link, 'junction');
    await expect(assertSafeCopyRoots({
      liveRoot: join(root, 'live'),
      copyRoots: [link],
      probe: {},
    })).rejects.toThrow(/symlink|reparse/i);
  });

  it('preserves component order when resolving a fresh multi-level root', async () => {
    const requested = join(root, 'copies', 'native', 'vault');
    const resolved = await resolveSafeRoot(requested, {});
    expect(resolved.resolved).toBe(requested);

    const aliasTarget = join(root, 'resolved', 'native', 'vault');
    const aliased = await resolveSafeRoot(requested, {
      realpath: path => path === requested ? aliasTarget : path,
    });
    expect(aliased.resolved).toBe(aliasTarget);
  });

  it('fails closed when requested sync/copy paths resolve outside their declared sync root', async () => {
    const syncRoot = join(root, 'declared-sync');
    const copyRoot = join(syncRoot, 'candidate');
    const probe: RootProbe = {
      realpath: path => path === syncRoot
        ? join(root, 'resolved-sync')
        : path === copyRoot
          ? join(root, 'resolved-candidate')
          : path,
    };

    await expect(assertSafeCopyRoots({
      liveRoot: join(root, 'live'),
      copyRoots: [copyRoot],
      syncRoots: [syncRoot],
      probe,
    })).rejects.toThrow(/sync/i);
  });
});

describe('headless preflight freshness', () => {
  it('accepts captures at or under 60 seconds and rejects stale/future captures', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    expect(isFreshPreflight({ capturedAt: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(isFreshPreflight({ capturedAt: new Date(now - 60_001).toISOString() }, now)).toBe(false);
    expect(() => assertFreshPreflight({ capturedAt: new Date(now + 1).toISOString() }, now)).toThrow(/future/i);
  });
});

describe('headless preflight manifest capture', () => {
  it('emits contract-shaped hashes and refuses a non-idle capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spm-preflight-manifest-'));
    try {
      await mkdir(join(root, 'live'), { recursive: true });
      await mkdir(join(root, 'native'), { recursive: true });
      await mkdir(join(root, 'candidate'), { recursive: true });
      const input = {
        captureType: 'initial' as const,
        runId: 'run-1',
        windowId: 'window-1',
        capturedAt: '2026-08-20T12:00:00.000Z',
        vaultIdentity: 'fixture-live',
        liveRoot: join(root, 'live'),
        copyRoots: { native: join(root, 'native'), candidate: join(root, 'candidate') },
        idle: true,
        authorityCommit: 'a'.repeat(40),
        authorityTree: 'b'.repeat(40),
        runtimeSha256: 'c'.repeat(64),
        schemaSha256: 'd'.repeat(64),
        fullSettingsBytes: new TextEncoder().encode('{"apiKey":"fixture-secret"}'),
        settings: { provider: 'fixture', apiKey: 'fixture-secret' },
        snapshotTreeSha256: 'e'.repeat(64),
      };
      const capture = await capturePreflightCapture(input);
      expect(capture.contract_version).toBe('headless-ingest/v1');
      expect(capture.roots_outside_live_and_sync).toBe(true);
      expect(capture.hashes.settings_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(capture)).not.toContain('fixture-secret');
      await expect(capturePreflightCapture({ ...input, idle: false })).rejects.toThrow(/idle/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
