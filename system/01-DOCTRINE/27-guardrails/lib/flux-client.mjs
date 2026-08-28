// flux-client.mjs — writes guardrail violations to the Reality Flux ledger.
//
// We bypass the 11-MIRAGE adapter module-import to keep this checker
// dependency-free of the rest of Orange5 — we speak the same protocol
// directly via fetch. Origin is set to "doctrine.guardrails" which the
// daemon classifies into the reality lane (receipts/terminal origin).
//
// If the daemon is unreachable, violations are spooled to
// state/flux-spool.jsonl and replayed by the daemon's catch-up worker on
// next reachable POST.

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COBRA_BASE, STATE_DIR } from "./paths.mjs";

const SPOOL_PATH = resolve(STATE_DIR, "flux-spool.jsonl");
const FETCH_TIMEOUT_MS = parseInt(process.env.GUARDRAILS_FLUX_TIMEOUT_MS || "10000", 10);

function ensureSpoolDir() {
  mkdirSync(dirname(SPOOL_PATH), { recursive: true });
}

async function tryFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function writeViolationsToFlux({ run_id, violations, ok, elapsed_ms, origin }) {
  if (!Array.isArray(violations) || violations.length === 0) {
    return { ok: true, wrote: 0, source: "noop" };
  }
  // Spec (2026-06-24 rewrite brief): tag origin=guardrails on the
  // Reality-lane event. Sub-origin "doctrine.guardrails" is preserved on
  // every violation row so existing consumers that match the longer tag
  // still resolve.
  const evidenceFiles = violations.flatMap((item) => {
    const values = item?.details?.offenders || item?.details?.files || [];
    return Array.isArray(values) ? values.map((value) => typeof value === "string" ? value : value?.file).filter(Boolean) : [];
  }).slice(0, 20);
  const evt = {
    origin: typeof origin === "string" && origin.length > 0 ? origin : "doctrine.guardrails",
    fallback_lane: "reality",
    event: {
      event_type: "risk",
      summary: `Guardrail run ${run_id}: ${violations.length} violation(s)`,
      entities: violations.map((item) => item.guardrail_id).slice(0, 20),
      files: evidenceFiles,
      commands: ["node 01-DOCTRINE/27-guardrails/runtime.mjs"],
      risk: violations.some((item) => ["CRITICAL", "HIGH"].includes(String(item.severity))) ? "high" : "medium",
      next_action: "Resolve the recorded guardrail violations and rerun the witness.",
      confidence: 0.8,
      evidence: {
        run_id,
        overall_ok: String(!!ok),
        elapsed_ms: String(elapsed_ms),
        violations_json: JSON.stringify(violations),
      },
    },
  };
  const r = await tryFetch(`${COBRA_BASE}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evt),
  });
  if (r.ok) {
    return { ok: true, wrote: violations.length, source: "cobra_loopback", receipt: r.body };
  }
  // Spool for replay
  ensureSpoolDir();
  appendFileSync(SPOOL_PATH, JSON.stringify(evt) + "\n", "utf8");
  return {
    ok: false,
    wrote: 0,
    spooled: violations.length,
    spool_path: SPOOL_PATH,
    detail: r.err || `cobra ${r.status}`,
  };
}

export async function fluxHealthz() {
  const r = await tryFetch(`${COBRA_BASE}/healthz`, { method: "GET" });
  if (r.ok) return { ok: true, source: "cobra_loopback", cobra: r.body };
  return { ok: false, detail: r.err || `cobra ${r.status}` };
}

function normalizeSpooledEvent(row) {
  if (row?.event && row?.origin) return row;
  const violations = Array.isArray(row?.violations) ? row.violations : [];
  const evidenceFiles = violations.flatMap((item) => {
    const values = item?.details?.offenders || item?.details?.files || [];
    return Array.isArray(values) ? values.map((value) => typeof value === "string" ? value : value?.file).filter(Boolean) : [];
  }).slice(0, 20);
  return {
    origin: row?.origin === "guardrails" ? "doctrine.guardrails" : (row?.origin || "doctrine.guardrails"),
    fallback_lane: "reality",
    event: {
      event_type: "risk",
      summary: `Guardrail run ${row?.run_id || "legacy"}: ${violations.length} violation(s)`,
      entities: violations.map((item) => item.guardrail_id).filter(Boolean).slice(0, 20),
      files: evidenceFiles,
      commands: ["node 01-DOCTRINE/27-guardrails/runtime.mjs"],
      risk: violations.some((item) => ["CRITICAL", "HIGH"].includes(String(item.severity))) ? "high" : "medium",
      next_action: "Resolve the recorded guardrail violations and rerun the witness.",
      confidence: 0.8,
      evidence: {
        run_id: String(row?.run_id || "legacy"),
        overall_ok: String(!!row?.overall_ok),
        elapsed_ms: String(row?.elapsed_ms ?? 0),
        violations_json: JSON.stringify(violations),
      },
    },
  };
}

export async function replayFluxSpool() {
  if (!existsSync(SPOOL_PATH)) return { ok: true, replayed: 0, remaining: 0 };
  const rows = readFileSync(SPOOL_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  const remaining = [];
  const failures = [];
  let replayed = 0;
  for (const line of rows) {
    let row;
    try { row = JSON.parse(line); } catch { remaining.push(line); continue; }
    const envelope = normalizeSpooledEvent(row);
    const result = await tryFetch(`${COBRA_BASE}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (result.ok && result.body?.accepted === true) replayed += 1;
    else {
      remaining.push(line);
      if (failures.length < 3) failures.push({ status: result.status, body: result.body, err: result.err });
    }
  }
  const temp = `${SPOOL_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, remaining.length ? `${remaining.join("\n")}\n` : "", "utf8");
  renameSync(temp, SPOOL_PATH);
  return { ok: remaining.length === 0, replayed, remaining: remaining.length, failures, spool_path: SPOOL_PATH };
}
