import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEDGER_SCHEMA,
  READINESS_SCHEMA,
  assertStateOutsidePayload,
  deployPaths,
  hashObject,
  verifyPlannedPayload,
  verifyModelSet,
  verifyPlan,
  writeJsonAtomic,
} from './deploy-core.mjs';
import { downloadApprovedModel, hashFile, remoteDownloadScript } from './deploy-downloads.mjs';
import {
  configureOrangeClients,
  preflightOrangeClients,
  rollbackOrangeClients,
  verifyOrangeClients,
} from './deploy-clients.mjs';

function command(executable, args, { cwd, env = process.env, timeoutMs = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    shell: false,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0 || result.error) {
    throw new Error(`${executable} failed (${result.status ?? 'spawn'}): ${result.error?.message || stderr || stdout || 'no output'}`);
  }
  return { status: result.status, stdout, stderr };
}

function powershellEncoded(script, options = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], options);
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(paths) {
  mkdirSync(paths.deployRoot, { recursive: true });
  try {
    const descriptor = openSync(paths.lock, 'wx');
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() })}\n`, 'utf8');
    closeSync(descriptor);
  } catch (error) {
    let owner = null;
    try { owner = JSON.parse(readFileSync(paths.lock, 'utf8')); } catch {}
    if (owner?.pid && !processExists(owner.pid)) {
      rmSync(paths.lock, { force: true });
      return acquireLock(paths);
    }
    throw new Error(`Another deploy operation owns ${paths.lock}${owner?.pid ? ` (pid ${owner.pid})` : ''}.`);
  }
  return () => rmSync(paths.lock, { force: true });
}

export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { return { schema: LEDGER_SCHEMA, sequence: index + 1, event: 'ledger.invalid', raw: line }; }
  });
}

function appendLedger(paths, entry, now = () => new Date().toISOString(), sequenceState = null) {
  const sequence = sequenceState ? (sequenceState.value += 1) : readLedger(paths.ledger).length + 1;
  const row = {
    schema: LEDGER_SCHEMA,
    sequence,
    at: now(),
    ...entry,
  };
  appendFileSync(paths.ledger, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function writeRuntimeReceipt(paths, kind, payload, now = () => new Date().toISOString()) {
  const createdAt = now();
  const contentSha256 = hashObject(payload);
  const stamp = createdAt.replace(/[:.]/g, '-');
  const receiptPath = path.join(paths.receipts, `${kind}-${stamp}-${contentSha256.slice(0, 12)}.json`);
  writeJsonAtomic(receiptPath, {
    schema: 'orange.deploy.stage-receipt.v1',
    kind,
    createdAt,
    contentSha256,
    payload,
  });
  return receiptPath;
}

function latestActionEvents(ledger, planSha256) {
  const rows = ledger.filter((item) => item.planSha256 === planSha256 && item.actionId);
  const latest = new Map();
  for (const row of rows) latest.set(row.actionId, row);
  return latest;
}

function unresolvedFailure(ledger, planSha256) {
  const latest = latestActionEvents(ledger, planSha256);
  return [...latest.values()].find((item) => item.event === 'action.failed' || item.event === 'dry-run.failed') || null;
}

function freshComponent(context, id) {
  return context.freshDiscovery?.components?.[id] || context.plan.components?.[id] || null;
}

function freshModel(context, role) {
  return context.freshDiscovery?.optionalModels?.find((item) => item.role === role)
    || context.plan.optionalModels?.find((item) => item.role === role)
    || null;
}

function hermesPaths(plan, target) {
  const root = target === 'compute' ? plan.storage.computeState : plan.dataRoot;
  if (!root) throw new Error(`Hermes ${target} state root is unresolved.`);
  const installRoot = path.win32.join(root, 'deploy', 'components', 'hermes');
  return {
    root,
    installRoot,
    dataRoot: path.win32.join(installRoot, 'data'),
    workspaceRoot: path.win32.join(root, 'workspaces'),
    overlay: target === 'compute'
      ? path.win32.join(root, 'deploy', 'staging', `hermes-overlay-${plan.payloadFingerprint.fingerprint.slice(0, 16)}`)
      : path.join(plan.sourceRoot, '08-HERMES', 'product-integration'),
  };
}

function windowsTool(name, env) {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const canonical = path.join(root, 'System32', 'OpenSSH', name);
  return existsSync(canonical) ? canonical : name;
}

function sshInfo(plan, env) {
  const host = plan.topology.compute?.host;
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error('Approved compute SSH host is missing or unsafe.');
  const user = String(env.ORANGE5_COMPUTE_USER || 'Atom').trim();
  const key = String(env.ORANGE5_COMPUTE_KEY || path.join(env.USERPROFILE || os.homedir(), '.ssh', 'orange_codexa_automation_ed25519')).trim();
  const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes'];
  if (key && existsSync(key)) base.push('-i', key);
  return { host, user, key, target: `${user}@${host}`, base };
}

function remotePowerShell(plan, script, env, timeoutMs = 120_000) {
  const ssh = sshInfo(plan, env);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return command(windowsTool('ssh.exe', env), [...ssh.base, ssh.target, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, timeoutMs });
}

function stageHermesOverlay(plan, context) {
  const paths = deployPaths(plan.dataRoot);
  const source = path.join(plan.sourceRoot, '08-HERMES', 'product-integration');
  const staging = path.join(paths.deployRoot, 'staging');
  const zip = path.join(staging, `hermes-overlay-${plan.payloadFingerprint.fingerprint}.zip`);
  mkdirSync(staging, { recursive: true });
  powershellEncoded(`
$ErrorActionPreference = 'Stop'
$source = '${source.replaceAll("'", "''")}'
$destination = '${zip.replaceAll("'", "''")}'
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -CompressionLevel Optimal
`, { timeoutMs: 120_000 });
  const ssh = sshInfo(plan, context.env);
  command(windowsTool('scp.exe', context.env), [...ssh.base, zip, `${ssh.target}:orangefive-hermes-overlay.zip`], { env: context.env, timeoutMs: 180_000 });
  const remote = hermesPaths(plan, 'compute');
  remotePowerShell(plan, `
$ErrorActionPreference = 'Stop'
$destination = '${remote.overlay.replaceAll("'", "''")}'
$archive = Join-Path $env:USERPROFILE 'orangefive-hermes-overlay.zip'
New-Item -ItemType Directory -Force -Path '${path.win32.dirname(remote.overlay).replaceAll("'", "''")}' | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
Remove-Item -LiteralPath $archive -Force
`, context.env, 180_000);
  return { staged: remote.overlay };
}

function powershellFile(scriptPath, scriptArgs, options = {}) {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs], options);
}

function hermesScriptArguments(plan, target, scriptName, extra = []) {
  const locations = hermesPaths(plan, target);
  const script = path.win32.join(locations.overlay, 'scripts', scriptName);
  const common = ['-InstallRoot', locations.installRoot, '-DataRoot', locations.dataRoot];
  if (scriptName !== 'preflight.ps1') common.push('-WorkspaceRoot', locations.workspaceRoot, '-AllowedRoot', locations.root);
  return { locations, script, args: [...common, ...extra] };
}

function invokeHermesScript(plan, target, scriptName, extra, context, timeoutMs = 180_000) {
  const details = hermesScriptArguments(plan, target, scriptName, extra);
  if (target === 'compute') {
    const quoted = [
      `'${String(details.script).replaceAll("'", "''")}'`,
      ...details.args.map((item) => /^-[A-Za-z][A-Za-z0-9-]*$/.test(String(item)) ? String(item) : `'${String(item).replaceAll("'", "''")}'`),
    ].join(' ');
    return remotePowerShell(plan, `& ${quoted}`, context.env, timeoutMs);
  }
  return powershellFile(details.script, details.args, { env: context.env, timeoutMs });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return null;
}

function hermesPreflight(plan, target, context, writeReceipt = false) {
  try {
    const result = invokeHermesScript(plan, target, 'preflight.ps1', writeReceipt ? ['-WriteReceipt'] : [], context, 90_000);
    const report = parseJsonOutput(result.stdout);
    return { ok: report?.status === 'READY', report, output: result.stdout };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function verifyOwnedGatewayStopped(plan, target, context) {
  const locations = hermesPaths(plan, target);
  const script = `
$launch = '${path.win32.join(locations.dataRoot, 'gateway-launch.json').replaceAll("'", "''")}'
if (-not (Test-Path -LiteralPath $launch)) { [ordered]@{ stopped = $false; reason = 'launch-manifest-absent' } | ConvertTo-Json -Compress; exit 0 }
$record = Get-Content -LiteralPath $launch -Raw | ConvertFrom-Json
$process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
if (-not $process) { [ordered]@{ stopped = $false; reason = 'process-already-stopped' } | ConvertTo-Json -Compress; exit 0 }
$actual = (Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)").ExecutablePath
if ([IO.Path]::GetFullPath($actual) -ne [IO.Path]::GetFullPath([string]$record.executable)) { throw 'Owned gateway executable mismatch; refusing to stop it.' }
Stop-Process -Id ([int]$record.pid) -Force
[ordered]@{ stopped = $true; pid = [int]$record.pid } | ConvertTo-Json -Compress
`;
  return target === 'compute' ? remotePowerShell(plan, script, context.env, 30_000) : powershellEncoded(script, { env: context.env, timeoutMs: 30_000 });
}

function externalMutationDisabled(context) {
  return context.env.ORANGE5_DEPLOY_TEST_MODE === '1' || context.env.ORANGE5_DEPLOY_DISABLE_DOWNLOADS === '1';
}

async function verifyDownloadedModel(action) {
  const evidence = [];
  for (const file of action.files || []) {
    if (!existsSync(file.destination)) return { ok: false, evidence: { destination: file.destination, reason: 'missing' } };
    const bytes = statSync(file.destination).size;
    const sha256 = await hashFile(file.destination);
    evidence.push({ destination: file.destination, bytes, sha256 });
    if (bytes !== file.bytes || sha256 !== file.sha256) return { ok: false, evidence: evidence.at(-1) };
  }
  return { ok: evidence.length > 0, evidence };
}

export async function defaultActionExecutor(action, phase, context) {
  const { plan } = context;
  if (phase === 'dry-run') {
    if (action.kind === 'payload.verify') {
      const result = verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
      if (!result.ok) throw new Error(`Payload fingerprint mismatch: ${JSON.stringify(result.mismatches)}`);
    }
    if (action.kind === 'state.prepare') assertStateOutsidePayload(plan.sourceRoot, plan.dataRoot);
    if (action.kind === 'component.adopt') {
      const component = freshComponent(context, action.component);
      if (!component?.adoptable) throw new Error(`Compatible ${action.component} is no longer available on ${action.target}.`);
    }
    if (action.kind === 'model.adopt' && !freshModel(context, action.role)?.installed) throw new Error(`Selected model ${action.role} is no longer installed.`);
    if (action.kind === 'orange.clients.configure') return await preflightOrangeClients(plan);
    const guardedExternalAction = action.kind === 'component.install'
      || action.kind === 'model.download'
      || action.kind === 'hermes.overlay.stage'
      || action.kind === 'hermes.gateway.ensure'
      || (action.kind === 'component.adopt' && action.component === 'hermes-agent');
    if (guardedExternalAction) {
      if (externalMutationDisabled(context)) throw new Error(`External installation/download is disabled for ${action.id}.`);
    }
    if (action.kind === 'component.install' && action.component !== 'hermes-agent' && !action.version) throw new Error(`${action.component} install version is not pinned.`);
    if (action.kind === 'hermes.overlay.stage' && !existsSync(path.join(plan.sourceRoot, action.overlay))) throw new Error('Hermes overlay is missing from the immutable payload.');
    if (action.target === 'compute' && guardedExternalAction) {
      for (const tool of ['ssh.exe', ...(action.kind === 'hermes.overlay.stage' ? ['scp.exe'] : [])]) {
        const resolved = windowsTool(tool, context.env);
        if (resolved === tool) throw new Error(`${tool} is required for approved compute action ${action.id}.`);
      }
    }
    if (action.kind === 'hermes.gateway.ensure') {
      const locations = hermesPaths(plan, action.target);
      if (action.target === 'control' && !existsSync(path.join(locations.overlay, 'scripts', 'start-owner.ps1'))) throw new Error('Hermes gateway owner script is missing.');
    }
    return { ok: true, phase };
  }

  if (phase === 'verify') {
    if (action.kind === 'payload.verify') return verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
    if (action.kind === 'state.prepare') return { ok: existsSync(deployPaths(plan.dataRoot).components) };
    if (action.kind === 'component.adopt') return { ok: freshComponent(context, action.component)?.adoptable === true };
    if (action.kind === 'model.adopt') return { ok: freshModel(context, action.role)?.installed === true };
    if (action.kind === 'deployment.activate') {
      const active = existsSync(context.paths.activePlan) ? parseJsonOutput(readFileSync(context.paths.activePlan, 'utf8')) : null;
      return {
        ok: active?.planSha256 === plan.planSha256
          && (active?.modelSetSha256 || null) === (plan.approval?.modelSetSha256 || null),
      };
    }
    if (action.kind === 'hermes.gateway.ensure') return hermesPreflight(plan, action.target, context, false);
    if (action.kind === 'hermes.overlay.stage') return { ok: true, evidence: 'staged-overlay-preserved' };
    if (action.kind === 'component.install') {
      const component = freshComponent(context, action.component);
      return { ok: component?.adoptable === true, evidence: component?.evidence || 'fresh-probe-required' };
    }
    if (action.kind === 'model.download') return await verifyDownloadedModel(action);
    if (action.kind === 'orange.clients.configure') return await verifyOrangeClients(plan);
    return { ok: true };
  }

  if (phase === 'rollback') {
    if (action.kind === 'deployment.activate') {
      if (existsSync(context.paths.activePlan)) rmSync(context.paths.activePlan, { force: true });
      return { deactivated: true };
    }
    if (action.kind === 'hermes.gateway.ensure') return parseJsonOutput(verifyOwnedGatewayStopped(plan, action.target, context).stdout) || { stopped: false };
    if (action.kind === 'orange.clients.configure') return rollbackOrangeClients(plan, context.paths);
    return { preserved: true, reason: 'Runtimes, model assets, caches, receipts, and user data are retained for safe adoption.' };
  }

  if (phase !== 'apply') throw new Error(`Unsupported action phase: ${phase}`);
  if (action.kind === 'payload.verify') {
    const result = verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
    if (!result.ok) throw new Error(`Payload changed after approval: ${JSON.stringify(result.mismatches)}`);
    return result;
  }
  if (action.kind === 'state.prepare') {
    mkdirSync(context.paths.components, { recursive: true });
    mkdirSync(context.paths.receipts, { recursive: true });
    mkdirSync(plan.storage.models, { recursive: true });
    return { prepared: true };
  }
  if (action.kind === 'hermes.overlay.stage') return stageHermesOverlay(plan, context);
  if (action.kind === 'component.adopt') {
    if (action.component !== 'hermes-agent') return { adopted: true, version: action.version };
    return invokeHermesScript(plan, action.target, 'install-hermes-product.ps1', ['-Apply', '-ExistingHermesExe', action.executable, '-SwarmProfile', plan.hermes.profile], context, 180_000);
  }
  if (action.kind === 'component.install') {
    if (externalMutationDisabled(context)) throw new Error(`External installation/download is disabled for ${action.id}.`);
    if (action.component === 'hermes-agent') {
      return invokeHermesScript(plan, action.target, 'install-hermes-product.ps1', ['-Apply', '-SwarmProfile', plan.hermes.profile], context, 30 * 60_000);
    }
    if (action.target === 'compute') {
      const quoted = [action.command.executable, ...action.command.args].map((item) => `'${String(item).replaceAll("'", "''")}'`).join(' ');
      return remotePowerShell(plan, `& ${quoted}`, context.env, 30 * 60_000);
    }
    return command(action.command.executable, action.command.args, { env: context.env, timeoutMs: 30 * 60_000 });
  }
  if (action.kind === 'model.adopt') return { adopted: true, role: action.role };
  if (action.kind === 'model.download') {
    if (externalMutationDisabled(context)) throw new Error(`External installation/download is disabled for ${action.id}.`);
    if (action.target === 'compute') {
      const result = remotePowerShell(plan, remoteDownloadScript(action), context.env, 30 * 60_000);
      const parsed = parseJsonOutput(result.stdout);
      if (parsed?.status !== 'VERIFIED') throw new Error(`Codexa model download returned invalid evidence for ${action.role}.`);
      return parsed;
    }
    return downloadApprovedModel(action);
  }
  if (action.kind === 'hermes.gateway.ensure') {
    const ready = hermesPreflight(plan, action.target, context, false);
    if (ready.ok) return { adopted: true, preflight: ready.report };
    invokeHermesScript(plan, action.target, 'start-owner.ps1', ['-Apply'], context, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const proof = hermesPreflight(plan, action.target, context, true);
    if (!proof.ok) throw new Error(`Hermes readiness failed after launch: ${proof.error || JSON.stringify(proof.report?.blockers || [])}`);
    return { started: true, preflight: proof.report };
  }
  if (action.kind === 'orange.clients.configure') return await configureOrangeClients(plan, context.paths);
  if (action.kind === 'deployment.activate') {
    writeJsonAtomic(context.paths.activePlan, {
      schema: 'orange.deploy.active-plan.v1',
      product: plan.product,
      release: plan.release,
      planSha256: plan.planSha256,
      modelSetSha256: plan.approval?.modelSetSha256 || null,
      activatedAt: context.now(),
    });
    return { activated: true };
  }
  throw new Error(`Unsupported deploy action: ${action.kind}`);
}

function isSuccessfulTerminal(event) {
  return event === 'action.completed' || event === 'action.adopted';
}

export async function applyApprovedPlan({
  plan,
  approvalHash,
  modelApprovalHash,
  paths = deployPaths(plan.dataRoot),
  freshDiscovery,
  env = process.env,
  executor = defaultActionExecutor,
  now = () => new Date().toISOString(),
}) {
  const integrity = verifyPlan(plan);
  if (!integrity.ok) throw new Error(`Stored plan hash is invalid: expected ${integrity.expected}, got ${integrity.actual}.`);
  const modelSetIntegrity = verifyModelSet(plan);
  if (!modelSetIntegrity.ok) {
    throw new Error(`Stored model set hash is invalid: expected ${modelSetIntegrity.expected}, got ${modelSetIntegrity.actual}.`);
  }
  if (approvalHash !== plan.planSha256) throw new Error(`Approval hash mismatch. Expected ${plan.planSha256}.`);
  if (plan.approval?.explicitModelSetApproval && modelApprovalHash !== plan.approval.modelSetSha256) {
    throw new Error(`Explicit model approval hash mismatch. Expected ${plan.approval.modelSetSha256}.`);
  }
  if (!plan.executable || plan.blockers.length) throw new Error(`Approved plan is blocked: ${JSON.stringify(plan.blockers)}`);
  assertStateOutsidePayload(plan.sourceRoot, plan.dataRoot);
  const payload = verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
  if (!payload.ok) throw new Error(`Payload changed after planning: ${JSON.stringify(payload.mismatches)}`);

  const release = acquireLock(paths);
  const context = { plan, paths, freshDiscovery, env, now, sequence: { value: 0 } };
  try {
    const prior = readLedger(paths.ledger);
    context.sequence.value = prior.length;
    const failure = unresolvedFailure(prior, plan.planSha256);
    if (failure) {
      appendLedger(paths, {
        event: 'plan.resume.requested',
        planSha256: plan.planSha256,
        priorFailure: { event: failure.event, actionId: failure.actionId, error: failure.error || null },
      }, now, context.sequence);
    }
    appendLedger(paths, {
      event: 'approval.accepted',
      planSha256: plan.planSha256,
      approvedHash: approvalHash,
      approvedModelSetSha256: modelApprovalHash || null,
    }, now, context.sequence);

    for (const action of plan.actions) {
      appendLedger(paths, { event: 'dry-run.started', planSha256: plan.planSha256, actionId: action.id, kind: action.kind }, now, context.sequence);
      try {
        const evidence = await executor(action, 'dry-run', context);
        appendLedger(paths, { event: 'dry-run.completed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, evidence }, now, context.sequence);
      } catch (error) {
        appendLedger(paths, { event: 'dry-run.failed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, error: error.message }, now, context.sequence);
        throw error;
      }
    }

    const completedBeforeRun = latestActionEvents(prior, plan.planSha256);
    for (const action of plan.actions) {
      const previous = completedBeforeRun.get(action.id);
      if (previous && isSuccessfulTerminal(previous.event)) {
        const verification = await executor(action, 'verify', context);
        if (verification?.ok !== false) {
          appendLedger(paths, { event: 'action.adopted', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, evidence: verification }, now, context.sequence);
          continue;
        }
      }
      appendLedger(paths, { event: 'action.started', planSha256: plan.planSha256, actionId: action.id, kind: action.kind }, now, context.sequence);
      try {
        const evidence = await executor(action, 'apply', context);
        appendLedger(paths, { event: 'action.completed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, evidence }, now, context.sequence);
      } catch (error) {
        appendLedger(paths, { event: 'action.failed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, error: error.message }, now, context.sequence);
        throw error;
      }
    }
    const report = {
      schema: 'orange.deploy.apply-report.v1',
      status: 'APPLIED',
      planSha256: plan.planSha256,
      modelSetSha256: plan.approval?.modelSetSha256 || null,
      ledgerPath: paths.ledger,
    };
    return { ...report, receiptPath: writeRuntimeReceipt(paths, 'apply', report, now) };
  } finally {
    release();
  }
}

export async function deploymentStatus({
  plan,
  paths = deployPaths(plan.dataRoot),
  freshDiscovery,
  env = process.env,
  executor = defaultActionExecutor,
  now = () => new Date().toISOString(),
  writeReceipt = true,
}) {
  const context = { plan, paths, freshDiscovery, env, now };
  const blockers = [];
  const integrity = verifyPlan(plan);
  if (!integrity.ok) blockers.push({ code: 'PLAN_HASH_INVALID', evidence: integrity });
  const modelSetIntegrity = verifyModelSet(plan);
  if (!modelSetIntegrity.ok) blockers.push({ code: 'MODEL_SET_HASH_INVALID', evidence: modelSetIntegrity });
  const payload = verifyPlannedPayload(plan.sourceRoot, plan.payloadFingerprint, plan.packageLock);
  if (!payload.ok) blockers.push({ code: 'PAYLOAD_CHANGED', evidence: payload.mismatches });
  blockers.push(...plan.blockers);

  const ledger = readLedger(paths.ledger);
  const latest = latestActionEvents(ledger, plan.planSha256);
  for (const action of plan.actions) {
    const event = latest.get(action.id);
    if (!event || !isSuccessfulTerminal(event.event)) {
      blockers.push({ code: 'ACTION_INCOMPLETE', evidence: { actionId: action.id, event: event?.event || null } });
      continue;
    }
    try {
      const verification = await executor(action, 'verify', context);
      if (verification?.ok === false) blockers.push({ code: 'ACTION_LIVE_PROBE_FAILED', evidence: { actionId: action.id, verification } });
    } catch (error) {
      blockers.push({ code: 'ACTION_LIVE_PROBE_FAILED', evidence: { actionId: action.id, error: error.message } });
    }
  }
  const rollback = existsSync(paths.rollback) ? parseJsonOutput(readFileSync(paths.rollback, 'utf8')) : null;
  const rolledBack = rollback?.planSha256 === plan.planSha256;
  const ready = !rolledBack && blockers.length === 0;
  const receiptPath = path.join(paths.receipts, `readiness-${plan.planSha256}.json`);
  const report = {
    schema: READINESS_SCHEMA,
    status: rolledBack ? 'ROLLED_BACK' : (ready ? 'READY' : 'BLOCKED'),
    ready,
    product: plan.product,
    release: plan.release,
    planSha256: plan.planSha256,
    modelSetSha256: plan.approval?.modelSetSha256 || null,
    checkedAt: now(),
    blockers,
    ledgerPath: paths.ledger,
    receiptPath,
  };
  if (writeReceipt) writeJsonAtomic(receiptPath, report);
  return report;
}

export async function rollbackDeployment({
  plan,
  paths = deployPaths(plan.dataRoot),
  env = process.env,
  executor = defaultActionExecutor,
  now = () => new Date().toISOString(),
}) {
  const integrity = verifyPlan(plan);
  if (!integrity.ok) throw new Error('Cannot rollback an invalid plan.');
  const modelSetIntegrity = verifyModelSet(plan);
  if (!modelSetIntegrity.ok) throw new Error('Cannot rollback a plan with an invalid model set.');
  const release = acquireLock(paths);
  const context = { plan, paths, env, now, sequence: { value: readLedger(paths.ledger).length } };
  const evidence = [];
  try {
    for (const action of [...plan.actions].reverse()) {
      try {
        const result = await executor(action, 'rollback', context);
        evidence.push({ actionId: action.id, result });
        appendLedger(paths, { event: 'rollback.completed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, evidence: result }, now, context.sequence);
      } catch (error) {
        evidence.push({ actionId: action.id, error: error.message });
        appendLedger(paths, { event: 'rollback.failed', planSha256: plan.planSha256, actionId: action.id, kind: action.kind, error: error.message }, now, context.sequence);
        throw error;
      }
    }
    const report = {
      schema: 'orange.deploy.rollback.v1',
      status: 'ROLLED_BACK_DATA_PRESERVED',
      planSha256: plan.planSha256,
      modelSetSha256: plan.approval?.modelSetSha256 || null,
      rolledBackAt: now(),
      evidence,
      preservation: ['user-memory', 'receipts', 'secrets', 'logs', 'model-assets', 'adopted-runtimes', 'download-cache'],
    };
    writeJsonAtomic(paths.rollback, report);
    return { ...report, receiptPath: writeRuntimeReceipt(paths, 'rollback', report, now) };
  } finally {
    release();
  }
}

export const __runtimeInternals = Object.freeze({ acquireLock, hermesPaths, latestActionEvents, unresolvedFailure, verifyDownloadedModel, writeRuntimeReceipt });
