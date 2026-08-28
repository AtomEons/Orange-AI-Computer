#!/usr/bin/env bun

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const PORTS = [1337, 7419, 7430, 7431, 7432, 7440];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function fetchJson(url, timeoutMs = 3_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
}

function owners() {
  const list = PORTS.join(',');
  const script = `$rows = foreach ($port in @(${list})) { $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; if ($listener) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId=$($listener.OwningProcess)\" -ErrorAction SilentlyContinue; [pscustomobject]@{ port=$port; pid=[int]$listener.OwningProcess; name=$process.Name; executable=$process.ExecutablePath; commandLine=$process.CommandLine } } }; ConvertTo-Json -Compress -InputObject @($rows)`;
  const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error(`listener inventory failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString().trim() || '[]');
}

function exactEyesTunnel(row) {
  const executable = String(row?.executable || '').replace(/\\/g, '/').toLowerCase();
  const command = String(row?.commandLine || '').replace(/\\/g, '/');
  return Number(row?.port) === 7440
    && executable.endsWith('/ssh.exe')
    && command.toLowerCase().includes('/.ssh/orange_codexa_automation_ed25519')
    && command.includes('-L 127.0.0.1:7440:127.0.0.1:7440');
}

async function waitFor(check, timeoutMs = 75_000, intervalMs = 750) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await Bun.sleep(intervalMs);
  } while (Date.now() < deadline);
  return null;
}

const beforeRows = owners();
const before = Object.fromEntries(beforeRows.map((row) => [row.port, row]));
const initialSentinel = await fetchJson('http://127.0.0.1:7432/health');
const initialEyes = await fetchJson('http://127.0.0.1:7440/health');
const target = before[7440];
if (!initialSentinel.ok || initialSentinel.body?.ok !== true) throw new Error('link sentinel is not initially healthy');
if (!initialEyes.ok || initialEyes.body?.service !== 'colpali-ingest') throw new Error('AE Eyes is not initially healthy');
if (!exactEyesTunnel(target)) throw new Error(`port 7440 is not owned by the exact OrangeFive AE Eyes SSH tunnel: ${JSON.stringify(target)}`);

const killed = Bun.spawnSync(['taskkill.exe', '/PID', String(target.pid), '/T', '/F'], {
  stdout: 'pipe', stderr: 'pipe', windowsHide: true,
});
if (killed.exitCode !== 0) throw new Error(`exact tunnel termination failed: ${killed.stderr.toString().trim()}`);

const outageObserved = await waitFor(async () => !(await fetchJson('http://127.0.0.1:7440/health', 800)).ok, 12_000, 250);
const recovered = await waitFor(async () => {
  const [sentinel, eyes] = await Promise.all([
    fetchJson('http://127.0.0.1:7432/health'),
    fetchJson('http://127.0.0.1:7440/health'),
  ]);
  if (sentinel.ok && sentinel.body?.ok === true && eyes.ok && eyes.body?.service === 'colpali-ingest') {
    return { sentinel, eyes };
  }
  return null;
});
const afterRows = owners();
const after = Object.fromEntries(afterRows.map((row) => [row.port, row]));
const stablePorts = [1337, 7419, 7430, 7431, 7432];
const stableNeighbors = stablePorts.every((port) => before[port]?.pid === after[port]?.pid);
const replacement = after[7440];
const checks = {
  initial_sentinel_healthy: initialSentinel.ok && initialSentinel.body?.ok === true,
  initial_eyes_healthy: initialEyes.ok && initialEyes.body?.service === 'colpali-ingest',
  exact_tunnel_owner_proven: exactEyesTunnel(target),
  controlled_outage_observed: Boolean(outageObserved),
  sentinel_recovered_eyes: Boolean(recovered),
  replacement_tunnel_is_exact: exactEyesTunnel(replacement),
  replacement_pid_changed: Number(replacement?.pid) > 0 && replacement.pid !== target.pid,
  neighboring_orange_pids_unchanged: stableNeighbors,
  popup_surface_none: recovered?.sentinel?.body?.popupSurface === 'none',
};
const green = Object.values(checks).every(Boolean);
const receipt = {
  schema: 'orange5.link-sentinel-live-proof.v1',
  status: green ? 'ORANGE5_LINK_SENTINEL_GREEN' : 'ORANGE5_LINK_SENTINEL_NEEDS_WORK',
  generatedAt: new Date().toISOString(), checks,
  before: Object.fromEntries(PORTS.map((port) => [port, before[port]?.pid || null])),
  after: Object.fromEntries(PORTS.map((port) => [port, after[port]?.pid || null])),
  sentinel: recovered?.sentinel?.body || null,
};
receipt.sha256 = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-link-sentinel-live-proof.json`);
const written = writeChainedJsonReceipt(receiptPath, receipt);
process.stdout.write(`${JSON.stringify({ ...written, receiptPath }, null, 2)}\n`);
if (!green) process.exitCode = 1;
