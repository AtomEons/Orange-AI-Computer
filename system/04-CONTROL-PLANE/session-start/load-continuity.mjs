#!/usr/bin/env node
// Orange5 — Session-Start: Continuity Surface Loader
// Path:    04-CONTROL-PLANE/session-start/load-continuity.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports + global fetch only)
//
// What this does
// --------------
// Step 2 of the session-start ritual, factored out as a focused, callable
// module so the deploy grid (and any other surface) can render the operator's
// most recent Continuity Packet on its own without dragging the full
// orchestrator graph along.
//
// Concretely:
//   1. GET http://127.0.0.1:1337/v1/continuity/latest with a short timeout.
//      That endpoint is mounted by 04-CONTROL-PLANE/continuity/loader.mjs and
//      already does the three-tier source dance (Reality Flux → on-disk files
//      → last-known-good cache). We never re-implement that here — single
//      source of truth.
//   2. If the gateway is unreachable, fall back to the in-process loadLatest()
//      from continuity/loader.mjs so the grid still renders on a cold boot
//      where the OrangeLLM gateway isn't up yet.
//   3. Pull out the three fields the deploy grid actually cares about:
//        - tomorrow_first_action
//        - open_blockers   (full list, with a trimmed preview)
//        - hot_currents    (the most recent reality-lane signals)
//   4. If no continuity packet exists from the last 48 hours — even after the
//      in-process fallback — emit an HONEST warning to the grid. Not a fake
//      "all good." The string is exactly:
//        "no recent continuity packet (last seen: <date or 'never'>)"
//      and the surface carries `warning: true` so the orchestrator can route
//      it into health.yellows without re-deriving.
//
// Mom's Law alignment
// -------------------
// - Every return value reports `source` (gateway | module | cache | none) and
//   `stale` so the operator sees exactly where the bytes came from.
// - "No recent packet" is reported plainly, not papered over with empty
//   defaults. The 48h freshness window is computed against the packet's `date`
//   field, not against ambient process time.
// - The function NEVER throws on the request path. All failures resolve to a
//   `{ ok:false, reason, warning? }` shape with a named reason.
// - Loopback only. Gateway URL defaults to http://127.0.0.1:1337 and is
//   overridable via env ORANGELLM_GATEWAY for ops, never via untrusted input.
//
// Public API
// ----------
//   import { loadContinuitySurface, formatGridLine } from "./load-continuity.mjs";
//
//   const surface = await loadContinuitySurface();
//   // → {
//   //     ok, source, transport, stale, warning,
//   //     date, sha256,
//   //     tomorrow_first_action,
//   //     open_blockers: [...],
//   //     open_blockers_count,
//   //     hot_currents: [...],
//   //     hot_currents_count,
//   //     age_hours, fresh_within_48h,
//   //     attempts, elapsed_ms, fetched_at,
//   //     warning_message?
//   //   }
//
//   const lines = formatGridLine(surface); // string[] for the deploy grid
//
// CLI
// ---
//   node load-continuity.mjs              # JSON (compact)
//   node load-continuity.mjs --pretty     # JSON (pretty)
//   node load-continuity.mjs --grid       # render the grid lines only
//   node load-continuity.mjs --skip-gateway   # in-process fallback only
//   node load-continuity.mjs --gateway URL    # override base
//   node load-continuity.mjs --window-hours N # override 48h freshness window
//
// Exit codes: 0 packet returned (any freshness),
//             2 no packet anywhere (warning emitted),
//             1 hard error.

import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const GATEWAY_BASE =
  process.env.ORANGELLM_GATEWAY || "http://127.0.0.1:1337";

const CONTINUITY_LOADER_PATH =
  process.env.ORANGE5_CONTINUITY_LOADER ||
  resolve(ORANGE5_ROOT, "04-CONTROL-PLANE", "continuity", "loader.mjs");

const GATEWAY_PATH = "/v1/continuity/latest";

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.ORANGE5_CONTINUITY_TIMEOUT_MS || "3000",
  10,
);

// The "recent" window. Doctrine says 48h. Operator can override via env so the
// laptop-closed-for-the-weekend case can be tuned without code change.
const DEFAULT_FRESHNESS_WINDOW_HOURS = parseInt(
  process.env.ORANGE5_CONTINUITY_WINDOW_HOURS || "48",
  10,
);

// How many open_blockers and hot_currents to surface in the trimmed preview.
// The full lists are still attached for downstream consumers.
const PREVIEW_BLOCKERS = 8;
const PREVIEW_HOT_CURRENTS = 8;

const SCHEMA = "orange5.continuity-surface.v1";

// ---------------------------------------------------------------------------
// Helpers

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
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

/**
 * Compute the age in hours of an ISO date string (YYYY-MM-DD or full ISO).
 * Returns null if the input is missing or unparseable.
 */
export function ageHours(dateStr, now = new Date()) {
  if (!dateStr || typeof dateStr !== "string") return null;
  // Accept either YYYY-MM-DD or full ISO 8601.
  let dt;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // Packets that record only a date are conservatively dated at end-of-day
    // UTC so a "today" packet still reads as ~0h, not ~24h, old.
    const [y, m, d] = dateStr.split("-").map(Number);
    dt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  } else {
    dt = new Date(dateStr);
  }
  if (isNaN(dt.getTime())) return null;
  const ms = now.getTime() - dt.getTime();
  if (ms < 0) return 0; // future-dated packet — treat as fresh, not negative
  return ms / 3_600_000;
}

// ---------------------------------------------------------------------------
// Transport 1 — gateway

async function loadViaGateway({ gateway = GATEWAY_BASE, timeoutMs } = {}) {
  const url = `${gateway.replace(/\/+$/, "")}${GATEWAY_PATH}`;
  const r = await fetchJsonWithTimeout(url, { timeoutMs });
  if (!r.ok) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.error || `gateway_status_${r.status}`,
      status: r.status,
    };
  }
  if (!r.data || typeof r.data !== "object") {
    return {
      ok: false,
      transport: "gateway",
      reason: "gateway_returned_no_json",
    };
  }
  if (r.data.ok === false) {
    return {
      ok: false,
      transport: "gateway",
      reason: r.data.reason || "gateway_returned_not_ok",
      detail: r.data,
    };
  }
  return { ok: true, transport: "gateway", payload: r.data };
}

// ---------------------------------------------------------------------------
// Transport 2 — in-process module fallback

async function loadViaModule() {
  try {
    const mod = await import(pathToFileURL(CONTINUITY_LOADER_PATH).href);
    const fn = mod.loadLatest || mod.default;
    if (typeof fn !== "function") {
      return {
        ok: false,
        transport: "module",
        reason: "in_process_loader_no_function",
      };
    }
    const out = await fn({});
    if (!out || out.ok === false) {
      return {
        ok: false,
        transport: "module",
        reason: out?.reason || "in_process_loader_not_ok",
        detail: out,
      };
    }
    return { ok: true, transport: "module", payload: out };
  } catch (e) {
    return {
      ok: false,
      transport: "module",
      reason: "in_process_loader_threw",
      detail: String(e?.message || e),
    };
  }
}

// ---------------------------------------------------------------------------
// Surface extraction

/**
 * Pull tomorrow_first_action + open_blockers + hot_currents out of whatever
 * shape the loader returned. Both the gateway and the in-process loader
 * resolve to an envelope like:
 *   { ok, source, stale, date, packet: { tomorrow_first_action, open_blockers,
 *     hot_currents, progress, ... }, sha256 }
 * but field aliases exist in the wild (open_blockers vs blockers,
 * tomorrow_first_action vs tomorrows_first_action). We accept both.
 */
function extractSurface(payload) {
  const packet = payload?.packet || {};
  const open_blockers = Array.isArray(packet.open_blockers)
    ? packet.open_blockers
    : Array.isArray(packet.blockers)
      ? packet.blockers
      : [];
  const hot_currents = Array.isArray(packet.hot_currents) ? packet.hot_currents : [];
  const tomorrow_first_action =
    packet.tomorrow_first_action ?? packet.tomorrows_first_action ?? null;
  return {
    date: payload?.date || packet.date || null,
    sha256: payload?.sha256 || null,
    source: payload?.source || null,
    stale: !!payload?.stale,
    tomorrow_first_action,
    open_blockers,
    open_blockers_count: open_blockers.length,
    hot_currents,
    hot_currents_count: hot_currents.length,
  };
}

// ---------------------------------------------------------------------------
// Public API — loadContinuitySurface

/**
 * Load the operator's most recent Continuity Packet and surface the three
 * fields the deploy grid renders: tomorrow's_first_action, open_blockers,
 * hot_currents.
 *
 * Options
 * -------
 *   gateway       : override gateway base URL (default 127.0.0.1:1337)
 *   skipGateway   : skip the gateway hop entirely (in-process only)
 *   timeoutMs     : gateway timeout, default 3000ms
 *   windowHours   : freshness window for the warning, default 48
 *   now           : injectable clock (Date) — used by tests
 *
 * Return — always a single object, never throws.
 *   { ok, schema, source, transport, stale, warning, warning_message?,
 *     date, sha256, tomorrow_first_action,
 *     open_blockers: [...], open_blockers_count,
 *     hot_currents: [...], hot_currents_count,
 *     age_hours, fresh_within_48h,
 *     attempts: [{ transport, ok, reason }],
 *     elapsed_ms, fetched_at }
 */
export async function loadContinuitySurface(opts = {}) {
  const t0 = nowMs();
  const fetched_at = isoNow();
  const windowHours = Number.isFinite(opts.windowHours)
    ? opts.windowHours
    : DEFAULT_FRESHNESS_WINDOW_HOURS;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const attempts = [];
  let result = null;

  if (!opts.skipGateway) {
    const g = await loadViaGateway({
      gateway: opts.gateway,
      timeoutMs: opts.timeoutMs,
    });
    attempts.push({
      transport: "gateway",
      ok: g.ok,
      reason: g.ok ? null : g.reason,
    });
    if (g.ok) result = g;
  } else {
    attempts.push({ transport: "gateway", skipped: true });
  }

  if (!result) {
    const m = await loadViaModule();
    attempts.push({
      transport: "module",
      ok: m.ok,
      reason: m.ok ? null : m.reason,
    });
    if (m.ok) result = m;
  }

  const elapsed_ms = nowMs() - t0;

  // No packet anywhere — emit the honest warning. The deploy grid will route
  // this into health.yellows; the operator sees "no recent continuity packet"
  // instead of an empty section that lies by omission.
  if (!result) {
    return {
      ok: false,
      schema: SCHEMA,
      source: "none",
      transport: null,
      stale: false,
      warning: true,
      warning_message: "no recent continuity packet (last seen: never)",
      date: null,
      sha256: null,
      tomorrow_first_action: null,
      open_blockers: [],
      open_blockers_count: 0,
      hot_currents: [],
      hot_currents_count: 0,
      age_hours: null,
      fresh_within_48h: false,
      reason: "no_continuity_packet_via_any_transport",
      attempts,
      elapsed_ms,
      fetched_at,
    };
  }

  const surface = extractSurface(result.payload);
  const age_hours = ageHours(surface.date, now);
  const fresh_within_48h =
    age_hours != null && age_hours <= windowHours;

  // The warning fires when we DO have a packet but it's outside the freshness
  // window. The packet itself is still returned — the grid can show the stale
  // contents AND the warning together. That's not a contradiction; it's the
  // operator seeing both "here's the last context I have" and "by the way,
  // it's old."
  let warning = false;
  let warning_message;
  if (age_hours == null) {
    warning = true;
    warning_message =
      `no recent continuity packet (last seen: ${surface.date || "unknown"})`;
  } else if (!fresh_within_48h) {
    warning = true;
    const days = (age_hours / 24).toFixed(1);
    warning_message =
      `no recent continuity packet within ${windowHours}h (last seen: ${surface.date}, ~${days}d ago)`;
  }

  return {
    ok: true,
    schema: SCHEMA,
    source: surface.source || result.transport,
    transport: result.transport,
    stale: surface.stale,
    warning,
    warning_message,
    date: surface.date,
    sha256: surface.sha256,
    tomorrow_first_action: surface.tomorrow_first_action,
    open_blockers: surface.open_blockers,
    open_blockers_count: surface.open_blockers_count,
    hot_currents: surface.hot_currents,
    hot_currents_count: surface.hot_currents_count,
    age_hours: age_hours == null ? null : Math.round(age_hours * 10) / 10,
    fresh_within_48h,
    attempts,
    elapsed_ms,
    fetched_at,
  };
}

// ---------------------------------------------------------------------------
// Grid renderer — one-screen lines for the deploy grid

function trim(s, n) {
  if (s == null) return "";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

/**
 * Render the continuity surface as an array of strings the orchestrator's
 * deploy-grid renderer can splice into its output. Pure formatter — no I/O.
 */
export function formatGridLine(surface) {
  const lines = [];
  if (!surface || surface.ok === false) {
    lines.push("│ Continuity   : (no packet)");
    if (surface?.warning_message) {
      lines.push(`│   WARNING    : ${surface.warning_message}`);
    } else if (surface?.reason) {
      lines.push(`│   reason     : ${surface.reason}`);
    }
    return lines;
  }
  const ageBit =
    surface.age_hours == null
      ? "age:?"
      : surface.age_hours < 24
        ? `age:${surface.age_hours.toFixed(1)}h`
        : `age:${(surface.age_hours / 24).toFixed(1)}d`;
  lines.push(
    `│ Continuity   : ${surface.date || "?"}   ${ageBit}   src:${surface.source}   stale:${surface.stale}`,
  );
  if (surface.warning && surface.warning_message) {
    lines.push(`│   WARNING    : ${surface.warning_message}`);
  }
  lines.push(
    `│   next       : ${trim(surface.tomorrow_first_action, 60) || "(none)"}`,
  );
  lines.push(
    `│   blockers   : ${surface.open_blockers_count}` +
      (surface.open_blockers_count ? "" : "   (none open)"),
  );
  for (const b of surface.open_blockers.slice(0, PREVIEW_BLOCKERS)) {
    const text =
      typeof b === "string" ? b : b?.title || b?.summary || b?.id || JSON.stringify(b);
    lines.push(`│     • ${trim(text, 56)}`);
  }
  lines.push(`│   hot_curr   : ${surface.hot_currents_count}`);
  for (const h of surface.hot_currents.slice(0, PREVIEW_HOT_CURRENTS)) {
    const label = h?.event_type || h?.type || "?";
    const text = h?.title || h?.summary || h?.subject || h?.detail || "";
    lines.push(`│     • ${label}  ${trim(text, 48)}`);
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
    else if (a === "--skip-gateway") args.skipGateway = true;
    else if (a === "--gateway") args.gateway = argv[++i];
    else if (a === "--window-hours") args.windowHours = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") args.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function helpText() {
  return [
    "Orange5 — Session-Start: Continuity Surface Loader",
    "",
    "Usage:",
    "  node load-continuity.mjs [--pretty] [--grid] [--skip-gateway]",
    "                           [--gateway http://127.0.0.1:1337]",
    "                           [--window-hours 48] [--timeout-ms 3000]",
    "",
    "Exit codes: 0 packet returned, 2 no packet anywhere, 1 hard error.",
  ].join("\n");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }
  loadContinuitySurface(args).then(
    (surface) => {
      if (args.grid) {
        process.stdout.write(formatGridLine(surface).join("\n") + "\n");
      } else {
        const txt = args.pretty
          ? JSON.stringify(surface, null, 2)
          : JSON.stringify(surface);
        process.stdout.write(txt + "\n");
      }
      process.exit(surface.ok ? 0 : 2);
    },
    (err) => {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          reason: "cli_unhandled",
          detail: String(err?.message || err),
        }) + "\n",
      );
      process.exit(1);
    },
  );
}

export default loadContinuitySurface;
