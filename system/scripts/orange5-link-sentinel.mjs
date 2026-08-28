#!/usr/bin/env bun

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const STATE_PATH = path.join(DATA_ROOT, 'link-sentinel-latest.json');
const KEY_PATH = process.env.ORANGE5_CODEXA_SSH_KEY || path.join(os.homedir(), '.ssh', 'orange_codexa_automation_ed25519');
const KNOWN_HOSTS = path.join(DATA_ROOT, 'codexa-link-known-hosts');
const SSH_EXE = process.env.ORANGE5_SSH_EXE || path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
const USER = process.env.ORANGE5_CODEXA_USER || 'Atom';
const HOSTS = [...new Set([
  process.env.ORANGE5_CODEXA_DIRECT_HOST || '10.0.99.1',
  process.env.ORANGE5_CODEXA_HOST || 'CODEXA',
  process.env.ORANGE5_CODEXA_WIFI_HOST || '10.0.0.4',
].filter(Boolean))];
const PORT = Number(process.env.ORANGE5_LINK_SENTINEL_PORT || 7432);
const INTERVAL_MS = Math.max(5_000, Number(process.env.ORANGE5_LINK_SENTINEL_INTERVAL_MS || 15_000));

const ENDPOINTS = [
  {
    id: 'ae-eyes', localPort: 7440, remotePort: 7440, path: '/health',
    validate: (probe) => probe.ok && probe.body?.ok === true && probe.body?.service === 'colpali-ingest',
  },
  {
    id: 'qdrant', localPort: 6333, remotePort: 6333, path: '/',
    validate: (probe) => probe.ok && Boolean(probe.body?.title || probe.body?.version),
  },
];

const endpointState = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint.id, {
  status: 'starting', healthy: false, host: null, pid: null, consecutiveFailures: 0,
  reconnectAttempts: 0, nextAttemptAt: 0, lastCheckedAt: null, lastHealthyAt: null, blocker: null,
}]));
const ownedTunnels = new Map();
let cycleRunning = false;
let cycles = 0;

export function nextReconnectDelay(attempt) {
  return Math.min(120_000, 2_000 * (2 ** Math.max(0, Math.min(6, Number(attempt) || 0))));
}

export function classifyLinkState(states) {
  const rows = Object.values(states || {});
  if (rows.length > 0 && rows.every((row) => row.healthy === true)) return 'healthy';
  if (rows.some((row) => row.status === 'reconnecting' || row.status === 'starting')) return 'reconnecting';
  return 'degraded';
}

async function fetchJson(url, timeoutMs = 2_500) {
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

function tcpOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function sshBase() {
  return [
    '-i', KEY_PATH, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'ConnectTimeout=4',
    '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
  ];
}

async function runSsh(args, timeoutMs = 10_000) {
  const child = Bun.spawn([SSH_EXE, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { ok: exitCode === 0, exitCode, stdout, stderr: stderr.trim().slice(-500) };
}

async function findHealthyHost(endpoint) {
  for (const host of HOSTS) {
    const command = `curl.exe --silent --fail --max-time 4 http://127.0.0.1:${endpoint.remotePort}${endpoint.path}`;
    const result = await runSsh([...sshBase(), `${USER}@${host}`, command]);
    if (result.ok) return { host, result };
  }
  return null;
}

function spawnTunnel(endpoint, host) {
  const child = Bun.spawn([
    SSH_EXE, '-N', '-T', ...sshBase(), '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${endpoint.localPort}:127.0.0.1:${endpoint.remotePort}`,
    `${USER}@${host}`,
  ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  const owner = { child, alive: true, host, pid: child.pid };
  child.exited.then(() => { owner.alive = false; }).catch(() => { owner.alive = false; });
  ownedTunnels.set(endpoint.id, owner);
  return owner;
}

async function waitForHealth(endpoint, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const probe = await fetchJson(`http://127.0.0.1:${endpoint.localPort}${endpoint.path}`);
    if (endpoint.validate(probe)) return true;
    await Bun.sleep(350);
  } while (Date.now() < deadline);
  return false;
}

async function ensureEndpoint(endpoint) {
  const row = endpointState[endpoint.id];
  row.lastCheckedAt = new Date().toISOString();
  const local = await fetchJson(`http://127.0.0.1:${endpoint.localPort}${endpoint.path}`);
  if (endpoint.validate(local)) {
    row.status = 'healthy'; row.healthy = true; row.consecutiveFailures = 0;
    row.reconnectAttempts = 0; row.nextAttemptAt = 0; row.blocker = null;
    row.lastHealthyAt = row.lastCheckedAt;
    const owner = ownedTunnels.get(endpoint.id);
    row.pid = owner?.alive ? owner.pid : null;
    row.host = owner?.alive ? owner.host : row.host;
    return;
  }

  row.healthy = false;
  row.consecutiveFailures += 1;
  if (Date.now() < row.nextAttemptAt) {
    row.status = 'backoff';
    return;
  }

  const owner = ownedTunnels.get(endpoint.id);
  if (owner?.alive && row.consecutiveFailures < 2) {
    row.status = 'reconnecting';
    row.blocker = 'awaiting-second-failure-before-owned-tunnel-replacement';
    return;
  }
  if (owner?.alive) {
    try { owner.child.kill(); } catch {}
    ownedTunnels.delete(endpoint.id);
  }
  if (await tcpOpen(endpoint.localPort)) {
    row.status = 'degraded';
    row.blocker = `loopback-port-${endpoint.localPort}-owned-but-unhealthy`;
    row.nextAttemptAt = Date.now() + nextReconnectDelay(row.reconnectAttempts++);
    return;
  }
  if (!fs.existsSync(KEY_PATH)) {
    row.status = 'degraded'; row.blocker = `ssh-key-missing:${KEY_PATH}`;
    row.nextAttemptAt = Date.now() + nextReconnectDelay(row.reconnectAttempts++);
    return;
  }

  row.status = 'reconnecting'; row.blocker = null;
  const remote = await findHealthyHost(endpoint);
  if (!remote) {
    row.status = 'degraded'; row.blocker = 'codexa-remote-organ-unreachable';
    row.nextAttemptAt = Date.now() + nextReconnectDelay(row.reconnectAttempts++);
    return;
  }
  const next = spawnTunnel(endpoint, remote.host);
  row.pid = next.pid; row.host = remote.host;
  const healthy = await waitForHealth(endpoint);
  row.healthy = healthy;
  row.status = healthy ? 'healthy' : 'degraded';
  row.blocker = healthy ? null : 'ssh-tunnel-started-without-healthy-loopback-endpoint';
  row.lastHealthyAt = healthy ? new Date().toISOString() : row.lastHealthyAt;
  row.consecutiveFailures = healthy ? 0 : row.consecutiveFailures;
  row.reconnectAttempts = healthy ? 0 : row.reconnectAttempts + 1;
  row.nextAttemptAt = healthy ? 0 : Date.now() + nextReconnectDelay(row.reconnectAttempts);
}

function snapshot() {
  const status = classifyLinkState(endpointState);
  return {
    schema: 'orange5.link-sentinel.v1', ok: status === 'healthy', status,
    popupSurface: 'none', runtime: 'bun', pid: process.pid, cycles,
    intervalMs: INTERVAL_MS, hosts: HOSTS, endpoints: structuredClone(endpointState),
    generatedAt: new Date().toISOString(),
  };
}

function persist() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const temp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(snapshot(), null, 2)}\n`, 'utf8');
  fs.renameSync(temp, STATE_PATH);
}

async function cycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await Promise.all(ENDPOINTS.map(ensureEndpoint));
    cycles += 1;
    persist();
  } finally {
    cycleRunning = false;
  }
}

async function main() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: PORT,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health' || url.pathname === '/healthz') {
        const state = snapshot();
        return Response.json(state, { status: state.ok ? 200 : 503 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });
  await cycle();
  const timer = setInterval(cycle, INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    for (const owner of ownedTunnels.values()) if (owner.alive) try { owner.child.kill(); } catch {}
    server.stop(true);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) await main();
