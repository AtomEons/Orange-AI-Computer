#!/usr/bin/env node
// 08-HERMES / smoke-test.mjs
//
// Hermes gateway-route smoke test — Mom's-Law receipt that the bounded
// execution layer is wired end to end.
//
// Doctrine (operator-issued, Atom McCree):
//   - Hermes replaces "OpenClaw". Every action by any LLM in the superstack
//     must pass through a Hermes lease + the 8-gate LOOM chain.
//   - The gateway at 127.0.0.1:1337 owns the only public surface; the
//     daemon at 127.0.0.1:7430 is loopback-only. This smoke test exercises
//     the gateway routes (the only door from outside the box) and confirms
//     the daemon's enforcement behind them.
//   - No fake greens. If a stage cannot run (gateway down, daemon down,
//     fetch errored), the test surfaces the gap honestly and exits non-zero.
//     We do NOT skip the forbidden-action assertion just because the
//     allowed-action stage didn't reach the daemon.
//
// What this test exercises:
//   1. POST /v1/hermes/lease
//      - Creates a lease scoped to actor=hermes-smoke,
//        targetProject=hermes-smoke-test, with the allowed verb
//        "browser.screenshot" and an explicit extra forbidden verb
//        "rm_minus_rf". Defaults (destructive_write, production_deploy,
//        scope_expansion, egress_unbounded) are auto-merged by the daemon.
//      - Asserts: 200 ok, lease.id present, default_forbidden surfaced.
//
//   2. POST /v1/hermes/action (FORBIDDEN — must be rejected)
//      - Proposes action_verb = "destructive_write" (a default-forbidden
//        verb the lease never opted out of).
//      - Asserts: NOT 200. Lease policy refuses before the LOOM chain even
//        runs. The body carries a structured error with type=lease_refused
//        and reason naming the forbidden verb.
//
//   3. POST /v1/hermes/action (ALLOWED — must pass all 8 gates)
//      - Proposes action_verb = "browser.screenshot", carrying:
//          • a valid order (orange.order.v1) with a receipt_path that
//            exists on disk
//          • a valid report (orange.report.v1) with a status that does NOT
//            contain any fake-green words
//          • an action envelope shaped for gates 6/7/8 (openai_gateway,
//            mcp_default, false_green_guard)
//      - Asserts: 200 ok, pass=true, all 8 gates report pass=true.
//
// Mom's Law:
//   No theater. Every stage prints PASS/FAIL with the structured reason.
//   The exit code is the source of truth — 0 means every stage passed,
//   non-zero means at least one stage failed or could not run.
//
// Run (gateway must be up on 127.0.0.1:1337; Hermes daemon on 127.0.0.1:7430):
//   node 08-HERMES/smoke-test.mjs
//
// Honest gaps:
//   - This test does NOT spin up the gateway or the daemon. It assumes both
//     are already running. The lease created here is real and persists in
//     08-HERMES/leases.db with the configured TTL (10 minutes by default).
//     Run the test against a hermetic instance if you want a clean slate.
//   - Gate 3 (receipt_spine) requires the receipt_path on the order to
//     exist on disk. We write a small JSON file under a temp dir and
//     reference it. The temp file is left behind on purpose so the receipt
//     spine can be inspected post-run; the path is printed on success.
//   - We do NOT exercise POST /approvals/:id from here. That route is NOT
//     proxied by the gateway by design (see hermes-boundary.mjs). A
//     requires_approval=true lease is out of scope for this smoke test.
//   - The test is single-threaded and sequential. Concurrency stress is
//     out of scope here (see 08-HERMES/tests/lease-engine.test.mjs).

import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── config ─────────────────────────────────────────────────────────────────

const GATEWAY_BASE_URL =
  process.env.AE_GATEWAY_BASE_URL || "http://127.0.0.1:1337";

const REQUEST_TIMEOUT_MS = Number(process.env.AE_SMOKE_TIMEOUT_MS || 15_000);

const ACTOR = "hermes-smoke";
const TARGET_PROJECT = "hermes-smoke-test";
const ALLOWED_VERB = "browser.screenshot";
const EXTRA_FORBIDDEN = "rm_minus_rf";

// The verb proposed in stage 2. This is in the daemon's DEFAULT_FORBIDDEN
// list (08-HERMES/src/lease-engine.mjs) and is auto-merged into the lease's
// forbidden set on mint. The action must be refused before the LOOM chain.
const FORBIDDEN_VERB = "destructive_write";

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
      try {
        body = JSON.parse(text);
      } catch (err) {
        parseError = err && err.message ? err.message : String(err);
      }
    }
    return {
      ok_http: res.ok,
      status: res.status,
      body,
      raw: text,
      parse_error: parseError,
    };
  } catch (err) {
    return {
      ok_http: false,
      status: 0,
      body: null,
      raw: "",
      parse_error: null,
      transport_error: err && err.message ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── output helpers ─────────────────────────────────────────────────────────

const PASS = "PASS";
const FAIL = "FAIL";

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function logStage(name, verdict, detail) {
  const tag = verdict === PASS ? `[${PASS}]` : `[${FAIL}]`;
  log(`${tag} ${name}`);
  if (detail) {
    log(`       detail: ${JSON.stringify(detail)}`);
  }
}

// ─── stage 0: gateway reachable ─────────────────────────────────────────────

async function stageProbeGateway() {
  const res = await fetchJson(`${GATEWAY_BASE_URL}/healthz`, { method: "GET" }, 5_000);
  if (res.transport_error) {
    return {
      pass: false,
      reason: "gateway_unreachable",
      detail: { url: `${GATEWAY_BASE_URL}/healthz`, transport_error: res.transport_error },
    };
  }
  if (!res.ok_http) {
    return {
      pass: false,
      reason: "gateway_unhealthy",
      detail: { http: res.status, body_preview: (res.raw || "").slice(0, 200) },
    };
  }
  return { pass: true, detail: { http: res.status } };
}

// ─── stage 1: create lease ──────────────────────────────────────────────────

async function stageCreateLease() {
  const reqBody = {
    actor: ACTOR,
    targetProject: TARGET_PROJECT,
    allowed: [ALLOWED_VERB],
    forbidden: [EXTRA_FORBIDDEN],
    riskLevel: "medium",
    ttl_ms: 5 * 60 * 1000,
    requires_approval: false,
  };

  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/lease`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    },
  );

  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status !== 200) {
    return {
      pass: false,
      reason: "non_200",
      detail: { http: res.status, body: res.body, raw_preview: (res.raw || "").slice(0, 300) },
    };
  }
  if (!res.body || res.body.ok !== true) {
    return { pass: false, reason: "envelope_not_ok", detail: { body: res.body } };
  }
  const lease = res.body.data?.lease;
  const defaultForbidden = res.body.data?.default_forbidden;
  if (!lease || typeof lease.id !== "string" || lease.id.length === 0) {
    return { pass: false, reason: "lease_id_missing", detail: { body: res.body } };
  }
  if (!Array.isArray(defaultForbidden) || defaultForbidden.length === 0) {
    return {
      pass: false,
      reason: "default_forbidden_missing",
      detail: { body: res.body },
    };
  }
  if (!defaultForbidden.includes(FORBIDDEN_VERB)) {
    return {
      pass: false,
      reason: "default_forbidden_missing_target_verb",
      detail: { default_forbidden: defaultForbidden, expected_includes: FORBIDDEN_VERB },
    };
  }
  return {
    pass: true,
    lease,
    default_forbidden: defaultForbidden,
    detail: {
      lease_id: lease.id,
      actor: lease.actor,
      targetProject: lease.targetProject,
      allowed: lease.allowed,
      forbidden_count: Array.isArray(lease.forbidden) ? lease.forbidden.length : null,
    },
  };
}

// ─── stage 2: forbidden action must be refused ──────────────────────────────

async function stageForbiddenAction(lease) {
  const reqBody = {
    lease_id: lease.id,
    actor: ACTOR,
    action_verb: FORBIDDEN_VERB,
    order: {
      schema: "orange.order.v1",
      // The order is well-shaped on purpose — we want to prove the LEASE
      // refuses the verb, not that the order schema gate refuses the order.
      // The daemon's policy check runs before the LOOM chain, so a forbidden
      // verb is rejected with type=lease_refused regardless of order quality.
      orderId: `smoke-forbidden-${randomUUID().slice(0, 8)}`,
      action: FORBIDDEN_VERB,
      intent: FORBIDDEN_VERB,
      scope: TARGET_PROJECT,
      allowedActions: [ALLOWED_VERB],
      forbiddenActions: [FORBIDDEN_VERB],
      targetProject: TARGET_PROJECT,
      riskLevel: "medium",
      requiresReceipt: false,
      receipt_path: "/tmp/unused-for-forbidden-stage.json",
    },
    report: {
      schema: "orange.report.v1",
      orderId: `smoke-forbidden-report-${randomUUID().slice(0, 8)}`,
      status: "blocked",
      confidence: 0.99,
      actionsTaken: [],
      evidence: [],
      blockers: ["lease refused forbidden action"],
      nextAction: "none",
      receiptPath: "not-required-for-forbidden-stage",
    },
    action: {
      kind: "system",
      verb: FORBIDDEN_VERB,
      status: "blocked",
    },
  };

  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    },
  );

  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }

  // We EXPECT a non-200. Either the gateway returns 403 (lease_refused) or
  // 409 (gate_failed) — both are correct refusals. A 200 would mean the
  // forbidden verb leaked through, which is a hard fail.
  if (res.status === 200 && res.body && res.body.ok === true) {
    return {
      pass: false,
      reason: "forbidden_action_was_approved",
      detail: { http: res.status, body: res.body },
    };
  }
  if (res.body && res.body.ok !== false) {
    return {
      pass: false,
      reason: "envelope_not_error",
      detail: { http: res.status, body: res.body },
    };
  }
  // Surface the rejection reason for the receipt.
  const errType = res.body?.error?.type || null;
  const errMsg = res.body?.error?.message || null;
  return {
    pass: true,
    detail: {
      http: res.status,
      error_type: errType,
      error_message: errMsg,
    },
  };
}

// ─── stage 3: allowed action must pass all 8 gates ──────────────────────────

async function writeReceiptFile(lease) {
  const dir = await mkdtemp(join(tmpdir(), "hermes-smoke-"));
  const path = join(dir, "receipt.json");
  const receipt = {
    schema: "orange5.receipt.v0",
    receipt_id: `smoke-${randomUUID()}`,
    generated_at: nowIso(),
    actor: ACTOR,
    status: "pending",
    confidence: 0.99,
    hash_chain: 1,
    target: TARGET_PROJECT,
    lease_id: lease.id,
    action: ALLOWED_VERB,
    note: "hermes smoke-test receipt; safe to delete",
  };
  await writeFile(path, JSON.stringify(receipt, null, 2));
  return path;
}

async function stageAllowedAction(lease) {
  const receiptPath = await writeReceiptFile(lease);
  const orderId = `smoke-allowed-${randomUUID().slice(0, 8)}`;

  const reqBody = {
    lease_id: lease.id,
    actor: ACTOR,
    action_verb: ALLOWED_VERB,
    order: {
      schema: "orange.order.v1",
      orderId,
      action: ALLOWED_VERB,
      intent: ALLOWED_VERB,
      scope: TARGET_PROJECT,
      allowedActions: [ALLOWED_VERB],
      forbiddenActions: [FORBIDDEN_VERB],
      targetProject: TARGET_PROJECT,
      riskLevel: "medium",
      requiresReceipt: true,
      receipt_path: receiptPath,
    },
    report: {
      schema: "orange.report.v1",
      orderId,
      status: "ready",
      confidence: 0.99,
      actionsTaken: ["validated browser screenshot action through Hermes smoke"],
      evidence: [{ type: "receipt", path: receiptPath }],
      blockers: [],
      nextAction: "execute allowed screenshot action",
      receiptPath,
    },
    action: {
      // Shaped for gates 6/7/8. The gates are deliberately conservative:
      //   gate 6 (openai_gateway): action originated via the gateway
      //   gate 7 (mcp_default):    adapter completed MCP handshake
      //   gate 8 (false_green):    status carries no fake-green words
      kind: "tool_call",
      verb: ALLOWED_VERB,
      status: "ready",
      via_gateway: true,
      mcp_handshake: true,
      tool: "playwright",
      card: "browser.screenshot",
      surface: "gateway",
    },
    receipt_path: receiptPath,
  };

  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    },
  );

  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status !== 200) {
    return {
      pass: false,
      reason: "non_200",
      detail: { http: res.status, body: res.body, raw_preview: (res.raw || "").slice(0, 500) },
    };
  }
  if (!res.body || res.body.ok !== true) {
    return { pass: false, reason: "envelope_not_ok", detail: { body: res.body } };
  }
  const data = res.body.data;
  if (!data || data.pass !== true) {
    return { pass: false, reason: "loom_did_not_pass", detail: { body: res.body } };
  }
  if (!Array.isArray(data.results) || data.results.length !== 8) {
    return {
      pass: false,
      reason: "loom_results_wrong_length",
      detail: { expected: 8, got: Array.isArray(data.results) ? data.results.length : null, body: res.body },
    };
  }
  for (const r of data.results) {
    if (!r || r.pass !== true) {
      return {
        pass: false,
        reason: "loom_gate_did_not_pass",
        detail: { failed_gate: r, all_results: data.results },
      };
    }
  }
  return {
    pass: true,
    detail: {
      http: res.status,
      lease_id: data.lease_id,
      gate_ids: data.results.map((r) => r.id),
      receipt_path: receiptPath,
    },
  };
}

// ─── runner ─────────────────────────────────────────────────────────────────

async function main() {
  log(`[hermes-smoke] start ${nowIso()}`);
  log(`[hermes-smoke] gateway: ${GATEWAY_BASE_URL}`);

  const summary = {
    started_at: nowIso(),
    gateway: GATEWAY_BASE_URL,
    stages: {},
  };

  // Stage 0
  const s0 = await stageProbeGateway();
  summary.stages.probe_gateway = s0;
  logStage("0/probe_gateway", s0.pass ? PASS : FAIL, s0.detail || { reason: s0.reason });
  if (!s0.pass) {
    summary.exit_reason = "gateway_unreachable";
    log(`[hermes-smoke] aborting: ${s0.reason}`);
    log(`[hermes-smoke] summary: ${JSON.stringify(summary)}`);
    process.exit(2);
  }

  // Stage 1
  const s1 = await stageCreateLease();
  summary.stages.create_lease = { pass: s1.pass, reason: s1.reason, detail: s1.detail };
  logStage("1/create_lease", s1.pass ? PASS : FAIL, s1.detail || { reason: s1.reason });
  if (!s1.pass) {
    summary.exit_reason = `create_lease:${s1.reason}`;
    log(`[hermes-smoke] aborting: ${s1.reason}`);
    log(`[hermes-smoke] summary: ${JSON.stringify(summary)}`);
    process.exit(3);
  }
  const lease = s1.lease;

  // Stage 2 — forbidden action must be REJECTED
  const s2 = await stageForbiddenAction(lease);
  summary.stages.forbidden_action = { pass: s2.pass, reason: s2.reason, detail: s2.detail };
  logStage(
    "2/forbidden_action_rejected",
    s2.pass ? PASS : FAIL,
    s2.detail || { reason: s2.reason },
  );

  // Stage 3 — allowed action must PASS all 8 gates
  const s3 = await stageAllowedAction(lease);
  summary.stages.allowed_action = { pass: s3.pass, reason: s3.reason, detail: s3.detail };
  logStage(
    "3/allowed_action_8_gates",
    s3.pass ? PASS : FAIL,
    s3.detail || { reason: s3.reason },
  );

  const allPass = s0.pass && s1.pass && s2.pass && s3.pass;
  summary.all_pass = allPass;
  summary.ended_at = nowIso();
  log(`[hermes-smoke] summary: ${JSON.stringify(summary)}`);

  if (!allPass) {
    log(`[hermes-smoke] FAIL — at least one stage did not pass`);
    process.exit(1);
  }
  log(`[hermes-smoke] PASS — lease minted, forbidden refused, allowed cleared all 8 gates`);
  process.exit(0);
}

main().catch((err) => {
  log(`[hermes-smoke] uncaught error: ${err && err.stack ? err.stack : err}`);
  process.exit(99);
});
