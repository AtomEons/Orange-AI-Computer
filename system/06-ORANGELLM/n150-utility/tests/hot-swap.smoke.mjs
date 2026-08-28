#!/usr/bin/env node
// hot-swap.smoke.mjs — hermetic unit smoke for the N150 hot-swap orchestrator.
// No network. No Ollama. No real daemons. We override globalThis.fetch with a
// deterministic mock router that simulates:
//   - Ollama /api/tags, /api/pull (streaming JSONL), /api/generate, /api/embeddings
//   - Each daemon's /healthz, /model | /admin/swap, and the post-flip smoke endpoints
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/tests/hot-swap.smoke.mjs
//
// Exit 0 = all pass. Exit 1 = at least one fail (with the failing case named).
//
// We deliberately avoid third-party test runners. The repo's other smoke tests
// (classifier.smoke.mjs, server.test.mjs) use this same pattern.

import { hotSwap, TARGETS, VERSION } from "../hot-swap.mjs";

// -- Tiny assertion framework ------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truthy(name, val, hint = "") {
  check(name, !!val, val ? "" : (hint || `falsy: ${JSON.stringify(val)}`));
}
async function rejects(name, fn, msgMatch = null) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    const msg = String(err?.message || err);
    if (msgMatch && !new RegExp(msgMatch).test(msg)) {
      check(name, false, `wrong message: ${msg}`);
    } else {
      check(name, true, msg.slice(0, 80));
    }
  }
}

// -- Mock fetch --------------------------------------------------------------

function makeMock({
  installedTags = new Set(["qwen3:0.6b"]),
  daemonModels = { classifier: "qwen3:0.6b", embedder: "nomic-embed-text", "fallback-chat": "qwen3:0.6b" },
  shadowGenerateFails = false,
  shadowEmbedFails = false,
  shadowEmbedBad = false, // returns non-finite embedding
  daemonFlipFails = null, // null | { target }
  daemonFlipMissingTag = false, // post-flip healthz still reports old model
  daemonSmokeFails = null, // null | { target }
  pullProgress = ["pulling manifest", "downloading", "verifying sha256 digest", "success"],
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const path = u.pathname;
    const port = u.port;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, method, path, body });

    // ----- Ollama (port 11434) -----
    if (port === "11434" || u.host === "127.0.0.1:11434") {
      if (path === "/api/tags" && method === "GET") {
        return jsonRes(200, { models: [...installedTags].map((n) => ({ name: n })) });
      }
      if (path === "/api/pull" && method === "POST") {
        // Return a streamed JSONL body. Each progress line ends with \n.
        const lines = pullProgress.slice();
        // Simulate the pull succeeding: register the tag in installedTags.
        const tag = body?.name;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            for (const status of lines) {
              controller.enqueue(enc.encode(JSON.stringify({ status }) + "\n"));
            }
            // Register tag after the stream ends.
            if (tag && lines[lines.length - 1] === "success") {
              installedTags.add(tag);
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (path === "/api/generate" && method === "POST") {
        if (shadowGenerateFails) return jsonRes(500, { error: "simulated_generate_fail" });
        return jsonRes(200, {
          model: body?.model,
          response: "reality",
          done: true,
        });
      }
      if (path === "/api/embeddings" && method === "POST") {
        if (shadowEmbedFails) return jsonRes(500, { error: "simulated_embed_fail" });
        if (shadowEmbedBad) return jsonRes(200, { embedding: [Number.NaN, 1, 2] });
        // 8-dim deterministic vector
        return jsonRes(200, { embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] });
      }
      return jsonRes(404, { error: "mock_ollama_unknown", path });
    }

    // ----- Classifier daemon (port 7480) -----
    if (port === "7480") {
      if (path === "/healthz" && method === "GET") {
        return jsonRes(200, { status: "ok", service: "n150-classifier", active_model: daemonModels.classifier });
      }
      if (path === "/model" && method === "POST") {
        if (daemonFlipFails?.target === "classifier") {
          return jsonRes(400, { error: "model_not_installed" });
        }
        const tag = body?.model;
        if (!daemonFlipMissingTag) daemonModels.classifier = tag;
        return jsonRes(200, { ok: true, active_model: daemonModels.classifier });
      }
      if (path === "/classify" && method === "POST") {
        if (daemonSmokeFails?.target === "classifier") {
          return jsonRes(500, { error: "simulated_classify_fail" });
        }
        return jsonRes(200, { lane: "reality", confidence: 1.0, source: "origin_rule" });
      }
      return jsonRes(404, { error: "mock_classifier_unknown", path });
    }

    // ----- Embedder daemon (port 8798) -----
    if (port === "8798") {
      if (path === "/healthz" && method === "GET") {
        return jsonRes(200, { state: "open", model: daemonModels.embedder });
      }
      if (path === "/admin/swap" && method === "POST") {
        if (daemonFlipFails?.target === "embedder") {
          return jsonRes(400, { error: "non_stock_model_rejected" });
        }
        const tag = body?.model;
        if (!daemonFlipMissingTag) daemonModels.embedder = tag;
        return jsonRes(200, { ok: true, previous: "nomic-embed-text", current: daemonModels.embedder });
      }
      if (path === "/embed" && method === "POST") {
        if (daemonSmokeFails?.target === "embedder") {
          return jsonRes(500, { error: "simulated_embed_fail" });
        }
        return jsonRes(200, { embedding: [0.1, 0.2, 0.3, 0.4], model: daemonModels.embedder, dim: 4 });
      }
      return jsonRes(404, { error: "mock_embedder_unknown", path });
    }

    // ----- Fallback-chat daemon (port 8799) -----
    if (port === "8799") {
      if (path === "/healthz" && method === "GET") {
        return jsonRes(200, { degraded: false, model: daemonModels["fallback-chat"] });
      }
      if (path === "/admin/swap" && method === "POST") {
        if (daemonFlipFails?.target === "fallback-chat") {
          return jsonRes(400, { error: "non_stock_model_rejected" });
        }
        const tag = body?.model;
        if (!daemonFlipMissingTag) daemonModels["fallback-chat"] = tag;
        return jsonRes(200, { ok: true, previous: "qwen3:0.6b", current: daemonModels["fallback-chat"] });
      }
      return jsonRes(404, { error: "mock_fallback_unknown", path });
    }

    return jsonRes(404, { error: "mock_unknown_host", host: u.host });
  };

  return { calls, installedTags, daemonModels };
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// -- Tests -------------------------------------------------------------------

console.log(`[smoke] ${VERSION}`);
console.log("");

// [1] Targets registry is sane.
console.log("[1] TARGETS registry");
eq("  classifier present", !!TARGETS.classifier, true);
eq("  embedder present", !!TARGETS.embedder, true);
eq("  fallback-chat present", !!TARGETS["fallback-chat"], true);
eq("  classifier smoke_kind is generate", TARGETS.classifier.smoke_kind, "generate");
eq("  embedder smoke_kind is embed", TARGETS.embedder.smoke_kind, "embed");

// [2] Happy path: classifier swap to a new qwen3 stock tag.
console.log("");
console.log("[2] happy path — classifier swap qwen3:0.6b → qwen3:0.6b-q5_K_M");
{
  const mock = makeMock();
  const rec = await hotSwap({
    target: "classifier",
    to: "qwen3:0.6b-q5_K_M",
    smokeRounds: 2,
    drainMs: 0,
  });
  eq("  outcome=success", rec.outcome, "success");
  eq("  from captured", rec.from, "qwen3:0.6b");
  eq("  to recorded", rec.to, "qwen3:0.6b-q5_K_M");
  eq("  daemon now reports new model", mock.daemonModels.classifier, "qwen3:0.6b-q5_K_M");
  truthy("  shadow_smoke trials captured", Array.isArray(rec.shadow_smoke) && rec.shadow_smoke.length === 2);
  truthy("  post_flip_smoke present", !!rec.post_flip_smoke);
  truthy("  pull was attempted (tag was absent)", mock.calls.some((c) => c.path === "/api/pull"));
}

// [3] Happy path: embedder swap. Verifies embed shadow + post-flip embedding.
console.log("");
console.log("[3] happy path — embedder swap nomic-embed-text → nomic-embed-text:v1.5");
{
  const mock = makeMock();
  const rec = await hotSwap({
    target: "embedder",
    to: "nomic-embed-text:v1.5",
    smokeRounds: 1,
    drainMs: 0,
  });
  eq("  outcome=success", rec.outcome, "success");
  eq("  daemon now reports new model", mock.daemonModels.embedder, "nomic-embed-text:v1.5");
  eq("  post_flip dim recorded", rec.post_flip_smoke?.dim, 4);
}

// [4] Noop: target tag equals current tag.
console.log("");
console.log("[4] noop — same tag");
{
  makeMock();
  const rec = await hotSwap({
    target: "classifier",
    to: "qwen3:0.6b",
    drainMs: 0,
  });
  eq("  outcome=noop_same_tag", rec.outcome, "noop_same_tag");
}

// [5] Dry-run: pull + shadow + smoke, but no flip.
console.log("");
console.log("[5] dry-run — pull and smoke but never flip");
{
  const mock = makeMock();
  const rec = await hotSwap({
    target: "embedder",
    to: "nomic-embed-text:v1.5",
    dryRun: true,
    smokeRounds: 1,
    drainMs: 0,
  });
  eq("  outcome=dry_run_ok", rec.outcome, "dry_run_ok");
  eq("  daemon model UNCHANGED (no flip)", mock.daemonModels.embedder, "nomic-embed-text");
  truthy("  shadow_smoke ran", Array.isArray(rec.shadow_smoke) && rec.shadow_smoke.length === 1);
  truthy("  no /admin/swap call", !mock.calls.some((c) => c.path === "/admin/swap"));
}

// [6] Stock-tag guard: bogus tag refused before any network.
console.log("");
console.log("[6] stock-tag guard");
{
  makeMock();
  await rejects(
    "  rejects path-like tag",
    () => hotSwap({ target: "classifier", to: "../etc/passwd", drainMs: 0 }),
    "non_stock_tag_rejected"
  );
  await rejects(
    "  rejects whitespace tag",
    () => hotSwap({ target: "classifier", to: "qwen3 evil", drainMs: 0 }),
    "non_stock_tag_rejected"
  );
}

// [7] Flip failure: daemon refuses swap. No rollback needed (alias never moved).
console.log("");
console.log("[7] flip refused — no rollback needed");
{
  const mock = makeMock({ daemonFlipFails: { target: "classifier" } });
  await rejects(
    "  rejects with daemon error",
    () => hotSwap({ target: "classifier", to: "qwen3:0.6b-q5_K_M", drainMs: 0 }),
    "daemon_flip_http"
  );
  eq("  daemon model unchanged", mock.daemonModels.classifier, "qwen3:0.6b");
}

// [8] Post-flip smoke failure → automatic rollback.
console.log("");
console.log("[8] post-flip smoke fails → auto-rollback to previous tag");
{
  const mock = makeMock({ daemonSmokeFails: { target: "classifier" } });
  let captured = null;
  try {
    await hotSwap({ target: "classifier", to: "qwen3:0.6b-q5_K_M", drainMs: 0 });
  } catch (err) {
    captured = err;
  }
  truthy("  hotSwap threw", !!captured);
  truthy("  error mentions rollback", captured && /rollback=rolled_back/.test(String(captured.message)));
  eq("  daemon restored to original", mock.daemonModels.classifier, "qwen3:0.6b");
}

// [9] Unknown target.
console.log("");
console.log("[9] unknown target rejected");
{
  makeMock();
  await rejects(
    "  unknown target",
    () => hotSwap({ target: "nonexistent", to: "qwen3:0.6b" }),
    "unknown_target"
  );
}

// [10] Missing --to.
console.log("");
console.log("[10] missing to-tag rejected");
{
  makeMock();
  await rejects("  no to", () => hotSwap({ target: "classifier", drainMs: 0 }), "missing_to_tag");
}

// -- Summary -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;
console.log("");
console.log(`[smoke] ${passed}/${results.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  process.exit(1);
}
process.exit(0);
