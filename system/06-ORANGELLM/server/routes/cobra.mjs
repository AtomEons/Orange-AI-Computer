// AE OrangeLLM — Æ Cobra gateway routes
// Path: 06-ORANGELLM/server/routes/cobra.mjs
//
// Doctrine:
//   - Æ Cobra is the AtomEons memory daemon: Mamba 2.8B Q5_K_M GGUF, built
//     with llama.cpp inside WSL2 on Codexa, GBNF-locked to the AgentTurn
//     JSON shape declared in memory/ae-cobra/grammar/agent_turn.gbnf and
//     mirrored in memory/ae-cobra/schemas/agent-turn.schema.json. The
//     belt-and-suspenders parser-layer validator lives at
//     memory/ae-cobra/grammar/validator.mjs.
//   - The active daemon listens on N150 loopback at 127.0.0.1:7419. Local
//     memory IPC stays local. Cobra model work enters OrangeBrain, whose
//     cross-computer leases use authenticated AE Phase exclusively.
//   - Rail-token auth is enforced HERE (in the handlers), not in the main
//     boundary. The main boundary cannot do it because the token must be
//     read at request time from the rail-token-watcher singleton (the
//     file rotates without a gateway restart).
//   - Mom's Law: receipts only, no theater. No silent fall-back to
//     anonymous. No retry-without-auth. No swallowing daemon errors. If
//     the daemon is down we say so with the exact upstream status.
//
// Routes:
//   POST /v1/cobra/turn        — proxy to daemon /completion with GBNF.
//                                Body: { prompt: string, lane?: "reality"
//                                | "thought" | "merge", max_tokens?: int,
//                                temperature?: float }. Returns the parsed
//                                AgentTurn JSON plus daemon timing and the
//                                Flux append result (if the daemon wrote).
//   GET  /v1/cobra/healthz     — daemon health: model loaded, ctx-size,
//                                mlock, Flux lanes reachable, prior-sha
//                                chain unbroken (last verified). This is
//                                the read-only summary the cockpit shows.
//   GET  /v1/cobra/flux/tail   — read-only tail of the canonical daily
//                                Reality and Thought JSONL ledgers.
//                                Query: ?lane=reality|thought|both
//                                (default: both), ?n=1..200 (default: 50).
//                                Merged in append order. No write surface.
//
// HTTP shape (mirrors sibling routes guardrails.mjs / receipts.mjs):
//   Success: { ...payload }
//   Error:   { error: { code, message, ... }, _ae_http_status: N }

import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateAgentTurn } from "../../memory/ae-cobra/grammar/validator.mjs";
import { canonicalFluxRoot } from "../../memory/ae-cobra/paths.mjs";
import {
  getToken,
  getTokenFingerprint,
  isDisabled as railIsDisabled,
} from "../middleware/rail-token-watcher.mjs";
import {
  COBRA_ALLOWED,
  isCobraRouteAllowed,
  isCobraPath,
  RAIL_TOKEN_HEADER,
} from "./cobra-boundary.mjs";

export { COBRA_ALLOWED, isCobraRouteAllowed, isCobraPath };

// ---------------------------------------------------------------------------
// Config — env-bound, never hardcoded secrets.
// ---------------------------------------------------------------------------

const DAEMON_URL = (process.env.AE_COBRA_DAEMON_URL || "http://127.0.0.1:7419").replace(/\/+$/, "");
const DAEMON_TIMEOUT_MS = clampInt(process.env.AE_COBRA_TIMEOUT_MS, 30_000, 1_000, 120_000);

// Flux lanes are daily JSONL directories in the canonical on-disk ledger.
// Explicit env values may still point at a single JSONL file for compatibility.
const FLUX_ROOT = canonicalFluxRoot();
const FLUX_REALITY_PATH = process.env.AE_FLUX_REALITY || join(FLUX_ROOT, "events", "reality");
const FLUX_THOUGHT_PATH = process.env.AE_FLUX_THOUGHT || join(FLUX_ROOT, "events", "thought");

// 14-point activation gate — published constants the cockpit reads off
// /v1/cobra/healthz so it can render the badge without doing math.
const GATE_CTX_MAX = 1024;
const GATE_RSS_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
const GATE_TTFT_MAX_MS = 5_000;
const GATE_JSON_VALIDITY_MIN = 0.95;

// ---------------------------------------------------------------------------
// HTTP shape helpers (mirror guardrails.mjs)
// ---------------------------------------------------------------------------

function ok(body) { return body; }

function err(status, code, message, extra = {}) {
  return {
    error: { code, message, ...extra },
    _ae_http_status: status,
  };
}

function clampInt(raw, fallback, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

// ---------------------------------------------------------------------------
// Rail-token gate
// ---------------------------------------------------------------------------
//
// The rail-token-watcher singleton owns the in-memory token. We compare it
// (constant-time) against the value presented in the x-ae-rail-token
// header. Fail-closed: if the watcher is disabled (kill-switch) or has no
// token loaded, every Cobra request is denied. No anonymous lane.

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function presentedFingerprint(presented) {
  if (typeof presented !== "string" || presented.length === 0) return null;
  return createHash("sha256").update(presented).digest("hex").slice(0, 12);
}

function checkRail(headers) {
  if (railIsDisabled()) {
    return {
      ok: false,
      status: 503,
      reason: "rail_token_disabled",
      detail: "ORANGEBOX_RAIL_DISABLED=1 latched at watcher start. Cobra surface is fail-closed.",
    };
  }
  const accepted = getToken();
  if (!accepted) {
    return {
      ok: false,
      status: 503,
      reason: "rail_token_unset",
      detail: "No rail token loaded by watcher. Cobra surface is fail-closed until rotation lands a valid token.",
    };
  }
  const presented = headers?.[RAIL_TOKEN_HEADER];
  if (!presented || typeof presented !== "string") {
    return {
      ok: false,
      status: 401,
      reason: "rail_token_missing",
      detail: `Missing header: ${RAIL_TOKEN_HEADER}`,
    };
  }
  if (!constantTimeEqual(presented, accepted)) {
    return {
      ok: false,
      status: 401,
      reason: "rail_token_mismatch",
      detail: "Presented rail token did not match the watcher's accepted token.",
      presented_fp: presentedFingerprint(presented),
      accepted_fp: getTokenFingerprint(),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fetch with timeout — mirrors upstream.mjs pattern.
// ---------------------------------------------------------------------------

async function fetchLocalCobra(path, options, timeoutMs = DAEMON_TIMEOUT_MS) {
  const started = performance.now();
  const response = await fetch(`${DAEMON_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, elapsed_ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------
// POST /v1/cobra/turn
// ---------------------------------------------------------------------------
//
// Body:
//   {
//     prompt: string,                       // required, 1..16384 chars
//     lane?: "reality" | "thought" | "merge",  // hint; daemon decides
//     max_tokens?: int (1..512, default 256),
//     temperature?: float (0..2, default 0.2),
//     stop?: string[] (max 4 items, max 32 chars each)
//   }
//
// Behavior:
//   1. Rail-token gate (fail-closed).
//   2. Body validation (size cap, type checks).
//   3. Call the N150-local Cobra memory organ. Any model work requested by
//      Cobra crosses OrangeBrain and therefore AE Phase; local IPC stays local.
//   4. Parse JSON. Run validateAgentTurn() (parser-layer belt-and-
//      suspenders). If invalid, return 502 with the validator errors —
//      DO NOT pass invalid AgentTurn through to callers and DO NOT
//      pretend the call succeeded.
//   5. Return the validated AgentTurn, daemon timing, and any Flux
//      append metadata the daemon surfaced (prior_sha256, new_sha256).
//
// What this route does NOT do:
//   - It does not write to Flux. The daemon owns the hash-chain append.
//   - It does not stream. Night-1 is one-shot completion only. Streaming
//     is out of scope until the GBNF + validator interplay is exercised
//     under load.
//   - It does not retry on validation failure. A drift past the grammar
//     is a real incident; the daemon's healthz and smoke-test catch it.

export async function handleCobraTurn(body, headers) {
  const gate = checkRail(headers);
  if (!gate.ok) {
    return err(gate.status, "rail_gate_denied", gate.detail, { reason: gate.reason });
  }

  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object.");
  }
  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return err(400, "missing_prompt", "Body.prompt must be a non-empty string.");
  }
  if (prompt.length > 16384) {
    return err(413, "prompt_too_large", `prompt must be <= 16384 chars; got ${prompt.length}.`);
  }

  const lane = body.lane;
  if (lane != null && !["reality", "thought", "merge"].includes(lane)) {
    return err(422, "invalid_lane", "lane must be one of: reality, thought, merge.");
  }

  const max_tokens = clampInt(body.max_tokens, 256, 1, 512);
  const temperature = (() => {
    const t = Number(body.temperature);
    if (!Number.isFinite(t)) return 0.2;
    return Math.min(Math.max(t, 0), 2);
  })();

  let stop = [];
  if (Array.isArray(body.stop)) {
    stop = body.stop
      .filter(s => typeof s === "string" && s.length > 0 && s.length <= 32)
      .slice(0, 4);
  }

  // The daemon side is expected to apply the GBNF via --grammar-file at
  // boot (see memory/ae-cobra/bin/start.sh), so we do not need to ship
  // the grammar in every request. We DO pass a lane hint via the body so
  // the daemon can route Reality vs Thought appends accordingly.
  const origin = lane === "reality"
    ? "operator"
    : lane === "merge"
      ? "merge_synthesis"
      : "orangellm_reasoning";
  const upstreamBody = {
    origin,
    fallback_lane: lane || "thought",
    event: {
      event_type: "observation",
      summary: prompt,
      entities: [],
      files: [],
      commands: [],
      risk: "low",
      next_action: "Return the governed AgentTurn to OrangeLLM.",
      confidence: 1,
      generation: { max_tokens, temperature, stop },
    },
  };

  let upstream;
  try {
    upstream = await fetchLocalCobra("/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    const reason = /timed out/i.test(String(e?.message || e)) ? "daemon_timeout" : "daemon_unreachable";
    return err(504, reason, `Æ Cobra daemon at ${DAEMON_URL} ${reason}: ${String(e?.message || e)}`);
  }

  const { response, elapsed_ms } = upstream;
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok || parsed.accepted === false) {
    return err(response.ok ? 422 : 502, parsed?.reason || "daemon_http_error", parsed?.error || `Daemon returned ${response.status}`, {
      upstream_status: response.status,
      upstream_body: parsed,
      elapsed_ms,
    });
  }

  const agentTurn = parsed.agent_turn;
  const flux = { id: parsed.id || null, lane: parsed.lane || agentTurn?.lane || null, accepted: true };

  // Parser-layer belt-and-suspenders. The GBNF should have already made
  // this impossible to fail, but we check anyway — Mom's Law: receipts
  // only, no theater. If this fails, the daemon's grammar has drifted.
  const validation = validateAgentTurn(agentTurn);
  if (!validation.valid) {
    return err(502, "agent_turn_invalid",
      "Daemon emitted JSON that failed AgentTurn validation. GBNF drift suspected.",
      {
        validator_errors: validation.errors,
        elapsed_ms,
      });
  }

  // Latency receipt for the 14-point activation gate (ttft<5s on N150 cold).
  // We don't have token-level ttft from llama.cpp /completion in one-shot
  // mode, so we report end-to-end elapsed_ms with a boolean against the
  // cold-start budget. The smoke-test in memory/ae-cobra/smoke-test.mjs is
  // the authoritative TTFT measurement; this is observational only.
  const within_ttft_budget = elapsed_ms <= GATE_TTFT_MAX_MS;

  return ok({
    agent_turn: agentTurn,
    flux,
    daemon: {
      url: DAEMON_URL,
      elapsed_ms,
      within_ttft_budget,
      ttft_budget_ms: GATE_TTFT_MAX_MS,
      transport: "loopback-local",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /v1/cobra/healthz
// ---------------------------------------------------------------------------
//
// Probes the daemon's /health endpoint and returns a normalized summary
// for the cockpit. Surfaces the 14-point activation gate constants so the
// UI can render the badge without doing math.

export async function handleCobraHealthz(headers) {
  // Healthz is also gated. Otherwise the boundary lets unauthenticated
  // callers fingerprint the daemon's existence and ctx-size.
  const gate = checkRail(headers);
  if (!gate.ok) {
    return err(gate.status, "rail_gate_denied", gate.detail, { reason: gate.reason });
  }

  let probe;
  let elapsed_ms = null;
  let live = false;
  let daemon_payload = null;
  let probe_error = null;
  try {
    probe = await fetchLocalCobra("/healthz", { method: "GET" }, 3_000);
    elapsed_ms = probe.elapsed_ms;
    live = probe.response.ok;
    daemon_payload = await probe.response.json().catch(() => null);
    probe_error = live ? null : `HTTP ${probe.response.status}`;
  } catch (e) {
    probe_error = String(e?.message || e);
  }

  return ok({
    status: live ? "live" : "unreachable",
    daemon: {
      url: DAEMON_URL,
      live,
      elapsed_ms,
      payload: daemon_payload,
      error: probe_error,
      transport: "loopback-local",
    },
    flux: {
      reality_path: FLUX_REALITY_PATH,
      thought_path: FLUX_THOUGHT_PATH,
      storage: "canonical-daily-jsonl",
      note: "Flux liveness from the gateway side is approximate; the daemon owns writes. GET /v1/cobra/flux/tail verifies the current on-disk tail.",
    },
    activation_gate: {
      ctx_size_max: GATE_CTX_MAX,
      rss_max_bytes: GATE_RSS_MAX_BYTES,
      ttft_max_ms: GATE_TTFT_MAX_MS,
      json_validity_min: GATE_JSON_VALIDITY_MIN,
      note: "Operator's 14-point activation gate (memory/ae-cobra/activation/). The authoritative pass/fail is the runner output; these are published constants only.",
    },
    rail: {
      fingerprint: getTokenFingerprint(),
    },
    generated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// GET /v1/cobra/flux/tail
// ---------------------------------------------------------------------------
//
// Read-only tail of the Flux JSONL lanes. NO WRITE SURFACE.
//
// Query:
//   ?lane=reality|thought|both   (default: both)
//   ?n=1..200                    (default: 50; cap is 200 lines per lane
//                                  to keep gateway latency bounded)
//
// Behavior:
//   - Reads the last N lines of each requested lane.
//   - Each line is parsed as JSON. If a line fails to parse, it is
//     surfaced as a {error, raw} entry rather than dropped silently
//     (Mom's Law: never hide drift).
//   - When both lanes are requested, results are merged in time order
//     using the line's own "ts" field if present, else file append order.
//   - Reports prior_sha256 chain integrity: walks each lane's tail and
//     confirms every line's prior_sha256 equals the previous line's
//     own sha256 (computed over the canonical JSON string). Returns
//     chain_unbroken: true | false | "indeterminate" per lane.
//
// Why on the gateway: the cockpit needs a small, fast, auth-gated view
// of the hash-chained ledger without ever holding the rail token less
// than 1ms longer than necessary. The full Flux is consumed by Codexa-
// side jobs over Mirage, not over this surface.

export async function handleCobraFluxTail(url, headers) {
  const gate = checkRail(headers);
  if (!gate.ok) {
    return err(gate.status, "rail_gate_denied", gate.detail, { reason: gate.reason });
  }

  const laneParam = (url.searchParams.get("lane") || "both").toLowerCase();
  if (!["reality", "thought", "both"].includes(laneParam)) {
    return err(422, "invalid_lane",
      "lane must be one of: reality, thought, both.");
  }
  const n = clampInt(url.searchParams.get("n"), 50, 1, 200);

  const wantReality = laneParam === "reality" || laneParam === "both";
  const wantThought = laneParam === "thought" || laneParam === "both";

  const lanes = {};
  if (wantReality) lanes.reality = await tailLane(FLUX_REALITY_PATH, n, "reality");
  if (wantThought) lanes.thought = await tailLane(FLUX_THOUGHT_PATH, n, "thought");

  // Merged view (best-effort) when both lanes requested. Preserve per-lane
  // detail under .lanes so callers can pick what they want.
  let merged = null;
  if (wantReality && wantThought) {
    const all = [
      ...(lanes.reality.entries || []),
      ...(lanes.thought.entries || []),
    ];
    all.sort((a, b) => {
      const ta = a.parsed?.ts ?? a.line_no ?? 0;
      const tb = b.parsed?.ts ?? b.line_no ?? 0;
      if (typeof ta === "string" || typeof tb === "string") {
        return String(ta).localeCompare(String(tb));
      }
      return ta - tb;
    });
    merged = all.slice(-n);
  }

  return ok({
    requested: { lane: laneParam, n },
    lanes,
    merged,
    note: "Read-only tail. Writes go through the daemon, not this gateway.",
    generated_at: new Date().toISOString(),
  });
}

// Tail-N implementation for a daily-file lane directory or an explicit single
// JSONL file. Reads newest files first until N records are available.
export async function tailLane(path, n, laneName) {
  let fs;
  try {
    fs = await import("node:fs/promises");
  } catch (e) {
    return {
      lane: laneName,
      path,
      present: false,
      entries: [],
      chain_unbroken: "indeterminate",
      error: `fs import failed: ${String(e?.message || e)}`,
    };
  }
  let files;
  try {
    const source = await fs.stat(path);
    if (source.isFile()) {
      files = [path];
    } else if (source.isDirectory()) {
      files = (await fs.readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(path, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } else {
      files = [];
    }
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return {
        lane: laneName,
        path,
        present: false,
        entries: [],
        chain_unbroken: "indeterminate",
        note: "lane source not present (daemon may not have written yet)",
      };
    }
    return {
      lane: laneName,
      path,
      present: false,
      entries: [],
      chain_unbroken: "indeterminate",
      error: String(e?.message || e),
    };
  }

  if (!files.length) {
    return {
      lane: laneName,
      path,
      present: false,
      entries: [],
      chain_unbroken: "indeterminate",
      note: "lane source contains no JSONL files",
    };
  }

  const selected = [];
  let remaining = n;
  for (let index = files.length - 1; index >= 0 && remaining > 0; index--) {
    const file = files[index];
    const raw = await fs.readFile(file, { encoding: "utf8" });
    const lines = raw.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const start = Math.max(0, lines.length - remaining);
    selected.unshift(...lines.slice(start).map((line, offset) => ({
      file,
      line,
      line_no: start + offset + 1,
    })));
    remaining = n - selected.length;
  }

  const entries = selected.map(({ file, line, line_no }) => {
    try {
      const parsed = JSON.parse(line);
      const sha = createHash("sha256").update(line).digest("hex");
      return { file, line_no, parsed, sha256_of_line: sha };
    } catch (e) {
      return { file, line_no, error: "json_parse_failed", raw: line.slice(0, 500) };
    }
  });

  // Current Flux records chain declared `prev_hash` to the prior record's
  // declared `hash`. Legacy records may use `prior_sha256`, in which case we
  // compare with the prior raw-line digest. Verification is bounded to the
  // returned tail; older history is intentionally outside this endpoint.
  let chain_unbroken;
  if (entries.length < 2) {
    chain_unbroken = "indeterminate";
  } else {
    let unbroken = true;
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      const expected = cur.parsed?.prev_hash ?? cur.parsed?.prior_sha256;
      const actual = cur.parsed?.prev_hash !== undefined
        ? prev.parsed?.hash
        : prev.sha256_of_line;
      if (!expected || !actual || expected !== actual) {
        unbroken = false;
        break;
      }
    }
    chain_unbroken = unbroken;
  }

  return {
    lane: laneName,
    path,
    present: true,
    source_type: files.length === 1 && files[0] === path ? "file" : "daily-directory",
    files_available: files.length,
    files_read: [...new Set(selected.map((entry) => entry.file))],
    returned: entries.length,
    chain_unbroken,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — called from server/index.mjs
// ---------------------------------------------------------------------------
//
// Returns a result object on a matched Cobra route, or null when the path
// is not in the Cobra namespace (so the main switch falls through to 404).

export async function dispatchCobra(req, url, { readBody }) {
  const method = req.method.toUpperCase();
  const path = url.pathname;
  const headers = req.headers || {};

  if (!isCobraRouteAllowed(method, path)) {
    return null;
  }

  if (method === "POST" && path === "/v1/cobra/turn") {
    const body = await safeReadBody(req, readBody);
    if (body && body._ae_http_status) return body;
    return await handleCobraTurn(body, headers);
  }
  if (method === "GET" && path === "/v1/cobra/healthz") {
    return await handleCobraHealthz(headers);
  }
  if (method === "GET" && path === "/v1/cobra/flux/tail") {
    return await handleCobraFluxTail(url, headers);
  }
  return null;
}

async function safeReadBody(req, readBody) {
  try {
    return await readBody(req);
  } catch (e) {
    return err(400, "invalid_body", String(e?.message || e));
  }
}
