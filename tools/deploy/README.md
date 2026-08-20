# Controlled plugin deployer

`tools/deploy/deploy-plugin.mjs` is the repository-owned deployment boundary for
the built Karpathy LLM Wiki plugin. It copies only `main.js`, `manifest.json`,
and `styles.css`; it never copies `data.json` or any vault content.

Dry-run is the default and performs marker checks plus SHA-256 planning without
writing. A live deployment requires `--write` and:

```powershell
node tools/deploy/deploy-plugin.mjs deploy --source . --vault C:\Users\lleit\SPM-Brain --write
```

The deployer requires the exact `SPM-Brain` vault directory, a real `.obsidian`
plugins path, and matching `karpathywiki` / `Karpathy LLM Wiki` manifest
markers. It records a pre-deploy SHA-256 manifest, creates a timestamped
backup under `.obsidian\plugins\.karpathywiki-deploy-backups`, verifies every
post-copy hash, and restores the backup automatically if the copy fails. Vault,
plugin, source, and backup path chains are rejected if they contain symlinks,
junctions, or Windows reparse points. A per-plugin interprocess lock prevents
overlapping deployments. The target files are CAS-checked immediately before
backup and replacement; a concurrent mutation aborts and restores from the
verified backup.

Rollback is also dry-run by default:

```powershell
node tools/deploy/deploy-plugin.mjs rollback --operation <backup-directory>
node tools/deploy/deploy-plugin.mjs rollback --operation <backup-directory> --write
```

Rollback requires the verified deployment receipt, checks the recorded
`target_after` hashes, and refuses to overwrite any target that drifted after
deployment. It verifies backup hashes before restoration. Both deployment and
rollback write receipts only when `--write` is present.
Keep Obsidian idle before a write deployment and reload the plugin through the
normal Obsidian workflow after the verified receipt is available.

Focused tests:

```powershell
node --test tools/deploy/deploy-plugin.test.mjs
```
