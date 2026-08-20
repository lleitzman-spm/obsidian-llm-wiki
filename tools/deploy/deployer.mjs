import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEPLOY_FILES = ['main.js', 'manifest.json', 'styles.css'];
export const PLUGIN_ID = 'karpathywiki';
export const PLUGIN_NAME = 'Karpathy LLM Wiki';
const RECEIPT_VERSION = 1;

const asAbsolute = (value) => path.resolve(value);

const normalizeForCompare = (value) => {
  const resolved = asAbsolute(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const isSamePath = (left, right) => normalizeForCompare(left) === normalizeForCompare(right);

const isWithin = (child, parent) => {
  const relative = path.relative(asAbsolute(parent), asAbsolute(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const statRequired = async (filePath, label) => {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
  return stat;
};

const directoryRequired = async (directory, label) => {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
  return stat;
};

const rejectReparse = async (filePath, label) => {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link or reparse point: ${filePath}`);
  if (process.platform === 'win32') {
    try {
      execFileSync('fsutil.exe', ['reparsepoint', 'query', filePath], { stdio: 'ignore', windowsHide: true });
      throw new Error(`${label} must not be a junction or reparse point: ${filePath}`);
    } catch (error) {
      if (error?.message?.includes('must not be a junction')) throw error;
      if (error?.code === 'ENOENT') throw new Error(`cannot verify Windows reparse-point status for ${filePath}`);
      if (error?.status !== 1) throw new Error(`cannot verify Windows reparse-point status for ${filePath}`);
      // fsutil exits with status 1 for ordinary files and directories.
    }
  }
  const realPath = await fs.realpath(filePath);
  if (!isSamePath(realPath, filePath)) throw new Error(`${label} resolves through a junction or reparse point: ${filePath}`);
};

async function assertDirectoryChainNoReparse(root, stopAt) {
  const rootAbs = asAbsolute(root);
  const stopAbs = asAbsolute(stopAt);
  const relative = path.relative(rootAbs, stopAbs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`marker path is outside the expected root: ${stopAbs}`);
  }
  let current = rootAbs;
  await rejectReparse(current, 'root');
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await rejectReparse(current, 'deployment path component');
  }
}

async function assertSourceSeparation(sourceDir, vaultDir, targetDir) {
  if (isWithin(sourceDir, vaultDir) || isWithin(vaultDir, sourceDir) || isWithin(sourceDir, targetDir) || isWithin(targetDir, sourceDir)) {
    throw new Error(`source must be distinct from and outside the vault/deployment path: ${sourceDir}`);
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  const contents = await fs.readFile(filePath);
  hash.update(contents);
  return { sha256: hash.digest('hex'), bytes: contents.byteLength };
}

const readJson = async (filePath, label) => {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath} (${error.message})`);
  }
  return value;
};

const utcStamp = () => new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');

export function defaultOptions(repoRoot = process.cwd()) {
  const vault = process.env.SPM_VAULT_PATH || path.join(process.env.USERPROFILE || process.env.HOME || '', 'SPM-Brain');
  return {
    sourceDir: asAbsolute(repoRoot),
    vaultDir: asAbsolute(vault),
    write: false,
    operation: null,
  };
}

export async function inspectTarget(vaultValue) {
  const vaultDir = asAbsolute(vaultValue);
  const obsidianDir = path.join(vaultDir, '.obsidian');
  const pluginsDir = path.join(obsidianDir, 'plugins');
  const targetDir = path.join(pluginsDir, PLUGIN_ID);

  if (path.basename(vaultDir) !== 'SPM-Brain') {
    throw new Error(`refusing vault whose final directory is not exactly SPM-Brain: ${vaultDir}`);
  }
  await directoryRequired(vaultDir, 'vault');
  await assertDirectoryChainNoReparse(path.parse(vaultDir).root, targetDir);
  await directoryRequired(obsidianDir, 'Obsidian configuration directory');
  await directoryRequired(pluginsDir, 'Obsidian plugins directory');
  await directoryRequired(targetDir, 'Karpathy plugin directory');

  const targetManifestPath = path.join(targetDir, 'manifest.json');
  await statRequired(targetManifestPath, 'installed manifest');
  const targetManifest = await readJson(targetManifestPath, 'installed manifest');
  if (targetManifest.id !== PLUGIN_ID || targetManifest.name !== PLUGIN_NAME) {
    throw new Error(`installed plugin marker mismatch: expected ${PLUGIN_ID}/${PLUGIN_NAME}`);
  }

  const targetFiles = {};
  for (const file of DEPLOY_FILES) {
    const targetPath = path.join(targetDir, file);
    if (await fileExists(targetPath)) {
      await statRequired(targetPath, `installed ${file}`);
      targetFiles[file] = { path: targetPath, existed: true, ...(await sha256(targetPath)) };
    } else {
      targetFiles[file] = { path: targetPath, existed: false, sha256: null, bytes: 0 };
    }
  }

  const backupRoot = path.join(pluginsDir, '.karpathywiki-deploy-backups');
  if (await fileExists(backupRoot)) {
    await directoryRequired(backupRoot, 'deployment backup root');
    await assertDirectoryChainNoReparse(pluginsDir, backupRoot);
  }
  return { vaultDir, obsidianDir, pluginsDir, targetDir, backupRoot, targetManifest, targetFiles };
}

export async function inspectDeployment(options) {
  const sourceDir = asAbsolute(options.sourceDir);
  const targetInspection = await inspectTarget(options.vaultDir);
  await directoryRequired(sourceDir, 'source directory');
  await assertDirectoryChainNoReparse(path.parse(sourceDir).root, sourceDir);
  await assertSourceSeparation(sourceDir, targetInspection.vaultDir, targetInspection.targetDir);

  const sourceManifestPath = path.join(sourceDir, 'manifest.json');
  await statRequired(sourceManifestPath, 'source manifest');
  const sourceManifest = await readJson(sourceManifestPath, 'source manifest');
  if (sourceManifest.id !== PLUGIN_ID || sourceManifest.name !== PLUGIN_NAME) {
    throw new Error(`source plugin marker mismatch: expected ${PLUGIN_ID}/${PLUGIN_NAME}`);
  }

  const sourceFiles = {};
  for (const file of DEPLOY_FILES) {
    const sourcePath = path.join(sourceDir, file);
    await statRequired(sourcePath, `source ${file}`);
    sourceFiles[file] = { path: sourcePath, ...(await sha256(sourcePath)) };
  }
  return { ...targetInspection, sourceDir, sourceManifest, sourceFiles };
}

const makeManifest = (inspection, operationId, operationDir) => ({
  receipt_version: RECEIPT_VERSION,
  operation: 'karpathywiki-plugin-deploy',
  operation_id: operationId,
  created_at: new Date().toISOString(),
  source_dir: inspection.sourceDir,
  vault_dir: inspection.vaultDir,
  target_dir: inspection.targetDir,
  backup_dir: operationDir,
  plugin: { id: PLUGIN_ID, name: PLUGIN_NAME },
  files: Object.fromEntries(DEPLOY_FILES.map((file) => [file, {
    source: { sha256: inspection.sourceFiles[file].sha256, bytes: inspection.sourceFiles[file].bytes },
    target_before: {
      existed: inspection.targetFiles[file].existed,
      sha256: inspection.targetFiles[file].sha256,
      bytes: inspection.targetFiles[file].bytes,
    },
  }])),
});

const writeJson = async (filePath, value) => fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

async function copyVerified(source, target, expected) {
  await fs.copyFile(source, target);
  const actual = await sha256(target);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`hash verification failed for ${target}`);
  }
}

async function assertTargetCas(inspection, expectedFiles, phase) {
  for (const file of DEPLOY_FILES) {
    const expected = expectedFiles[file];
    if (!expected) continue;
    const target = path.join(inspection.targetDir, file);
    const exists = await fileExists(target);
    if (Boolean(expected.existed) !== exists) throw new Error(`target CAS refusal (${phase}): existence changed for ${file}`);
    if (!exists) continue;
    const actual = await sha256(target);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`target CAS refusal (${phase}): hash changed for ${file}`);
    }
  }
}

async function assertTargetAfterCas(inspection, receipt) {
  const expectedFiles = {};
  for (const file of DEPLOY_FILES) {
    const targetAfter = receipt.files?.[file]?.target_after;
    if (!targetAfter || typeof targetAfter.sha256 !== 'string') throw new Error(`rollback receipt is missing target_after for ${file}`);
    expectedFiles[file] = { existed: true, sha256: targetAfter.sha256, bytes: targetAfter.bytes };
  }
  await assertTargetCas(inspection, expectedFiles, 'rollback');
}

async function verifyBackupHashes(manifest, operationDir) {
  const backupDir = path.join(operationDir, 'backup');
  await directoryRequired(backupDir, 'deployment backup directory');
  await assertDirectoryChainNoReparse(operationDir, backupDir);
  for (const file of DEPLOY_FILES) {
    const record = manifest.files[file].target_before;
    const backup = path.join(backupDir, file);
    if (!record.existed) {
      if (await fileExists(backup)) throw new Error(`unexpected backup for absent target: ${file}`);
      continue;
    }
    await statRequired(backup, `backup ${file}`);
    const actual = await sha256(backup);
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) throw new Error(`backup hash verification failed: ${file}`);
  }
}

async function withDeploymentLock(inspection, action) {
  const lockPath = path.join(inspection.pluginsDir, '.karpathywiki-deploy.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx');
    await lock.writeFile(`${JSON.stringify({ operation: 'karpathywiki-deploy', pid: process.pid, created_at: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    if (lock) await lock.close();
    if (error?.code === 'EEXIST') throw new Error(`deployment lock already held: ${lockPath}`);
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

async function replaceWithVerified(source, target, expected, operationId) {
  const temporary = `${target}.deploy-${operationId}.tmp`;
  try {
    await copyVerified(source, temporary, expected);
    // fs.rename does not replace an existing file on Windows. The caller has
    // already captured the pre-deploy backup, so this small replacement gap is
    // recoverable if the process is interrupted.
    if (await fileExists(target)) await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } finally {
    if (await fileExists(temporary)) await fs.rm(temporary, { force: true });
  }
}

async function restoreFromManifest(inspection, manifest, operationDir) {
  await verifyBackupHashes(manifest, operationDir);
  const backupDir = path.join(operationDir, 'backup');
  for (const file of DEPLOY_FILES) {
    const record = manifest.files[file].target_before;
    const target = path.join(inspection.targetDir, file);
    if (!record.existed) {
      if (await fileExists(target)) await fs.rm(target, { force: true });
      continue;
    }
    const backup = path.join(backupDir, file);
    await statRequired(backup, `backup ${file}`);
    await replaceWithVerified(backup, target, record, `${manifest.operation_id}-rollback`);
  }
}

export async function deploy(options) {
  const initialInspection = await inspectDeployment(options);
  if (!options.write) {
    const operationId = `${utcStamp()}-${process.pid}`;
    const operationDir = path.join(initialInspection.backupRoot, operationId);
    return { mode: 'dry-run', manifest: makeManifest(initialInspection, operationId, operationDir), targetDir: initialInspection.targetDir };
  }
  return withDeploymentLock(initialInspection, async () => {
    const inspection = await inspectDeployment(options);
    const operationId = `${utcStamp()}-${process.pid}`;
    const operationDir = path.join(inspection.backupRoot, operationId);
    const manifest = makeManifest(inspection, operationId, operationDir);
    await assertTargetCas(inspection, Object.fromEntries(DEPLOY_FILES.map((file) => [file, manifest.files[file].target_before])), 'pre-backup');
    if (options.hooks?.beforeBackup) await options.hooks.beforeBackup(inspection);
    await assertTargetCas(inspection, Object.fromEntries(DEPLOY_FILES.map((file) => [file, manifest.files[file].target_before])), 'pre-backup');
    await fs.mkdir(path.join(operationDir, 'backup'), { recursive: true });
    await writeJson(path.join(operationDir, 'predeploy-manifest.json'), manifest);
    for (const file of DEPLOY_FILES) {
      const record = manifest.files[file].target_before;
      if (record.existed) await copyVerified(path.join(inspection.targetDir, file), path.join(operationDir, 'backup', file), record);
    }
    await verifyBackupHashes(manifest, operationDir);

    try {
      if (options.hooks?.beforeReplace) await options.hooks.beforeReplace(inspection);
      await assertTargetCas(inspection, Object.fromEntries(DEPLOY_FILES.map((file) => [file, manifest.files[file].target_before])), 'pre-replacement');
      for (const file of DEPLOY_FILES) {
        const source = inspection.sourceFiles[file];
        const currentSource = await sha256(path.join(inspection.sourceDir, file));
        if (currentSource.sha256 !== source.sha256 || currentSource.bytes !== source.bytes) throw new Error(`source changed after predeploy manifest: ${file}`);
        await assertTargetCas(inspection, { [file]: manifest.files[file].target_before }, `pre-replacement-${file}`);
        await replaceWithVerified(path.join(inspection.sourceDir, file), path.join(inspection.targetDir, file), source, operationId);
      }
      const verifiedFiles = {};
      for (const file of DEPLOY_FILES) {
        const actual = await sha256(path.join(inspection.targetDir, file));
        const expected = inspection.sourceFiles[file];
        if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`post-copy hash mismatch: ${file}`);
        verifiedFiles[file] = { source: manifest.files[file].source, target_after: actual };
      }
      const receipt = { ...manifest, completed_at: new Date().toISOString(), result: 'deployed-and-verified', files: verifiedFiles };
      await writeJson(path.join(operationDir, 'deploy-receipt.json'), receipt);
      return receipt;
    } catch (error) {
      await restoreFromManifest(inspection, manifest, operationDir);
      throw new Error(`${error.message}; deployment rolled back from ${operationDir}`);
    }
  });
}

export async function rollback(options) {
  if (!options.operation) throw new Error('rollback requires --operation <backup directory>');
  const operationDir = asAbsolute(options.operation);
  await directoryRequired(operationDir, 'rollback operation directory');
  await rejectReparse(operationDir, 'rollback operation directory');
  const manifestPath = path.join(operationDir, 'predeploy-manifest.json');
  const manifest = await readJson(manifestPath, 'predeploy manifest');
  if (manifest.operation !== 'karpathywiki-plugin-deploy' || !manifest.operation_id) throw new Error('invalid deploy manifest');
  const deployReceipt = await readJson(path.join(operationDir, 'deploy-receipt.json'), 'deploy receipt');
  if (deployReceipt.result !== 'deployed-and-verified') throw new Error('rollback requires a verified deployment receipt');
  const inspection = await inspectTarget(manifest.vault_dir);
  if (!isSamePath(inspection.targetDir, manifest.target_dir)) throw new Error('rollback target marker mismatch');
  if (!isWithin(operationDir, inspection.backupRoot)) throw new Error('rollback operation is outside the expected backup root');
  await assertTargetAfterCas(inspection, deployReceipt);
  await verifyBackupHashes(manifest, operationDir);
  const plan = { mode: options.write ? 'write' : 'dry-run', operation: 'karpathywiki-plugin-rollback', operation_id: manifest.operation_id, targetDir: inspection.targetDir, files: manifest.files };
  if (!options.write) return plan;
  return withDeploymentLock(inspection, async () => {
    const lockedInspection = await inspectTarget(manifest.vault_dir);
    await assertTargetAfterCas(lockedInspection, deployReceipt);
    await verifyBackupHashes(manifest, operationDir);
    await restoreFromManifest(lockedInspection, manifest, operationDir);
    await assertTargetCas(lockedInspection, Object.fromEntries(DEPLOY_FILES.map((file) => [file, manifest.files[file].target_before])), 'post-rollback');
    const receipt = { ...plan, completed_at: new Date().toISOString(), result: 'rolled-back-and-verified' };
    await writeJson(path.join(operationDir, 'rollback-receipt.json'), receipt);
    return receipt;
  });
}
