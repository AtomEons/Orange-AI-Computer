#!/usr/bin/env node
// n150-utility/hot-swap.mjs — orchestrates a no-restart stock-model swap on the N150.
// ----------------------------------------------------------------------------
// Operator surface (CLI):
//
//   node hot-swap.mjs --target=<classifier|embedder|fallback-chat> \
//                     --to=<stock_tag> [--from=<current_tag>] [--dry-run] \
//                     [--smoke-rounds=<n>] [--drain-ms=<n>] [--rollback]
//
// Examples:
//   # Swap the classifier from whatever it has to qwen3:0.6b-q5_K_M
//   node hot-swap.mjs --target=classifier --to=qwen3:0.6b-q5_K_M
//
//   # Swap the embedder, run 5 smoke embeds, allow 8s for old in-flight to drain
//   node hot-swap.mjs --target=embedder --to=nomic-embed-text:v1.5 \
//                     --smoke-rounds=5 --drain-ms=8000
//
//   # Roll back the chat fallback to its previous tag (read from receipt log)
//   node hot-swap.mjs --target=fallback-chat --rollback
//
// Procedure (the contract):
//   1. PRELUDE        — load target spec, confirm daemon /healthz, capture current tag
//   2. PULL           — POST /api/pull on Ollama; wait until tag present in /api/tags
//   3. SHADOW LOAD    — warm the new tag in Ollama without flipping the daemon's alias
//                       (one stock call against /api/generate or /api/embeddings)
//   4. SMOKE          — run target-specific smoke calls against shadow model
//   5. FLIP ALIAS     — POST to the daemon's swap endpoint (no restart)
//   6. POST-FLIP SMOKE — confirm the daemon now answers with the new tag
//   7. DRAIN          — sleep DRAIN_MS so in-flight requests on the old tag finish
//   8. RECEIPT        — write JSONL line to state/hot-swap.jsonl
//
// On ANY failure between PULL and POST-FLIP SMOKE we attempt automatic rollback
// to the captured "from" tag and exit non-zero with the failure reason. Mom's
// Law: name the gap, never silently leave a half-swapped daemon.
//
// Per Wave 1 doctrine: STOCK WEIGHTS ONLY. The "--to" tag must match the target's
// stock-tag whitelist (delegated to each daemon's own swap endpoint, which
// re-validates against /api/tags before accepting). We refuse to pull anything
// that doesn't look like a public Ollama tag.
//
// Network footprint: loopback only (127.0.0.1). Ollama on :11434, daemons on
// their own published ports (classifier 7480, embedder 8798, fallback-chat 8799).
// ----------------------------------------------------------------------------

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -- Paths ------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname);
const STATE_DIR = resolve(ROOT, "state");
const RECEIPT_PATH = resolve(STATE_DIR, "hot-swap.jsonl");

// -- Constants --------------------------------------------------------------

export const VERSION = "n150-hot-swap.v0.1.0";

const OLLAMA_BASE = process.env.N150_OLLAMA_BASE || "http://127.0.0.1:11434";
const OLLAMA_PULL_TIMEOUT_MS = parseInt(process.env.N150_OLLAMA_PULL_TIMEOUT_MS || "600000", 10); // 10m
const OLLAMA_PROBE_TIMEOUT_MS = parseInt(process.env.N150_OLLAMA_PROBE_TIMEOUT_MS || "5000", 10);
const DEFAULT_DRAIN_MS = parseInt(process.env.N150_HOT_SWAP_DRAIN_MS || "5000", 10);
const DEFAULT_SMOKE_ROUNDS = parseInt(process.env.N150_HOT_SWAP_SMOKE_ROUNDS || "3", 10);

// Stock-tag shape, mirrors the daemons' own regexes. Defense in depth — the
// daemons re-validate against /api/tags, but we refuse to even attempt a pull
// for anything that doesn't look like a normal published Ollama tag.
const STOCK_TAG_RE = /^[a-z0-9][a-z0-9._:\-]{0,63}$/i;

// Target registry. Each entry knows how to:
//   - read the daemon's currently active model
//   - flip the daemon's alias to a new tag (no restart)
//   - run a representative smoke call against EITHER the daemon OR the raw
//     model in Ollama (used for shadow-load + smoke before flip)
//   - report a friendly id for receipts
export const TARGETS = {
  classifier: {
    id: "classifier",
    daemon_base: process.env.N150_CLASSIFIER_BASE || "http://127.0.0.1:7480",
    ollama_path: "/api/generate", // qwen3:0.6b is a chat-completion model
    smoke_kind: "generate",
    smoke_prompt:
      "Reply with EXACTLY one lowercase word from: reality, thought, merge.\norigin: \"receipt.test.smoke\"\nReply:",
    swap_endpoint: "/model",
    swap_body: (model) => ({ model }),
    healthz_path: "/healthz",
    model_field: "active_model",
  },
  embedder: {
    id: "embedder",
    daemon_base: process.env.N150_EMBEDDER_BASE || "http://127.0.0.1:8798",
    ollama_path: "/api/embeddings",
    smoke_kind: "embed",
    smoke_input: "AtomEons N150 utility embedder smoke probe.",
    swap_endpoint: "/admin/swap",
    swap_body: (model) => ({ model }),
    healthz_path: "/healthz",
    model_field: "model", // pool.stats() reports { model, ... }
  },
  "fallback-chat": {
    id: "fallback-chat",
    daemon_base: process.env.N150_FALLBACK_CHAT_BASE || "http://127.0.0.1:8799",
    ollama_path: "/api/generate",
    smoke_kind: "generate",
    smoke_prompt: "Reply with the single word ok.",
    swap_endpoint: "/admin/swap",
    swap_body: (model) => ({ model }),
    healthz_path: "/healthz",
    model_field: "model",
  },
};

// -- Tiny structured logger -------------------------------------------------

const LOG_LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const LOG_MIN = LOG_LEVELS[process.env.N150_HOT_SWAP_LOG_LEVEL || "info"] || 30;

function log(level, evt, fields = {}) {
  if ((LOG_LEVELS[level] || 30) < LOG_MIN) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    evt,
    component: "n150-hot-swap",
    version: VERSION,
    ...fields,
  });
  // Receipts go to stderr so stdout is clean for downstream tools.
  process.stderr.write(line + "\n");
}

// -- HTTP helpers (fetch with timeout, JSON-only) ---------------------------

async function httpJson(url, { method = "GET", body, timeoutMs = OLLAMA_PROBE_TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 512) }; }
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// -- State / receipts -------------------------------------------------------

async function ensureStateDir() {
  if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });
}

async function writeReceipt(record) {
  try {
    await ensureStateDir();
    await appendFile(RECEIPT_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Mom's Law: name the gap, do not crash. The CLI exit code still tells truth.
    log("warn", "receipt_write_failed", { error: String(err?.message || err) });
  }
}

async function lastSuccessfulReceiptFor(targetId) {
  if (!existsSync(RECEIPT_PATH)) return null;
  let raw;
  try { raw = await readFile(RECEIPT_PATH, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec && rec.target === targetId && rec.outcome === "success" && rec.from && rec.to) {
        return rec;
      }
    } catch { /* skip junk line */ }
  }
  return null;
}

// -- Ollama operations ------------------------------------------------------

async function ollamaListTags() {
  const url = `${OLLAMA_BASE}/api/tags`;
  const { ok, status, body } = await httpJson(url, { method: "GET" });
  if (!ok) throw new Error(`ollama_tags_unreachable: status=${status}`);
  const names = ((body && body.models) || []).map((m) => m?.name || m?.model).filter(Boolean);
  return names;
}

async function isTagPresent(tag) {
  const tags = await ollamaListTags();
  return tags.includes(tag);
}

/**
 * Pull a tag. /api/pull streams a progress JSONL; we drain it to completion and
 * then re-probe /api/tags. We do NOT trust the stream's `status: success` alone —
 * a successful pull MUST end with the tag visible in /api/tags.
 */
async function ollamaPull(tag, { timeoutMs = OLLAMA_PULL_TIMEOUT_MS, onProgress } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: tag, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama_pull_http_${res.status}`);
    // Drain the stream. Each line is a JSON object with { status, ... }.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastStatus = null;
    let sawError = null;
    /* eslint-disable no-constant-condition */
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          lastStatus = obj?.status || lastStatus;
          if (obj?.error) sawError = obj.error;
          if (typeof onProgress === "function") onProgress(obj);
        } catch {
          // Ignore unparseable progress lines; Ollama sometimes emits trailing whitespace.
        }
      }
    }
    if (sawError) throw new Error(`ollama_pull_error: ${sawError}`);
    if (lastStatus !== "success") {
      // Some Ollama builds end the stream after the final "verifying sha256 digest"
      // line without a literal "success". Fall back to the tag-presence probe.
      const present = await isTagPresent(tag);
      if (!present) throw new Error(`ollama_pull_unverified_last_status=${lastStatus}`);
    } else {
      const present = await isTagPresent(tag);
      if (!present) throw new Error("ollama_pull_reported_success_but_tag_absent");
    }
    return { ok: true, last_status: lastStatus };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shadow-load: ask Ollama to load the new tag into memory without going through
 * the daemon. For generate-style targets we issue an empty generate (Ollama
 * accepts prompt:"" as a load primitive). For embed targets we send one short
 * embedding. Either way the model is now hot in Ollama's slot cache.
 */
async function ollamaShadowLoad(spec, tag) {
  const url = `${OLLAMA_BASE}${spec.ollama_path}`;
  if (spec.smoke_kind === "generate") {
    const { ok, status, body } = await httpJson(url, {
      method: "POST",
      body: { model: tag, prompt: "", stream: false, options: { num_predict: 1 } },
      timeoutMs: 60_000,
    });
    if (!ok) throw new Error(`shadow_load_generate_http_${status}: ${JSON.stringify(body)?.slice(0, 256)}`);
    return { ok: true };
  }
  if (spec.smoke_kind === "embed") {
    const { ok, status, body } = await httpJson(url, {
      method: "POST",
      body: { model: tag, prompt: "shadow_load" },
      timeoutMs: 60_000,
    });
    if (!ok) throw new Error(`shadow_load_embed_http_${status}: ${JSON.stringify(body)?.slice(0, 256)}`);
    return { ok: true };
  }
  throw new Error(`unknown_smoke_kind: ${spec.smoke_kind}`);
}

/**
 * Pre-flip smoke: hit Ollama directly with the new tag. Repeats `rounds` times.
 * Confirms the model loaded clean and returns sane responses. Latency captured.
 */
async function smokeShadow(spec, tag, rounds) {
  const url = `${OLLAMA_BASE}${spec.ollama_path}`;
  const trials = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = Date.now();
    if (spec.smoke_kind === "generate") {
      const { ok, status, body } = await httpJson(url, {
        method: "POST",
        body: {
          model: tag,
          prompt: spec.smoke_prompt,
          stream: false,
          options: { temperature: 0, num_predict: 16, stop: ["\n"] },
        },
        timeoutMs: 60_000,
      });
      if (!ok) throw new Error(`shadow_smoke_generate_http_${status} on round ${i + 1}`);
      const response = String(body?.response ?? "").trim();
      if (response.length === 0) throw new Error(`shadow_smoke_empty_response on round ${i + 1}`);
      trials.push({ round: i + 1, latency_ms: Date.now() - t0, len: response.length });
    } else if (spec.smoke_kind === "embed") {
      const { ok, status, body } = await httpJson(url, {
        method: "POST",
        body: { model: tag, prompt: spec.smoke_input },
        timeoutMs: 60_000,
      });
      if (!ok) throw new Error(`shadow_smoke_embed_http_${status} on round ${i + 1}`);
      const emb = body?.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error(`shadow_smoke_bad_embedding on round ${i + 1}`);
      }
      const finite = emb.every((x) => Number.isFinite(x));
      if (!finite) throw new Error(`shadow_smoke_non_finite_embedding on round ${i + 1}`);
      trials.push({ round: i + 1, latency_ms: Date.now() - t0, dim: emb.length });
    }
  }
  return trials;
}

// -- Daemon operations ------------------------------------------------------

async function daemonHealth(spec) {
  const url = `${spec.daemon_base}${spec.healthz_path}`;
  const { ok, status, body } = await httpJson(url, { method: "GET", timeoutMs: 4000 });
  if (!ok) throw new Error(`daemon_healthz_${status}`);
  return body || {};
}

async function daemonCurrentModel(spec) {
  const h = await daemonHealth(spec);
  const candidates = [h?.[spec.model_field], h?.active_model, h?.model];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  // Fall through — embedder reports model under stats().model
  if (h?.stats && typeof h.stats.model === "string") return h.stats.model;
  return null;
}

async function daemonFlip(spec, tag) {
  const url = `${spec.daemon_base}${spec.swap_endpoint}`;
  const { ok, status, body } = await httpJson(url, {
    method: "POST",
    body: spec.swap_body(tag),
    timeoutMs: 10_000,
  });
  if (!ok) throw new Error(`daemon_flip_http_${status}: ${JSON.stringify(body)?.slice(0, 256)}`);
  return body || { ok: true };
}

/**
 * Post-flip smoke: hit the daemon (NOT raw Ollama) and confirm it now reports
 * the new active tag and answers a real request. This is what proves the alias
 * truly flipped without restart.
 */
async function smokeDaemon(spec, expectedTag) {
  const current = await daemonCurrentModel(spec);
  if (current !== expectedTag) {
    throw new Error(`daemon_active_model_mismatch: expected=${expectedTag} got=${current ?? "<null>"}`);
  }
  // One real round-trip through the daemon's primary endpoint, by target kind.
  if (spec.id === "classifier") {
    const { ok, status, body } = await httpJson(`${spec.daemon_base}/classify`, {
      method: "POST",
      body: { origin: "receipt.hot.swap.smoke", event_metadata: { probe: true } },
      timeoutMs: 8_000,
    });
    if (!ok) throw new Error(`classifier_post_flip_smoke_http_${status}`);
    if (!body || typeof body.lane !== "string") throw new Error("classifier_post_flip_smoke_bad_body");
    return { round_trip: "classify", lane: body.lane, source: body.source };
  }
  if (spec.id === "embedder") {
    const { ok, status, body } = await httpJson(`${spec.daemon_base}/embed`, {
      method: "POST",
      body: { text: "hot-swap post-flip smoke" },
      timeoutMs: 30_000,
    });
    if (!ok) throw new Error(`embedder_post_flip_smoke_http_${status}`);
    if (!body || !Array.isArray(body.embedding) || body.embedding.length === 0) {
      throw new Error("embedder_post_flip_smoke_bad_embedding");
    }
    return { round_trip: "embed", dim: body.embedding.length };
  }
  if (spec.id === "fallback-chat") {
    // Chat fallback gates /chat on activation. Health check alone is enough to
    // prove the alias flipped; we already verified the model field above.
    return { round_trip: "healthz_only", note: "activation-gated; healthz confirms tag" };
  }
  return { round_trip: "none" };
}

// -- Orchestrator -----------------------------------------------------------

/**
 * Perform a hot-swap. Returns a detailed record. Throws on unrecoverable
 * failure (after attempting rollback if a "from" tag is known).
 *
 * opts:
 *   target         — "classifier" | "embedder" | "fallback-chat"
 *   to             — new stock tag (required unless rollback=true)
 *   from           — current tag (optional; auto-discovered)
 *   smokeRounds    — pre-flip smoke iterations (default 3)
 *   drainMs        — sleep between flip and final receipt write (default 5000)
 *   dryRun         — do PRELUDE/PULL/SHADOW/SMOKE only, no flip
 *   rollback       — flip BACK to the last successful "from" recorded in receipts
 */
export async function hotSwap(opts) {
  const spec = TARGETS[opts.target];
  if (!spec) throw new Error(`unknown_target: ${opts.target}`);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // PRELUDE -----------------------------------------------------------------
  const health = await daemonHealth(spec);
  const currentModel = await daemonCurrentModel(spec);
  const from = opts.from || currentModel || null;

  let to = opts.to || null;
  if (opts.rollback) {
    const last = await lastSuccessfulReceiptFor(spec.id);
    if (!last) throw new Error("rollback_no_previous_receipt");
    // Rollback means: flip from current back to whatever "from" the last
    // successful swap captured (i.e., the tag that was running BEFORE that swap).
    to = last.from;
    log("info", "rollback_target_resolved", { from: currentModel, to });
  }
  if (!to) throw new Error("missing_to_tag");
  if (!STOCK_TAG_RE.test(to)) throw new Error(`non_stock_tag_rejected: ${to}`);

  log("info", "prelude_ok", { target: spec.id, from, to, dry_run: !!opts.dryRun, health_status: health?.status });

  if (from && from === to && !opts.rollback) {
    log("warn", "noop_same_tag", { tag: to });
    const record = {
      ts: startedAt,
      target: spec.id,
      from,
      to,
      outcome: "noop_same_tag",
      elapsed_ms: Date.now() - t0,
    };
    await writeReceipt(record);
    return record;
  }

  // PULL --------------------------------------------------------------------
  // Skip pull if the tag is already present — Ollama no-ops anyway, but we
  // can save the round trip when re-running.
  const alreadyPresent = await isTagPresent(to);
  if (alreadyPresent) {
    log("info", "pull_skipped_tag_present", { tag: to });
  } else {
    log("info", "pull_begin", { tag: to });
    await ollamaPull(to, {
      onProgress: (p) => {
        if (p?.status && p.status !== "downloading") {
          log("debug", "pull_progress", { status: p.status });
        }
      },
    });
    log("info", "pull_complete", { tag: to });
  }

  // SHADOW LOAD -------------------------------------------------------------
  log("info", "shadow_load_begin", { tag: to });
  await ollamaShadowLoad(spec, to);
  log("info", "shadow_load_complete", { tag: to });

  // SMOKE (pre-flip) --------------------------------------------------------
  const rounds = opts.smokeRounds ?? DEFAULT_SMOKE_ROUNDS;
  log("info", "smoke_shadow_begin", { tag: to, rounds });
  const shadowSmoke = await smokeShadow(spec, to, rounds);
  log("info", "smoke_shadow_complete", { tag: to, trials: shadowSmoke });

  if (opts.dryRun) {
    const record = {
      ts: startedAt,
      target: spec.id,
      from,
      to,
      outcome: "dry_run_ok",
      shadow_smoke: shadowSmoke,
      elapsed_ms: Date.now() - t0,
    };
    log("info", "dry_run_complete", record);
    await writeReceipt(record);
    return record;
  }

  // FLIP ALIAS --------------------------------------------------------------
  let flipResult;
  try {
    log("info", "flip_begin", { target: spec.id, to });
    flipResult = await daemonFlip(spec, to);
    log("info", "flip_complete", { target: spec.id, to, daemon_reply: flipResult });
  } catch (err) {
    // Flip itself failed BEFORE the alias moved. The daemon refused the swap
    // (e.g., not in its tag list). No rollback necessary because nothing
    // changed; just surface the failure with a receipt.
    const record = {
      ts: startedAt,
      target: spec.id,
      from,
      to,
      outcome: "flip_failed",
      error: String(err?.message || err),
      elapsed_ms: Date.now() - t0,
    };
    await writeReceipt(record);
    throw err;
  }

  // POST-FLIP SMOKE ---------------------------------------------------------
  try {
    log("info", "smoke_daemon_begin", { target: spec.id, to });
    const postSmoke = await smokeDaemon(spec, to);
    log("info", "smoke_daemon_complete", { target: spec.id, to, result: postSmoke });

    // DRAIN -----------------------------------------------------------------
    const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
    if (drainMs > 0) {
      log("info", "drain_begin", { drain_ms: drainMs });
      await new Promise((r) => setTimeout(r, drainMs));
      log("info", "drain_complete", {});
    }

    const record = {
      ts: startedAt,
      target: spec.id,
      from,
      to,
      outcome: "success",
      shadow_smoke: shadowSmoke,
      post_flip_smoke: postSmoke,
      drain_ms: drainMs,
      rollback: !!opts.rollback,
      elapsed_ms: Date.now() - t0,
    };
    await writeReceipt(record);
    return record;
  } catch (postErr) {
    // The alias DID move but post-flip behavior is bad. Attempt to flip back
    // to "from" if we have it. If rollback itself fails, we surface both errors.
    log("error", "post_flip_smoke_failed", { error: String(postErr?.message || postErr) });
    let rollbackOutcome = "skipped_no_from";
    let rollbackError = null;
    if (from && STOCK_TAG_RE.test(from)) {
      try {
        log("warn", "auto_rollback_begin", { from_current: to, to_previous: from });
        await daemonFlip(spec, from);
        rollbackOutcome = "rolled_back";
        log("warn", "auto_rollback_complete", { restored: from });
      } catch (rbErr) {
        rollbackOutcome = "rollback_failed";
        rollbackError = String(rbErr?.message || rbErr);
        log("error", "auto_rollback_failed", { error: rollbackError });
      }
    }
    const record = {
      ts: startedAt,
      target: spec.id,
      from,
      to,
      outcome: "post_flip_failed",
      post_flip_error: String(postErr?.message || postErr),
      rollback_outcome: rollbackOutcome,
      rollback_error: rollbackError,
      shadow_smoke: shadowSmoke,
      elapsed_ms: Date.now() - t0,
    };
    await writeReceipt(record);
    const composite = new Error(
      `post_flip_failed (${record.post_flip_error}); rollback=${rollbackOutcome}` +
        (rollbackError ? ` (${rollbackError})` : "")
    );
    composite.record = record;
    throw composite;
  }
}

// -- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) {
      out[raw.slice(2)] = true;
    } else {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return out;
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node hot-swap.mjs --target=<classifier|embedder|fallback-chat> \\",
      "                    --to=<stock_tag> [--from=<current_tag>] \\",
      "                    [--smoke-rounds=<n>] [--drain-ms=<n>] [--dry-run]",
      "  node hot-swap.mjs --target=<...> --rollback",
      "",
      "Env:",
      "  N150_OLLAMA_BASE              (default http://127.0.0.1:11434)",
      "  N150_CLASSIFIER_BASE          (default http://127.0.0.1:7480)",
      "  N150_EMBEDDER_BASE            (default http://127.0.0.1:8798)",
      "  N150_FALLBACK_CHAT_BASE       (default http://127.0.0.1:8799)",
      "  N150_HOT_SWAP_LOG_LEVEL       trace|debug|info|warn|error (default info)",
      "",
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) { usage(); process.exit(0); }
  const target = args.target;
  if (!target || !TARGETS[target]) {
    process.stderr.write(`error: --target must be one of ${Object.keys(TARGETS).join(", ")}\n`);
    usage();
    process.exit(2);
  }
  const opts = {
    target,
    to: args.to ? String(args.to) : null,
    from: args.from ? String(args.from) : null,
    smokeRounds: args["smoke-rounds"] ? parseInt(args["smoke-rounds"], 10) : undefined,
    drainMs: args["drain-ms"] ? parseInt(args["drain-ms"], 10) : undefined,
    dryRun: !!args["dry-run"],
    rollback: !!args.rollback,
  };
  try {
    const record = await hotSwap(opts);
    // Clean stdout = the receipt. Operators can pipe it to jq.
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");
    process.exit(record.outcome === "success" || record.outcome === "dry_run_ok" || record.outcome === "noop_same_tag" ? 0 : 1);
  } catch (err) {
    process.stderr.write(`[hot-swap] FAILED: ${err?.message || err}\n`);
    if (err?.record) process.stdout.write(JSON.stringify(err.record, null, 2) + "\n");
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const argvPath = resolve(process.argv[1]).toLowerCase().replace(/\\/g, "/");
    const selfPath = resolve(__filename).toLowerCase().replace(/\\/g, "/");
    return argvPath === selfPath;
  } catch { return false; }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[hot-swap] uncaught: ${err?.message || err}\n`);
    process.exit(1);
  });
}
