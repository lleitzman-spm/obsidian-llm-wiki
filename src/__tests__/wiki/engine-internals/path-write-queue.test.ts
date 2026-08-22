import { describe, expect, it } from 'vitest';
import { normalizeVaultPath, PathWriteQueue } from '../../../wiki/engine-internals/path-write-queue';

const wait = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

describe('PathWriteQueue', () => {
  it('joins slash, Unicode, and case aliases for an existing vault path', async () => {
    const queue = new PathWriteQueue({ existingPaths: ['wiki/entities/Élan.md'] });
    let active = 0;
    let maxActive = 0;

    const write = (path: string) => queue.run(path, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await wait(5);
      active--;
    });

    await Promise.all([
      write('wiki\\entities\\E\u0301lan.md'),
      write('WIKI/entities/ÉLAN.md'),
    ]);

    expect(maxActive).toBe(1);
    expect(queue.canonicalPath('wiki\\entities\\e\u0301lan.md')).toBe('wiki/entities/Élan.md');
  });

  it('serializes equivalent paths so read-modify-write updates preserve both merges', async () => {
    const queue = new PathWriteQueue();
    const pages = new Map<string, string>();

    const mergeAndWrite = (path: string, addition: string) => queue.run(path, async () => {
      const current = pages.get('wiki/entities/Foo.md') ?? '';
      await wait(5);
      pages.set('wiki/entities/Foo.md', current + addition);
    });

    await Promise.all([
      mergeAndWrite('wiki\\entities\\Foo.md', 'A'),
      mergeAndWrite('wiki/entities/Foo.md', 'B'),
    ]);

    expect(pages.get('wiki/entities/Foo.md')).toBe('AB');
  });

  it('allows different paths to overlap', async () => {
    const queue = new PathWriteQueue();
    let active = 0;
    let maxActive = 0;

    const write = (path: string) => queue.run(path, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await wait(10);
      active--;
    });

    await Promise.all([write('wiki/entities/A.md'), write('wiki/entities/B.md')]);

    expect(maxActive).toBe(2);
  });

  it('acquires multiple paths in sorted order so opposite requests cannot deadlock', async () => {
    const queue = new PathWriteQueue();
    const events: string[] = [];

    const first = queue.run(['wiki/B.md', 'wiki/A.md'], async held => {
      events.push('first-enter');
      await held.runRaw('wiki/A.md', async () => { events.push('first-A'); });
      await wait(2);
      await held.runRaw('wiki/B.md', async () => { events.push('first-B'); });
    });
    const second = queue.run(['wiki/A.md', 'wiki/B.md'], async held => {
      events.push('second-enter');
      await held.runRaw('wiki/B.md', async () => { events.push('second-B'); });
      await held.runRaw('wiki/A.md', async () => { events.push('second-A'); });
    });

    await expect(Promise.race([
      Promise.all([first, second]),
      wait(200).then(() => { throw new Error('multi-path lease deadlocked'); }),
    ])).resolves.toEqual([undefined, undefined]);

    expect(events).toEqual(['first-enter', 'first-A', 'first-B', 'second-enter', 'second-B', 'second-A']);
  });

  it('rejects reentrant raw operations on the same held path', async () => {
    const queue = new PathWriteQueue();

    await queue.run('wiki/A.md', async held => {
      await expect(held.runRaw('wiki/A.md', () =>
        held.runRaw('wiki/A.md', async () => undefined)
      )).rejects.toThrow(/reentrant/i);
    });
  });

  it('locks case, separator, and NFC aliases to one newly-created identity', async () => {
    const queue = new PathWriteQueue();
    const held = await queue.acquire(['wiki\\Cafe\u0301.md', 'WIKI/caf\u00e9.md']);
    expect(held.paths).toEqual(['wiki/Caf\u00e9.md']);
    held.release();
  });

  it('uses one stable existing spelling for case and NFC aliases', () => {
    const queue = new PathWriteQueue({ existingPaths: ['wiki/Caf\u00e9.md'] });
    expect(queue.canonicalPath('WIKI\\CAFE\u0301.MD')).toBe('wiki/Caf\u00e9.md');
  });

  it.each([
    '/absolute.md',
    '\\absolute.md',
    '\\\\server\\share\\file.md',
    'C:/outside.md',
    'C:outside.md',
    'wiki/../outside.md',
    'wiki/./file.md',
    'wiki/file:stream.md',
    'wiki/file\u0000.md',
    'wiki/file.md ',
    'wiki/file.md.',
    'wiki/CON.md',
    'wiki/aux.txt',
    'wiki/LPT1',
  ])('rejects unsafe lease identity %j', path => {
    expect(() => normalizeVaultPath(path)).toThrow();
    expect(() => new PathWriteQueue().canonicalPath(path)).toThrow();
  });

  it('blocks new queue writers across an exclusive mutation boundary', async () => {
    const queue = new PathWriteQueue();
    let releaseBoundary!: () => void;
    let entered!: () => void;
    const boundaryEntered = new Promise<void>(resolve => { entered = resolve; });
    const boundary = queue.withMutationBoundary(['wiki/source.md'], async held => {
      await held.runAny('Notes/links.md', async () => undefined);
      entered();
      await new Promise<void>(resolve => { releaseBoundary = resolve; });
    });
    await boundaryEntered;
    let started = false;
    const writer = queue.run('Notes/new.md', async () => { started = true; });
    await wait(5);
    expect(started).toBe(false);
    releaseBoundary();
    await Promise.all([boundary, writer]);
    expect(started).toBe(true);
  });

  it('keeps disjoint held mutation boundaries globally exclusive and lets the owner use runAny', async () => {
    const queue = new PathWriteQueue();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    let secondEntered!: () => void;
    const firstReady = new Promise<void>(resolve => { firstEntered = resolve; });
    const secondReady = new Promise<void>(resolve => { secondEntered = resolve; });
    const events: string[] = [];
    let activeBoundaries = 0;
    let maxActiveBoundaries = 0;

    const first = queue.withMutationBoundary('wiki/first.md', async held => {
      activeBoundaries++;
      maxActiveBoundaries = Math.max(maxActiveBoundaries, activeBoundaries);
      events.push(`first:${held.paths.join(',')}`);
      // This path is deliberately outside the initially-held set. It must be
      // usable by the boundary owner without entering the global queue.
      await held.runAny('Notes/discovered-by-verification.md', async () => {
        events.push('first-runAny');
      });
      firstEntered();
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      activeBoundaries--;
    });

    await firstReady;
    const second = queue.withMutationBoundary('wiki/second.md', async held => {
      activeBoundaries++;
      maxActiveBoundaries = Math.max(maxActiveBoundaries, activeBoundaries);
      events.push(`second:${held.paths.join(',')}`);
      secondEntered();
      activeBoundaries--;
    });

    await wait(10);
    expect(events).toEqual(['first:wiki/first.md', 'first-runAny']);
    expect(maxActiveBoundaries).toBe(1);
    releaseFirst();
    await Promise.all([first, second, secondReady]);
    expect(events).toEqual([
      'first:wiki/first.md',
      'first-runAny',
      'second:wiki/second.md',
    ]);
    expect(maxActiveBoundaries).toBe(1);
  });

  it('refuses synchronous nested mutation-boundary misuse without poisoning later callers', async () => {
    const queue = new PathWriteQueue();

    await queue.withMutationBoundary('wiki/outer.md', async () => {
      await expect(queue.withMutationBoundary('wiki/inner.md', async () => undefined))
        .rejects.toThrow(/non-reentrant/i);
    });

    await expect(queue.run('wiki/after.md', async () => 'released')).resolves.toBe('released');
  });

  it('rejects an empty lease set without creating an unscoped operation', async () => {
    await expect(new PathWriteQueue().acquire([])).rejects.toThrow(/at least one path/i);
  });

  it('does not strand mutation accounting when a lease path is hostile', async () => {
    const queue = new PathWriteQueue();
    await expect(queue.acquire('../outside.md')).rejects.toThrow();
    await expect(queue.withMutationBoundary('wiki/inside.md', async () => 'ok')).resolves.toBe('ok');
  });
});
