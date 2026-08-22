// A vault fake with the two things `src/core/link-retarget.ts` depends on and
// the production mock context does not model: a link cache with positions, and
// a linkpath resolver.
//
// The resolver deliberately mirrors Obsidian's own behaviour, because the
// safeguard under test ("only rewrite links that actually resolve to the page
// being deleted") is only meaningful against a realistic resolver:
//
//   * a linkpath may be a full path, a partial path, or a bare basename
//   * frontmatter aliases are NOT consulted — Obsidian's resolver reads its
//     file lookup, not aliases, so a bare link matching only an alias does not
//     resolve
//   * when several files match, the one in the linking file's own folder wins,
//     then the shortest path
//
// Links inside fenced code blocks are not reported, which is also what the real
// metadata cache does — a quoted `[[Foo]]` in documentation is not a link.

export interface FakeReference {
  link: string;
  original: string;
  position: { start: { offset: number }; end: { offset: number } };
}

export interface FakeLinkVault {
  vault: {
    getMarkdownFiles(): Array<{ path: string }>;
    read(file: { path: string }): Promise<string>;
    process(file: { path: string }, fn: (data: string) => string): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: { path: string }): { links?: FakeReference[]; embeds?: FakeReference[] } | null;
    getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null;
    on(event: 'changed', callback: (file: { path: string }, data: string) => unknown): unknown;
    offref(ref: unknown): void;
  };
  withPathWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
  read(path: string): string;
  write(path: string, content: string): void;
  remove(path: string): void;
  /** Paths whose content was handed to `vault.process`, in call order. */
  processed: string[];
}

const FENCE = /^\s*(```|~~~)/;

function fencedLineRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let openedAt: number | null = null;
  for (const line of content.split('\n')) {
    if (FENCE.test(line)) {
      if (openedAt === null) openedAt = offset;
      else {
        ranges.push([openedAt, offset + line.length]);
        openedAt = null;
      }
    }
    offset += line.length + 1;
  }
  if (openedAt !== null) ranges.push([openedAt, content.length]);
  return ranges;
}

function scanReferences(content: string): { links: FakeReference[]; embeds: FakeReference[] } {
  const fenced = fencedLineRanges(content);
  const inFence = (offset: number): boolean =>
    fenced.some(([start, end]) => offset >= start && offset < end);

  const links: FakeReference[] = [];
  const embeds: FakeReference[] = [];
  const pattern = /(!?)\[\[([^\][]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (inFence(match.index)) continue;
    const inner = match[2];
    const pipe = inner.indexOf('|');
    const link = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const reference: FakeReference = {
      link,
      original: match[0],
      position: {
        start: { offset: match.index },
        end: { offset: match.index + match[0].length },
      },
    };
    (match[1] === '!' ? embeds : links).push(reference);
  }
  return { links, embeds };
}

export function createFakeLinkVault(initial: Record<string, string>): FakeLinkVault {
  const files = new Map<string, string>(Object.entries(initial));
  const processed: string[] = [];
  const changedListeners = new Set<(file: { path: string }, data: string) => unknown>();
  const writeTails = new Map<string, Promise<void>>();

  const resolve = (linkpath: string, sourcePath: string): { path: string } | null => {
    const wanted = linkpath.replace(/\.md$/, '');
    const sourceFolder = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
    const matches = [...files.keys()].filter(path => {
      const withoutExt = path.replace(/\.md$/, '');
      if (withoutExt === wanted) return true;
      if (withoutExt.endsWith(`/${wanted}`)) return true;
      return false;
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const exact = (p: string): number => (p.replace(/\.md$/, '') === wanted ? 0 : 1);
      if (exact(a) !== exact(b)) return exact(a) - exact(b);
      const local = (p: string): number => (p.startsWith(sourceFolder) ? 0 : 1);
      if (local(a) !== local(b)) return local(a) - local(b);
      if (a.length !== b.length) return a.length - b.length;
      return a.localeCompare(b);
    });
    return { path: matches[0] };
  };

  return {
    vault: {
      getMarkdownFiles: () => [...files.keys()].map(path => ({ path })),
      read: async file => files.get(file.path) ?? '',
      process: async (file, fn) => {
        processed.push(file.path);
        const next = fn(files.get(file.path) ?? '');
        files.set(file.path, next);
        for (const listener of [...changedListeners]) {
          listener(file, next);
        }
        return next;
      },
    },
    metadataCache: {
      getFileCache: file => {
        const content = files.get(file.path);
        if (content === undefined) return null;
        return scanReferences(content);
      },
      getFirstLinkpathDest: resolve,
      on: (_event, callback) => {
        changedListeners.add(callback);
        return callback;
      },
      offref: ref => {
        if (typeof ref === 'function') {
          changedListeners.delete(ref as (file: { path: string }, data: string) => unknown);
        }
      },
    },
    withPathWriteLock: <T>(path: string, operation: () => Promise<T>): Promise<T> => {
      const key = path.replace(/\\/g, '/');
      const previous = writeTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>(resolveRelease => { release = resolveRelease; });
      const tail = previous.then(() => current);
      writeTails.set(key, tail);
      return previous.then(operation).finally(() => {
        release();
        if (writeTails.get(key) === tail) writeTails.delete(key);
      });
    },
    read: path => files.get(path) ?? '',
    write: (path, content) => { files.set(path, content); },
    remove: path => { files.delete(path); },
    processed,
  };
}
