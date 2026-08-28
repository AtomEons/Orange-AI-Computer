import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DISCOVERY_SCHEMA = 'orange.deploy.discovery.v1';
export const PLAN_SCHEMA = 'orange.deploy.plan.v1';
export const LEDGER_SCHEMA = 'orange.deploy.action-ledger.v1';
export const READINESS_SCHEMA = 'orange.deploy.readiness.v1';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value) {
  return sha256(stableJson(value));
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

export function mergeCatalogAcquisition(catalog, acquisitionCatalog, { sourceCatalogSha256 = null } = {}) {
  if (acquisitionCatalog?.schema !== 'orange.deploy.model-acquisition-catalog.v1') {
    throw new Error('Unsupported model acquisition catalog schema.');
  }
  if (sourceCatalogSha256 && acquisitionCatalog.sourceCatalogSha256 !== sourceCatalogSha256) {
    throw new Error(`Model acquisition catalog is stale. Expected source catalog ${acquisitionCatalog.sourceCatalogSha256}, got ${sourceCatalogSha256}.`);
  }
  const baseRoles = new Map((catalog.roles || []).map((role) => [role.role, role]));
  if (baseRoles.size !== (catalog.roles || []).length) throw new Error('Base model catalog contains duplicate roles.');
  const overlays = new Map();
  for (const entry of acquisitionCatalog.roles || []) {
    if (!entry?.role || overlays.has(entry.role)) throw new Error(`Model acquisition catalog contains a missing or duplicate role: ${entry?.role || 'missing'}.`);
    if (!baseRoles.has(entry.role)) throw new Error(`Model acquisition catalog references unknown role: ${entry.role}.`);
    overlays.set(entry.role, entry);
  }
  const copyField = (entry, role, key, fallback = null) => Object.hasOwn(entry || {}, key)
    ? structuredClone(entry[key])
    : (Object.hasOwn(role, key) ? structuredClone(role[key]) : fallback);
  const roles = (catalog.roles || []).map((role) => {
    const entry = overlays.get(role.role);
    if (!entry) {
      return {
        ...structuredClone(role),
        provenanceStatus: 'blocked',
        provenanceBlockers: ['ACQUISITION_CATALOG_ENTRY_MISSING'],
        runtimeProvisioning: 'adopt-only',
      };
    }
    return {
      ...structuredClone(role),
      acquisition: copyField(entry, role, 'acquisition'),
      license: copyField(entry, role, 'license'),
      redistribution: copyField(entry, role, 'redistribution'),
      provenanceStatus: copyField(entry, role, 'provenanceStatus', 'blocked'),
      provenanceBlockers: copyField(entry, role, 'provenanceBlockers', ['PROVENANCE_STATUS_MISSING']),
      runtimeProvisioning: copyField(entry, role, 'runtimeProvisioning', 'adopt-only'),
      provenanceEvidence: copyField(entry, role, 'evidence'),
      observedArtifacts: copyField(entry, role, 'observedArtifacts', []),
    };
  });
  return {
    ...structuredClone(catalog),
    roles,
    deployAcquisition: {
      schema: acquisitionCatalog.schema,
      sourceCatalogSha256: acquisitionCatalog.sourceCatalogSha256,
      generatedAt: acquisitionCatalog.generatedAt || null,
      policy: structuredClone(acquisitionCatalog.policy || {}),
    },
  };
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, filePath);
  } catch {
    rmSync(filePath, { force: true });
    renameSync(temporary, filePath);
  }
}

export function defaultDataRoot(env = process.env) {
  const explicit = String(env.ORANGE5_DEPLOY_DATA_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), 'OrangeBox-Data', 'orange5');
}

export function deployPaths(dataRoot) {
  const deployRoot = path.join(path.resolve(dataRoot), 'deploy');
  return {
    dataRoot: path.resolve(dataRoot),
    deployRoot,
    discovery: path.join(deployRoot, 'discovery.json'),
    plan: path.join(deployRoot, 'plan.json'),
    ledger: path.join(deployRoot, 'action-ledger.jsonl'),
    activePlan: path.join(deployRoot, 'active-plan.json'),
    rollback: path.join(deployRoot, 'rollback.json'),
    clientRollback: path.join(deployRoot, 'client-config-rollback.json'),
    lock: path.join(deployRoot, 'apply.lock'),
    components: path.join(deployRoot, 'components'),
    receipts: path.join(deployRoot, 'receipts'),
  };
}

function normalizedForComparison(value) {
  const resolved = path.resolve(value).replaceAll('/', path.sep).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathInside(candidate, parent, allowParent = false) {
  const child = normalizedForComparison(candidate);
  const root = normalizedForComparison(parent);
  return (allowParent && child === root) || child.startsWith(`${root}${path.sep}`);
}

export function assertStateOutsidePayload(sourceRoot, dataRoot) {
  if (isPathInside(dataRoot, sourceRoot, true)) {
    throw new Error(`Deployment state must be outside the immutable payload: ${dataRoot}`);
  }
}

function walkFiles(root, relativeRoot = '') {
  const absolute = path.join(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  const rows = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) rows.push(...walkFiles(root, relative));
    else if (entry.isFile()) rows.push(relative.replaceAll('\\', '/'));
  }
  return rows;
}

export function criticalPayloadPaths(sourceRoot, manifest) {
  const requested = new Set([
    '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md',
    '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json',
    String(manifest.models?.catalog || ''),
    String(manifest.models?.acquisitionCatalog || ''),
    '08-HERMES/product-integration/upstream.lock.json',
    '08-HERMES/product-integration/integration.manifest.json',
    '08-HERMES/product-integration/scripts/install-hermes-product.ps1',
    '08-HERMES/product-integration/scripts/materialize-config.ps1',
    '08-HERMES/product-integration/scripts/start-owner.ps1',
    '08-HERMES/product-integration/scripts/preflight.ps1',
    '03-BACKEND/install-orange5-clients.mjs',
    '03-BACKEND/orange5-brain-mcp-server.mjs',
    ...walkFiles(sourceRoot, '03-BACKEND/client-skills'),
    'ORANGE_START.cmd',
    ...walkFiles(sourceRoot, 'scripts/llm-deploy').filter((item) => !item.includes('/tests/')),
  ]);
  return [...requested].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function capturePayloadFingerprint(sourceRoot, manifest) {
  const files = criticalPayloadPaths(sourceRoot, manifest).map((relativePath) => {
    const absolutePath = path.resolve(sourceRoot, relativePath);
    if (!isPathInside(absolutePath, sourceRoot, true)) {
      return { path: relativePath, status: 'unsafe', sha256: null, bytes: null };
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      return { path: relativePath, status: 'missing', sha256: null, bytes: null };
    }
    const bytes = readFileSync(absolutePath);
    return { path: relativePath, status: 'verified', sha256: sha256(bytes), bytes: bytes.length };
  });
  const requiredMissing = files.filter((item) => item.status !== 'verified').map((item) => item.path);
  const fingerprint = hashObject(files);
  return { algorithm: 'sha256', fingerprint, files, requiredMissing };
}

export function verifyPayloadFingerprint(sourceRoot, expected) {
  const mismatches = [];
  for (const file of expected?.files || []) {
    const absolutePath = path.resolve(sourceRoot, file.path);
    if (!isPathInside(absolutePath, sourceRoot, true) || !existsSync(absolutePath)) {
      mismatches.push({ path: file.path, reason: 'missing' });
      continue;
    }
    const actual = sha256(readFileSync(absolutePath));
    if (actual !== file.sha256) mismatches.push({ path: file.path, reason: 'sha256-mismatch', expected: file.sha256, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function verifyPayloadLock(sourceRoot) {
  const lockPath = path.join(sourceRoot, 'orangefive.payload.lock.json');
  if (!existsSync(lockPath)) return { present: false, verified: false, lockPath, mismatches: [] };
  const lock = readJson(lockPath);
  const mismatches = [];
  const files = Array.isArray(lock.files) ? lock.files : [];
  if (lock.schema !== 'orangefive.payload-lock.v1') mismatches.push({ path: 'orangefive.payload.lock.json', reason: 'schema-invalid' });
  if (lock.product !== 'Orange' || lock.release !== 'OrangeFive') mismatches.push({ path: 'orangefive.payload.lock.json', reason: 'release-identity-invalid' });
  if (lock.hashAlgorithm !== 'sha256') mismatches.push({ path: 'orangefive.payload.lock.json', reason: 'hash-algorithm-invalid' });
  if (!Number.isSafeInteger(Number(lock.fileCount)) || Number(lock.fileCount) !== files.length) {
    mismatches.push({ path: 'orangefive.payload.lock.json', reason: 'file-count-invalid', declared: lock.fileCount, actual: files.length });
  }
  const listed = new Set();
  for (const file of files) {
    const relativePath = String(file?.path || '').replaceAll('\\', '/');
    const parts = relativePath.split('/');
    if (!relativePath || path.posix.isAbsolute(relativePath) || parts.some((part) => !part || part === '.' || part === '..')) {
      mismatches.push({ path: relativePath || null, reason: 'path-unsafe' });
      continue;
    }
    if (relativePath === 'orangefive.payload.lock.json') {
      mismatches.push({ path: relativePath, reason: 'lock-self-reference-forbidden' });
      continue;
    }
    if (listed.has(relativePath.toLowerCase())) {
      mismatches.push({ path: relativePath, reason: 'duplicate-path' });
      continue;
    }
    listed.add(relativePath.toLowerCase());
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 || ''))) {
      mismatches.push({ path: relativePath, reason: 'sha256-invalid' });
      continue;
    }
    if (!Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) < 0) {
      mismatches.push({ path: relativePath, reason: 'bytes-invalid' });
      continue;
    }
    const absolutePath = path.resolve(sourceRoot, relativePath);
    if (!isPathInside(absolutePath, sourceRoot, true) || !existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      mismatches.push({ path: relativePath, reason: 'missing-or-not-regular-file' });
      continue;
    }
    const bytes = readFileSync(absolutePath);
    if (bytes.length !== Number(file.bytes)) {
      mismatches.push({ path: relativePath, reason: 'bytes-mismatch', expected: Number(file.bytes), actual: bytes.length });
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== file.sha256) mismatches.push({ path: relativePath, reason: 'sha256-mismatch', expected: file.sha256, actual });
  }
  for (const relativePath of walkFiles(sourceRoot)) {
    if (relativePath === 'orangefive.payload.lock.json' || listed.has(relativePath.toLowerCase())) continue;
    mismatches.push({ path: relativePath, reason: 'unexpected-file' });
  }
  return {
    present: true,
    verified: mismatches.length === 0,
    lockPath,
    fileCount: files.length,
    lockSha256: sha256(readFileSync(lockPath)),
    mismatches,
  };
}

export function verifyPlannedPayload(sourceRoot, payloadFingerprint, expectedPackageLock) {
  const critical = verifyPayloadFingerprint(sourceRoot, payloadFingerprint);
  const actualPackageLock = verifyPayloadLock(sourceRoot);
  const mismatches = critical.mismatches.map((item) => ({ scope: 'critical-fingerprint', ...item }));
  if (Boolean(expectedPackageLock?.present) !== actualPackageLock.present) {
    mismatches.push({ scope: 'package-lock', reason: 'presence-changed', expected: Boolean(expectedPackageLock?.present), actual: actualPackageLock.present });
  } else if (expectedPackageLock?.present) {
    if (!actualPackageLock.verified) {
      mismatches.push(...actualPackageLock.mismatches.map((item) => ({ scope: 'package-lock', ...item })));
    }
    if (actualPackageLock.lockSha256 !== expectedPackageLock.lockSha256) {
      mismatches.push({ scope: 'package-lock', reason: 'lock-sha256-changed', expected: expectedPackageLock.lockSha256, actual: actualPackageLock.lockSha256 });
    }
  }
  return { ok: mismatches.length === 0, mismatches, critical, packageLock: actualPackageLock };
}

export function parseVersion(value) {
  const match = String(value || '').match(/(?<!\d)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseVersion(left);
  const b = Array.isArray(right) ? right : parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function roundGiB(bytes) {
  return Math.round((Number(bytes || 0) / (1024 ** 3)) * 10) / 10;
}

export function selectHardwareProfile(ramBytes, profiles) {
  const ramGiB = Number(ramBytes || 0) / (1024 ** 3);
  const entries = Object.entries(profiles || {}).sort((a, b) => Number(a[1].minimumRamGiB) - Number(b[1].minimumRamGiB));
  let selected = entries[0]?.[0] || 'compact';
  for (const [name, profile] of entries) {
    if (ramGiB >= Number(profile.minimumRamGiB || 0)) selected = name;
  }
  return selected;
}

export function localHardwareSnapshot(sourceRoot, dataRoot) {
  let disk = { path: path.parse(dataRoot).root || dataRoot, totalBytes: null, availableBytes: null };
  try {
    const probePath = existsSync(dataRoot) ? dataRoot : (existsSync(path.dirname(dataRoot)) ? path.dirname(dataRoot) : sourceRoot);
    const stats = statfsSync(probePath);
    disk = {
      path: path.parse(dataRoot).root || dataRoot,
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch {
    // Disk capacity remains explicit unknown evidence when the platform cannot report it.
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    ramBytes: os.totalmem(),
    ramGiB: roundGiB(os.totalmem()),
    logicalCores: os.cpus().length,
    userProfile: process.env.USERPROFILE || os.homedir(),
    disk,
    networkInterfaces: Object.entries(os.networkInterfaces()).flatMap(([name, rows]) =>
      (rows || []).filter((row) => row && !row.internal).map((row) => ({
        name,
        address: row.address,
        family: row.family,
        cidr: row.cidr || null,
      })),
    ).sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address)),
  };
}

function normalizeComponent(id, observed, requirement = {}) {
  const found = observed?.found === true || observed?.serviceReady === true;
  const compatible = observed?.compatible === true;
  return {
    id,
    required: requirement.required === true,
    found,
    compatible,
    adoptable: found && compatible,
    version: observed?.version || null,
    minimum: requirement.minimum || null,
    pinnedVersion: requirement.pinnedVersion || null,
    executable: observed?.executable || null,
    serviceReady: observed?.serviceReady === true,
    serviceUrl: observed?.serviceUrl || null,
    availableVersion: observed?.availableVersion || null,
    evidence: observed?.evidence || (found ? 'observed' : 'not-found'),
    node: observed?.node || requirement.node || 'control',
  };
}

function artifactSatisfied(spec, observed) {
  if (!observed?.exists) return false;
  if (spec.bytes != null) return Number(observed.bytes) === Number(spec.bytes);
  if (spec.minimum_bytes != null) return Number(observed.bytes) >= Number(spec.minimum_bytes);
  return true;
}

function safeAcquisitionUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return { ok: false, reason: 'download-url-must-be-credential-free-https' };
    for (const key of parsed.searchParams.keys()) {
      if (/(?:token|key|signature|credential|password|secret|auth)/i.test(key)) return { ok: false, reason: `credential-like-query-parameter:${key}` };
    }
    return { ok: true, url: parsed.href };
  } catch {
    return { ok: false, reason: 'download-url-invalid' };
  }
}

function normalizeAcquisition(role) {
  const input = role.acquisition;
  if (!input || typeof input !== 'object') return { pinned: false, issue: 'acquisition-missing', value: null };
  const revision = String(input.revision || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase() || null;
  const repository = String(input.repository || '').trim() || null;
  const rows = Array.isArray(input.files) && input.files.length ? input.files : [input];
  const files = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const urlCheck = safeAcquisitionUrl(row.url);
    if (!urlCheck.ok) return { pinned: false, issue: urlCheck.reason, value: null };
    const fileRepository = String(row.sourceRepository || row.repository || repository || '').trim();
    const fileRevision = String(row.sourceRevision || row.revision || revision).trim();
    if (!fileRevision) return { pinned: false, issue: `immutable-revision-missing:${index}`, value: null };
    if (provider === 'huggingface') {
      if (!fileRepository || !/^[a-f0-9]{40,64}$/i.test(fileRevision)) {
        return { pinned: false, issue: `huggingface-repository-or-revision-invalid:${index}`, value: null };
      }
      const parsed = new URL(urlCheck.url);
      const expectedPrefix = `/${fileRepository}/resolve/${fileRevision}/`.toLowerCase();
      if (parsed.hostname.toLowerCase() !== 'huggingface.co' || !decodeURIComponent(parsed.pathname).toLowerCase().startsWith(expectedPrefix)) {
        return { pinned: false, issue: `huggingface-url-not-revision-bound:${index}`, value: null };
      }
    }
    const sha = String(row.sha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) return { pinned: false, issue: `sha256-invalid:${index}`, value: null };
    const expectedBytes = Number(row.bytes ?? role.required_artifacts?.[index]?.bytes ?? role.required_artifacts?.[index]?.minimum_bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) return { pinned: false, issue: `download-bytes-missing:${index}`, value: null };
    const fallbackName = path.posix.basename(new URL(urlCheck.url).pathname);
    const relativePath = String(row.relativePath || row.filename || fallbackName || '').replaceAll('\\', '/');
    if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      return { pinned: false, issue: `download-relative-path-unsafe:${index}`, value: null };
    }
    files.push({
      url: urlCheck.url,
      sha256: sha,
      bytes: expectedBytes,
      relativePath,
      repository: fileRepository || null,
      revision: fileRevision,
    });
  }
  return { pinned: true, issue: null, value: { provider, repository, revision: revision || null, files } };
}

function artifactPathKey(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function joinArtifactPath(root, relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  return /^[A-Za-z]:[\\/]/.test(root) ? path.win32.join(root, ...parts) : path.join(root, ...parts);
}

export function expectedModelIntegrityFiles(role) {
  const required = role.required_artifacts || [];
  const files = new Map();
  const issues = [];
  const allowed = (candidate) => required.some((spec) => {
    const candidateKey = artifactPathKey(candidate);
    const requiredKey = artifactPathKey(spec.path);
    return spec.kind === 'directory' ? candidateKey.startsWith(`${requiredKey}/`) : candidateKey === requiredKey;
  });
  const add = (candidate, source) => {
    const filePath = String(candidate?.path || '');
    const bytes = Number(candidate?.bytes);
    const fileSha256 = String(candidate?.sha256 || '').toLowerCase();
    if (!allowed(filePath)) {
      issues.push({ reason: 'checksum-path-outside-required-artifacts', path: filePath || null, source });
      return;
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(fileSha256)) {
      issues.push({ reason: 'checksum-record-invalid', path: filePath || null, source });
      return;
    }
    const key = artifactPathKey(filePath);
    const existing = files.get(key);
    const value = { path: filePath, bytes, sha256: fileSha256, source };
    if (existing && (existing.bytes !== value.bytes || existing.sha256 !== value.sha256)) {
      issues.push({ reason: 'checksum-record-conflict', path: filePath, source });
      return;
    }
    files.set(key, existing || value);
  };

  for (const artifact of role.observedArtifacts || []) add(artifact, 'provenance-observed-artifact');
  for (const spec of required) {
    if (spec.sha256) add(spec, 'source-catalog-artifact');
  }

  const acquisition = normalizeAcquisition(role);
  if (acquisition.pinned) {
    for (const spec of required) {
      if (spec.kind === 'directory') {
        for (const file of acquisition.value.files) {
          const segments = file.relativePath.split('/');
          if (segments[0] === role.role) segments.shift();
          if (!segments.length) {
            issues.push({ reason: 'checksum-relative-path-empty', path: file.relativePath, source: 'acquisition' });
            continue;
          }
          add({ ...file, path: joinArtifactPath(spec.path, segments.join('/')) }, 'acquisition');
        }
        continue;
      }
      const matches = acquisition.value.files.filter((file) =>
        Number(file.bytes) === Number(spec.bytes)
        && path.posix.basename(file.relativePath).toLowerCase() === path.basename(spec.path).toLowerCase());
      if (matches.length === 1) add({ ...matches[0], path: spec.path }, 'acquisition');
      else if (spec.bytes != null && !spec.sha256 && !(role.observedArtifacts || []).some((item) => artifactPathKey(item.path) === artifactPathKey(spec.path))) {
        issues.push({ reason: matches.length ? 'checksum-acquisition-ambiguous' : 'checksum-acquisition-unmapped', path: spec.path, source: 'acquisition' });
      }
    }
  }

  return {
    files: [...files.values()].sort((left, right) => artifactPathKey(left.path).localeCompare(artifactPathKey(right.path))),
    issues,
  };
}

function normalizeModelInventory(catalog, observations, node) {
  return (catalog.roles || []).map((role) => {
    const modelObservation = observations?.[role.role] || {};
    const artifacts = (role.required_artifacts || []).map((spec) => {
      const evidence = (modelObservation.artifacts || []).find((item) => item.path === spec.path) || {};
      return {
        ...spec,
        exists: evidence.exists === true,
        observedBytes: Number.isFinite(Number(evidence.bytes)) ? Number(evidence.bytes) : null,
        verified: artifactSatisfied(spec, evidence),
        node,
      };
    });
    const eligible = role.availability?.lease_eligible === true;
    const acquisition = normalizeAcquisition(role);
    const expectedIntegrity = expectedModelIntegrityFiles(role);
    const checksumObservations = modelObservation.checksums || [];
    const checksumFiles = expectedIntegrity.files.map((expected) => {
      const observed = checksumObservations.find((item) => artifactPathKey(item.path) === artifactPathKey(expected.path)) || {};
      const observedBytes = Number.isFinite(Number(observed.bytes)) ? Number(observed.bytes) : null;
      const observedSha256 = /^[a-f0-9]{64}$/i.test(String(observed.sha256 || '')) ? String(observed.sha256).toLowerCase() : null;
      return {
        ...expected,
        exists: observed.exists === true,
        observedBytes,
        observedSha256,
        verified: observed.exists === true && observedBytes === expected.bytes && observedSha256 === expected.sha256,
        node,
      };
    });
    const checksumPinned = expectedIntegrity.files.length > 0 && expectedIntegrity.issues.length === 0;
    const checksumVerified = checksumPinned && checksumFiles.every((item) => item.verified);
    const installed = artifacts.length > 0 && artifacts.every((item) => item.verified) && checksumVerified;
    return {
      role: role.role,
      model: role.model,
      family: role.family || null,
      capability: role.capability,
      runtime: role.runtime,
      qualityTier: role.quality_tier || null,
      optional: true,
      eligible,
      selectedByDefault: eligible,
      installed,
      estimatedLiveBytes: Number(role.estimated_live_bytes || 0),
      downloadBytes: acquisition.value?.files.reduce((total, item) => total + item.bytes, 0) || null,
      installedBytes: artifacts.reduce((total, item) => total + Number(item.bytes || item.minimum_bytes || 0), 0) || null,
      license: role.license || null,
      redistribution: role.redistribution || null,
      provenanceStatus: role.provenanceStatus || null,
      provenanceBlockers: role.provenanceBlockers || [],
      provenanceEvidence: role.provenanceEvidence || null,
      runtimeProvisioning: role.runtimeProvisioning || null,
      observedArtifacts: role.observedArtifacts || [],
      maximumContext: role.maximum_context || null,
      practicalContext: role.practical_context || null,
      memoryEstimateConfidence: role.memory_estimate_confidence || null,
      proof: role.proof || null,
      environmentChanges: role.environment_changes || [],
      artifacts,
      checksum: {
        pinned: checksumPinned,
        verified: checksumVerified,
        files: checksumFiles,
        issues: expectedIntegrity.issues,
      },
      source: role.source || null,
      acquisitionPinned: acquisition.pinned,
      acquisitionIssue: acquisition.issue,
      acquisition: acquisition.value,
      catalogAvailability: role.availability?.state || 'unknown',
      evidence: modelObservation.evidence || (installed ? 'artifact-probe-pass' : 'artifact-probe-miss'),
    };
  }).sort((left, right) => left.role.localeCompare(right.role));
}

export function buildDiscovery({
  sourceRoot,
  dataRoot,
  manifest,
  catalog,
  observed,
  generatedAt = new Date().toISOString(),
}) {
  assertStateOutsidePayload(sourceRoot, dataRoot);
  if (manifest.schema !== 'orange.deploy.manifest.v1' || manifest.product !== 'Orange' || manifest.release !== 'OrangeFive') {
    throw new Error('Unsupported deploy manifest; expected Orange release OrangeFive.');
  }
  const payloadFingerprint = capturePayloadFingerprint(sourceRoot, manifest);
  const payloadLock = verifyPayloadLock(sourceRoot);
  const catalogFingerprint = payloadFingerprint.files.find((item) => item.path === manifest.models?.catalog)?.sha256 || null;
  const acquisitionCatalogFingerprint = payloadFingerprint.files.find((item) => item.path === manifest.models?.acquisitionCatalog)?.sha256 || null;
  const control = {
    ...observed.control,
    ramGiB: observed.control?.ramGiB ?? roundGiB(observed.control?.ramBytes),
  };
  const compute = observed.compute?.online ? {
    ...observed.compute,
    ramGiB: observed.compute?.ramGiB ?? roundGiB(observed.compute?.ramBytes),
  } : null;
  const topologyMode = compute ? 'control-plus-compute' : 'single-computer';
  const profileHardware = compute || control;
  const recommendedProfile = selectHardwareProfile(profileHardware.ramBytes, manifest.hermes?.hardwareProfiles);
  const runtimeRows = Object.fromEntries((manifest.runtimes || []).map((runtime) => [runtime.id, runtime]));
  const controlObserved = observed.componentInventory?.control || observed.components || {};
  const computeObserved = observed.componentInventory?.compute || observed.components || {};
  const componentInventory = {
    control: {
      bun: normalizeComponent('bun', controlObserved.bun, {
        required: true,
        minimum: runtimeRows.bun?.minimum,
        pinnedVersion: runtimeRows.bun?.minimum,
        node: 'control',
      }),
      ollama: normalizeComponent('ollama', controlObserved.ollama, { required: false, node: 'control' }),
      'hermes-agent': normalizeComponent('hermes-agent', controlObserved['hermes-agent'], {
        required: true,
        pinnedVersion: runtimeRows['hermes-agent']?.version,
        node: 'control',
      }),
    },
    compute: compute ? {
      ollama: normalizeComponent('ollama', computeObserved.ollama, { required: false, node: 'compute' }),
      'hermes-agent': normalizeComponent('hermes-agent', computeObserved['hermes-agent'], {
        required: true,
        pinnedVersion: runtimeRows['hermes-agent']?.version,
        node: 'compute',
      }),
    } : null,
  };
  const components = compute ? {
    bun: componentInventory.control.bun,
    ollama: componentInventory.compute.ollama,
    'hermes-agent': componentInventory.compute['hermes-agent'],
  } : {
    bun: componentInventory.control.bun,
    ollama: componentInventory.control.ollama,
    'hermes-agent': componentInventory.control['hermes-agent'],
  };

  // Keep each node's inventory so selecting one-computer mode after Codexa
  // discovery never adopts a remote component or model as local.
  const modelObservations = observed.modelInventory || { control: observed.models || {}, compute: observed.models || {} };
  const modelInventory = {
    control: normalizeModelInventory(catalog, modelObservations.control, 'control'),
    compute: compute ? normalizeModelInventory(catalog, modelObservations.compute, 'compute') : null,
  };
  const optionalModels = compute ? modelInventory.compute : modelInventory.control;
  const body = {
    schema: DISCOVERY_SCHEMA,
    product: manifest.product,
    release: manifest.release,
    sourceRoot: path.resolve(sourceRoot),
    dataRoot: path.resolve(dataRoot),
    payload: {
      immutable: manifest.payload?.immutable === true,
      stateOutsidePayload: true,
      criticalFingerprint: payloadFingerprint,
      packageLock: payloadLock,
      catalogSha256: catalogFingerprint,
      acquisitionCatalogSha256: acquisitionCatalogFingerprint,
      resolvedCatalogSha256: hashObject(catalog),
    },
    topology: {
      mode: topologyMode,
      preferred: manifest.topologies?.preferred,
      control,
      compute,
      evidence: observed.topologyEvidence || (compute ? 'trusted-remote-live-probe' : 'no-trusted-remote-live-probe'),
    },
    network: observed.network || {
      controlInterfaces: control.networkInterfaces || [],
      trustedCandidates: [],
      selectedComputeHost: compute?.host || null,
    },
    hardwareProfile: {
      recommended: recommendedProfile,
      measuredNode: compute ? 'compute' : 'control',
      definition: manifest.hermes?.hardwareProfiles?.[recommendedProfile] || null,
    },
    components,
    componentInventory,
    optionalModels,
    modelInventory,
    warnings: [
      ...(payloadLock.present ? [] : ['Payload package lock is absent; critical deploy files are still hash-bound to the approved plan.']),
      ...(payloadLock.present && !payloadLock.verified ? ['Payload package lock verification failed.'] : []),
    ],
  };
  return { ...body, generatedAt, discoverySha256: hashObject(body) };
}

export function verifyDiscoveryHash(discovery) {
  const { generatedAt: _generatedAt, discoverySha256: _discoverySha256, receiptPath: _receiptPath, ...body } = discovery;
  const actual = hashObject(body);
  return { ok: actual === discovery.discoverySha256, expected: discovery.discoverySha256, actual };
}

function action(id, kind, fields = {}) {
  return { id, kind, mutates: false, resumable: true, rollback: 'preserve', ...fields };
}

function selectedModelsFrom(discovery, selections = {}) {
  const selected = new Set(discovery.optionalModels.filter((item) => item.selectedByDefault).map((item) => item.role));
  for (const role of selections.deselect || []) selected.delete(role);
  for (const role of selections.select || []) selected.add(role);
  if (selections.deselectAll) selected.clear();
  const known = new Set(discovery.optionalModels.map((item) => item.role));
  const unknown = [...selected].filter((role) => !known.has(role));
  if (unknown.length) throw new Error(`Unknown optional model role(s): ${unknown.join(', ')}`);
  return discovery.optionalModels.map((item) => ({ ...item, selected: selected.has(item.role) }));
}

function installActionForComponent(component, runtime, context) {
  if (component.id === 'bun') {
    return action('component.bun.install', 'component.install', {
      mutates: true,
      target: 'control',
      component: 'bun',
      version: component.pinnedVersion,
      command: { executable: 'winget', args: ['install', '--id', runtime.windowsPackageId, '--exact', '--version', component.pinnedVersion, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] },
    });
  }
  if (component.id === 'ollama') {
    return action('component.ollama.install', 'component.install', {
      mutates: true,
      target: component.node,
      component: 'ollama',
      version: component.availableVersion,
      command: { executable: 'winget', args: ['install', '--id', runtime.windowsPackageId, '--exact', '--version', component.availableVersion, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'] },
    });
  }
  return action('component.hermes-agent.install', 'component.install', {
    mutates: true,
    target: component.node,
    component: 'hermes-agent',
    version: runtime.version,
    tag: runtime.tag,
    commit: runtime.commit,
    overlay: runtime.overlay,
    command: {
      executable: 'powershell.exe',
      script: `${runtime.overlay}/scripts/install-hermes-product.ps1`,
      args: ['-Apply', '-SwarmProfile', context.hardwareProfile],
    },
  });
}

export function planHash(plan) {
  const {
    generatedAt: _generatedAt,
    planSha256: _planSha256,
    receiptPath: _receiptPath,
    approvalCommand: _approvalCommand,
    ...body
  } = plan;
  return hashObject(body);
}

function modelApprovalRows(models, target) {
  return models.map((model) => ({
    role: model.role,
    model: model.model,
    runtime: model.runtime,
    target,
    installed: model.installed,
    revision: model.acquisition?.revision || null,
    files: model.acquisition?.files || [],
    license: model.license || null,
    redistribution: model.redistribution || null,
    provenanceStatus: model.provenanceStatus || null,
    provenanceBlockers: model.provenanceBlockers || [],
    provenanceEvidence: model.provenanceEvidence || null,
    runtimeProvisioning: model.runtimeProvisioning || null,
    checksum: model.checksum || { pinned: false, verified: false, files: [], issues: [] },
  }));
}

export function verifyModelSet(plan) {
  const target = plan.topology?.compute ? 'compute' : 'control';
  const selected = (plan.optionalModels || []).filter((model) => model.selected);
  const calculatedModels = modelApprovalRows(selected, target);
  const calculatedSha256 = calculatedModels.length ? hashObject(calculatedModels) : null;
  const declaredModels = plan.approval?.selectedModels || [];
  const declaredSha256 = plan.approval?.modelSetSha256 || null;
  const explicitRequired = calculatedModels.length > 0;
  return {
    ok: stableJson(declaredModels) === stableJson(calculatedModels)
      && declaredSha256 === calculatedSha256
      && plan.approval?.explicitModelSetApproval === explicitRequired,
    expected: declaredSha256,
    actual: calculatedSha256,
    explicitRequired,
    selectedModelsMatch: stableJson(declaredModels) === stableJson(calculatedModels),
  };
}

export function buildPlan({
  discovery,
  manifest,
  selections = {},
  generatedAt = new Date().toISOString(),
}) {
  const discoveryIntegrity = verifyDiscoveryHash(discovery);
  if (!discoveryIntegrity.ok) throw new Error('Discovery hash verification failed; rerun discover.');
  const requestedTopology = selections.topology || discovery.topology.mode;
  if (!(manifest.topologies?.supported || []).includes(requestedTopology)) throw new Error(`Unsupported topology: ${requestedTopology}`);
  const useCompute = requestedTopology === 'control-plus-compute';
  const topology = {
    mode: requestedTopology,
    control: discovery.topology.control,
    compute: useCompute ? discovery.topology.compute : null,
  };
  const profileNode = topology.compute || topology.control;
  const hardwareProfile = selections.profile || selectHardwareProfile(profileNode?.ramBytes, manifest.hermes?.hardwareProfiles);
  if (!manifest.hermes?.hardwareProfiles?.[hardwareProfile]) throw new Error(`Unsupported Hermes hardware profile: ${hardwareProfile}`);
  const topologyModels = useCompute
    ? (discovery.modelInventory?.compute || discovery.optionalModels)
    : (discovery.modelInventory?.control || discovery.optionalModels);
  const models = selectedModelsFrom({ ...discovery, optionalModels: topologyModels }, selections);
  const selectedModels = models.filter((item) => item.selected);
  const computeState = topology.compute?.userProfile
    ? path.win32.join(topology.compute.userProfile, 'OrangeBox-Data', 'orange5')
    : null;
  if (useCompute && selections.storage && !path.win32.isAbsolute(selections.storage)) {
    throw new Error('Two-host model storage must be an absolute Windows path on Codexa.');
  }
  const modelStore = useCompute
    ? path.win32.resolve(selections.storage || path.win32.join(computeState || 'C:\\OrangeBox-Data\\orange5', 'models'))
    : path.resolve(selections.storage || path.join(discovery.dataRoot, 'models'));
  assertStateOutsidePayload(discovery.sourceRoot, discovery.dataRoot);
  if (!useCompute && isPathInside(modelStore, discovery.sourceRoot, true)) throw new Error('Model storage must be outside the immutable payload.');

  const runtimes = Object.fromEntries((manifest.runtimes || []).map((runtime) => [runtime.id, runtime]));
  const selectedInventory = useCompute && discovery.componentInventory?.compute
    ? {
      bun: discovery.componentInventory.control.bun,
      ollama: discovery.componentInventory.compute.ollama,
      'hermes-agent': discovery.componentInventory.compute['hermes-agent'],
    }
    : (discovery.componentInventory?.control || discovery.components);
  const components = structuredClone(selectedInventory);
  components.bun.node = 'control';
  components.ollama.node = useCompute ? 'compute' : 'control';
  components['hermes-agent'].node = useCompute ? 'compute' : 'control';
  const requiresOllama = selectedModels.some((item) => String(item.runtime).toLowerCase().includes('ollama'));
  components.ollama.required = requiresOllama;
  const actions = [
    action('payload.verify', 'payload.verify', { target: 'control', rollback: 'none' }),
    action('state.prepare', 'state.prepare', { mutates: true, target: 'control', rollback: 'deactivate-only' }),
  ];
  if (useCompute) {
    actions.push(action('hermes.overlay.stage', 'hermes.overlay.stage', {
      mutates: true,
      target: 'compute',
      overlay: runtimes['hermes-agent']?.overlay,
      rollback: 'preserve-cache',
    }));
  }
  const blockers = [];
  const adoptedComponents = [];
  const missingComponents = [];
  const downloads = [];

  if (discovery.payload.criticalFingerprint.requiredMissing.length) {
    blockers.push({ code: 'PAYLOAD_FILES_MISSING', evidence: discovery.payload.criticalFingerprint.requiredMissing });
  }
  if (discovery.payload.packageLock.present && !discovery.payload.packageLock.verified) {
    blockers.push({ code: 'PAYLOAD_LOCK_INVALID', evidence: discovery.payload.packageLock.mismatches });
  }
  if (useCompute && !topology.compute) blockers.push({ code: 'COMPUTE_NODE_NOT_DISCOVERED', evidence: requestedTopology });
  if (useCompute && topology.compute?.hardwareProbe !== 'ssh-cim-live') {
    blockers.push({ code: 'COMPUTE_HARDWARE_NOT_PROVEN', evidence: topology.compute?.hardwareProbe || 'missing' });
  }
  if (useCompute && !computeState) blockers.push({ code: 'COMPUTE_STATE_ROOT_UNRESOLVED', evidence: topology.compute?.host || null });
  if (Number(profileNode?.ramGiB || 0) < Number(manifest.hermes?.hardwareProfiles?.compact?.minimumRamGiB || 8)) {
    blockers.push({ code: 'INSUFFICIENT_RAM', evidence: { measuredGiB: profileNode?.ramGiB || 0, minimumGiB: manifest.hermes?.hardwareProfiles?.compact?.minimumRamGiB || 8 } });
  }

  for (const id of ['bun', 'ollama', 'hermes-agent']) {
    const component = components[id];
    if (!component.required && !component.adoptable) continue;
    if (component.adoptable) {
      adoptedComponents.push(id);
      actions.push(action(`component.${id}.adopt`, 'component.adopt', {
        mutates: id === 'hermes-agent',
        target: component.node,
        component: id,
        version: component.version,
        executable: component.executable,
        evidence: component.evidence,
      }));
      continue;
    }
    missingComponents.push(id);
    if (id === 'ollama' && !component.availableVersion) {
      blockers.push({ code: 'OLLAMA_VERSION_UNRESOLVED', evidence: 'Discovery could not resolve an exact approved winget version.' });
      continue;
    }
    const install = installActionForComponent(component, runtimes[id], { hardwareProfile });
    actions.push(install);
    downloads.push({ id, version: install.version, target: install.target, resumable: true });
  }

  for (const model of selectedModels) {
    if (!model.eligible) blockers.push({ code: 'MODEL_NOT_LEASE_ELIGIBLE', evidence: model.role });
    const provenanceReceiptSha256 = String(model.provenanceEvidence?.receiptSha256 || '').toLowerCase();
    if (model.provenanceStatus !== 'verified-local-artifact'
      || model.provenanceBlockers.length > 0
      || !/^[a-f0-9]{64}$/.test(provenanceReceiptSha256)) {
      blockers.push({
        code: 'MODEL_PROVENANCE_UNVERIFIED',
        evidence: {
          role: model.role,
          status: model.provenanceStatus,
          reasons: model.provenanceBlockers || [],
          receiptSha256: provenanceReceiptSha256 || null,
        },
      });
      continue;
    }
    if (!model.license || !['upstream-download-only', 'operator-download-permitted', 'redistribution-permitted'].includes(model.redistribution)) {
      blockers.push({ code: 'MODEL_LICENSE_UNRESOLVED', evidence: { role: model.role, license: model.license, redistribution: model.redistribution } });
      continue;
    }
    if (!model.checksum?.pinned) {
      blockers.push({ code: 'MODEL_CHECKSUM_UNRESOLVED', evidence: { role: model.role, issues: model.checksum?.issues || [] } });
      continue;
    }
    const observedModelBytes = model.artifacts.some((artifact) => artifact.exists)
      || model.checksum.files.some((file) => file.exists);
    if (observedModelBytes && !model.checksum.verified) {
      blockers.push({
        code: 'MODEL_CHECKSUM_MISMATCH',
        evidence: {
          role: model.role,
          files: model.checksum.files.filter((file) => !file.verified).map((file) => ({
            path: file.path,
            expectedBytes: file.bytes,
            observedBytes: file.observedBytes,
            expectedSha256: file.sha256,
            observedSha256: file.observedSha256,
          })),
        },
      });
      continue;
    }
    if (model.installed) {
      adoptedComponents.push(`model:${model.role}`);
      actions.push(action(`model.${model.role}.adopt`, 'model.adopt', {
        target: topology.compute ? 'compute' : 'control',
        role: model.role,
        model: model.model,
        artifacts: model.artifacts,
        checksums: model.checksum.files,
      }));
      continue;
    }
    missingComponents.push(`model:${model.role}`);
    if (!model.acquisitionPinned) {
      blockers.push({ code: 'MODEL_ACQUISITION_NOT_PINNED', evidence: { role: model.role, source: model.source, reason: model.acquisitionIssue } });
      continue;
    }
    if (model.runtimeProvisioning === 'adopt-only') {
      blockers.push({
        code: 'MODEL_RUNTIME_ADOPT_ONLY',
        evidence: { role: model.role, runtime: model.runtime, reason: 'No clean-install runtime provisioner is proven for this role.' },
      });
      continue;
    }
    const files = model.acquisition.files.map((file) => ({
      ...file,
      destination: useCompute
        ? path.win32.join(modelStore, ...file.relativePath.split('/'))
        : path.join(modelStore, ...file.relativePath.split('/')),
    }));
    const download = action(`model.${model.role}.download`, 'model.download', {
      mutates: true,
      target: topology.compute ? 'compute' : 'control',
      role: model.role,
      model: model.model,
      acquisition: model.acquisition,
      files,
      method: useCompute ? 'remote-native-powershell-http-range' : 'native-fetch-http-range',
      rollback: 'preserve-owned-partials-and-verified-assets',
    });
    actions.push(download);
    downloads.push({
      id: `model:${model.role}`,
      bytes: files.reduce((total, item) => total + item.bytes, 0),
      target: download.target,
      method: download.method,
      resumable: true,
      files: files.map((file) => ({ destination: file.destination, bytes: file.bytes, sha256: file.sha256, source: file.url })),
    });
  }

  const requiredDownloadBytes = downloads.reduce((total, item) => total + Number(item.bytes || 0), 0);
  const diskNode = useCompute ? topology.compute : topology.control;
  const availableBytes = Number(diskNode?.disk?.availableBytes || 0);
  const reserveBytes = Number(manifest.downloads?.minimumFreeReserveGiB || 10) * (1024 ** 3);
  if (requiredDownloadBytes && availableBytes && requiredDownloadBytes + reserveBytes > availableBytes) {
    blockers.push({ code: 'INSUFFICIENT_DISK', evidence: { requiredBytes: requiredDownloadBytes, reserveBytes, availableBytes, target: useCompute ? 'compute' : 'control' } });
  }

  actions.push(action('hermes.gateway.ensure', 'hermes.gateway.ensure', {
    mutates: true,
    target: useCompute ? 'compute' : 'control',
    networkBinding: 'loopback-only',
    rollback: 'stop-owned-process',
  }));
  actions.push(action('orange.clients.configure', 'orange.clients.configure', {
    mutates: true,
    target: 'control',
    installer: manifest.configuration?.orangeFiveClientInstaller,
    mcpServer: manifest.configuration?.brainMcpServer,
    rollback: 'restore-only-if-installed-hash-is-current',
  }));
  actions.push(action('deployment.activate', 'deployment.activate', { mutates: true, target: 'control', rollback: 'deactivate' }));
  const modelApproval = modelApprovalRows(selectedModels, useCompute ? 'compute' : 'control');
  const modelSetSha256 = modelApproval.length ? hashObject(modelApproval) : null;
  const body = {
    schema: PLAN_SCHEMA,
    product: manifest.product,
    release: manifest.release,
    sourceRoot: discovery.sourceRoot,
    dataRoot: discovery.dataRoot,
    immutablePayload: true,
    payloadFingerprint: discovery.payload.criticalFingerprint,
    packageLock: discovery.payload.packageLock,
    catalogSha256: discovery.payload.catalogSha256,
    acquisitionCatalogSha256: discovery.payload.acquisitionCatalogSha256,
    resolvedCatalogSha256: discovery.payload.resolvedCatalogSha256,
    discoverySha256: discovery.discoverySha256,
    topology,
    hardware: {
      control: topology.control,
      compute: topology.compute,
    },
    hermes: {
      profile: hardwareProfile,
      settings: manifest.hermes.hardwareProfiles[hardwareProfile],
      gatewayOwners: manifest.hermes.gatewayOwners,
      dispatchers: manifest.hermes.dispatchers,
      swarmgate: manifest.hermes.swarmgate,
      swarmSentinel: manifest.hermes.swarmSentinel,
      executionWaves: [
        { wave: 1, purpose: 'gateway-owner-and-dispatcher', maxParallel: 1 },
        { wave: 2, purpose: 'immediate-profile-workers', maxParallel: manifest.hermes.hardwareProfiles[hardwareProfile].immediateWorkers, profiles: manifest.hermes.profiles || [] },
        { wave: 3, purpose: 'durable-tasks', maxParallel: manifest.hermes.hardwareProfiles[hardwareProfile].durableTasks },
      ],
      sentinel: {
        liveRamCeilingGiB: manifest.hermes.hardwareProfiles[hardwareProfile].liveRamCeilingGiB || manifest.models?.defaultLiveRamCeilingGiB || null,
        collisionPolicy: 'stop-on-overlap',
        failureAmplificationPolicy: 'halt-wave',
      },
    },
    storage: { state: discovery.dataRoot, computeState, models: modelStore },
    network: discovery.network,
    components,
    optionalModels: models,
    adoptedComponents: adoptedComponents.sort(),
    missingComponents: missingComponents.sort(),
    downloads,
    actions,
    blockers,
    executable: blockers.length === 0,
    dryRunRequiredBeforeMutation: true,
    approval: {
      required: true,
      bindsPlanSha256: true,
      explicitModelSetApproval: modelApproval.length > 0,
      modelSetSha256,
      selectedModels: modelApproval,
    },
  };
  const plan = { ...body, generatedAt };
  const planSha256 = planHash(plan);
  const modelFlag = modelSetSha256 ? ` --approve-models ${modelSetSha256}` : '';
  return {
    ...plan,
    planSha256,
    approvalCommand: `bun scripts/llm-deploy/orange-deploy.mjs apply --approve ${planSha256}${modelFlag}`,
  };
}

export function verifyPlan(plan) {
  const actual = planHash(plan);
  return { ok: plan.schema === PLAN_SCHEMA && actual === plan.planSha256, expected: plan.planSha256, actual };
}

export function sanitizeRoleList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
