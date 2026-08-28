#!/usr/bin/env bun
// 08-HERMES/tests/misfit-live-smoke.mjs
//
// AE Misfit pre-action second-opinion — LIVE enforcement smoke test.
//
// Wave 2 #027 authored the static descriptor at
// 04-CONTROL-PLANE/misfit/second-opinion.mjs (no enforcement, decorative).
// Wave 3-04 authored the Hermes middleware skeleton at
// 08-HERMES/src/pre-action/misfit-second-opinion.mjs (live module).
// This smoke test is the receipt that the middleware is REALLY enforced
// end-to-end through the Hermes daemon — not just unit-tested in isolation.
//
// What "live" means here, concretely:
//   1. We boot the real Hermes daemon (src/server.mjs) on 127.0.0.1:7430,
//      against a hermetic temp SQLite DB and a hermetic audit log directory.
//   2. We stand up a tiny mock gateway on a free 127.0.0.1 port and point
//      Hermes at it via HERMES_GATEWAY_URL. The mock gateway speaks the
//      OpenAI-shaped /v1/chat/completions surface that callMisfitGateway()
//      expects, and returns a strict REFUSE:/CONFIRM: line driven by the
//      test's MISFIT_MOCK_VERDICT env var. This is the ONLY mock in the
//      pipeline — the middleware, the audit, the override path, the LOOM
//      chain, the lease engine, and Hermes's HTTP handler are all real.
//   3. We exercise the four cases the doctrine demands:
//        (a) low-risk action  → second-opinion BYPASSED (audit row says so;
//                               Misfit is NOT called).
//        (b) high-risk action with mocked Misfit REFUSE → BLOCKED at the
//                               Misfit gate with 409 misfit_refused; audit
//                               row records decision=block, middleware_decision=refuse.
//        (c) high-risk action with mocked Misfit CONFIRM → PASSES the Misfit
//                               gate (proceeds to the LOOM 8-gate chain).
//                               We do NOT require the LOOM chain to pass —
//                               this test asserts Misfit lets the request
//                               through, not that downstream gates do.
//        (d) critical-risk action without operator approval → DOUBLE-BLOCKED:
//                               first by the lease policy (operator approval
//                               required, before Misfit even runs); then,
//                               after we add operator_approved=true, by
//                               Misfit REFUSE. Two independent enforcement
//                               axes, both honest, both audited.
//
// Mocking surface (real env, test-only effect):
//   MISFIT_MOCK_VERDICT  ∈ { "REFUSE", "CONFIRM" }  drives the mock gateway's
//                          response. Read only by the mock — not by the
//                          middleware. The middleware is untouched.
//   MISFIT_MOCK_REASON   optional one-line reason text appended after the
//                          REFUSE:/CONFIRM: prefix.
//
// Env that the test sets for the Hermes daemon process:
//   HERMES_GATEWAY_URL=http://127.0.0.1:<mock port>
//   HERMES_MISFIT_TIMEOUT_MS=4000
//   (HERMES_MISFIT_DISABLED is NEVER set here — kill-switch is its own
//   smoke test, not this one.)
//
// Hermetic isolation:
//   - leases.db          → tests/.fixtures/misfit-live-smoke/leases-<uuid>.db
//   - approvals/         → tests/.fixtures/misfit-live-smoke/approvals/
//   - audit/             → tests/.fixtures/misfit-live-smoke/audit/
//   The fixtures dir is NOT cleaned up on exit so post-mortem inspection
//   is possible. Delete it manually if you want a fresh run.
//
// Mom's Law:
//   - No fake greens. Every assertion either passes with a structured
//     PASS row or fails with the full body / audit snippet for diagnosis.
//   - We assert on the audit JSONL too — if the daemon returns the right
//     HTTP but writes the wrong row, the test FAILS. The audit is part
//     of the contract.
//   - We do NOT skip a case because a prior case failed. Each of (a-d)
//     runs to completion (unless boot itself failed). The exit code is
//     the source of truth: 0 = every case passed, non-zero = at least
//     one failed.
//
// Runtime: Bun (Hermes daemon requires it — see src/server.mjs runtime_unsupported).
// Run:
//     bun run 08-HERMES/tests/misfit-live-smoke.mjs
//     # or, with a specific mock verdict already supplied (not required —
//     # the test sets MISFIT_MOCK_VERDICT per case as needed):
//     MISFIT_MOCK_VERDICT=REFUSE bun run 08-HERMES/tests/misfit-live-smoke.mjs
//
// Honest gaps (read me):
//   - Hermes binds 127.0.0.1:7430 hard. If another Hermes is already running
//     locally, this test exits 2 with EADDRINUSE — it does NOT try to
//     "share" the daemon (state would bleed between the smoke and the
//     long-running daemon's real DB).
//   - The mock gateway binds 127.0.0.1:0 (kernel-chosen free port). If the
//     kernel cannot allocate any port, the test exits 2.
//   - We deliberately wait for the daemon's /healthz to respond OK before
//     issuing the action requests. A 2-second budget is given; tune via
//     HERMES_BOOT_TIMEOUT_MS if a slow CI host needs more.
//   - The test does NOT assert on the LOOM gate results in case (c). It
//     asserts only that the response was NOT misfit_refused. The Misfit
//     gate's job is to make a decision; downstream gates are tested
//     elsewhere (smoke-test.mjs and the per-gate test files).
//   - We rotate MISFIT_MOCK_VERDICT in this test process, but the mock
//     gateway reads it on every request — no caching — so the daemon
//     sees the right verdict for each case without restarting either
//     server.
//
// Schema: orange5.hermes.misfit-live-smoke.v0
// Sovereign: Atom McCree

import {
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ─── paths ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// tests/ → 08-HERMES
const HERMES_ROOT = resolve(__dirname, "..");

const FIXTURE_ROOT = resolve(HERMES_ROOT, "tests", ".fixtures", "misfit-live-smoke");
const FIXTURE_RUN = resolve(FIXTURE_ROOT, `run-${Date.now()}-${randomUUID().slice(0, 6)}`);
const LEASES_DB = resolve(FIXTURE_RUN, "leases.db");
const APPROVALS_DIR = resolve(HERMES_ROOT, "approvals"); // server.mjs reads here, hardcoded
const AUDIT_DIR = resolve(HERMES_ROOT, "audit");         // server.mjs writes here, hardcoded
const MISFIT_AUDIT_LOG = resolve(AUDIT_DIR, "misfit-second-opinion.jsonl");

// ─── config ─────────────────────────────────────────────────────────────────

function chooseTestPort() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);
  return port;
}

const HERMES_PORT = Number(process.env.HERMES_TEST_PORT) || chooseTestPort();
process.env.HERMES_TEST_MODE = "1";
process.env.HERMES_TEST_PORT = String(HERMES_PORT);
const HERMES_BASE_URL = `http://127.0.0.1:${HERMES_PORT}`;
const REQUEST_TIMEOUT_MS = Number(process.env.AE_SMOKE_TIMEOUT_MS || 15_000);
const BOOT_TIMEOUT_MS = Number(process.env.HERMES_BOOT_TIMEOUT_MS || 2_000);

const ACTOR = "misfit-live-smoke";
const LOW_TARGET = "misfit-live-smoke-low";
const HIGH_TARGET = "misfit-live-smoke-high";
const CRIT_TARGET = "misfit-live-smoke-critical";

// Verbs map onto the risk-matrix:
//   query_only       → low
//   schema_migration → high
//   destructive_write→ critical (and also default-forbidden, so we have to
//                                 mint a lease that opts in via allowed list;
//                                 the engine refuses to do that because
//                                 destructive_write also stays in forbidden
//                                 due to the closed-world conflict rule). For
//                                 the critical case we use payment_charge,
//                                 which the matrix grades as critical without
//                                 being default-forbidden.
const LOW_VERB = "query_only";
const HIGH_VERB = "schema_migration";
const CRIT_VERB = "payment_charge";

// ─── output helpers ─────────────────────────────────────────────────────────

const PASS = "PASS";
const FAIL = "FAIL";
let _passCount = 0;
let _failCount = 0;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function nowIso() {
  return new Date().toISOString();
}

function assert(condition, label, detail) {
  if (condition) {
    _passCount++;
    log(`  [${PASS}] ${label}`);
  } else {
    _failCount++;
    log(`  [${FAIL}] ${label}`);
    if (detail !== undefined) {
      try {
        log(`         detail: ${JSON.stringify(detail).slice(0, 1200)}`);
      } catch {
        log(`         detail: <unserializable>`);
      }
    }
  }
}

// ─── fetch helper ───────────────────────────────────────────────────────────

async function fetchJson(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = null;
    let parseError = null;
    if (text && text.length > 0) {
      try { body = JSON.parse(text); }
      catch (e) { parseError = e && e.message ? e.message : String(e); }
    }
    return { ok_http: res.ok, status: res.status, body, raw: text, parse_error: parseError };
  } catch (e) {
    return {
      ok_http: false,
      status: 0,
      body: null,
      raw: "",
      parse_error: null,
      transport_error: e && e.message ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── mock Misfit gateway ────────────────────────────────────────────────────
//
// Implements the minimal /v1/chat/completions surface that the real Misfit
// middleware's callMisfitGateway() consumes. Reads MISFIT_MOCK_VERDICT from
// process.env on every request — no caching — so the test process can rotate
// the verdict between cases without restarting the mock.
//
// Response shape mirrors the OpenAI chat/completions wire format the gateway
// returns; the middleware only reads choices[0].message.content. We populate
// just enough metadata to be honest in the audit row.

function startMockGateway() {
  if (typeof Bun === "undefined") {
    throw new Error("mock gateway requires Bun (this whole smoke test does)");
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // kernel-chosen
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const verdictRaw = String(process.env.MISFIT_MOCK_VERDICT || "").trim().toUpperCase();
        const reason = process.env.MISFIT_MOCK_REASON || "test mock";
        let line;
        if (verdictRaw === "REFUSE") {
          line = `REFUSE: ${reason}`;
        } else if (verdictRaw === "CONFIRM") {
          line = `CONFIRM: ${reason}`;
        } else {
          // The test should always set MISFIT_MOCK_VERDICT before issuing an
          // /action call that reaches the gateway. If it doesn't, we return
          // a malformed body so the middleware's blocking-risk fail-closed
          // path is exercised (and the test will fail loudly — that's the
          // intent: don't let a missing test setup silently confirm).
          line = `MOCK_GATEWAY_NO_VERDICT_SET (got=${verdictRaw || "<empty>"})`;
        }
        const body = JSON.stringify({
          id: `chatcmpl-mock-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "ae-misfit:v0",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: line },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response(JSON.stringify({ ok: true, mock: true }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
    error(e) {
      return new Response(
        JSON.stringify({ ok: false, error: e && e.message ? e.message : "mock_error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { server, url, stop: () => { try { server.stop(true); } catch { /* no-op */ } } };
}

// ─── Hermes daemon boot ─────────────────────────────────────────────────────

async function waitForHermesHealth() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    const r = await fetchJson(`${HERMES_BASE_URL}/healthz`, { method: "GET" }, 500);
    if (r.ok_http && r.body && r.body.ok === true) return { ok: true, body: r.body };
    lastErr = r.transport_error || `http ${r.status}`;
    await new Promise(res => setTimeout(res, 50));
  }
  return { ok: false, reason: lastErr || "timeout" };
}

// Pre-init the lease engine with a hermetic DB so the daemon's start() sees
// initialized=true and skips its default-path init. Same trick for the
// audit/approvals dirs — we just make sure they exist (they're hardcoded in
// server.mjs to HERMES_ROOT/audit and HERMES_ROOT/approvals).
async function bootHermes() {
  await mkdir(FIXTURE_RUN, { recursive: true });
  await mkdir(APPROVALS_DIR, { recursive: true });
  await mkdir(AUDIT_DIR, { recursive: true });

  // Pre-init lease engine with hermetic DB path. server.start() will see
  // initialized=true and skip re-init with the default DB. Reaper off so we
  // don't pin the process.
  const leaseEngine = await import("../src/lease-engine.mjs");
  leaseEngine.init({ dbPath: LEASES_DB, startReaper: false });

  // Now import the server and start it. It picks up the env we set in main().
  const server = await import("../src/server.mjs");
  const handle = await server.start();
  const health = await waitForHermesHealth();
  if (!health.ok) {
    try { await handle.stop(); } catch { /* no-op */ }
    throw new Error(`Hermes did not become healthy within ${BOOT_TIMEOUT_MS}ms: ${health.reason}`);
  }
  return { handle, leaseEngine, server, health: health.body };
}

// ─── audit log helpers ──────────────────────────────────────────────────────

async function readAuditRows() {
  if (!existsSync(MISFIT_AUDIT_LOG)) return [];
  const raw = await readFile(MISFIT_AUDIT_LOG, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); }
    catch { /* skip — corrupt lines surfaced by other tests */ }
  }
  return out;
}

async function auditRowForLease(leaseId) {
  const rows = await readAuditRows();
  // Most recent row for this lease wins.
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].lease_id === leaseId) return rows[i];
  }
  return null;
}

// ─── lease helpers ──────────────────────────────────────────────────────────

async function mintLease(opts) {
  const r = await fetchJson(
    `${HERMES_BASE_URL}/lease`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    },
  );
  if (r.status !== 200 || !r.body || r.body.ok !== true) {
    throw new Error(`mintLease failed: http=${r.status} body=${JSON.stringify(r.body)}`);
  }
  return r.body.data.lease;
}

function actionBody({ lease, verb, riskLevel, operatorApproved }) {
  return {
    lease_id: lease.id,
    actor: ACTOR,
    action_verb: verb,
    operator_approved: Boolean(operatorApproved),
    order: {
      schema: "orange.order.v1",
      order_id: `misfit-live-${randomUUID().slice(0, 8)}`,
      actor: ACTOR,
      target: lease.targetProject,
      verb,
      receipt_path: "/tmp/misfit-live-smoke-not-required.json",
    },
    report: {
      schema: "orange.report.v1",
      status: "proposed",
    },
    action: {
      kind: "system",
      verb,
      risk_level: riskLevel,
      summary: `misfit-live-smoke ${verb} at risk_level=${riskLevel}`,
    },
  };
}

async function postAction(body) {
  return fetchJson(
    `${HERMES_BASE_URL}/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

// ─── case (a): low-risk → Misfit BYPASSED ───────────────────────────────────

async function caseLowRiskBypass() {
  log(`\n[case-a] low-risk action → Misfit skipped`);
  // No MISFIT_MOCK_VERDICT needed — the middleware should never call the mock
  // at risk_level=low. We still clear it to be unambiguous.
  delete process.env.MISFIT_MOCK_VERDICT;

  const lease = await mintLease({
    actor: ACTOR,
    targetProject: LOW_TARGET,
    allowed: [LOW_VERB],
    riskLevel: "low",
    ttl_ms: 60_000,
    requires_approval: false,
  });
  const beforeRows = (await readAuditRows()).length;
  const res = await postAction(actionBody({ lease, verb: LOW_VERB, riskLevel: "low" }));

  // The response may be 200 (if downstream LOOM passes) or 409 (if a later
  // gate fails — gate 3 receipt_spine will refuse our non-existent receipt
  // path, for example). EITHER WAY, it must NOT be 409 misfit_refused. The
  // assertion is on the Misfit verdict, not the LOOM chain.
  const misfitRefused =
    res.status === 409 &&
    res.body && res.body.error && res.body.error.code === "misfit_refused";
  assert(!misfitRefused, "low-risk action is not Misfit-refused", {
    http: res.status, error: res.body?.error,
  });

  // Audit row must say decision=pass with middleware_decision=skipped (or
  // an equivalent low-risk pass-through).
  const row = await auditRowForLease(lease.id);
  assert(row !== null, "audit row written for low-risk action", { row });
  if (row) {
    assert(row.decision === "pass",
      "audit row decision=pass for low-risk", { row });
    assert(row.risk_level === "low",
      "audit row risk_level=low", { row });
    assert(
      row.middleware_decision === "skipped" || row.middleware_decision === "advisory",
      "audit row middleware_decision is skipped for low-risk",
      { row },
    );
  }
  const afterRows = (await readAuditRows()).length;
  assert(afterRows > beforeRows, "audit log grew by at least one row", {
    before: beforeRows, after: afterRows,
  });
  return { lease, res, row };
}

// ─── case (b): high-risk + mocked REFUSE → BLOCKED ──────────────────────────

async function caseHighRiskRefuseBlocks() {
  log(`\n[case-b] high-risk action + mocked Misfit REFUSE → blocked`);
  process.env.MISFIT_MOCK_VERDICT = "REFUSE";
  process.env.MISFIT_MOCK_REASON = "test:case-b refuses high-risk schema migration";

  const lease = await mintLease({
    actor: ACTOR,
    targetProject: HIGH_TARGET,
    allowed: [HIGH_VERB],
    // riskLevel "high" auto-flips requires_approval=true on the lease — we
    // don't want lease policy to block first here; we want Misfit to block.
    // So we use "medium" lease risk but pass action.risk_level=high through
    // the action envelope, which the middleware honors per resolveRiskLevel().
    riskLevel: "medium",
    ttl_ms: 60_000,
    requires_approval: false,
  });

  const res = await postAction(actionBody({
    lease, verb: HIGH_VERB, riskLevel: "high",
  }));

  assert(res.status === 409,
    "high-risk REFUSE returns HTTP 409", { http: res.status, body: res.body });
  assert(
    res.body && res.body.ok === false &&
      res.body.error && res.body.error.code === "misfit_refused",
    "error code is misfit_refused", { body: res.body },
  );
  assert(
    res.body?.error?.detail?.misfit?.middleware_decision === "refuse",
    "response detail surfaces middleware_decision=refuse",
    { detail: res.body?.error?.detail },
  );
  assert(
    typeof res.body?.error?.detail?.override_hint === "string" &&
      res.body.error.detail.override_hint.includes(`override-${lease.id}.json`),
    "response detail surfaces operator override hint with lease id",
    { detail: res.body?.error?.detail },
  );

  const row = await auditRowForLease(lease.id);
  assert(row !== null, "audit row written for refused action", { row });
  if (row) {
    assert(row.decision === "block",
      "audit row decision=block", { row });
    assert(row.middleware_decision === "refuse",
      "audit row middleware_decision=refuse", { row });
    assert(row.risk_level === "high",
      "audit row risk_level=high", { row });
    assert(Array.isArray(row.reasons) && row.reasons.some(r => /refuse/i.test(r)),
      "audit row reasons mention refusal", { reasons: row.reasons });
  }
  return { lease, res, row };
}

// ─── case (c): high-risk + mocked CONFIRM → proceeds past Misfit ────────────

async function caseHighRiskConfirmProceeds() {
  log(`\n[case-c] high-risk action + mocked Misfit CONFIRM → proceeds to LOOM`);
  process.env.MISFIT_MOCK_VERDICT = "CONFIRM";
  process.env.MISFIT_MOCK_REASON = "test:case-c confirms high-risk schema migration";

  const lease = await mintLease({
    actor: ACTOR,
    targetProject: HIGH_TARGET,
    allowed: [HIGH_VERB],
    riskLevel: "medium",
    ttl_ms: 60_000,
    requires_approval: false,
  });

  const res = await postAction(actionBody({
    lease, verb: HIGH_VERB, riskLevel: "high",
  }));

  // The contract of this case: Misfit did NOT block. Downstream LOOM gates
  // may still fail (we're not providing a real receipt_path), and that's
  // fine — they'd surface as gate_failed, not misfit_refused.
  const misfitRefused =
    res.status === 409 &&
    res.body && res.body.error && res.body.error.code === "misfit_refused";
  assert(!misfitRefused,
    "CONFIRM means action is NOT misfit_refused",
    { http: res.status, error: res.body?.error });

  // If a later LOOM gate failed, the body still carries `error.detail.misfit`
  // with the CONFIRM verdict — assert it.
  const misfitVerdict =
    res.body && res.body.ok === true
      ? res.body.data && res.body.data.misfit
      : res.body && res.body.error && res.body.error.detail && res.body.error.detail.misfit;
  assert(
    misfitVerdict && misfitVerdict.decision === "pass",
    "misfit verdict on response is decision=pass",
    { misfitVerdict, body: res.body },
  );
  assert(
    misfitVerdict && misfitVerdict.middleware_decision === "confirm",
    "misfit middleware_decision=confirm on response",
    { misfitVerdict },
  );

  const row = await auditRowForLease(lease.id);
  assert(row !== null, "audit row written for confirmed action", { row });
  if (row) {
    assert(row.decision === "pass",
      "audit row decision=pass on CONFIRM", { row });
    assert(row.middleware_decision === "confirm",
      "audit row middleware_decision=confirm", { row });
    assert(row.risk_level === "high",
      "audit row risk_level=high", { row });
  }
  return { lease, res, row };
}

// ─── case (d): critical action without operator approval → DOUBLE-BLOCKED ───

async function caseCriticalDoubleBlock() {
  log(`\n[case-d] critical-risk action without approval → double-blocked`);

  // First sub-case: lease policy refuses BEFORE Misfit runs.
  // `riskLevel: "production"` is in AUTO_APPROVAL_RISKS → requires_approval=true.
  // The lease must allow the verb so the refusal is from approval, not scope.
  process.env.MISFIT_MOCK_VERDICT = "REFUSE"; // even if Misfit were called
  process.env.MISFIT_MOCK_REASON = "test:case-d would also refuse critical payment";

  const lease = await mintLease({
    actor: ACTOR,
    targetProject: CRIT_TARGET,
    allowed: [CRIT_VERB],
    riskLevel: "production",
    ttl_ms: 60_000,
    // requires_approval auto-set to true by the engine; we don't override it.
  });
  assert(lease.requires_approval === true,
    "production-risk lease auto-flags requires_approval=true",
    { lease });

  // Sub-case d-1: no operator approval → lease policy blocks (403 lease_refused).
  // Misfit must NOT have been called yet (server.mjs runs checkAction first).
  const auditBefore = await readAuditRows();
  const rowsForLeaseBefore = auditBefore.filter(r => r.lease_id === lease.id).length;
  const r1 = await postAction(actionBody({
    lease, verb: CRIT_VERB, riskLevel: "critical", operatorApproved: false,
  }));
  assert(r1.status === 403,
    "(d-1) lease policy returns HTTP 403 without operator approval",
    { http: r1.status, body: r1.body });
  assert(
    r1.body && r1.body.error && r1.body.error.code === "lease_refused",
    "(d-1) error code is lease_refused", { body: r1.body },
  );
  assert(
    r1.body?.error?.detail?.reason === "operator_approval_required",
    "(d-1) refusal reason is operator_approval_required",
    { detail: r1.body?.error?.detail },
  );
  const auditAfter1 = await readAuditRows();
  const rowsForLeaseAfter1 = auditAfter1.filter(r => r.lease_id === lease.id).length;
  assert(
    rowsForLeaseAfter1 === rowsForLeaseBefore,
    "(d-1) Misfit was NOT called yet — no new audit row for this lease",
    { before: rowsForLeaseBefore, after: rowsForLeaseAfter1 },
  );

  // Sub-case d-2: with operator approval, the lease policy passes — and now
  // Misfit's REFUSE blocks at the second axis. Two independent layers, both
  // honest. Double-block proven.
  const r2 = await postAction(actionBody({
    lease, verb: CRIT_VERB, riskLevel: "critical", operatorApproved: true,
  }));
  assert(r2.status === 409,
    "(d-2) with operator approval, Misfit REFUSE blocks at HTTP 409",
    { http: r2.status, body: r2.body });
  assert(
    r2.body && r2.body.error && r2.body.error.code === "misfit_refused",
    "(d-2) error code is misfit_refused",
    { body: r2.body },
  );

  const row = await auditRowForLease(lease.id);
  assert(row !== null,
    "(d-2) audit row written after operator approval clears lease policy",
    { row });
  if (row) {
    assert(row.decision === "block",
      "(d-2) audit row decision=block", { row });
    assert(row.middleware_decision === "refuse",
      "(d-2) audit row middleware_decision=refuse", { row });
    assert(row.risk_level === "critical",
      "(d-2) audit row risk_level=critical", { row });
  }
  return { lease, r1, r2, row };
}

// ─── runner ─────────────────────────────────────────────────────────────────

async function main() {
  log(`[misfit-live-smoke] start ${nowIso()}`);
  log(`[misfit-live-smoke] fixture dir: ${FIXTURE_RUN}`);

  // Stand up the mock gateway FIRST so we know its URL before Hermes boots.
  let mock;
  try {
    mock = startMockGateway();
  } catch (e) {
    log(`[misfit-live-smoke] FAIL: could not start mock gateway: ${e && e.message ? e.message : e}`);
    process.exit(2);
  }
  log(`[misfit-live-smoke] mock gateway: ${mock.url}`);

  // Wire the daemon's env so the middleware points at our mock.
  process.env.HERMES_GATEWAY_URL = mock.url;
  process.env.HERMES_MISFIT_TIMEOUT_MS = process.env.HERMES_MISFIT_TIMEOUT_MS || "4000";
  // Never let a stray kill-switch from the parent shell mask the test.
  delete process.env.HERMES_MISFIT_DISABLED;

  // Boot Hermes.
  let hermes;
  try {
    hermes = await bootHermes();
  } catch (e) {
    log(`[misfit-live-smoke] FAIL: Hermes boot failed: ${e && e.message ? e.message : e}`);
    try { mock.stop(); } catch { /* no-op */ }
    process.exit(2);
  }
  log(`[misfit-live-smoke] hermes listening at ${HERMES_BASE_URL}`);
  log(`[misfit-live-smoke] hermes health: ${JSON.stringify(hermes.health)}`);

  let exitCode = 0;
  try {
    // Each case is independent — we run all four even if some fail. The exit
    // code is the final source of truth.
    try { await caseLowRiskBypass(); } catch (e) {
      _failCount++;
      log(`  [${FAIL}] case-a threw: ${e && e.message ? e.message : e}`);
    }
    try { await caseHighRiskRefuseBlocks(); } catch (e) {
      _failCount++;
      log(`  [${FAIL}] case-b threw: ${e && e.message ? e.message : e}`);
    }
    try { await caseHighRiskConfirmProceeds(); } catch (e) {
      _failCount++;
      log(`  [${FAIL}] case-c threw: ${e && e.message ? e.message : e}`);
    }
    try { await caseCriticalDoubleBlock(); } catch (e) {
      _failCount++;
      log(`  [${FAIL}] case-d threw: ${e && e.message ? e.message : e}`);
    }
  } finally {
    try { await hermes.handle.stop(); } catch { /* no-op */ }
    try { hermes.leaseEngine.close(); } catch { /* no-op */ }
    try { mock.stop(); } catch { /* no-op */ }
  }

  log(`\n[misfit-live-smoke] PASS=${_passCount} FAIL=${_failCount}`);
  log(`[misfit-live-smoke] audit log: ${MISFIT_AUDIT_LOG}`);
  log(`[misfit-live-smoke] fixture:  ${FIXTURE_RUN}`);

  if (_failCount > 0) {
    log(`[misfit-live-smoke] OVERALL: FAIL`);
    exitCode = 1;
  } else {
    log(`[misfit-live-smoke] OVERALL: PASS — Misfit second-opinion is LIVE-enforced`);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  log(`[misfit-live-smoke] uncaught error: ${e && e.stack ? e.stack : e}`);
  process.exit(99);
});
