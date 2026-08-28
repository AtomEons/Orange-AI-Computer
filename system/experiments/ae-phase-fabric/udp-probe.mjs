#!/usr/bin/env bun

const host = process.argv[2] || '10.0.99.1';
const port = Number(process.argv[3] || 8915);
const count = Number(process.argv[4] || 1_000);
const warmup = Math.min(50, Math.max(10, Math.ceil(count * 0.02)));
const outstanding = new Map();
const samples = [];
let sequence = 0;
let received = 0;
let timedOut = false;

const clockMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const socket = await Bun.udpSocket({
  connect: { hostname: host, port },
  socket: {
    data() {
      const started = outstanding.get(sequence);
      if (started != null) {
        const elapsed = clockMs() - started;
        outstanding.delete(sequence);
        if (sequence > warmup) samples.push(elapsed);
      }
      received += 1;
      if (sequence >= count + warmup) finish();
      else sendNext();
    },
  },
});

const timeout = setTimeout(() => { timedOut = true; finish(); }, 15_000);

function sendNext() {
  sequence += 1;
  const packet = Buffer.allocUnsafe(32);
  packet.writeBigUInt64BE(BigInt(sequence), 0);
  packet.writeBigUInt64BE(process.hrtime.bigint(), 8);
  packet.fill(0xA5, 16);
  outstanding.set(sequence, clockMs());
  socket.send(packet);
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function finish() {
  clearTimeout(timeout);
  socket.close();
  const sorted = [...samples].sort((a, b) => a - b);
  const result = {
    schema: 'orange.ae-phase.udp-baseline.v1',
    ok: !timedOut && sorted.length === count,
    transport: 'bun-udp-direct-ip',
    target: `${host}:${port}`,
    packetBytes: 32,
    warmup,
    sent: sequence,
    received,
    measured: sorted.length,
    loss: Math.max(0, sequence - received),
    rttMs: sorted.length ? {
      min: Number(sorted[0].toFixed(3)),
      p50: Number(percentile(sorted, 0.50).toFixed(3)),
      p95: Number(percentile(sorted, 0.95).toFixed(3)),
      p99: Number(percentile(sorted, 0.99).toFixed(3)),
      max: Number(sorted.at(-1).toFixed(3)),
      mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3)),
    } : null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

sendNext();
