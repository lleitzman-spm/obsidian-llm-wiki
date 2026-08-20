import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FilesystemLease,
  LeaseBusyError,
  LeaseFrozenError,
  StaleLeaseError,
} from '../../../../../../tools/llm-wiki-cli/src/headless/lease';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'spm-headless-lease-'));
  roots.push(root);
  return root;
}

async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function visit(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(current, entry.name);
      const metadata = await lstat(target);
      const contents = metadata.isDirectory() ? '' : (await readFile(target)).toString('base64');
      entries.push(`${relative}:${metadata.isDirectory() ? 'directory' : 'file'}:${contents}`);
      if (metadata.isDirectory()) await visit(target, relative);
    }
  }
  await visit(root, '');
  return entries.sort();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('FilesystemLease', () => {
  it('keeps the protected vault tree unchanged when explicit metadata is external', async () => {
    const root = await makeRoot();
    const metadataRoot = await makeRoot();
    await mkdir(join(root, 'notes'), { recursive: true });
    await writeFile(join(root, 'notes', 'source.md'), 'source bytes\n', 'utf8');
    const before = await snapshotTree(root);
    const manager = new FilesystemLease(root, {
      metadataRoot,
      now: () => 1_000,
      ttlMs: 10_000,
    });

    const lease = await manager.acquire({ ownerId: 'worker', runId: 'external-metadata' });
    await lease.heartbeat();
    await lease.release();

    expect(await snapshotTree(root)).toEqual(before);
    expect((await snapshotTree(metadataRoot)).length).toBeGreaterThan(0);
  });

  it('rejects an explicit metadata root that would write inside the protected vault', async () => {
    const root = await makeRoot();
    expect(() => new FilesystemLease(root, { metadataRoot: join(root, 'outside') }))
      .toThrow(/outside the protected lease root/i);
  });

  it('serializes acquisition and carries owner/run identity with a monotonic fence', async () => {
    const root = await makeRoot();
    const manager = new FilesystemLease(root, { now: () => 1_000, ttlMs: 10_000 });

    const first = await manager.acquire({ ownerId: 'worker-a', runId: 'run-a' });
    expect(first.record.ownerId).toBe('worker-a');
    expect(first.record.runId).toBe('run-a');
    expect(first.record.fence).toBe(1);

    await expect(manager.acquire({ ownerId: 'worker-b', runId: 'run-b' }))
      .rejects.toBeInstanceOf(LeaseBusyError);

    await first.release();
    const second = await manager.acquire({ ownerId: 'worker-b', runId: 'run-b' });
    expect(second.record.fence).toBe(2);
    expect(second.record.ownerId).toBe('worker-b');
  });

  it('renews a live lease but refuses heartbeat and writes after expiry', async () => {
    const root = await makeRoot();
    let now = 1_000;
    const manager = new FilesystemLease(root, { now: () => now, ttlMs: 100 });
    const lease = await manager.acquire({ ownerId: 'worker', runId: 'run' });

    now = 1_050;
    const renewed = await lease.heartbeat();
    expect(renewed.expiresAt).toBe(1_150);

    now = 1_151;
    await expect(lease.heartbeat()).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(lease.checkBeforeWrite()).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(lease.checkBeforeFinalCommit()).rejects.toBeInstanceOf(StaleLeaseError);
  });

  it('refuses stale owners after a newer fenced owner takes over', async () => {
    const root = await makeRoot();
    let now = 1_000;
    const manager = new FilesystemLease(root, { now: () => now, ttlMs: 100 });
    const oldLease = await manager.acquire({ ownerId: 'old', runId: 'run-old' });

    now = 1_101;
    const newLease = await manager.acquire({ ownerId: 'new', runId: 'run-new' });
    expect(newLease.record.fence).toBeGreaterThan(oldLease.record.fence);

    await expect(oldLease.checkBeforeWrite()).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(oldLease.release()).rejects.toBeInstanceOf(StaleLeaseError);
    await newLease.checkBeforeFinalCommit();
  });

  it('checks the fence immediately before guarded writes and final commit', async () => {
    const root = await makeRoot();
    const manager = new FilesystemLease(root, { now: () => 1_000, ttlMs: 10_000 });
    const lease = await manager.acquire({ ownerId: 'writer', runId: 'run' });
    const target = join(root, 'output.md');

    await lease.withWriteFence(async () => {
      await writeFile(target, 'candidate\n', 'utf8');
    });
    await lease.withFinalCommit(async () => {
      await writeFile(target, 'committed\n', 'utf8');
    });
    expect(await readFile(target, 'utf8')).toBe('committed\n');
  });

  it('freezes acquisition and rejects current-owner writes until explicitly cleared', async () => {
    const root = await makeRoot();
    const manager = new FilesystemLease(root, { now: () => 1_000, ttlMs: 10_000 });
    const lease = await manager.acquire({ ownerId: 'writer', runId: 'run' });

    await lease.freeze('rollback could not restore the snapshot');
    expect(await manager.isFrozen()).toBe(true);
    await expect(lease.checkBeforeWrite()).rejects.toBeInstanceOf(LeaseFrozenError);
    await expect(manager.acquire({ ownerId: 'other', runId: 'other-run' }))
      .rejects.toBeInstanceOf(LeaseFrozenError);

    await manager.clearFreeze();
    await lease.release();
    const recovered = await manager.acquire({ ownerId: 'recovery', runId: 'recovery-run' });
    expect(recovered.record.fence).toBe(2);
  });

  it('does not let a stale release remove a newer lease record', async () => {
    const root = await makeRoot();
    let now = 1_000;
    const manager = new FilesystemLease(root, { now: () => now, ttlMs: 50 });
    const oldLease = await manager.acquire({ ownerId: 'old', runId: 'old-run' });
    now = 1_051;
    const newLease = await manager.acquire({ ownerId: 'new', runId: 'new-run' });

    await expect(oldLease.release()).rejects.toBeInstanceOf(StaleLeaseError);
    const current = await manager.current();
    expect(current?.fence).toBe(newLease.record.fence);
    expect(current?.ownerId).toBe('new');
  });
});
