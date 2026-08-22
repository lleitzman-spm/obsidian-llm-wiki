import { EngineContext } from '../../types';
import { PROMPTS } from '../../prompts';
import { TOKENS_LINT_PAGE_FIX, WIKI_SUBFOLDERS } from '../../constants';
import { buildSystemPrompt } from '../system-prompts';
import { parseFrontmatter, enforceFrontmatterConstraints, serializeFrontmatter } from '../../core/frontmatter';
import { parseJsonResponse } from '../../core/json';
import { reassertH1 } from '../../core/section-header-canonicalizer';
import { cleanMarkdownResponse } from '../../core/markdown';
import { renderTemplate } from '../../core/template-renderer';
import { resolveModelForTask } from '../../core/model-resolver';
import { RetargetSafetyError, retargetLinksToPage, type RetargetResult } from '../../core/link-retarget';
import { normalizeVaultPath, type PathWriteLease } from '../engine-internals/path-write-queue';

type MergeJournalStatus = 'planned' | 'partial' | 'retargeted' | 'committed';

interface MergeJournalEntry {
  id: string;
  targetPath: string;
  sourcePath: string;
  targetHash: string;
  sourceHash: string;
  mergedTargetHash?: string;
  status: MergeJournalStatus;
  retarget?: RetargetResult;
  updatedAt: string;
}

/** Raised when a resumable merge no longer describes the files on disk. */
export class MergePlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergePlanConflictError';
  }
}

interface MergeJournalStore {
  load(): Promise<MergeJournalEntry[]>;
  save(entries: MergeJournalEntry[]): Promise<void>;
}

const MERGE_JOURNAL_FILE = '.karpathywiki-merge-journal.json';
const journalTails = new Map<string, Promise<void>>();

interface JournalAdapter {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<string>;
  write?: (path: string, content: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  /** Obsidian DataAdapter mkdir is an exclusive directory create. */
  mkdir?: (path: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
}

type JournalLeaseAdapter = JournalAdapter & Required<Pick<JournalAdapter, 'mkdir' | 'read' | 'write' | 'remove'>>;

function hasJournalLeaseAdapter(adapter: JournalAdapter | undefined): adapter is JournalLeaseAdapter {
  return Boolean(adapter?.mkdir && adapter.read && adapter.write && adapter.remove);
}

const JOURNAL_LOCK_STALE_MS = 10 * 60 * 1000;
const JOURNAL_LOCK_HEARTBEAT_MS = 2_000;
const JOURNAL_LOCK_RETRY_MS = 25;
const JOURNAL_LOCK_ATTEMPTS = 240;

interface JournalLeaseRecord {
  version: 1;
  token: string;
  createdAt: number;
  heartbeatAt: number;
}

interface JournalFileLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const noJournalFileLease: JournalFileLease = {
  assertOwned: async () => undefined,
  release: async () => undefined,
};

function journalLeaseToken(): string {
  // Do not use `:` here: the token is also embedded in a vault-relative
  // recovery path and Windows treats a colon as an alternate data stream.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function parseJournalLease(raw: string): JournalLeaseRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const lease = value as Partial<JournalLeaseRecord>;
    return lease.version === 1 && typeof lease.token === 'string' && lease.token.length > 0 &&
      Number.isFinite(lease.createdAt) && Number.isFinite(lease.heartbeatAt)
      ? lease as JournalLeaseRecord
      : null;
  } catch {
    return null;
  }
}

function journalLeaseError(path: string): Error {
  return new Error(`Merge journal lease ownership was lost: ${path}`);
}

/** @internal Exported for direct lease-race tests; callers should use mergeDuplicatePages. */
export async function acquireJournalFileLock(ctx: EngineContext, rawPath: string): Promise<JournalFileLease> {
  // Validate before even looking up the adapter. Settings are user-controlled,
  // and an unsafe wiki folder must never reach an adapter path operation.
  const path = normalizeVaultPath(rawPath);
  const adapter = (ctx.app.vault as unknown as { adapter?: JournalAdapter }).adapter;
  // mkdir is the only portable exclusive primitive exposed by Obsidian's
  // DataAdapter. A legacy test double without it cannot provide a cross-process
  // lease; the in-process journal tail still serializes those callers.
  if (!hasJournalLeaseAdapter(adapter)) return noJournalFileLease;

  const lockPath = normalizeVaultPath(`${path}.lock`);
  const leasePath = normalizeVaultPath(`${lockPath}/lease.json`);
  const token = journalLeaseToken();
  const record: JournalLeaseRecord = { version: 1, token, createdAt: Date.now(), heartbeatAt: Date.now() };
  let lost: Error | undefined;
  let heartbeatId: number | undefined;

  const readOwner = async (): Promise<JournalLeaseRecord> => {
    const current = parseJournalLease(await adapter.read(leasePath));
    if (!current) throw journalLeaseError(path);
    return current;
  };
  const assertOwned = async (): Promise<void> => {
    if (lost) throw lost;
    const current = await readOwner();
    if (current.token !== token) {
      lost = journalLeaseError(path);
      throw lost;
    }
  };
  const stopHeartbeat = (): void => {
    if (heartbeatId !== undefined) {
      window.clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
  };
  const startHeartbeat = (): void => {
    heartbeatId = window.setInterval(() => {
      void (async () => {
        try {
          await assertOwned();
          await adapter.write(leasePath, JSON.stringify({ ...record, heartbeatAt: Date.now() }));
        } catch (error) {
          lost = error instanceof Error ? error : journalLeaseError(path);
          stopHeartbeat();
        }
      })();
    }, JOURNAL_LOCK_HEARTBEAT_MS);
  };

  for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt++) {
    let acquiredDirectory = false;
    try {
      // Atomic exclusive acquisition. Two workers cannot both mkdir the same
      // lock directory; neither can overwrite an incumbent lease record.
      await adapter.mkdir(lockPath);
      acquiredDirectory = true;
      await adapter.write(leasePath, JSON.stringify(record));
      startHeartbeat();
      return {
        assertOwned,
        release: async () => {
          stopHeartbeat();
          if (lost) return;
          try {
            await assertOwned();
            await adapter.remove(lockPath);
          } catch (error) {
            // Release is best-effort after a completed merge. Never remove a
            // lock whose token we can no longer prove belongs to us.
            if (!(error instanceof Error) || !/ownership was lost/i.test(error.message)) throw error;
          }
        },
      };
    } catch {
      if (acquiredDirectory) {
        // The lease metadata write failed after our exclusive mkdir. Do not
        // strand an unowned directory that would otherwise look stale.
        await adapter.remove(lockPath).catch(() => undefined);
        throw new Error(`Unable to initialize merge journal lease: ${path}`);
      }
      // The lock may be an incumbent, a malformed abandoned lease, or a
      // filesystem race. Recovery is deliberately rename-based: never remove
      // an incumbent in place, and only quarantine a lease that stayed stale.
      if (await adapter.exists?.(lockPath)) {
        try {
          const existing = parseJournalLease(await adapter.read(leasePath));
          if (existing && Date.now() - existing.heartbeatAt > JOURNAL_LOCK_STALE_MS) {
            const recoveryPath = normalizeVaultPath(`${lockPath}.recovery-${token}`);
            try {
              await adapter.rename?.(lockPath, recoveryPath);
              const recovered = parseJournalLease(await adapter.read(normalizeVaultPath(`${recoveryPath}/lease.json`)));
              // A recovery rename is the ownership handoff. Verify the
              // quarantined token and heartbeat before deleting it. If the
              // incumbent heartbeated after our first read, restore its lease
              // instead of stealing an active merge.
              if (recovered?.token === existing.token &&
                recovered.heartbeatAt === existing.heartbeatAt &&
                Date.now() - recovered.heartbeatAt > JOURNAL_LOCK_STALE_MS) {
                await adapter.remove(recoveryPath);
              } else if (recovered) {
                await adapter.rename?.(recoveryPath, lockPath);
              }
            } catch {
              // Another worker is acquiring/recovering. Retry without
              // touching either worker's lock.
            }
          }
        } catch {
          // A partially-created lease is not safe to steal immediately. The
          // next iteration can observe a complete stale record and quarantine
          // it with the same ownership checks.
        }
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, JOURNAL_LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out acquiring merge journal lock: ${path}`);
}

async function withJournalProcessLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const previous = journalTails.get(path) ?? Promise.resolve();
  const tail = previous.then(() => gate);
  journalTails.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (journalTails.get(path) === tail) journalTails.delete(path);
  }
}

function mergeJournalPath(ctx: EngineContext): string {
  const wikiFolder = normalizeVaultPath(ctx.settings.wikiFolder);
  return normalizeVaultPath(`${wikiFolder}/${MERGE_JOURNAL_FILE}`);
}

/**
 * Keep the merge plan in the vault, alongside the wiki log. The adapter is
 * intentionally optional for small unit-test doubles; production Obsidian
 * always supplies it. A malformed journal is a safety failure, not an empty
 * journal, because silently discarding a partial plan could delete a source.
 */
function getMergeJournalStore(ctx: EngineContext): MergeJournalStore | null {
  // Validate settings before touching the adapter. This is intentionally
  // duplicated at this boundary because journal access is also called by
  // resumptions that may bypass the top-level merge wrapper.
  const path = mergeJournalPath(ctx);
  const adapter = (ctx.app.vault as unknown as { adapter?: JournalAdapter }).adapter;
  if (!adapter?.exists || !adapter.read || !adapter.write || !adapter.rename || !adapter.remove) return null;
  return {
    async load() {
      if (!await adapter.exists!(path)) return [];
      const raw = await adapter.read!(path);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some(entry => {
        if (!entry || typeof entry !== 'object') return true;
        const value = entry as Partial<MergeJournalEntry>;
        if (typeof value.id !== 'string' || typeof value.targetPath !== 'string' ||
          typeof value.sourcePath !== 'string' || typeof value.targetHash !== 'string' ||
          typeof value.sourceHash !== 'string' || typeof value.status !== 'string' ||
          !['planned', 'partial', 'retargeted', 'committed'].includes(value.status) ||
          typeof value.updatedAt !== 'string' || value.targetHash.length === 0 || value.sourceHash.length === 0) return true;
        try {
          return value.id !== mergePlanId(value.targetPath, value.sourcePath);
        } catch {
          return true;
        }
      })) throw new Error(`Invalid merge journal at ${path}`);
      return parsed as MergeJournalEntry[];
    },
    async save(entries) {
      const content = JSON.stringify(entries, null, 2) + '\n';
      // Obsidian's adapter rename is atomic within a vault. Never expose a
      // partially-written journal to a second merge worker.
      const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await adapter.write!(tempPath, content);
      try {
        await adapter.rename!(tempPath, path);
      } catch (error) {
        if (adapter.remove) await adapter.remove(tempPath).catch(() => undefined);
        throw error;
      }
      const persisted = await adapter.read!(path);
      const persistedEntries: unknown = JSON.parse(persisted);
      if (!Array.isArray(persistedEntries)) {
        throw new Error(`Merge journal readback was malformed at ${path}`);
      }
      if (JSON.stringify(persistedEntries) !== JSON.stringify(entries)) {
        throw new Error(`Merge journal readback did not match the committed write at ${path}`);
      }
    },
  };
}

function mergePlanId(targetPath: string, sourcePath: string): string {
  return `${normalizeVaultPath(targetPath)}\u0000${normalizeVaultPath(sourcePath)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Stable content hash; use injected SubtleCrypto when available. */
async function contentHash(content: string, subtle?: SubtleCrypto): Promise<string> {
  if (subtle) {
    const bytes = new TextEncoder().encode(content);
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // Test doubles do not expose Obsidian's activeWindow.crypto. This fallback
  // remains content-sensitive and deterministic; production uses SHA-256.
  let first = 2166136261;
  let second = 16777619;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + i), 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Lint cancelled by user', 'AbortError');
}

function retargetIsSafe(result: RetargetResult): boolean {
  return result.stale === 0 && result.barrierTimeouts === 0 &&
    result.unverifiedFiles === 0 && result.remainingLinks === 0;
}

function retargetLock(
  ctx: EngineContext,
  held: PathWriteLease | undefined,
  lockedPaths: ReadonlySet<string>,
): <T>(path: string, operation: () => Promise<T>) => Promise<T> {
  return <T>(path: string, operation: () => Promise<T>) => {
    const normalized = normalizeVaultPath(path);
    if ([...lockedPaths].some(locked => normalizeVaultPath(locked) === normalized)) {
      // In the legacy fallback the target/source leases are the two nested
      // outer calls above, so re-entering either would deadlock. In the
      // canonical multi-path path, runHeld is the queue's reentrancy-safe API.
      return held ? held.runHeld(path, operation) : operation();
    }
    // A mutation boundary drains the queue before verification and keeps new
    // writers out until deletion. Retarget may discover paths beyond the
    // initial target/source/journal set; run them through that same boundary.
    if (held?.runAny) return held.runAny(path, operation);
    return ctx.withPathWriteLock ? ctx.withPathWriteLock(path, operation) : operation();
  };
}

export async function mergeDuplicatePages(
  ctx: EngineContext,
  targetPath: string,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string> {
  // Validate all caller/settings paths before constructing an adapter lease.
  // In particular, `wikiFolder: '../outside'` must fail before a journal lock
  // or any adapter.exists/read/write call can occur.
  const wikiFolder = normalizeVaultPath(ctx.settings.wikiFolder);
  const safeTargetPath = normalizeVaultPath(targetPath);
  const safeSourcePath = normalizeVaultPath(sourcePath);
  const journalPath = normalizeVaultPath(`${wikiFolder}/${MERGE_JOURNAL_FILE}`);
  const isWithinWiki = (path: string): boolean => path === wikiFolder || path.startsWith(`${wikiFolder}/`);
  if (!isWithinWiki(safeTargetPath) || !isWithinWiki(safeSourcePath)) {
    throw new Error(`Merge paths must stay within the configured wiki folder: ${wikiFolder}`);
  }
  const lockedPaths = new Set([safeTargetPath, safeSourcePath, journalPath]);
  const run = (held: PathWriteLease | undefined, journalLease: JournalFileLease): Promise<string> =>
    mergeDuplicatePagesLocked(ctx, safeTargetPath, safeSourcePath, signal, held, lockedPaths, journalLease);

  const execute = (journalLease: JournalFileLease): Promise<string> => {
    if (ctx.withMutationBoundary) {
      return ctx.withMutationBoundary([...lockedPaths], held => run(held, journalLease));
    }
    // Acquire target/source together in canonical order. The journal shares
    // the same lease so concurrent lint workers cannot overwrite one another's
    // resumable state.
    if (ctx.withPathWriteLocks) {
      return ctx.withPathWriteLocks([...lockedPaths], held => run(held, journalLease));
    }
    if (ctx.withPathWriteLock) {
      return ctx.withPathWriteLock(safeTargetPath, () =>
        ctx.withPathWriteLock(safeSourcePath, () => run(undefined, journalLease))
      );
    }
    return run(undefined, journalLease);
  };
  const journalLease = await acquireJournalFileLock(ctx, journalPath);
  try {
    return await withJournalProcessLock(journalPath, () => execute(journalLease));
  } finally {
    await journalLease.release();
  }
}

async function mergeDuplicatePagesLocked(
  ctx: EngineContext,
  targetPath: string,
  sourcePath: string,
  signal: AbortSignal | undefined,
  held: PathWriteLease | undefined,
  lockedPaths: ReadonlySet<string>,
  journalLease: JournalFileLease,
): Promise<string> {
  checkCancelled(signal);
  await journalLease.assertOwned();
  const wikiFolder = ctx.settings.wikiFolder;
  const sourceRel = sourcePath.replace(wikiFolder + '/', '').replace('.md', '');
  const targetRel = targetPath.replace(wikiFolder + '/', '').replace('.md', '');
  const journal = getMergeJournalStore(ctx);
  if (ctx.withMutationBoundary && !journal) {
    throw new Error('Cannot merge destructively: durable merge journal is unavailable');
  }
  const journalEntries = journal ? await journal.load() : [];
  const planId = mergePlanId(targetPath, sourcePath);
  const priorPlan = journalEntries.find(entry => entry.id === planId);
  const targetContent = await ctx.tryReadFile(targetPath);
  const sourceContent = await ctx.tryReadFile(sourcePath);
  if (!targetContent || !sourceContent) {
    // A committed plan is the durable proof that deletion already happened;
    // make a retry idempotent instead of attempting a second destructive step.
    if (priorPlan?.status === 'committed' && !sourceContent && targetContent) {
      const currentTargetHash = await contentHash(targetContent, ctx.subtle);
      if (priorPlan.mergedTargetHash && currentTargetHash !== priorPlan.mergedTargetHash) {
        throw new MergePlanConflictError(`Committed target changed since merge plan ${planId}; refusing resume`);
      }
      return `merged ${sourceRel} → ${targetRel} (already committed)`;
    }
    throw new Error(`Cannot merge: target or source page not found (target=${targetPath}, source=${sourcePath})`);
  }

  const targetHash = await contentHash(targetContent, ctx.subtle);
  const sourceHash = await contentHash(sourceContent, ctx.subtle);
  if (priorPlan?.status === 'committed') {
    throw new MergePlanConflictError(
      `Merge plan ${planId} is committed but its source still exists; refusing to delete a recreated source`
    );
  }
  if (priorPlan) {
    if (priorPlan.sourceHash !== sourceHash) {
      throw new MergePlanConflictError(`Source changed since merge plan ${planId} was created; refusing resume`);
    }
    const expectedTargetHash = priorPlan.status === 'planned'
      ? priorPlan.targetHash
      : priorPlan.mergedTargetHash ?? priorPlan.targetHash;
    if (targetHash !== expectedTargetHash) {
      throw new MergePlanConflictError(`Target changed since merge plan ${planId} was written; refusing resume`);
    }
  }

  let plan = priorPlan;
  if (journal && !plan) {
    await journalLease.assertOwned();
    plan = {
      id: planId,
      targetPath,
      sourcePath,
      targetHash,
      sourceHash,
      status: 'planned',
      updatedAt: nowIso(),
    };
    await journal.save([...journalEntries, plan]);
  }
  const resumeExisting = Boolean(plan && plan.status !== 'planned');

  const sourceFm = parseFrontmatter(sourceContent);
  const targetFm = parseFrontmatter(targetContent);
  const sourceTitle = sourcePath.split('/').pop()?.replace('.md', '') || '';

  const targetSources = Array.isArray(targetFm?.sources) ? targetFm.sources : [];
  const sourceSources = Array.isArray(sourceFm?.sources) ? sourceFm.sources : [];
  const mergedSourcesSet = new Set<string>();
  const mergedSourcesList: string[] = [];
  for (const s of [...targetSources, ...sourceSources]) {
    const key = s.trim().toLowerCase();
    if (!mergedSourcesSet.has(key)) {
      mergedSourcesSet.add(key);
      mergedSourcesList.push(s);
    }
  }

  const targetAliases = Array.isArray(targetFm?.aliases) ? targetFm.aliases : [];
  const sourceAliases = Array.isArray(sourceFm?.aliases) ? sourceFm.aliases : [];

  const extractH1 = (content: string): string | null => {
    const bodyMatch = content.match(/^---[\s\S]*?\n---\n?([\s\S]*)/);
    if (!bodyMatch) return null;
    const h1Match = bodyMatch[1].trim().match(/^#\s+(.+?)(?:\n|$)/);
    return h1Match ? h1Match[1].trim() : null;
  };
  const sourceH1 = extractH1(sourceContent);
  const targetH1 = extractH1(targetContent);

  const allAliases = [...targetAliases, sourceTitle, ...sourceAliases];
  if (sourceH1 && sourceH1 !== sourceTitle) {
    allAliases.push(sourceH1);
  }
  const targetFilename = targetPath.split('/').pop()?.replace('.md', '') || '';
  if (targetH1 && targetH1 !== targetFilename && !targetAliases.includes(targetH1)) {
    allAliases.unshift(targetH1);
  }

  const wikiSubfolders = [WIKI_SUBFOLDERS.entities, WIKI_SUBFOLDERS.concepts, WIKI_SUBFOLDERS.sources];
  const cleanAliases = allAliases.filter(a => {
    if (!a) return false;
    for (const folder of wikiSubfolders) {
      if (a.startsWith(folder) && a.length > folder.length) return false;
    }
    return true;
  });

  const targetTitle = targetFm?.title as string || targetFilename;
  let dedupedAliases = cleanAliases.filter((a, i) =>
    a && a !== targetTitle && cleanAliases.indexOf(a) === i
  );

  const targetBodyMatch = targetContent.match(/^---[\s\S]*?\n---\n?([\s\S]*)/);
  const sourceBodyMatch = sourceContent.match(/^---[\s\S]*?\n---\n?([\s\S]*)/);
  const targetBody = targetBodyMatch ? targetBodyMatch[1].trim() : targetContent;
  const sourceBody = sourceBodyMatch ? sourceBodyMatch[1].trim() : sourceContent;

  const client = ctx.getClient();
  let mergedBody = '';
  let llmMergeSucceeded = false;
  if (!resumeExisting && client) {
    try {
      const prompt = renderTemplate(PROMPTS.mergeDuplicatePages, {
        target_content: targetBody,
        source_content: sourceBody,
      });

      const mergedContent = await client.createMessage({
        model: resolveModelForTask(ctx.settings, 'lint'),
        max_tokens: TOKENS_LINT_PAGE_FIX,
        system: await buildSystemPrompt(
          ctx.settings,
          ctx.getSchemaContext,
          'merge'
        ),
        messages: [{ role: 'user', content: prompt }],
        ...(ctx.settings.disableThinking ? { enableThinking: false } : {}),
      });

      const cleaned = cleanMarkdownResponse(mergedContent);
      if (cleaned && cleaned.length > 100) {
        let parsed: { body?: string; aliases?: string[] } | null = null;
        try {
          parsed = await parseJsonResponse(cleaned, undefined, { silentOnEmpty: true });
        } catch (parseErr) {
          console.error(`mergeDuplicatePages: JSON parse failed for ${sourcePath} → ${targetPath}`, parseErr);
        }
        if (parsed?.body) {
          // #435 Item 2: this path hands the model a body and adopts its answer,
          // exactly like the merge and related-page paths in #419 — and the
          // title line is inside that window with no layer owning it. Softer
          // here (the surviving page's title is already captured into
          // `aliases:` above, so identity survives a lost H1) but the same
          // class, and the same deterministic repair applies.
          mergedBody = reassertH1(targetBody, parsed.body.trim());
          llmMergeSucceeded = true;
        } else if (!parsed) {
          console.warn(`mergeDuplicatePages: JSON parse returned null for ${sourcePath} → ${targetPath}, falling back to programmatic merge`);
        } else {
          console.warn(`mergeDuplicatePages: LLM response missing 'body' field for ${sourcePath} → ${targetPath}, falling back to programmatic merge`);
        }
        if (parsed?.aliases && Array.isArray(parsed.aliases)) {
          for (const a of parsed.aliases) {
            if (a && a !== targetTitle && !dedupedAliases.includes(a)) {
              dedupedAliases.push(a);
            }
          }
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`LLM merge failed for ${sourcePath} → ${targetPath}: ${errMsg}. Using programmatic merge.`, e);
    }
  }

  if (!resumeExisting && !mergedBody) {
    if (llmMergeSucceeded) {
      console.warn(`mergeDuplicatePages: LLM returned empty body for ${sourcePath} → ${targetPath}, using programmatic merge`);
    }
    mergedBody = targetBody;
    if (sourceBody) {
      mergedBody += '\n\n## From ' + sourceTitle + '\n\n' + sourceBody;
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const newContent = serializeFrontmatter(
    {
      type: targetFm?.type,
      created: targetFm?.created || today,
      updated: today,
      sources: mergedSourcesList,
      tags: Array.isArray(targetFm?.tags) ? targetFm.tags : [],
      reviewed: targetFm?.reviewed,
      aliases: dedupedAliases,
    },
    { tagStyle: 'block' }
  ) + '\n\n' + mergedBody;
  const pageType = targetPath.includes(`/${WIKI_SUBFOLDERS.entities}/`)
    ? 'entity'
    : targetPath.includes(`/${WIKI_SUBFOLDERS.concepts}/`)
      ? 'concept'
      : 'source';

  // Issue #388: `newContent` was serialized from `targetFm` a few lines up, but
  // the caller is the one that read the target page — pass the date explicitly
  // rather than relying on it surviving a round trip through the serializer.
  const enforced = resumeExisting ? targetContent : enforceFrontmatterConstraints(newContent, pageType, ctx.settings, {
    preserveCreated: targetFm?.created,
  });
  if (!resumeExisting) {
    checkCancelled(signal);
    await journalLease.assertOwned();
    const writeTarget = held && ctx.createOrUpdateFileUnlocked
      ? ctx.createOrUpdateFileUnlocked
      : ctx.createOrUpdateFile;
    await writeTarget(targetPath, enforced);
    if (journal && plan) {
      await journalLease.assertOwned();
      plan = {
        ...plan,
        mergedTargetHash: await contentHash(enforced, ctx.subtle),
        status: 'partial',
        updatedAt: nowIso(),
      };
      const current = await journal.load();
      await journal.save([...current.filter(entry => entry.id !== planId), plan]);
    }
  }

  // Issue #386: retarget every link that resolves to the source page, vault-wide
  // and in every link form, BEFORE the page is deleted. The retarget primitive
  // drains every admitted Vault.process write and verifies the post-write
  // metadata state before returning.
  const retargetedDeps = {
    vault: ctx.app.vault,
    metadataCache: ctx.app.metadataCache,
    signal,
    withPathWriteLock: retargetLock(ctx, held, lockedPaths),
  };
  let retargeted: RetargetResult;
  try {
    retargeted = await retargetLinksToPage(retargetedDeps, sourcePath, targetPath);
  } catch (error) {
    // A failed/partial retarget leaves the source in place. Journal the
    // partial state when possible so a later run can resume only after hashes
    // still match; never turn a safety error into a deletion.
    if (journal && plan && error instanceof RetargetSafetyError) {
      await journalLease.assertOwned();
      const current = await journal.load();
      await journal.save([...current.filter(entry => entry.id !== planId), {
        ...plan,
        status: 'partial',
        retarget: error.result,
        updatedAt: nowIso(),
      }]);
    }
    throw error;
  }
  if (!retargetIsSafe(retargeted)) {
    const safetyError = new RetargetSafetyError(retargeted);
    if (journal && plan) {
      await journalLease.assertOwned();
      const current = await journal.load();
      await journal.save([...current.filter(entry => entry.id !== planId), {
        ...plan,
        status: 'partial',
        retarget: retargeted,
        updatedAt: nowIso(),
      }]);
    }
    throw safetyError;
  }
  if (journal && plan) {
    await journalLease.assertOwned();
    plan = { ...plan, status: 'retargeted', retarget: retargeted, updatedAt: nowIso() };
    const current = await journal.load();
    await journal.save([...current.filter(entry => entry.id !== planId), plan]);
  }

  // This check intentionally sits immediately before the destructive call.
  // Retarget has already drained all in-flight writes; an abort here preserves
  // the source and leaves a resumable `retargeted` plan behind.
  checkCancelled(signal);
  await journalLease.assertOwned();
  const deleteSource = held && ctx.deleteFileUnlocked
    ? ctx.deleteFileUnlocked
    : ctx.deleteFile;
  await deleteSource(sourcePath);
  if (journal) {
    await journalLease.assertOwned();
    // A successful delete must be observable before the durable commit is
    // recorded. If the adapter reports the source still present, retain the
    // resumable retargeted plan and refuse to claim a commit.
    if (await ctx.tryReadFile(sourcePath) !== null) {
      throw new Error(`File deletion could not be verified: ${sourcePath}`);
    }
  }
  if (journal && plan) {
    await journalLease.assertOwned();
    const current = await journal.load();
    await journal.save([...current.filter(entry => entry.id !== planId), {
      ...plan,
      status: 'committed',
      updatedAt: nowIso(),
    }]);
  }
  const linkNote = retargeted.linksRewritten > 0
    ? ` (${retargeted.linksRewritten} link${retargeted.linksRewritten === 1 ? '' : 's'} retargeted in ${retargeted.filesChanged} file${retargeted.filesChanged === 1 ? '' : 's'})`
    : '';
  return `merged ${sourceRel} → ${targetRel}${linkNote}`;
}
