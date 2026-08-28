#!/usr/bin/env node
// guardrails-sweep.mjs
// Path:    04-CONTROL-PLANE/session-start/guardrails-sweep.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports + global fetch only)
//
// Session-start step 3 of the operator ritual.
//
// What this does
// --------------
// Fires the full 27-Guardrails sweep against the OrangeLLM gateway and
// returns the verdict in a shape the orchestrator and the deploy-grid
// renderer can both consume without further interpretation.
//
//   POST http://127.0.0.1:1337/v1/guardrails/run
//        body:    { source: "session-start", scope: "full", at: ISO8601 }
//        200:     { ok, ran, passed, failed, violations:[ {id,name,severity,
//                                                          detail,...} ], ... }
//
// Return shape
// ------------
//   When the daemon is reachable AND returns 2xx:
//     {
//       available:   true,
//       ok:          boolean,           // true iff failed === 0
//       ran:         integer,           // count of guardrails actually executed
//       passed:      integer,
//       failed:      integer,
//       violations:  [ ...gateway items ],
//       gateway_url: string,
//       gateway_status: 200..299,
//       latency_ms:  integer,
//       ran_at:      ISO8601
//     }
//
//   When the daemon is NOT reachable, NOT mounted, errors, or returns
//   a malformed body:
//     {
//       available:   false,
//       gateway_url: string,
//       gateway_status: number|null,
//       gateway_error: string,          // named reason — never blank
//       latency_ms:  integer,
//       ran_at:      ISO8601
//     }
//
//   NOTE — Mom's Law line: there is NO third state. We never return
//   { ok:true, failed:0 } when we did not actually receive a real
//   sweep result from the daemon. Unreachable means available:false,
//   period. Downstream renderers must surface that as "guardrails
//   daemon unreachable" — not as "all green."
//
// Doctrine alignment (binding)
// ----------------------------
// - Mom's Law: every field is real. If we do not have a number from
//   the daemon, we do not synthesize one. We return available:false
//   with a named gateway_error and let the deploy grid say so.
// - Receipts > recollection: the response carries ran_at, latency_ms,
//   and (when present) the daemon's raw violation list so 10-RECEIPTS
//   can persist it byte-for-byte.
// - Loopback only. Gateway URL is 127.0.0.1:1337. Overridable by env
//   ORANGE5_GATEWAY_URL for tests / alternate cockpits.
// - No-network surprise: 3000ms hard timeout via AbortController.
//   The 27-guardrails sweep is the heaviest of the four session-start
//   POSTs, so it gets a more generous deadline than inject-genome,
//   but it is still bounded — a hung daemon will not stall the ritual.
// - Idempotent: rerunning the script fires another sweep. The daemon
//   itself is responsible for any internal sweep-rate limiting; this
//   module makes no assumptions about caching.
//
// Programmatic API
// ----------------
//   import { runGuardrailsSweep } from "./guardrails-sweep.mjs";
//   const r = await runGuardrailsSweep();
//   const r = await runGuardrailsSweep({ gatewayUrl, timeoutMs, log });
//
// CLI
// ---
//   node guardrails-sweep.mjs            # one-shot, prints JSON result
//   node guardrails-sweep.mjs --json     # same (default; explicit flag)
//
// Exit codes
// ----------
//   0  available:true AND ok:true        (sweep ran, all passed)
//   1  available:true AND ok:false       (sweep ran, at least one failed)
//   2  available:false                   (daemon unreachable / malformed)
//
// This is the source of truth for the third bullet in the session-start
// ritual. Mom is watching every line.
//
// -------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Defaults — loopback only, overridable by env for tests / alternate cockpits.
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_URL =
  process.env.ORANGE5_GATEWAY_URL || "http://127.0.0.1:1337";

const DEFAULT_RUN_PATH =
  process.env.ORANGE5_GUARDRAILS_RUN_PATH || "/v1/guardrails/run";

const DEFAULT_TIMEOUT_MS = Number(
  process.env.ORANGE5_GUARDRAILS_TIMEOUT_MS || 3000,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coerce a daemon-returned value to a non-negative integer, or null if
 * the shape is unusable. Mom's Law: do NOT default missing counts to 0
 * — a missing count is a malformed response, not a zero.
 */
function toCount(v) {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    return Math.trunc(v);
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    return parseInt(v, 10);
  }
  return null;
}

function toViolations(v) {
  if (Array.isArray(v)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Core: runGuardrailsSweep
// ---------------------------------------------------------------------------

/**
 * POST the full 27-Guardrails sweep request to the OrangeLLM gateway
 * and return the verdict.
 *
 * @param {object} [opts]
 * @param {string} [opts.gatewayUrl]   - default http://127.0.0.1:1337
 * @param {string} [opts.runPath]      - default /v1/guardrails/run
 * @param {number} [opts.timeoutMs]    - default 3000
 * @param {string} [opts.scope]        - daemon-specific; default "full"
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<
 *   | {
 *       available: true,
 *       ok: boolean,
 *       ran: number,
 *       passed: number,
 *       failed: number,
 *       violations: any[],
 *       gateway_url: string,
 *       gateway_status: number,
 *       latency_ms: number,
 *       ran_at: string,
 *     }
 *   | {
 *       available: false,
 *       gateway_url: string,
 *       gateway_status: number|null,
 *       gateway_error: string,
 *       latency_ms: number,
 *       ran_at: string,
 *     }
 * >}
 */
export async function runGuardrailsSweep(opts = {}) {
  const gatewayUrl = opts.gatewayUrl || DEFAULT_GATEWAY_URL;
  const runPath    = opts.runPath    || DEFAULT_RUN_PATH;
  const timeoutMs  = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const scope      = typeof opts.scope === "string" && opts.scope.length ? opts.scope : "full";
  const log        = typeof opts.log === "function" ? opts.log : () => {};

  const targetUrl = new URL(runPath, gatewayUrl).toString();
  const ran_at    = nowIso();
  const payload   = { source: "session-start", scope, at: ran_at };

  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(
      targetUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const gateway_error =
      err && err.name === "AbortError"
        ? `gateway-timeout-${timeoutMs}ms`
        : `gateway-unreachable: ${err && err.message ? err.message : String(err)}`;
    log(`[guardrails-sweep] ${gateway_error}`);
    return {
      available: false,
      gateway_url: gatewayUrl,
      gateway_status: null,
      gateway_error,
      latency_ms,
      ran_at,
    };
  }

  const latency_ms = Date.now() - t0;
  const gateway_status = res.status;

  // Non-2xx — daemon answered but did not run the sweep. NOT green.
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    const gateway_error = `gateway-status-${gateway_status}${detail ? `: ${detail}` : ""}`;
    log(`[guardrails-sweep] non-ok ${gateway_status} ${targetUrl}`);
    return {
      available: false,
      gateway_url: gatewayUrl,
      gateway_status,
      gateway_error,
      latency_ms,
      ran_at,
    };
  }

  // 2xx — try to parse a real sweep verdict.
  let body;
  try {
    body = await res.json();
  } catch (err) {
    const gateway_error = `malformed-body: ${err && err.message ? err.message : String(err)}`;
    log(`[guardrails-sweep] ${gateway_error}`);
    return {
      available: false,
      gateway_url: gatewayUrl,
      gateway_status,
      gateway_error,
      latency_ms,
      ran_at,
    };
  }

  const ran    = toCount(body && body.ran);
  const passed = toCount(body && body.passed);
  const failed = toCount(body && body.failed);
  const violations = toViolations(body && body.violations);

  // Mom's Law: a 2xx with missing counts is NOT a green sweep. It is a
  // malformed response. Be loud about it; do not synthesize zeros.
  if (ran === null || passed === null || failed === null || violations === null) {
    const gateway_error =
      `malformed-verdict: ran=${ran} passed=${passed} failed=${failed} ` +
      `violations=${violations === null ? "missing" : `len${violations.length}`}`;
    log(`[guardrails-sweep] ${gateway_error}`);
    return {
      available: false,
      gateway_url: gatewayUrl,
      gateway_status,
      gateway_error,
      latency_ms,
      ran_at,
    };
  }

  // Cross-check internal arithmetic. If the daemon's own numbers disagree
  // (passed + failed != ran), trust the daemon's `failed` for the ok flag
  // but surface the inconsistency in violations as a synthetic record so
  // the operator sees it.
  const ok = failed === 0;
  let finalViolations = violations;
  if (passed + failed !== ran) {
    finalViolations = violations.slice();
    finalViolations.push({
      id: "session-start.guardrails-sweep.arithmetic-mismatch",
      name: "Guardrails verdict arithmetic does not balance",
      severity: "warn",
      detail: `passed(${passed}) + failed(${failed}) !== ran(${ran})`,
      source: "guardrails-sweep.mjs",
    });
  }

  return {
    available: true,
    ok: ok && finalViolations.length === violations.length, // demote ok if we added a synthetic warn
    ran,
    passed,
    failed,
    violations: finalViolations,
    gateway_url: gatewayUrl,
    gateway_status,
    latency_ms,
    ran_at,
  };
}

// ---------------------------------------------------------------------------
// Default export — matches inject-genome.mjs convention
// ---------------------------------------------------------------------------

export default { runGuardrailsSweep };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || "") === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  runGuardrailsSweep({ log: (l) => process.stderr.write(l + "\n") })
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      if (r.available === false) process.exit(2);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`[guardrails-sweep] FATAL ${err && err.stack ? err.stack : err}\n`);
      process.exit(2);
    });
}
