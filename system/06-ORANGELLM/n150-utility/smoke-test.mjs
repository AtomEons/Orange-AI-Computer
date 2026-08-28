#!/usr/bin/env node
// smoke-test.mjs — top-level N150 utility smoke battery.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/smoke-test.mjs
//
// Exit 0 = all 8 cases pass. Exit 1 = at least one fail.
//
// Wave 1 doctrine: STOCK WEIGHTS ONLY. No custom training, only stock weights.
// The N150 (Beelink, 4 cores, 16 GB) hosts three co-resident jobs:
//
//   1. origin-based lane classifier   qwen3:0.6b        (port 7480)
//   2. Graph Weaver embedder          nomic-embed-text  (port 8798)
//   3. emergency chat fallback        qwen3:0.6b        (port 7481)
//
// This battery covers the 8 SLA-grade behaviors the production rail must keep
// honest. It is HERMETIC — no real Ollama, no real Codexa, no real network.
// We exercise the actual exported code paths (not re-implementations) and
// inject deterministic fetch impls or fake clocks where the daemons accept
// injection points. Where no injection is exposed, we override globalThis.fetch
// for the duration of the case and restore it after.
//
// Mom's Law: real tests, real receipts, no theater.

import {
  classifyByOrigin,
  REALITY_ORIGIN_PREFIXES,
  THOUGHT_ORIGIN_PREFIXES,
} from "./classifier/daemon.mjs";

import {
  createEmbedderPool,
  POOL_STATE,
} from "./embedder/pool.mjs";

import {
  createState as createFallbackState,
  probeCodexa,
} from "./fallback-chat/server.mjs";

import {
  hotSwap,
  TARGETS as HOT_SWAP_TARGETS,
} from "./hot-swap.mjs";

import {
  probeTarget,
  summarize,
  runOneTick,
  buildSnapshot,
  recordSample,
  TARGETS as HEALTH_TARGETS,
} from "./health-monitor.mjs";

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

const RESULTS = [];
const CASES = []; // ordered case rollups

function caseStart(num, title) {
  const c = { num, title, checks: [] };
  CASES.push(c);
  console.log(`\n[case ${num}] ${title}`);
  return c;
}

function ok(c, name, cond, detail = "") {
  const passed = !!cond;
  c.checks.push({ name, ok: passed, detail });
  RESULTS.push({ case: c.num, name, ok: passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"} ${name}${detail && !passed ? `  — ${detail}` : ""}`);
}

function eq(c, name, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  ok(c, name, passed, passed ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function withFakeFetch(handler, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Case 1 — classifier origin map
//   reality / thought / merge origins resolve through classifyByOrigin
//   to the right lanes with confidence 1.0 (origin_rule) or 0.0 (needs_tiebreak).
// ---------------------------------------------------------------------------

{
  const c = caseStart(1, "classifier origin map (reality/thought/merge)");

  // Confirm the prefix tables themselves are non-empty (defensive).
  ok(c, "reality prefix table populated", REALITY_ORIGIN_PREFIXES.length > 0);
  ok(c, "thought prefix table populated", THOUGHT_ORIGIN_PREFIXES.length > 0);

  // Sample reality origins — every REALITY prefix should map to reality.
  for (const prefix of REALITY_ORIGIN_PREFIXES) {
    const r = classifyByOrigin(`${prefix}smoke_event_1`);
    ok(c, `reality lane for "${prefix}*"`, r.lane === "reality" && r.confidence === 1.0 && r.source === "origin_rule");
  }
  // Sample thought origins.
  for (const prefix of THOUGHT_ORIGIN_PREFIXES) {
    const r = classifyByOrigin(`${prefix}smoke_event_1`);
    ok(c, `thought lane for "${prefix}*"`, r.lane === "thought" && r.confidence === 1.0 && r.source === "origin_rule");
  }

  // Empty origin → merge + needs tiebreak.
  const empty = classifyByOrigin("");
  eq(c, "empty origin lane=merge",          empty.lane, "merge");
  eq(c, "empty origin confidence=0",        empty.confidence, 0.0);
  eq(c, "empty origin source=needs_tiebreak", empty.source, "origin_empty_needs_tiebreak");

  // Unknown origin → merge + needs tiebreak.
  const unknown = classifyByOrigin("zzz.unmapped.origin");
  eq(c, "unknown origin lane=merge",          unknown.lane, "merge");
  eq(c, "unknown origin source=unknown_needs_tiebreak", unknown.source, "origin_unknown_needs_tiebreak");

  // Case-insensitivity (origins are conventionally lowercase but classifier defends).
  const upper = classifyByOrigin("RECEIPT.upper.case");
  eq(c, "case-insensitive prefix match", upper.lane, "reality");

  // Non-string defensively returns merge/needs_tiebreak.
  const nonStr = classifyByOrigin(null);
  eq(c, "non-string origin → merge", nonStr.lane, "merge");
}

// ---------------------------------------------------------------------------
// Case 2 — embedder produces 768-dim
//   createEmbedderPool wired with a stub fetch returning a 768-length vector;
//   confirm dim=768 and the embedding round-trips intact through embedOne.
//   nomic-embed-text emits 768-dimensional vectors as its native output.
// ---------------------------------------------------------------------------

{
  const c = caseStart(2, "embedder produces 768-dim vector");

  // Construct a deterministic 768-dim vector. The fetch impl returns it.
  const vector768 = new Array(768).fill(0).map((_, i) => (i + 1) / 1000);

  const stubFetch = async (url, init, _timeoutMs) => {
    if (String(url).endsWith("/api/embeddings")) {
      return {
        ok: true,
        status: 200,
        async text() { return ""; },
        async json() { return { embedding: vector768, model: "nomic-embed-text" }; },
      };
    }
    return { ok: false, status: 404, async text() { return ""; }, async json() { return {}; } };
  };

  const pool = createEmbedderPool({
    model: "nomic-embed-text",
    concurrency: 5,
    fetchImpl: stubFetch,
  });

  const res = await pool.embed("smoke test — produce a 768-dim embedding");
  eq(c, "model echoed",       res.model, "nomic-embed-text");
  eq(c, "dim=768",            res.dim, 768);
  ok(c, "embedding length=768", res.embedding.length === 768);
  ok(c, "embedding is finite", res.embedding.every((v) => Number.isFinite(v)));
  ok(c, "embedding round-trips intact", res.embedding[0] === vector768[0] && res.embedding[767] === vector768[767]);

  const st = pool.stats();
  eq(c, "pool model=nomic-embed-text", st.model, "nomic-embed-text");
  eq(c, "last_dim=768",                st.last_dim, 768);
  eq(c, "totals.ok=1",                 st.totals.ok, 1);
  await pool.close();
}

// ---------------------------------------------------------------------------
// Case 3 — fallback activates on rail-down
//   probeCodexa fed an "unhealthy" rail repeatedly, with the clock advanced
//   past ACTIVATION_GRACE_MS (60_000 ms by default). Expect activated=true,
//   stats.activations=1.
// ---------------------------------------------------------------------------

{
  const c = caseStart(3, "fallback activates on rail-down past grace");

  let clock = 1_000_000;
  const tickClock = (ms) => { clock += ms; };
  const unhealthyFetch = async () => ({ ok: false, status: 503, async text() { return ""; } });

  const state = createFallbackState({
    fetchImpl: unhealthyFetch,
    now: () => clock,
    activationGraceMs: 60_000,
    deactivationRuns: 3,
  });

  // First failed probe registers firstFailureAt.
  await probeCodexa(state);
  ok(c, "rail marked unhealthy after first failed probe", state.railHealthy === false);
  ok(c, "not yet activated (within grace)",                state.activated === false);
  ok(c, "firstFailureAt captured",                          typeof state.firstFailureAt === "number");

  // Second probe still inside grace.
  tickClock(30_000);
  await probeCodexa(state);
  ok(c, "still not activated mid-grace",                    state.activated === false);

  // Past grace.
  tickClock(31_000); // total 61s of downtime since first failure
  await probeCodexa(state);
  ok(c, "activated after rail down past grace",             state.activated === true);
  eq(c, "stats.activations=1",                              state.stats.activations, 1);
  eq(c, "stats.probes_fail=3",                              state.stats.probes_fail, 3);
}

// ---------------------------------------------------------------------------
// Case 4 — fallback deactivates on rail-up
//   Continuing from a degraded/activated state, feed N consecutive healthy
//   probes (DEACTIVATION_HEALTHY_RUNS = 3 by default). Expect activated=false.
// ---------------------------------------------------------------------------

{
  const c = caseStart(4, "fallback deactivates after sustained rail-up");

  let clock = 2_000_000;
  let railOk = false;
  const flipFetch = async () => ({ ok: railOk, status: railOk ? 200 : 503, async text() { return ""; } });

  const state = createFallbackState({
    fetchImpl: flipFetch,
    now: () => clock,
    activationGraceMs: 1_000,        // tiny grace for the test
    deactivationRuns: 3,
  });

  // Drive into activated.
  await probeCodexa(state);            // fail #1, sets firstFailureAt
  clock += 2_000;
  await probeCodexa(state);            // fail #2, past grace
  ok(c, "fallback activated for deactivation test", state.activated === true);

  // Now flip the rail healthy.
  railOk = true;
  for (let i = 1; i <= 3; i += 1) {
    clock += 5_000;
    await probeCodexa(state);
    if (i < 3) {
      ok(c, `still activated after ${i} healthy probe(s)`, state.activated === true);
    }
  }
  eq(c, "deactivated after 3 healthy probes", state.activated, false);
  eq(c, "stats.deactivations=1",              state.stats.deactivations, 1);
  ok(c, "rail marked healthy",                state.railHealthy === true);
}

// ---------------------------------------------------------------------------
// Case 5 — hot-swap with rollback
//   Run hotSwap against the classifier with a daemon that fails the post-flip
//   smoke. Verify the swap is rolled back to the original tag, and the error
//   message names rollback=rolled_back.
// ---------------------------------------------------------------------------

{
  const c = caseStart(5, "hot-swap auto-rolls back on post-flip smoke failure");

  let classifierModel = "qwen3:0.6b";
  const installedTags = new Set(["qwen3:0.6b"]);

  const fakeRouter = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const path = u.pathname;
    const port = u.port;
    const body = init.body ? JSON.parse(init.body) : null;

    // Ollama
    if (port === "11434") {
      if (path === "/api/tags") {
        return jsonRes(200, { models: [...installedTags].map((n) => ({ name: n })) });
      }
      if (path === "/api/pull") {
        const tag = body?.name;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(JSON.stringify({ status: "pulling manifest" }) + "\n"));
            controller.enqueue(enc.encode(JSON.stringify({ status: "success" }) + "\n"));
            if (tag) installedTags.add(tag);
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (path === "/api/generate") {
        return jsonRes(200, { model: body?.model, response: "reality", done: true });
      }
      return jsonRes(404, { error: "unknown_ollama_path", path });
    }

    // Classifier daemon (7480)
    if (port === "7480") {
      if (path === "/healthz") {
        return jsonRes(200, { status: "ok", active_model: classifierModel });
      }
      if (path === "/model" && method === "POST") {
        classifierModel = body?.model ?? classifierModel;
        return jsonRes(200, { ok: true, active_model: classifierModel });
      }
      if (path === "/classify") {
        // POST-FLIP SMOKE FAILS — this is what triggers the rollback path.
        return jsonRes(500, { error: "simulated_post_flip_failure" });
      }
      return jsonRes(404, { error: "unknown_classifier_path", path });
    }
    return jsonRes(404, { error: "unknown_host" });
  };

  let captured = null;
  await withFakeFetch(fakeRouter, async () => {
    try {
      await hotSwap({
        target: "classifier",
        to: "qwen3:0.6b-q5_K_M",
        smokeRounds: 2,
        drainMs: 0,
      });
    } catch (err) {
      captured = err;
    }
  });

  ok(c, "hotSwap threw on post-flip smoke failure", !!captured);
  ok(c, "error names rollback=rolled_back", captured && /rollback=rolled_back/.test(String(captured.message)));
  eq(c, "classifier model restored to original", classifierModel, "qwen3:0.6b");
  ok(c, "classifier target is registered in hot-swap TARGETS", !!HOT_SWAP_TARGETS.classifier);
}

// ---------------------------------------------------------------------------
// Case 6 — concurrent embedder slots
//   Set concurrency=5; fire 12 embed calls in parallel against a stub fetch
//   that holds open for a small delay. Verify never more than 5 in-flight at
//   any moment, queue depth tracked, all 12 complete OK.
// ---------------------------------------------------------------------------

{
  const c = caseStart(6, "concurrent embedder slots respected (concurrency=5)");

  const CONCURRENCY = 5;
  const N = 12;

  let inFlightObserved = 0;
  let peakInFlight = 0;
  const releases = []; // resolve-functions per call so we can stagger

  const stubFetch = async (url, init, _timeoutMs) => {
    if (!String(url).endsWith("/api/embeddings")) {
      return { ok: false, status: 404, async text() { return ""; }, async json() { return {}; } };
    }
    inFlightObserved += 1;
    if (inFlightObserved > peakInFlight) peakInFlight = inFlightObserved;
    // Suspend until our scheduler releases this call.
    await new Promise((resolve) => releases.push(resolve));
    inFlightObserved -= 1;
    return {
      ok: true,
      status: 200,
      async text() { return ""; },
      async json() { return { embedding: new Array(768).fill(0.5), model: "nomic-embed-text" }; },
    };
  };

  const pool = createEmbedderPool({
    model: "nomic-embed-text",
    concurrency: CONCURRENCY,
    fetchImpl: stubFetch,
  });

  // Kick off N requests.
  const tasks = [];
  for (let i = 0; i < N; i += 1) tasks.push(pool.embed(`input ${i}`));

  // Give the event loop a tick or two so the first 5 grab slots.
  await sleep(20);

  ok(c, "in-flight observed at most concurrency", peakInFlight <= CONCURRENCY);
  eq(c, "peak in-flight == concurrency",          peakInFlight, CONCURRENCY);

  const stMid = pool.stats();
  ok(c, "queue depth > 0 mid-flight",             stMid.queue_depth > 0);
  ok(c, "in_flight reported == concurrency",      stMid.in_flight === CONCURRENCY);

  // Release calls in waves: as each in-flight completes, the queue drains.
  while (releases.length > 0) {
    const r = releases.shift();
    r();
    // Let the next queued waiter promote into an inflight slot.
    await sleep(5);
  }

  const out = await Promise.all(tasks);
  eq(c, "all N tasks completed", out.length, N);
  ok(c, "every result is dim=768", out.every((r) => r.dim === 768));

  const stEnd = pool.stats();
  eq(c, "totals.ok=N",  stEnd.totals.ok, N);
  eq(c, "in_flight=0 at end", stEnd.in_flight, 0);
  eq(c, "queue_depth=0 at end", stEnd.queue_depth, 0);
  ok(c, "peak was never exceeded across run", peakInFlight === CONCURRENCY);
  await pool.close();
}

// ---------------------------------------------------------------------------
// Case 7 — health monitor reports correctly
//   Drive runOneTick with a fake fetch that returns the three N150 daemons +
//   Ollama in known states. Verify the schema-v1 snapshot is shaped, that
//   targets are all present, that fallback's 503 is treated as gated alive,
//   and that summarize() produces the documented percentile + error_rate.
// ---------------------------------------------------------------------------

{
  const c = caseStart(7, "health monitor reports correctly");

  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes(":7480")) return { status: 200, async text() { return JSON.stringify({ ok: true, model: "qwen3:0.6b" }); } };
    if (s.includes(":8798")) return { status: 200, async text() { return JSON.stringify({ ok: true, model: "nomic-embed-text", dim: 768 }); } };
    if (s.includes(":7481")) return { status: 503, async text() { return JSON.stringify({ gated: true, degraded: false }); } };
    if (s.includes(":11434")) return { status: 200, async text() { return JSON.stringify({ models: [{ name: "qwen3:0.6b" }, { name: "nomic-embed-text" }] }); } };
    return { status: 204, async text() { return ""; } };
  };

  const snap = await runOneTick({ fetchImpl, push: false, nowFn: () => 9_000 });
  eq(c, "snapshot schema",   snap.schema, "ae.n150.health.snapshot.v1");
  eq(c, "snapshot host",     snap.host, "n150");
  ok(c, "all 4 targets keyed in snapshot", HEALTH_TARGETS.every((t) => snap.targets[t.name] !== undefined));
  ok(c, "classifier up",     snap.targets.classifier.up === true);
  ok(c, "embedder up",       snap.targets.embedder.up === true);
  ok(c, "ollama up",         snap.targets.ollama.up === true);
  ok(c, "fallback-chat up=true (gated counts as alive)", snap.targets["fallback-chat"].up === true);
  ok(c, "fallback-chat gated=true flag", snap.targets["fallback-chat"].gated === true);

  // summarize() math sanity — mixed pass/fail.
  const r = summarize([
    { t: 1, ok: true,  status: 200, latency_ms: 10 },
    { t: 2, ok: true,  status: 200, latency_ms: 20 },
    { t: 3, ok: false, status: 503, latency_ms: 30, error: "down" },
    { t: 4, ok: true,  status: 200, latency_ms: 40 },
  ]);
  eq(c, "summarize samples=4",      r.samples, 4);
  eq(c, "summarize up=true (last)", r.up, true);
  eq(c, "summarize error_rate=0.25", r.error_rate, 0.25);
  eq(c, "summarize p50=20",         r.latency_ms_p50, 20);
  eq(c, "summarize last=40",        r.latency_ms_last, 40);

  // Empty rollup is null-ish, not a crash.
  const empty = summarize([]);
  eq(c, "summarize empty samples=0", empty.samples, 0);
  eq(c, "summarize empty up=false",  empty.up, false);
  eq(c, "summarize empty p50=null",  empty.latency_ms_p50, null);

  // probeTarget: a network error encodes ok=false but does not throw.
  const errSample = await probeTarget(
    { name: "classifier", url: "http://127.0.0.1:7480/healthz", optional: false },
    { fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, timeoutMs: 500, nowFn: () => 9_999 },
  );
  ok(c, "probeTarget network error → ok=false", errSample.ok === false);
  eq(c, "probeTarget network error → status=0", errSample.status, 0);
  ok(c, "probeTarget captured error string",    typeof errSample.error === "string" && errSample.error.includes("ECONNREFUSED"));
}

// ---------------------------------------------------------------------------
// Case 8 — 60fps SLA verified
//   The cockpit UI consumes the health-monitor snapshot through the cheap
//   in-memory read path (buildSnapshot over the rolling window) — NOT by
//   re-driving probes per frame. Probes run on a 10s background tick. The
//   UI's 60fps budget (16.67 ms/frame) only applies to the READ path.
//
//   We verify:
//     (a) buildSnapshot() over a fully-saturated WINDOW_SIZE (60 samples
//         per target × 4 targets) stays comfortably under the frame budget,
//         60 consecutive reads in a row.
//     (b) summarize() — the per-target rollup the UI invokes for sparklines
//         — is even faster.
//     (c) probeTarget against a synchronous-ish stub fetch finishes under
//         a quarter-frame, which is what the 10s tick requires to stay well
//         clear of any frame.
// ---------------------------------------------------------------------------

{
  const c = caseStart(8, "60fps SLA — snapshot READ budget under 16.67 ms/frame");

  const FRAME_BUDGET_MS = 1000 / 60; // 16.666...
  const ITERS = 60;                  // one full second of read frames

  // Saturate the in-memory window buffers (WINDOW_SIZE=60 by default) so
  // buildSnapshot must summarize the largest realistic working set.
  for (const t of HEALTH_TARGETS) {
    for (let i = 0; i < 60; i += 1) {
      recordSample(
        t.name,
        { t: i, ok: i % 7 !== 0, status: i % 7 === 0 ? 503 : 200, latency_ms: 1 + (i % 13) },
        { nowFn: () => i },
      );
    }
  }

  // Warm-up the JIT so the steady-state numbers reflect production cost.
  for (let i = 0; i < 5; i += 1) buildSnapshot({ nowFn: () => 999_000 });

  const snapSamples = [];
  for (let i = 0; i < ITERS; i += 1) {
    const t0 = performance.now();
    const snap = buildSnapshot({ nowFn: () => 1_000_000 + i });
    const dt = performance.now() - t0;
    snapSamples.push(dt);
    if (!snap || snap.schema !== "ae.n150.health.snapshot.v1") {
      ok(c, `iteration ${i} produced a v1 snapshot`, false, "snapshot missing or wrong schema");
      break;
    }
  }
  snapSamples.sort((a, b) => a - b);
  const p50 = snapSamples[Math.floor((snapSamples.length - 1) * 0.5)];
  const p95 = snapSamples[Math.floor((snapSamples.length - 1) * 0.95)];
  const max = snapSamples[snapSamples.length - 1];

  console.log(`  buildSnapshot:  p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms max=${max.toFixed(4)}ms  budget=${FRAME_BUDGET_MS.toFixed(3)}ms`);

  ok(c, "p50 snapshot read < frame budget", p50 < FRAME_BUDGET_MS, `p50=${p50.toFixed(4)}ms budget=${FRAME_BUDGET_MS.toFixed(3)}ms`);
  ok(c, "p95 snapshot read < frame budget", p95 < FRAME_BUDGET_MS, `p95=${p95.toFixed(4)}ms budget=${FRAME_BUDGET_MS.toFixed(3)}ms`);
  ok(c, "max snapshot read < frame budget", max < FRAME_BUDGET_MS, `max=${max.toFixed(4)}ms budget=${FRAME_BUDGET_MS.toFixed(3)}ms`);
  ok(c, `${ITERS} snapshots produced`,      snapSamples.length === ITERS);

  // summarize() is the inner-loop helper the UI calls for sparkline rollups.
  const dummySamples = Array.from({ length: 60 }, (_, i) => ({
    t: i, ok: i % 5 !== 0, status: i % 5 === 0 ? 503 : 200, latency_ms: 5 + (i % 11),
  }));
  for (let i = 0; i < 5; i += 1) summarize(dummySamples); // warm
  const sumSamples = [];
  for (let i = 0; i < ITERS; i += 1) {
    const t0 = performance.now();
    summarize(dummySamples);
    sumSamples.push(performance.now() - t0);
  }
  sumSamples.sort((a, b) => a - b);
  const sumP95 = sumSamples[Math.floor((sumSamples.length - 1) * 0.95)];
  console.log(`  summarize:      p95=${sumP95.toFixed(4)}ms  budget=${FRAME_BUDGET_MS.toFixed(3)}ms`);
  ok(c, "summarize p95 < frame budget", sumP95 < FRAME_BUDGET_MS, `p95=${sumP95.toFixed(4)}ms`);

  // Per-target probe latency — the 10s background tick must clear a frame
  // budget by a wide margin so it never collides with a UI repaint.
  const fastFetch = async (url) => {
    const s = String(url);
    if (s.includes(":7480")) return { status: 200, async text() { return '{"ok":true,"model":"qwen3:0.6b"}'; } };
    if (s.includes(":8798")) return { status: 200, async text() { return '{"ok":true,"model":"nomic-embed-text","dim":768}'; } };
    if (s.includes(":7481")) return { status: 503, async text() { return '{"gated":true}'; } };
    if (s.includes(":11434")) return { status: 200, async text() { return '{"models":[]}'; } };
    return { status: 204, async text() { return ""; } };
  };
  // Warm the probe path.
  await probeTarget(HEALTH_TARGETS[0], { fetchImpl: fastFetch, timeoutMs: 500, nowFn: () => 0 });

  const probeStart = performance.now();
  await probeTarget(HEALTH_TARGETS[0], { fetchImpl: fastFetch, timeoutMs: 500, nowFn: () => 0 });
  const probeDt = performance.now() - probeStart;
  const PROBE_BUDGET_MS = FRAME_BUDGET_MS / 4;
  console.log(`  probeTarget:    dt=${probeDt.toFixed(4)}ms  budget=${PROBE_BUDGET_MS.toFixed(3)}ms`);
  ok(c, `single probe under ${PROBE_BUDGET_MS.toFixed(2)}ms`, probeDt < PROBE_BUDGET_MS, `dt=${probeDt.toFixed(4)}ms`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalPass = RESULTS.filter((r) => r.ok).length;
const totalFail = RESULTS.length - totalPass;

console.log("");
console.log("=".repeat(72));
console.log("[smoke] N150 utility battery — 8 cases");
for (const cs of CASES) {
  const pass = cs.checks.filter((x) => x.ok).length;
  const fail = cs.checks.length - pass;
  const tag = fail === 0 ? "PASS" : "FAIL";
  console.log(`  case ${cs.num}: ${tag}  (${pass}/${cs.checks.length})  ${cs.title}`);
}
console.log("=".repeat(72));
console.log(`[smoke] checks: ${totalPass}/${RESULTS.length} passed, ${totalFail} failed`);

if (totalFail > 0) {
  console.log("");
  console.log("[smoke] failing checks:");
  for (const f of RESULTS.filter((r) => !r.ok)) {
    console.log(`  - case ${f.case}: ${f.name}${f.detail ? `  — ${f.detail}` : ""}`);
  }
  process.exit(1);
}
process.exit(0);
