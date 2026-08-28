import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  AE_PULSE_TYPES,
  createPulseFrameDecoder,
  encodePulseFrame,
} from './ae-pulse-protocol.mjs';

export const AE_PULSE_CARRIER_SCHEMA = 'orange.ae-pulse.carrier.v1';
export const AE_PULSE_DEFAULT_PORT = 8905;
export const AE_PULSE_DEFAULT_HEALTH_PORT = 8906;
export const AE_PULSE_DEFAULT_INTERVAL_MS = 1_000;

const NODE_BOOT_ID = process.env.ORANGE5_BOOT_ID
  || `${os.hostname()}:${Math.round(Date.now() - (os.uptime() * 1_000))}`;

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const SNAPSHOT_PATH = process.env.ORANGE5_AE_PULSE_CARRIER_STATE
  || path.join(DATA_ROOT, 'topology', 'ae-pulse-carrier.json');
const EVENTS_PATH = process.env.ORANGE5_AE_PULSE_CARRIER_EVENTS
  || path.join(DATA_ROOT, 'topology', 'ae-pulse-carrier-events.jsonl');
const TOPOLOGY_PATH = process.env.ORANGE5_AE_PULSE_STATE
  || path.join(DATA_ROOT, 'topology', 'ae-pulse-state.json');
const KEY_PATH = process.env.ORANGE5_AE_PULSE_KEY_FILE
  || path.join(DATA_ROOT, 'secrets', 'ae-pulse-key.txt');

const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const stableJson = (value) => JSON.stringify(stable(value));
const cleanText = (value, max = 256) => String(value ?? '').trim().slice(0, max);

function pulseKey() {
  if (process.env.ORANGE5_AE_PULSE_KEY) return process.env.ORANGE5_AE_PULSE_KEY;
  try { return fs.readFileSync(KEY_PATH, 'utf8').trim() || null; }
  catch { return null; }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function appendEvent(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function boundedBlockers(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 16)
    .map((item) => cleanText(typeof item === 'string' ? item : item?.code || item?.message || item, 192))
    .filter(Boolean);
}

export function normalizeCarrierState(input = {}) {
  const topology = input.topology || {};
  const state = {
    nodeId: cleanText(input.nodeId || os.hostname(), 96),
    role: cleanText(input.role || process.env.ORANGE5_NODE_ROLE || 'orange-node', 64),
    bootId: cleanText(input.bootId || process.env.ORANGE5_BOOT_ID || '', 96) || null,
    status: cleanText(input.status || topology.status || 'unknown', 32),
    selectedPath: cleanText(input.selectedPath || '', 192) || null,
    flowPressure: Number.isFinite(Number(input.flowPressure)) ? Number(input.flowPressure) : null,
    solarWave: input.solarWave ? {
      id: cleanText(input.solarWave.id || input.solarWave.waveId, 128) || null,
      state: cleanText(input.solarWave.state, 32) || null,
    } : null,
    custody: input.custody ? {
      active: Math.max(0, Number(input.custody.active || 0)),
      hash: cleanText(input.custody.hash, 64) || null,
    } : null,
    capabilityHash: cleanText(input.capabilityHash, 64) || null,
    worksetHash: cleanText(input.worksetHash, 64) || null,
    readyRequired: Number.isFinite(Number(input.readyRequired ?? topology.readyRequired))
      ? Number(input.readyRequired ?? topology.readyRequired) : null,
    totalRequired: Number.isFinite(Number(input.totalRequired ?? topology.totalRequired))
      ? Number(input.totalRequired ?? topology.totalRequired) : null,
    blockers: boundedBlockers(input.blockers),
  };
  state.stateHash = sha256(stableJson(state));
  return state;
}

export function stateVariation(previous, current) {
  if (!previous) return { full: current };
  const changed = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === 'stateHash') continue;
    if (stableJson(previous[key]) !== stableJson(value)) changed[key] = value;
  }
  return Object.keys(changed).length ? { changed, stateHash: current.stateHash } : null;
}

export function applyStateVariation(previous, variation) {
  const next = variation?.full
    ? { ...variation.full }
    : { ...(previous || {}), ...(variation?.changed || {}) };
  return normalizeCarrierState(next);
}

export function readLocalCarrierState(overrides = {}) {
  const topology = readJson(TOPOLOGY_PATH) || {};
  return normalizeCarrierState({
    nodeId: process.env.ORANGE5_NODE_ID || os.hostname(),
    role: process.env.ORANGE5_NODE_ROLE || (os.hostname().toUpperCase() === 'CODEXA' ? 'heavy-compute' : 'control'),
    bootId: NODE_BOOT_ID,
    topology,
    status: topology.status || 'carrier_only',
    blockers: topology.status === 'offline' ? ['local topology reports offline'] : [],
    ...overrides,
  });
}

function watchTopology(onChange) {
  const directory = path.dirname(TOPOLOGY_PATH);
  const filename = path.basename(TOPOLOGY_PATH).toLowerCase();
  fs.mkdirSync(directory, { recursive: true });
  let coalesceTimer = null;
  try {
    const watcher = fs.watch(directory, (_eventType, changedName) => {
      if (changedName && String(changedName).toLowerCase() !== filename) return;
      clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(onChange, 1);
    });
    return () => {
      clearTimeout(coalesceTimer);
      watcher.close();
    };
  } catch {
    return () => {};
  }
}

function authenticationOptions(key, host) {
  const allowUnauthenticated = process.env.ORANGE5_AE_PULSE_ALLOW_UNAUTHENTICATED === '1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!key && !(allowUnauthenticated && loopback)) {
    throw new Error('AE Pulse requires ORANGE5_AE_PULSE_KEY outside an explicit loopback-only development mode');
  }
  return { key: key || null, requireAuthentication: Boolean(key) };
}

function createPeer({ socket, direction, localState, key, intervalMs, onVariation, onClose, peerLabel }) {
  let sendSeq = 0;
  let receivedSeq = 0;
  let acknowledgedSeq = 0;
  let lastReceivedAt = Date.now();
  let lastSentState = null;
  let remoteState = null;
  let peerObservedLocalStateHash = null;
  let closed = false;
  let timer = null;
  let framesSent = 0;
  let framesReceived = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  let phaseGaps = 0;
  let rttEwmaMs = null;
  let lastVariationRttMs = null;
  let variationAcknowledgements = 0;
  const rttSamplesMs = [];
  const sentAt = new Map();
  const auth = { key, requireAuthentication: Boolean(key) };

  const clockMs = () => Number(process.hrtime.bigint()) / 1_000_000;
  const rttStats = () => {
    if (!rttSamplesMs.length) return { samples: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, ewmaMs: null };
    const sorted = [...rttSamplesMs].sort((a, b) => a - b);
    const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
    return {
      samples: sorted.length,
      minMs: Number(sorted[0].toFixed(3)),
      p50Ms: Number(percentile(0.50).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      maxMs: Number(sorted.at(-1).toFixed(3)),
      ewmaMs: Number(rttEwmaMs.toFixed(3)),
    };
  };

  const acknowledge = (ack) => {
    const now = clockMs();
    for (const [seq, sent] of sentAt) {
      if (seq > ack) continue;
      const duration = Math.max(0, now - sent.startedAt);
      rttSamplesMs.push(duration);
      if (rttSamplesMs.length > 1_024) rttSamplesMs.shift();
      rttEwmaMs = rttEwmaMs == null ? duration : (rttEwmaMs * 0.8) + (duration * 0.2);
      if (sent.type === AE_PULSE_TYPES.VARIATION) {
        lastVariationRttMs = duration;
        variationAcknowledgements += 1;
      }
      sentAt.delete(seq);
    }
  };

  const send = (type, payload = null) => {
    if (closed || socket.destroyed) return false;
    sendSeq += 1;
    const encoded = encodePulseFrame({ type, seq: sendSeq, ack: receivedSeq, payload }, { key });
    if (type !== AE_PULSE_TYPES.ACK && type !== AE_PULSE_TYPES.CLOSE) {
      sentAt.set(sendSeq, { startedAt: clockMs(), type });
    }
    framesSent += 1;
    bytesSent += encoded.length;
    socket.write(encoded);
    return true;
  };

  const decoder = createPulseFrameDecoder({
    ...auth,
    onError(error) {
      socket.destroy(error);
    },
    onFrame(frame) {
      lastReceivedAt = Date.now();
      acknowledgedSeq = Math.max(acknowledgedSeq, frame.ack || 0);
      acknowledge(acknowledgedSeq);
      framesReceived += 1;
      if (frame.payload?.observedStateHash) peerObservedLocalStateHash = cleanText(frame.payload.observedStateHash, 64);
      const sendAck = () => send(AE_PULSE_TYPES.ACK, { observedStateHash: remoteState?.stateHash || null });
      if (frame.seq <= receivedSeq) {
        sendAck();
        return;
      }
      const expected = receivedSeq + 1;
      if (frame.seq !== expected) {
        phaseGaps += 1;
        onVariation?.({ kind: 'phase_gap', expected, received: frame.seq, peerLabel });
      }
      receivedSeq = frame.seq;
      if (frame.type === AE_PULSE_TYPES.HELLO) {
        remoteState = applyStateVariation(null, frame.payload?.state ? { full: frame.payload.state } : null);
        onVariation?.({ kind: 'hello', peerLabel, remoteState, peer: frame.payload?.peer || null });
        sendAck();
      } else if (frame.type === AE_PULSE_TYPES.VARIATION) {
        remoteState = applyStateVariation(remoteState, frame.payload?.variation);
        onVariation?.({ kind: 'variation', peerLabel, remoteState, variation: frame.payload?.variation || null });
        sendAck();
      } else if (frame.type === AE_PULSE_TYPES.PULSE) {
        sendAck();
      } else if (frame.type === AE_PULSE_TYPES.CLOSE) {
        socket.end();
      }
    },
  });

  socket.on('data', (chunk) => {
    bytesReceived += chunk.length;
    decoder(chunk);
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    onClose?.({ direction, peerLabel, sendSeq, receivedSeq, acknowledgedSeq, lastReceivedAt });
  });

  const helloState = normalizeCarrierState(localState());
  lastSentState = helloState;
  send(AE_PULSE_TYPES.HELLO, {
    peer: { nodeId: helloState.nodeId, role: helloState.role, direction },
    state: helloState,
  });

  const flushState = () => {
    const current = normalizeCarrierState(localState());
    const variation = stateVariation(lastSentState, current);
    if (!variation) return false;
    send(AE_PULSE_TYPES.VARIATION, { variation });
    lastSentState = current;
    return true;
  };

  timer = setInterval(() => {
    if (Date.now() - lastReceivedAt > intervalMs * 5) {
      socket.destroy(new Error('AE Pulse phase timeout'));
      return;
    }
    if (!flushState()) send(AE_PULSE_TYPES.PULSE);
  }, intervalMs);

  return {
    close() {
      if (closed) return;
      send(AE_PULSE_TYPES.CLOSE);
      socket.end();
    },
    flushState,
    snapshot() {
      return {
        direction,
        peerLabel,
        connected: !closed && !socket.destroyed,
        authenticated: Boolean(key),
        sendSeq,
        receivedSeq,
        acknowledgedSeq,
        lastReceivedAt,
        localStateHash: lastSentState?.stateHash || null,
        peerObservedLocalStateHash,
        remoteState,
        closed,
        metrics: {
          framesSent,
          framesReceived,
          bytesSent,
          bytesReceived,
          phaseGaps,
          unacknowledgedFrames: sentAt.size,
          variationAcknowledgements,
          lastVariationRttMs: lastVariationRttMs == null ? null : Number(lastVariationRttMs.toFixed(3)),
          rtt: rttStats(),
        },
      };
    },
  };
}

function carrierRecorder({ mode, snapshotPath = SNAPSHOT_PATH, eventsPath = EVENTS_PATH }) {
  let previousEventHash = null;
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/);
    previousEventHash = JSON.parse(lines.at(-1) || '{}').eventHash || null;
  } catch {}
  return (event) => {
    const record = {
      schema: AE_PULSE_CARRIER_SCHEMA,
      eventId: `pulse-${randomUUID()}`,
      at: new Date().toISOString(),
      mode,
      ...event,
      previousEventHash,
    };
    record.eventHash = sha256(stableJson(record));
    previousEventHash = record.eventHash;
    appendEvent(eventsPath, record);
    writeAtomic(snapshotPath, record);
    return record;
  };
}

function startCarrierHealthServer({ mode, snapshot, host = '127.0.0.1', port = AE_PULSE_DEFAULT_HEALTH_PORT }) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/health' && request.url !== '/healthz') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const carrier = snapshot();
    const connected = mode === 'server'
      ? Number(carrier.connectedPeers || 0) > 0
      : carrier.connected === true || carrier.closed === false;
    response.writeHead(connected ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      schema: AE_PULSE_CARRIER_SCHEMA,
      ok: connected,
      mode,
      connected,
      carrier,
      at: new Date().toISOString(),
    }));
  });
  server.listen(port, host);
  return server;
}

export function parsePulseTargets(value = process.env.ORANGE5_AE_PULSE_TARGETS) {
  const raw = String(value || '10.0.99.1:8905,CODEXA:8905,CODEXA.local:8905,10.0.0.4:8905');
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [host, rawPort] = entry.split(':');
    return { host, port: Number(rawPort || AE_PULSE_DEFAULT_PORT), label: entry };
  });
}

export function startPulseCarrierServer({
  host = process.env.ORANGE5_AE_PULSE_HOST || '0.0.0.0',
  port = Number(process.env.ORANGE5_AE_PULSE_PORT || AE_PULSE_DEFAULT_PORT),
  key = pulseKey(),
  intervalMs = Number(process.env.ORANGE5_AE_PULSE_INTERVAL_MS || AE_PULSE_DEFAULT_INTERVAL_MS),
  healthHost = process.env.ORANGE5_AE_PULSE_HEALTH_HOST || '127.0.0.1',
  healthPort = Number(process.env.ORANGE5_AE_PULSE_HEALTH_PORT || AE_PULSE_DEFAULT_HEALTH_PORT),
  localState = readLocalCarrierState,
  snapshotPath,
  eventsPath,
} = {}) {
  authenticationOptions(key, host);
  const record = carrierRecorder({ mode: 'server', snapshotPath, eventsPath });
  const peers = new Map();
  const closeTopologyWatch = watchTopology(() => {
    for (const peer of peers.values()) peer.flushState();
  });
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, intervalMs);
    const peerLabel = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
    const peer = createPeer({
      socket,
      direction: 'inbound',
      localState,
      key,
      intervalMs,
      peerLabel,
      onVariation: (event) => record(event),
      onClose: (event) => { peers.delete(peerLabel); record({ kind: 'disconnected', ...event }); },
    });
    peers.set(peerLabel, peer);
    record({ kind: 'connected', peerLabel });
  });
  server.listen(port, host, () => record({ kind: 'listening', host, port }));
  const healthServer = startCarrierHealthServer({
    mode: 'server',
    host: healthHost,
    port: healthPort,
    snapshot: () => ({
      listening: server.listening,
      host,
      port,
      connectedPeers: peers.size,
      peers: [...peers.values()].map((peer) => peer.snapshot()),
    }),
  });
  return {
    server,
    healthServer,
    peers,
    close() {
      closeTopologyWatch();
      for (const peer of peers.values()) peer.close();
      server.close();
      healthServer.close();
    },
  };
}

export function startPulseCarrierClient({
  targets = parsePulseTargets(),
  key = pulseKey(),
  intervalMs = Number(process.env.ORANGE5_AE_PULSE_INTERVAL_MS || AE_PULSE_DEFAULT_INTERVAL_MS),
  healthHost = process.env.ORANGE5_AE_PULSE_HEALTH_HOST || '127.0.0.1',
  healthPort = Number(process.env.ORANGE5_AE_PULSE_HEALTH_PORT || AE_PULSE_DEFAULT_HEALTH_PORT),
  localState = readLocalCarrierState,
  snapshotPath,
  eventsPath,
} = {}) {
  if (!targets.length) throw new Error('AE Pulse client has no target paths');
  authenticationOptions(key, targets[0].host);
  const record = carrierRecorder({ mode: 'client', snapshotPath, eventsPath });
  let stopped = false;
  let peer = null;
  let targetIndex = 0;
  let failures = 0;
  let reconnectTimer = null;
  const closeTopologyWatch = watchTopology(() => peer?.flushState());

  const connect = () => {
    if (stopped) return;
    const target = targets[targetIndex % targets.length];
    const socket = net.createConnection({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, intervalMs);
    socket.once('connect', () => {
      failures = 0;
      record({ kind: 'connected', target: target.label });
      peer = createPeer({
        socket,
        direction: 'outbound',
        localState: () => readLocalCarrierState({ selectedPath: target.label, ...localState() }),
        key,
        intervalMs,
        peerLabel: target.label,
        onVariation: (event) => record({ target: target.label, ...event }),
        onClose: (event) => {
          peer = null;
          if (stopped) return;
          failures += 1;
          if (failures >= 2) targetIndex = (targetIndex + 1) % targets.length;
          const delayMs = Math.min(15_000, 500 * (2 ** Math.min(5, failures)));
          record({ kind: 'disconnected', target: target.label, failures, nextTarget: targets[targetIndex].label, delayMs, ...event });
          reconnectTimer = setTimeout(connect, delayMs);
        },
      });
    });
    socket.once('error', (error) => {
      if (peer || stopped) return;
      failures += 1;
      if (failures >= 2) targetIndex = (targetIndex + 1) % targets.length;
      const delayMs = Math.min(15_000, 500 * (2 ** Math.min(5, failures)));
      record({ kind: 'connect_failed', target: target.label, error: cleanText(error.message, 256), failures, nextTarget: targets[targetIndex].label, delayMs });
      reconnectTimer = setTimeout(connect, delayMs);
    });
  };

  connect();
  const healthServer = startCarrierHealthServer({
    mode: 'client',
    host: healthHost,
    port: healthPort,
    snapshot: () => {
      if (!peer) return { connected: false, target: targets[targetIndex]?.label || null, failures };
      const current = peer.snapshot();
      return { ...current, connected: current.connected, target: current.peerLabel, failures };
    },
  });
  return {
    healthServer,
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      closeTopologyWatch();
      peer?.close();
      healthServer.close();
    },
    snapshot() { return peer?.snapshot() || { connected: false, target: targets[targetIndex]?.label || null, failures }; },
  };
}

function printStatus() {
  const state = readJson(SNAPSHOT_PATH);
  process.stdout.write(`${JSON.stringify(state || { schema: AE_PULSE_CARRIER_SCHEMA, status: 'no_state' }, null, 2)}\n`);
}

if (import.meta.main) {
  const mode = process.argv[2] || process.env.ORANGE5_AE_PULSE_MODE || 'client';
  if (mode === 'status') {
    printStatus();
  } else {
    const carrier = mode === 'server' ? startPulseCarrierServer() : startPulseCarrierClient();
    const stop = () => { carrier.close(); setTimeout(() => process.exit(0), 25); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
