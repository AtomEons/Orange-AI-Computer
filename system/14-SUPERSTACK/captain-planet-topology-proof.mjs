#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const DEFAULT_MANIFEST = path.join(import.meta.dirname, 'captain-planet-stack.json');
const RECEIPT_ROOT = path.join(import.meta.dirname, 'receipts');
const DEFAULT_KEY = process.env.ORANGE_CODEXA_SSH_KEY
  || path.join(os.homedir(), '.ssh', 'orange_codexa_automation_ed25519');

function assertReceiptPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(RECEIPT_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`topology receipt must remain under ${RECEIPT_ROOT}`);
  }
  return resolved;
}

export function buildProbePayload(manifest) {
  const threeD = manifest.roles.find((role) => role.role === 'three_d_hunyuan21');
  if (!threeD) throw new Error('Captain Planet registry lacks three_d_hunyuan21');
  if (!Array.isArray(threeD.installation_probe_paths) || threeD.installation_probe_paths.length === 0) {
    throw new Error('three_d_hunyuan21 lacks bounded installation_probe_paths');
  }
  return {
    mutex: manifest.policy.lease_mutex,
    markers: manifest.policy.creative_process_markers,
    three_d_role: threeD.role,
    three_d_paths: threeD.installation_probe_paths,
    ollama_base_url: manifest.ollama.worker_base_url,
  };
}

function remoteScript(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPayload}'))
$payload = ConvertFrom-Json -InputObject $payloadJson
$paths = @($payload.three_d_paths | ForEach-Object {
  [ordered]@{ path = [string]$_; exists = [bool](Test-Path -LiteralPath ([string]$_)) }
})
$markers = @($payload.markers)
$creative = @(Get-CimInstance Win32_Process | Where-Object {
  $row = $_
  $row.ProcessId -ne $PID -and $row.CommandLine -and
    ($markers | Where-Object { $_ -and $row.CommandLine -like ('*' + $_ + '*') }).Count -gt 0
} | Select-Object ProcessId,Name,CommandLine)
$ollamaModels = @()
$ollamaError = $null
try {
  $url = ([string]$payload.ollama_base_url).TrimEnd('/') + '/api/ps'
  $ollamaModels = @((Invoke-RestMethod -Uri $url -TimeoutSec 10).models |
    Select-Object name,size,size_vram,expires_at)
} catch {
  $ollamaError = $_.Exception.Message
}
$mutex = [Threading.Mutex]::new($false, [string]$payload.mutex)
$mutexAvailable = $false
try {
  $mutexAvailable = $mutex.WaitOne(0)
  if ($mutexAvailable) { $mutex.ReleaseMutex() }
} finally {
  $mutex.Dispose()
}
[ordered]@{
  captured_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  lease_mutex_available = [bool]$mutexAvailable
  creative_process_count = $creative.Count
  creative_processes = $creative
  running_ollama_model_count = $ollamaModels.Count
  running_ollama_models = $ollamaModels
  ollama_probe_error = $ollamaError
  three_d_role = [string]$payload.three_d_role
  three_d_exact_path_probe = $paths
  model_loaded_by_probe = $false
  files_written_by_probe = $false
} | ConvertTo-Json -Depth 8 -Compress
`;
}

export function evaluateTopology(manifest, remote) {
  const threeD = manifest.roles.find((role) => role.role === 'three_d_hunyuan21');
  const threeDPathsAbsent = Array.isArray(remote.three_d_exact_path_probe)
    && remote.three_d_exact_path_probe.length > 0
    && remote.three_d_exact_path_probe.every((entry) => entry.exists === false);
  const checks = {
    expected_worker_answered: String(remote.host || '').toUpperCase() === String(manifest.hosts.worker || '').toUpperCase(),
    production_lease_mutex_is_available: remote.lease_mutex_available === true,
    no_creative_worker_is_currently_active: remote.creative_process_count === 0,
    at_most_one_ollama_model_is_currently_resident: remote.running_ollama_model_count <= 1,
    ollama_residency_probe_succeeded: remote.ollama_probe_error === null,
    probe_loaded_no_model: remote.model_loaded_by_probe === false,
    probe_wrote_no_remote_file: remote.files_written_by_probe === false,
    three_d_registry_claim_is_candidate_only:
      threeD?.availability?.state === 'candidate_not_observed'
      && threeD?.availability?.lease_eligible === false,
    three_d_exact_paths_are_absent: threeDPathsAbsent,
    three_d_artifact_proof_is_absent:
      Array.isArray(threeD?.required_artifacts)
      && threeD.required_artifacts.length === 0
      && threeD?.proof?.receipt === null,
  };
  const findings = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
  return {
    schema: 'orange5.captain-planet.board8-topology-proof.v1',
    status: findings.length === 0
      ? 'CAPTAIN_PLANET_BOARD8_LIVE_TOPOLOGY_GREEN_3D_NOT_INSTALLED'
      : 'CAPTAIN_PLANET_BOARD8_LIVE_TOPOLOGY_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    execution_scope: 'NO_LOAD_NO_GENERATION_NO_INSTALL_BOUNDED_LIVE_QUERY',
    model_generation_executed: false,
    large_weight_hashes_recomputed: false,
    checks,
    findings,
    remote,
    limitations: [
      'Current process and mutex state does not prove a completed real-model lease activation.',
      'Exact negative paths are bounded evidence, not an exhaustive filesystem search.',
      'Peak process-tree and shared-GPU memory remain separate activation gates.',
    ],
  };
}

export function probeCodexa(manifest, {
  worker = manifest.hosts.worker,
  user = manifest.hosts.worker_user,
  key = DEFAULT_KEY,
} = {}) {
  if (!fs.existsSync(key)) throw new Error(`SSH key missing: ${key}`);
  const encodedScript = Buffer.from(remoteScript(buildProbePayload(manifest)), 'utf16le').toString('base64');
  const output = execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-i', key,
    `${user}@${worker}`,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`Codexa topology probe returned no JSON: ${output.slice(-1000)}`);
  return JSON.parse(line);
}

async function main() {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string', default: DEFAULT_MANIFEST },
    output: { type: 'string' },
    worker: { type: 'string' },
    user: { type: 'string' },
    key: { type: 'string', default: DEFAULT_KEY },
    'no-write': { type: 'boolean', default: false },
  } });
  const manifest = JSON.parse(fs.readFileSync(path.resolve(values.manifest), 'utf8'));
  const remote = probeCodexa(manifest, {
    worker: values.worker || manifest.hosts.worker,
    user: values.user || manifest.hosts.worker_user,
    key: values.key,
  });
  const proof = evaluateTopology(manifest, remote);
  if (values['no-write']) {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  } else {
    const stamp = proof.generated_at.replace(/[:.]/g, '-');
    const output = assertReceiptPath(values.output || path.join(RECEIPT_ROOT, `${stamp}-board8-topology-proof.json`));
    const written = writeChainedJsonReceipt(output, proof);
    process.stdout.write(`${JSON.stringify({
      status: written.status,
      checks: written.checks,
      findings: written.findings,
      receipt_path: output,
      receipt_sha256: written.receipt_sha256,
    }, null, 2)}\n`);
  }
  if (proof.findings.length > 0) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_BOARD8_TOPOLOGY_PROOF_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
