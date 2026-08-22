// Issue #386 — retarget every link that points at a page before that page is
// deleted.
//
// `mergeDuplicatePages` merges a duplicate into its target and then deletes the
// duplicate. Every link still pointing at the deleted page is dead from that
// moment on, and the deletion is what makes it unfindable afterwards: no scan
// can report a reference to a file that no longer exists.
//
// The rewrite this replaces looked only inside the wiki folder, and searched
// only for the wiki-relative form (`[[entities/Foo]]`). Measured on a vault
// with 2824 wiki pages and 473 notes outside the wiki: of the links pointing
// from outside into the wiki, 1762 (across 340 notes) were written as a bare
// title `[[Foo]]` and none carried a folder prefix — the bare form is what
// Obsidian's own autocomplete inserts. Widening the radius without widening
// the link form would therefore have changed nothing at all.
//
// Two properties this module is built around:
//
//   * Resolve before replacing. A bare `[[Foo]]` is not evidence that this
//     page is meant: another note named `Foo` elsewhere in the vault owns that
//     link. Every candidate is resolved through the same resolver the app uses
//     (`getFirstLinkpathDest`, which is source-file relative), and only a link
//     that actually lands on the page being deleted is touched. Frontmatter
//     aliases are deliberately NOT consulted, because Obsidian's resolver does
//     not consult them either — a bare link matching only an alias does not
//     resolve today, and pretending otherwise here would rewrite links that
//     were never pointing at this page.
//
//   * Write surgically. Foreign notes are the user's own files. Replacements
//     are applied at the offsets the metadata cache reports, so nothing else
//     in the file is reformatted, and links inside code blocks are left alone
//     because the cache does not report them as links. This is also why the
//     write goes through `vault.process` rather than the wiki's own write gate
//     (`createOrUpdateFile`), which normalizes `sources:` frontmatter and
//     corrects link pollution on every write — appropriate for a generated
//     wiki page, not for someone's own note.
//
// The module is deliberately free of wiki vocabulary (no `wikiFolder`, no page
// types) so the same primitive serves a rename or a redirect feature later.

/** The subset of `TFile` this module needs. */
export interface RetargetFile {
  path: string;
}

/** The subset of `Reference` (link and embed cache entries) this module needs. */
export interface RetargetReference {
  /** Link destination as written, including any `#subpath`. */
  link: string;
  /** The reference exactly as it appears in the document, e.g. `[[a/b|c]]`. */
  original: string;
  position: { start: { offset: number }; end: { offset: number } };
}

/** The subset of `MetadataCache` this module needs. */
export interface RetargetMetadataCache {
  getFileCache(file: RetargetFile): {
    links?: RetargetReference[];
    embeds?: RetargetReference[];
  } | null;
  getFirstLinkpathDest(linkpath: string, sourcePath: string): RetargetFile | null;
}

/**
 * The two event methods used by Obsidian's MetadataCache.  They are kept out
 * of RetargetMetadataCache deliberately: the pure link-resolution tests use a
 * much smaller cache double, while the production App supplies these methods.
 */
interface RetargetMetadataEvents {
  on?: (name: 'changed', callback: (file: RetargetFile, data: string) => unknown) => unknown;
  offref?: (ref: unknown) => void;
}

export interface MetadataMutationWatch {
  snapshot(): number;
  changedSince(epoch: number): boolean;
  close(): void;
}

export function watchMetadataMutations(metadataCache: RetargetMetadataCache): MetadataMutationWatch {
  const events = metadataCache as RetargetMetadataCache & RetargetMetadataEvents;
  let epoch = 0;
  let ref: unknown;
  if (typeof events.on === 'function') ref = events.on('changed', () => { epoch++; });
  return {
    snapshot: () => epoch,
    changedSince: previous => epoch !== previous,
    close: () => { if (ref !== undefined && typeof events.offref === 'function') events.offref(ref); },
  };
}

/** The subset of `Vault` this module needs. */
export interface RetargetVault {
  getMarkdownFiles(): RetargetFile[];
  read(file: RetargetFile): Promise<string>;
  process(file: RetargetFile, fn: (data: string) => string): Promise<string>;
}

export interface RetargetDeps {
  vault: RetargetVault;
  metadataCache: RetargetMetadataCache;
  /** Serialize a note's read/modify/write operation with all other writers. */
  withPathWriteLock?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
  /** Abort the lint operation without changing the error type at the boundary. */
  signal?: AbortSignal;
  /** Test hook; production uses the bounded default below. */
  metadataBarrierTimeoutMs?: number;
}

export interface RetargetResult {
  /** Files whose content was rewritten. */
  filesChanged: number;
  /** Individual references rewritten. */
  linksRewritten: number;
  /**
   * References that resolved to the page but could not be rewritten because
   * the file on disk no longer matched the cached position. Non-zero means
   * those links are about to go dead — the caller should surface it.
   */
  stale: number;
  /** Notes whose changed event did not arrive before the bounded barrier. */
  barrierTimeouts: number;
  /** Files whose current link state could not be proven. */
  unverifiedFiles: number;
  /** Current links that still resolve to the source after rewriting. */
  remainingLinks: number;
}

/** A merge must retain its source when link safety cannot be proven. */
export class RetargetSafetyError extends Error {
  readonly result: RetargetResult;

  constructor(result: RetargetResult) {
    super(
      `Cannot delete duplicate source: ${result.stale} stale retarget(s), ` +
      `${result.barrierTimeouts} metadata barrier timeout(s), ` +
      `${result.unverifiedFiles} unverified file(s), ${result.remainingLinks} remaining link(s)`
    );
    this.name = 'RetargetSafetyError';
    this.result = result;
  }
}

const DEFAULT_METADATA_BARRIER_TIMEOUT_MS = 2_000;

function emptyResult(): RetargetResult {
  return { filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0, unverifiedFiles: 0, remainingLinks: 0 };
}

/**
 * Locks are keyed by vault paths, not by whatever separator or dot segments a
 * caller happened to use. Obsidian paths are case-sensitive, so preserve case
 * while canonicalising separators and `.`/`..` segments.
 */
function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

interface FenceMarker {
  character: '`' | '~';
  length: number;
  suffix: string;
}

function fenceMarker(line: string): FenceMarker | null {
  // CommonMark permits up to three spaces before a fence. Keep the suffix so
  // a closing fence can require the absence of an info string; a line such as
  // ```typescript is an opener, never a closer for an earlier fence.
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { character: match[1][0] as '`' | '~', length: match[1].length, suffix: match[2] };
}

function frontmatterRange(content: string): [number, number] | null {
  // YAML frontmatter is only frontmatter when the document starts with its
  // delimiter. Both `---` and YAML's `...` are valid closing delimiters.
  const opening = content.match(/^\uFEFF?---[ \t]*(?:\r?\n|$)/);
  if (!opening) return null;
  let offset = opening[0].length;
  for (const line of content.slice(offset).split('\n')) {
    const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^ {0,3}(?:---|\.\.\.)[ \t]*$/.test(withoutCr)) {
      return [0, offset + line.length];
    }
    offset += line.length + 1;
  }
  // An unclosed frontmatter block is safer treated as metadata than as live
  // Markdown: deleting its source must never rewrite a YAML value blindly.
  return [0, content.length];
}

function rawReferences(content: string): RetargetReference[] {
  const excludedRanges: Array<[number, number]> = [];
  const codeContextRanges: Array<[number, number]> = [];
  let offset = 0;
  let fenceStart: number | null = null;
  let fenceCharacter: '`' | '~' | '' = '';
  let fenceLength = 0;
  for (const line of content.split('\n')) {
    const marker = fenceMarker(line);
    if (marker && fenceStart === null) {
      fenceStart = offset;
      fenceCharacter = marker.character;
      fenceLength = marker.length;
    } else if (
      marker && fenceStart !== null && marker.character === fenceCharacter &&
      marker.length >= fenceLength && marker.suffix.trim() === ''
    ) {
      const range: [number, number] = [fenceStart, offset + line.length];
      excludedRanges.push(range);
      codeContextRanges.push(range);
      fenceStart = null;
      fenceCharacter = '';
      fenceLength = 0;
    }
    offset += line.length + 1;
  }
  if (fenceStart !== null) {
    const range: [number, number] = [fenceStart, content.length];
    excludedRanges.push(range);
    codeContextRanges.push(range);
  }
  for (const match of content.matchAll(/%%[\s\S]*?(?:%%|$)/g)) {
    const range: [number, number] = [match.index, match.index + match[0].length];
    excludedRanges.push(range);
    codeContextRanges.push(range);
  }
  const frontmatter = frontmatterRange(content);
  if (frontmatter) codeContextRanges.push(frontmatter);

  const boundaries = [...codeContextRanges].sort((a, b) => a[0] - b[0]);
  const ordinaryRanges: Array<[number, number]> = [];
  let ordinaryStart = 0;
  for (const [start, end] of boundaries) {
    if (start > ordinaryStart) ordinaryRanges.push([ordinaryStart, start]);
    ordinaryStart = Math.max(ordinaryStart, end);
  }
  if (ordinaryStart < content.length) ordinaryRanges.push([ordinaryStart, content.length]);

  for (const [regionStart, regionEnd] of ordinaryRanges) {
    const region = content.slice(regionStart, regionEnd);
    const backtickRuns = [...region.matchAll(/`+/g)].map(match => ({
      start: regionStart + match.index,
      end: regionStart + match.index + match[0].length,
      length: match[0].length,
    }));
    for (let i = 0; i < backtickRuns.length;) {
      const opener = backtickRuns[i];
      const closingIndex = backtickRuns.findIndex(
        (candidate, index) => index > i && candidate.length === opener.length
      );
      if (closingIndex < 0) {
        i++;
        continue;
      }
      excludedRanges.push([opener.start, backtickRuns[closingIndex].end]);
      i = closingIndex + 1;
    }
  }
  const references: RetargetReference[] = [];
  const links = /!?\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(links)) {
    if (excludedRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const inner = match[1];
    const pipe = inner.indexOf('|');
    references.push({
      link: pipe >= 0 ? inner.slice(0, pipe) : inner,
      original: match[0],
      position: { start: { offset: match.index }, end: { offset: match.index + match[0].length } },
    });
  }
  return references;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Lint cancelled by user', 'AbortError');
  }
}

interface MetadataBarrier {
  wait: Promise<boolean>;
  cancel: () => void;
}

/**
 * Arm the changed-event barrier before Vault.process starts.  Obsidian's
 * `changed` callback is the point at which the new file data is indexed, so a
 * later retarget operation can safely take its cache snapshot inside the path
 * lock.  A timer is used only as a deadline; it is never used as a guessed
 * propagation delay.
 */
function armMetadataBarrier(
  metadataCache: RetargetMetadataCache,
  file: RetargetFile,
  expectedContent: () => string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): MetadataBarrier {
  const events = metadataCache as RetargetMetadataCache & RetargetMetadataEvents;
  let timer: number | undefined;
  let eventRef: unknown;
  let settled = false;
  let resolveWait!: (refreshed: boolean) => void;
  let rejectWait!: (error: unknown) => void;

  const wait = new Promise<boolean>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const cleanup = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    if (eventRef !== undefined && typeof events.offref === 'function') {
      events.offref(eventRef);
    }
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  const settle = (refreshed: boolean): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveWait(refreshed);
  };

  const onAbort = (): void => {
    if (settled) return;
    // The file write has already started. Cancellation must not turn this
    // barrier into an early rejection that lets the caller race ahead of
    // sibling writes; settle as an unobserved barrier and let the outer
    // operation rethrow AbortError only after every started write is drained.
    settle(false);
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
    return { wait, cancel: () => settle(false) };
  }

  timer = window.setTimeout(() => settle(false), timeoutMs);
  if (typeof events.on !== 'function') {
    // A production MetadataCache always has `on('changed')`.  A missing event
    // surface is therefore a failed safety precondition, not permission to
    // guess with a sleep or to delete the source.
  } else {
    try {
      eventRef = events.on('changed', (changedFile, data) => {
        if (changedFile.path !== file.path || data !== expectedContent()) return;
        settle(true);
      });
    } catch (error) {
      settled = true;
      cleanup();
      rejectWait(error);
    }
  }
  return {
    wait,
    cancel: () => settle(false),
  };
}

/**
 * Every linkpath under which `filePath` is addressable, shortest first:
 * `Foo`, `entities/Foo`, `wiki/entities/Foo`. Which of them actually resolves
 * to this file depends on the linking file and is decided by the resolver.
 */
function addressableForms(filePath: string): string[] {
  const withoutExt = filePath.replace(/\.md$/, '');
  const segments = withoutExt.split('/');
  const forms: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    forms.push(segments.slice(i).join('/'));
  }
  return forms;
}

/**
 * Pick the linkpath to write for a link that lived in `fromFile` and pointed at
 * the page now being replaced by `toPath`.
 *
 * Preference order is *shape first*: a link written with two segments is
 * rewritten with two segments where that resolves. The wiki writes its own
 * internal links folder-prefixed and a user note writes bare titles; a rewrite
 * that silently converted between the two would be a second, unasked-for change
 * to the file. Only when the original's shape does not resolve does this fall
 * back to the shortest form that does, and finally to the full path, which
 * always resolves.
 */
function chooseLinkpath(
  metadataCache: RetargetMetadataCache,
  linkingFilePath: string,
  originalLinkpath: string,
  toPath: string
): string {
  const forms = addressableForms(toPath);
  const resolvesToTarget = (candidate: string): boolean =>
    metadataCache.getFirstLinkpathDest(candidate, linkingFilePath)?.path === toPath;

  const originalDepth = originalLinkpath.split('/').length;
  const sameShape = forms.find(f => f.split('/').length === originalDepth);
  if (sameShape && resolvesToTarget(sameShape)) return sameShape;

  const shortestResolving = forms.find(resolvesToTarget);
  if (shortestResolving) return shortestResolving;

  return forms[forms.length - 1];
}

/**
 * Rewrite every link in the vault that resolves to `fromPath` so it points at
 * `toPath` instead. Call this BEFORE deleting `fromPath` — resolution depends
 * on the file still existing.
 *
 * `fromPath` itself is skipped: its own links are about to disappear with it.
 */
export async function retargetLinksToPage(
  deps: RetargetDeps,
  fromPath: string,
  toPath: string
): Promise<RetargetResult> {
  const result = emptyResult();
  if (fromPath === toPath) return result;

  throwIfAborted(deps.signal);
  const files = deps.vault.getMarkdownFiles().filter(file => file.path !== fromPath);
  // Promise.all would reject on the first cancellation/error and leave sibling
  // Vault.process calls running. Keep every admitted operation alive and
  // inspect the settled outcomes only after the write drain is complete.
  const startedWrites = files.map(async file => {
    const operation = async (): Promise<Pick<RetargetResult, 'filesChanged' | 'linksRewritten' | 'stale' | 'barrierTimeouts'>> => {
      throwIfAborted(deps.signal);

      // This snapshot MUST be taken after acquiring the path lock. A lint run
      // can retarget the same note for several duplicate merges at once; a
      // snapshot taken before the lock has offsets for a version that another
      // worker may already have rewritten.
      const cache = deps.metadataCache.getFileCache(file);
      if (cache === null) {
        return { filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0 };
      }
      const currentContent = await deps.vault.read(file);
      const referencesByOffset = new Map<number, RetargetReference>();
      for (const reference of [...(cache.links ?? []), ...(cache.embeds ?? []), ...rawReferences(currentContent)]) {
        referencesByOffset.set(reference.position.start.offset, reference);
      }
      const references = [...referencesByOffset.values()];
      if (references.length === 0) {
        return { filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0 };
      }

      const edits: Array<{ start: number; end: number; original: string; replacement: string }> = [];
      for (const ref of references) {
        const hashIndex = ref.link.indexOf('#');
        const linkpath = hashIndex >= 0 ? ref.link.slice(0, hashIndex) : ref.link;
        const subpath = hashIndex >= 0 ? ref.link.slice(hashIndex) : '';
        // `[[#Heading]]` addresses the current file and has no linkpath.
        if (!linkpath) continue;

        const dest = deps.metadataCache.getFirstLinkpathDest(linkpath, file.path);
        if (!dest || dest.path !== fromPath) continue;

        const newLinkpath = chooseLinkpath(deps.metadataCache, file.path, linkpath, toPath);
        // Rebuild from `original` so display text (`|…`), the embed marker (`!`)
        // and the subpath survive verbatim; only the destination changes.
        const replacement = ref.original.replace(`[[${ref.link}`, `[[${newLinkpath}${subpath}`);
        if (replacement === ref.original) continue;

        edits.push({
          start: ref.position.start.offset,
          end: ref.position.end.offset,
          original: ref.original,
          replacement,
        });
      }
      if (edits.length === 0) {
        return { filesChanged: 0, linksRewritten: 0, stale: 0, barrierTimeouts: 0 };
      }

      let applied = 0;
      let stale = 0;
      let expectedContent: string | undefined;
      const barrier = armMetadataBarrier(
        deps.metadataCache,
        file,
        () => expectedContent,
        deps.metadataBarrierTimeoutMs ?? DEFAULT_METADATA_BARRIER_TIMEOUT_MS,
        deps.signal,
      );

      try {
        await deps.vault.process(file, data => {
          let next = data;
          // Descending, so an earlier edit's offsets stay valid even when a
          // replacement is shorter or longer than the original link.
          for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
            // The cache can lag the file. Splicing on a stale offset would
            // corrupt the note, so a position that no longer holds what the
            // cache promised is reported instead of guessed at.
            if (next.slice(edit.start, edit.end) !== edit.original) {
              stale++;
              continue;
            }
            next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
            applied++;
          }
          expectedContent = next;
          return next;
        });

        if (applied === 0) {
          barrier.cancel();
          return { filesChanged: 0, linksRewritten: 0, stale, barrierTimeouts: 0 };
        }

        // Abort is observed by the outer coordinator after every admitted
        // operation settles. Do not reject here: the write already happened
        // and sibling writes must be drained before the destructive boundary.
        const refreshed = await barrier.wait;
        return {
          filesChanged: 1,
          linksRewritten: applied,
          stale,
          barrierTimeouts: refreshed ? 0 : 1,
        };
      } catch (error) {
        // Keep AbortError and Vault errors intact for the lint controller. The
        // caller must see the original type rather than a generic merge error.
        barrier.cancel();
        throw error;
      }
    };

    if (deps.withPathWriteLock) {
      return deps.withPathWriteLock(canonicalPath(file.path), operation);
    }
    return operation();
  });

  const settledWrites = await Promise.allSettled(startedWrites);
  let firstError: unknown;
  let hasError = false;
  for (const settled of settledWrites) {
    if (settled.status === 'rejected' && !hasError) {
      hasError = true;
      firstError = settled.reason;
    }
  }
  throwIfAborted(deps.signal);
  if (hasError) throw firstError;

  for (const settled of settledWrites) {
    if (settled.status !== 'fulfilled') continue;
    const fileResult = settled.value;
    result.filesChanged += fileResult.filesChanged;
    result.linksRewritten += fileResult.linksRewritten;
    result.stale += fileResult.stale;
    result.barrierTimeouts += fileResult.barrierTimeouts;
  }

  const verification = await verifyNoLinksToPage(deps, fromPath);
  result.unverifiedFiles = verification.unverifiedFiles;
  result.remainingLinks = verification.remainingLinks;

  return result;
}

/** Read current note content under the write lock and prove no live link resolves to fromPath. */
export async function verifyNoLinksToPage(
  deps: RetargetDeps,
  fromPath: string,
): Promise<Pick<RetargetResult, 'unverifiedFiles' | 'remainingLinks'>> {
  const totals = { unverifiedFiles: 0, remainingLinks: 0 };
  const files = deps.vault.getMarkdownFiles().filter(file => file.path !== fromPath);
  const results = await Promise.all(files.map(async file => {
    const operation = async (): Promise<typeof totals> => {
      throwIfAborted(deps.signal);
      if (deps.metadataCache.getFileCache(file) === null) {
        return { unverifiedFiles: 1, remainingLinks: 0 };
      }
      const content = await deps.vault.read(file);
      let remainingLinks = 0;
      for (const reference of rawReferences(content)) {
        const linkpath = reference.link.split('#', 1)[0];
        if (!linkpath) continue;
        if (deps.metadataCache.getFirstLinkpathDest(linkpath, file.path)?.path === fromPath) {
          remainingLinks++;
        }
      }
      return { unverifiedFiles: 0, remainingLinks };
    };
    return deps.withPathWriteLock ? deps.withPathWriteLock(canonicalPath(file.path), operation) : operation();
  }));
  for (const result of results) {
    totals.unverifiedFiles += result.unverifiedFiles;
    totals.remainingLinks += result.remainingLinks;
  }
  return totals;
}
