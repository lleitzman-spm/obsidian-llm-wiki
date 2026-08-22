// v1.22.0 #97: business logic for "apply a Schema suggestion" — the
// orchestrator function behind the SchemaDiffModal's "Apply" button.
//
// Flow:
//   1. Read the current config.md (skip if missing — first-install case)
//   2. Create a backup (config.md.bak.<iso>) by copying content
//   3. Prune old backups to enforce MAX_BACKUPS limit
//   4. Write the new body to the original path, preserving the YAML
//      frontmatter (version, updated, auto_suggestion_count)
//   5. Invalidate the SchemaManager cache via onCacheInvalidate callback
//   6. Return a small result struct so the UI can show a Notice
//
// Frontmatter handling: we keep the existing frontmatter (date/version),
// only the body changes. This way, every apply leaves an audit trail in
// the frontmatter (updated: <today>, auto_suggestion_count: N) without
// the LLM having to know anything about frontmatter format.

import { App, TFile } from 'obsidian';
import { backupFilename, rotateBackups } from '../core/backup-rotation';
import { assertSafeVaultPath, getSchemaPathWriteQueue, verifyVaultFile } from './schema-manager';

export interface ApplySchemaSuggestionParams {
  app: App;
  currentPath: string;
  newBody: string;
  /** Override Date.now() for deterministic tests. */
  now?: () => Date;
  /** Called once after a successful write so the SchemaManager can drop
   *  its in-memory cache (the next loadSchema() will return the new body). */
  onCacheInvalidate?: () => void;
}

export type ApplySchemaResult =
  | { success: true;  backupPath: string }
  | { success: false; reason: 'source-missing' };

export async function applySchemaSuggestion(
  params: ApplySchemaSuggestionParams
): Promise<ApplySchemaResult> {
  const { app, currentPath, newBody, onCacheInvalidate } = params;
  const now = params.now ?? (() => new Date());
  const safeCurrentPath = assertSafeVaultPath(currentPath);
  const queue = getSchemaPathWriteQueue(app);
  const canonicalCurrentPath = queue.canonicalPath(safeCurrentPath);
  const iso = now().toISOString();
  const baseBackupPath = assertSafeVaultPath(backupFilename(canonicalCurrentPath, iso));
  // Include a bounded set of deterministic collision candidates in the same
  // lease. This keeps two simultaneous applies from overwriting one backup
  // when tests or a clock provide the same timestamp.
  const backupCandidates = [baseBackupPath];
  for (let i = 1; i <= 32; i++) backupCandidates.push(`${baseBackupPath}-${i}`);

  const dir = canonicalCurrentPath.substring(0, canonicalCurrentPath.lastIndexOf('/'));
  const baseName = canonicalCurrentPath.split('/').pop() ?? canonicalCurrentPath;
  const bakPrefix = `${dir}/${baseName}.bak.`;
  const vaultAny = app.vault as unknown as {
    getFiles?: () => TFile[];
    getMarkdownFiles: () => TFile[];
  };
  const filesToScan: TFile[] = vaultAny.getFiles ? vaultAny.getFiles() : vaultAny.getMarkdownFiles();
  const existingBackupPaths = filesToScan
    .map(file => file.path)
    .filter(path => path.startsWith(bakPrefix))
    .map(path => assertSafeVaultPath(path));

  return queue.run(
    [canonicalCurrentPath, ...backupCandidates, ...existingBackupPaths],
    async held => {
      const file = app.vault.getAbstractFileByPath(canonicalCurrentPath);
      if (!(file instanceof TFile)) {
        return { success: false, reason: 'source-missing' };
      }

      // All reads and writes happen while the canonical source lease is held;
      // a concurrent apply therefore backs up the latest completed edit.
      const originalContent = await held.runRaw(canonicalCurrentPath, () => app.vault.read(file));
      let bakPath = baseBackupPath;
      for (const candidate of backupCandidates) {
        if (!app.vault.getAbstractFileByPath(candidate)) {
          bakPath = candidate;
          break;
        }
      }
      await held.runRaw(bakPath, () => app.vault.create(bakPath, originalContent));
      await verifyVaultFile(app, bakPath, originalContent, 'Schema backup', held);

      const allBackups: string[] = [];
      const currentFiles = vaultAny.getFiles ? vaultAny.getFiles() : vaultAny.getMarkdownFiles();
      for (const candidate of currentFiles) {
        if (candidate.path.startsWith(bakPrefix)) allBackups.push(candidate.path);
      }
      allBackups.sort();
      const toDelete = rotateBackups(allBackups);
      for (const path of toDelete) {
        const oldBackup = app.vault.getAbstractFileByPath(path);
        if (oldBackup instanceof TFile) {
          await held.runRaw(path, () => app.fileManager.trashFile(oldBackup));
        }
      }

      const newContent = spliceBody(originalContent, newBody);
      await held.runRaw(canonicalCurrentPath, () => app.vault.modify(file, newContent));
      await verifyVaultFile(app, canonicalCurrentPath, newContent, 'Schema apply', held);
      onCacheInvalidate?.();

      return { success: true, backupPath: bakPath };
    },
  );
}

/**
 * Replace the body of a schema file (everything after the YAML
 * frontmatter) with `newBody`, preserving the original frontmatter.
 *
 * Frontmatter is the `--- ... ---` block at the top. If the file has
 * no frontmatter, the new content is just `newBody` (so the apply path
 * is the same regardless of frontmatter state).
 */
export function spliceBody(originalContent: string, newBody: string): string {
  if (!originalContent.startsWith('---')) {
    return newBody;
  }
  const end = originalContent.indexOf('---', 3);
  if (end <= 0) {
    // Unterminated frontmatter — treat as no frontmatter
    return newBody;
  }
  // Keep the frontmatter (including its closing `---` and trailing
  // newline if any), then append the new body.
  const frontmatter = originalContent.substring(0, end + 3);
  // Ensure exactly one blank line between frontmatter and body
  return `${frontmatter}\n\n${newBody}`;
}
