import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AE_LINK_PROTOCOL,
  AELink,
  AELinkJournalIntegrityError,
  AELinkProtocolError,
  ChannelScheduler,
  FrameDecoder,
  UnackedJournal,
  createBunTcpConnector,
  createBunTcpServer,
  encodeFrame,
} from '../ae-link/index.mjs';

const INTEGRITY_KEY = 'ae-link-test-key-32-bytes-minimum';
const roots = [];
const disposables = [];

function fixture(name = 'node') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orange5-ae-link-${name}-`));
  roots.push(root);
  return { root, journalPath: path.join(root, 'unacked.json') };
}

function cursors(overrides = {}) {
  return { control: 0, memory: 0, model: 0, telemetry: 0, artifact: 0, ...overrides };
}

function remoteFrame(type, fields = {}, sender = 'peer-b') {
  return encodeFrame({ protocol: AE_LINK_PROTOCOL, type, sender, ...fields }, INTEGRITY_KEY);
}

function decodeWrite(bytes) {
  return new FrameDecoder(INTEGRITY_KEY).push(bytes)[0];
}

function fakeTransport(writes = []) {
  return {
    closed: false,
    write(bytes) {
      writes.push(Buffer.from(bytes));
      return bytes.byteLength;
    },
    terminate() {
      this.closed = true;
    },
  };
}

function completeHandshake(link, transport, { received = cursors(), stateRoot = null } = {}) {
  link.attachTransport(transport);
  link.receiveBytes(remoteFrame('hello', { resume: { received }, stateRoot }), transport);
  expect(link.state).toBe('connected');
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(message);
}

afterEach(async () => {
  while (disposables.length) {
    try {
      await disposables.pop()();
    } catch {}
  }
  while (roots.length) {
    const root = roots.pop();
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(10);
      }
    }
    if (lastError) throw lastError;
  }
});

describe('AE Link isolated backplane proof', () => {
  test('decodes fragmented and coalesced length-prefixed frames', () => {
    const frames = [
      encodeFrame({ protocol: AE_LINK_PROTOCOL, type: 'data', sender: 'a', channel: 'memory', seq: 1, payload: { value: 'one' } }, INTEGRITY_KEY),
      encodeFrame({ protocol: AE_LINK_PROTOCOL, type: 'ack', sender: 'b', channel: 'memory', ack: 1 }, INTEGRITY_KEY),
    ];
    const wire = Buffer.concat(frames);
    const decoder = new FrameDecoder(INTEGRITY_KEY);
    const decoded = [];
    const chunkSizes = [1, 2, 7, 3, 19, 5, 11];
    let offset = 0;
    let index = 0;
    while (offset < wire.byteLength) {
      const end = Math.min(wire.byteLength, offset + chunkSizes[index++ % chunkSizes.length]);
      decoded.push(...decoder.push(wire.subarray(offset, end)));
      offset = end;
    }

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ type: 'data', channel: 'memory', seq: 1, payload: { value: 'one' } });
    expect(decoded[1]).toMatchObject({ type: 'ack', channel: 'memory', ack: 1 });
    expect(decoder.buffer.byteLength).toBe(0);
  });

  test('schedules fixed channel priority while preserving per-channel FIFO', () => {
    const scheduler = new ChannelScheduler();
    scheduler.enqueue({ channel: 'artifact', seq: 1 });
    scheduler.enqueue({ channel: 'control', seq: 1 });
    scheduler.enqueue({ channel: 'telemetry', seq: 1 });
    scheduler.enqueue({ channel: 'model', seq: 1 });
    scheduler.enqueue({ channel: 'memory', seq: 1 });
    scheduler.enqueue({ channel: 'control', seq: 2 });

    const order = [];
    while (scheduler.size) order.push(scheduler.dequeue());
    expect(order.map(({ channel, seq }) => `${channel}:${seq}`)).toEqual([
      'control:1',
      'control:2',
      'memory:1',
      'model:1',
      'telemetry:1',
      'artifact:1',
    ]);
  });

  test('backs off, reconnects, and resumes without replaying a peer-confirmed frame', async () => {
    const { journalPath } = fixture('resume');
    const connections = [];
    const timers = [];
    const connector = async (handlers) => {
      const writes = [];
      const transport = fakeTransport(writes);
      connections.push({ handlers, transport, writes });
      handlers.onOpen(transport);
      return transport;
    };
    const link = new AELink({
      id: 'peer-a',
      journalPath,
      integrityKey: INTEGRITY_KEY,
      connector,
      heartbeatMs: 0,
      reconnectBaseMs: 10,
      reconnectMaxMs: 40,
      setTimeoutFn(fn, ms) {
        const timer = { fn, ms, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    disposables.push(() => link.stop());

    await link.start();
    const first = connections[0];
    link.receiveBytes(remoteFrame('hello', { resume: { received: cursors() }, stateRoot: null }), first.transport);
    expect(link.state).toBe('connected');
    expect(link.send('artifact', { sha256: 'abc' })).toBe(1);
    expect(link.journal.size).toBe(1);
    expect(first.writes.map(decodeWrite).filter((message) => message.type === 'data')).toHaveLength(1);

    link.transportClosed('deterministic-drop', first.transport);
    expect(link.state).toBe('backoff');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(10);
    timers.shift().fn();
    await waitFor(() => connections.length === 2, 'reconnect attempt did not run');

    const second = connections[1];
    expect(link.state).toBe('handshaking');
    link.receiveBytes(remoteFrame('hello', {
      resume: { received: cursors({ artifact: 1 }) },
      stateRoot: null,
    }), second.transport);
    expect(link.state).toBe('connected');
    expect(link.journal.size).toBe(0);
    expect(second.writes.map(decodeWrite).filter((message) => message.type === 'data')).toHaveLength(0);
    expect(link.stateHistory.map(({ state }) => state).slice(-6)).toEqual([
      'connected',
      'disconnected',
      'backoff',
      'connecting',
      'handshaking',
      'connected',
    ]);
  });

  test('suppresses duplicate delivery and repeats the cumulative acknowledgement', () => {
    const { journalPath } = fixture('duplicates');
    const delivered = [];
    const writes = [];
    const transport = fakeTransport(writes);
    const link = new AELink({
      id: 'peer-a',
      journalPath,
      integrityKey: INTEGRITY_KEY,
      heartbeatMs: 0,
      onMessage: (message) => delivered.push(message),
    });
    disposables.push(() => link.stop());
    completeHandshake(link, transport);

    const data = remoteFrame('data', { channel: 'model', seq: 1, payload: { token: 7 } });
    link.receiveBytes(data, transport);
    link.receiveBytes(data, transport);

    expect(delivered).toEqual([{ sender: 'peer-b', channel: 'model', seq: 1, payload: { token: 7 } }]);
    expect(link.status().stats.duplicates).toBe(1);
    expect(writes.map(decodeWrite).filter((message) => message.type === 'ack')).toEqual([
      expect.objectContaining({ channel: 'model', ack: 1 }),
      expect.objectContaining({ channel: 'model', ack: 1 }),
    ]);
  });

  test('persists unacked channel sequences across a process-style reopen', () => {
    const { journalPath } = fixture('journal');
    let journal = new UnackedJournal({ filePath: journalPath, nodeId: 'peer-a', integrityKey: INTEGRITY_KEY });
    journal.append({
      protocol: AE_LINK_PROTOCOL,
      type: 'data',
      sender: 'peer-a',
      channel: 'memory',
      seq: 1,
      payload: { root: 'r1' },
    });

    journal = new UnackedJournal({ filePath: journalPath, nodeId: 'peer-a', integrityKey: INTEGRITY_KEY });
    expect(journal.verify()).toMatchObject({ ok: true, pending: 1 });
    expect(journal.next('memory')).toBe(2);
    expect(journal.pending()[0]).toMatchObject({ channel: 'memory', seq: 1, payload: { root: 'r1' } });
    expect(journal.acknowledge('memory', 1)).toBe(1);
    expect(new UnackedJournal({ filePath: journalPath, nodeId: 'peer-a', integrityKey: INTEGRITY_KEY }).size).toBe(0);
  });

  test('emits signed heartbeats and invokes state-root reconciliation on divergence', () => {
    const { journalPath } = fixture('roots');
    const mismatches = [];
    const intervals = [];
    const writes = [];
    const transport = fakeTransport(writes);
    const link = new AELink({
      id: 'peer-a',
      journalPath,
      integrityKey: INTEGRITY_KEY,
      heartbeatMs: 25,
      clock: () => 1234,
      getStateRoot: () => 'root-a',
      onStateRootMismatch: (mismatch) => mismatches.push(mismatch),
      setIntervalFn(fn, ms) {
        const timer = { fn, ms, unref() {} };
        intervals.push(timer);
        return timer;
      },
      clearIntervalFn() {},
    });
    disposables.push(() => link.stop());
    completeHandshake(link, transport, { stateRoot: 'root-b' });
    expect(mismatches).toEqual([expect.objectContaining({ localRoot: 'root-a', remoteRoot: 'root-b', phase: 'hello' })]);
    expect(intervals[0].ms).toBe(25);

    intervals[0].fn();
    const heartbeat = writes.map(decodeWrite).findLast((message) => message.type === 'heartbeat');
    expect(heartbeat).toMatchObject({ heartbeat: 1, received: cursors(), stateRoot: 'root-a', at: 1234 });

    link.receiveBytes(remoteFrame('heartbeat', {
      heartbeat: 1,
      received: cursors(),
      stateRoot: 'root-c',
      at: 1234,
    }), transport);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[1]).toMatchObject({ remoteRoot: 'root-c', phase: 'heartbeat' });
  });

  test('fails closed on wire or disk tampering', () => {
    const valid = encodeFrame({
      protocol: AE_LINK_PROTOCOL,
      type: 'data',
      sender: 'peer-a',
      channel: 'control',
      seq: 1,
      payload: { allow: false },
    }, INTEGRITY_KEY);
    const signed = JSON.parse(valid.subarray(4).toString('utf8'));
    signed.payload.allow = true;
    const tamperedBody = Buffer.from(JSON.stringify(signed));
    const tamperedFrame = Buffer.alloc(4 + tamperedBody.byteLength);
    tamperedFrame.writeUInt32BE(tamperedBody.byteLength, 0);
    tamperedBody.copy(tamperedFrame, 4);
    expect(() => new FrameDecoder(INTEGRITY_KEY).push(tamperedFrame)).toThrow(AELinkProtocolError);
    expect(() => new FrameDecoder(INTEGRITY_KEY).push(tamperedFrame)).toThrow('authentication failed');

    const { journalPath } = fixture('tamper');
    const journal = new UnackedJournal({ filePath: journalPath, nodeId: 'peer-a', integrityKey: INTEGRITY_KEY });
    journal.append({
      protocol: AE_LINK_PROTOCOL,
      type: 'data',
      sender: 'peer-a',
      channel: 'control',
      seq: 1,
      payload: { allow: false },
    });
    const document = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    document.records[0].payload.allow = true;
    fs.writeFileSync(journalPath, JSON.stringify(document), 'utf8');
    expect(() => new UnackedJournal({ filePath: journalPath, nodeId: 'peer-a', integrityKey: INTEGRITY_KEY }))
      .toThrow(AELinkJournalIntegrityError);
  });

  test('exchanges and acknowledges multiplexed frames over one Bun TCP connection', async () => {
    const serverFixture = fixture('tcp-server');
    const clientFixture = fixture('tcp-client');
    const delivered = [];
    let serverLink = null;
    const listener = createBunTcpServer({
      port: 0,
      createLink() {
        serverLink = new AELink({
          id: 'tcp-server',
          journalPath: serverFixture.journalPath,
          integrityKey: INTEGRITY_KEY,
          heartbeatMs: 0,
          onMessage: (message) => delivered.push(message),
        });
        return serverLink;
      },
    });
    const client = new AELink({
      id: 'tcp-client',
      journalPath: clientFixture.journalPath,
      integrityKey: INTEGRITY_KEY,
      heartbeatMs: 0,
      connector: createBunTcpConnector({ port: listener.port }),
    });
    disposables.push(() => listener.stop(true));
    disposables.push(() => client.stop());

    await client.start();
    await waitFor(() => client.state === 'connected' && serverLink?.state === 'connected', 'TCP peers did not handshake');
    client.send('memory', { root: 'm1' });
    client.send('telemetry', { latencyMs: 3 });
    await waitFor(() => delivered.length === 2 && client.journal.size === 0, 'TCP frames were not delivered and acknowledged');

    expect(delivered).toEqual([
      expect.objectContaining({ channel: 'memory', seq: 1, payload: { root: 'm1' } }),
      expect.objectContaining({ channel: 'telemetry', seq: 1, payload: { latencyMs: 3 } }),
    ]);
    expect(listener.activeLinks).toHaveLength(1);
    expect(client.status()).toMatchObject({ state: 'connected', pending: 0, stats: { sent: 2 } });
  });
});
