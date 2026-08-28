#!/usr/bin/env node
// N150 emergency chat fallback — smoke tests.
// Path: 06-ORANGELLM/n150-utility/fallback-chat/tests/server.test.mjs
//
// Hermetic. No network. We inject a fake fetch that simulates both:
//   - Codexa /healthz   (rail probe)
//   - Ollama /api/chat  (degraded chat)
//   - Ollama /api/tags  (hot-swap validation)
//
// Tests:
//   1. /healthz works before any probe and reports activated=false.
//   2. /chat is gated (503) while Codexa rail is healthy.
//   3. After Codexa is unreachable past the grace window, /chat activates
//      and returns degraded=true with X-AE-Degraded:true header.
//   4. Activation only fires AFTER the grace window, not before.
//   5. Three consecutive healthy probes deactivate /chat again.
//   6. Inflight gate caps concurrency at MAX_INFLIGHT.
//   7. Prompt validation: missing prompt -> 400; oversize -> 413.
//   8. /admin/swap rejects non-stock model names.
//   9. /admin/swap rejects stock-pattern model not installed in Ollama.
//  10. /admin/swap accepts an installed stock model and flips chatModel.
//  11. /readyz mirrors activation state.
//  12. Ollama upstream error surfaces as 502 with degraded=true body.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/fallback-chat/tests/server.test.mjs
//
// Exit 0 on green, 1 on any failure.

import {
  createServer,
  createHandler,
  createState,
  probeCodexa,
  acquireSlot,
  releaseSlot,
  MAX_INFLIGHT,
  ACTIVATION_GRACE_MS,
  DEACTIVATION_HEALTHY_RUNS,
  MAX_PROMPT_CHARS,
  STOCK_QWEN3_PATTERN,
  DEFAULT_CHAT_MODEL,
} from "../server.mjs";

// ---------- Mini harness ----------

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- Fake fetch factory ----------
//
// rail: "up" | "down" | () => "up"|"down"   - Codexa /healthz behavior
// installedTags: array of model names returned by /api/tags
// chat: () => { content: string }            - Ollama /api/chat response

function makeFetch({
  rail = "up",
  installedTags = ["qwen3:0.6b", "qwen3:0.6b-q4", "nomic-embed-text:latest"],
  chat = () => ({ content: "ok" }),
  chatStatus = 200,
} = {}) {
  return async function fakeFetch(url, opts = {}) {
    const u = String(url);
    if (u.endsWith("/healthz")) {
      const state = typeof rail === "function" ? rail() : rail;
      if (state === "up") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // Simulate unreachable host as a network error.
      throw new Error("ECONNREFUSED");
    }
    if (u.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({ models: installedTags.map((n) => ({ name: n })) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/api/chat")) {
      if (chatStatus !== 200) {
        return new Response("upstream broke", { status: chatStatus });
      }
      const c = chat();
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: c.content },
          total_duration: 12_345_678,
          eval_count: 17,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not_found", { status: 404 });
  };
}

function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
    init.headers["Content-Length"] = String(init.body.length);
  }
  return new Request(`http://127.0.0.1:7481${path}`, init);
}

// ---------- Tests ----------

async function test1_healthz_pre_probe() {
  const { state, handler } = createServer({ fetchImpl: makeFetch({ rail: "up" }) });
  const res = await handler(req("GET", "/healthz"));
  const body = await res.json();
  assert(res.status === 200, "healthz status");
  assert(body.ok === true, "healthz ok");
  assert(body.activated === false, "not activated before probe");
  assert(body.model === DEFAULT_CHAT_MODEL, "default model exposed");
}

async function test2_chat_gated_when_rail_healthy() {
  const { state, handler } = createServer({ fetchImpl: makeFetch({ rail: "up" }) });
  await probeCodexa(state);
  assert(state.railHealthy === true, "rail healthy after probe");
  const res = await handler(req("POST", "/chat", { prompt: "hi" }));
  assert(res.status === 503, "chat gated 503");
  assert(res.headers.get("X-AE-Degraded") === "false", "not degraded header");
  const body = await res.json();
  assert(body.error === "fallback_not_active", "fallback_not_active reason");
}

async function test3_activates_after_grace_then_serves_degraded() {
  let now = 1_000_000;
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ rail: "down", chat: () => ({ content: "degraded reply" }) }),
    activationGraceMs: 60_000,
    now: () => now,
  });
  // First failing probe — sets firstFailureAt.
  await probeCodexa(state);
  assert(state.activated === false, "not activated immediately");
  // Advance clock past grace window and probe again.
  now += 61_000;
  await probeCodexa(state);
  assert(state.activated === true, "activated after grace");

  const res = await handler(req("POST", "/chat", { prompt: "help me" }));
  assert(res.status === 200, "chat 200 once activated");
  assert(res.headers.get("X-AE-Degraded") === "true", "degraded header set");
  assert(res.headers.get("X-AE-Reason") === "codexa-rail-unreachable", "reason header set");
  const body = await res.json();
  assert(body.degraded === true, "body degraded flag");
  assert(body.model === DEFAULT_CHAT_MODEL, "body model");
  assert(typeof body.content === "string" && body.content.length > 0, "body content");
  assert(typeof body.note === "string" && body.note.includes("degraded"), "human note");
}

async function test4_no_activation_before_grace() {
  let now = 1_000_000;
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ rail: "down" }),
    activationGraceMs: 60_000,
    now: () => now,
  });
  await probeCodexa(state);
  now += 30_000; // less than grace
  await probeCodexa(state);
  assert(state.activated === false, "not activated within grace window");
  const res = await handler(req("POST", "/chat", { prompt: "x" }));
  assert(res.status === 503, "still gated");
}

async function test5_deactivates_after_healthy_runs() {
  let railState = "down";
  let now = 1_000_000;
  const { state } = createServer({
    fetchImpl: makeFetch({ rail: () => railState }),
    activationGraceMs: 10_000,
    deactivationRuns: DEACTIVATION_HEALTHY_RUNS,
    now: () => now,
  });
  // Bring up activation.
  await probeCodexa(state);
  now += 11_000;
  await probeCodexa(state);
  assert(state.activated === true, "activated");
  // Now flip rail back up. Need DEACTIVATION_HEALTHY_RUNS healthy probes.
  railState = "up";
  for (let i = 0; i < DEACTIVATION_HEALTHY_RUNS - 1; i++) {
    await probeCodexa(state);
    assert(state.activated === true, `still active after ${i + 1} healthy`);
  }
  await probeCodexa(state);
  assert(state.activated === false, "deactivated after N healthy probes");
  assert(state.stats.deactivations === 1, "deactivation counter");
}

async function test6_inflight_gate_caps_concurrency() {
  const state = createState({ fetchImpl: makeFetch() });
  // Fill all slots.
  for (let i = 0; i < MAX_INFLIGHT; i++) await acquireSlot(state);
  assert(state.inflight === MAX_INFLIGHT, "all slots filled");
  // Next acquire must wait.
  let resolved = false;
  const p = acquireSlot(state).then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert(resolved === false, "waiter blocked while full");
  // Release one — the waiter gets the slot directly.
  releaseSlot(state);
  await p;
  assert(resolved === true, "waiter resolved after release");
  // Drain.
  for (let i = 0; i < MAX_INFLIGHT; i++) releaseSlot(state);
}

async function test7_prompt_validation() {
  let now = 1_000_000;
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ rail: "down" }),
    activationGraceMs: 0,
    now: () => now,
  });
  await probeCodexa(state);
  await probeCodexa(state);
  assert(state.activated === true, "activated for prompt-validation test");

  const r1 = await handler(req("POST", "/chat", {}));
  assert(r1.status === 400, "missing prompt -> 400");
  const b1 = await r1.json();
  assert(b1.error === "prompt_required", "prompt_required");

  const big = "a".repeat(MAX_PROMPT_CHARS + 1);
  const r2 = await handler(req("POST", "/chat", { prompt: big }));
  assert(r2.status === 413, "oversize prompt -> 413");
  const b2 = await r2.json();
  assert(b2.error === "prompt_too_long", "prompt_too_long");
  assert(b2.degraded === true, "still flags degraded on validation error during outage");
}

async function test8_admin_swap_rejects_non_stock() {
  const { handler } = createServer({ fetchImpl: makeFetch() });
  const r = await handler(req("POST", "/admin/swap", { model: "evil-finetune:latest" }));
  assert(r.status === 400, "non-stock rejected");
  const b = await r.json();
  assert(b.error === "non_stock_model_rejected", "rejection reason");
  // And the regex itself excludes obvious non-stock names.
  assert(STOCK_QWEN3_PATTERN.test("qwen3:0.6b") === true, "qwen3:0.6b is stock");
  assert(STOCK_QWEN3_PATTERN.test("llama3:8b") === false, "llama3 is not stock-qwen3");
}

async function test9_admin_swap_rejects_uninstalled() {
  const { handler } = createServer({
    fetchImpl: makeFetch({ installedTags: ["qwen3:0.6b"] }),
  });
  const r = await handler(req("POST", "/admin/swap", { model: "qwen3:99b-ghost" }));
  assert(r.status === 404, "uninstalled stock-pattern rejected");
  const b = await r.json();
  assert(b.error === "model_not_installed", "not installed reason");
}

async function test10_admin_swap_accepts_installed_stock() {
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ installedTags: ["qwen3:0.6b", "qwen3:0.6b-q4"] }),
  });
  assert(state.chatModel === "qwen3:0.6b", "default model");
  const r = await handler(req("POST", "/admin/swap", { model: "qwen3:0.6b-q4" }));
  assert(r.status === 200, "swap 200");
  const b = await r.json();
  assert(b.ok === true && b.current === "qwen3:0.6b-q4" && b.previous === "qwen3:0.6b",
    "swap result");
  assert(state.chatModel === "qwen3:0.6b-q4", "state updated");
  assert(state.stats.hot_swaps === 1, "hot_swaps counter");
}

async function test11_readyz_mirrors_activation() {
  let now = 1_000_000;
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ rail: "down" }),
    activationGraceMs: 1_000,
    now: () => now,
  });
  const r1 = await handler(req("GET", "/readyz"));
  assert(r1.status === 503, "readyz 503 before activation");
  await probeCodexa(state);
  now += 2_000;
  await probeCodexa(state);
  assert(state.activated === true, "activated");
  const r2 = await handler(req("GET", "/readyz"));
  assert(r2.status === 200, "readyz 200 once activated");
}

async function test12_ollama_upstream_error_surfaces_502() {
  let now = 1_000_000;
  const { state, handler } = createServer({
    fetchImpl: makeFetch({ rail: "down", chatStatus: 500 }),
    activationGraceMs: 0,
    now: () => now,
  });
  await probeCodexa(state);
  await probeCodexa(state);
  const r = await handler(req("POST", "/chat", { prompt: "hi" }));
  assert(r.status === 502, "upstream 500 -> 502 to caller");
  assert(r.headers.get("X-AE-Degraded") === "true", "still degraded");
  const b = await r.json();
  assert(typeof b.error === "string" && b.error.startsWith("ollama_http_"),
    "error surfaces upstream code");
}

// ---------- Runner ----------

const cases = [
  ["1_healthz_pre_probe",                test1_healthz_pre_probe],
  ["2_chat_gated_when_rail_healthy",     test2_chat_gated_when_rail_healthy],
  ["3_activates_after_grace_then_serves",test3_activates_after_grace_then_serves_degraded],
  ["4_no_activation_before_grace",       test4_no_activation_before_grace],
  ["5_deactivates_after_healthy_runs",   test5_deactivates_after_healthy_runs],
  ["6_inflight_gate_caps_concurrency",   test6_inflight_gate_caps_concurrency],
  ["7_prompt_validation",                test7_prompt_validation],
  ["8_admin_swap_rejects_non_stock",     test8_admin_swap_rejects_non_stock],
  ["9_admin_swap_rejects_uninstalled",   test9_admin_swap_rejects_uninstalled],
  ["10_admin_swap_accepts_installed",    test10_admin_swap_accepts_installed_stock],
  ["11_readyz_mirrors_activation",       test11_readyz_mirrors_activation],
  ["12_ollama_upstream_error_502",       test12_ollama_upstream_error_surfaces_502],
];

(async () => {
  // eslint-disable-next-line no-console
  console.log("n150-fallback-chat smoke tests");
  for (const [name, fn] of cases) {
    try {
      await fn();
      record(name, true);
    } catch (err) {
      record(name, false, err?.message ?? String(err));
    }
  }
  const fails = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
})();
