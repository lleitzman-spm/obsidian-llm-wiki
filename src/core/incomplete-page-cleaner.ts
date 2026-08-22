// #170 — Incomplete-page cleaner.
//
// A wiki page may be left in a partial state if generation is interrupted
// (user cancels, plugin reload mid-write, or an LLM error after the page was
// already created). The fix:
//
// 1. When a wiki page is first written, stamp frontmatter `generation_complete: false`.
// 2. After the FULL body is written successfully, flip the flag to `true`.
// 3. On plugin startup (QuickFixes Phase 3), scan wiki/{entities,concepts,sources}
//    for pages where the flag is stuck at `false` and archive them.
//
// Backward-compat rule: pages WITHOUT the field at all are treated as legacy
// (v1.20.x or earlier). We MUST NOT delete them — that would wipe every existing
// wiki on upgrade. Only `false` triggers cleanup.
//
// Cleanup mode: `trash` (Obsidian's `fileManager.trashFile`, moves to .trash —
// recoverable). Future enhancement could add a hard-delete option, gated on
// a settings flag (out of scope for v1.21.0).

import { App, TFile } from 'obsidian';
import { parseFrontmatter } from './frontmatter';
import { getVaultPathWriteQueue, notifyVaultWrite } from './path-write-safety';

/** True iff the page's frontmatter explicitly contains `generation_complete: false`.
 *  Note: parseFrontmatter returns all unknown keys as strings (no boolean
 *  coercion), so we compare against the literal string 'false'.
 *  Legacy pages without the field at all return false (preserve). */
export function isIncomplete(content: string): boolean {
  const fm = parseFrontmatter(content);
  if (!fm) return false;
  return fm.generation_complete === 'false';
}

/** Files under wiki/{entities,concepts,sources} that are flagged incomplete. */
export interface IncompleteScanResult {
  files: TFile[];
  scanned: number;
}

export async function findIncompletePages(
  app: App,
  wikiFolder: string,
): Promise<TFile[]> {
  const prefix = `${wikiFolder}/`;
  const allFiles = app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
  const incomplete: TFile[] = [];

  for (const f of allFiles) {
    try {
      const content = await app.vault.read(f);
      if (isIncomplete(content)) {
        incomplete.push(f);
      }
    } catch (e) {
      // Read failure is non-fatal — skip this file and continue.
      console.warn(`[incomplete-page-cleaner] failed to read ${f.path}:`, e);
    }
  }

  return incomplete;
}

/**
 * Archive (trash) the given files. Returns the count successfully cleaned.
 * Failures on individual files are logged and skipped — one bad page must not
 * block cleanup of the rest.
 */
export async function cleanIncompletePages(
  app: App,
  files: TFile[],
): Promise<number> {
  const queue = getVaultPathWriteQueue(
    app.vault,
    app.vault.getMarkdownFiles().map(file => file.path),
  );
  let cleaned = 0;
  for (const f of files) {
    try {
      await queue.run(f.path, async held => {
        // A scan can become stale while another writer is active.  Re-check
        // identity under the same lease before moving anything to .trash.
        const current = app.vault.getAbstractFileByPath(f.path) as { path?: string } | null;
        if (!current || current.path !== f.path) {
          throw new Error(`Incomplete page disappeared before cleanup: ${f.path}`);
        }
        await held.runRaw(f.path, () => app.fileManager.trashFile(f));
        if (app.vault.getAbstractFileByPath(f.path)) {
          throw new Error(`Incomplete page trash could not be verified: ${f.path}`);
        }
        notifyVaultWrite(
          (app as unknown as { onFileWrite?: (path: string) => void }).onFileWrite,
          queue,
          f.path,
        );
      });
      cleaned++;
      console.debug(`[incomplete-page-cleaner] trashed ${f.path}`);
    } catch (e) {
      console.warn(`[incomplete-page-cleaner] failed to trash ${f.path}:`, e);
    }
  }
  return cleaned;
}

/**
 * Frontmatter stamp helper used by the page writer.
 * - `setGenerationComplete(content, false)` stamps the flag at start.
 * - `setGenerationComplete(content, true)` flips to true on full write.
 * Idempotent: re-stamping with the same value is a no-op.
 */
export function setGenerationComplete(content: string, complete: boolean): string {
  const fm = parseFrontmatter(content);
  const value = complete ? 'true' : 'false';

  // Match the existing line (with any leading whitespace) within the frontmatter
  // block, or insert a new line if the field doesn't exist yet.
  const existingRe = /^(\s*)generation_complete:\s*(?:true|false)\s*$/m;

  if (fm) {
    // Determine the frontmatter block boundaries.
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx === -1) return content; // malformed; refuse to mutate
    const fmBlock = content.substring(0, endIdx); // '---\n<fields>'
    const rest = content.substring(endIdx);

    if (existingRe.test(fmBlock)) {
      const newFm = fmBlock.replace(existingRe, `$1generation_complete: ${value}`);
      return newFm + rest;
    }
    // Insert the field on its own line, just before the closing '---' boundary.
    return fmBlock + `\ngeneration_complete: ${value}` + rest;
  }

  // No frontmatter yet — prepend a fresh block.
  return `---\ngeneration_complete: ${value}\n---\n\n${content}`;
}
