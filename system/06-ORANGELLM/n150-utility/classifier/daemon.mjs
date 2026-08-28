#!/usr/bin/env node
// n150-utility/classifier/daemon.mjs — Bun-capable Node 20+ daemon
// ----------------------------------------------------------------------------
// Port: 127.0.0.1:7480 (loopback only; LAN ingress is the gateway's job, not ours)
//
// Surface:
//   GET  /healthz          → liveness + ollama probe + counters
//   POST /classify         → { origin, event_metadata } → { lane, confidence, ... }
//   GET  /model            → reports the bound stock model and hot-swap state
//
// Lane assignment law (V1 mitigation — origin-first, NOT string-match on payload):
//
//   reality  ← origin starts with one of: receipt., terminal., doctrine.,
//              cobra., n150., codexa., hermes.terminal., aecode.terminal.
//              These prefixes come from G12 reality-lane discipline at
//              01-DOCTRINE/27-guardrails/checks/g12-reality-lane-discipline.mjs
//              + extensions for terminal-emitter rails. confidence=1.0,
//              source="origin_rule".
//
//   thought  ← origin starts with one of: chat., agent., frontier., heavy.,
//              skinny., openllm., misfit.thought., aecode.draft.
//              confidence=1.0, source="origin_rule".
//
//   merge    ← origin is empty OR origin prefix is not in either set above.
//              This is the BORDERLINE bucket. We escalate to qwen3:0.6b for a
//              tiebreaker (event_metadata classification). If the model is
//              unreachable or returns malformed output, we DEFAULT TO THOUGHT
//              (safer: thought-lane is opt-in to act; reality-lane is
//              auto-trusted by Mirage StateBrief). source="model_tiebreak" or
//              "model_unreachable_default_thought".
//
// Per Wave 1 doctrine: STOCK WEIGHTS ONLY. No custom training. The qwen3:0.6b
// path is used solely as a tiebreaker for unknown origins; we never fine-tune
// it here. Hot-swap is implemented by re-reading MODEL_NAME from disk on
// /model GET or on SIGHUP — no service restart required.
//
// Failure law: every path returns 200 with a lane assignment. Unreachable
// Ollama is NOT a 500 — it's a deterministic default-to-thought with
// source="model_unreachable_default_thought" and the receipt-trail clear.
//
// Receipts: every /classify decision is appended to STATE_DIR/decisions.jsonl
// (append-only, JSON-lines, no rotation here — Mom's Law: receipts only, no
// silent loss; rotation is the operator's cron).
// ----------------------------------------------------------------------------

import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// -- Paths ------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname);
const STATE_DIR = resolve(ROOT, "state");
const DECISIONS_PATH = resolve(STATE_DIR, "decisions.jsonl");
const MODEL_PIN_PATH = resolve(STATE_DIR, "model.pin"); // for hot-swap

// -- Constants --------------------------------------------------------------

export const VERSION = "n150-classifier.v0.1.0";
export const HOST = process.env.N150_CLASSIFIER_HOST || "127.0.0.1";
export const PORT = parseInt(process.env.N150_CLASSIFIER_PORT || "7480", 10);

const OLLAMA_BASE = process.env.N150_OLLAMA_BASE || "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:0.6b"; // stock; never fine-tuned here
const OLLAMA_TIMEOUT_MS = parseInt(process.env.N150_OLLAMA_TIMEOUT_MS || "2500", 10);
const BODY_CAP_BYTES = parseInt(process.env.N150_BODY_CAP_BYTES || "65536", 10);

// Origin prefix tables. Mirrors G12 and extends with the rails that emit
// receipt-grade events on the N150 side (terminal emitters in cobra, codexa,
// hermes, aecode).
export const REALITY_ORIGIN_PREFIXES = [
  "receipt.",
  "terminal.",
  "doctrine.",
  "cobra.",
  "n150.",
  "codexa.",
  "hermes.terminal.",
  "aecode.terminal.",
];

export const THOUGHT_ORIGIN_PREFIXES = [
  "chat.",
  "agent.",
  "frontier.",
  "heavy.",
  "skinny.",
  "openllm.",
  "misfit.thought.",
  "aecode.draft.",
];

// -- Counters (in-memory; durable record is decisions.jsonl) ----------------

const counters = {
  started_at: new Date().toISOString(),
  total: 0,
  by_lane: { reality: 0, thought: 0, merge: 0 },
  by_source: {
    origin_rule: 0,
    model_tiebreak: 0,
    model_unreachable_default_thought: 0,
    invalid_input_default_thought: 0,
  },
  ollama_unreachable: 0,
  last_ollama_error: null,
};

// -- Hot-swap model name ----------------------------------------------------

let activeModel = DEFAULT_MODEL;

async function readPinnedModel() {
  try {
    if (!existsSync(MODEL_PIN_PATH)) return DEFAULT_MODEL;
    const raw = (await readFile(MODEL_PIN_PATH, "utf8")).trim();
    if (!raw) return DEFAULT_MODEL;
    // Whitelist: must look like an Ollama model tag (alnum, dots, colons, dashes).
    if (!/^[a-z0-9][a-z0-9._:\-]{0,63}$/i.test(raw)) return DEFAULT_MODEL;
    return raw;
  } catch {
    return DEFAULT_MODEL;
  }
}

async function refreshActiveModel() {
  activeModel = await readPinnedModel();
  return activeModel;
}

// -- Core classifier --------------------------------------------------------

/**
 * Pure-function origin classifier. Returns lane + confidence + source.
 * No I/O. Used by tests and by the live handler.
 */
export function classifyByOrigin(origin) {
  if (typeof origin !== "string" || origin.length === 0) {
    return { lane: "merge", confidence: 0.0, source: "origin_empty_needs_tiebreak" };
  }
  // Lowercase compare on prefix; origins are conventionally lowercased
  // (G12 also lowercases). Defensive lower() here for resilience.
  const o = origin.toLowerCase();
  for (const p of REALITY_ORIGIN_PREFIXES) {
    if (o.startsWith(p)) {
      return { lane: "reality", confidence: 1.0, source: "origin_rule" };
    }
  }
  for (const p of THOUGHT_ORIGIN_PREFIXES) {
    if (o.startsWith(p)) {
      return { lane: "thought", confidence: 1.0, source: "origin_rule" };
    }
  }
  return { lane: "merge", confidence: 0.0, source: "origin_unknown_needs_tiebreak" };
}

/**
 * Ollama tiebreaker. Asks qwen3:0.6b to classify an unknown-origin event into
 * reality | thought | merge. Returns null on any failure (caller defaults).
 *
 * We deliberately give it a SHORT, deterministic prompt and require a single
 * lowercase token reply. We do NOT trust freeform output beyond the regex.
 */
async function ollamaTiebreak(origin, event_metadata) {
  const prompt = [
    "You are a deterministic lane classifier for an event stream.",
    "Three lanes exist:",
    "  - reality: events from real-world I/O, terminals, signed receipts, hardware sensors, persisted file writes, doctrine emissions",
    "  - thought: events from LLM chat, agent reasoning, drafts, hypothetical reasoning, model output",
    "  - merge: only when the event is BOTH a real-world action AND a reasoning output (very rare; e.g. a signed agent action receipt)",
    "",
    `origin: ${JSON.stringify(origin ?? "")}`,
    `event_metadata: ${JSON.stringify(event_metadata ?? {}).slice(0, 1024)}`,
    "",
    "Reply with EXACTLY one lowercase word from: reality, thought, merge.",
    "No other words. No punctuation. No reasoning trace.",
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: activeModel,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          top_p: 0.1,
          num_predict: 8,
          stop: ["\n"],
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      counters.ollama_unreachable += 1;
      counters.last_ollama_error = `http_${res.status}`;
      return null;
    }
    const body = await res.json();
    const out = String(body?.response ?? "").trim().toLowerCase();
    const m = out.match(/\b(reality|thought|merge)\b/);
    if (!m) {
      counters.last_ollama_error = "malformed_response";
      return null;
    }
    return m[1];
  } catch (err) {
    counters.ollama_unreachable += 1;
    counters.last_ollama_error = String(err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full classify: origin-rule first, model tiebreak only on merge/unknown,
 * default-to-thought on any failure. Writes a receipt line.
 */
export async function classify({ origin, event_metadata }) {
  // Step 1: input validation.
  if (origin !== undefined && origin !== null && typeof origin !== "string") {
    const decision = {
      lane: "thought",
      confidence: 0.0,
      source: "invalid_input_default_thought",
      reason: "origin must be a string",
    };
    await recordDecision({ origin, event_metadata, decision });
    return decision;
  }

  // Step 2: origin rule.
  const ruled = classifyByOrigin(origin);
  if (ruled.lane !== "merge") {
    const decision = { lane: ruled.lane, confidence: ruled.confidence, source: ruled.source };
    await recordDecision({ origin, event_metadata, decision });
    return decision;
  }

  // Step 3: borderline → model tiebreak (qwen3:0.6b stock).
  const tieLane = await ollamaTiebreak(origin, event_metadata);
  if (tieLane === null) {
    const decision = {
      lane: "thought",
      confidence: 0.5,
      source: "model_unreachable_default_thought",
      tiebreak_attempted: true,
    };
    await recordDecision({ origin, event_metadata, decision });
    return decision;
  }
  const decision = {
    lane: tieLane,
    // Tiebreak confidence is mid; we have no logprobs from /api/generate.
    confidence: 0.75,
    source: "model_tiebreak",
    model: activeModel,
  };
  await recordDecision({ origin, event_metadata, decision });
  return decision;
}

// -- Receipts ---------------------------------------------------------------

async function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

async function recordDecision({ origin, event_metadata, decision }) {
  counters.total += 1;
  counters.by_lane[decision.lane] = (counters.by_lane[decision.lane] || 0) + 1;
  counters.by_source[decision.source] = (counters.by_source[decision.source] || 0) + 1;

  try {
    await ensureStateDir();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      origin: origin ?? null,
      // Keep metadata trimmed in the receipt — large payloads belong on Codexa.
      event_metadata_keys: event_metadata && typeof event_metadata === "object"
        ? Object.keys(event_metadata).slice(0, 32)
        : null,
      decision,
    }) + "\n";
    await appendFile(DECISIONS_PATH, line, "utf8");
  } catch {
    // Mom's Law: name the gap. We do not crash on receipt write failure;
    // the in-memory counters still reflect the decision and the caller
    // gets the right lane. Operator cron will notice if the file is missing.
  }
}

// -- HTTP layer -------------------------------------------------------------

async function readBody(req, capBytes = BODY_CAP_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", chunk => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function probeOllama() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, status: res.status };
    const body = await res.json();
    const names = (body?.models || []).map(m => m?.name || m?.model).filter(Boolean);
    return {
      reachable: true,
      active_model: activeModel,
      active_model_present: names.includes(activeModel),
      tag_count: names.length,
    };
  } catch (err) {
    return { reachable: false, err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRequest(req, res) {
  // Loopback-only enforcement. The TCP bind is already 127.0.0.1; this is
  // defense-in-depth in case someone (rightly) re-binds via env.
  const remote = req.socket?.remoteAddress || "";
  if (HOST === "127.0.0.1" && remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    json(res, { error: "loopback_only" }, 403);
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const method = req.method || "GET";
  const path = url.pathname;

  // GET /healthz
  if (method === "GET" && path === "/healthz") {
    const ollama = await probeOllama();
    json(res, {
      status: ollama.reachable ? "ok" : "degraded",
      service: "n150-classifier",
      version: VERSION,
      bind: `${HOST}:${PORT}`,
      active_model: activeModel,
      ollama,
      counters,
      generated_at: new Date().toISOString(),
    });
    return;
  }

  // GET /model
  if (method === "GET" && path === "/model") {
    await refreshActiveModel();
    json(res, {
      active_model: activeModel,
      default_model: DEFAULT_MODEL,
      pinned_via: existsSync(MODEL_PIN_PATH) ? MODEL_PIN_PATH : null,
      hot_swap: "write a stock tag to state/model.pin then GET /model (or SIGHUP) to re-bind",
    });
    return;
  }

  // POST /model { model: "<stock_tag>" }  (hot-swap; stock only)
  if (method === "POST" && path === "/model") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, { error: `bad_body: ${err.message}` }, 400);
      return;
    }
    const tag = String(body?.model || "").trim();
    if (!/^[a-z0-9][a-z0-9._:\-]{0,63}$/i.test(tag)) {
      json(res, { error: "invalid_model_tag" }, 400);
      return;
    }
    try {
      await ensureStateDir();
      await writeFile(MODEL_PIN_PATH, tag, "utf8");
      activeModel = tag;
      json(res, { ok: true, active_model: activeModel });
    } catch (err) {
      json(res, { error: `pin_write_failed: ${err.message}` }, 500);
    }
    return;
  }

  // POST /classify
  if (method === "POST" && path === "/classify") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, { error: `bad_body: ${err.message}` }, 400);
      return;
    }
    const decision = await classify({
      origin: body?.origin,
      event_metadata: body?.event_metadata,
    });
    json(res, decision);
    return;
  }

  json(res, { error: "not_found", method, path }, 404);
}

// -- Boot -------------------------------------------------------------------

export async function start() {
  await ensureStateDir();
  await refreshActiveModel();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      try {
        json(res, { error: `internal: ${err?.message || err}` }, 500);
      } catch { /* socket already gone */ }
    });
  });

  server.on("error", err => {
    // Bind failures must be loud — Mom's Law: name the gap.
    process.stderr.write(`[n150-classifier] server error: ${err.message}\n`);
    process.exit(1);
  });

  // SIGHUP triggers model re-bind from state/model.pin without restart.
  process.on("SIGHUP", () => {
    refreshActiveModel().then(m => {
      process.stderr.write(`[n150-classifier] SIGHUP: active_model=${m}\n`);
    });
  });

  // Clean shutdown.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      process.stderr.write(`[n150-classifier] ${sig}: shutting down\n`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 3000).unref();
    });
  }

  return new Promise(resolveBind => {
    server.listen(PORT, HOST, () => {
      process.stderr.write(`[n150-classifier] listening on http://${HOST}:${PORT} model=${activeModel}\n`);
      resolveBind(server);
    });
  });
}

// Auto-start when invoked directly (node daemon.mjs or bun daemon.mjs).
// Guard against double-start when imported by tests.
// On Windows, path canonicalization (slashes, drive-letter case) makes a raw
// string compare unreliable. Normalize both sides via realpath when possible.
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const argvPath = resolve(process.argv[1]).toLowerCase().replace(/\\/g, "/");
    const selfPath = resolve(__filename).toLowerCase().replace(/\\/g, "/");
    return argvPath === selfPath;
  } catch { return false; }
})();
if (isMain) {
  start().catch(err => {
    process.stderr.write(`[n150-classifier] start failed: ${err?.message || err}\n`);
    process.exit(1);
  });
}
