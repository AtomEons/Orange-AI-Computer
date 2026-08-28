import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './deploy-core.mjs';

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function loadInstaller(plan) {
  const relative = plan.actions.find((action) => action.kind === 'orange.clients.configure')?.installer;
  if (!relative) throw new Error('OrangeFive client installer is not declared in the approved plan.');
  const installerPath = path.resolve(plan.sourceRoot, relative);
  if (!existsSync(installerPath) || !statSync(installerPath).isFile()) throw new Error(`OrangeFive client installer is missing: ${installerPath}`);
  return await import(`${pathToFileURL(installerPath).href}?deploy=${plan.planSha256}`);
}

function surfaces(installer) {
  const rows = Object.entries(installer.CLIENTS || {}).map(([name, file]) => ({ kind: 'client-config', name, file }));
  for (const [rootName, root] of Object.entries(installer.SKILL_ROOTS || {})) {
    for (const skill of ['orange5', 'orangebox-primer']) {
      rows.push({ kind: 'client-skill', name: `${rootName}:${skill}`, file: path.join(root, skill, 'SKILL.md') });
    }
  }
  return rows.sort((left, right) => left.file.localeCompare(right.file));
}

function snapshotSurface(row, backupRoot, index) {
  const beforeExists = existsSync(row.file) && statSync(row.file).isFile();
  const backupPath = beforeExists ? path.join(backupRoot, `${String(index).padStart(2, '0')}.bak`) : null;
  if (backupPath) {
    mkdirSync(path.dirname(backupPath), { recursive: true });
    copyFileSync(row.file, backupPath);
  }
  return {
    ...row,
    beforeExists,
    beforeSha256: beforeExists ? sha256File(row.file) : null,
    backupPath,
  };
}

function parityOkay(report, requireCurrent) {
  if (!report?.ok) return false;
  const accepted = requireCurrent ? new Set(['CURRENT']) : new Set(['CURRENT', 'WOULD_UPDATE']);
  return (report.results || []).every((item) => accepted.has(item.status))
    && (report.skills || []).every((item) => accepted.has(item.status) || (!requireCurrent && item.status === 'WOULD_ARCHIVE_STALE'));
}

export async function preflightOrangeClients(plan) {
  const installer = await loadInstaller(plan);
  const report = installer.install({ dryRun: true });
  if (!parityOkay(report, false)) throw new Error(`OrangeFive client configuration preflight failed: ${JSON.stringify(report.results || [])}`);
  return { ok: true, report };
}

export async function configureOrangeClients(plan, paths) {
  const installer = await loadInstaller(plan);
  const backupRoot = path.join(paths.deployRoot, 'client-config-backups', plan.planSha256);
  const before = surfaces(installer).map((row, index) => snapshotSurface(row, backupRoot, index));
  let report = null;
  let installError = null;
  try {
    report = installer.install({ dryRun: false });
  } catch (error) {
    installError = error;
  }
  const records = before.map((row) => ({
    ...row,
    afterExists: existsSync(row.file) && statSync(row.file).isFile(),
    afterSha256: existsSync(row.file) && statSync(row.file).isFile() ? sha256File(row.file) : null,
  }));
  const rollback = {
    schema: 'orange.deploy.client-config-rollback.v1',
    planSha256: plan.planSha256,
    createdAt: new Date().toISOString(),
    files: records,
    archivedStaleSkills: (report?.skills || [])
      .filter((item) => item.status === 'ARCHIVED_STALE')
      .map((item) => ({ path: item.path, archivePath: item.archivePath })),
    installError: installError?.message || null,
  };
  writeJsonAtomic(paths.clientRollback, rollback);
  if (installError) throw installError;
  if (!report.ok) throw new Error(`OrangeFive client configuration failed: ${JSON.stringify(report.results || [])}`);
  return {
    schema: 'orange.deploy.client-config.v1',
    status: 'ORANGEFIVE_CLIENTS_CONFIGURED',
    receiptPath: report.receiptPath || null,
    rollbackPath: paths.clientRollback,
    clients: report.results,
    skills: report.skills,
  };
}

export async function verifyOrangeClients(plan) {
  const installer = await loadInstaller(plan);
  const report = installer.install({ dryRun: true });
  return { ok: parityOkay(report, true), report };
}

export function rollbackOrangeClients(plan, paths) {
  if (!existsSync(paths.clientRollback)) return { restored: [], preserved: [], reason: 'rollback-record-absent' };
  const record = JSON.parse(readFileSync(paths.clientRollback, 'utf8'));
  if (record.planSha256 !== plan.planSha256) throw new Error('Client rollback record belongs to a different approved plan.');
  const restored = [];
  const preserved = [];
  for (const file of record.files || []) {
    const currentExists = existsSync(file.file) && statSync(file.file).isFile();
    const currentSha256 = currentExists ? sha256File(file.file) : null;
    if (currentExists !== file.afterExists || currentSha256 !== file.afterSha256) {
      preserved.push({ file: file.file, reason: 'changed-after-deploy' });
      continue;
    }
    if (file.beforeExists) {
      if (!file.backupPath || !existsSync(file.backupPath)) throw new Error(`Client rollback backup is missing: ${file.backupPath}`);
      mkdirSync(path.dirname(file.file), { recursive: true });
      copyFileSync(file.backupPath, file.file);
      restored.push({ file: file.file, status: 'RESTORED' });
    } else {
      rmSync(file.file, { force: true });
      restored.push({ file: file.file, status: 'REMOVED_DEPLOY_CREATED_FILE' });
    }
  }
  for (const item of record.archivedStaleSkills || []) {
    if (existsSync(item.archivePath) && !existsSync(item.path)) {
      mkdirSync(path.dirname(item.path), { recursive: true });
      renameSync(item.archivePath, item.path);
      restored.push({ file: item.path, status: 'RESTORED_ARCHIVED_STALE_SKILL' });
    } else if (existsSync(item.archivePath)) {
      preserved.push({ file: item.path, archivePath: item.archivePath, reason: 'destination-exists' });
    }
  }
  return { restored, preserved, rollbackRecord: paths.clientRollback };
}
