// AE OrangeLLM — Guardrails / Soul Genome / Continuity Packet gateway routes
// Path: 06-ORANGELLM/server/routes/guardrails.mjs
//
// Doctrine:
//   - 27 Constitutional Guardrails: enumerated invariants the system MUST
//     preserve. The doctrine layer at 01-DOCTRINE/27-guardrails owns the
//     checks, registry, runtime, and SQLite store. THIS module is the
//     gateway-side reverse-proxy: it wraps the lib so the frontier
//     boundary can read/run without bypassing the boundary law.
//   - Soul Genome: file-based JSON at state/soul-genome.json. Single
//     source of truth. Read is open; write is operator-gated by
//     ATOMEONS_IDENTITY_SECRET (env-only, never hardcoded).
//   - Continuity Packet: cron-written daily JSON. Read-only here — writes
//     go through the cron job in lib/continuity-packet.mjs so the gateway
//     never authors continuity content (Mom's Law: receipts only, no
//     theater, no silent fall-back).
//
// Routes:
//   GET  /v1/guardrails/status        — last persisted run (run_id, ok,
//                                       violations[], elapsed_ms, ts)
//   POST /v1/guardrails/run           — run all 27 checks now, persist,
//                                       optionally flux. Operator-gated.
//   GET  /v1/genome                   — current Soul Genome (auto-init on
//                                       first read)
//   POST /v1/genome                   — update Soul Genome. Operator-gated.
//                                       Body: { genome: { ... } } where
//                                       genome.schema must be v1.
//   GET  /v1/continuity-packet        — most recent continuity packet
//                                       (today's, else most recent on disk)
//
// HTTP shape (consistent with sibling routes):
//   Success: { ...payload }
//   Error:   { error: { code, message, ... }, _ae_http_status: N }
//
// The handler functions return a plain object; the dispatcher in index.mjs
// strips _ae_http_status and serializes the rest as JSON. Sentinel-shaped
// for parity with v1.mjs / receipts.mjs.

import { runGuardrails } from "../../../01-DOCTRINE/27-guardrails/runtime.mjs";
import { latestRun } from "../../../01-DOCTRINE/27-guardrails/lib/db.mjs";
import {
  ensureSoulGenome,
  readSoulGenome,
  writeSoulGenome,
  soulGenomeIsHealthy,
} from "../../../01-DOCTRINE/27-guardrails/lib/soul-genome.mjs";
import {
  loadMostRecentContinuity,
  readContinuity,
} from "../../../01-DOCTRINE/27-guardrails/lib/continuity-packet.mjs";
import {
  GUARDRAILS_ALLOWED,
  isGuardrailsRouteAllowed,
  OPERATOR_TOKEN_HEADER,
} from "./guardrails-boundary.mjs";

export { GUARDRAILS_ALLOWED, isGuardrailsRouteAllowed };

// ---------------------------------------------------------------------------
// HTTP shape helpers (mirror receipts.mjs)
// ---------------------------------------------------------------------------

function ok(body) { return body; }

function err(status, code, message, extra = {}) {
  return {
    error: { code, message, ...extra },
    _ae_http_status: status,
  };
}

// ---------------------------------------------------------------------------
// Operator gate
// ---------------------------------------------------------------------------
//
// Guardrail #6: ATOMEONS_IDENTITY_SECRET env-only, never hardcoded.
// The gate compares constant-time to defeat timing-leak probing.
//
// If the env var is unset, every operator-gated POST is REJECTED. The
// system is fail-closed by design: no secret means no operator presence,
// which means no write authority.

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function checkOperator(headers) {
  const secret = process.env.ATOMEONS_IDENTITY_SECRET;
  if (!secret || typeof secret !== "string" || secret.length < 8) {
    return {
      ok: false,
      reason: "operator_secret_unset",
      detail: "ATOMEONS_IDENTITY_SECRET is unset or too short on this host. Operator-gated writes are fail-closed.",
    };
  }
  const presented = headers?.[OPERATOR_TOKEN_HEADER];
  if (!presented || typeof presented !== "string") {
    return {
      ok: false,
      reason: "operator_token_missing",
      detail: `Missing header: ${OPERATOR_TOKEN_HEADER}`,
    };
  }
  if (!constantTimeEqual(presented, secret)) {
    return {
      ok: false,
      reason: "operator_token_mismatch",
      detail: "Operator token did not match the env-bound secret.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GET /v1/guardrails/status
// ---------------------------------------------------------------------------
//
// Returns the last run summary, normalized for gateway consumers.
//
// Shape:
//   {
//     ok: boolean,                          // last run had zero violations
//     run_id: string | null,
//     started_at: number | null,            // epoch ms
//     finished_at: number | null,
//     elapsed_ms: number | null,
//     stop: boolean,                        // CRITICAL/HIGH triggered
//     total_checks: number,
//     violations: [
//       { guardrail_id, severity, name?, details? }
//     ],
//     backend: "sqlite" | "jsonl" | null,   // persistence layer used
//     fresh: boolean                        // true if a run was found
//   }

export async function handleGuardrailsStatus() {
  let run = null;
  try {
    run = await latestRun();
  } catch (e) {
    return err(500, "guardrails_status_read_failed", String(e?.message || e));
  }
  if (!run) {
    return ok({
      ok: false,
      fresh: false,
      run_id: null,
      started_at: null,
      finished_at: null,
      elapsed_ms: null,
      stop: false,
      total_checks: 0,
      violations: [],
      backend: null,
      note: "no guardrail run on record — POST /v1/guardrails/run to seed",
    });
  }
  const results = Array.isArray(run.results) ? run.results : [];
  const violations = results
    .filter(r => !r.pass)
    .map(r => ({
      guardrail_id: r.guardrail_id,
      severity: r.severity,
      name: r.name || null,
      details: typeof r.details === "string"
        ? safeParseJson(r.details)
        : (r.details ?? null),
    }));
  const stop = violations.some(v => v.severity === "CRITICAL" || v.severity === "HIGH");
  return ok({
    ok: !!run.ok && violations.length === 0,
    fresh: true,
    run_id: run.run_id,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    elapsed_ms: run.elapsed_ms ?? null,
    stop,
    total_checks: results.length,
    violations,
    backend: run.backend || (run.run_id ? "sqlite" : null),
  });
}

function safeParseJson(s) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// POST /v1/guardrails/run
// ---------------------------------------------------------------------------
//
// Body (optional):
//   { write_to_flux?: boolean, timeout_ms_per_check?: number }
//
// Header (required):
//   x-ae-operator-token: <ATOMEONS_IDENTITY_SECRET>
//
// Why operator-gate a "read-shaped" run? Because runtime.mjs writes to the
// SQLite store, may write to Flux, and consumes wall-clock budget. We don't
// want a frontier model triggering sweeps as a side-channel.

export async function handleGuardrailsRun(body, headers) {
  const gate = checkOperator(headers);
  if (!gate.ok) {
    return err(403, "operator_gate_denied", gate.detail, { reason: gate.reason });
  }
  const opts = {
    write_to_flux: body?.write_to_flux === false ? false : true,
    persist: true,
    timeout_ms_per_check: clampTimeout(body?.timeout_ms_per_check),
  };
  let out;
  try {
    out = await runGuardrails(opts);
  } catch (e) {
    return err(500, "guardrails_run_failed", String(e?.message || e));
  }
  // Trim the response: don't echo every check's full details on a fresh-run
  // response — that's what GET /v1/guardrails/status is for. Return the
  // summary the cockpit needs to render the banner.
  return ok({
    ok: out.ok,
    run_id: out.run_id,
    started_at: out.started_at,
    finished_at: out.finished_at,
    elapsed_ms: out.elapsed_ms,
    stop: out.stop,
    total_checks: out.results.length,
    violations: out.violations,
    backend: out.backend,
    flux: out.flux,
  });
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 8000;
  // Cap at 30s/check so the route can't be used to wedge the gateway.
  return Math.min(Math.max(Math.round(n), 100), 30_000);
}

// ---------------------------------------------------------------------------
// GET /v1/genome
// ---------------------------------------------------------------------------
//
// Auto-initializes the genome on first read (writes the default skeleton)
// then returns it. Returns a 500 if the file is unreadable.

export async function handleGenomeGet() {
  let g;
  try {
    g = ensureSoulGenome();
  } catch (e) {
    return err(500, "soul_genome_read_failed", String(e?.message || e));
  }
  if (g && g._read_error) {
    return err(500, "soul_genome_read_failed", g._read_error, { path: g._path });
  }
  const health = soulGenomeIsHealthy(g);
  return ok({
    genome: g,
    health,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/genome
// ---------------------------------------------------------------------------
//
// Body: { genome: { schema: "orange5.soul-genome.v1", ... } }
// Header: x-ae-operator-token (required, matches env)
//
// The whole-file replace pattern is intentional. Partial patches would
// silently drop intent_anchors or operator identity facts on schema drift.
// Operator must POST the full v1 document; the writer stamps updated_at.

export async function handleGenomePost(body, headers) {
  const gate = checkOperator(headers);
  if (!gate.ok) {
    return err(403, "operator_gate_denied", gate.detail, { reason: gate.reason });
  }
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "Body must be a JSON object containing { genome }.");
  }
  const next = body.genome;
  if (!next || typeof next !== "object") {
    return err(400, "missing_genome", "Body must include a 'genome' object.");
  }
  if (typeof next.schema !== "string" || !next.schema.startsWith("orange5.soul-genome.")) {
    return err(422, "schema_mismatch",
      "genome.schema must be a string starting with 'orange5.soul-genome.' (currently v1).");
  }
  // Round-trip preflight: serialize to JSON, ensure it's not absurdly large.
  let preflight;
  try {
    preflight = JSON.stringify(next);
  } catch (e) {
    return err(422, "genome_not_serializable", String(e?.message || e));
  }
  if (preflight.length > 256 * 1024) {
    return err(413, "genome_too_large",
      `Soul Genome must be <= 256KB; received ${preflight.length} bytes.`);
  }
  let write;
  try {
    write = writeSoulGenome(next);
  } catch (e) {
    return err(500, "soul_genome_write_failed", String(e?.message || e));
  }
  // Reload from disk so the response reflects what was actually persisted
  // (including the writer-stamped updated_at).
  const after = readSoulGenome();
  const health = soulGenomeIsHealthy(after);
  return ok({
    written: true,
    path: write.path,
    sha256: write.sha256,
    genome: after,
    health,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/continuity-packet
// ---------------------------------------------------------------------------
//
// Returns today's packet if present, else the most recent. If no packet
// has ever been written, returns { present: false } so the frontier can
// boot without it and the cron will catch up at 23:55.

export async function handleContinuityPacketGet() {
  // Prefer today's, fall back to most recent on disk.
  let today = null;
  try {
    today = readContinuity();
  } catch (e) {
    return err(500, "continuity_read_failed", String(e?.message || e));
  }
  if (today && !today._read_error) {
    return ok({ present: true, source: "today", packet: today });
  }
  let recent = null;
  try {
    recent = loadMostRecentContinuity();
  } catch (e) {
    return err(500, "continuity_read_failed", String(e?.message || e));
  }
  if (recent) {
    return ok({ present: true, source: "most_recent", date: recent.date, packet: recent.data });
  }
  return ok({
    present: false,
    note: "no continuity packet on disk yet — cron writes at 23:55 local",
  });
}

// ---------------------------------------------------------------------------
// Dispatcher — called from server/index.mjs
// ---------------------------------------------------------------------------
//
// Returns { status, body } on a matched route, or null when the path is
// not in the guardrails namespace (so the main switch falls through to
// 404).

export async function dispatchGuardrails(req, url, { readBody }) {
  const method = req.method.toUpperCase();
  const path = url.pathname;
  const headers = req.headers || {};

  if (!isGuardrailsRouteAllowed(method, path)) {
    // Not ours — let the main dispatcher handle.
    return null;
  }

  let result;
  if (method === "GET" && path === "/v1/guardrails/status") {
    result = await handleGuardrailsStatus();
  } else if (method === "POST" && path === "/v1/guardrails/run") {
    const body = await safeReadBody(req, readBody);
    if (body && body._ae_http_status) return body;
    result = await handleGuardrailsRun(body, headers);
  } else if (method === "GET" && path === "/v1/genome") {
    result = await handleGenomeGet();
  } else if (method === "POST" && path === "/v1/genome") {
    const body = await safeReadBody(req, readBody);
    if (body && body._ae_http_status) return body;
    result = await handleGenomePost(body, headers);
  } else if (method === "GET" && path === "/v1/continuity-packet") {
    result = await handleContinuityPacketGet();
  } else {
    return null;
  }
  return result;
}

async function safeReadBody(req, readBody) {
  try {
    return await readBody(req);
  } catch (e) {
    return err(400, "invalid_body", String(e?.message || e));
  }
}

// Path-prefix detector so the main index.mjs can ask "is this a guardrails
// path at all?" before doing anything else.
export function isGuardrailsPath(pathname) {
  return (
    pathname === "/v1/guardrails/status" ||
    pathname === "/v1/guardrails/run" ||
    pathname === "/v1/genome" ||
    pathname === "/v1/continuity-packet"
  );
}
