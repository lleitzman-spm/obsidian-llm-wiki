import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureSnapshot,
  compareSnapshots,
  copySnapshot,
  detectSnapshotDrift,
} from '../../../../../tools/llm-wiki-cli/src/headless/copy-snapshot';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; live: string; native: string; candidate: string }> {
  const root = await mkdtemp(join(tmpdir(), 'spm-copy-snapshot-'));
  roots.push(root);
  const live = join(root, 'live');
  const native = join(root, 'native');
  const candidate = join(root, 'candidate');
  await mkdir(join(live, 'wiki', 'nested'), { recursive: true });
  await mkdir(join(live, 'run'), { recursive: true });
  await writeFile(join(live, 'wiki', 'a.md'), 'alpha');
  await writeFile(join(live, 'wiki', 'nested', 'b.md'), 'beta');
  await writeFile(join(live, 'run', 'lease.json'), 'ephemeral');
  return { root, live, native, candidate };
}

describe('copied-vault snapshots', () => {
  it('captures a deterministic path/byte manifest and binds exclusions', async () => {
    const { live } = await fixture();
    const snapshot = await captureSnapshot({ root: live, exclusions: ['run'] });
    expect(snapshot.version).toBe('copied-vault-snapshot/v1');
    expect(snapshot.exclusions).toEqual(['run']);
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ path: 'wiki/a.md', byteLength: 5 }),
      expect.objectContaining({ path: 'wiki/nested/b.md', byteLength: 4 }),
    ]);
    expect(snapshot.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const reversed = await captureSnapshot({ root: live, exclusions: ['run'] });
    expect(reversed.treeSha256).toBe(snapshot.treeSha256);
    expect(reversed.manifestSha256).toBe(snapshot.manifestSha256);
  });

  it('refuses exclusions outside run or lease metadata', async () => {
    const { live } = await fixture();
    await expect(captureSnapshot({ root: live, exclusions: ['wiki'] })).rejects.toThrow(/run\/lease/i);
  });

  it('copies source bytes into both fresh destinations and refuses non-empty destinations', async () => {
    const { live, native, candidate } = await fixture();
    const first = await copySnapshot({ root: live, destinationRoot: native, exclusions: ['run'] });
    expect(first.source.treeSha256).toBe(first.destination.treeSha256);
    const second = await copySnapshot({ root: live, destinationRoot: candidate, exclusions: ['run'] });
    expect(second.destination.entries).toEqual(first.destination.entries);
    await writeFile(join(candidate, 'unexpected.md'), 'do not overwrite');
    await expect(copySnapshot({ root: live, destinationRoot: candidate, exclusions: ['run'] })).rejects.toThrow(/empty/i);
  });

  it('detects added, removed, and changed files after a copy', async () => {
    const { live, native } = await fixture();
    const expected = (await copySnapshot({ root: live, destinationRoot: native, exclusions: ['run'] })).destination;
    await writeFile(join(native, 'wiki', 'a.md'), 'changed');
    await rm(join(native, 'wiki', 'nested', 'b.md'));
    await writeFile(join(native, 'new.md'), 'added');
    const drift = await detectSnapshotDrift(native, expected);
    expect(drift.exact).toBe(false);
    expect(drift.added).toEqual(['new.md']);
    expect(drift.removed).toEqual(['wiki/nested/b.md']);
    expect(drift.changed).toEqual(['wiki/a.md']);
  });

  it('rejects a symlink/reparse point anywhere below source or destination roots', async () => {
    const { live, native } = await fixture();
    await expect(captureSnapshot({ root: live, probe: {
      lstat: async path => {
        const stat = await lstat(path);
        return path.endsWith('wiki\\a.md') ? { ...stat, isReparsePoint: true } : stat;
      },
    } })).rejects.toThrow(/symlink|reparse/i);
    await copySnapshot({ root: live, destinationRoot: native, exclusions: ['run'] });
    await expect(detectSnapshotDrift(native, (await captureSnapshot({ root: live, exclusions: ['run'] })), {
      lstat: async path => {
        const stat = await lstat(path);
        return path.endsWith('wiki\\a.md') ? { ...stat, isReparsePoint: true } : stat;
      },
    })).rejects.toThrow(/symlink|reparse/i);
  });

  it('compares manifests by exact paths and bytes, not only tree hash', async () => {
    const { live } = await fixture();
    const snapshot = await captureSnapshot({ root: live, exclusions: ['run'] });
    const copy = { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry })) };
    expect(compareSnapshots(snapshot, copy).exact).toBe(true);
    expect(compareSnapshots(snapshot, { ...copy, exclusions: [] }).exact).toBe(false);
    copy.entries[0] = { ...copy.entries[0], byteSha256: 'f'.repeat(64) };
    expect(compareSnapshots(snapshot, copy).changed).toHaveLength(1);
  });

  it('does not leave source writes behind', async () => {
    const { live, native } = await fixture();
    const before = await captureSnapshot({ root: live, exclusions: ['run'] });
    await copySnapshot({ root: live, destinationRoot: native, exclusions: ['run'] });
    const after = await captureSnapshot({ root: live, exclusions: ['run'] });
    expect(after).toEqual(before);
  });
});
