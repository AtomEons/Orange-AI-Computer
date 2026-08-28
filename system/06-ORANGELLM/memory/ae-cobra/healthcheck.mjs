#!/usr/bin/env bun
// healthcheck.mjs — Æ Cobra Night-1 health endpoint.
//
// Bun HTTP server bound to 127.0.0.1:9101 inside Codexa WSL2. Loopback ONLY.
// Any non-loopback origin is refused with 403 before any handler runs.
//
// Routes
//   GET /healthz        → basic up: { ok, pid, uptime_s, listen, version }
//   GET /healthz/deep   → runs all 14 activation gates, returns full evidence
//                         (short-circuits on first FAIL like activation/runner.mjs)
//   GET /metrics        → { rss_bytes, ttft_ms (sample), json_validity_window }
//                         json_validity_window is a rolling 100-sample window of
//                         observed AgentTurn JSON validity rate from /event traffic
//                         observed by this process (samples self-reported by the
//                         Bun Flow Direct daemon via POST /metrics/json-sample;
//                         see "Operator wire-up" below).
//
// Honest-green discipline
//   * /healthz returns 200 only if the process itself is alive. It does NOT
//     attest to daemon health — that's what /healthz/deep is for.
//   * /healthz/deep runs the real 14-gate suite (same checks as
//     activation/runner.mjs). Gates that cannot run locally (host != codexa-wsl2)
//     report pass:null with a remote_recipe, NEVER pass:true. The aggregate
//     ok flag is true ONLY if every gate is pass:true.
//   * /metrics reports honest values or null + a reason. No fabricated numbers.
//
// Frontier isolation
//   * Bun's serve({ hostname }) binds only to the requested interface, but we
//     additionally verify the client socket remote address each request and
//     refuse 403 on anything that isn't 127.0.0.1 / ::1 / ::ffff:127.0.0.1.
//   * X-Forwarded-For / Forwarded headers are ignored on purpose. Loopback
//     trust comes from the kernel socket, not from request metadata.
//
// Operator wire-up (Flow Direct → healthcheck)
//   The Bun Flow Direct server (flow-direct/server.mjs on :7419) can post
//   one-line JSON samples to http://127.0.0.1:9101/metrics/json-sample of the
//   form {ok:bool, ttft_ms:number} after each /event round-trip. The
//   healthcheck ring-buffers the last 100 and exposes them via /metrics. If no
//   samples have ever arrived, the field is reported as null with reason
//   "no-samples-yet" rather than silently zero.
//
// Run
//   bun healthcheck.mjs
//   # or via systemd unit ae-cobra-healthcheck.service (separate from ae-cobra.service)
//
// Doctrine reference
//   * Night-1 brief: daemon at 127.0.0.1:9100 (Bun) inside WSL2; this
//     healthcheck on 127.0.0.1:9101 (separate port, separate process).
//   * The existing scaffolding's flow-direct uses :7419 historically; both
//     daemon-port shapes are honored — gates probe env.bun_url, and this
//     healthcheck is independent of either.
//
// Honest gap
//   * /metrics ttft_ms reports the most recent self-reported sample only.
//     A full TTFT cold-load measurement is the job of gate 05-ttft-cold,
//     which /healthz/deep runs. We do NOT re-measure TTFT here on every
//     /metrics hit; that would warm the model and lie about "cold" forever.

import { performance } from 'node:perf_hooks';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Config

const VERSION = '0.1.0';
const HOSTNAME = '127.0.0.1';
const PORT = Number(process.env.AE_COBRA_HEALTH_PORT || 9101);
const STARTED_AT = Date.now();
const STARTED_PERF = performance.now();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES_DIR = path.join(HERE, 'activation', 'gates');

// Loopback addresses we accept. Anything else → 403.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Rolling window of JSON-validity samples reported by Flow Direct.
const WINDOW_MAX = 100;
const samples = []; // [{ ok: bool, ttft_ms: number, t: epoch_ms }]

function pushSample(s) {
  samples.push(s);
  if (samples.length > WINDOW_MAX) samples.shift();
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate loader (mirrors filenames in activation/gates/)
// Each gate file exports `check(env, opts)` returning { pass, details, latency_ms }.

const GATE_FILES = [
  '01-gguf-integrity.mjs',
  '02-ctx-size-bounded.mjs',
  '03-mlock-bound.mjs',
  '04-rss-ceiling.mjs',
  '05-ttft-cold.mjs',
  '06-json-validity-100-pair.mjs',
  '07-healthcheck-green.mjs',
  '08-lease-gated-outbound.mjs',
  '09-hermes-integration.mjs',
  '10-no-frontier-reach.mjs',
  '11-loopback-only.mjs',
  '12-receipt-writes.mjs',
  '13-prior-sha-chain.mjs',
  '14-burn-in-60s.mjs',
];

async function loadGate(file) {
  // Use absolute file URL so dynamic import works on Windows (dev) and Linux (prod).
  const abs = path.join(GATES_DIR, file);
  const url = new URL('file://' + abs.replace(/\\/g, '/')).href;
  const mod = await import(url);
  if (typeof mod.check !== 'function') {
    throw new Error(`gate ${file}: missing exported check()`);
  }
  return { id: file.replace(/\.mjs$/, ''), check: mod.check };
}

async function runDeep() {
  const t0 = performance.now();
  const evidence = [];
  let firstFail = null;

  for (const file of GATE_FILES) {
    let gate;
    try {
      gate = await loadGate(file);
    } catch (e) {
      const rec = {
        gate: file.replace(/\.mjs$/, ''),
        pass: false,
        details: { reason: 'gate load failed', error: String(e && e.message || e) },
        latency_ms: 0,
      };
      evidence.push(rec);
      firstFail = firstFail || rec.gate;
      break; // short-circuit, same as runner.mjs
    }

    const r = await gate.check({}, {});
    // Normalize shape: gates return { pass, details, latency_ms }.
    const rec = {
      gate: gate.id,
      pass: r.pass,
      details: r.details || {},
      latency_ms: r.latency_ms ?? null,
    };
    evidence.push(rec);

    if (r.pass !== true) {
      // pass === false OR pass === null both short-circuit; null is honest gap.
      firstFail = gate.id;
      break;
    }
  }

  const all_green = evidence.length === GATE_FILES.length &&
                    evidence.every(e => e.pass === true);

  return {
    ok: all_green,
    gate_failed: firstFail,
    gates_total: GATE_FILES.length,
    gates_ran: evidence.length,
    duration_ms: Math.round((performance.now() - t0) * 1000) / 1000,
    evidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /metrics helpers

async function readSelfRssBytes() {
  // Linux/WSL2: /proc/self/status VmRSS in kB. Windows dev: not present → null.
  try {
    const txt = await readFile('/proc/self/status', 'utf8');
    const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(txt);
    if (!m) return null;
    return Number(m[1]) * 1024;
  } catch {
    return null;
  }
}

async function readDaemonRssBytes() {
  // Sum llama-server + flow-direct/server.mjs RSS, same shape as gate 04.
  try {
    const entries = await readdir('/proc');
    const pids = entries.filter(e => /^\d+$/.test(e)).map(Number);
    let total = 0;
    let matched = 0;
    for (const pid of pids) {
      const [comm, cmd, status] = await Promise.all([
        readFile(`/proc/${pid}/comm`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
      ]);
      const commT = comm.trim();
      const cmdParts = cmd.split('\0').filter(Boolean);
      const isLlama = commT === 'llama-server';
      const isBun = (commT === 'bun' || commT === 'node') &&
                    cmdParts.some(a => /flow-direct\/server\.mjs$/.test(a));
      if (!isLlama && !isBun) continue;
      const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
      if (m) { total += Number(m[1]) * 1024; matched++; }
    }
    if (matched === 0) return { bytes: null, reason: 'no daemon processes found' };
    return { bytes: total, processes: matched };
  } catch (e) {
    return { bytes: null, reason: 'proc-read-failed', error: String(e && e.message || e) };
  }
}

function jsonValidityWindow() {
  if (samples.length === 0) {
    return { rate: null, count: 0, reason: 'no-samples-yet' };
  }
  const ok = samples.filter(s => s.ok === true).length;
  return { rate: +(ok / samples.length).toFixed(4), count: samples.length, ok, bad: samples.length - ok };
}

function recentTtftMs() {
  if (samples.length === 0) return { ms: null, reason: 'no-samples-yet' };
  const last = samples[samples.length - 1];
  return { ms: last.ttft_ms ?? null, sampled_at: last.t };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function isLoopback(remoteAddr) {
  if (!remoteAddr) return false;
  // Bun's server.requestIP() returns { address, family, port } or null.
  // Some Bun versions hand back the raw string; handle both.
  const addr = typeof remoteAddr === 'string' ? remoteAddr : remoteAddr.address;
  if (!addr) return false;
  return LOOPBACK.has(addr);
}

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  async fetch(req, srv) {
    const remote = srv.requestIP(req);
    if (!isLoopback(remote)) {
      return json(
        { ok: false, error: 'forbidden', reason: 'non-loopback origin refused', remote: remote?.address ?? null },
        403,
      );
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // GET /healthz — basic up
    if (method === 'GET' && url.pathname === '/healthz') {
      return json({
        ok: true,
        pid: process.pid,
        uptime_s: Math.round((performance.now() - STARTED_PERF) / 10) / 100,
        started_at: STARTED_AT,
        listen: `${HOSTNAME}:${PORT}`,
        version: VERSION,
        scope: 'process-up-only (use /healthz/deep for the 14-gate daemon check)',
      });
    }

    // GET /healthz/deep — full 14-gate evidence
    if (method === 'GET' && url.pathname === '/healthz/deep') {
      const out = await runDeep();
      return json(out, out.ok ? 200 : 503);
    }

    // GET /metrics
    if (method === 'GET' && url.pathname === '/metrics') {
      const [selfRss, daemonRss] = await Promise.all([readSelfRssBytes(), readDaemonRssBytes()]);
      return json({
        ok: true,
        pid: process.pid,
        uptime_s: Math.round((performance.now() - STARTED_PERF) / 10) / 100,
        rss: {
          healthcheck_self_bytes: selfRss,
          daemon_total_bytes: daemonRss.bytes,
          daemon_processes: daemonRss.processes ?? null,
          daemon_reason: daemonRss.reason ?? null,
        },
        ttft: recentTtftMs(),
        json_validity_window: jsonValidityWindow(),
        sample_capacity: WINDOW_MAX,
      });
    }

    // POST /metrics/json-sample — Flow Direct self-reports validity samples
    // body: { ok: bool, ttft_ms: number }
    if (method === 'POST' && url.pathname === '/metrics/json-sample') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: 'invalid json body' }, 400);
      }
      if (typeof body?.ok !== 'boolean') {
        return json({ ok: false, error: 'field "ok" (boolean) required' }, 400);
      }
      const ttft = Number(body.ttft_ms);
      pushSample({
        ok: body.ok,
        ttft_ms: Number.isFinite(ttft) ? ttft : null,
        t: Date.now(),
      });
      return json({ ok: true, samples_held: samples.length, capacity: WINDOW_MAX });
    }

    return json({ ok: false, error: 'not found', path: url.pathname }, 404);
  },
  error(err) {
    return json({ ok: false, error: 'internal', message: String(err && err.message || err) }, 500);
  },
});

// Bun.serve returns synchronously; surface the bind for the operator.
console.log(JSON.stringify({
  msg: 'ae-cobra-healthcheck up',
  listen: `${server.hostname}:${server.port}`,
  pid: process.pid,
  version: VERSION,
  routes: ['GET /healthz', 'GET /healthz/deep', 'GET /metrics', 'POST /metrics/json-sample'],
}));

// Graceful shutdown
function shutdown(sig) {
  console.log(JSON.stringify({ msg: 'shutdown', signal: sig, pid: process.pid }));
  try { server.stop(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
