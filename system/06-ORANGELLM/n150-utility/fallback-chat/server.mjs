#!/usr/bin/env bun
// N150 utility — emergency chat fallback daemon (Bun).
// Path: 06-ORANGELLM/n150-utility/fallback-chat/server.mjs
// Runtime: Bun 1.x (uses Bun.serve). Node 20+ compatible for non-server paths.
//
// Why this exists (Wave 1 doctrine, stock-only):
//   The N150 (Beelink, 4 cores, 16 GB) hosts THREE stock-only utility jobs:
//     1. Origin-based lane classifier  (qwen3:0.6b)
//     2. Graph Weaver embedder         (nomic-embed-text)
//     3. Emergency chat fallback       (qwen3:0.6b)   <-- this daemon
//
//   The fallback is asleep until the Codexa rail (primary chat path) has
//   been UNREACHABLE for >60 seconds. Only then does it activate and start
//   serving /chat. While Codexa is healthy the fallback returns 503 with a
//   `degraded: false, gated: true` body so callers cannot accidentally
//   downgrade themselves to qwen3:0.6b when the real rail is up.
//
//   Every response served while activated carries:
//     X-AE-Degraded: true
//     X-AE-Reason:   codexa-rail-unreachable
//   ...and the JSON body has { degraded: true, model: "qwen3:0.6b", ... }
//   so no caller can mistake the response for primary-rail quality.
//
//   When Codexa returns (3 consecutive healthy probes), the daemon
//   auto-deactivates: /chat returns 503 again until the next outage.
//
// Hot-swap means swapping STOCK qwen3 tags (e.g. qwen3:0.6b <-> qwen3:0.6b-q4)
// without restarting the process. Arbitrary fine-tunes are rejected.
//
// Loopback only. The systemd unit enforces no public bind.

import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Constants — every number is doctrine, not magic.
// ---------------------------------------------------------------------------

export const DEFAULT_HOST              = "127.0.0.1";
export const DEFAULT_PORT              = 7481;
export const DEFAULT_OLLAMA_BASE_URL   = "http://127.0.0.1:11434";
export const DEFAULT_CHAT_MODEL        = "qwen3:0.6b";
export const DEFAULT_CODEXA_BASE_URL   = "http://10.0.0.4:8097";
// Activation hysteresis: Codexa must be down ≥60 s before we light up, and
// up for 3 consecutive probes (≈15 s) before we go dark again.
export const ACTIVATION_GRACE_MS       = 60_000;
export const DEACTIVATION_HEALTHY_RUNS = 3;
export const PROBE_INTERVAL_MS         = 5_000;
export const PROBE_TIMEOUT_MS          = 3_000;
// Chat request bounds.
export const MAX_REQUEST_BYTES         = 256 * 1024;       // 256 KB
export const MAX_PROMPT_CHARS          = 8_000;            // soft cap on input
export const CHAT_TIMEOUT_MS           = 30_000;           // upstream Ollama
export const QUEUE_TIMEOUT_MS          = 10_000;           // gate slot wait
export const MAX_INFLIGHT              = 2;                // N150 is small
// Allow-list for stock qwen3 tag suffixes that hotSwap will accept. Anything
// else is rejected as a non-stock weight.
export const STOCK_QWEN3_PATTERN = /^qwen3:[0-9a-z._-]+$/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function createState({
  ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
  codexaBaseUrl = process.env.CODEXA_RAIL_BASE ?? DEFAULT_CODEXA_BASE_URL,
  chatModel     = process.env.N150_FALLBACK_MODEL ?? DEFAULT_CHAT_MODEL,
  activationGraceMs   = ACTIVATION_GRACE_MS,
  probeIntervalMs     = PROBE_INTERVAL_MS,
  probeTimeoutMs      = PROBE_TIMEOUT_MS,
  deactivationRuns    = DEACTIVATION_HEALTHY_RUNS,
  fetchImpl           = globalThis.fetch,
  now                 = () => Date.now(),
} = {}) {
  return {
    ollamaBaseUrl,
    codexaBaseUrl,
    chatModel,
    activationGraceMs,
    probeIntervalMs,
    probeTimeoutMs,
    deactivationRuns,
    fetchImpl,
    now,
    // Mutable rail state.
    railHealthy: true,            // optimistic at boot; first probe corrects
    firstFailureAt: null,         // ms timestamp of first unhealthy probe
    healthyRunCount: 0,           // consecutive healthy probes while degraded
    activated: false,             // true => /chat serves
    lastProbeAt: 0,
    lastProbeOk: null,
    // Inflight gate.
    inflight: 0,
    waiters: [],                  // {resolve, reject, deadline}
    // Receipts.
    stats: {
      probes_ok: 0,
      probes_fail: 0,
      activations: 0,
      deactivations: 0,
      chats_served: 0,
      chats_gated: 0,
      chats_failed: 0,
      hot_swaps: 0,
      started_at: new Date().toISOString(),
    },
    probeHandle: null,
    closing: false,
  };
}

// ---------------------------------------------------------------------------
// Codexa rail probe
// ---------------------------------------------------------------------------

async function probeCodexa(state) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), state.probeTimeoutMs);
  let ok = false;
  try {
    const res = await state.fetchImpl(`${state.codexaBaseUrl}/healthz`, {
      method: "GET",
      signal: ctrl.signal,
      // No keepalive; this is a heartbeat, not a hot path.
    });
    ok = res.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(t);
  }
  state.lastProbeAt = state.now();
  state.lastProbeOk = ok;
  if (ok) {
    state.stats.probes_ok++;
    state.firstFailureAt = null;
    if (state.activated) {
      state.healthyRunCount++;
      if (state.healthyRunCount >= state.deactivationRuns) {
        state.activated = false;
        state.healthyRunCount = 0;
        state.stats.deactivations++;
        logEvt("fallback_deactivated", { stats: state.stats });
      }
    } else {
      state.healthyRunCount = 0;
    }
    state.railHealthy = true;
  } else {
    state.stats.probes_fail++;
    state.healthyRunCount = 0;
    state.railHealthy = false;
    if (state.firstFailureAt == null) state.firstFailureAt = state.lastProbeAt;
    const downFor = state.lastProbeAt - state.firstFailureAt;
    if (!state.activated && downFor >= state.activationGraceMs) {
      state.activated = true;
      state.stats.activations++;
      logEvt("fallback_activated", {
        codexa_down_for_ms: downFor,
        stats: state.stats,
      });
    }
  }
  return ok;
}

function startProbeLoop(state) {
  if (state.probeHandle) return;
  // Fire one immediately so /healthz reflects reality fast.
  probeCodexa(state).catch(() => {});
  state.probeHandle = setInterval(() => {
    if (state.closing) return;
    probeCodexa(state).catch(() => {});
  }, state.probeIntervalMs);
  // Don't keep the process alive on this timer alone.
  if (typeof state.probeHandle.unref === "function") state.probeHandle.unref();
}

function stopProbeLoop(state) {
  if (state.probeHandle) {
    clearInterval(state.probeHandle);
    state.probeHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Inflight gate (small, deterministic, no library)
// ---------------------------------------------------------------------------

function acquireSlot(state) {
  if (state.closing) return Promise.reject(new Error("pool_closed"));
  if (state.inflight < MAX_INFLIGHT) {
    state.inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const deadline = state.now() + QUEUE_TIMEOUT_MS;
    state.waiters.push({ resolve, reject, deadline });
  });
}

function releaseSlot(state) {
  while (state.waiters.length > 0) {
    const w = state.waiters.shift();
    if (state.now() > w.deadline) {
      w.reject(new Error("queue_timeout"));
      continue;
    }
    // Hand the slot directly to the waiter — inflight count is unchanged.
    w.resolve();
    return;
  }
  state.inflight = Math.max(0, state.inflight - 1);
}

// ---------------------------------------------------------------------------
// Chat call to Ollama
// ---------------------------------------------------------------------------

async function callOllamaChat(state, { prompt, system, temperature }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const body = {
      model: state.chatModel,
      stream: false,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      options: {
        // qwen3:0.6b on a 16 GB box; keep it tight and predictable.
        temperature: typeof temperature === "number" ? clamp(temperature, 0, 1.5) : 0.4,
        num_ctx: 2048,
        num_predict: 512,
      },
    };
    const res = await state.fetchImpl(`${state.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`ollama_http_${res.status}:${truncate(txt, 200)}`);
    }
    const json = await res.json();
    const content =
      json?.message?.content ??
      json?.response ??
      "";
    return {
      content: String(content),
      model: state.chatModel,
      ollama_total_duration_ns: json?.total_duration ?? null,
      ollama_eval_count: json?.eval_count ?? null,
    };
  } finally {
    clearTimeout(t);
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "..." : s; }

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// HTTP handler — exported for tests; Bun.serve wraps it.
// ---------------------------------------------------------------------------

const DEGRADED_HEADERS = Object.freeze({
  "X-AE-Host":     "n150",
  "X-AE-Lane":     "utility-fallback-chat",
  "X-AE-Degraded": "true",
  "X-AE-Reason":   "codexa-rail-unreachable",
  "Cache-Control": "no-store",
});

const PRIMARY_HEADERS = Object.freeze({
  "X-AE-Host":     "n150",
  "X-AE-Lane":     "utility-fallback-chat",
  "X-AE-Degraded": "false",
  "Cache-Control": "no-store",
});

function jsonResponse(body, { status = 200, degraded = false, extra = {} } = {}) {
  const base = degraded ? DEGRADED_HEADERS : PRIMARY_HEADERS;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...base,
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function readJsonBody(req) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_REQUEST_BYTES) {
    const e = new Error("payload_too_large"); e.status = 413; throw e;
  }
  let text;
  try {
    text = await req.text();
  } catch {
    const e = new Error("read_failed"); e.status = 400; throw e;
  }
  if (text.length > MAX_REQUEST_BYTES) {
    const e = new Error("payload_too_large"); e.status = 413; throw e;
  }
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error("invalid_json"); e.status = 400; throw e;
  }
}

export function createHandler(state) {
  return async function handler(req) {
    const url = new URL(req.url);

    // -----------------------------------------------------------------------
    // GET /healthz — always available; reports rail + activation truthfully.
    // -----------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({
        ok: true,
        service: "n150-fallback-chat",
        model: state.chatModel,
        activated: state.activated,
        rail_healthy: state.railHealthy,
        last_probe_at: state.lastProbeAt,
        last_probe_ok: state.lastProbeOk,
        codexa_down_since_ms: state.firstFailureAt ?? null,
        codexa_down_for_ms: state.firstFailureAt
          ? state.now() - state.firstFailureAt : 0,
        activation_grace_ms: state.activationGraceMs,
        inflight: state.inflight,
        waiting: state.waiters.length,
        stats: state.stats,
        ts: new Date().toISOString(),
      });
    }

    // -----------------------------------------------------------------------
    // GET /readyz — 200 only when activated. Lets a watcher distinguish
    // "daemon alive" (healthz) from "actually serving chat" (readyz).
    // -----------------------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/readyz") {
      const ready = state.activated;
      return jsonResponse(
        { ready, activated: state.activated, rail_healthy: state.railHealthy },
        { status: ready ? 200 : 503, degraded: ready }
      );
    }

    // -----------------------------------------------------------------------
    // POST /chat — gated by activation.
    // -----------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/chat") {
      if (!state.activated) {
        state.stats.chats_gated++;
        return jsonResponse(
          {
            error: "fallback_not_active",
            reason: "codexa_rail_healthy_or_grace_period_not_elapsed",
            rail_healthy: state.railHealthy,
            codexa_down_for_ms: state.firstFailureAt
              ? state.now() - state.firstFailureAt : 0,
            activation_grace_ms: state.activationGraceMs,
          },
          { status: 503, degraded: false }
        );
      }

      let body;
      try { body = await readJsonBody(req); }
      catch (err) {
        return jsonResponse(
          { error: err.message ?? "bad_request", degraded: true, model: state.chatModel },
          { status: err.status ?? 400, degraded: true }
        );
      }
      const prompt = typeof body.prompt === "string" ? body.prompt
                   : typeof body.message === "string" ? body.message
                   : null;
      if (!prompt || prompt.length === 0) {
        return jsonResponse(
          { error: "prompt_required", degraded: true, model: state.chatModel },
          { status: 400, degraded: true }
        );
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        return jsonResponse(
          { error: "prompt_too_long", limit: MAX_PROMPT_CHARS, degraded: true, model: state.chatModel },
          { status: 413, degraded: true }
        );
      }

      try {
        await acquireSlot(state);
      } catch (err) {
        state.stats.chats_failed++;
        return jsonResponse(
          { error: err.message ?? "queue_timeout", degraded: true, model: state.chatModel },
          { status: 503, degraded: true }
        );
      }

      const startedAt = state.now();
      try {
        const out = await callOllamaChat(state, {
          prompt,
          system: typeof body.system === "string" ? body.system : undefined,
          temperature: body.temperature,
        });
        state.stats.chats_served++;
        const took = state.now() - startedAt;
        return jsonResponse(
          {
            degraded: true,
            reason: "codexa-rail-unreachable",
            model: out.model,
            host: "n150",
            content: out.content,
            took_ms: took,
            ollama: {
              total_duration_ns: out.ollama_total_duration_ns,
              eval_count: out.ollama_eval_count,
            },
            note: "This response was served by a degraded emergency fallback (qwen3:0.6b on N150). Quality is intentionally lower than the primary Codexa rail. Treat as best-effort.",
          },
          { status: 200, degraded: true }
        );
      } catch (err) {
        state.stats.chats_failed++;
        const msg = err?.message ?? String(err);
        const status = /ollama_http_(4\d\d)/.test(msg) ? 502
                     : /AbortError|timeout/i.test(msg) ? 504
                     : 502;
        return jsonResponse(
          { error: msg, degraded: true, model: state.chatModel },
          { status, degraded: true }
        );
      } finally {
        releaseSlot(state);
      }
    }

    // -----------------------------------------------------------------------
    // POST /admin/swap — stock-only model hot swap.
    // -----------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/admin/swap") {
      let body;
      try { body = await readJsonBody(req); }
      catch (err) {
        return jsonResponse({ error: err.message }, { status: err.status ?? 400 });
      }
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model) {
        return jsonResponse({ error: "model_required" }, { status: 400 });
      }
      if (!STOCK_QWEN3_PATTERN.test(model)) {
        return jsonResponse(
          { error: "non_stock_model_rejected", pattern: String(STOCK_QWEN3_PATTERN), got: model },
          { status: 400 }
        );
      }
      // Validate against Ollama's installed tags before flipping.
      let tags;
      try {
        const r = await state.fetchImpl(`${state.ollamaBaseUrl}/api/tags`);
        if (!r.ok) throw new Error(`ollama_http_${r.status}`);
        tags = await r.json();
      } catch (err) {
        return jsonResponse(
          { error: "tag_lookup_failed", detail: err?.message ?? String(err) },
          { status: 502 }
        );
      }
      const installed = Array.isArray(tags?.models)
        ? tags.models.map((m) => m?.name).filter((n) => typeof n === "string")
        : [];
      if (!installed.includes(model)) {
        return jsonResponse(
          { error: "model_not_installed", model, installed },
          { status: 404 }
        );
      }
      const previous = state.chatModel;
      state.chatModel = model;
      state.stats.hot_swaps++;
      logEvt("fallback_hot_swap", { previous, current: model });
      return jsonResponse({ ok: true, previous, current: model });
    }

    return jsonResponse({ error: "not_found", path: url.pathname }, { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Logging — single-line structured JSON to stdout for journald.
// ---------------------------------------------------------------------------

function logEvt(evt, fields = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ evt, ts: new Date().toISOString(), ...fields }));
}

// ---------------------------------------------------------------------------
// Entry point (Bun.serve)
// ---------------------------------------------------------------------------

export function createServer(opts = {}) {
  const state = createState(opts);
  const handler = createHandler(state);
  return { state, handler };
}

function main() {
  const host = process.env.N150_FALLBACK_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.N150_FALLBACK_PORT ?? DEFAULT_PORT);
  const { state, handler } = createServer();
  startProbeLoop(state);

  if (typeof Bun === "undefined") {
    // We expect Bun in production. Refuse to start on plain Node to avoid a
    // silent quality drift (Bun.serve has different semantics than node:http).
    logEvt("fallback_boot_aborted", { reason: "bun_runtime_required" });
    process.exit(78); // EX_CONFIG
    return;
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handler,
    error(err) {
      logEvt("fallback_handler_error", { err: err?.message ?? String(err) });
      return new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  logEvt("fallback_listening", {
    host: server.hostname,
    port: server.port,
    model: state.chatModel,
    codexa_base: state.codexaBaseUrl,
    ollama_base: state.ollamaBaseUrl,
    activation_grace_ms: state.activationGraceMs,
  });

  function shutdown(signal) {
    logEvt("fallback_shutdown", { signal });
    state.closing = true;
    stopProbeLoop(state);
    // Reject queued waiters so they don't hang the systemd stop.
    for (const w of state.waiters.splice(0)) {
      try { w.reject(new Error("pool_closed")); } catch {}
    }
    server.stop(false);
    // Hard exit after 25 s if anything sticks (systemd KILL at 30 s).
    setTimeout(() => process.exit(0), 25_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof Bun !== "undefined" &&
  typeof Bun.main === "string" &&
  import.meta.path === Bun.main;
const invokedDirectlyNode =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;

if (invokedDirectly || invokedDirectlyNode) {
  main();
}

// Exports for tests.
export {
  createState,
  probeCodexa,
  startProbeLoop,
  stopProbeLoop,
  callOllamaChat,
  acquireSlot,
  releaseSlot,
  logEvt,
};
