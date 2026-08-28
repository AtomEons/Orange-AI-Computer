#!/usr/bin/env node
// Orange5 — Session-Start Ritual Orchestrator
// Path:    04-CONTROL-PLANE/session-start/orchestrator.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports only, no third-party deps)
//
// What this does
// --------------
// Makes the CLAUDE.md operator-rule "atomeons-prime fires on first substantive
// turn" a REAL, callable, auditable ceremony. Builds a single SessionStartGrid
// object by running 7 deterministic steps:
//
//   1. Load Soul Genome (13-MODELS/orange-llm/soul_genome.json) and prepare
//      the system-role payload that the gateway middleware injects on the
//      first turn. This orchestrator NEVER calls a model — it returns the
//      payload + sha256 so the actual inject is a separate, auditable step.
//   2. Load latest Continuity Packet via /v1/continuity/latest (live gateway
//      first, then in-process loadLatest() fallback). Source is reported.
//   3. Trigger the 27 Guardrails full sweep via /v1/guardrails/run (live
//      gateway first, then in-process runGuardrails() fallback). Returns the
//      REAL violation list — no fake green.
//   4. Query Reality Flux for hot currents in the last 24h.
//   5. Read the top of the Not-Green Ledger (00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md)
//      and surface DEFERRED + PENDING-LIVE-SYSTEM rows.
//   6. Emit a boot receipt to 10-RECEIPTS/orange5-build/ with the full grid
//      (deterministic JSON, sha256-hashed, plus a one-page Markdown index).
//   7. Build a compact one-screen deploy grid string for the operator (TUI
//      or web view consumes this verbatim).
//
// Steps 1–5 run in parallel via Promise.all. 6 and 7 run sequentially after
// the fan-out because they depend on the aggregate.
//
// TTL cache
// ---------
// 5 minutes, persisted at state/last-grid.json. Idempotent within the window:
// multiple fires return the cached grid + cache_hit:true. Override with
// --force or `{ force:true }` programmatically. TTL is wall-clock; we do not
// trust ambient process state across boots.
//
// Reach
// -----
// - Powershell script (N150 launcher): `node orchestrator.mjs --pretty`
// - Gateway POST /v1/session/start: import { sessionStartHandler }
// - Atomic Orange first-launch hook: import { runRitual }
//
// Doctrine
// --------
// - Mom's Law: every grid line is REAL. If guardrails sweep returns 3 reds,
//   the grid says "3 reds: <list>". Health field is computed from facts.
// - No model invocations for the grid itself. Step 1 is data-only.
// - Named fallbacks. Each step records `source` and `ok` so the operator can
//   see at a glance which sources were live and which fell back.
// - Receipts override recollection. Step 6 writes a hash-chained receipt.
// - Frontier-only-via-gateway. The orchestrator prefers the gateway when up
//   and only falls back to in-process functions if the gateway is unreachable.
//
// HTTP contract (when mounted as POST /v1/session/start)
// ------------------------------------------------------
//   POST /v1/session/start [body optional: { force?:bool }]
//   200 OK { ok, grid, cache_hit, receipt_path, fetched_at }
//   500 only for unhandled exceptions — never used on the normal path.
//
// CLI
// ---
//   node orchestrator.mjs               # run ritual, print compact JSON
//   node orchestrator.mjs --pretty      # pretty JSON
//   node orchestrator.mjs --display     # print only the deploy grid string
//   node orchestrator.mjs --force       # bypass TTL cache
//   node orchestrator.mjs --no-receipt  # skip step 6 (dry run)
//   node orchestrator.mjs --gateway URL # override gateway base (default 127.0.0.1:1337)
//
// Exit codes: 0 grid built (any health), 2 grid built with stop-level reds,
// 1 hard error.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants — paths and endpoints

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const SOUL_GENOME_PATH =
  process.env.ORANGE5_SOUL_GENOME ||
  resolve(ORANGE5_ROOT, "13-MODELS", "orange-llm", "soul_genome.json");

const NOT_GREEN_LEDGER_PATH =
  process.env.ORANGE5_NOT_GREEN_LEDGER ||
  resolve(ORANGE5_ROOT, "00-CHARTER", "ORANGE5_NOT_GREEN_LEDGER.md");

const RECEIPTS_DIR =
  process.env.ORANGE5_BOOT_RECEIPTS_DIR ||
  resolve(ORANGE5_ROOT, "10-RECEIPTS", "orange5-build");

const STATE_DIR = resolve(__dirname, "state");
const CACHE_PATH = resolve(STATE_DIR, "last-grid.json");

const GATEWAY_BASE =
  process.env.ORANGELLM_GATEWAY || "http://127.0.0.1:1337";

const TTL_MS = parseInt(process.env.ORANGE5_SESSION_START_TTL_MS || "300000", 10); // 5 min

const SCHEMA = "orange5.session-start-grid.v1";

// In-process fallback module paths.
const GUARDRAILS_RUNTIME_PATH = resolve(
  ORANGE5_ROOT,
  "01-DOCTRINE",
  "27-guardrails",
  "runtime.mjs",
);
const CONTINUITY_LOADER_PATH = resolve(
  ORANGE5_ROOT,
  "04-CONTROL-PLANE",
  "continuity",
  "loader.mjs",
);
const FLUX_ADAPTER_PATH = resolve(
  ORANGE5_ROOT,
  "11-MIRAGE",
  "adapters",
  "flux.mjs",
);

// Hot-current query — last 24h, reality lane only, top channels by volume.
const HOT_CURRENT_RANGE_MS = 86_400_000;
const HOT_CURRENT_MAX = 16;
const HOT_CURRENT_QUERY =
  process.env.ORANGE5_HOT_CURRENT_QUERY || "lane:reality"; // adapter is permissive

// ---------------------------------------------------------------------------
// Tiny helpers

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function safeStringify(obj) {
  // Stable JSON for hashing: sort keys recursively. Arrays preserve order.
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null; // cycle guard
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(obj));
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function isoDate(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function fetchJsonWithTimeout(url, { method = "GET", body, timeoutMs = 4000 } = {}) {
  // Native fetch — Node 20+. AbortController for the deadline.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { __nonjson: text.slice(0, 256) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.name === "AbortError" ? "timeout" : e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Soul Genome load + inject payload

export function loadSoulGenome({ path = SOUL_GENOME_PATH } = {}) {
  const t0 = performance.now();
  if (!existsSync(path)) {
    return {
      step: "soul_genome",
      ok: false,
      reason: "soul_genome_file_missing",
      path,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return {
      step: "soul_genome",
      ok: false,
      reason: "soul_genome_read_failed",
      path,
      detail: String(e?.message || e),
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      step: "soul_genome",
      ok: false,
      reason: "soul_genome_invalid_json",
      path,
      detail: String(e?.message || e),
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }

  // Build the inject payload — data only. The gateway memory-inject middleware
  // is the actual injector. This orchestrator NEVER calls a model.
  const sovereign = parsed?.sovereign || null;
  const schema_id = parsed?.schema_id || null;
  const schema_version = parsed?.schema_version || null;
  const inject_payload = {
    role: "system",
    schema_id,
    schema_version,
    genome_sha256: sha256(raw),
    bytes: raw.length,
    sovereign_name: sovereign?.name || null,
    sovereign_alias: sovereign?.alias || null,
    // Caller passes the full genome object to the inject middleware; we
    // attach a reference so the receipt records exactly what would be injected.
    genome_ref: { path, sha256: sha256(raw) },
  };
  return {
    step: "soul_genome",
    ok: true,
    source: `file:${path}`,
    schema_id,
    schema_version,
    genome_sha256: inject_payload.genome_sha256,
    bytes: inject_payload.bytes,
    sovereign: sovereign ? {
      name: sovereign.name || null,
      alias: sovereign.alias || null,
      email: sovereign.email || null,
    } : null,
    inject_payload,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Continuity Packet (gateway → in-process fallback)

async function loadContinuityViaGateway({ gateway = GATEWAY_BASE, timeoutMs = 3000 } = {}) {
  const r = await fetchJsonWithTimeout(`${gateway}/v1/continuity/latest`, {
    method: "GET", timeoutMs,
  });
  if (!r.ok || !r.data) {
    return { ok: false, reason: r.error || `gateway_status_${r.status}`, transport: "gateway" };
  }
  if (r.data.ok === false) {
    return { ok: false, reason: r.data.reason || "gateway_returned_not_ok", transport: "gateway", detail: r.data };
  }
  return { ok: true, transport: "gateway", payload: r.data };
}

async function loadContinuityViaModule() {
  try {
    const mod = await import(pathToFileURL(CONTINUITY_LOADER_PATH).href);
    const fn = mod.loadLatest || mod.default;
    if (typeof fn !== "function") {
      return { ok: false, reason: "in_process_loader_no_function", transport: "module" };
    }
    const out = await fn({});
    if (!out || out.ok === false) {
      return { ok: false, reason: out?.reason || "in_process_loader_not_ok", transport: "module", detail: out };
    }
    return { ok: true, transport: "module", payload: out };
  } catch (e) {
    return { ok: false, reason: "in_process_loader_threw", transport: "module", detail: String(e?.message || e) };
  }
}

export async function loadContinuity({ gateway = GATEWAY_BASE, skipGateway = false } = {}) {
  const t0 = performance.now();
  const attempts = [];
  let result = null;
  if (!skipGateway) {
    const g = await loadContinuityViaGateway({ gateway });
    attempts.push({ transport: "gateway", ok: g.ok, reason: g.reason });
    if (g.ok) result = g;
  } else {
    attempts.push({ transport: "gateway", skipped: true });
  }
  if (!result) {
    const m = await loadContinuityViaModule();
    attempts.push({ transport: "module", ok: m.ok, reason: m.reason });
    if (m.ok) result = m;
  }
  const elapsed_ms = Math.round(performance.now() - t0);
  if (!result) {
    return {
      step: "continuity",
      ok: false,
      reason: "no_continuity_packet_via_any_transport",
      attempts,
      elapsed_ms,
    };
  }
  const p = result.payload;
  return {
    step: "continuity",
    ok: true,
    source: p.source || result.transport,
    transport: result.transport,
    stale: !!p.stale,
    date: p.date || null,
    sha256: p.sha256 || null,
    // Trim — the grid surface keeps the small, useful pieces. The full packet
    // is still in the inject payload for downstream.
    summary: {
      progress_count: Array.isArray(p.packet?.progress) ? p.packet.progress.length : 0,
      open_blockers_count: Array.isArray(p.packet?.open_blockers) ? p.packet.open_blockers.length : 0,
      tomorrow_first_action: p.packet?.tomorrow_first_action ?? null,
      hot_currents_count: Array.isArray(p.packet?.hot_currents) ? p.packet.hot_currents.length : 0,
    },
    open_blockers: Array.isArray(p.packet?.open_blockers) ? p.packet.open_blockers.slice(0, 8) : [],
    attempts,
    elapsed_ms,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — 27 Guardrails sweep (gateway → in-process fallback)

async function runGuardrailsViaGateway({ gateway = GATEWAY_BASE, timeoutMs = 15000 } = {}) {
  const r = await fetchJsonWithTimeout(`${gateway}/v1/guardrails/run`, {
    method: "POST", body: {}, timeoutMs,
  });
  if (!r.ok || !r.data) {
    return { ok: false, reason: r.error || `gateway_status_${r.status}`, transport: "gateway" };
  }
  // The gateway endpoint returns the same shape as runGuardrails().
  return { ok: true, transport: "gateway", payload: r.data };
}

async function runGuardrailsViaModule() {
  try {
    const mod = await import(pathToFileURL(GUARDRAILS_RUNTIME_PATH).href);
    const fn = mod.runGuardrails;
    if (typeof fn !== "function") {
      return { ok: false, reason: "in_process_runtime_no_function", transport: "module" };
    }
    // Don't write to flux from a session-start orchestrator — that's the
    // sweep itself's job. We also persist:false to avoid hammering the
    // ledger when callers fire repeatedly.
    const out = await fn({ write_to_flux: false, persist: false });
    return { ok: true, transport: "module", payload: out };
  } catch (e) {
    return { ok: false, reason: "in_process_runtime_threw", transport: "module", detail: String(e?.message || e) };
  }
}

export async function runGuardrailsSweep({ gateway = GATEWAY_BASE, skipGateway = false } = {}) {
  const t0 = performance.now();
  const attempts = [];
  let result = null;
  if (!skipGateway) {
    const g = await runGuardrailsViaGateway({ gateway });
    attempts.push({ transport: "gateway", ok: g.ok, reason: g.reason });
    if (g.ok) result = g;
  } else {
    attempts.push({ transport: "gateway", skipped: true });
  }
  if (!result) {
    const m = await runGuardrailsViaModule();
    attempts.push({ transport: "module", ok: m.ok, reason: m.reason });
    if (m.ok) result = m;
  }
  const elapsed_ms = Math.round(performance.now() - t0);
  if (!result) {
    return {
      step: "guardrails",
      ok: false,
      reason: "no_guardrails_run_via_any_transport",
      attempts,
      elapsed_ms,
    };
  }
  const p = result.payload || {};
  const violations = Array.isArray(p.violations) ? p.violations : [];
  // Honest tally — break out by severity so the operator sees what kind of red.
  const by_severity = {};
  for (const v of violations) {
    const s = v.severity || "unknown";
    by_severity[s] = (by_severity[s] || 0) + 1;
  }
  return {
    step: "guardrails",
    ok: !!p.ok,
    transport: result.transport,
    run_id: p.run_id || null,
    elapsed_ms_check: p.elapsed_ms ?? null,
    stop: !!p.stop,
    violations_count: violations.length,
    by_severity,
    violations: violations.slice(0, 12).map((v) => ({
      guardrail_id: v.guardrail_id,
      severity: v.severity,
      name: v.name,
      detail: typeof v.details === "string" ? v.details.slice(0, 240) : v.details ?? null,
    })),
    attempts,
    elapsed_ms,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — Reality Flux hot currents (last 24h)

async function loadFluxAdapter() {
  try {
    const mod = await import(pathToFileURL(FLUX_ADAPTER_PATH).href);
    return mod.fluxAdapter || mod.default || null;
  } catch (e) {
    return { __err: String(e?.message || e) };
  }
}

export async function queryHotCurrents({ adapter } = {}) {
  const t0 = performance.now();
  const a = adapter || (await loadFluxAdapter());
  if (!a || typeof a.read !== "function") {
    return {
      step: "hot_currents",
      ok: false,
      reason: "flux_adapter_unavailable",
      detail: a && a.__err ? a.__err : "no_read_method",
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  let res;
  try {
    res = await a.read({
      query: HOT_CURRENT_QUERY,
      time_range_ms: HOT_CURRENT_RANGE_MS,
      max_records: HOT_CURRENT_MAX,
      include_conflicts: false,
    });
  } catch (e) {
    return {
      step: "hot_currents",
      ok: false,
      reason: "flux_read_threw",
      detail: String(e?.message || e),
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  if (!res || res.ok === false) {
    return {
      step: "hot_currents",
      ok: false,
      reason: res?.reason || "flux_read_not_ok",
      detail: res?.detail || null,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  // Pull records into a uniform shape. The flux adapter returns a StateBrief-
  // style envelope; we accept any of {events,records,items,results,entries}.
  const buckets = ["events", "records", "items", "results", "entries"];
  let records = [];
  for (const b of buckets) {
    if (Array.isArray(res.data?.[b])) records = records.concat(res.data[b]);
  }
  const currents = records.slice(0, HOT_CURRENT_MAX).map((r) => ({
    event_type: r.event_type || r.type || null,
    origin: r.origin || null,
    ts: r.ts || r.timestamp || null,
    title: r.title || r.summary || r.subject || null,
    severity: r.severity || null,
  }));
  return {
    step: "hot_currents",
    ok: true,
    source: `flux${res.source ? ":" + res.source : ""}`,
    stale: !!res.stale,
    count: currents.length,
    currents,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// Step 5 — Not-Green Ledger top

export function readNotGreenLedgerTop({ path = NOT_GREEN_LEDGER_PATH, maxPerSection = 6 } = {}) {
  const t0 = performance.now();
  if (!existsSync(path)) {
    return {
      step: "not_green_ledger",
      ok: false,
      reason: "ledger_file_missing",
      path,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return {
      step: "not_green_ledger",
      ok: false,
      reason: "ledger_read_failed",
      detail: String(e?.message || e),
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }
  // Lightweight markdown table extractor. The ledger is human-curated MD with
  // pipe tables under section headers. We don't depend on a markdown lib —
  // deterministic, zero-dep parsing keeps the orchestrator pure-data.
  const lines = raw.split(/\r?\n/);
  const sections = []; // { title, rows: [{cols}] }
  let current = null;
  let inTable = false;
  let header = null;
  for (const ln of lines) {
    const h = ln.match(/^##\s+(.+)$/);
    if (h) {
      current = { title: h[1].trim(), rows: [] };
      sections.push(current);
      inTable = false;
      header = null;
      continue;
    }
    if (!current) continue;
    const isPipeRow = /^\s*\|/.test(ln);
    if (!isPipeRow) { inTable = false; header = null; continue; }
    const cols = ln.split("|").slice(1, -1).map((c) => c.trim());
    // Detect separator row like |---|---|
    if (cols.every((c) => /^:?-{2,}:?$/.test(c))) { inTable = true; continue; }
    if (!header) { header = cols; continue; }
    if (inTable && cols.length === header.length) {
      const row = {};
      for (let i = 0; i < header.length; i++) row[header[i]] = cols[i];
      current.rows.push(row);
    }
  }
  const want = new Set([
    "DEFERRED BY OPERATOR",
    "PENDING-LIVE-SYSTEM (not deferred; just needs the moment)",
    "PENDING-LIVE-SYSTEM",
    "SCAFFOLD-NOW / FULL-LATER (PRs that ship contract; impl deepens later)",
    "SCAFFOLD-NOW / FULL-LATER",
  ]);
  const surfaced = sections
    .filter((s) => want.has(s.title) || /DEFERRED|PENDING|SCAFFOLD/i.test(s.title))
    .map((s) => ({
      section: s.title,
      count: s.rows.length,
      rows: s.rows.slice(0, maxPerSection),
    }));
  const total_open = surfaced.reduce((n, s) => n + s.count, 0);
  return {
    step: "not_green_ledger",
    ok: true,
    source: `file:${path}`,
    total_open,
    sections: surfaced,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// Aggregate health — honest, derived from facts

function deriveHealth({ steps }) {
  const reds = [];
  const yellows = [];
  // Step-level failures. We intentionally EXCLUDE `guardrails` here because
  // `guardrails.ok === false` is the runtime's correct signal for "violations
  // present" — not "the sweep itself failed." We classify it explicitly below.
  for (const [name, s] of Object.entries(steps)) {
    if (name === "guardrails") continue;
    if (!s || s.ok === false) reds.push(`${name}:${s?.reason || "failed"}`);
  }
  // Guardrails — distinguish "sweep itself failed" from "sweep ran and found reds".
  const gr = steps.guardrails;
  if (!gr || gr.transport == null) {
    reds.push(`guardrails:${gr?.reason || "sweep_unavailable"}`);
  } else if ((gr.violations_count || 0) > 0) {
    if (gr.stop) {
      reds.push(`guardrails:${gr.violations_count}_violations(stop)`);
    } else {
      yellows.push(`guardrails:${gr.violations_count}_violations`);
    }
  }
  // Continuity stale → yellow.
  if (steps.continuity?.ok && steps.continuity?.stale) {
    yellows.push("continuity:stale");
  }
  // Hot currents missing → yellow (not fatal).
  if (steps.hot_currents && !steps.hot_currents.ok) {
    // already in reds via step-failure above; downgrade to yellow because
    // hot-current absence is not a stop condition.
    const idx = reds.findIndex((r) => r.startsWith("hot_currents:"));
    if (idx >= 0) {
      reds.splice(idx, 1);
      yellows.push(`hot_currents:${steps.hot_currents.reason}`);
    }
  }
  let band;
  if (reds.length > 0) band = "RED";
  else if (yellows.length > 0) band = "YELLOW";
  else band = "GREEN";
  return { band, reds, yellows };
}

// ---------------------------------------------------------------------------
// Step 7 — Deploy grid display string (one-screen)

function fmtDuration(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function renderDeployGrid(grid) {
  const lines = [];
  lines.push("╭─ Orange5 Session-Start Grid ─────────────────────────────");
  lines.push(`│ schema     : ${grid.schema}`);
  lines.push(`│ session_id : ${grid.session_id}`);
  lines.push(`│ generated  : ${grid.generated_at}`);
  lines.push(`│ elapsed    : ${fmtDuration(grid.elapsed_ms)}   cache_hit:${grid.cache_hit}`);
  lines.push(`│ HEALTH     : ${grid.health.band}`);
  if (grid.health.reds.length) lines.push(`│   reds    : ${grid.health.reds.join(", ")}`);
  if (grid.health.yellows.length) lines.push(`│   yellows : ${grid.health.yellows.join(", ")}`);
  lines.push("├─ 1. Soul Genome");
  const sg = grid.steps.soul_genome;
  if (sg.ok) {
    lines.push(`│   sovereign : ${sg.sovereign?.alias || sg.sovereign?.name || "?"}`);
    lines.push(`│   sha256    : ${sg.genome_sha256.slice(0, 16)}…  bytes:${sg.bytes}`);
  } else {
    lines.push(`│   FAIL : ${sg.reason}`);
  }
  lines.push("├─ 2. Continuity Packet");
  const c = grid.steps.continuity;
  if (c.ok) {
    lines.push(`│   date      : ${c.date}   stale:${c.stale}   src:${c.source}`);
    lines.push(`│   progress  : ${c.summary.progress_count}   blockers:${c.summary.open_blockers_count}`);
    if (c.summary.tomorrow_first_action) {
      lines.push(`│   next      : ${String(c.summary.tomorrow_first_action).slice(0, 60)}`);
    }
  } else {
    lines.push(`│   FAIL : ${c.reason}`);
  }
  lines.push("├─ 3. 27 Guardrails");
  const g = grid.steps.guardrails;
  if (g.ok || g.violations_count != null) {
    lines.push(`│   reds:${g.violations_count || 0}   stop:${g.stop}   via:${g.transport}   ${fmtDuration(g.elapsed_ms_check)}`);
    for (const v of (g.violations || []).slice(0, 6)) {
      lines.push(`│     • ${v.guardrail_id} [${v.severity}] ${v.name}`);
    }
  } else {
    lines.push(`│   FAIL : ${g.reason}`);
  }
  lines.push("├─ 4. Hot Currents (24h)");
  const hc = grid.steps.hot_currents;
  if (hc.ok) {
    lines.push(`│   count : ${hc.count}   src:${hc.source}   stale:${hc.stale}`);
    for (const x of (hc.currents || []).slice(0, 4)) {
      lines.push(`│     • ${x.event_type || "?"}  ${String(x.title || "").slice(0, 50)}`);
    }
  } else {
    lines.push(`│   FAIL : ${hc.reason}`);
  }
  lines.push("├─ 5. Not-Green Ledger");
  const ng = grid.steps.not_green_ledger;
  if (ng.ok) {
    lines.push(`│   open  : ${ng.total_open}`);
    for (const s of ng.sections) {
      lines.push(`│     [${s.count}] ${s.section}`);
    }
  } else {
    lines.push(`│   FAIL : ${ng.reason}`);
  }
  lines.push("├─ 6. Boot Receipt");
  lines.push(`│   ${grid.receipt?.path || "(skipped)"}`);
  lines.push(`│   sha256: ${grid.receipt?.sha256?.slice(0, 32) || "-"}`);
  lines.push("╰──────────────────────────────────────────────────────────");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 6 — Boot receipt writer

function writeBootReceipt(grid, { dir = RECEIPTS_DIR } = {}) {
  const date = isoDate();
  const id = `${date}-session-start-${grid.session_id.slice(0, 8)}`;
  mkdirSync(dir, { recursive: true });
  const jsonPath = resolve(dir, `${id}.json`);
  const mdPath = resolve(dir, `${id}.md`);
  // The hash is computed over the deterministic JSON serialization of the
  // grid WITH the `receipt` field cleared, so the receipt can record its own
  // hash without a circular dependency.
  const { receipt: _ignored, ...gridForHash } = grid;
  const canonical = safeStringify(gridForHash);
  const hash = sha256(canonical);
  const receipt = {
    receipt_id: id,
    schema: "orange5.session-start-receipt.v1",
    generated_at: grid.generated_at,
    session_id: grid.session_id,
    grid_sha256: hash,
    health: grid.health,
    summary: {
      soul_genome_ok: !!grid.steps.soul_genome?.ok,
      continuity_ok: !!grid.steps.continuity?.ok,
      continuity_stale: !!grid.steps.continuity?.stale,
      guardrails_violations: grid.steps.guardrails?.violations_count ?? null,
      guardrails_stop: !!grid.steps.guardrails?.stop,
      hot_currents_count: grid.steps.hot_currents?.count ?? null,
      not_green_open: grid.steps.not_green_ledger?.total_open ?? null,
    },
    grid: gridForHash,
  };
  writeFileSync(jsonPath, JSON.stringify(receipt, null, 2), "utf8");
  // Tiny human-readable index file — one screen, points at the JSON for full data.
  const md = [
    `# Receipt — Session Start ${id}`,
    "",
    `**Schema:** \`orange5.session-start-receipt.v1\``,
    `**Generated:** ${grid.generated_at}`,
    `**Session ID:** \`${grid.session_id}\``,
    `**Grid SHA-256:** \`${hash}\``,
    `**Health:** \`${grid.health.band}\``,
    "",
    "```",
    renderDeployGrid({ ...grid, receipt: { path: jsonPath, sha256: hash } }),
    "```",
    "",
    `Full grid JSON: \`${jsonPath}\``,
    "",
  ].join("\n");
  writeFileSync(mdPath, md, "utf8");
  return { path: jsonPath, md_path: mdPath, sha256: hash, receipt_id: id };
}

// ---------------------------------------------------------------------------
// Cache

function readCache() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const txt = readFileSync(CACHE_PATH, "utf8");
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== "object" || !obj.grid) return null;
    const age = nowMs() - (obj.cached_at || 0);
    if (age > TTL_MS) return { stale: true, grid: obj.grid, cached_at: obj.cached_at, age_ms: age };
    return { stale: false, grid: obj.grid, cached_at: obj.cached_at, age_ms: age };
  } catch {
    return null;
  }
}

function writeCacheGrid(grid) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ schema: SCHEMA, cached_at: nowMs(), grid }, null, 2),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — runRitual

/**
 * Run the full session-start ritual and return a SessionStartGrid.
 *
 * Options
 * -------
 *   force        : bypass TTL cache
 *   skipReceipt  : skip step 6
 *   gateway      : override gateway base URL
 *   skipGateway  : skip gateway transport for steps 2 + 3 (in-process only)
 *   fluxAdapter  : injectable flux adapter (test seam)
 *
 * Return
 * ------
 *   { ok, grid, cache_hit, receipt_path, fetched_at }
 *   Never throws on the request path.
 */
export async function runRitual(opts = {}) {
  const fetched_at = nowMs();
  // Cache fast-path.
  if (!opts.force) {
    const c = readCache();
    if (c && !c.stale) {
      return {
        ok: true,
        cache_hit: true,
        grid: c.grid,
        receipt_path: c.grid?.receipt?.path || null,
        fetched_at,
        cache_age_ms: c.age_ms,
      };
    }
  }

  const session_id = randomUUID();
  const t0 = performance.now();

  // Steps 1–5 in parallel. Each returns its own ok/reason — Promise.all
  // never rejects because each step swallows its own errors into a result.
  const [soul_genome, continuity, guardrails, hot_currents, not_green_ledger] =
    await Promise.all([
      Promise.resolve().then(() => loadSoulGenome()),
      loadContinuity({ gateway: opts.gateway, skipGateway: opts.skipGateway }),
      runGuardrailsSweep({ gateway: opts.gateway, skipGateway: opts.skipGateway }),
      queryHotCurrents({ adapter: opts.fluxAdapter }),
      Promise.resolve().then(() => readNotGreenLedgerTop()),
    ]);

  const steps = { soul_genome, continuity, guardrails, hot_currents, not_green_ledger };
  const health = deriveHealth({ steps });
  const elapsed_ms = Math.round(performance.now() - t0);

  // Pre-receipt grid — receipt field added after step 6.
  const grid = {
    schema: SCHEMA,
    session_id,
    generated_at: isoNow(),
    elapsed_ms,
    cache_hit: false,
    health,
    steps,
    receipt: null,
  };

  // Step 6 — emit receipt unless skipped.
  let receipt = null;
  if (!opts.skipReceipt) {
    try {
      receipt = writeBootReceipt(grid);
      grid.receipt = receipt;
    } catch (e) {
      // Receipt failure is a real fact — record it but don't throw.
      grid.receipt = { error: String(e?.message || e) };
      health.yellows.push("receipt:write_failed");
    }
  }

  // Cache the finished grid (even if health is RED — we want to surface the
  // same red on repeated boots within the TTL window).
  writeCacheGrid(grid);

  return {
    ok: true,
    cache_hit: false,
    grid,
    receipt_path: receipt?.path || null,
    fetched_at,
  };
}

// ---------------------------------------------------------------------------
// Gateway handler — POST /v1/session/start

export async function sessionStartHandler(req, res) {
  try {
    if (req.method && req.method.toUpperCase() !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      res.end(JSON.stringify({ ok: false, reason: "method_not_allowed", allow: "POST" }));
      return;
    }
    // Body is optional; read defensively.
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length) {
        const txt = Buffer.concat(chunks).toString("utf8");
        if (txt.trim()) body = JSON.parse(txt);
      }
    } catch {
      body = {};
    }
    const out = await runRitual({ force: !!body.force, skipReceipt: !!body.skipReceipt });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      reason: "orchestrator_threw",
      detail: String(e?.message || e),
    }));
  }
}

export const routes = Object.freeze({
  "POST /v1/session/start": sessionStartHandler,
});

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { pretty: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") args.pretty = true;
    else if (a === "--display") args.display = true;
    else if (a === "--force") args.force = true;
    else if (a === "--no-receipt") args.skipReceipt = true;
    else if (a === "--skip-gateway") args.skipGateway = true;
    else if (a === "--gateway") args.gateway = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function helpText() {
  return [
    "Orange5 Session-Start Orchestrator",
    "",
    "Usage:",
    "  node orchestrator.mjs [--pretty] [--display] [--force]",
    "                        [--no-receipt] [--skip-gateway]",
    "                        [--gateway http://127.0.0.1:1337]",
    "",
    "Exit codes: 0 ok, 2 grid built with stop-level reds, 1 hard error.",
  ].join("\n");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch { return false; }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) { process.stdout.write(helpText() + "\n"); process.exit(0); }
  runRitual(args).then(
    (out) => {
      if (args.display) {
        process.stdout.write(renderDeployGrid(out.grid) + "\n");
      } else {
        const txt = args.pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out);
        process.stdout.write(txt + "\n");
      }
      const stop = out.grid?.steps?.guardrails?.stop === true;
      process.exit(stop ? 2 : 0);
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

export default runRitual;
