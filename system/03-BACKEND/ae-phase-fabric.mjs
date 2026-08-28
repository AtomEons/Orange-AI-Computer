import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  AE_PHASE_TYPES,
  applyReceiveSequence,
  createReceiveWindow,
  decodePhaseFrame,
  encodePhaseFrame,
  isAcknowledged,
} from './ae-phase-protocol.mjs';

export const AE_PHASE_FABRIC_SCHEMA = 'orange.ae-phase.fabric.v1';
export const AE_PHASE_STATE_SCHEMA = 'orange.ae-phase.state.v1';
export const AE_PHASE_PORT = 8905;
export const AE_PHASE_HEALTH_PORT = 8907;
export const AE_PHASE_CONTROL_PORT = 8908;

const DEFAULT_BEACON_MS = 250;
const DEFAULT_STALE_MS = 1_250;
const DEFAULT_RETRY_MS = 120;
const MAX_RETRIES = 4;
const MAX_STATE_BYTES = 48 * 1024;
const NODE_BOOT_EPOCH = (BigInt(Date.now()) << 16n) | BigInt(randomBytes(2).readUInt16BE(0));
const STATE_OP = Object.freeze({ SET: 0, REMOVE: 1 });

const FIELD = Object.freeze({
  node: 1,
  role: 2,
  boot: 3,
  status: 4,
  path: 5,
  pressure: 6,
  wave: 7,
  custody: 8,
  capabilities: 9,
  workset: 10,
  ready: 11,
  total: 12,
  blockers: 13,
  signal: 14,
});

const TYPE_NAME = Object.freeze(Object.fromEntries(
  Object.entries(AE_PHASE_TYPES).map(([name, value]) => [value, name]),
));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const stableJson = (value) => JSON.stringify(stable(value));
const clean = (value, max = 192) => String(value ?? '').trim().slice(0, max);
const endpointKey = (address, port) => `${address}:${port}`;

function resolvePaths(options = {}) {
  const dataRoot = options.dataRoot || process.env.ORANGE5_DATA_ROOT
    || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
  return {
    dataRoot,
    topology: process.env.ORANGE5_AE_PULSE_STATE
      || path.join(dataRoot, 'topology', 'ae-pulse-state.json'),
    snapshot: process.env.ORANGE5_AE_PHASE_STATE
      || path.join(dataRoot, 'topology', 'ae-phase-fabric.json'),
    events: process.env.ORANGE5_AE_PHASE_EVENTS
      || path.join(dataRoot, 'topology', 'ae-phase-fabric-events.jsonl'),
    key: options.keyFile || process.env.ORANGE5_AE_PHASE_KEY_FILE
      || path.join(dataRoot, 'secrets', 'ae-phase-key.txt'),
    signal: process.env.ORANGE5_AE_PHASE_SIGNAL
      || path.join(dataRoot, 'topology', 'ae-phase-signal.json'),
    inbox: process.env.ORANGE5_AE_PHASE_INBOX
      || path.join(dataRoot, 'topology', 'ae-phase-inbox.jsonl'),
  };
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function readBaseKey(keyPath) {
  let material;
  try { material = fs.readFileSync(keyPath, 'utf8').trim(); }
  catch { throw new Error(`AE Phase key is missing: ${keyPath}`); }
  if (!material) throw new Error(`AE Phase key is empty: ${keyPath}`);
  return createHash('sha256').update(material, 'utf8').digest();
}

function senderHashFor(nodeId) {
  return createHash('sha256').update(`orange.ae-phase.sender.v1\0${nodeId}`).digest().subarray(0, 8);
}

function stateRoot(fields) {
  return sha256(Buffer.from(stableJson(fields), 'utf8'));
}

export function normalizePhaseState(input = {}) {
  const topology = input.topology || {};
  const fields = {
    [FIELD.node]: clean(input.nodeId || os.hostname(), 96),
    [FIELD.role]: clean(input.role || 'orange-node', 48),
    [FIELD.boot]: clean(input.bootId || '', 96) || null,
    [FIELD.status]: clean(input.status || topology.status || 'unknown', 32),
    [FIELD.path]: clean(input.selectedPath || '', 96) || null,
    [FIELD.pressure]: Number.isFinite(Number(input.flowPressure)) ? Number(input.flowPressure) : null,
    [FIELD.wave]: input.solarWave ? [
      clean(input.solarWave.id || input.solarWave.waveId, 96) || null,
      clean(input.solarWave.state, 32) || null,
    ] : null,
    [FIELD.custody]: input.custody ? [
      Math.max(0, Number(input.custody.active || 0)),
      clean(input.custody.hash, 64) || null,
    ] : null,
    [FIELD.capabilities]: clean(input.capabilityHash, 64) || null,
    [FIELD.workset]: clean(input.worksetHash, 64) || null,
    [FIELD.ready]: Number.isFinite(Number(input.readyRequired ?? topology.readyRequired))
      ? Number(input.readyRequired ?? topology.readyRequired) : null,
    [FIELD.total]: Number.isFinite(Number(input.totalRequired ?? topology.totalRequired))
      ? Number(input.totalRequired ?? topology.totalRequired) : null,
    [FIELD.blockers]: (Array.isArray(input.blockers) ? input.blockers : [])
      .slice(0, 16)
      .map((item) => clean(typeof item === 'string' ? item : item?.code || item?.message || item, 160))
      .filter(Boolean),
    [FIELD.signal]: input.signal ? [
      clean(input.signal.id, 96) || null,
      clean(input.signal.kind, 48) || null,
      clean(input.signal.referenceHash, 64) || null,
      Math.max(0, Number(input.signal.referenceBytes || 0)),
    ] : null,
  };
  return { schema: AE_PHASE_STATE_SCHEMA, fields, root: stateRoot(fields) };
}

export function diffPhaseState(previous, current) {
  if (!previous) return { kind: 'snapshot', fields: current.fields, resultRoot: current.root };
  const ops = [];
  for (const [key, value] of Object.entries(current.fields)) {
    if (stableJson(previous.fields?.[key]) !== stableJson(value)) {
      ops.push([STATE_OP.SET, Number(key), value]);
    }
  }
  for (const key of Object.keys(previous.fields || {})) {
    if (!(key in current.fields)) ops.push([STATE_OP.REMOVE, Number(key)]);
  }
  if (!ops.length) return null;
  return {
    kind: 'state_program',
    baseRoot: previous.root,
    resultRoot: current.root,
    ops,
  };
}

export function applyPhaseDelta(previous, delta) {
  if (delta?.baseRoot && previous?.root !== delta.baseRoot) {
    return { state: previous, valid: false, reason: 'base_root_mismatch' };
  }
  const fields = delta?.kind === 'snapshot'
    ? { ...(delta.fields || {}) }
    : delta?.full
      ? { ...delta.full }
      : { ...(previous?.fields || {}), ...(delta?.set || {}) };
  for (const operation of delta?.ops || []) {
    const [opcode, key, value] = operation;
    if (opcode === STATE_OP.SET) fields[key] = value;
    else if (opcode === STATE_OP.REMOVE) delete fields[key];
    else return { state: previous, valid: false, reason: 'unknown_state_opcode' };
  }
  for (const key of delta?.remove || []) delete fields[key];
  const state = { schema: AE_PHASE_STATE_SCHEMA, fields, root: stateRoot(fields) };
  const expectedRoot = delta?.resultRoot || delta?.root || null;
  return {
    state,
    valid: !expectedRoot || state.root === expectedRoot,
    reason: expectedRoot && state.root !== expectedRoot ? 'result_root_mismatch' : null,
  };
}

function encodePayload(value) {
  const payload = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  if (payload.length > MAX_STATE_BYTES) throw new Error(`AE Phase payload exceeds ${MAX_STATE_BYTES} bytes`);
  return payload;
}

function decodePayload(buffer) {
  if (!buffer?.length) return null;
  try { return JSON.parse(buffer.toString('utf8')); }
  catch (error) { throw new Error(`AE Phase payload is invalid JSON: ${error.message}`); }
}

function normalizeEnvelope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AE Phase envelope must be an object');
  const id = clean(input.id, 96);
  const kind = clean(input.kind, 48);
  if (!id || !kind) throw new Error('AE Phase envelope requires id and kind');
  const body = input.body ?? null;
  const bodyJson = stableJson(body);
  const bodyBytes = Buffer.byteLength(bodyJson);
  if (bodyBytes > MAX_STATE_BYTES - 2_048) throw new Error(`AE Phase envelope body exceeds ${MAX_STATE_BYTES - 2_048} bytes`);
  const bodyHash = sha256(Buffer.from(bodyJson, 'utf8'));
  if (input.bodyHash && input.bodyHash !== bodyHash) throw new Error('AE Phase envelope body hash mismatch');
  return {
    schema: 'orange.ae-phase.envelope.v1',
    id,
    kind,
    correlationId: clean(input.correlationId || id, 96),
    body,
    bodyHash,
    bodyBytes,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

function appendEnvelopeInbox(paths, envelope, peer) {
  fs.mkdirSync(path.dirname(paths.inbox), { recursive: true });
  const row = {
    schema: 'orange.ae-phase.inbox.v1',
    receivedAt: new Date().toISOString(),
    sender: peer?.sender || null,
    nodeId: peer?.nodeId || null,
    ...envelope,
  };
  fs.appendFileSync(paths.inbox, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function encodeAckPayload(root) {
  return root && /^[a-f0-9]{64}$/.test(root)
    ? Buffer.from(root, 'hex')
    : Buffer.alloc(32);
}

function decodeAckPayload(buffer) {
  if (buffer?.length !== 32) return decodePayload(buffer);
  const root = buffer.equals(Buffer.alloc(32)) ? null : buffer.toString('hex');
  return { observedRemoteRoot: root };
}

function parseTargets(value = process.env.ORANGE5_AE_PHASE_TARGETS) {
  const raw = String(value || '10.0.99.1:8905,10.0.0.4:8905');
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [address, rawPort] = entry.split(':');
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
      throw new Error(`AE Phase targets must be literal IPv4 addresses: ${entry}`);
    }
    return { address, port: Number(rawPort || AE_PHASE_PORT), key: endpointKey(address, Number(rawPort || AE_PHASE_PORT)) };
  });
}

function watchTopology(filePath, onChange) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let queued = false;
  const watcher = fs.watch(path.dirname(filePath), (_event, changed) => {
    if (changed && String(changed).toLowerCase() !== path.basename(filePath).toLowerCase()) return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      onChange();
    });
  });
  return () => watcher.close();
}

function createEventWriter(paths, mode) {
  let previousEventHash = null;
  let draining = null;
  const queue = [];
  try {
    const lines = fs.readFileSync(paths.events, 'utf8').trim().split(/\r?\n/);
    previousEventHash = JSON.parse(lines.at(-1) || '{}').eventHash || null;
  } catch {}
  const drain = async () => {
    while (queue.length) {
      const { record, health } = queue.shift();
      try {
        await fs.promises.mkdir(path.dirname(paths.events), { recursive: true });
        await fs.promises.appendFile(paths.events, `${JSON.stringify(record)}\n`, 'utf8');
        const temporary = `${paths.snapshot}.${process.pid}.${randomUUID()}.tmp`;
        await fs.promises.writeFile(temporary, `${JSON.stringify({ ...health(), lastEvent: record }, null, 2)}\n`, 'utf8');
        await fs.promises.rename(temporary, paths.snapshot);
      } catch (error) {
        write.lastError = clean(error.message, 256);
      }
    }
  };
  const schedule = () => {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length) schedule();
    });
  };
  const write = (event, health) => {
    const record = {
      schema: AE_PHASE_FABRIC_SCHEMA,
      eventId: `phase-${randomUUID()}`,
      at: new Date().toISOString(),
      mode,
      ...event,
      previousEventHash,
    };
    record.eventHash = sha256(Buffer.from(stableJson(record), 'utf8'));
    previousEventHash = record.eventHash;
    queue.push({ record, health });
    schedule();
    return record;
  };
  write.lastError = null;
  write.flush = async () => {
    while (draining || queue.length) {
      if (draining) await draining;
      else schedule();
    }
  };
  return write;
}

function startHealthServer(port, health) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/health' && request.url !== '/healthz') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const body = health();
    response.writeHead(body.ok ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  });
  server.listen(port, '127.0.0.1');
  return server;
}

function createFabric(options = {}) {
  const mode = options.mode || 'client';
  const paths = resolvePaths(options);
  const baseKey = readBaseKey(paths.key);
  const nodeId = clean(options.nodeId || process.env.ORANGE5_NODE_ID || os.hostname(), 96);
  const role = clean(options.role || process.env.ORANGE5_NODE_ROLE
    || (nodeId.toUpperCase() === 'CODEXA' ? 'heavy-compute' : 'control'), 48);
  const senderHash = senderHashFor(nodeId);
  const senderHex = senderHash.toString('hex');
  const epoch = NODE_BOOT_EPOCH;
  const port = Number(options.port || process.env.ORANGE5_AE_PHASE_PORT || AE_PHASE_PORT);
  const healthPort = Number(options.healthPort || process.env.ORANGE5_AE_PHASE_HEALTH_PORT || AE_PHASE_HEALTH_PORT);
  const controlPort = Number(options.controlPort || process.env.ORANGE5_AE_PHASE_CONTROL_PORT || AE_PHASE_CONTROL_PORT);
  const targets = mode === 'client' ? (options.targets || parseTargets()) : [];
  const peers = new Map();
  const pending = new Map();
  let socket = null;
  let controlSocket = null;
  let healthServer = null;
  let closeWatch = () => {};
  let seq = 0;
  let localState = null;
  let running = true;
  let backpressured = false;
  let authFailures = 0;
  let replayDrops = 0;
  let hydrationRequests = 0;
  let framesSent = 0;
  let framesReceived = 0;
  let wireBytesSent = 0;
  let wireBytesReceived = 0;
  let droppedSends = 0;
  let envelopesSent = 0;
  let envelopesReceived = 0;
  let lastMeaningfulAt = null;
  let lastDeltaAckMs = null;
  let lastDeltaAckRoot = null;
  let lastDeltaMetrics = null;
  const sentRoots = new Map();
  let localSignal = readJson(paths.signal) || null;

  const readLocalState = () => {
    const topology = readJson(paths.topology) || {};
    const signal = localSignal || readJson(paths.signal) || null;
    return normalizePhaseState({
      nodeId,
      role,
      bootId: `${nodeId}:${epoch}`,
      topology,
      signal,
      status: topology.status || 'phase_fabric',
      blockers: topology.status === 'offline' ? ['local topology reports offline'] : [],
    });
  };

  localState = readLocalState();

  const peerList = () => [...peers.values()].map((peer) => ({
    sender: peer.sender,
    nodeId: peer.nodeId || null,
    role: peer.role || null,
    epoch: peer.epoch?.toString() || null,
    endpoints: [...peer.endpoints.values()].map((endpoint) => ({
      ...endpoint,
      lastSeenAt: endpoint.lastSeenAt ? new Date(endpoint.lastSeenAt).toISOString() : null,
      lastFailureAt: endpoint.lastFailureAt ? new Date(endpoint.lastFailureAt).toISOString() : null,
    })),
    lastSeenAt: peer.lastSeenAt ? new Date(peer.lastSeenAt).toISOString() : null,
    remoteStateRoot: peer.remoteState?.root || null,
    remoteStateValid: peer.remoteStateValid === true,
    observedLocalRoot: peer.observedLocalRoot || null,
    stateConverged: peer.observedLocalRoot === localState.root && peer.remoteStateValid === true,
  }));

  const health = () => {
    const now = Date.now();
    const livePeers = [...peers.values()].filter((peer) => now - peer.lastSeenAt <= DEFAULT_STALE_MS);
    const converged = livePeers.some((peer) => peer.observedLocalRoot === localState.root && peer.remoteStateValid === true);
    const ok = running && Boolean(socket) && livePeers.length > 0 && converged;
    return {
      schema: AE_PHASE_FABRIC_SCHEMA,
      ok,
      status: ok ? 'AE_PHASE_FABRIC_ACTIVE' : 'AE_PHASE_FABRIC_SYNCING',
      mode,
      transport: 'bun-udp-datagram',
      directTcp: false,
      dnsOnFabric: false,
      authenticated: true,
      encrypted: 'aes-256-gcm',
      nodeId,
      role,
      sender: senderHex,
      epoch: epoch.toString(),
      port: socket?.port || port,
      controlPort: controlSocket?.port || null,
      localStateRoot: localState.root,
      connectedPeers: livePeers.length,
      peers: peerList(),
      pendingCriticalFrames: pending.size,
      counters: {
        framesSent,
        framesReceived,
        wireBytesSent,
        wireBytesReceived,
        replayDrops,
        authFailures,
        hydrationRequests,
        droppedSends,
        envelopesSent,
        envelopesReceived,
      },
      deltaAck: {
        lastMs: lastDeltaAckMs,
        root: lastDeltaAckRoot,
        ...lastDeltaMetrics,
      },
      receiptWriterError: record?.lastError || null,
      backpressured,
      lastMeaningfulAt,
      statePath: paths.snapshot,
      eventPath: paths.events,
      inboxPath: paths.inbox,
      at: new Date().toISOString(),
    };
  };

  const record = createEventWriter(paths, mode);

  const allKnownTargets = (peer = null) => {
    if (peer?.endpoints?.size) {
      const now = Date.now();
      const ranked = [...peer.endpoints.values()].sort((a, b) => {
        const aCooling = a.lastFailureAt && now - a.lastFailureAt < DEFAULT_STALE_MS;
        const bCooling = b.lastFailureAt && now - b.lastFailureAt < DEFAULT_STALE_MS;
        if (aCooling !== bCooling) return aCooling ? 1 : -1;
        const aDirect = a.address.startsWith('10.0.99.');
        const bDirect = b.address.startsWith('10.0.99.');
        if (aDirect !== bDirect) return aDirect ? -1 : 1;
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      });
      return ranked.length ? [ranked[0]] : [];
    }
    return targets;
  };

  const ackFor = (peer) => peer?.window?.initialized
    ? { ackBase: peer.window.ackBase, ackBits: peer.window.ackBits }
    : { ackBase: 0, ackBits: 0 };

  const transmit = (packet, destinations, copies = 1) => {
    const unique = [...new Map(destinations.map((item) => [endpointKey(item.address, item.port), item])).values()];
    if (!unique.length || !socket) return 0;
    const batch = [];
    for (let copy = 0; copy < copies; copy += 1) {
      for (const destination of unique) batch.push(packet, destination.port, destination.address);
    }
    const expected = unique.length * copies;
    let sent = 0;
    try {
      sent = socket.sendMany(batch);
    } catch (batchError) {
      // A failed secondary path must not terminate the Fabric or suppress a
      // healthy direct path. Fall back to isolated submissions and account
      // for each failed destination independently.
      for (let copy = 0; copy < copies; copy += 1) {
        for (const destination of unique) {
          try {
            if (socket.send(packet, destination.port, destination.address)) sent += 1;
          } catch (error) {
            destination.lastFailureAt = Date.now();
            destination.failures = Number(destination.failures || 0) + 1;
            record({
              kind: 'path_send_failed',
              endpoint: endpointKey(destination.address, destination.port),
              error: clean(error?.message || batchError?.message || error, 256),
            }, health);
          }
        }
      }
    }
    framesSent += sent;
    wireBytesSent += sent * packet.length;
    if (sent < expected) {
      backpressured = true;
      droppedSends += expected - sent;
    }
    return sent;
  };

  const sendFrame = (type, payload, {
    peer = null,
    destinations = null,
    critical = false,
    burst = false,
    rawPayload = false,
  } = {}) => {
    seq = seq >= 0xffffffff ? 1 : seq + 1;
    const ack = ackFor(peer);
    const packet = encodePhaseFrame({
      type,
      senderHash,
      epoch,
      seq,
      ...ack,
      stateHashPrefix: Buffer.from(localState.root.slice(0, 16), 'hex'),
      payload: rawPayload ? Buffer.from(payload || []) : encodePayload(payload),
    }, { baseKey });
    const sendTargets = destinations || allKnownTargets(peer);
    transmit(packet, sendTargets, 1);
    if (type === AE_PHASE_TYPES.DELTA) {
      const stateEquivalentBytes = Math.max(
        Buffer.byteLength(stableJson(localState.fields), 'utf8'),
        Number(localSignal?.referenceBytes || 0),
      );
      sentRoots.set(localState.root, {
        startedAt: process.hrtime.bigint(),
        stateEquivalentBytes,
        deltaPayloadBytes: Buffer.byteLength(stableJson(payload?.delta || payload), 'utf8'),
        wireBytes: packet.length * Math.max(1, sendTargets.length),
      });
    }
    if (critical) pending.set(seq, {
      seq,
      type,
      packet,
      destinations: sendTargets,
      retries: 0,
      nextRetryAt: Date.now() + DEFAULT_RETRY_MS,
    });
    return seq;
  };

  const sendHello = (peer = null, destinations = null) => sendFrame(AE_PHASE_TYPES.HELLO, {
    nodeId,
    role,
    state: localState,
    observedRemoteRoot: peer?.remoteState?.root || null,
  }, { peer, destinations, critical: true, burst: true });

  const sendAck = (peer, destination) => sendFrame(
    AE_PHASE_TYPES.ACK,
    encodeAckPayload(peer.remoteState?.root || null),
    { peer, destinations: [destination], rawPayload: true },
  );

  const requestHydration = (peer, reason) => {
    hydrationRequests += 1;
    sendFrame(AE_PHASE_TYPES.HYDRATE_REQUEST, {
      reason,
      haveRoot: peer.remoteState?.root || null,
      expectedRoot: peer.advertisedRoot || null,
    }, { peer, critical: true, burst: true });
    record({ kind: 'hydration_requested', peer: peer.sender, reason }, health);
  };

  const applyAcknowledgment = (frame) => {
    for (const [pendingSeq] of pending) {
      if (isAcknowledged(pendingSeq, frame)) pending.delete(pendingSeq);
    }
  };

  const peerFor = (frame, address, remotePort) => {
    const sender = frame.senderHash.toString('hex');
    let peer = peers.get(sender);
    if (!peer || peer.epoch !== frame.epoch) {
      peer = {
        sender,
        epoch: frame.epoch,
        fresh: true,
        window: createReceiveWindow({ senderHash: frame.senderHash, epoch: frame.epoch }),
        endpoints: new Map(),
        lastSeenAt: Date.now(),
        remoteState: null,
        remoteStateValid: false,
        observedLocalRoot: null,
        advertisedRoot: null,
      };
      peers.set(sender, peer);
    }
    const key = endpointKey(address, remotePort);
    const endpoint = peer.endpoints.get(key) || { address, port: remotePort, key, failures: 0 };
    endpoint.address = address;
    endpoint.port = remotePort;
    endpoint.lastSeenAt = Date.now();
    endpoint.lastFailureAt = null;
    peer.endpoints.set(key, endpoint);
    peer.lastSeenAt = Date.now();
    return peer;
  };

  const receive = (_udp, datagram, remotePort, address) => {
    let frame;
    try {
      frame = decodePhaseFrame(datagram, { baseKey });
    } catch (error) {
      authFailures += 1;
      record({ kind: 'frame_rejected', address, port: remotePort, code: error.code || 'decode_error' }, health);
      return;
    }
    framesReceived += 1;
    wireBytesReceived += datagram.length;
    const peer = peerFor(frame, address, remotePort);
    const destination = { address, port: remotePort, key: endpointKey(address, remotePort) };
    applyAcknowledgment(frame);
    try {
      applyReceiveSequence(peer.window, frame);
    } catch (error) {
      if (error.code === 'REPLAY_SEQUENCE') {
        replayDrops += 1;
        sendAck(peer, destination);
        return;
      }
      record({ kind: 'sequence_rejected', peer: peer.sender, code: error.code || 'sequence_error' }, health);
      return;
    }
    const payload = frame.type === AE_PHASE_TYPES.ACK
      ? decodeAckPayload(frame.payload)
      : decodePayload(frame.payload);
    const newlyDiscovered = peer.fresh === true;
    peer.fresh = false;
    peer.advertisedRoot = frame.stateHashPrefix.toString('hex');
    if (payload?.observedRemoteRoot) {
      peer.observedLocalRoot = payload.observedRemoteRoot;
      const sentMetric = sentRoots.get(payload.observedRemoteRoot);
      if (sentMetric) {
        lastDeltaAckMs = Number(((Number(process.hrtime.bigint() - sentMetric.startedAt) / 1_000_000)).toFixed(3));
        lastDeltaAckRoot = payload.observedRemoteRoot;
        const semanticGain = sentMetric.wireBytes > 0
          ? sentMetric.stateEquivalentBytes / sentMetric.wireBytes
          : 0;
        const effectiveStateMbps = lastDeltaAckMs > 0
          ? (sentMetric.stateEquivalentBytes * 8) / (lastDeltaAckMs * 1_000)
          : 0;
        lastDeltaMetrics = {
          stateEquivalentBytes: sentMetric.stateEquivalentBytes,
          deltaPayloadBytes: sentMetric.deltaPayloadBytes,
          wireBytes: sentMetric.wireBytes,
          semanticGain: Number(semanticGain.toFixed(3)),
          effectiveStateMbps: Number(effectiveStateMbps.toFixed(3)),
        };
        sentRoots.delete(payload.observedRemoteRoot);
      }
    }
    if (newlyDiscovered && frame.type !== AE_PHASE_TYPES.HELLO) sendHello(peer, [destination]);

    if (frame.type === AE_PHASE_TYPES.HELLO) {
      const firstHello = !peer.nodeId;
      peer.nodeId = clean(payload?.nodeId, 96) || null;
      peer.role = clean(payload?.role, 48) || null;
      if (payload?.state?.fields) {
        const applied = applyPhaseDelta(null, { full: payload.state.fields, root: payload.state.root });
        peer.remoteState = applied.state;
        peer.remoteStateValid = applied.valid;
      }
      lastMeaningfulAt = new Date().toISOString();
      if (firstHello) {
        record({ kind: 'peer_online', peer: peer.sender, nodeId: peer.nodeId, endpoint: destination.key }, health);
        sendHello(peer, [destination]);
      }
    } else if (frame.type === AE_PHASE_TYPES.ENVELOPE) {
      try {
        const envelope = normalizeEnvelope(payload?.envelope);
        const row = appendEnvelopeInbox(paths, envelope, peer);
        envelopesReceived += 1;
        lastMeaningfulAt = row.receivedAt;
        record({
          kind: 'envelope_received',
          peer: peer.sender,
          envelopeId: envelope.id,
          envelopeKind: envelope.kind,
          correlationId: envelope.correlationId,
          bodyHash: envelope.bodyHash,
          bodyBytes: envelope.bodyBytes,
        }, health);
      } catch (error) {
        record({ kind: 'envelope_rejected', peer: peer.sender, error: clean(error.message, 256) }, health);
      }
    } else if (frame.type === AE_PHASE_TYPES.DELTA) {
      const applied = applyPhaseDelta(peer.remoteState, payload?.delta);
      peer.remoteState = applied.state;
      peer.remoteStateValid = applied.valid;
      lastMeaningfulAt = new Date().toISOString();
      if (!applied.valid) requestHydration(peer, 'delta_root_mismatch');
      else record({ kind: 'state_delta', peer: peer.sender, remoteStateRoot: applied.state.root }, health);
    } else if (frame.type === AE_PHASE_TYPES.HYDRATE_REQUEST) {
      sendFrame(AE_PHASE_TYPES.HYDRATE_SNAPSHOT, {
        state: localState,
        reason: payload?.reason || 'requested',
        observedRemoteRoot: peer.remoteState?.root || null,
      }, { peer, critical: true, burst: true });
      record({ kind: 'hydration_served', peer: peer.sender }, health);
    } else if (frame.type === AE_PHASE_TYPES.HYDRATE_SNAPSHOT) {
      const applied = applyPhaseDelta(null, { full: payload?.state?.fields, root: payload?.state?.root });
      peer.remoteState = applied.state;
      peer.remoteStateValid = applied.valid;
      lastMeaningfulAt = new Date().toISOString();
      record({ kind: applied.valid ? 'hydration_complete' : 'hydration_invalid', peer: peer.sender }, health);
    } else if (frame.type === AE_PHASE_TYPES.CLOSE) {
      record({ kind: 'peer_close', peer: peer.sender }, health);
    }

    if (frame.type !== AE_PHASE_TYPES.ACK && frame.type !== AE_PHASE_TYPES.BEACON) {
      sendAck(peer, destination);
    }
  };

  const flushState = () => {
    const next = readLocalState();
    const delta = diffPhaseState(localState, next);
    if (!delta) return false;
    localState = next;
    for (const peer of peers.values()) {
      sendFrame(AE_PHASE_TYPES.DELTA, {
        delta,
        observedRemoteRoot: peer.remoteState?.root || null,
      }, { peer, critical: true, burst: true });
    }
    if (!peers.size && mode === 'client') {
      sendFrame(AE_PHASE_TYPES.DELTA, { delta, observedRemoteRoot: null }, { critical: true, burst: true });
    }
    lastMeaningfulAt = new Date().toISOString();
    record({ kind: 'local_state_changed', localStateRoot: localState.root }, health);
    return true;
  };

  const receiveControl = (_udp, datagram) => {
    try {
      const frame = decodePhaseFrame(datagram, { baseKey });
      const payload = decodePayload(frame.payload);
      if (frame.type !== AE_PHASE_TYPES.DELTA || !['signal', 'envelope'].includes(payload?.control)) {
        throw new Error('invalid local phase control frame');
      }
      if (payload.control === 'signal') {
        if (!payload.clear && !payload.signal?.id) throw new Error('invalid local phase signal');
        localSignal = payload.clear ? null : {
          id: clean(payload.signal.id, 96),
          kind: clean(payload.signal.kind, 48),
          referenceHash: clean(payload.signal.referenceHash, 64),
          referenceBytes: Math.max(0, Number(payload.signal.referenceBytes || 0)),
          at: new Date().toISOString(),
        };
        flushState();
        fs.promises.mkdir(path.dirname(paths.signal), { recursive: true })
          .then(() => (payload.clear
            ? fs.promises.rm(paths.signal, { force: true })
            : fs.promises.writeFile(paths.signal, `${JSON.stringify(localSignal)}\n`, 'utf8')))
          .catch((error) => { record.lastError = clean(error.message, 256); });
        return;
      }

      const envelope = normalizeEnvelope(payload.envelope);
      const requestedPeer = clean(payload.destinationSender, 16);
      const destinationPeer = requestedPeer ? peers.get(requestedPeer) : null;
      if (requestedPeer && !destinationPeer) throw new Error(`AE Phase destination peer is unavailable: ${requestedPeer}`);
      const sendToPeer = (peer) => {
        const sent = sendFrame(AE_PHASE_TYPES.ENVELOPE, { envelope }, {
          peer,
          critical: true,
          burst: true,
        });
        if (sent) envelopesSent += 1;
      };
      if (destinationPeer) sendToPeer(destinationPeer);
      else if (peers.size) for (const peer of peers.values()) sendToPeer(peer);
      else if (mode === 'client') {
        const sent = sendFrame(AE_PHASE_TYPES.ENVELOPE, { envelope }, {
          destinations: targets,
          critical: true,
          burst: true,
        });
        if (sent) envelopesSent += 1;
      } else throw new Error('AE Phase has no peer for local envelope');
      lastMeaningfulAt = new Date().toISOString();
      record({
        kind: 'envelope_sent',
        envelopeId: envelope.id,
        envelopeKind: envelope.kind,
        correlationId: envelope.correlationId,
        destinationSender: requestedPeer || null,
        bodyHash: envelope.bodyHash,
        bodyBytes: envelope.bodyBytes,
      }, health);
    } catch (error) {
      record({ kind: 'local_control_rejected', code: error.code || 'invalid_control' }, health);
    }
  };

  const beacon = () => {
    if (mode === 'client' && !peers.size) {
      sendHello(null, targets);
      return;
    }
    for (const peer of peers.values()) {
      sendFrame(AE_PHASE_TYPES.BEACON, {
        observedRemoteRoot: peer.remoteState?.root || null,
      }, { peer });
      if (peer.remoteState && !peer.remoteStateValid) requestHydration(peer, 'beacon_detected_invalid_state');
    }
  };

  const retryPending = () => {
    const now = Date.now();
    for (const [pendingSeq, item] of pending) {
      if (now < item.nextRetryAt) continue;
      if (item.retries >= MAX_RETRIES) {
        pending.delete(pendingSeq);
        record({ kind: 'critical_frame_unacknowledged', seq: pendingSeq, type: TYPE_NAME[item.type] }, health);
        continue;
      }
      item.retries += 1;
      item.nextRetryAt = now + DEFAULT_RETRY_MS * (2 ** item.retries);
      transmit(item.packet, item.destinations, 1);
    }
  };

  return {
    async start() {
      socket = await Bun.udpSocket({
        port: mode === 'server' ? port : 0,
        hostname: mode === 'server' ? (options.host || process.env.ORANGE5_AE_PHASE_HOST || '0.0.0.0') : '0.0.0.0',
        binaryType: 'buffer',
        socket: {
          data: receive,
          drain() { backpressured = false; },
          error(socketOrError, maybeError) {
            const error = maybeError || socketOrError;
            record({ kind: 'udp_error', error: clean(error?.message || error, 256) }, health);
          },
        },
      });
      controlSocket = await Bun.udpSocket({
        port: controlPort,
        hostname: '127.0.0.1',
        binaryType: 'buffer',
        socket: { data: receiveControl },
      });
      healthServer = startHealthServer(healthPort, health);
      const closeTopologyWatch = watchTopology(paths.topology, flushState);
      const closeSignalWatch = watchTopology(paths.signal, flushState);
      closeWatch = () => { closeTopologyWatch(); closeSignalWatch(); };
      const beaconTimer = setInterval(beacon, DEFAULT_BEACON_MS);
      const retryTimer = setInterval(retryPending, 40);
      this.timers = [beaconTimer, retryTimer];
      record({ kind: 'fabric_started', port: socket.port, healthPort, targets }, health);
      if (mode === 'client') sendHello(null, targets);
      writeAtomic(paths.snapshot, health());
      return this;
    },
    snapshot: health,
    flushState,
    async close() {
      if (!running) return;
      running = false;
      for (const peer of peers.values()) sendFrame(AE_PHASE_TYPES.CLOSE, { reason: 'service_stop' }, { peer });
      for (const timer of this.timers || []) clearInterval(timer);
      closeWatch();
      socket?.close();
      controlSocket?.close();
      await new Promise((resolve) => healthServer?.close(resolve) || resolve());
      record({ kind: 'fabric_stopped' }, health);
      await record.flush();
    },
  };
}

export async function startAEPhaseFabricServer(options = {}) {
  return createFabric({ ...options, mode: 'server' }).start();
}

export async function startAEPhaseFabricClient(options = {}) {
  return createFabric({ ...options, mode: 'client' }).start();
}

async function sendLocalControl(payload, options = {}) {
  const paths = resolvePaths(options);
  const baseKey = readBaseKey(paths.key);
  const senderHash = senderHashFor(`${os.hostname()}:local-control`);
  const encodedPayload = encodePayload(payload);
  const packet = encodePhaseFrame({
    type: AE_PHASE_TYPES.DELTA,
    senderHash,
    epoch: (BigInt(Date.now()) << 16n) | BigInt(randomBytes(2).readUInt16BE(0)),
    seq: 1,
    payload: encodedPayload,
  }, { baseKey });
  const udp = await Bun.udpSocket({});
  const sent = udp.send(packet, Number(options.controlPort || AE_PHASE_CONTROL_PORT), '127.0.0.1');
  await Bun.sleep(1);
  udp.close();
  if (!sent) throw new Error('AE Phase local control hit UDP backpressure');
  return { schema: 'orange.ae-phase.local-control.v1', ok: true };
}

export async function sendLocalAEPhaseEnvelope(envelope, options = {}) {
  const normalized = normalizeEnvelope(envelope);
  const result = await sendLocalControl({
    control: 'envelope',
    envelope: normalized,
    destinationSender: clean(options.destinationSender, 16) || null,
  }, options);
  return {
    ...result,
    schema: 'orange.ae-phase.local-envelope.v1',
    id: normalized.id,
    kind: normalized.kind,
    correlationId: normalized.correlationId,
    bodyHash: normalized.bodyHash,
    bodyBytes: normalized.bodyBytes,
  };
}

export function readAEPhaseEnvelopes(criteria = {}, options = {}) {
  const paths = resolvePaths(options);
  let rows = [];
  try {
    rows = fs.readFileSync(paths.inbox, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {}
  const sinceMs = criteria.sinceAt ? Date.parse(criteria.sinceAt) : 0;
  const filtered = rows.filter((row) => {
    if (criteria.id && row.id !== criteria.id) return false;
    if (criteria.kind && row.kind !== criteria.kind) return false;
    if (criteria.correlationId && row.correlationId !== criteria.correlationId) return false;
    if (criteria.sender && row.sender !== criteria.sender) return false;
    if (sinceMs && Date.parse(row.receivedAt || row.createdAt || 0) < sinceMs) return false;
    return true;
  });
  const limit = Math.max(1, Math.min(10_000, Number(criteria.limit || 100)));
  return filtered.slice(-limit);
}

export async function waitForAEPhaseEnvelope(criteria = {}, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 240_000));
  const pollMs = Math.max(5, Number(options.pollMs || 20));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = readAEPhaseEnvelopes({ ...criteria, limit: 1 }, options);
    if (matches.length) return matches[0];
    await Bun.sleep(pollMs);
  }
  throw new Error(`AE Phase envelope timeout: ${criteria.kind || '*'} ${criteria.correlationId || criteria.id || '*'}`);
}

export async function sendLocalAEPhaseSignal(signal, options = {}) {
  if (!signal?.id) throw new Error('AE Phase local signal requires id');
  const result = await sendLocalControl({
    control: 'signal',
    signal: {
      id: clean(signal.id, 96),
      kind: clean(signal.kind || 'semantic_signal', 48),
      referenceHash: clean(signal.referenceHash || sha256(Buffer.from(String(signal.id))), 64),
      referenceBytes: Math.max(0, Number(signal.referenceBytes || 0)),
    },
  }, options);
  return { ...result, schema: 'orange.ae-phase.local-signal.v1', id: signal.id };
}

export async function clearLocalAEPhaseSignal(options = {}) {
  const result = await sendLocalControl({ control: 'signal', clear: true }, options);
  return { ...result, schema: 'orange.ae-phase.local-signal-clear.v1' };
}

function printStatus() {
  const paths = resolvePaths();
  process.stdout.write(`${JSON.stringify(readJson(paths.snapshot) || {
    schema: AE_PHASE_FABRIC_SCHEMA,
    ok: false,
    status: 'AE_PHASE_FABRIC_NO_STATE',
  }, null, 2)}\n`);
}

if (import.meta.main) {
  const mode = process.argv[2] || process.env.ORANGE5_AE_PHASE_MODE || 'client';
  if (mode === 'status') {
    printStatus();
  } else if (mode === 'signal') {
    const raw = process.argv.slice(3).join(' ');
    const signal = raw ? JSON.parse(raw) : { id: `signal-${randomUUID()}`, kind: 'semantic_signal' };
    process.stdout.write(`${JSON.stringify(await sendLocalAEPhaseSignal(signal))}\n`);
  } else if (mode === 'envelope') {
    const raw = process.argv.slice(3).join(' ');
    if (!raw) throw new Error('AE Phase envelope mode requires a JSON envelope');
    process.stdout.write(`${JSON.stringify(await sendLocalAEPhaseEnvelope(JSON.parse(raw)))}\n`);
  } else {
    const fabric = mode === 'server'
      ? await startAEPhaseFabricServer()
      : await startAEPhaseFabricClient();
    const stop = async () => { await fabric.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
