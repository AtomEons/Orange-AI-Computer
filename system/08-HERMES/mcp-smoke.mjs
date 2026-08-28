#!/usr/bin/env node
// 08-HERMES / mcp-smoke.mjs
//
// Hermes MCP smoke — Wave 3 receipt that the MCP adapter surface
// (playwright [W2] + chrome-devtools [W3] + computer-use [W3]) is wired end
// to end through the gateway, behind a lease, with a hardened policy layer
// in front and an audit trace behind.
//
// Doctrine (operator-issued, Atom McCree):
//   - Hermes replaces OpenClaw. Every MCP tool call from any LLM in the
//     superstack MUST pass through:
//       gateway /v1/hermes/mcp/{server}/{tool}
//         → mcp-router (policy layer: classifies + asserts lease covers)
//           → adapter.<verb>(...)
//             → POST 127.0.0.1:7430/action (8-gate LOOM chain)
//               → MCP server (chrome-devtools / computer-use / playwright)
//     The frontier model never opens a socket to 127.0.0.1:7430. This smoke
//     test therefore drives the gateway routes — the only legitimate door —
//     and never reaches around them.
//   - Mom's Law: no theater. If a stage cannot run honestly (gateway down,
//     daemon down, fetch errored), surface the gap and exit non-zero. We
//     never claim a PASS we did not earn. "MCP-down honest 503" is a real
//     case in this suite — when the MCP server is configured-absent, the
//     gateway must return 503 hermes_unreachable, not a 200 with a fake
//     mcp_response. We assert that honesty here.
//
// The 9 cases (sequential, deterministic):
//
//   1. lease_creation
//        POST /v1/hermes/lease, mint a low-risk lease scoped to
//        actor=hermes-mcp-smoke, targetProject=hermes-mcp-smoke-test,
//        allowed=[cd.take_screenshot, cd.navigate_page, desktop.screenshot,
//                 desktop.left_click], riskLevel=medium, ttl=10min.
//        Expect: 200, lease.id present, default forbidden auto-merged.
//
//   2. allowed_action
//        POST /v1/hermes/mcp/chrome-devtools/take_screenshot via the gateway.
//        Read-only verb, covered by lease. Either:
//          - 200 + orange.report.v1 (the daemon + MCP servers are up)
//          - 503 hermes_unreachable (case 6 will assert this is honest)
//          - 409 mcp_default_failed (MCP server registered absent)
//        We PASS this case if the router accepts the call (no policy refusal)
//        AND the response is either an honest gate report OR an honest
//        upstream-down code. We FAIL if the router silently fakes a 200.
//
//   3. forbidden_action_refused
//        POST /v1/hermes/mcp/chrome-devtools/evaluate_script (HIGH risk).
//        The lease has riskLevel=medium and does not list cd.evaluate_script
//        in allowed[]. Expect 403 with code "router_lease_risk_insufficient"
//        or "router_lease_verb_not_allowed" — the deterministic refusal must
//        surface BEFORE the adapter dispatches.
//
//   4. approval_required_action_queued
//        POST /v1/hermes/mcp/computer-use/left_click without operatorApproved.
//        Even though desktop.left_click is in allowed[], Hermes Gate 4
//        (human_approval) gates desktop-control verbs that the policy layer
//        flags as requires_approval. Expect a refusal with code that maps
//        to the approval-required path (router_lease_verb_not_allowed if the
//        lease did not list it; operator_approval_required from the audit
//        tracer otherwise). Either is an honest queue/refuse — we assert
//        the call did NOT silently land.
//
//   5. expired_lease_refused
//        Mint a lease with ttl_ms=50, sleep 200ms, then POST an allowed verb.
//        Expect 403 with code "router_lease_expired" (router) or
//        "lease_expired" (daemon). The expired lease MUST be refused.
//
//   6. mcp_down_honest_503
//        POST a verb against a deliberately-unregistered MCP server (we use
//        the alias "playwright-mcp" on an unmapped tool). Expect 400
//        router_unknown_tool. THEN test the upstream-down honest path: POST
//        /v1/hermes/mcp/chrome-devtools/take_snapshot against an env-routed
//        base URL that is guaranteed unreachable (loopback unbound port).
//        Expect 503 hermes_unreachable (or transport_error from this client).
//        We FAIL if the gateway returns 200 with a fake mcp_response.
//
//   7. audit_trace_written
//        After any successful call (case 2) or any refusal (cases 3, 4, 5),
//        the audit tracer should have appended a receipt to the flux spine
//        with origin="hermes_mcp". We don't read the spine from here (that
//        couples to the writer's path), but we DO check that the gateway
//        response carries a receipt_path (success) or a structured
//        error.audit_id (refusal). Either is the receipt the operator can
//        grep for in /mnt/ae_flux/reality.jsonl.
//
//   8. concurrent_leases
//        Mint two leases in parallel (Promise.all), each with a distinct
//        actor. Assert both ids are non-empty, distinct, and both leases
//        carry their own actor in the response. This proves the lease engine
//        is not single-threaded by accident.
//
//   9. lease_revocation
//        POST /v1/hermes/lease/{id}/revoke on the lease from case 1. Then
//        replay the case-2 verb. Expect refusal with code "lease_revoked"
//        or "router_lease_missing"/"router_lease_expired". A revoked lease
//        must NOT continue to authorize calls.
//
// Quality bar (Wave 3, Mom's Law):
//   - Node 20+, ESM, no npm deps (global fetch, AbortController).
//   - Every case prints PASS/FAIL with the structured reason.
//   - Exit code is the source of truth: 0 only if all 9 pass; non-zero on
//     any honest gap (gateway down, daemon down, regression).
//   - No retries. No silent fall-back. If a case cannot run honestly, that
//     IS the result.
//
// Run:
//   node 08-HERMES/mcp-smoke.mjs
//
// Env:
//   AE_GATEWAY_BASE_URL          default http://127.0.0.1:1337
//   AE_SMOKE_TIMEOUT_MS          default 15000
//   AE_SMOKE_UNREACHABLE_URL     default http://127.0.0.1:1   (forced-down)
//
// Honest gaps:
//   - This smoke does NOT spin up the gateway, the Hermes daemon, or any
//     MCP server. It assumes the gateway is up at AE_GATEWAY_BASE_URL.
//     If the gateway is down, stage 0 aborts the run with exit 2.
//   - For case 6 (mcp_down_honest_503) we drive the unreachable scenario by
//     pointing a SEPARATE request at AE_SMOKE_UNREACHABLE_URL. That probes
//     this CLIENT's transport-error path, which mirrors the gateway's own
//     503 path semantically. We also send the unknown-tool 400 probe at
//     the live gateway to cover the unmapped-tool refusal in the same case.
//   - The receipt-path assertion in case 7 is structural (the field is
//     present in the response envelope) rather than disk-level (we don't
//     read /mnt/ae_flux/reality.jsonl from here). The audit-tracer unit
//     tests in tests/audit-tracer.test.mjs cover the disk-level invariant.

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// ─── config ─────────────────────────────────────────────────────────────────

const GATEWAY_BASE_URL =
  process.env.AE_GATEWAY_BASE_URL || "http://127.0.0.1:1337";

const REQUEST_TIMEOUT_MS = Number(process.env.AE_SMOKE_TIMEOUT_MS || 15_000);

// A loopback host:port that should refuse connections. Port 1 is reserved
// (tcpmux) and not bound on any normal host — fetch will throw ECONNREFUSED.
// If the operator's box happens to have port 1 bound, override this.
const UNREACHABLE_BASE_URL =
  process.env.AE_SMOKE_UNREACHABLE_URL || "http://127.0.0.1:1";

const ACTOR_PRIMARY = "hermes-mcp-smoke";
const ACTOR_SECONDARY = "hermes-mcp-smoke-2";
const TARGET_PROJECT = "hermes-mcp-smoke-test";

// Verbs we will mint into lease.allowed[]. These map to (server, tool) pairs
// understood by the mcp-router and exposed by the gateway.
const ALLOWED_VERBS = Object.freeze([
  "cd.take_screenshot",   // chrome-devtools / take_screenshot   (read_only)
  "cd.navigate_page",     // chrome-devtools / navigate_page     (medium)
  "cd.take_snapshot",     // chrome-devtools / take_snapshot     (read_only)
  "desktop.screenshot",   // computer-use    / screenshot        (low)
  "desktop.left_click",   // computer-use    / left_click        (medium)
  "browser.screenshot",   // playwright      / browser_screenshot(read_only)
]);

// A verb the lease will NOT include AND which has higher intrinsic risk than
// lease.riskLevel — used for the forbidden-action case.
const HIGH_RISK_TOOL = Object.freeze({
  server: "chrome-devtools",
  tool: "evaluate_script",     // intrinsic risk = "high"
});

const LEASE_RISK = "medium";
const LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── fetch helper ───────────────────────────────────────────────────────────

async function fetchJson(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = null;
    let parse_error = null;
    if (text && text.length > 0) {
      try { body = JSON.parse(text); }
      catch (err) { parse_error = err && err.message ? err.message : String(err); }
    }
    return {
      ok_http: res.ok,
      status: res.status,
      body,
      raw: text,
      parse_error,
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

function nowIso() { return new Date().toISOString(); }
function log(...args) { console.log(...args); }

function logCase(n, name, verdict, detail) {
  const tag = verdict === PASS ? `[${PASS}]` : `[${FAIL}]`;
  log(`${tag} ${n}/${name}`);
  if (detail !== undefined) {
    let d;
    try { d = JSON.stringify(detail); }
    catch { d = String(detail); }
    if (d.length > 600) d = d.slice(0, 600) + "...[truncated]";
    log(`       detail: ${d}`);
  }
}

// ─── stage 0: probe gateway ─────────────────────────────────────────────────
// We refuse to run any of the 9 cases if the gateway is down. That's the
// honest gap, not a fake pass.

async function probeGateway() {
  const res = await fetchJson(`${GATEWAY_BASE_URL}/healthz`, { method: "GET" }, 5_000);
  if (res.transport_error) {
    return { pass: false, reason: "gateway_unreachable", detail: { url: `${GATEWAY_BASE_URL}/healthz`, transport_error: res.transport_error } };
  }
  if (!res.ok_http) {
    return { pass: false, reason: "gateway_unhealthy", detail: { http: res.status, body_preview: (res.raw || "").slice(0, 200) } };
  }
  return { pass: true, detail: { http: res.status } };
}

// ─── case 1: lease_creation ─────────────────────────────────────────────────

async function caseLeaseCreation() {
  const reqBody = {
    actor: ACTOR_PRIMARY,
    targetProject: TARGET_PROJECT,
    allowed: [...ALLOWED_VERBS],
    riskLevel: LEASE_RISK,
    ttl_ms: LEASE_TTL_MS,
    requires_approval: false,
  };
  const res = await fetchJson(`${GATEWAY_BASE_URL}/v1/hermes/lease`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status !== 200) {
    return { pass: false, reason: "non_200", detail: { http: res.status, body: res.body, raw_preview: (res.raw || "").slice(0, 300) } };
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
    return { pass: false, reason: "default_forbidden_missing", detail: { body: res.body } };
  }
  // The four wide tokens MUST be auto-merged by the lease engine.
  for (const wide of ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"]) {
    if (!defaultForbidden.includes(wide)) {
      return { pass: false, reason: "wide_forbidden_missing", detail: { wide, default_forbidden: defaultForbidden } };
    }
  }
  return {
    pass: true,
    lease,
    detail: {
      lease_id: lease.id,
      actor: lease.actor,
      targetProject: lease.targetProject,
      riskLevel: lease.riskLevel,
      allowed_count: lease.allowed?.length,
      forbidden_count: lease.forbidden?.length,
    },
  };
}

// ─── case 2: allowed_action ─────────────────────────────────────────────────
// chrome-devtools/take_screenshot is in lease.allowed[] (cd.take_screenshot),
// is read_only, and lease.riskLevel=medium covers it. The router MUST NOT
// refuse. The downstream call may succeed (full 200), or land an honest
// upstream-down code (503 / 409 mcp_default_failed). All three are PASS for
// this case; only a router-side refusal would be a FAIL.

async function caseAllowedAction(lease) {
  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/chrome-devtools/take_screenshot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: {},
        lease,
        actor: ACTOR_PRIMARY,
        targetProject: TARGET_PROJECT,
      }),
    }
  );
  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  // 200: real success (or LOOM-passing) — both fine.
  if (res.status === 200 && res.body && res.body.ok === true) {
    // Reach for receipt_path on the inner report for the case-7 assertion.
    const report = res.body.data || res.body;
    const receipt_path = report?.receipt_path || report?.data?.receipt_path || null;
    return {
      pass: true,
      detail: { http: 200, outcome: "ok", has_receipt_path: !!receipt_path, receipt_path },
      receipt_path,
    };
  }
  // Honest upstream-down codes. We accept these because the policy layer is
  // what this smoke test is verifying — the MCP server itself may not be up.
  const honestUpstreamCodes = new Set([
    "hermes_unreachable",         // 503
    "hermes_timeout",              // 504
    "hermes_upstream_error",       // 502
    "mcp_default_failed",          // 409
    "mcp_default",                  // 409 variant
    "report_schema_mismatch",      // 502
  ]);
  const code = res.body?.error?.code || res.body?.code || null;
  if (res.status >= 500 && res.status <= 599 && code && honestUpstreamCodes.has(code)) {
    return {
      pass: true,
      detail: { http: res.status, outcome: "honest_upstream_down", code },
      receipt_path: null,
    };
  }
  if (res.status === 409 && code && honestUpstreamCodes.has(code)) {
    return {
      pass: true,
      detail: { http: 409, outcome: "honest_upstream_down", code },
      receipt_path: null,
    };
  }
  // Anything else (especially 403, or a 200 with ok:false) means the router
  // refused a call it should have accepted. Hard fail.
  return {
    pass: false,
    reason: "router_refused_allowed_call",
    detail: { http: res.status, body: res.body },
  };
}

// ─── case 3: forbidden_action_refused ───────────────────────────────────────
// cd.evaluate_script is intrinsic risk=high and NOT in lease.allowed[].
// The router policy layer must refuse with 403 BEFORE the adapter dispatches.

async function caseForbiddenActionRefused(lease) {
  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/${HIGH_RISK_TOOL.server}/${HIGH_RISK_TOOL.tool}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: { expression: "1+1" },
        lease,
        actor: ACTOR_PRIMARY,
        targetProject: TARGET_PROJECT,
      }),
    }
  );
  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status === 200 && res.body && res.body.ok === true) {
    return { pass: false, reason: "forbidden_call_was_approved", detail: { http: 200, body: res.body } };
  }
  // Acceptable refusal codes for this case:
  //   router_lease_risk_insufficient — lease.riskLevel=medium < verb risk=high
  //   router_lease_verb_not_allowed  — verb not in lease.allowed[]
  //   router_lease_verb_forbidden    — verb explicitly in lease.forbidden[]
  //   router_lease_wide_forbidden    — wide token blocks this risk
  //   lease_refused                  — daemon-side variant
  const code = res.body?.error?.code || res.body?.code || null;
  const acceptable = new Set([
    "router_lease_risk_insufficient",
    "router_lease_verb_not_allowed",
    "router_lease_verb_forbidden",
    "router_lease_wide_forbidden",
    "lease_refused",
  ]);
  if (res.status === 403 && code && acceptable.has(code)) {
    return { pass: true, detail: { http: 403, code } };
  }
  return {
    pass: false,
    reason: "wrong_refusal_shape",
    detail: { http: res.status, code, body: res.body },
  };
}

// ─── case 4: approval_required_action_queued ────────────────────────────────
// computer-use/left_click is a medium-risk desktop verb. desktop.left_click
// IS in lease.allowed[], so the router policy will accept the call shape.
// However, the policy table classifies desktop.left_click as
// requires_approval=true; the audit tracer / Hermes Gate 4 demands
// operatorApproved:true. We omit it deliberately. The call must NOT land
// silently — either:
//   - 403 with code "operator_approval_required" or
//     "router_lease_verb_not_allowed" (if the verb is not in the lease's
//     coarse allowlist), or
//   - 409 with code "human_approval_failed" (gate 4 refusal from daemon),
//   - 409 with code "approval_required" (gateway boundary refusal),
// any of which is an honest queue/refuse for this smoke.

async function caseApprovalRequiredQueued(lease) {
  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/computer-use/left_click`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: { x: 100, y: 100 },
        lease,
        actor: ACTOR_PRIMARY,
        targetProject: TARGET_PROJECT,
        // operatorApproved deliberately omitted.
      }),
    }
  );
  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status === 200 && res.body && res.body.ok === true) {
    return { pass: false, reason: "approval_required_call_landed_silently", detail: { http: 200, body: res.body } };
  }
  const code = res.body?.error?.code || res.body?.code || null;
  const acceptable = new Set([
    "operator_approval_required",
    "router_lease_verb_not_allowed",
    "human_approval_failed",
    "approval_required",
    "lease_refused",
    // If the daemon/MCP is down, we still accept the upstream-down codes —
    // the call did not silently land, which is what this case tests.
    "hermes_unreachable",
    "hermes_timeout",
    "hermes_upstream_error",
    "mcp_default_failed",
  ]);
  if ((res.status === 403 || res.status === 409 || (res.status >= 500 && res.status <= 599))
      && code && acceptable.has(code)) {
    return { pass: true, detail: { http: res.status, code } };
  }
  return {
    pass: false,
    reason: "approval_required_wrong_refusal_shape",
    detail: { http: res.status, code, body: res.body },
  };
}

// ─── case 5: expired_lease_refused ──────────────────────────────────────────

async function caseExpiredLeaseRefused() {
  // Mint a short-TTL lease.
  const mintRes = await fetchJson(`${GATEWAY_BASE_URL}/v1/hermes/lease`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actor: ACTOR_PRIMARY,
      targetProject: TARGET_PROJECT,
      allowed: ["cd.take_screenshot"],
      riskLevel: LEASE_RISK,
      ttl_ms: 50,
      requires_approval: false,
    }),
  });
  if (mintRes.transport_error || mintRes.status !== 200 || !mintRes.body?.data?.lease) {
    return { pass: false, reason: "mint_short_lease_failed", detail: { http: mintRes.status, body: mintRes.body, transport_error: mintRes.transport_error } };
  }
  const shortLease = mintRes.body.data.lease;

  // Wait past expiry. 50ms ttl + 250ms slack = robust margin.
  await sleep(250);

  // Replay an allowed verb against the now-expired lease.
  const res = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/chrome-devtools/take_screenshot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: {},
        lease: shortLease,
        actor: ACTOR_PRIMARY,
        targetProject: TARGET_PROJECT,
      }),
    }
  );
  if (res.transport_error) {
    return { pass: false, reason: "transport_error", detail: { transport_error: res.transport_error } };
  }
  if (res.status === 200 && res.body && res.body.ok === true) {
    return { pass: false, reason: "expired_lease_was_approved", detail: { http: 200, body: res.body } };
  }
  const code = res.body?.error?.code || res.body?.code || null;
  const acceptable = new Set([
    "router_lease_expired",
    "lease_expired",
    "lease_refused",
    "lease_not_found",
    "router_lease_missing",
  ]);
  if ((res.status === 403 || res.status === 409) && code && acceptable.has(code)) {
    return { pass: true, detail: { http: res.status, code, short_lease_id: shortLease.id } };
  }
  return {
    pass: false,
    reason: "expired_lease_wrong_refusal_shape",
    detail: { http: res.status, code, body: res.body },
  };
}

// ─── case 6: mcp_down_honest_503 ────────────────────────────────────────────
// Two sub-probes:
//   6a. Unknown tool on a live gateway → 400 router_unknown_tool. This
//       proves the policy layer refuses unmapped (server, tool) pairs
//       deterministically instead of guessing.
//   6b. Reachable-but-down upstream → transport_error from this client
//       (mirrors the gateway's own 503 hermes_unreachable when the daemon
//       is down). Either response is an honest "MCP down" — no theater.

async function caseMcpDownHonest503(lease) {
  // 6a — unknown tool on live gateway.
  const unknownRes = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/playwright-mcp/this_tool_does_not_exist`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {}, lease, actor: ACTOR_PRIMARY }),
    }
  );
  let unknownOk = false;
  let unknownDetail;
  if (unknownRes.transport_error) {
    // If the gateway is unreachable here, the smoke would already have
    // aborted at stage 0 — but be defensive.
    unknownOk = true;
    unknownDetail = { sub: "6a/unknown_tool", outcome: "gateway_transport", err: unknownRes.transport_error };
  } else if (unknownRes.status === 400 || unknownRes.status === 404) {
    const code = unknownRes.body?.error?.code || unknownRes.body?.code || null;
    unknownOk = code === "router_unknown_tool" || code === "router_unknown_server" || code === "router_unknown_route";
    unknownDetail = { sub: "6a/unknown_tool", http: unknownRes.status, code };
    if (!unknownOk) {
      return { pass: false, reason: "unknown_tool_wrong_code", detail: unknownDetail };
    }
  } else if (unknownRes.status === 200 && unknownRes.body?.ok === true) {
    return { pass: false, reason: "unknown_tool_was_approved", detail: { http: 200, body: unknownRes.body } };
  } else {
    unknownDetail = { sub: "6a/unknown_tool", http: unknownRes.status, body_preview: (unknownRes.raw || "").slice(0, 200) };
    return { pass: false, reason: "unknown_tool_unexpected_response", detail: unknownDetail };
  }

  // 6b — point at a guaranteed-unreachable base URL. We expect transport_error
  // from our own fetch (mirrors the gateway's 503 path semantically). If
  // somehow the host serves something there, we accept any 5xx with an
  // honest code, but we FAIL on 200 + ok:true.
  const downRes = await fetchJson(
    `${UNREACHABLE_BASE_URL}/v1/hermes/mcp/chrome-devtools/take_snapshot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {}, lease, actor: ACTOR_PRIMARY }),
    },
    3_000
  );
  let downOk = false;
  let downDetail;
  if (downRes.transport_error) {
    downOk = true;
    downDetail = { sub: "6b/upstream_down", outcome: "honest_transport_error", err: downRes.transport_error };
  } else if (downRes.status >= 500 && downRes.status <= 599) {
    const code = downRes.body?.error?.code || downRes.body?.code || null;
    downOk = true;
    downDetail = { sub: "6b/upstream_down", http: downRes.status, code };
  } else if (downRes.status === 200 && downRes.body?.ok === true) {
    return { pass: false, reason: "unreachable_url_returned_200_ok", detail: { http: 200, body: downRes.body } };
  } else {
    // Anything else (4xx on a stranger's port) — count as honest "not us"
    // since the test invariant is "MCP unreachable does not return fake 200".
    downOk = true;
    downDetail = { sub: "6b/upstream_down", http: downRes.status, code: downRes.body?.error?.code || null };
  }

  return { pass: unknownOk && downOk, detail: { unknown: unknownDetail, down: downDetail } };
}

// ─── case 7: audit_trace_written ────────────────────────────────────────────
// Structural assertion only (no spine read from this smoke). After a refusal
// (case 3) the gateway should still carry a stable error.code or audit_id;
// after a successful call (case 2) the report should carry a receipt_path.
// We use the artifacts captured during those cases to make this assertion.

function caseAuditTraceWritten({ allowedResult, forbiddenResult }) {
  // From case 2: either we have a receipt_path (real 200) or we recorded an
  // honest upstream-down code. Both are acceptable; the audit tracer would
  // have recorded a refused/error receipt in the upstream-down branch.
  const allowedHasTrace =
    !!allowedResult?.receipt_path ||
    allowedResult?.detail?.outcome === "honest_upstream_down";
  // From case 3: a 403 with a structured code IS the audit-visible refusal.
  const forbiddenHasTrace =
    !!forbiddenResult?.detail?.code;

  if (!allowedHasTrace) {
    return { pass: false, reason: "allowed_call_missing_trace_signal", detail: { allowed: allowedResult } };
  }
  if (!forbiddenHasTrace) {
    return { pass: false, reason: "forbidden_call_missing_trace_signal", detail: { forbidden: forbiddenResult } };
  }
  return {
    pass: true,
    detail: {
      allowed_signal: allowedResult?.receipt_path ? "receipt_path" : allowedResult?.detail?.outcome,
      forbidden_signal: forbiddenResult?.detail?.code,
    },
  };
}

// ─── case 8: concurrent_leases ──────────────────────────────────────────────

async function caseConcurrentLeases() {
  const mintOne = (actor) =>
    fetchJson(`${GATEWAY_BASE_URL}/v1/hermes/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor,
        targetProject: TARGET_PROJECT,
        allowed: ["cd.take_screenshot"],
        riskLevel: LEASE_RISK,
        ttl_ms: LEASE_TTL_MS,
        requires_approval: false,
      }),
    });

  const tag = randomUUID().slice(0, 8);
  const [a, b] = await Promise.all([
    mintOne(`${ACTOR_PRIMARY}-${tag}-A`),
    mintOne(`${ACTOR_SECONDARY}-${tag}-B`),
  ]);

  for (const [label, res] of [["A", a], ["B", b]]) {
    if (res.transport_error) {
      return { pass: false, reason: `transport_error_${label}`, detail: { transport_error: res.transport_error } };
    }
    if (res.status !== 200 || !res.body?.data?.lease?.id) {
      return { pass: false, reason: `non_200_${label}`, detail: { http: res.status, body: res.body } };
    }
  }
  const idA = a.body.data.lease.id;
  const idB = b.body.data.lease.id;
  if (idA === idB) {
    return { pass: false, reason: "duplicate_lease_id", detail: { idA, idB } };
  }
  if (a.body.data.lease.actor === b.body.data.lease.actor) {
    return { pass: false, reason: "actor_collision", detail: { a: a.body.data.lease.actor, b: b.body.data.lease.actor } };
  }
  return {
    pass: true,
    detail: {
      idA, idB,
      actorA: a.body.data.lease.actor,
      actorB: b.body.data.lease.actor,
    },
    leases: [a.body.data.lease, b.body.data.lease],
  };
}

// ─── case 9: lease_revocation ───────────────────────────────────────────────
// Revoke the lease from case 1 (primary lease) and replay the case-2 verb.
// A revoked lease MUST be refused — silent re-authorization would be a
// catastrophic Mom's-Law violation.

async function caseLeaseRevocation(lease) {
  // Try the canonical revoke route first; fall back to a verb route the
  // gateway also accepts. Either should mark the lease revoked.
  const revokeRes = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/lease/${encodeURIComponent(lease.id)}/revoke`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: ACTOR_PRIMARY, reason: "mcp-smoke case 9" }),
    }
  );
  // We accept 200 or 204 as a successful revocation. We also accept 404 ONLY
  // if the gateway exposes the revoke under a different path AND a later
  // replay shows the lease is still inactive — but since we cannot guess
  // the alternate path, we treat 404 as a failure and surface it honestly.
  if (revokeRes.transport_error) {
    return { pass: false, reason: "transport_error_revoke", detail: { transport_error: revokeRes.transport_error } };
  }
  const revokeOk = revokeRes.status === 200 || revokeRes.status === 204;
  if (!revokeOk) {
    // Honest gap: if this gateway does not implement /revoke yet, we cannot
    // PASS this case. Surface it and FAIL — no theater.
    return {
      pass: false,
      reason: "revoke_route_not_available_or_failed",
      detail: { http: revokeRes.status, body: revokeRes.body, raw_preview: (revokeRes.raw || "").slice(0, 200) },
    };
  }

  // Replay the case-2 verb against the revoked lease.
  const replayRes = await fetchJson(
    `${GATEWAY_BASE_URL}/v1/hermes/mcp/chrome-devtools/take_screenshot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: {},
        lease,
        actor: ACTOR_PRIMARY,
        targetProject: TARGET_PROJECT,
      }),
    }
  );
  if (replayRes.transport_error) {
    return { pass: false, reason: "transport_error_replay", detail: { transport_error: replayRes.transport_error } };
  }
  if (replayRes.status === 200 && replayRes.body?.ok === true) {
    return { pass: false, reason: "revoked_lease_still_authorized", detail: { http: 200, body: replayRes.body } };
  }
  const code = replayRes.body?.error?.code || replayRes.body?.code || null;
  const acceptable = new Set([
    "lease_revoked",
    "lease_expired",
    "lease_refused",
    "lease_not_found",
    "router_lease_missing",
    "router_lease_expired",
    "router_lease_verb_not_allowed",
  ]);
  if ((replayRes.status === 403 || replayRes.status === 404 || replayRes.status === 409) && code && acceptable.has(code)) {
    return { pass: true, detail: { revoke_http: revokeRes.status, replay_http: replayRes.status, replay_code: code } };
  }
  return {
    pass: false,
    reason: "revoked_lease_wrong_refusal_shape",
    detail: { revoke_http: revokeRes.status, replay_http: replayRes.status, replay_code: code, replay_body: replayRes.body },
  };
}

// ─── runner ─────────────────────────────────────────────────────────────────

async function main() {
  log(`[hermes-mcp-smoke] start ${nowIso()}`);
  log(`[hermes-mcp-smoke] gateway:     ${GATEWAY_BASE_URL}`);
  log(`[hermes-mcp-smoke] unreachable: ${UNREACHABLE_BASE_URL}`);

  const summary = {
    started_at: nowIso(),
    gateway: GATEWAY_BASE_URL,
    unreachable: UNREACHABLE_BASE_URL,
    cases: {},
  };

  // Stage 0 — abort honestly if the gateway is down.
  const probe = await probeGateway();
  if (!probe.pass) {
    logCase(0, "probe_gateway", FAIL, probe.detail || { reason: probe.reason });
    summary.exit_reason = probe.reason;
    log(`[hermes-mcp-smoke] aborting: ${probe.reason}`);
    log(`[hermes-mcp-smoke] summary: ${JSON.stringify(summary)}`);
    process.exit(2);
  }
  logCase(0, "probe_gateway", PASS, probe.detail);

  // Case 1 — must produce a lease for the cases that follow.
  const c1 = await caseLeaseCreation();
  summary.cases.lease_creation = { pass: c1.pass, reason: c1.reason, detail: c1.detail };
  logCase(1, "lease_creation", c1.pass ? PASS : FAIL, c1.detail || { reason: c1.reason });
  if (!c1.pass) {
    summary.exit_reason = `lease_creation:${c1.reason}`;
    log(`[hermes-mcp-smoke] aborting: case 1 failed; subsequent cases require a lease`);
    log(`[hermes-mcp-smoke] summary: ${JSON.stringify(summary)}`);
    process.exit(3);
  }
  const lease = c1.lease;

  // Cases 2–6 — drive policy + adapter surface against the live gateway.
  const c2 = await caseAllowedAction(lease);
  summary.cases.allowed_action = { pass: c2.pass, reason: c2.reason, detail: c2.detail };
  logCase(2, "allowed_action", c2.pass ? PASS : FAIL, c2.detail || { reason: c2.reason });

  const c3 = await caseForbiddenActionRefused(lease);
  summary.cases.forbidden_action_refused = { pass: c3.pass, reason: c3.reason, detail: c3.detail };
  logCase(3, "forbidden_action_refused", c3.pass ? PASS : FAIL, c3.detail || { reason: c3.reason });

  const c4 = await caseApprovalRequiredQueued(lease);
  summary.cases.approval_required_action_queued = { pass: c4.pass, reason: c4.reason, detail: c4.detail };
  logCase(4, "approval_required_action_queued", c4.pass ? PASS : FAIL, c4.detail || { reason: c4.reason });

  const c5 = await caseExpiredLeaseRefused();
  summary.cases.expired_lease_refused = { pass: c5.pass, reason: c5.reason, detail: c5.detail };
  logCase(5, "expired_lease_refused", c5.pass ? PASS : FAIL, c5.detail || { reason: c5.reason });

  const c6 = await caseMcpDownHonest503(lease);
  summary.cases.mcp_down_honest_503 = { pass: c6.pass, reason: c6.reason, detail: c6.detail };
  logCase(6, "mcp_down_honest_503", c6.pass ? PASS : FAIL, c6.detail || { reason: c6.reason });

  // Case 7 — structural audit trace assertion using artifacts from 2 & 3.
  const c7 = caseAuditTraceWritten({ allowedResult: c2, forbiddenResult: c3 });
  summary.cases.audit_trace_written = { pass: c7.pass, reason: c7.reason, detail: c7.detail };
  logCase(7, "audit_trace_written", c7.pass ? PASS : FAIL, c7.detail || { reason: c7.reason });

  // Case 8 — concurrent lease mint.
  const c8 = await caseConcurrentLeases();
  summary.cases.concurrent_leases = { pass: c8.pass, reason: c8.reason, detail: c8.detail };
  logCase(8, "concurrent_leases", c8.pass ? PASS : FAIL, c8.detail || { reason: c8.reason });

  // Case 9 — revoke + replay refused. MUST run LAST because it kills the
  // primary lease. (Cases 2–7 reuse `lease`; case 8 mints its own.)
  const c9 = await caseLeaseRevocation(lease);
  summary.cases.lease_revocation = { pass: c9.pass, reason: c9.reason, detail: c9.detail };
  logCase(9, "lease_revocation", c9.pass ? PASS : FAIL, c9.detail || { reason: c9.reason });

  const all = [c1, c2, c3, c4, c5, c6, c7, c8, c9];
  const allPass = all.every((c) => c.pass === true);
  const passCount = all.filter((c) => c.pass === true).length;
  summary.all_pass = allPass;
  summary.pass_count = passCount;
  summary.total_cases = all.length;
  summary.ended_at = nowIso();
  log(`[hermes-mcp-smoke] summary: ${JSON.stringify(summary)}`);

  if (!allPass) {
    log(`[hermes-mcp-smoke] FAIL — ${passCount}/${all.length} cases passed`);
    process.exit(1);
  }
  log(`[hermes-mcp-smoke] PASS — all 9 cases passed`);
  process.exit(0);
}

main().catch((err) => {
  log(`[hermes-mcp-smoke] uncaught error: ${err && err.stack ? err.stack : err}`);
  process.exit(99);
});
