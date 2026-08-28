#!/usr/bin/env node
// Orange5 — Session-Start: Hot Currents Aggregator
// Path:    04-CONTROL-PLANE/session-start/flux-currents.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports + global fetch only)
//
// What this does
// --------------
// Step 4 of the session-start ritual, factored out as a focused, callable
// module so the deploy grid can render the top-N reality-lane currents on
// its own without dragging the full orchestrator graph along.
//
// Concretely:
//   1. GET  http://127.0.0.1:1337/v1/atomsmasher/currents
//        → "active currents in the last 24h" (atom-graph view; what is
//          currently in motion, irrespective of single event timing)
//   2. GET  http://127.0.0.1:1337/v1/flow/events?lane=reality&from=24h
//        → the raw reality-lane event stream from the last 24h
//          (one row per emitted event; provides depth + last_event_ts)
//   3. Merge into a single `hot_currents: [{label, depth, last_event_ts}]`
//      list, deterministically sorted by (depth desc, last_event_ts desc,
//      label asc), trimmed to the top 5.
//
// Aggregation rules
// -----------------
//   - "label" : a stable human-readable string. Preference order:
//                 current.title → current.label → current.subject
//                 → event.title → event.label → event.event_type
//                 → "(unlabeled)"
//   - "depth" : INTEGER count of how many real signals back this current.
//                 An /atomsmasher/currents row contributes
//                   max(row.depth, row.event_count, 1)
//                 to its label's depth bucket; each matching /flow/events
//                 row adds 1. Labels that appear ONLY in /atomsmasher/currents
//                 with no explicit depth get depth=1 (we don't fabricate
//                 strength out of presence alone).
//   - "last_event_ts" : the MAX timestamp across every contributing row,
//                 in ISO 8601 UTC. If a contributor lacks a timestamp it
//                 is excluded from the max — never coerced to "now".
//   - Labels are matched case-insensitively but emitted in the casing of
//     the first contributor seen (deterministic by sort order described
//     below — gateway data is consumed before flow data so a current's
//     own canonical label wins over an event-stream variant).
//
// Mom's Law alignment
// -------------------
//   - REAL DATA ONLY. If both endpoints are 404 or unreachable, the
//     returned surface is { ok:true, hot_currents:[], warning:true,
//     warning_message:"no live currents endpoint reachable" } — not a
//     fake "all green" with synthetic currents.
//   - Every return value reports `sources` so the operator sees exactly
//     where the bytes came from per endpoint (live | fallback | missing).
//   - The function NEVER throws on the request path. Every error path
//     resolves to a uniform shape with a named reason.
//   - Loopback only. Gateway URL defaults to http://127.0.0.1:1337 and is
//     overridable via env ORANGELLM_GATEWAY for ops, never via untrusted
//     input. No third-party deps; no third-party HTTP.
//   - Deterministic. Same inputs → same `hot_currents` list, in the same
//     order, every time. The orchestrator hashes the grid; this module
//     must not introduce nondeterminism (no `new Date()` in payload,
//     no Map iteration leakage — we sort everything).
//
// Public API
// ----------
//   import { loadHotCurrents, formatGridLine } from "./flux-currents.mjs";
//
//   const surface = await loadHotCurrents();
//   // → {
//   //     ok, warning, warning_message?,
//   //     sources: {
//   //       atomsmasher: { ok, transport, status?, reason?, count },
//   //       flow_events: { ok, transport, status?, reason?, count },
//   //     },
//   //     hot_currents: [{label, depth, last_event_ts}, ...],  // top 5
//   //     all_currents_count, contributing_event_count,
//   //     window_hours, top_n,
//   //     elapsed_ms, fetched_at,
//   //   }
//
//   const lines = formatGridLine(surface); // string[] for the deploy grid
//
// CLI
// ---
//   node flux-currents.mjs              # JSON (compact)
//   node flux-currents.mjs --pretty     # JSON (pretty)
//   node flux-currents.mjs --grid       # render the grid lines only
//   node flux-currents.mjs --gateway URL    # override base
//   node flux-currents.mjs --window-hours N # override 24h window
//   node flux-currents.mjs --top N          # override top-5
//
// Exit codes: 0 surface returned (any state),
//             2 surface returned with warning (no live endpoint),
//             1 hard error.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants

const GATEWAY_BASE =
  process.env.ORANGELLM_GATEWAY || "http://127.0.0.1:1337";

const ATOMSMASHER_PATH = "/v1/atomsmasher/currents";
const FLOW_EVENTS_PATH = "/v1/flow/events";

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.ORANGE5_FLUX_CURRENTS_TIMEOUT_MS || "3000",
  10,
);

const DEFAULT_WINDOW_HOURS = parseInt(
  process.env.ORANGE5_FLUX_CURRENTS_WINDOW_HOURS || "24",
  10,
);

const DEFAULT_TOP_N = parseInt(
  process.env.ORANGE5_FLUX_CURRENTS_TOP || "5",
  10,
);

const SCHEMA = "orange5.hot-currents-surface.v1";

// Fields we tolerate from upstream payloads. We accept several shapes because
// /v1/atomsmasher/currents and /v1/flow/events are authored by separate
// subsystems and each may use slightly different field names. Order matters:
// the first non-empty field wins.
const LABEL_FIELDS = [
  "title", "label", "subject", "name",
  "event_type", "current_type", "kind", "topic",
];
const DEPTH_FIELDS = ["depth", "event_count", "count", "weight", "n"];
const TS_FIELDS    = ["last_event_ts", "ts", "timestamp", "updated_at", "created_at", "occurred_at"];

// ---------------------------------------------------------------------------
// Helpers

function isoNow() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Pull the first defined+non-empty value from an object across a list of keys.
 * Returns undefined if no field matches.
 */
function pickField(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    return v;
  }
  return undefined;
}

/**
 * Parse a timestamp value to an epoch-ms integer. Accepts ISO strings, numeric
 * epoch seconds (10 digits), and numeric epoch ms (13 digits). Returns null on
 * anything unparseable — we never coerce garbage to `Date.now()`.
 */
function parseTs(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: <= 1e11 looks like seconds; otherwise ms.
    return v <= 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // Pure-digit string → epoch
    if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
    if (/^\d{13}$/.test(s)) return parseInt(s, 10);
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function epochMsToIso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * fetch with a hard deadline. Native fetch — Node 20+. Returns a uniform
 * shape so the caller never has to introspect AbortController state.
 */
async function fetchJsonWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { __nonjson: text.slice(0, 256) };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
    return { ok: false, status: 0, error: reason };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Transport — /v1/atomsmasher/currents
//
// Expected shape (best-effort, tolerant):
//   {
//     ok: true,
//     currents: [
//       { title|label|subject, depth|event_count, last_event_ts, ... },
//       ...
//     ]
//   }
// Also accepted at top level: { items }, { results }, { entries }, or a bare
// array (some early gateway routes return a bare array).

async function fetchAtomsmasherCurrents({ gateway, windowHours, timeoutMs }) {
  const t0 = performance.now();
  const base = gateway.replace(/\/+$/, "");
  // The endpoint contract is "active currents in the last 24h". We pass the
  // window as a hint via ?window_hours= so a future server implementation can
  // honor it; servers that ignore the param will still return their default
  // window and we'll downstream-filter by ts.
  const url = `${base}${ATOMSMASHER_PATH}?window_hours=${encodeURIComponent(windowHours)}`;
  const r = await fetchJsonWithTimeout(url, { timeoutMs });
  const elapsed_ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.error || `gateway_status_${r.status}`,
      status: r.status,
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  if (!r.data || typeof r.data !== "object") {
    return {
      ok: false,
      transport: "gateway",
      reason: "gateway_returned_no_json",
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  if (r.data.ok === false) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.data.reason || "gateway_returned_not_ok",
      detail: r.data,
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  // Extract rows from any of the tolerated shapes.
  let rows = [];
  if (Array.isArray(r.data)) rows = r.data;
  else {
    for (const k of ["currents", "items", "results", "entries", "rows", "records"]) {
      if (Array.isArray(r.data[k])) { rows = r.data[k]; break; }
    }
  }
  // Filter to objects only — defensive against schema drift.
  rows = rows.filter((x) => x && typeof x === "object");
  return {
    ok: true,
    transport: "gateway",
    status: r.status,
    count: rows.length,
    rows,
    elapsed_ms,
  };
}

// ---------------------------------------------------------------------------
// Transport — /v1/flow/events?lane=reality&from=24h
//
// Expected shape (best-effort, tolerant):
//   {
//     ok: true,
//     events: [
//       { title|label|event_type, ts|timestamp|occurred_at, lane: "reality", ... },
//       ...
//     ]
//   }
// Also accepted: { items }, { results }, { entries }, or a bare array.

async function fetchFlowEvents({ gateway, windowHours, timeoutMs }) {
  const t0 = performance.now();
  const base = gateway.replace(/\/+$/, "");
  // `from=24h` is the doctrine form; we also pass explicit `lane=reality` and
  // `window_hours` for servers that prefer numeric params. The server-side
  // parser is expected to accept any of these — we send all three.
  const params = new URLSearchParams({
    lane: "reality",
    from: `${windowHours}h`,
    window_hours: String(windowHours),
  });
  const url = `${base}${FLOW_EVENTS_PATH}?${params.toString()}`;
  const r = await fetchJsonWithTimeout(url, { timeoutMs });
  const elapsed_ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.error || `gateway_status_${r.status}`,
      status: r.status,
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  if (!r.data || typeof r.data !== "object") {
    return {
      ok: false,
      transport: "gateway",
      reason: "gateway_returned_no_json",
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  if (r.data.ok === false) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.data.reason || "gateway_returned_not_ok",
      detail: r.data,
      count: 0,
      rows: [],
      elapsed_ms,
    };
  }
  let rows = [];
  if (Array.isArray(r.data)) rows = r.data;
  else {
    for (const k of ["events", "items", "results", "entries", "rows", "records", "deltas"]) {
      if (Array.isArray(r.data[k])) { rows = r.data[k]; break; }
    }
  }
  rows = rows.filter((x) => x && typeof x === "object");
  // Server-side filtering on lane is best-effort. Apply a client-side guard so
  // a permissive server can't sneak non-reality lanes into our reality grid.
  rows = rows.filter((x) => {
    const lane = x.lane || x.channel || x.bucket;
    if (lane === undefined || lane === null) return true; // unlabeled → trust query
    return String(lane).toLowerCase() === "reality";
  });
  return {
    ok: true,
    transport: "gateway",
    status: r.status,
    count: rows.length,
    rows,
    elapsed_ms,
  };
}

// ---------------------------------------------------------------------------
// Aggregation

/**
 * Merge atomsmasher.currents + flow.events into a deterministic top-N list.
 *
 * Returns: { hot_currents:[{label,depth,last_event_ts}], all_currents_count,
 *            contributing_event_count }
 */
export function aggregate({ atomsmasher_rows = [], flow_rows = [], topN = DEFAULT_TOP_N, windowHours = DEFAULT_WINDOW_HOURS, nowMs: nowOverride } = {}) {
  const cutoffMs = (Number.isFinite(nowOverride) ? nowOverride : nowMs())
    - (windowHours * 3_600_000);

  // bucket: lowercaseLabel → { label (canonical casing), depth, lastTsMs }
  const buckets = new Map();

  function bumpBucket(rawLabel, depthDelta, tsMs) {
    if (!isNonEmptyString(rawLabel)) return false;
    const label = rawLabel.trim();
    const key = label.toLowerCase();
    const existing = buckets.get(key);
    if (existing) {
      existing.depth += Math.max(0, depthDelta);
      if (tsMs != null && (existing.lastTsMs == null || tsMs > existing.lastTsMs)) {
        existing.lastTsMs = tsMs;
      }
    } else {
      buckets.set(key, {
        label,
        depth: Math.max(0, depthDelta),
        lastTsMs: tsMs != null ? tsMs : null,
      });
    }
    return true;
  }

  // 1. Ingest /atomsmasher/currents first so canonical current labels win
  //    over event-stream variants on casing.
  let atoms_used = 0;
  for (const row of atomsmasher_rows) {
    const label = pickField(row, LABEL_FIELDS);
    const rawDepth = pickField(row, DEPTH_FIELDS);
    const depth = isFiniteNumber(rawDepth) ? Math.max(1, Math.floor(rawDepth))
                 : (isNonEmptyString(rawDepth) && /^\d+$/.test(rawDepth)) ? parseInt(rawDepth, 10)
                 : 1; // doctrine: presence alone counts as 1
    const tsMs = parseTs(pickField(row, TS_FIELDS));
    // Client-side window guard. A row with no timestamp is kept (the server
    // already filtered by window_hours); a row with a timestamp must be inside
    // the window.
    if (tsMs != null && tsMs < cutoffMs) continue;
    if (bumpBucket(label, depth, tsMs)) atoms_used += 1;
  }

  // 2. Ingest /flow/events. Each event adds 1 to its label's depth.
  let events_used = 0;
  for (const row of flow_rows) {
    const label = pickField(row, LABEL_FIELDS);
    const tsMs = parseTs(pickField(row, TS_FIELDS));
    if (tsMs != null && tsMs < cutoffMs) continue;
    if (bumpBucket(label, 1, tsMs)) events_used += 1;
  }

  // 3. Sort deterministically: depth desc, last_event_ts desc, label asc.
  const all = Array.from(buckets.values()).map((b) => ({
    label: b.label,
    depth: b.depth,
    last_event_ts: epochMsToIso(b.lastTsMs),
    _lastTsMs: b.lastTsMs == null ? -Infinity : b.lastTsMs,
  }));
  all.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    if (b._lastTsMs !== a._lastTsMs) return b._lastTsMs - a._lastTsMs;
    return a.label.localeCompare(b.label);
  });
  // Drop the sort-only field.
  const top = all.slice(0, Math.max(0, topN)).map(({ label, depth, last_event_ts }) => ({
    label, depth, last_event_ts,
  }));

  return {
    hot_currents: top,
    all_currents_count: all.length,
    contributing_event_count: atoms_used + events_used,
  };
}

// ---------------------------------------------------------------------------
// Public API — loadHotCurrents

/**
 * Run the hot-currents surface end-to-end.
 *
 * Options
 * -------
 *   gateway        : override gateway base URL
 *   windowHours    : override 24h window
 *   topN           : override top-5
 *   timeoutMs      : override per-request timeout
 *   skipAtomsmasher: skip the atomsmasher GET (testing)
 *   skipFlowEvents : skip the flow events GET (testing)
 *
 * Return
 * ------
 *   See module-header `Public API`. Never throws on the request path.
 */
export async function loadHotCurrents(opts = {}) {
  const t0 = performance.now();
  const fetched_at = isoNow();
  const gateway = opts.gateway || GATEWAY_BASE;
  const windowHours = Number.isFinite(opts.windowHours) ? opts.windowHours : DEFAULT_WINDOW_HOURS;
  const topN = Number.isFinite(opts.topN) ? opts.topN : DEFAULT_TOP_N;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Parallel fan-out — both endpoints are read-only and independent.
  const [atomsmasher, flow_events] = await Promise.all([
    opts.skipAtomsmasher
      ? Promise.resolve({ ok: false, transport: "gateway", reason: "skipped", count: 0, rows: [], elapsed_ms: 0 })
      : fetchAtomsmasherCurrents({ gateway, windowHours, timeoutMs }),
    opts.skipFlowEvents
      ? Promise.resolve({ ok: false, transport: "gateway", reason: "skipped", count: 0, rows: [], elapsed_ms: 0 })
      : fetchFlowEvents({ gateway, windowHours, timeoutMs }),
  ]);

  const agg = aggregate({
    atomsmasher_rows: atomsmasher.ok ? atomsmasher.rows : [],
    flow_rows:        flow_events.ok ? flow_events.rows : [],
    topN,
    windowHours,
    nowMs: opts.nowMs,
  });

  const bothDead = !atomsmasher.ok && !flow_events.ok;
  const warning_message = bothDead
    ? `no live currents endpoint reachable (atomsmasher:${atomsmasher.reason || "?"}; flow_events:${flow_events.reason || "?"})`
    : (agg.hot_currents.length === 0
        ? "live endpoint(s) reachable but no currents in window"
        : null);

  // Build the public surface. Source objects expose `transport`, `status`,
  // `reason`, `count` — enough for the grid to render "live | missing |
  // skipped" without leaking the raw rows.
  const surface = {
    schema: SCHEMA,
    ok: true,                // module ran end-to-end; "no live endpoint" is a warning, not a failure
    warning: bothDead || agg.hot_currents.length === 0,
    warning_message,
    sources: {
      atomsmasher: {
        ok: atomsmasher.ok,
        transport: atomsmasher.transport,
        status: atomsmasher.status ?? null,
        reason: atomsmasher.reason || null,
        count: atomsmasher.count,
        elapsed_ms: atomsmasher.elapsed_ms,
      },
      flow_events: {
        ok: flow_events.ok,
        transport: flow_events.transport,
        status: flow_events.status ?? null,
        reason: flow_events.reason || null,
        count: flow_events.count,
        elapsed_ms: flow_events.elapsed_ms,
      },
    },
    hot_currents: agg.hot_currents,
    all_currents_count: agg.all_currents_count,
    contributing_event_count: agg.contributing_event_count,
    window_hours: windowHours,
    top_n: topN,
    elapsed_ms: Math.round(performance.now() - t0),
    fetched_at,
  };

  return surface;
}

// ---------------------------------------------------------------------------
// Grid renderer — pure, no I/O

/**
 * Render the hot-currents portion of the deploy grid. Returns a string[] for
 * line-by-line composition. Mom's Law: zero counts and warning states are
 * spoken plainly, never papered over.
 */
export function formatGridLine(surface) {
  const lines = [];
  const s = surface || {};
  const sources = s.sources || {};
  const a = sources.atomsmasher || {};
  const f = sources.flow_events || {};
  const aSrc = a.ok ? `live(${a.count})` : `down(${a.reason || "?"})`;
  const fSrc = f.ok ? `live(${f.count})` : `down(${f.reason || "?"})`;
  lines.push(`hot_currents (${s.window_hours ?? "?"}h, top ${s.top_n ?? "?"}) — atomsmasher:${aSrc}  flow:${fSrc}`);
  if (s.warning && s.warning_message) {
    lines.push(`  ! ${s.warning_message}`);
  }
  if (!Array.isArray(s.hot_currents) || s.hot_currents.length === 0) {
    lines.push("  (no currents)");
  } else {
    for (const c of s.hot_currents) {
      const ts = c.last_event_ts ? c.last_event_ts.replace("T", " ").slice(0, 19) + "Z" : "no-ts";
      const label = String(c.label || "(unlabeled)").slice(0, 48);
      lines.push(`  • depth=${String(c.depth).padStart(3)}  ${ts}  ${label}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") args.pretty = true;
    else if (a === "--grid") args.grid = true;
    else if (a === "--gateway") args.gateway = argv[++i];
    else if (a === "--window-hours") args.windowHours = parseInt(argv[++i], 10);
    else if (a === "--top") args.topN = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") args.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--skip-atomsmasher") args.skipAtomsmasher = true;
    else if (a === "--skip-flow-events") args.skipFlowEvents = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function helpText() {
  return [
    "Orange5 Hot Currents Aggregator",
    "",
    "Usage:",
    "  node flux-currents.mjs [--pretty] [--grid]",
    "                         [--gateway URL] [--window-hours N] [--top N]",
    "                         [--timeout-ms MS]",
    "                         [--skip-atomsmasher] [--skip-flow-events]",
    "",
    "Exit codes: 0 ok, 2 ok-with-warning (no live endpoint), 1 hard error.",
  ].join("\n");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const here = new URL(import.meta.url).href;
    const there = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
    return here === there;
  } catch { return false; }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write(helpText() + "\n"); process.exit(0); }
  loadHotCurrents(args).then(
    (surface) => {
      if (args.grid) {
        process.stdout.write(formatGridLine(surface).join("\n") + "\n");
      } else {
        const txt = args.pretty ? JSON.stringify(surface, null, 2) : JSON.stringify(surface);
        process.stdout.write(txt + "\n");
      }
      process.exit(surface.warning ? 2 : 0);
    },
    (err) => {
      process.stderr.write(JSON.stringify({
        ok: false,
        reason: "cli_unhandled",
        detail: String(err?.message || err),
      }) + "\n");
      process.exit(1);
    },
  );
}

export default loadHotCurrents;
