#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function normalized(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(candidate, parent) {
  const child = normalized(candidate);
  const root = normalized(parent);
  return child.startsWith(`${root}${path.sep}`);
}

function assertSafeTemporaryRoot(root) {
  const temporaryBase = path.resolve(os.tmpdir());
  if (!isInside(root, temporaryBase) || !path.basename(root).startsWith('orangefive-release-proof-')) {
    throw new Error(`Unsafe release proof temporary root: ${root}`);
  }
}

function powershellEncoded(script, timeoutMs = 180_000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, shell: false });
  if (result.status !== 0 || result.error) {
    throw new Error(`Safe ZIP extraction failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

function extractArchiveSafely(zipPath, extractRoot) {
  const escapedZip = zipPath.replaceAll("'", "''");
  const escapedRoot = extractRoot.replaceAll("'", "''");
  powershellEncoded(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = [IO.Path]::GetFullPath('${escapedZip}')
$root = [IO.Path]::GetFullPath('${escapedRoot}').TrimEnd('\\', '/')
New-Item -ItemType Directory -Force -Path $root | Out-Null
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$stream = [IO.File]::OpenRead($zipPath)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false, [Text.Encoding]::UTF8)
try {
  foreach ($entry in $archive.Entries) {
    $relative = ([string]$entry.FullName).Replace('/', '\\')
    if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative)) { throw "Unsafe ZIP entry: $($entry.FullName)" }
    $destination = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $destination.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "ZIP entry escapes proof root: $($entry.FullName)" }
    if (-not $seen.Add($destination)) { throw "Duplicate ZIP destination: $($entry.FullName)" }
    if ([string]::IsNullOrEmpty($entry.Name)) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      continue
    }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
    $input = $entry.Open()
    $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
`);
}

async function hashFile(filePath) {
  const algorithm = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => algorithm.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return algorithm.digest('hex');
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (existsSync(filePath)) rmSync(filePath, { force: true });
  try {
    renameSync(temporary, filePath);
  } catch {
    writeFileSync(filePath, readFileSync(temporary));
    rmSync(temporary, { force: true });
  }
}

function observedFixture(catalog, manifest) {
  const artifacts = Object.fromEntries((catalog.roles || []).map((role) => [role.role, {
    artifacts: (role.required_artifacts || []).map((spec) => ({ path: spec.path, exists: false, bytes: null })),
    evidence: 'extracted-release-clean-root-no-models',
  }]));
  const hermesVersion = manifest.runtimes.find((runtime) => runtime.id === 'hermes-agent')?.version || null;
  return {
    control: {
      hostname: 'ORANGEFIVE-RELEASE-PROOF',
      platform: 'win32',
      arch: 'x64',
      ramBytes: 32 * (1024 ** 3),
      logicalCores: 8,
      userProfile: 'C:\\OrangeFiveReleaseProof',
      disk: { path: 'TEMP', totalBytes: 512 * (1024 ** 3), availableBytes: 256 * (1024 ** 3) },
      networkInterfaces: [],
    },
    compute: null,
    topologyEvidence: 'deterministic-extracted-release-proof',
    network: { controlInterfaces: [], trustedCandidates: [], selectedComputeHost: null },
    components: {
      bun: { found: true, compatible: true, version: process.versions.bun, executable: process.execPath, evidence: 'proof-process', node: 'control' },
      ollama: { found: false, compatible: false, evidence: 'not-required-no-model-plan', node: 'control' },
      'hermes-agent': { found: true, compatible: true, version: hermesVersion, executable: 'proof-hermes.exe', evidence: 'proof-executor-only', node: 'control' },
    },
    models: artifacts,
  };
}

function receiptSummary(filePath, payload) {
  return {
    file: path.basename(filePath),
    schema: payload.schema,
    status: payload.status || payload.payload?.status || null,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  };
}

async function runProof(zipPath, receiptPath, proofRoot) {
  const extractRoot = path.join(proofRoot, 'payload');
  const dataRoot = path.join(proofRoot, 'state');
  const sidecarPath = `${zipPath}.sha256`;
  const zipSha256 = await hashFile(zipPath);
  if (!existsSync(sidecarPath)) throw new Error(`ZIP SHA-256 sidecar is missing: ${sidecarPath}`);
  const sidecarHash = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sidecarHash || '') || sidecarHash !== zipSha256) {
    throw new Error(`ZIP SHA-256 sidecar mismatch: expected ${sidecarHash || 'invalid'}, got ${zipSha256}.`);
  }
  extractArchiveSafely(zipPath, extractRoot);

  const core = await import(`${pathToFileURL(path.join(extractRoot, 'scripts', 'llm-deploy', 'deploy-core.mjs')).href}?proof=${Date.now()}`);
  const runtime = await import(`${pathToFileURL(path.join(extractRoot, 'scripts', 'llm-deploy', 'deploy-runtime.mjs')).href}?proof=${Date.now()}`);
  const manifest = core.readJson(path.join(extractRoot, '00-CHARTER', 'LLM-DEPLOY', 'orangefive.deploy.json'));
  const catalogPath = path.resolve(extractRoot, manifest.models.catalog);
  const acquisitionPath = path.resolve(extractRoot, manifest.models.acquisitionCatalog);
  const baseCatalog = core.readJson(catalogPath);
  const catalog = core.mergeCatalogAcquisition(baseCatalog, core.readJson(acquisitionPath), {
    sourceCatalogSha256: core.sha256(readFileSync(catalogPath)),
  });
  const packageLock = core.verifyPayloadLock(extractRoot);
  if (!packageLock.verified) throw new Error(`Extracted payload lock failed: ${JSON.stringify(packageLock.mismatches)}`);

  const generatedAt = new Date().toISOString();
  const discovery = core.buildDiscovery({
    sourceRoot: extractRoot,
    dataRoot,
    manifest,
    catalog,
    observed: observedFixture(catalog, manifest),
    generatedAt,
  });
  const plan = core.buildPlan({
    discovery,
    manifest,
    selections: { topology: 'single-computer', deselectAll: true },
    generatedAt,
  });
  if (!plan.executable || plan.blockers.length) throw new Error(`Extracted no-model proof plan is blocked: ${JSON.stringify(plan.blockers)}`);
  if (plan.approval.modelSetSha256 !== null) throw new Error('No-model release proof unexpectedly requires a model approval hash.');

  const paths = core.deployPaths(dataRoot);
  if (existsSync(paths.deployRoot)) throw new Error('Clean-install proof state existed before approval tests.');
  const markerRoot = path.join(paths.components, 'release-proof');
  const executorCalls = [];
  const proofExecutor = async (action, phase, context) => {
    executorCalls.push({ actionId: action.id, phase });
    const marker = path.join(markerRoot, `${action.id}.json`);
    if (phase === 'dry-run') return { ok: true, mode: 'deterministic-no-external-mutation' };
    if (phase === 'verify') {
      if (action.kind === 'payload.verify') return core.verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
      if (action.kind === 'deployment.activate') {
        const active = existsSync(paths.activePlan) ? core.readJson(paths.activePlan) : null;
        return { ok: active?.planSha256 === plan.planSha256 && (active?.modelSetSha256 || null) === null };
      }
      return { ok: existsSync(marker), marker: path.relative(proofRoot, marker).replaceAll('\\', '/') };
    }
    if (phase === 'rollback') {
      if (action.kind === 'deployment.activate') rmSync(paths.activePlan, { force: true });
      return { preserved: true, externalMutation: false };
    }
    if (phase !== 'apply') throw new Error(`Unexpected proof phase: ${phase}`);
    mkdirSync(markerRoot, { recursive: true });
    core.writeJsonAtomic(marker, { actionId: action.id, kind: action.kind, externalMutation: false });
    if (action.kind === 'deployment.activate') {
      core.writeJsonAtomic(paths.activePlan, {
        schema: 'orange.deploy.active-plan.v1',
        planSha256: plan.planSha256,
        modelSetSha256: null,
      });
    }
    return { applied: true, externalMutation: false };
  };

  let wrongPlanApprovalRejected = false;
  try {
    await runtime.applyApprovedPlan({
      plan,
      approvalHash: '0'.repeat(64),
      modelApprovalHash: null,
      paths,
      freshDiscovery: discovery,
      executor: proofExecutor,
    });
  } catch (error) {
    wrongPlanApprovalRejected = error.message.includes('Approval hash mismatch');
  }
  if (!wrongPlanApprovalRejected || executorCalls.length || existsSync(paths.deployRoot)) {
    throw new Error('Wrong plan approval was not rejected before mutation.');
  }

  const tamperedModelSetPlan = structuredClone(plan);
  tamperedModelSetPlan.approval.modelSetSha256 = 'f'.repeat(64);
  tamperedModelSetPlan.planSha256 = core.planHash(tamperedModelSetPlan);
  let invalidModelSetRejected = false;
  try {
    await runtime.applyApprovedPlan({
      plan: tamperedModelSetPlan,
      approvalHash: tamperedModelSetPlan.planSha256,
      modelApprovalHash: tamperedModelSetPlan.approval.modelSetSha256,
      paths,
      freshDiscovery: discovery,
      executor: proofExecutor,
    });
  } catch (error) {
    invalidModelSetRejected = error.message.includes('Stored model set hash is invalid');
  }
  if (!invalidModelSetRejected || executorCalls.length || existsSync(paths.deployRoot)) {
    throw new Error('Invalid model set was not rejected before mutation.');
  }

  const apply = await runtime.applyApprovedPlan({
    plan,
    approvalHash: plan.planSha256,
    modelApprovalHash: null,
    paths,
    freshDiscovery: discovery,
    executor: proofExecutor,
    env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1', ORANGE5_DEPLOY_DISABLE_DOWNLOADS: '1' },
  });
  const firstApplyIndex = executorCalls.findIndex((call) => call.phase === 'apply');
  if (firstApplyIndex !== plan.actions.length || executorCalls.slice(0, firstApplyIndex).some((call) => call.phase !== 'dry-run')) {
    throw new Error('Extracted clean install mutated before every dry-run completed.');
  }
  const readiness = await runtime.deploymentStatus({ plan, paths, freshDiscovery: discovery, executor: proofExecutor });
  if (!readiness.ready || readiness.status !== 'READY') throw new Error(`Extracted readiness proof failed: ${JSON.stringify(readiness.blockers)}`);
  const applyReceipt = receiptSummary(apply.receiptPath, core.readJson(apply.receiptPath));
  const readinessReceipt = receiptSummary(readiness.receiptPath, core.readJson(readiness.receiptPath));

  const preserved = path.join(paths.components, 'preserved-data.txt');
  writeFileSync(preserved, 'preserve-through-rollback\n', 'utf8');
  const preservedSha256 = await hashFile(preserved);
  const rollback = await runtime.rollbackDeployment({ plan, paths, executor: proofExecutor, env: { ...process.env, ORANGE5_DEPLOY_TEST_MODE: '1' } });
  const postRollback = await runtime.deploymentStatus({ plan, paths, freshDiscovery: discovery, executor: proofExecutor });
  if (postRollback.status !== 'ROLLED_BACK' || postRollback.ready) throw new Error('Post-rollback readiness did not report ROLLED_BACK.');
  if (!existsSync(preserved) || await hashFile(preserved) !== preservedSha256) throw new Error('Rollback did not preserve the proof data sentinel.');
  const finalPayload = core.verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
  if (!finalPayload.ok || finalPayload.packageLock.lockSha256 !== packageLock.lockSha256) {
    throw new Error(`Extracted payload changed during install or rollback: ${JSON.stringify(finalPayload.mismatches)}`);
  }

  return {
    schema: 'orangefive.deploy-release-proof.v1',
    status: 'PROVEN',
    product: 'Orange',
    release: 'OrangeFive',
    generatedAt,
    zip: { file: path.basename(zipPath), sha256: zipSha256, sidecarVerified: true },
    extractedPayload: {
      lockVerified: true,
      lockSha256: packageLock.lockSha256,
      fileCount: packageLock.fileCount,
      catalogSha256: discovery.payload.catalogSha256,
      acquisitionCatalogSha256: discovery.payload.acquisitionCatalogSha256,
      resolvedCatalogSha256: discovery.payload.resolvedCatalogSha256,
    },
    approval: { planSha256: plan.planSha256, modelSetSha256: null, noModelsSelected: true },
    hashEnforcement: {
      wrongPlanApprovalRejectedBeforeMutation: true,
      invalidModelSetRejectedBeforeMutation: true,
    },
    cleanInstall: {
      stateAbsentBeforeApply: true,
      stateCreatedOutsidePayload: existsSync(paths.deployRoot),
      allDryRunsCompletedBeforeMutation: true,
      dataRoot: path.relative(proofRoot, dataRoot).replaceAll('\\', '/'),
    },
    apply: applyReceipt,
    readiness: readinessReceipt,
    rollback: receiptSummary(rollback.receiptPath, core.readJson(rollback.receiptPath)),
    postRollback: { status: postRollback.status, ready: postRollback.ready, blockerCount: postRollback.blockers.length },
    preservation: { sentinelSha256: preservedSha256, preservedAfterRollback: true },
    payloadUnchangedAfterRollback: true,
    proofMode: 'deterministic-extracted-payload-no-external-mutation',
    externalMutation: false,
    limitations: [
      'Does not install or launch external Bun, Ollama, Hermes, model runtimes, or model weights.',
      'Does not prove network availability of pinned upstream model URLs.',
      'Runtime and model readiness still require live probes on the approved target topology.',
    ],
    receiptPath,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.zip) throw new Error('Required argument: --zip PATH');
  const zipPath = path.resolve(options.zip);
  if (!existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
  const receiptPath = path.resolve(options.receipt || path.join(path.dirname(zipPath), 'Orange-AI-Computer-Wave-4A-Green.release-proof.json'));
  const proofRoot = mkdtempSync(path.join(os.tmpdir(), 'orangefive-release-proof-'));
  assertSafeTemporaryRoot(proofRoot);
  let report;
  let failure;
  try {
    report = await runProof(zipPath, receiptPath, proofRoot);
  } catch (error) {
    failure = error;
    report = {
      schema: 'orangefive.deploy-release-proof.v1',
      status: 'BLOCKED',
      product: 'Orange',
      release: 'OrangeFive',
      generatedAt: new Date().toISOString(),
      error: error.message,
      receiptPath,
    };
  } finally {
    assertSafeTemporaryRoot(proofRoot);
    rmSync(proofRoot, { recursive: true, force: true });
  }
  report.safeTemporaryRoot = {
    parent: path.resolve(os.tmpdir()),
    namingPolicy: 'orangefive-release-proof-*',
    removed: !existsSync(proofRoot),
  };
  writeJsonAtomic(receiptPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failure) throw failure;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ schema: 'orange.deploy.error.v1', status: 'BLOCKED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
