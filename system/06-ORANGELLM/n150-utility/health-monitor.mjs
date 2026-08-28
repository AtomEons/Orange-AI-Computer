#!/usr/bin/env node
// n150-utility/health-monitor.mjs — Node 20+ daemon
// ----------------------------------------------------------------------------
// Port: 127.0.0.1:7482 (loopback only; the Cockpit reaches us via its tunnel)
//
// Purpose:
//   Monitor the three stock-only utility daemons co-resident on the N150
//   (Beelink, 4 cores, 16 GB) and emit rolled-up health to the Cockpit shadow
//   cache. Wave 1 doctrine: STOCK WEIGHTS ONLY. This daemon does no inference;
//   it only probes /healthz endpoints, records uptime, latency, and error
//   rate, and pushes a JSON snapshot to the Cockpit's shadow endpoint.
//
//   Targets (all loopback):
//     1. classifier      127.0.0.1:7480/healthz   qwen3:0.6b lane router
//     2. embedder        127.0.0.1:8798/healthz   nomic-embed-text Graph Weaver
//     3. fallback-chat   127.0.0.1:7481/healthz   qwen3:0.6b emergency chat
//
//   Plus a passive Ollama check at 127.0.0.1:11434/api/tags so we can
//   distinguish "daemon down" from "Ollama down beneath it" — both are
//   surfaced honestly. Mom's Law: receipts only, no theater.
//
// Surface:
//   GET  /healthz   → liveness for the monitor itself (counters, last tick)
//   GET  /snapshot  → most-recent rolled-up snapshot served from memory
//   GET  /targets   → static list of monitored targets + their tick state
//   POST /tick      → force an immediate probe cycle (for tests / cron)
//
// Hot-swap law: this daemon never holds model handles. Hot-swap is the
// concern of the daemons it watches. We report the model tag each target
// claims, but we do not pin or version-lock. If a target swaps stock weights
// mid-flight, our next snapshot will reflect the new tag.
//
// Receipts:
//   - Every probe cycle is logged to STATE_DIR/health.jsonl (append-only).
//   - Every shadow-cache push (success or failure) is logged to
//     STATE_DIR/shadow.jsonl. No silent loss; rotation is the operator's cron.
//
// Failure law:
//   - Target down → we record { up: false, error, latency_ms } and keep going.
//   - Cockpit shadow push fails → we record it and keep going. The monitor
//     itself MUST stay up even when downstream is dead, because the Cockpit
//     uses /snapshot as the fallback when its push channel is degraded.
// ----------------------------------------------------------------------------

import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -- Paths -----------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname);
const STATE_DIR = resolve(ROOT, "state", "health-monitor");
const HEALTH_LOG = resolve(STATE_DIR, "health.jsonl");
const SHADOW_LOG = resolve(STATE_DIR, "shadow.jsonl");

// -- Constants -------------------------------------------------------------

export const VERSION = "n150-health-monitor.v0.1.0";
export const HOST = process.env.N150_HEALTH_HOST || "127.0.0.1";
export const PORT = parseInt(process.env.N150_HEALTH_PORT || "7482", 10);

// Probe cadence. 10 s is fast enough for the Cockpit grid to feel live
// without making the N150 work for nothing. The probe timeout is half the
// cadence so a slow target cannot stack ticks.
export const TICK_INTERVAL_MS = parseInt(process.env.N150_HEALTH_TICK_MS || "10000", 10);
export const PROBE_TIMEOUT_MS = parseInt(process.env.N150_HEALTH_PROBE_TIMEOUT_MS || "4000", 10);

// Rolling window over which we compute latency p50/p95 and error_rate.
// 60 samples × 10 s tick = 10 minutes of memory. Bounded so the daemon
// never grows past ~100 KB resident regardless of uptime.
export const WINDOW_SIZE = parseInt(process.env.N150_HEALTH_WINDOW || "60", 10);

// Cockpit shadow cache endpoint. The Cockpit accepts a POST snapshot and
// caches it for the grid view. We never block on this — if the Cockpit is
// unreachable, we just keep our own /snapshot fresh and try again next tick.
export const COCKPIT_SHADOW_URL = process.env.N150_HEALTH_COCKPIT_URL
  || "http://127.0.0.1:8787/orange3/shadow/n150";
export const COCKPIT_TIMEOUT_MS = parseInt(process.env.N150_HEALTH_COCKPIT_TIMEOUT_MS || "3000", 10);
export const COCKPIT_TOKEN = process.env.N150_HEALTH_COCKPIT_TOKEN || ""; // optional bearer

const BODY_CAP_BYTES = 16384; // /tick has no body but be defensive

// -- Targets ---------------------------------------------------------------
//
// Loopback only. These are the three Wave-1 stock-only utility daemons.
// Each entry is: { name, kind, url, optional }
//   - kind is reported to the Cockpit as the grid badge.
//   - optional=true means a 503 (gated) is still "up" — used for the
//     fallback chat which is asleep when Codexa is healthy.

export const TARGETS = Object.freeze([
  {
    name: "classifier",
    kind: "lane-router",
    url: `http://${process.env.N150_CLASSIFIER_HOST || "127.0.0.1"}:${process.env.N150_CLASSIFIER_PORT || "7480"}/healthz`,
    optional: false,
  },
  {
    name: "embedder",
    kind: "graph-weaver-embedder",
    url: `http://${process.env.N150_EMBEDDER_HOST || "127.0.0.1"}:${process.env.N150_EMBEDDER_PORT || "8798"}/healthz`,
    optional: false,
  },
  {
    name: "fallback-chat",
    kind: "emergency-chat",
    url: `http://${process.env.N150_FALLBACK_HOST || "127.0.0.1"}:${process.env.N150_FALLBACK_PORT || "7481"}/healthz`,
    optional: true, // 503-gated is allowed; only network-level failure marks it down
  },
  {
    name: "ollama",
    kind: "model-host",
    url: `${process.env.N150_OLLAMA_BASE || "http://127.0.0.1:11434"}/api/tags`,
    optional: false,
  },
]);

// -- State -----------------------------------------------------------------

// In-memory rolling sample buffers, one per target. Each sample is:
//   { t, ok, status, latency_ms, error?, body? }
const buffers = new Map();
for (const t of TARGETS) buffers.set(t.name, []);

// First-seen timestamps so we can report uptime per target.
const firstUp = new Map();   // name -> ms since epoch when first ok=true
const lastUp = new Map();    // name -> ms since epoch last ok=true
const lastDown = new Map();  // name -> ms since epoch last ok=false

// Daemon counters.
const counters = {
  ticks_total: 0,
  ticks_failed: 0,
  shadow_pushes_total: 0,
  shadow_pushes_failed: 0,
  started_at: Date.now(),
  last_tick_at: 0,
  last_snapshot: null, // last full snapshot object, served by /snapshot
};

// -- Helpers ---------------------------------------------------------------

async function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

async function appendJsonl(path, obj) {
  // Best-effort: if disk is full we still keep the in-memory snapshot.
  try {
    await appendFile(path, JSON.stringify(obj) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`[n150-health-monitor] jsonl write failed ${path}: ${err.message}\n`);
  }
}

function pushBounded(arr, sample, max = WINDOW_SIZE) {
  arr.push(sample);
  while (arr.length > max) arr.shift();
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[idx];
}

export function summarize(samples, opts = {}) {
  // Pure helper — exported for tests. Computes the per-target rollup.
  if (!samples || samples.length === 0) {
    return {
      samples: 0,
      up: false,
      error_rate: null,
      latency_ms_p50: null,
      latency_ms_p95: null,
      latency_ms_last: null,
      last_status: null,
      last_error: null,
      last_tick_at: null,
    };
  }
  const oks = samples.filter((s) => s.ok).length;
  const latencies = samples
    .filter((s) => typeof s.latency_ms === "number" && isFinite(s.latency_ms))
    .map((s) => s.latency_ms)
    .sort((a, b) => a - b);
  const last = samples[samples.length - 1];
  return {
    samples: samples.length,
    up: !!last.ok,
    error_rate: 1 - oks / samples.length,
    latency_ms_p50: percentile(latencies, 0.5),
    latency_ms_p95: percentile(latencies, 0.95),
    latency_ms_last: typeof last.latency_ms === "number" ? last.latency_ms : null,
    last_status: last.status ?? null,
    last_error: last.error ?? null,
    last_tick_at: last.t,
  };
}

function uptimeMs(name) {
  const first = firstUp.get(name);
  const last = lastUp.get(name);
  if (!first || !last) return 0;
  return Math.max(0, last - first);
}

// -- Probing ---------------------------------------------------------------

export async function probeTarget(target, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, nowFn = Date.now } = {}) {
  // Returns a sample row. Never throws — failures are encoded as ok=false.
  const t = nowFn();
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.url, {
      method: "GET",
      signal: ctl.signal,
      headers: { "Accept": "application/json", "User-Agent": `${VERSION}` },
    });
    const latency_ms = Math.round(performance.now() - started);
    let body = null;
    try {
      const text = await res.text();
      if (text && text.length > 0 && text.length < BODY_CAP_BYTES) {
        try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 512) }; }
      }
    } catch { /* ignore body read failure */ }
    // optional=true targets accept 503 as "alive but gated"
    const okStatus = res.status >= 200 && res.status < 300;
    const gated = target.optional && res.status === 503;
    return {
      t,
      ok: okStatus || gated,
      status: res.status,
      latency_ms,
      body,
      gated: gated || undefined,
      model: body && typeof body.model === "string" ? body.model : (body && body.active_model) || undefined,
    };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - started);
    return {
      t,
      ok: false,
      status: 0,
      latency_ms,
      error: err && err.name === "AbortError" ? "timeout" : (err.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function recordSample(name, sample, opts = {}) {
  // Pure-ish helper around the module-global buffers/firstUp maps. Exported
  // so tests can drive deterministic state without standing up a server.
  const now = opts.nowFn ? opts.nowFn() : sample.t || Date.now();
  if (!buffers.has(name)) buffers.set(name, []);
  pushBounded(buffers.get(name), sample);
  if (sample.ok) {
    if (!firstUp.has(name)) firstUp.set(name, now);
    lastUp.set(name, now);
  } else {
    lastDown.set(name, now);
  }
}

export function buildSnapshot({ nowFn = Date.now } = {}) {
  const now = nowFn();
  const targets = {};
  for (const t of TARGETS) {
    const samples = buffers.get(t.name) || [];
    const sum = summarize(samples);
    const lastSample = samples[samples.length - 1];
    targets[t.name] = {
      kind: t.kind,
      url: t.url,
      optional: t.optional,
      ...sum,
      uptime_ms: uptimeMs(t.name),
      gated: lastSample && lastSample.gated ? true : false,
      model: lastSample && lastSample.model ? lastSample.model : null,
    };
  }
  return {
    schema: "ae.n150.health.snapshot.v1",
    host: "n150",
    version: VERSION,
    generated_at: now,
    monitor: {
      uptime_ms: now - counters.started_at,
      ticks_total: counters.ticks_total,
      ticks_failed: counters.ticks_failed,
      shadow_pushes_total: counters.shadow_pushes_total,
      shadow_pushes_failed: counters.shadow_pushes_failed,
      last_tick_at: counters.last_tick_at,
    },
    targets,
  };
}

// -- Cockpit shadow push ---------------------------------------------------

export async function pushShadow(snapshot, { fetchImpl = fetch, timeoutMs = COCKPIT_TIMEOUT_MS, url = COCKPIT_SHADOW_URL, token = COCKPIT_TOKEN } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
      "X-AE-Host": "n150",
      "X-AE-Schema": snapshot.schema,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchImpl(url, {
      method: "POST",
      signal: ctl.signal,
      headers,
      body: JSON.stringify(snapshot),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.name === "AbortError" ? "timeout" : (err.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

// -- Tick loop -------------------------------------------------------------

export async function runOneTick({ fetchImpl = fetch, push = true, nowFn = Date.now } = {}) {
  // Mom's Law: receipts only, no silent loss. Make sure the state dir is
  // present before we start writing — start() does this at boot, but /tick
  // can be invoked before start() in tests / cron-driven contexts.
  await ensureStateDir();
  counters.ticks_total += 1;
  counters.last_tick_at = nowFn();
  let anyFailed = false;
  // Probe all targets in parallel — N150 has 4 cores; 4 outbound localhost
  // GETs is trivial and keeps the tick within PROBE_TIMEOUT_MS even when one
  // target is slow.
  const results = await Promise.all(
    TARGETS.map((t) => probeTarget(t, { fetchImpl }).then((sample) => ({ t, sample })))
  );
  for (const { t, sample } of results) {
    recordSample(t.name, sample, { nowFn });
    await appendJsonl(HEALTH_LOG, {
      tick: counters.ticks_total,
      target: t.name,
      ...sample,
    });
    if (!sample.ok) anyFailed = true;
  }
  if (anyFailed) counters.ticks_failed += 1;
  const snapshot = buildSnapshot({ nowFn });
  counters.last_snapshot = snapshot;
  if (push) {
    counters.shadow_pushes_total += 1;
    const r = await pushShadow(snapshot, { fetchImpl });
    if (!r.ok) counters.shadow_pushes_failed += 1;
    await appendJsonl(SHADOW_LOG, { tick: counters.ticks_total, t: counters.last_tick_at, ...r });
  }
  return snapshot;
}

// -- HTTP surface ----------------------------------------------------------

function send(res, status, body, extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-AE-Host": "n150",
    "X-AE-Lane": "utility-health-monitor",
    ...extraHeaders,
  });
  res.end(text);
}

async function readJson(req, max = BODY_CAP_BYTES) {
  return new Promise((resolveFn, rejectFn) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        rejectFn(new Error("payload_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveFn({});
      try { resolveFn(JSON.parse(raw)); } catch (e) { rejectFn(e); }
    });
    req.on("error", rejectFn);
  });
}

export function createHttpHandler({ fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    // Loopback-only enforcement when bound to 127.0.0.1.
    const remote = req.socket && req.socket.remoteAddress;
    if (HOST === "127.0.0.1" && remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
      return send(res, 403, { error: "forbidden", reason: "loopback_only" });
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";

    if (method === "GET" && path === "/healthz") {
      return send(res, 200, {
        ok: true,
        version: VERSION,
        bind: `${HOST}:${PORT}`,
        uptime_ms: Date.now() - counters.started_at,
        ticks_total: counters.ticks_total,
        ticks_failed: counters.ticks_failed,
        shadow_pushes_total: counters.shadow_pushes_total,
        shadow_pushes_failed: counters.shadow_pushes_failed,
        last_tick_at: counters.last_tick_at,
      });
    }

    if (method === "GET" && path === "/snapshot") {
      // If we haven't ticked yet, build one now from empty buffers so the
      // schema is stable for callers.
      const snap = counters.last_snapshot || buildSnapshot();
      return send(res, 200, snap);
    }

    if (method === "GET" && path === "/targets") {
      const out = TARGETS.map((t) => ({
        ...t,
        samples: (buffers.get(t.name) || []).length,
        last: (buffers.get(t.name) || []).slice(-1)[0] || null,
      }));
      return send(res, 200, { targets: out });
    }

    if (method === "POST" && path === "/tick") {
      try {
        await readJson(req); // accept empty body
        const snap = await runOneTick({ fetchImpl });
        return send(res, 200, { ok: true, snapshot: snap });
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message || String(err) });
      }
    }

    return send(res, 404, { error: "not_found", path });
  };
}

// -- Lifecycle -------------------------------------------------------------

let _intervalHandle = null;
let _serverHandle = null;

export async function start({ fetchImpl = fetch } = {}) {
  await ensureStateDir();
  const handler = createHttpHandler({ fetchImpl });
  const server = createServer(handler);
  await new Promise((resolveFn, rejectFn) => {
    server.once("error", rejectFn);
    server.listen(PORT, HOST, () => {
      process.stderr.write(`[n150-health-monitor] listening on http://${HOST}:${PORT}\n`);
      resolveFn();
    });
  });
  _serverHandle = server;
  // Fire one immediate tick so /snapshot is populated within a second of boot.
  runOneTick({ fetchImpl }).catch((err) => {
    process.stderr.write(`[n150-health-monitor] initial tick failed: ${err.message}\n`);
  });
  _intervalHandle = setInterval(() => {
    runOneTick({ fetchImpl }).catch((err) => {
      process.stderr.write(`[n150-health-monitor] tick failed: ${err.message}\n`);
    });
  }, TICK_INTERVAL_MS);
  // SIGHUP forces an immediate tick (useful from cron / scripts).
  process.on("SIGHUP", () => {
    runOneTick({ fetchImpl }).catch(() => {});
  });
  return server;
}

export async function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  if (_serverHandle) {
    await new Promise((resolveFn) => _serverHandle.close(() => resolveFn()));
    _serverHandle = null;
  }
}

// Run when invoked directly. ESM import does not trigger this.
const isDirect = (() => {
  try {
    return resolve(process.argv[1] || "") === __filename;
  } catch { return false; }
})();

if (isDirect) {
  start().catch((err) => {
    process.stderr.write(`[n150-health-monitor] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
  // Clean shutdown on SIGTERM/SIGINT so systemd's TimeoutStopSec is respected.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      stop().finally(() => process.exit(0));
    });
  }
}
