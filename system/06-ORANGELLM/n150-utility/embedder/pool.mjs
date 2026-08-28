// N150 utility embedder — connection pool for Ollama /api/embeddings.
// Path: 06-ORANGELLM/n150-utility/embedder/pool.mjs
//
// Doctrine (Wave 1, stock-only):
//   - N150 is a Beelink with 4 cores and 16 GB RAM. It hosts STOCK utility
//     models only. No custom training, no fine-tunes, no LoRA.
//   - This pool serves the Graph Weaver embedder job: nomic-embed-text v1.5
//     pulled by `ollama pull nomic-embed-text`. The default model id is
//     resolvable via env (OLLAMA_EMBED_MODEL) so we can hot-swap the stock
//     weight version (e.g. nomic-embed-text:v1.5 -> nomic-embed-text:latest)
//     without restarting the daemon — see hotSwapModel() below.
//   - 5 concurrent in-flight requests is the hard concurrency cap. The N150
//     can saturate its 4 cores at this depth without OOM on a 16 GB box when
//     only one stock model is resident.
//   - 30 s queue-wait timeout. If a caller cannot acquire a slot within 30 s
//     we reject the request rather than let it hang the calling DAG node.
//   - 60 s per-request fetch timeout (separate from the queue wait). Ollama
//     cold-start can take ~3-5 s; warm calls are <100 ms for 768-dim vectors.
//   - No retries inside the pool. Retries belong to the caller's gauge so
//     the pool stays deterministic and small.
//
// This module exports:
//   - createEmbedderPool(opts): factory returning a pool instance.
//   - default singleton pool() for the daemon process.
//   - Constants for tests and external sanity checks.
//
// Receipts:
//   - Every embed() call produces a structured stat (queued_ms, embed_ms,
//     model, dim, ok). stats() returns a rolling snapshot for /healthz and
//     systemd watchdog reporting.

import { setTimeout as delay } from "node:timers/promises";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_BATCH_CHUNK = 16; // batched callers fan out in chunks of 16

// Pool states for hot-swap coordination. A pool moves OPEN -> DRAINING ->
// OPEN when a hot-swap is in progress so that in-flight calls keep their
// existing model and new calls wait for the swap to land.
export const POOL_STATE = Object.freeze({
  OPEN: "open",
  DRAINING: "draining",
  CLOSED: "closed",
});

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.length > 0;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

/**
 * Create an embedder pool bound to a single Ollama endpoint.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]        Ollama base URL.
 * @param {string} [opts.model]          Stock embedding model id (Ollama tag).
 * @param {number} [opts.concurrency]    Max in-flight requests (default 5).
 * @param {number} [opts.queueTimeoutMs] Max wait to acquire a slot (default 30_000).
 * @param {number} [opts.fetchTimeoutMs] Max per-request HTTP timeout (default 60_000).
 * @param {(url:string,init:object,timeoutMs:number)=>Promise<Response>} [opts.fetchImpl]
 *        Test seam — defaults to fetchWithTimeout.
 * @returns {EmbedderPool}
 */
export function createEmbedderPool(opts = {}) {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  let model = opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const queueTimeoutMs = Math.max(1, opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
  const fetchTimeoutMs = Math.max(1, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const fetchImpl = opts.fetchImpl ?? fetchWithTimeout;

  let inFlight = 0;
  let state = POOL_STATE.OPEN;
  const waiters = []; // { resolve, reject, enqueuedAt, timer }

  // Rolling stats (last N samples, ring buffer would be overkill at this size).
  const STATS_KEEP = 256;
  const samples = []; // { queued_ms, embed_ms, ok, model, dim, ts }
  let totalRequests = 0;
  let totalOk = 0;
  let totalFail = 0;
  let totalQueueTimeouts = 0;

  function recordSample(s) {
    samples.push(s);
    if (samples.length > STATS_KEEP) samples.shift();
  }

  function acquireSlot() {
    return new Promise((resolve, reject) => {
      if (state === POOL_STATE.CLOSED) {
        reject(new Error("pool_closed"));
        return;
      }
      if (state === POOL_STATE.OPEN && inFlight < concurrency) {
        inFlight += 1;
        resolve();
        return;
      }
      // Queue.
      const enqueuedAt = nowMs();
      const timer = setTimeout(() => {
        // Remove from waiters and reject as queue timeout.
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        totalQueueTimeouts += 1;
        reject(new Error(`queue_timeout_${queueTimeoutMs}ms`));
      }, queueTimeoutMs);
      const waiter = { resolve, reject, enqueuedAt, timer };
      waiters.push(waiter);
    });
  }

  function releaseSlot() {
    inFlight -= 1;
    // Promote next waiter, but only if pool is OPEN (DRAINING blocks new work).
    while (state === POOL_STATE.OPEN && waiters.length > 0 && inFlight < concurrency) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      inFlight += 1;
      w.resolve();
    }
  }

  async function embedOne(text, perCallModel) {
    if (!isNonEmptyString(text)) {
      throw new Error("embed_input_must_be_nonempty_string");
    }
    if (state === POOL_STATE.CLOSED) {
      throw new Error("pool_closed");
    }
    const useModel = perCallModel ?? model;
    const t0 = nowMs();
    await acquireSlot();
    const t1 = nowMs();
    let ok = false;
    let dim = 0;
    try {
      totalRequests += 1;
      const res = await fetchImpl(
        `${baseUrl}/api/embeddings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: useModel, prompt: text }),
        },
        fetchTimeoutMs,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`ollama_http_${res.status}:${detail.slice(0, 200)}`);
      }
      const json = await res.json();
      if (!json || !Array.isArray(json.embedding)) {
        throw new Error("ollama_response_missing_embedding");
      }
      ok = true;
      dim = json.embedding.length;
      const t2 = nowMs();
      recordSample({
        queued_ms: t1 - t0,
        embed_ms: t2 - t1,
        ok: true,
        model: useModel,
        dim,
        ts: t2,
      });
      totalOk += 1;
      return { embedding: json.embedding, model: useModel, dim };
    } catch (err) {
      const t2 = nowMs();
      recordSample({
        queued_ms: t1 - t0,
        embed_ms: t2 - t1,
        ok: false,
        model: useModel,
        dim,
        ts: t2,
        error: err.message,
      });
      totalFail += 1;
      throw err;
    } finally {
      releaseSlot();
    }
  }

  /**
   * Batch helper. Fans out an array of strings through the pool in chunks
   * so we don't queue thousands of requests at once and starve other jobs
   * on the same daemon (origin classifier, emergency chat fallback).
   *
   * Preserves input order in the returned array. On per-item failure the
   * slot contains { ok:false, error }. Throws only on programmer error
   * (e.g. non-array input).
   */
  async function embedBatch(inputs, { chunk = DEFAULT_BATCH_CHUNK, perCallModel } = {}) {
    if (!Array.isArray(inputs)) {
      throw new Error("embed_batch_inputs_must_be_array");
    }
    const out = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i += chunk) {
      const slice = inputs.slice(i, i + chunk);
      const settled = await Promise.allSettled(
        slice.map((t) => embedOne(t, perCallModel)),
      );
      for (let j = 0; j < settled.length; j += 1) {
        const r = settled[j];
        if (r.status === "fulfilled") {
          out[i + j] = { ok: true, ...r.value };
        } else {
          out[i + j] = { ok: false, error: r.reason?.message ?? String(r.reason) };
        }
      }
    }
    return out;
  }

  /**
   * Hot-swap the bound stock model. Implementation:
   *   1. Move pool to DRAINING (new acquireSlot calls are blocked from
   *      promotion, but already-acquired in-flight calls finish).
   *   2. Wait until inFlight === 0 (or drain timeout elapses, in which case
   *      we abandon the swap and keep the old model).
   *   3. Validate the new model is reachable via Ollama's /api/tags.
   *   4. Flip the model id, return pool to OPEN, and resume promoting
   *      queued waiters.
   *
   * Returns { ok, from, to, drained_in_ms, waiter_count_at_swap }.
   */
  async function hotSwapModel(nextModel, { drainTimeoutMs = 10_000, pollMs = 25 } = {}) {
    if (!isNonEmptyString(nextModel)) {
      throw new Error("hot_swap_model_must_be_nonempty_string");
    }
    if (nextModel === model) {
      return { ok: true, from: model, to: model, drained_in_ms: 0, waiter_count_at_swap: waiters.length, no_op: true };
    }
    const from = model;
    const t0 = nowMs();
    state = POOL_STATE.DRAINING;
    // Wait for in-flight to drain.
    while (inFlight > 0) {
      if (nowMs() - t0 > drainTimeoutMs) {
        state = POOL_STATE.OPEN;
        // Resume any waiters we may have blocked.
        while (waiters.length > 0 && inFlight < concurrency) {
          const w = waiters.shift();
          clearTimeout(w.timer);
          inFlight += 1;
          w.resolve();
        }
        throw new Error(`hot_swap_drain_timeout_${drainTimeoutMs}ms`);
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(pollMs);
    }
    // Verify the new model is available on the Ollama daemon.
    try {
      const res = await fetchImpl(`${baseUrl}/api/tags`, { method: "GET" }, 5_000);
      if (!res.ok) {
        state = POOL_STATE.OPEN;
        throw new Error(`hot_swap_tags_http_${res.status}`);
      }
      const json = await res.json();
      const tags = Array.isArray(json?.models) ? json.models.map((m) => m.name) : [];
      // Accept exact match or "name:tag" loose match where caller passed just "name".
      const found = tags.some((t) => t === nextModel || t.startsWith(`${nextModel}:`));
      if (!found) {
        state = POOL_STATE.OPEN;
        throw new Error(`hot_swap_model_not_installed:${nextModel}`);
      }
    } catch (err) {
      state = POOL_STATE.OPEN;
      throw err;
    }
    const waiterCount = waiters.length;
    model = nextModel;
    state = POOL_STATE.OPEN;
    // Resume waiters.
    while (waiters.length > 0 && inFlight < concurrency) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      inFlight += 1;
      w.resolve();
    }
    return {
      ok: true,
      from,
      to: nextModel,
      drained_in_ms: nowMs() - t0,
      waiter_count_at_swap: waiterCount,
    };
  }

  function stats() {
    let queuedSum = 0;
    let embedSum = 0;
    let okSamples = 0;
    let lastDim = 0;
    for (const s of samples) {
      queuedSum += s.queued_ms;
      embedSum += s.embed_ms;
      if (s.ok) {
        okSamples += 1;
        lastDim = s.dim || lastDim;
      }
    }
    const n = samples.length || 1;
    return {
      state,
      model,
      base_url: baseUrl,
      concurrency,
      in_flight: inFlight,
      queue_depth: waiters.length,
      queue_timeout_ms: queueTimeoutMs,
      fetch_timeout_ms: fetchTimeoutMs,
      sample_count: samples.length,
      mean_queued_ms: Math.round(queuedSum / n),
      mean_embed_ms: Math.round(embedSum / n),
      last_dim: lastDim,
      totals: {
        requests: totalRequests,
        ok: totalOk,
        fail: totalFail,
        queue_timeouts: totalQueueTimeouts,
      },
    };
  }

  async function close() {
    state = POOL_STATE.CLOSED;
    // Reject all queued waiters.
    while (waiters.length > 0) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(new Error("pool_closed"));
    }
  }

  function currentModel() {
    return model;
  }

  return {
    embed: embedOne,
    embedBatch,
    hotSwapModel,
    stats,
    close,
    currentModel,
    // Test seams.
    __internals: {
      get inFlight() { return inFlight; },
      get waiters() { return waiters; },
      get state() { return state; },
      get baseUrl() { return baseUrl; },
    },
  };
}

// ----------------------------------------------------------------------------
// Daemon singleton
// ----------------------------------------------------------------------------

let _singleton = null;
export function pool() {
  if (!_singleton) _singleton = createEmbedderPool();
  return _singleton;
}

/**
 * @typedef {ReturnType<typeof createEmbedderPool>} EmbedderPool
 */
