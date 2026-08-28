#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPulseCarrierClient } from '../03-BACKEND/ae-pulse-carrier.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const TOPOLOGY_PATH = process.env.ORANGE5_AE_PULSE_STATE || path.join(DATA_ROOT, 'topology', 'ae-pulse-state.json');
const EVENTS_PATH = process.env.ORANGE5_AE_PULSE_CARRIER_EVENTS || path.join(DATA_ROOT, 'topology', 'ae-pulse-carrier-events.jsonl');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'ae-pulse');
const HEALTH_URL = process.env.ORANGE5_AE_PULSE_HEALTH_URL || 'http://127.0.0.1:8906/health';
const DURATION_MS = Number(argument('--duration-ms', '10000'));

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const stableJson = (value) => JSON.stringify(stable(value));
const sleep = (ms) => Bun.sleep(ms);

async function health() {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000), cache: 'no-store' });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(`AE Pulse primary health failed: HTTP ${response.status}`);
  return body;
}

async function waitFor(predicate, timeoutMs, intervalMs = 10) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return { value, elapsedMs: performance.now() - started };
    await sleep(intervalMs);
  }
  return { value: null, elapsedMs: performance.now() - started };
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function latestReconnect() {
  let events = [];
  try {
    events = fs.readFileSync(EVENTS_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {}
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const connected = events[index];
    if (connected.kind !== 'connected') continue;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const disconnected = events[prior];
      if (disconnected.kind !== 'disconnected') continue;
      const durationMs = Date.parse(connected.at) - Date.parse(disconnected.at);
      if (durationMs >= 0) return { disconnectedAt: disconnected.at, connectedAt: connected.at, durationMs, target: connected.target };
    }
  }
  return null;
}

async function codexaTaskState() {
  const ssh = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const key = process.env.ORANGE5_CODEXA_KEY || path.join(os.homedir(), '.ssh', 'orange_codexa_automation_ed25519');
  const host = process.env.ORANGE5_CODEXA_HOST || 'CODEXA';
  const command = [
    "$ProgressPreference='SilentlyContinue'",
    "$task=Get-ScheduledTask -TaskName 'Orange5 AE Pulse Carrier' -ErrorAction Stop",
    "$info=Get-ScheduledTaskInfo -TaskName 'Orange5 AE Pulse Carrier'",
    "[pscustomobject]@{taskName=$task.TaskName;state=$task.State.ToString();lastTaskResult=$info.LastTaskResult}|ConvertTo-Json -Compress",
  ].join(';');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const child = Bun.spawn([
    ssh, '-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `Atom@${host}`,
    'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const jsonLine = stdout.split(/\r?\n/).map((line) => line.trim()).findLast((line) => line.startsWith('{'));
  if (exitCode !== 0 || !jsonLine) return { ok: false, exitCode, error: stderr.trim().slice(-500) || 'task-state-unparseable' };
  return { ok: true, ...JSON.parse(jsonLine) };
}

async function main() {
  const startedAt = new Date().toISOString();
  const initial = await health();
  await sleep(DURATION_MS);
  const steady = await health();
  const durationSeconds = DURATION_MS / 1_000;
  const idleBytes = steady.carrier.metrics.bytesSent - initial.carrier.metrics.bytesSent;
  const idleByteRate = idleBytes / durationSeconds;

  const existed = fs.existsSync(TOPOLOGY_PATH);
  const original = existed ? fs.readFileSync(TOPOLOGY_PATH) : Buffer.from('{}\n');
  const baselineHash = steady.carrier.localStateHash;
  const probeStatus = `pulse_probe_${randomUUID().replaceAll('-', '')}`;
  let variation = null;
  let restored = null;
  try {
    writeAtomic(TOPOLOGY_PATH, Buffer.from(`${JSON.stringify({ status: probeStatus })}\n`));
    variation = await waitFor(async () => {
      const current = await health();
      return current.carrier.localStateHash !== baselineHash
        && current.carrier.peerObservedLocalStateHash === current.carrier.localStateHash
        ? current : null;
    }, 3_000);
  } finally {
    if (existed) writeAtomic(TOPOLOGY_PATH, original);
    else fs.rmSync(TOPOLOGY_PATH, { force: true });
    restored = await waitFor(async () => {
      const current = await health();
      return current.carrier.localStateHash === baselineHash
        && current.carrier.peerObservedLocalStateHash === baselineHash
        ? current : null;
    }, 3_000);
  }

  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-pulse-fallback-'));
  const fallbackStarted = performance.now();
  const fallback = startPulseCarrierClient({
    targets: [
      { host: '127.0.0.1', port: 65534, label: 'unreachable-proof-path' },
      { host: '10.0.0.4', port: 8905, label: '10.0.0.4:8905' },
    ],
    healthPort: 0,
    snapshotPath: path.join(fallbackRoot, 'snapshot.json'),
    eventsPath: path.join(fallbackRoot, 'events.jsonl'),
  });
  const fallbackResult = await waitFor(() => {
    const current = fallback.snapshot();
    return current.connected && current.peerLabel === '10.0.0.4:8905' ? current : null;
  }, 10_000, 25);
  const fallbackElapsedMs = performance.now() - fallbackStarted;
  fallback.close();
  await sleep(50);
  fs.rmSync(fallbackRoot, { recursive: true, force: true });

  const task = await codexaTaskState();
  const reconnect = latestReconnect();
  const final = await health();
  const checks = {
    primaryDirectConnected: final.connected === true && final.carrier.target === '10.0.99.1:8905',
    authenticated: final.carrier.authenticated === true,
    peerReconstructedCurrentState: final.carrier.peerObservedLocalStateHash === final.carrier.localStateHash,
    steadyStateHash: initial.carrier.localStateHash === steady.carrier.localStateHash,
    idleUnderOneKilobytePerSecond: idleByteRate < 1_024,
    persistentRttP95Under50Ms: Number(final.carrier.metrics.rtt.p95Ms) < 50,
    zeroPhaseGaps: final.carrier.metrics.phaseGaps === 0,
    variationAcknowledgedUnder500Ms: Boolean(variation?.value) && variation.elapsedMs < 500,
    restorationAcknowledgedUnder500Ms: Boolean(restored?.value) && restored.elapsedMs < 500,
    wifiFallbackUnder10Seconds: Boolean(fallbackResult.value) && fallbackElapsedMs < 10_000,
    reconnectTrailPresent: Boolean(reconnect) && reconnect.durationMs < 15_000,
    codexaStartupTaskRunning: task.ok === true && task.state === 'Running' && task.lastTaskResult === 267009,
  };
  const ok = Object.values(checks).every(Boolean);
  const receipt = {
    schema: 'orange.ae-pulse.proof.v1',
    receiptId: `ae-pulse-${randomUUID()}`,
    startedAt,
    completedAt: new Date().toISOString(),
    status: ok ? 'GREEN' : 'NOT_GREEN',
    checks,
    measurements: {
      steadyDurationMs: DURATION_MS,
      idleBytes,
      idleBytesPerSecond: Number(idleByteRate.toFixed(3)),
      rtt: final.carrier.metrics.rtt,
      variationRoundtripMs: Number(variation.elapsedMs.toFixed(3)),
      restorationRoundtripMs: Number(restored.elapsedMs.toFixed(3)),
      fallbackConnectMs: Number(fallbackElapsedMs.toFixed(3)),
      primaryTarget: final.carrier.target,
      fallbackTarget: fallbackResult.value?.peerLabel || null,
      framesSent: final.carrier.metrics.framesSent,
      framesReceived: final.carrier.metrics.framesReceived,
      bytesSent: final.carrier.metrics.bytesSent,
      bytesReceived: final.carrier.metrics.bytesReceived,
      phaseGaps: final.carrier.metrics.phaseGaps,
    },
    persistence: { task, reconnect },
    evidence: {
      healthUrl: HEALTH_URL,
      eventsPath: EVENTS_PATH,
      topologyPath: TOPOLOGY_PATH,
      carrierSource: path.join(ROOT, '03-BACKEND', 'ae-pulse-carrier.mjs'),
      protocolSource: path.join(ROOT, '03-BACKEND', 'ae-pulse-protocol.mjs'),
    },
  };
  receipt.receiptHash = sha256(stableJson(receipt));
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const receiptPath = path.join(RECEIPT_DIR, `${receipt.completedAt.replaceAll(':', '-')}-${receipt.status.toLowerCase()}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(path.join(RECEIPT_DIR, 'latest.json'), `${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

await main();
