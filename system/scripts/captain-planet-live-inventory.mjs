#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, '14-SUPERSTACK', 'captain-planet-stack.json');
const DEFAULT_OUTPUT = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'captain-planet', 'installed-lane-inventory.json');
const DEFAULT_KEY = 'C:\\Users\\a\\.ssh\\orange_codexa_automation_ed25519';

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function installed(role) {
  return String(role.availability?.state || '').startsWith('installed_');
}

function priorProof(role) {
  const receiptPath = path.resolve(ROOT, role.proof.receipt);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const sourceReceiptPath = path.resolve(receipt.source_receipt);
  const source = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
  return { receiptPath, receipt, sourceReceiptPath, source };
}

export function buildInventorySpecs(manifest) {
  const specs = [];
  for (const role of manifest.roles.filter(installed)) {
    for (const artifact of role.required_artifacts) {
      specs.push({
        role: role.role,
        evidence_kind: 'installed_component',
        path: artifact.path,
        exact_bytes: artifact.bytes ?? null,
        minimum_bytes: artifact.minimum_bytes ?? null,
        path_kind: artifact.kind ?? 'file',
        expected_sha256: null,
      });
    }
    const proof = priorProof(role);
    specs.push({
      role: role.role,
      evidence_kind: 'generated_proof_artifact',
      path: proof.source.artifact,
      exact_bytes: Number(proof.source.artifact_bytes),
      minimum_bytes: null,
      path_kind: 'file',
      expected_sha256: String(proof.source.artifact_sha256 || '').toLowerCase(),
    });
  }
  return specs;
}

function remoteInventory(specs, { worker, user, key }) {
  const specsBase64 = Buffer.from(JSON.stringify(specs), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${specsBase64}'))
$specs = ConvertFrom-Json -InputObject $json
$rows = @(foreach ($spec in @($specs)) {
  $exists = Test-Path -LiteralPath $spec.path
  $bytes = 0L
  $sha256 = $null
  if ($exists) {
    $item = Get-Item -LiteralPath $spec.path
    if ($item.PSIsContainer) {
      $sum = (Get-ChildItem -LiteralPath $spec.path -Recurse -File -ErrorAction Stop | Measure-Object Length -Sum).Sum
      if ($null -ne $sum) { $bytes = [long]$sum }
    } else {
      $bytes = [long]$item.Length
      if ($spec.expected_sha256) {
        $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $spec.path).Hash.ToLowerInvariant()
      }
    }
  }
  $sizeValid = $exists
  if ($null -ne $spec.exact_bytes) { $sizeValid = $sizeValid -and ($bytes -eq [long]$spec.exact_bytes) }
  if ($null -ne $spec.minimum_bytes) { $sizeValid = $sizeValid -and ($bytes -ge [long]$spec.minimum_bytes) }
  $hashValid = (-not $spec.expected_sha256) -or ($sha256 -eq [string]$spec.expected_sha256)
  [ordered]@{
    role = [string]$spec.role
    evidence_kind = [string]$spec.evidence_kind
    path = [string]$spec.path
    path_kind = [string]$spec.path_kind
    exists = [bool]$exists
    bytes = $bytes
    exact_bytes = $spec.exact_bytes
    minimum_bytes = $spec.minimum_bytes
    sha256 = $sha256
    expected_sha256 = $spec.expected_sha256
    size_valid = [bool]$sizeValid
    hash_valid = [bool]$hashValid
    valid = [bool]($sizeValid -and $hashValid)
  }
})
[ordered]@{
  captured_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  entries = $rows
} | ConvertTo-Json -Depth 8 -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-i', key,
    `${user}@${worker}`,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`Codexa inventory did not return JSON: ${output.slice(-1000)}`);
  return JSON.parse(line);
}

export function createInventoryReceipt(manifest, remote) {
  const installedRoles = manifest.roles.filter(installed).map((role) => role.role);
  const roleChecks = Object.fromEntries(installedRoles.map((role) => {
    const entries = remote.entries.filter((entry) => entry.role === role);
    return [role, {
      entry_count: entries.length,
      all_entries_valid: entries.length > 0 && entries.every((entry) => entry.valid),
      generated_artifact_hash_verified: entries.some((entry) => entry.evidence_kind === 'generated_proof_artifact' && entry.hash_valid),
    }];
  }));
  const allValid = Object.values(roleChecks).every((check) => check.all_entries_valid && check.generated_artifact_hash_verified);
  return {
    schema: 'orange5.captain-planet.live-installed-inventory.v1',
    status: allValid
      ? 'CAPTAIN_PLANET_LIVE_INSTALLED_ARTIFACT_INVENTORY_GREEN'
      : 'CAPTAIN_PLANET_LIVE_INSTALLED_ARTIFACT_INVENTORY_NEEDS_WORK',
    generated_at: new Date().toISOString(),
    worker_reported_at: remote.captured_at,
    worker_host: remote.host,
    installed_roles: installedRoles,
    all_valid: allValid,
    role_checks: roleChecks,
    entries: remote.entries,
    validation_scope: {
      installed_components: 'EXACT_OR_MINIMUM_BYTE_SIZE_WITHOUT_REHASHING_LARGE_MODEL_WEIGHTS',
      generated_artifacts: 'EXACT_BYTE_SIZE_AND_SHA256',
      model_weight_content_hashes_recomputed: false,
    },
    limitations: [
      'Large model weights were not rehashed by this bounded live probe.',
      'Installed inventory and artifact identity do not prove perceptual or studio quality.',
    ],
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string', default: DEFAULT_MANIFEST },
    output: { type: 'string', default: DEFAULT_OUTPUT },
    worker: { type: 'string', default: 'CODEXA' },
    user: { type: 'string', default: 'Atom' },
    key: { type: 'string', default: DEFAULT_KEY },
  } });
  if (!fs.existsSync(values.key)) throw new Error(`SSH key missing: ${values.key}`);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(values.manifest), 'utf8'));
  const specs = buildInventorySpecs(manifest);
  const remote = remoteInventory(specs, values);
  const receipt = createInventoryReceipt(manifest, remote);
  const written = writeChainedJsonReceipt(path.resolve(values.output), receipt);
  process.stdout.write(`${JSON.stringify({
    status: written.status,
    all_valid: written.all_valid,
    roles: written.role_checks,
    receipt_path: path.resolve(values.output),
    receipt_file_sha256: sha256File(path.resolve(values.output)),
  }, null, 2)}\n`);
  if (!written.all_valid) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'CAPTAIN_PLANET_LIVE_INVENTORY_FAILED', error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
