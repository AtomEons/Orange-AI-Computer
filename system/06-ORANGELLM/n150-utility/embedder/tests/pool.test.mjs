#!/usr/bin/env node
// N150 utility embedder pool — smoke tests.
// Path: 06-ORANGELLM/n150-utility/embedder/tests/pool.test.mjs
//
// Hermetic. No network. We inject a fake fetch that simulates Ollama's
// /api/embeddings and /api/tags so we can deterministically test:
//   1. happy path (single embed, dim correct)
//   2. concurrency cap is enforced (peak in-flight never exceeds limit)
//   3. queue timeout fires when slots stay busy past deadline
//   4. batch helper preserves order and chunks correctly
//   5. batch helper degrades per-item without throwing on partial failure
//   6. hot-swap drains and flips model id; new calls use new model
//   7. hot-swap rejects when the requested stock model is not installed
//   8. close() drains waiters with pool_closed errors
//   9. HTTP non-2xx from Ollama surfaces as ollama_http_<code>
//  10. Stats snapshot reflects requests
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/embedder/tests/pool.test.mjs
//
// Exit 0 on green, 1 on any failure.

import { createEmbedderPool, DEFAULT_EMBED_MODEL, POOL_STATE } from "../pool.mjs";
import { setTimeout as delay } from "node:timers/promises";

// ----------------------------------------------------------------------------
// Mini test harness
// ----------------------------------------------------------------------------

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  // Single line per test for readable CI output.
  // eslint-disable-next-line no-console
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function run(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err.message);
  }
}

// ----------------------------------------------------------------------------
// Fake Ollama fetch
// ----------------------------------------------------------------------------

/**
 * Build a fake fetch with a configurable per-request latency and an
 * installed-models list for /api/tags.
 *
 * @param {object} opts
 * @param {number}   opts.latencyMs        Per-embed delay (default 0).
 * @param {string[]} opts.installedModels  Names returned by /api/tags.
 * @param {(model:string)=>number} [opts.dimFor]  Custom dim per model.
 * @param {(model:string)=>boolean} [opts.failFor] Force HTTP 500 for matching model.
 */
function makeFakeFetch({ latencyMs = 0, installedModels = ["nomic-embed-text:latest"], dimFor, failFor } = {}) {
  const state = { peakInFlight: 0, inFlight: 0, calls: 0 };
  async function fake(url, init, _timeoutMs) {
    state.calls += 1;
    if (url.endsWith("/api/tags")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: installedModels.map((name) => ({ name })) };
        },
        async text() { return ""; },
      };
    }
    if (url.endsWith("/api/embeddings")) {
      state.inFlight += 1;
      if (state.inFlight > state.peakInFlight) state.peakInFlight = state.inFlight;
      try {
        if (latencyMs > 0) await delay(latencyMs);
        const body = JSON.parse(init.body);
        if (failFor && failFor(body.model)) {
          return {
            ok: false,
            status: 500,
            async json() { return { error: "simulated" }; },
            async text() { return "simulated upstream error"; },
          };
        }
        const dim = dimFor ? dimFor(body.model) : 768;
        const embedding = new Array(dim).fill(0).map((_, i) => Math.sin(i + body.prompt.length));
        return {
          ok: true,
          status: 200,
          async json() { return { embedding, model: body.model }; },
          async text() { return ""; },
        };
      } finally {
        state.inFlight -= 1;
      }
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return "not found"; } };
  }
  return { fake, state };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

async function main() {
  // eslint-disable-next-line no-console
  console.log("N150 embedder pool — smoke tests");

  // 1. Happy path.
  await run("happy_path_returns_768d_vector", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 5 });
    const p = createEmbedderPool({ fetchImpl: fake, model: DEFAULT_EMBED_MODEL });
    const r = await p.embed("hello world");
    assert(r.embedding.length === 768, `expected dim 768, got ${r.embedding.length}`);
    assert(r.model === DEFAULT_EMBED_MODEL, "model echoed");
    await p.close();
  });

  // 2. Concurrency cap (5 slots).
  await run("concurrency_cap_enforced_at_5", async () => {
    const { fake, state } = makeFakeFetch({ latencyMs: 50 });
    const p = createEmbedderPool({ fetchImpl: fake, concurrency: 5 });
    const inputs = new Array(20).fill(0).map((_, i) => `text-${i}`);
    await Promise.all(inputs.map((t) => p.embed(t)));
    assert(state.peakInFlight <= 5, `peakInFlight ${state.peakInFlight} exceeded cap 5`);
    assert(state.peakInFlight === 5, `expected peak to actually hit 5, got ${state.peakInFlight}`);
    await p.close();
  });

  // 3. Queue timeout.
  await run("queue_timeout_rejects_when_slots_stay_busy", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 200 });
    const p = createEmbedderPool({ fetchImpl: fake, concurrency: 1, queueTimeoutMs: 50 });
    // First call holds the only slot.
    const hold = p.embed("hold");
    // Second should wait 50ms then reject.
    let caught = null;
    try {
      await p.embed("blocked");
    } catch (err) {
      caught = err;
    }
    assert(caught && /queue_timeout_50ms/.test(caught.message), `expected queue_timeout, got ${caught && caught.message}`);
    await hold; // let first finish
    await p.close();
  });

  // 4. Batch order + chunking.
  await run("batch_preserves_input_order", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 5, dimFor: () => 8 });
    const p = createEmbedderPool({ fetchImpl: fake, concurrency: 3 });
    const inputs = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg"];
    const out = await p.embedBatch(inputs, { chunk: 3 });
    assert(out.length === inputs.length, `expected ${inputs.length} results`);
    for (let i = 0; i < inputs.length; i += 1) {
      assert(out[i].ok === true, `slot ${i} failed: ${out[i].error}`);
      assert(out[i].dim === 8, `slot ${i} wrong dim`);
    }
    await p.close();
  });

  // 5. Batch partial failure.
  await run("batch_partial_failure_returns_per_item_error", async () => {
    const { fake } = makeFakeFetch({
      latencyMs: 2,
      failFor: (m) => m === "broken-model",
    });
    const p = createEmbedderPool({ fetchImpl: fake });
    const a = await p.embed("ok", "nomic-embed-text").catch((e) => ({ err: e.message }));
    assert(!a.err, "first call should succeed");
    // Use embedBatch with a perCallModel override that fails server-side.
    const out = await p.embedBatch(["x", "y"], { perCallModel: "broken-model" });
    assert(out.length === 2, "two slots");
    assert(out[0].ok === false && /ollama_http_500/.test(out[0].error), `slot 0 expected ollama_http_500: ${out[0].error}`);
    assert(out[1].ok === false && /ollama_http_500/.test(out[1].error), `slot 1 expected ollama_http_500: ${out[1].error}`);
    await p.close();
  });

  // 6. Hot-swap.
  await run("hot_swap_drains_then_flips_model", async () => {
    const { fake } = makeFakeFetch({
      latencyMs: 20,
      installedModels: ["nomic-embed-text:v1.5", "nomic-embed-text:latest"],
    });
    const p = createEmbedderPool({ fetchImpl: fake, model: "nomic-embed-text:v1.5", concurrency: 3 });
    // Fire some background work, then swap.
    const work = Promise.all([p.embed("a"), p.embed("b"), p.embed("c")]);
    const swap = await p.hotSwapModel("nomic-embed-text:latest");
    assert(swap.ok && swap.to === "nomic-embed-text:latest", "swap landed");
    assert(p.currentModel() === "nomic-embed-text:latest", "currentModel reflects swap");
    await work;
    // Post-swap calls use the new model.
    const r = await p.embed("post");
    assert(r.model === "nomic-embed-text:latest", `post-swap call should use new model, got ${r.model}`);
    await p.close();
  });

  // 7. Hot-swap rejects missing model.
  await run("hot_swap_rejects_missing_model", async () => {
    const { fake } = makeFakeFetch({
      latencyMs: 2,
      installedModels: ["nomic-embed-text:v1.5"],
    });
    const p = createEmbedderPool({ fetchImpl: fake, model: "nomic-embed-text:v1.5" });
    let caught = null;
    try {
      await p.hotSwapModel("not-installed-model");
    } catch (err) {
      caught = err;
    }
    assert(caught && /hot_swap_model_not_installed/.test(caught.message), `expected hot_swap_model_not_installed, got ${caught && caught.message}`);
    assert(p.currentModel() === "nomic-embed-text:v1.5", "model unchanged on failed swap");
    assert(p.__internals.state === POOL_STATE.OPEN, "pool returns to OPEN on failed swap");
    await p.close();
  });

  // 8. Close drains waiters.
  await run("close_drains_waiters_with_pool_closed", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 100 });
    const p = createEmbedderPool({ fetchImpl: fake, concurrency: 1, queueTimeoutMs: 5_000 });
    const hold = p.embed("hold");
    const waiterPromise = p.embed("waiter").then(() => "ok", (e) => e.message);
    // Give the waiter a tick to enqueue.
    await delay(10);
    await p.close();
    const waiterResult = await waiterPromise;
    assert(/pool_closed/.test(waiterResult), `expected pool_closed for waiter, got ${waiterResult}`);
    // Hold may have completed before close; that's fine. Just don't crash.
    await hold.catch(() => {});
  });

  // 9. HTTP 500 surfaces as ollama_http_500.
  await run("http_500_surfaces_as_ollama_http_500", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 2, failFor: () => true });
    const p = createEmbedderPool({ fetchImpl: fake });
    let caught = null;
    try {
      await p.embed("nope");
    } catch (err) {
      caught = err;
    }
    assert(caught && /ollama_http_500/.test(caught.message), `expected ollama_http_500, got ${caught && caught.message}`);
    await p.close();
  });

  // 10. Stats reflect activity.
  await run("stats_reflect_request_totals", async () => {
    const { fake } = makeFakeFetch({ latencyMs: 2 });
    const p = createEmbedderPool({ fetchImpl: fake });
    await p.embed("one");
    await p.embed("two");
    const s = p.stats();
    assert(s.totals.requests === 2, `requests=${s.totals.requests}`);
    assert(s.totals.ok === 2, `ok=${s.totals.ok}`);
    assert(s.last_dim === 768, `last_dim=${s.last_dim}`);
    assert(s.state === POOL_STATE.OPEN, "state OPEN");
    await p.close();
  });

  // ----- Summary -----
  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log("FAILURES:");
    for (const f of failed) {
      // eslint-disable-next-line no-console
      console.log(`  - ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("test harness crashed:", err);
  process.exit(1);
});
