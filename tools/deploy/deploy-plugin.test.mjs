import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deploy, rollback } from './deployer.mjs';

const manifest = JSON.stringify({ id: 'karpathywiki', name: 'Karpathy LLM Wiki', version: 'test' });

async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), 'tmp', 'karpathywiki-deploy-'));
  const source = path.join(root, 'repo');
  const vault = path.join(root, 'SPM-Brain');
  const target = path.join(vault, '.obsidian', 'plugins', 'karpathywiki');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, 'manifest.json'), manifest);
  await writeFile(path.join(source, 'main.js'), 'new-runtime');
  await writeFile(path.join(source, 'styles.css'), '.x {}');
  await writeFile(path.join(target, 'manifest.json'), manifest);
  await writeFile(path.join(target, 'main.js'), 'old-runtime');
  await writeFile(path.join(target, 'styles.css'), '.old {}');
  return { root, source, vault, target };
}

test('dry-run verifies exact markers and performs no writes', async () => {
  const f = await fixture();
  try {
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: false });
    assert.equal(result.mode, 'dry-run');
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'old-runtime');
    assert.equal(await stat(path.join(f.vault, '.obsidian', 'plugins', 'karpathywiki')).then((s) => s.isDirectory()), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('write creates a manifest, backup, and verifies copied hashes', async () => {
  const f = await fixture();
  try {
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: true });
    assert.equal(result.result, 'deployed-and-verified');
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'new-runtime');
    assert.equal(await readFile(path.join(f.target, 'styles.css'), 'utf8'), '.x {}');
    assert.equal((await stat(path.join(result.backup_dir, 'predeploy-manifest.json'))).isFile(), true);
    assert.equal((await stat(path.join(result.backup_dir, 'backup', 'main.js'))).isFile(), true);
    const receipt = JSON.parse(await readFile(path.join(result.backup_dir, 'deploy-receipt.json'), 'utf8'));
    assert.equal(receipt.result, 'deployed-and-verified');
    const dryRollback = await rollback({ operation: result.backup_dir, write: false });
    assert.equal(dryRollback.mode, 'dry-run');
    const restored = await rollback({ operation: result.backup_dir, write: true });
    assert.equal(restored.result, 'rolled-back-and-verified');
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'old-runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rechecks target CAS after the backup and restores on a concurrent mutation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deploy({
      sourceDir: f.source,
      vaultDir: f.vault,
      write: true,
      hooks: { beforeReplace: async ({ targetDir }) => writeFile(path.join(targetDir, 'main.js'), 'external mutation') },
    }), /target CAS refusal/);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'old-runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses a pre-existing interprocess deployment lock', async () => {
  const f = await fixture();
  const lock = path.join(f.vault, '.obsidian', 'plugins', '.karpathywiki-deploy.lock');
  try {
    await writeFile(lock, '{"pid":123}\n');
    await assert.rejects(deploy({ sourceDir: f.source, vaultDir: f.vault, write: true }), /deployment lock already held/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rollback refuses target drift and leaves the drift untouched', async () => {
  const f = await fixture();
  try {
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: true });
    await writeFile(path.join(f.target, 'main.js'), 'unrelated later change');
    await assert.rejects(rollback({ operation: result.backup_dir, write: true }), /target CAS refusal \(rollback\)/);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'unrelated later change');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rollback verifies backup hashes before restoring', async () => {
  const f = await fixture();
  try {
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: true });
    await writeFile(path.join(result.backup_dir, 'backup', 'main.js'), 'corrupt backup');
    await assert.rejects(rollback({ operation: result.backup_dir, write: true }), /backup hash verification failed/);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'new-runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rollback works when the source repository is no longer present', async () => {
  const f = await fixture();
  try {
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: true });
    await rm(f.source, { recursive: true, force: true });
    const restored = await rollback({ operation: result.backup_dir, write: true });
    assert.equal(restored.result, 'rolled-back-and-verified');
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'old-runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a vault without the exact SPM-Brain marker', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deploy({ sourceDir: f.source, vaultDir: path.join(f.root, 'wrong-vault'), write: false }), /exactly SPM-Brain/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects a vault path that is a junction or symbolic link', async (t) => {
  const f = await fixture();
  const linkParent = path.join(f.root, 'reparse-parent');
  const linkedVault = path.join(linkParent, 'SPM-Brain');
  try {
    await mkdir(linkParent, { recursive: true });
    try { await symlink(f.vault, linkedVault, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) { t.skip(`symbolic-link fixture unavailable: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(deploy({ sourceDir: f.source, vaultDir: linkedVault, write: false }), /directory|symbolic link|reparse|junction/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('rejects junction or reparse-point source, plugin, and backup chains', async (t) => {
  const f = await fixture();
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const makeLink = async (realPath, linkPath) => {
    try { await symlink(realPath, linkPath, linkType); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) { t.skip(`symbolic-link fixture unavailable: ${error.code}`); return false; }
      throw error;
    }
    return true;
  };
  try {
    const sourceReal = path.join(f.root, 'source-real');
    await rename(f.source, sourceReal);
    if (!await makeLink(sourceReal, f.source)) return;
    await assert.rejects(deploy({ sourceDir: f.source, vaultDir: f.vault, write: false }), /directory|symbolic link|reparse|junction/);
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const pluginFixture = await fixture();
  try {
    const targetReal = path.join(pluginFixture.vault, '.obsidian', 'plugins', 'karpathywiki-real');
    await rename(pluginFixture.target, targetReal);
    if (!await makeLink(targetReal, pluginFixture.target)) return;
    await assert.rejects(deploy({ sourceDir: pluginFixture.source, vaultDir: pluginFixture.vault, write: false }), /directory|symbolic link|reparse|junction/);
  } finally { await rm(pluginFixture.root, { recursive: true, force: true }); }

  const backupFixture = await fixture();
  try {
    const backupRoot = path.join(backupFixture.vault, '.obsidian', 'plugins', '.karpathywiki-deploy-backups');
    const backupReal = path.join(backupFixture.root, 'backup-real');
    await mkdir(backupReal, { recursive: true });
    if (!await makeLink(backupReal, backupRoot)) return;
    await assert.rejects(deploy({ sourceDir: backupFixture.source, vaultDir: backupFixture.vault, write: false }), /directory|symbolic link|reparse|junction/);
  } finally { await rm(backupFixture.root, { recursive: true, force: true }); }
});

test('rejects source nested inside the vault deployment path', async () => {
  const f = await fixture();
  const nestedSource = path.join(f.vault, 'repo');
  try {
    await mkdir(nestedSource, { recursive: true });
    for (const file of ['main.js', 'manifest.json', 'styles.css']) await writeFile(path.join(nestedSource, file), await readFile(path.join(f.source, file)));
    await assert.rejects(deploy({ sourceDir: nestedSource, vaultDir: f.vault, write: false }), /source must be distinct/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('does not deploy settings data.json', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'data.json'), 'source settings');
    await writeFile(path.join(f.target, 'data.json'), 'live settings');
    const before = await stat(path.join(f.target, 'data.json'));
    const result = await deploy({ sourceDir: f.source, vaultDir: f.vault, write: true });
    const after = await stat(path.join(f.target, 'data.json'));
    assert.equal(await readFile(path.join(f.target, 'data.json'), 'utf8'), 'live settings');
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(Object.keys(result.files).sort().join(','), 'main.js,manifest.json,styles.css');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
