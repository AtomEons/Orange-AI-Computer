import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildDiscovery,
  compareVersions,
  expectedModelIntegrityFiles,
  localHardwareSnapshot,
  parseVersion,
  readJson,
} from './deploy-core.mjs';

function commandResult(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 5_000,
    shell: false,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout,
    stderr,
    error: result.error?.message || null,
  };
}

export function findExecutable(name, env = process.env) {
  const explicit = String(env[`ORANGE5_DEPLOY_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_EXE`] || '').trim();
  if (explicit && existsSync(explicit)) return path.resolve(explicit);
  if (process.platform === 'win32') {
    const windowsRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const canonical = [
      path.join(windowsRoot, 'System32', 'OpenSSH', name),
      path.join(windowsRoot, 'System32', name),
    ].find((candidate) => existsSync(candidate));
    if (canonical) return canonical;
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = commandResult(finder, [name], { env, timeoutMs: 5_000 });
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item && existsSync(item)) || null;
}

function probeBun(manifest, env) {
  const runtime = manifest.runtimes.find((item) => item.id === 'bun');
  const version = process.versions.bun || null;
  const executable = process.execPath;
  return {
    found: Boolean(version),
    compatible: Boolean(version && compareVersions(version, runtime.minimum) >= 0),
    version,
    executable,
    availableVersion: runtime.minimum,
    evidence: version ? `bun-runtime:${version}` : 'bun-runtime-not-found',
    node: 'control',
  };
}

function parseHighestVersion(output) {
  const versions = String(output || '').split(/\r?\n/).map((line) => parseVersion(line)?.join('.')).filter(Boolean);
  versions.sort((left, right) => compareVersions(right, left) || left.localeCompare(right));
  return versions[0] || null;
}

function resolveWingetVersion(packageId, env) {
  if (env.ORANGE5_DEPLOY_DISABLE_NETWORK === '1' || env.ORANGE5_DEPLOY_TEST_MODE === '1') return null;
  const winget = findExecutable('winget.exe', env) || findExecutable('winget', env);
  if (!winget) return null;
  const result = commandResult(winget, ['show', '--id', packageId, '--exact', '--versions', '--accept-source-agreements', '--disable-interactivity'], { env, timeoutMs: 12_000 });
  return result.ok ? parseHighestVersion(result.stdout) : null;
}

function probeLocalOllama(manifest, env) {
  const runtime = manifest.runtimes.find((item) => item.id === 'ollama');
  const executable = findExecutable('ollama.exe', env) || findExecutable('ollama', env);
  if (!executable) {
    return {
      found: false,
      compatible: false,
      version: null,
      executable: null,
      availableVersion: resolveWingetVersion(runtime.windowsPackageId, env),
      evidence: 'ollama-cli-not-found',
      node: 'control',
    };
  }
  const result = commandResult(executable, ['--version'], { env, timeoutMs: 4_000 });
  const version = parseVersion(`${result.stdout}\n${result.stderr}`)?.join('.') || null;
  return {
    found: result.ok || Boolean(version),
    compatible: Boolean(version),
    version,
    executable,
    serviceReady: false,
    availableVersion: version || resolveWingetVersion(runtime.windowsPackageId, env),
    evidence: result.ok ? `ollama-cli:${version}` : `ollama-version-probe-failed:${result.error || result.stderr}`,
    node: 'control',
  };
}

function hermesCandidates(dataRoot, env) {
  return [
    String(env.ORANGE5_HERMES_EXE || '').trim(),
    path.join(dataRoot, 'deploy', 'components', 'hermes', 'venv', 'Scripts', 'hermes.exe'),
    findExecutable('hermes.exe', env),
    findExecutable('hermes', env),
  ].filter(Boolean);
}

function probeLocalHermes(manifest, dataRoot, env) {
  const runtime = manifest.runtimes.find((item) => item.id === 'hermes-agent');
  const executable = hermesCandidates(dataRoot, env).find((item) => existsSync(item)) || null;
  if (!executable) return { found: false, compatible: false, version: null, executable: null, evidence: 'hermes-cli-not-found', node: 'control' };
  const result = commandResult(executable, ['--version'], { env, timeoutMs: 5_000 });
  const version = parseVersion(`${result.stdout}\n${result.stderr}`)?.join('.') || null;
  return {
    found: result.ok || Boolean(version),
    compatible: version === runtime.version,
    version,
    executable,
    evidence: result.ok ? `hermes-cli:${result.stdout}` : `hermes-version-probe-failed:${result.error || result.stderr}`,
    node: 'control',
  };
}

function recursiveSize(target) {
  const stats = statSync(target);
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += recursiveSize(path.join(target, entry.name));
  }
  return total;
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

async function probeLocalArtifacts(catalog) {
  const rows = await Promise.all((catalog.roles || []).map(async (role) => {
    const artifacts = (role.required_artifacts || []).map((spec) => {
      try {
        return { path: spec.path, exists: existsSync(spec.path), bytes: existsSync(spec.path) ? recursiveSize(spec.path) : null };
      } catch (error) {
        return { path: spec.path, exists: false, bytes: null, error: error.message };
      }
    });
    const checksums = await Promise.all(expectedModelIntegrityFiles(role).files.map(async (spec) => {
      try {
        const present = existsSync(spec.path) && statSync(spec.path).isFile();
        return { path: spec.path, exists: present, bytes: present ? statSync(spec.path).size : null, sha256: present ? await hashFile(spec.path) : null };
      } catch (error) {
        return { path: spec.path, exists: false, bytes: null, sha256: null, error: error.message };
      }
    }));
    return [role.role, { artifacts, checksums, evidence: 'local-filesystem-live-probe-with-sha256' }];
  }));
  return Object.fromEntries(rows);
}

function sshExecutable(env) {
  return String(env.ORANGE5_DEPLOY_SSH_EXE || '').trim() || findExecutable('ssh.exe', env) || findExecutable('ssh', env);
}

function sshArguments(host, env, encodedCommand) {
  const user = String(env.ORANGE5_COMPUTE_USER || 'Atom').trim();
  const key = String(env.ORANGE5_COMPUTE_KEY || path.join(env.USERPROFILE || os.homedir(), '.ssh', 'orange_codexa_automation_ed25519')).trim();
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-o', 'StrictHostKeyChecking=yes'];
  if (key && existsSync(key)) args.push('-i', key);
  args.push(`${user}@${host}`, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand);
  return args;
}

function remoteProbeScript(catalog, pinnedHermesVersion) {
  const specs = (catalog.roles || []).flatMap((role) => [
    ...(role.required_artifacts || []).map((spec) => ({ r: role.role, p: 'a', x: spec.path })),
    ...expectedModelIntegrityFiles(role).files.map((spec) => ({ r: role.role, p: 'c', x: spec.path })),
  ]);
  const specsBase64 = Buffer.from(JSON.stringify({ items: specs }), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$specJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${specsBase64}'))
$specDocument = $specJson | ConvertFrom-Json
$artifacts = @()
$checksums = @()
foreach ($spec in @($specDocument.items)) {
  $present = Test-Path -LiteralPath ([string]$spec.x)
  $bytes = $null
  $sha256 = $null
  if ($present) {
    $item = Get-Item -Force -LiteralPath ([string]$spec.x)
    if ($item.PSIsContainer) { $bytes = [long](Get-ChildItem -Force -File -Recurse -LiteralPath $item.FullName | Measure-Object -Property Length -Sum).Sum }
    else {
      $bytes = [long]$item.Length
      if ([string]$spec.p -eq 'c') { $sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
  }
  $row = [ordered]@{ role = [string]$spec.r; path = [string]$spec.x; exists = [bool]$present; bytes = $bytes }
  if ([string]$spec.p -eq 'c') {
    $row.sha256 = $sha256
    $checksums += $row
  } else { $artifacts += $row }
}
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$profileDrive = [IO.Path]::GetPathRoot($env:USERPROFILE).TrimEnd('\\')
$disk = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $profileDrive } | Select-Object -First 1
$hermesCandidates = @(
  (Join-Path $env:USERPROFILE 'OrangeBox-Data\\orange5\\deploy\\components\\hermes\\venv\\Scripts\\hermes.exe'),
  [string](Get-Command hermes.exe -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$hermesExe = $hermesCandidates | Select-Object -First 1
$hermesVersion = $null
if ($hermesExe) { $hermesVersion = (& $hermesExe --version 2>&1 | Out-String).Trim() }
[ordered]@{
  hostname = $env:COMPUTERNAME
  userProfile = $env:USERPROFILE
  ramBytes = [long]$cs.TotalPhysicalMemory
  logicalCores = [int]$cs.NumberOfLogicalProcessors
  platform = [string]$os.Caption
  arch = [string]$env:PROCESSOR_ARCHITECTURE
  disk = [ordered]@{
    path = $profileDrive + '\\'
    totalBytes = if ($disk) { [long]$disk.Size } else { $null }
    availableBytes = if ($disk) { [long]$disk.FreeSpace } else { $null }
  }
  hermes = [ordered]@{
    found = [bool]$hermesExe
    compatible = [bool]($hermesVersion -match '(?<![0-9])${pinnedHermesVersion.replaceAll('.', '\\.').replaceAll('-', '\\-')}(?![0-9])')
    versionOutput = $hermesVersion
    executable = $hermesExe
  }
  artifacts = $artifacts
  checksums = $checksums
} | ConvertTo-Json -Depth 8 -Compress
`;
}

function probeRemote(host, catalog, manifest, env, timeoutMs) {
  const ssh = sshExecutable(env);
  if (!ssh) return { ok: false, error: 'ssh-not-found' };
  const pinned = manifest.runtimes.find((item) => item.id === 'hermes-agent').version;
  const script = remoteProbeScript(catalog, pinned);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = commandResult(ssh, sshArguments(host, env, encoded), { env, timeoutMs: remoteProbeTimeoutMs(timeoutMs) });
  if (!result.ok) return { ok: false, error: result.error || result.stderr || `ssh-exit-${result.status}` };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `remote-json-invalid:${error.message}` };
  }
}

function remoteProbeTimeoutMs(timeoutMs) {
  // SSH startup can consume most of a short service-probe budget, while exact
  // model adoption may require hashing tens of gigabytes on the compute host.
  return Math.max(Number(timeoutMs || 0) * 8, 120_000);
}

async function probeOllamaVersion(url, timeoutMs) {
  try {
    const response = await fetch(`${String(url).replace(/\/$/, '')}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = response.ok ? await response.json() : null;
    return body?.version || null;
  } catch {
    return null;
  }
}

async function discoverFabric(sourceRoot, env, timeoutMs) {
  const modulePath = path.join(sourceRoot, '03-BACKEND', 'compute-fabric.mjs');
  if (!existsSync(modulePath)) return null;
  try {
    const fabric = await import(`${pathToFileURL(modulePath).href}?deploy=${Date.now()}`);
    return await fabric.discoverComputeFabric({ env, persist: false, timeoutMs });
  } catch (error) {
    return { operational: false, mode: 'single_machine', nodes: [], error: error.message };
  }
}

function selectRemoteNode(fabric) {
  return (fabric?.nodes || [])
    .filter((node) => node.trusted && !node.local && !node.physicalRemote)
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.priority || 0) - Number(a.priority || 0) || a.host.localeCompare(b.host))[0] || null;
}

function remoteCandidates(fabric) {
  const preferred = selectRemoteNode(fabric);
  const rows = (fabric?.nodes || [])
    .filter((node) => node.trusted && !node.local && !node.physicalRemote)
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.priority || 0) - Number(a.priority || 0) || a.host.localeCompare(b.host));
  return preferred ? [preferred, ...rows.filter((node) => node.host !== preferred.host)] : rows;
}

function stableServiceFacts(capabilities = {}) {
  const service = (name) => {
    const value = capabilities[name] || {};
    return {
      ready: value.ready === true,
      url: value.url || null,
      models: [...(value.models || [])].sort((a, b) => a.localeCompare(b)),
    };
  };
  return {
    ollama: service('ollama'),
    openai: service('openai'),
    inference: { ...service('inference'), kind: capabilities.inference?.kind || null },
    rail: {
      ready: capabilities.rail?.ready === true,
      authorized: capabilities.rail?.authorized === true,
      tokenConfigured: capabilities.rail?.tokenConfigured === true,
      status: capabilities.rail?.status || null,
      url: capabilities.rail?.url || null,
    },
    eyes: { ready: capabilities.eyes?.ready === true, url: capabilities.eyes?.url || null },
  };
}

function modelsFromRemote(catalog, remote) {
  return Object.fromEntries((catalog.roles || []).map((role) => [role.role, {
    artifacts: (remote?.artifacts || []).filter((item) => item.role === role.role).map(({ role: _role, ...item }) => item),
    checksums: (remote?.checksums || []).filter((item) => item.role === role.role).map(({ role: _role, ...item }) => item),
    evidence: remote ? 'remote-filesystem-live-probe-with-sha256' : 'remote-filesystem-probe-unavailable',
  }]));
}

export async function observeDeployment({ sourceRoot, dataRoot, manifest, catalog, fixture, env = process.env, timeoutMs = 900 }) {
  if (fixture) {
    const value = typeof fixture === 'string' ? readJson(fixture) : fixture;
    return structuredClone(value.observed || value);
  }

  const control = localHardwareSnapshot(sourceRoot, dataRoot);
  const fabric = await discoverFabric(sourceRoot, env, timeoutMs);
  const candidateProbes = [];
  let remoteNode = null;
  let remoteProbe = null;
  for (const candidate of remoteCandidates(fabric)) {
    const result = probeRemote(candidate.host, catalog, manifest, env, timeoutMs);
    candidateProbes.push({ host: candidate.host, name: candidate.name, servicesOnline: candidate.online === true, sshHardware: result.ok, error: result.ok ? null : result.error });
    if (result.ok) {
      remoteNode = candidate;
      remoteProbe = result;
      break;
    }
  }
  const remote = remoteProbe?.value || null;
  const compute = remoteNode ? {
    hostname: remote?.hostname || remoteNode.name || remoteNode.host,
    host: remoteNode.host,
    online: true,
    trusted: true,
    ramBytes: remote?.ramBytes || null,
    logicalCores: remote?.logicalCores || null,
    userProfile: remote?.userProfile || null,
    platform: remote?.platform || 'windows-remote',
    arch: remote?.arch || 'unknown',
    disk: remote?.disk || null,
    hardwareProbe: 'ssh-cim-live',
    services: stableServiceFacts(remoteNode.capabilities),
  } : null;

  const localOllama = probeLocalOllama(manifest, env);
  let remoteOllama = {
    found: false,
    compatible: false,
    version: null,
    executable: null,
    serviceReady: false,
    availableVersion: localOllama.availableVersion,
    evidence: 'codexa-ollama-service-not-ready',
    node: 'compute',
  };
  if (remoteNode?.capabilities?.ollama?.ready) {
    const version = await probeOllamaVersion(remoteNode.capabilities.ollama.url, timeoutMs);
    remoteOllama = {
      found: true,
      compatible: true,
      version,
      executable: null,
      serviceReady: true,
      serviceUrl: remoteNode.capabilities.ollama.url,
      availableVersion: version,
      evidence: `ollama-api-live:${remoteNode.capabilities.ollama.url}`,
      node: 'compute',
    };
  }

  const localHermes = probeLocalHermes(manifest, dataRoot, env);
  const hermesVersion = remote?.hermes?.versionOutput ? parseVersion(remote.hermes.versionOutput)?.join('.') : null;
  const remoteHermes = remoteNode ? {
    found: remote?.hermes?.found === true,
    compatible: remote?.hermes?.compatible === true,
    version: hermesVersion,
    executable: remote?.hermes?.executable || null,
    evidence: remote ? `hermes-remote-cli:${remote.hermes.versionOutput || 'not-found'}` : `hermes-remote-probe-unavailable:${remoteProbe?.error || 'unknown'}`,
    node: 'compute',
  } : null;
  const localModels = await probeLocalArtifacts(catalog);
  const remoteModels = remoteNode ? modelsFromRemote(catalog, remote) : null;
  const componentInventory = {
    control: { bun: probeBun(manifest, env), ollama: localOllama, 'hermes-agent': localHermes },
    compute: remoteNode ? { ollama: remoteOllama, 'hermes-agent': remoteHermes } : null,
  };

  return {
    control,
    compute,
    topologyEvidence: remoteNode ? `orange-compute-fabric:${fabric.status}` : `orange-compute-fabric:${fabric?.status || fabric?.error || 'unavailable'}`,
    network: {
      controlInterfaces: control.networkInterfaces || [],
      trustedCandidates: candidateProbes,
      selectedComputeHost: remoteNode?.host || null,
      selectionEvidence: remoteNode ? 'trusted-ssh-cim-live' : 'no-trusted-ssh-hardware-probe',
    },
    componentInventory,
    components: remoteNode
      ? { bun: componentInventory.control.bun, ollama: remoteOllama, 'hermes-agent': remoteHermes }
      : componentInventory.control,
    modelInventory: { control: localModels, compute: remoteModels },
    models: remoteModels || localModels,
  };
}

export async function discoverDeployment(options) {
  const observed = await observeDeployment(options);
  return buildDiscovery({ ...options, observed });
}

export const __probeInternals = Object.freeze({ commandResult, parseHighestVersion, probeLocalArtifacts, remoteProbeScript, remoteProbeTimeoutMs, remoteCandidates, selectRemoteNode });
