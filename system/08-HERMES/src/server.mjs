// 08-HERMES / server.mjs
//
// Hermes daemon — bounded-execution control plane for the Orange5 superstack.
//
// Replaces "OpenClaw". Every action proposed by any LLM in the superstack
// (frontier-via-gateway, OrangeLLM, Codexa worker, MCP tool adapter) must
// arrive here inside a lease, traverse the AE Misfit pre-action second-opinion
// (Wave 3-04) and the 8-gate LOOM chain in order, and only land on the host
// if all checks pass. This file is the network surface that exposes that
// behaviour.
//
// Transport:   Bun.serve (Node-compatible fallback noted in "honest gaps")
// Bind:        127.0.0.1:7430                (loopback ONLY — hard enforced)
// Reach:       gateway /v1/hermes/* proxies here. Frontier model NEVER opens
//              a socket here directly; gate 6 (openai_gateway) enforces that
//              all frontier traffic was mediated by the gateway at
//              127.0.0.1:1337, and the listen address below refuses any non-
//              loopback peer regardless of how the request was routed.
//
// Routes:
//   POST /lease                 — mint a lease (lease-engine.createLease)
//   POST /action                — execute an action through Misfit + 8 gates
//   GET  /healthz               — liveness + active-lease count
//   GET  /approvals             — list pending approvals (queue tail)
//   POST /approvals/:id         — Sovereign approves/denies a pending lease
//
// Response shape (uniform):
//   { ok: boolean, data?: any, error?: { code, message, detail? } }
//
// HTTP status codes:
//   200 ok                      — request succeeded (ok:true)
//   400 invalid_request         — body / params malformed
//   401 not_loopback            — peer is not 127.0.0.1 (defence in depth)
//   403 lease_refused           — lease policy denied the action
//   409 gate_failed             — one of the 8 LOOM gates rejected
//   409 misfit_refused          — AE Misfit second-opinion REFUSED (no override)
//   422 schema_invalid          — order/report did not parse against schema
//   500 internal                — unexpected — surfaces structured error
//
// Frontier-Isolation invariant:
//   This daemon is a private control plane. The gateway is the only public
//   surface. Atom McCree (the Sovereign) is the only human authority. No
//   route here writes to the production host filesystem; gates 1-8 are the
//   write-discipline, and lease-engine persists to 08-HERMES/leases.db via
//   the engine module (not from this file).
//
// AE Misfit pre-action second-opinion (Wave 3-04 → live in this wave):
//   Before any /action request reaches the LOOM 8-gate chain, it is routed
//   through the AE Misfit second-opinion middleware (src/pre-action/
//   misfit-second-opinion.mjs). Behaviour by risk_level:
//     low      → pass-through, no second-opinion call (audit: "skipped:low")
//     medium   → advisory; logged but does NOT block (audit always written)
//     high     → blocking; REFUSE halts /action at 409 misfit_refused unless
//                operator-signed override is present in 08-HERMES/approvals/
//     critical → blocking AND requires human approval in addition (gate 4
//                still enforces the approval queue; Misfit is the second axis)
//   Kill-switch: env HERMES_MISFIT_DISABLED=1 → middleware bypassed entirely,
//                loud warning logged on every /action.
//   Unreachable: if the AE Misfit Ollama tag is missing, the middleware
//                returns { decision: "allow-with-warning" } and we proceed,
//                with a loud audit entry. We do NOT pretend-confirm.
//   Audit: every middleware verdict is appended as JSONL to
//                08-HERMES/audit/misfit-second-opinion.jsonl
//   Override: a REFUSE can be overridden only by a signed approval file in
//                08-HERMES/approvals/override-{lease_id}.json whose
//                signed_by === "atom". The override itself is logged with the
//                full Misfit verdict chain.
//
// Honest gaps (read me):
//   - This file targets Bun (per the task: "Bun HTTP server"). Bun is the
//     primary runtime. The handler is also Node-fetch-shaped, so it could
//     be hosted on `node --experimental-fetch` + `node:http` with a small
//     adapter; that adapter is NOT shipped in this file. If you need to
//     run on Node, write the adapter and route requests through `handle`.
//   - The lease engine uses `node:sqlite` (Bun is compatible because Bun
//     ships a node:sqlite shim). On Node 20.x the engine emits an
//     ExperimentalWarning on first init — benign.
//   - Gate 4 (human_approval) reads from `08-HERMES/approvals/pending.jsonl`.
//     This server writes to that exact file when the Sovereign approves a
//     lease via POST /approvals/:id. There is NO cryptographic signature
//     check on the writes — `signed: true` and `signed_by: "atom"` are
//     written because the daemon assumes the peer is the Sovereign by
//     virtue of being on the loopback interface. If/when the gateway
//     terminates an Ed25519 channel and forwards a signed envelope, this
//     handler should verify the signature before writing. Tracked.
//   - The Misfit middleware module is loaded lazily on first /action so a
//     missing file fails fast on use rather than at daemon boot. If the
//     module is missing entirely, /action returns 500 with
//     misfit_middleware_load_failed — we do NOT silently skip enforcement.
//     The kill-switch is the ONLY supported way to disable Misfit.
//   - `GET /approvals` returns the tail of pending.jsonl filtered to the
//     leases that are still active and whose approval state is not yet
//     true. There is no pagination — the queue is intended to be small
//     (handful of items at a time). If it ever grows past O(thousands),
//     add a cursor.
//   - Gate execution is sequential. The doctrine ("8 gates must pass") and
//     the failure-localisation goal both argue against running them in
//     parallel. Short-circuit on first fail. The aggregate latency for a
//     happy-path action is the sum of all 8 gates; on the read-light
//     hot path that is currently single-digit ms in practice.
//   - There is no in-process rate limiting. The gateway is the surface
//     that talks to the world; this daemon trusts the gateway to throttle.
//     If the gateway is misconfigured and a misbehaving local client
//     hammers /action, Hermes will keep validating but the SQLite writes
//     in lease-engine and the JSONL appends here will become the bottleneck.
//
// Run: `bun run src/server.mjs` (from 08-HERMES/)
// Stop: SIGINT/SIGTERM — closes lease-engine DB and the HTTP listener.

import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { localAppOrigin, withLocalAppCors } from "../../03-BACKEND/local-app-cors.mjs";

import {
  init as initLeaseEngine,
  close as closeLeaseEngine,
  createLease,
  checkAction,
  revokeLease,
  listActive,
  HermesError,
  DEFAULT_FORBIDDEN,
  REFUSAL,
} from "./lease-engine.mjs";
import {
  SETTLEMENT_OUTCOMES,
  writePreActionSettlement,
} from "./pre-action/receipt-settlement.mjs";

// ─── constants ──────────────────────────────────────────────────────────────

export const HOST = "127.0.0.1";
const TEST_PORT = Number(process.env.HERMES_TEST_PORT);
export const PORT = process.env.HERMES_TEST_MODE === "1"
  && Number.isInteger(TEST_PORT)
  && TEST_PORT >= 1024
  && TEST_PORT <= 65535
  ? TEST_PORT
  : 7430;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 08-HERMES/src → 08-HERMES
const HERMES_ROOT = resolve(__dirname, "..");
const APPROVALS_DIR = resolve(HERMES_ROOT, "approvals");
const APPROVALS_QUEUE = resolve(APPROVALS_DIR, "pending.jsonl");

// AE Misfit second-opinion paths
const MISFIT_MIDDLEWARE_PATH = resolve(__dirname, "pre-action/misfit-second-opinion.mjs");
const AUDIT_DIR = resolve(HERMES_ROOT, "audit");
const MISFIT_AUDIT_LOG = resolve(AUDIT_DIR, "misfit-second-opinion.jsonl");

const GATE_FILES = Object.freeze([
  "loom-gates/01-order-schema.mjs",
  "loom-gates/02-report-schema.mjs",
  "loom-gates/03-receipt-spine.mjs",
  "loom-gates/04-human-approval.mjs",
  "loom-gates/05-codexa-lease.mjs",
  "loom-gates/06-openai-gateway.mjs",
  "loom-gates/07-mcp-default.mjs",
  "loom-gates/08-false-green.mjs",
]);

const SOVEREIGN_PRINCIPAL = "atom";

// Misfit kill-switch — env-gated, loud when active.
const MISFIT_DISABLED = String(process.env.HERMES_MISFIT_DISABLED || "") === "1";

// ─── structured errors ──────────────────────────────────────────────────────

class ServerError extends Error {
  /** @param {string} code @param {string} message @param {number} status @param {object} [detail] */
  constructor(code, message, status, detail) {
    super(message);
    this.name = "ServerError";
    this.code = code;
    this.status = status;
    this.detail = detail || null;
  }
}

// ─── gate loader (dynamic, ordered, cached) ─────────────────────────────────

/** @type {Array<{id:string, index:number, fn:Function}> | null} */
let _gateChain = null;

/**
 * Dynamically import every LOOM gate in canonical order. Cached after first
 * call. Tests / hot-reload can pass { reload: true } to bust the cache.
 *
 * Each gate module is expected to export either a default function or a
 * named function matching its file (orderSchemaGate, reportSchemaGate, …).
 * The signature varies (see each gate file) but they all return either
 * `{ pass, reasons }` or a Promise of same. The chain runner here unifies
 * the signatures by giving every gate the same context object and letting
 * each one pick what it needs.
 *
 * @param {{ reload?: boolean }} [opts]
 * @returns {Promise<Array<{id:string, index:number, fn:Function}>>}
 */
export async function loadGateChain({ reload = false } = {}) {
  if (_gateChain && !reload) return _gateChain;
  const chain = [];
  for (const rel of GATE_FILES) {
    const abs = resolve(__dirname, rel);
    // Bust ESM cache on reload by appending a query — only works on file URLs.
    const url = reload ? `file://${abs}?t=${Date.now()}` : `file://${abs}`;
    const mod = await import(url);
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new ServerError(
        "gate_load_failed",
        `gate ${rel} has no default export function`,
        500,
        { file: rel },
      );
    }
    chain.push({
      id: mod.GATE_ID || rel,
      index: typeof mod.GATE_INDEX === "number" ? mod.GATE_INDEX : chain.length + 1,
      fn,
    });
  }
  // Trust the file order, but also assert GATE_INDEX is monotonic — catches
  // a refactor that renames files without updating the indices.
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].index <= chain[i - 1].index) {
      throw new ServerError(
        "gate_order_inconsistent",
        `gate ${chain[i].id} index ${chain[i].index} ≤ prior ${chain[i - 1].id} index ${chain[i - 1].index}`,
        500,
      );
    }
  }
  _gateChain = chain;
  return chain;
}

// ─── AE Misfit pre-action middleware (Wave 3-04, live in this wave) ─────────

/** @type {Function | null} */
let _misfitMiddleware = null;
/** @type {string | null} */
let _misfitLoadError = null;

/**
 * Lazily import the Misfit second-opinion middleware. The middleware module is
 * expected to default-export an async function with the shape:
 *
 *   async function misfitSecondOpinion(ctx, opts) -> {
 *     decision: "confirm" | "refuse" | "allow-with-warning" | "skipped",
 *     risk_level: "low" | "medium" | "high" | "critical",
 *     reasons: string[],
 *     model_tag?: string | null,
 *     unreachable?: boolean,
 *     advisory?: boolean,
 *     evidence?: object,
 *   }
 *
 * If the module cannot be loaded we record the error string and surface it on
 * every subsequent /action as a 500 misfit_middleware_load_failed — we do NOT
 * silently skip enforcement. To disable Misfit, set HERMES_MISFIT_DISABLED=1.
 *
 * @param {{ reload?: boolean }} [opts]
 * @returns {Promise<Function>}
 */
export async function loadMisfitMiddleware({ reload = false } = {}) {
  if (_misfitMiddleware && !reload) return _misfitMiddleware;
  if (_misfitLoadError && !reload) {
    throw new ServerError(
      "misfit_middleware_load_failed",
      `Misfit middleware previously failed to load: ${_misfitLoadError}`,
      500,
      { path: MISFIT_MIDDLEWARE_PATH },
    );
  }
  try {
    const url = reload
      ? `file://${MISFIT_MIDDLEWARE_PATH}?t=${Date.now()}`
      : `file://${MISFIT_MIDDLEWARE_PATH}`;
    const mod = await import(url);
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error("middleware module has no default export function");
    }
    _misfitMiddleware = fn;
    _misfitLoadError = null;
    return fn;
  } catch (e) {
    _misfitLoadError = e && e.message ? e.message : String(e);
    throw new ServerError(
      "misfit_middleware_load_failed",
      `failed to load Misfit middleware: ${_misfitLoadError}`,
      500,
      { path: MISFIT_MIDDLEWARE_PATH },
    );
  }
}

/**
 * Ensure the audit directory + file exist.
 */
async function ensureAuditFile() {
  await mkdir(AUDIT_DIR, { recursive: true });
  if (!existsSync(MISFIT_AUDIT_LOG)) {
    await writeFile(MISFIT_AUDIT_LOG, "");
  }
}

/**
 * Append one Misfit verdict (or kill-switch / unreachable / override) row to
 * the JSONL audit log. Best-effort: a single appendFile call. The chain caller
 * never blocks on this — we await it because the audit must precede the
 * /action response, but a failure to write does NOT change the verdict.
 *
 * @param {object} record
 */
async function appendMisfitAudit(record) {
  try {
    await ensureAuditFile();
    await appendFile(MISFIT_AUDIT_LOG, JSON.stringify(record) + "\n");
  } catch (e) {
    // Loud, but do not change verdict — audit failure is its own problem and
    // is reported via stderr so a sidecar can pick it up.
    try {
      console.error(
        "hermes: WARN failed to write misfit audit row:",
        e && e.message ? e.message : e,
      );
    } catch { /* no-op */ }
  }
}

/**
 * Check for a signed operator-override file authorizing a Misfit REFUSE to
 * proceed. The override must live at:
 *   08-HERMES/approvals/override-{lease_id}.json
 * and contain:
 *   { signed_by: "atom", lease_id: <lease.id>, approved: true,
 *     for_action_verb?: string, note?: string, decided_at?: string }
 *
 * We do NOT verify a cryptographic signature here — same model as the
 * pending.jsonl approval queue (see honest gaps). The file's existence on the
 * loopback-only filesystem under the Sovereign's user is the trust anchor.
 *
 * @param {string} leaseId
 * @param {string} actionVerb
 * @returns {Promise<{ overridden: boolean, record: object | null, reason?: string }>}
 */
async function loadMisfitOverride(leaseId, actionVerb) {
  const overridePath = resolve(APPROVALS_DIR, `override-${leaseId}.json`);
  if (!existsSync(overridePath)) {
    return { overridden: false, record: null };
  }
  try {
    const raw = await readFile(overridePath, "utf8");
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object") {
      return { overridden: false, record: null, reason: "override_file_not_object" };
    }
    if (rec.signed_by !== SOVEREIGN_PRINCIPAL) {
      return { overridden: false, record: rec, reason: "override_not_signed_by_sovereign" };
    }
    if (rec.lease_id !== leaseId) {
      return { overridden: false, record: rec, reason: "override_lease_id_mismatch" };
    }
    if (rec.approved !== true) {
      return { overridden: false, record: rec, reason: "override_not_approved" };
    }
    if (
      typeof rec.for_action_verb === "string" &&
      rec.for_action_verb.length > 0 &&
      rec.for_action_verb !== actionVerb
    ) {
      return { overridden: false, record: rec, reason: "override_action_verb_mismatch" };
    }
    return { overridden: true, record: rec };
  } catch (e) {
    return {
      overridden: false,
      record: null,
      reason: `override_file_unreadable: ${e && e.message ? e.message : String(e)}`,
    };
  }
}

/**
 * Run the Misfit pre-action middleware against an action context. Returns a
 * uniform verdict the /action handler can branch on. Always writes an audit
 * row before returning.
 *
 *   { gate: "misfit_second_opinion",
 *     decision: "pass" | "block",
 *     risk_level: "low" | "medium" | "high" | "critical" | "unknown",
 *     middleware_decision: "confirm" | "refuse" | "allow-with-warning" |
 *                          "skipped" | "kill-switched" | "unreachable" |
 *                          "advisory",
 *     reasons: string[],
 *     audit_id: string,
 *     override?: object | null,
 *     evidence?: object }
 *
 * @param {object} ctx — same context object passed to runLoomChain
 * @returns {Promise<object>}
 */
export async function runMisfitMiddleware(ctx) {
  const audit_id = `mso_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const baseAudit = {
    audit_id,
    ts: new Date().toISOString(),
    lease_id: ctx.lease && ctx.lease.id ? ctx.lease.id : null,
    actor: ctx.actor || null,
    action_verb: ctx.actionVerb || null,
  };

  // Kill-switch — loud, audited, pass-through.
  if (MISFIT_DISABLED) {
    try {
      console.error(
        "hermes: WARN HERMES_MISFIT_DISABLED=1 — Misfit second-opinion BYPASSED",
        `(lease=${baseAudit.lease_id}, verb=${baseAudit.action_verb})`,
      );
    } catch { /* no-op */ }
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "pass",
      risk_level: "unknown",
      middleware_decision: "kill-switched",
      reasons: ["HERMES_MISFIT_DISABLED=1 — second-opinion bypassed by env kill-switch"],
      audit_id,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  // Load middleware. A failure here is hard — we will not silently skip.
  let mw;
  try {
    mw = await loadMisfitMiddleware();
  } catch (e) {
    const reason =
      e instanceof ServerError ? e.message : (e && e.message ? e.message : String(e));
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "block",
      risk_level: "unknown",
      middleware_decision: "load_failed",
      reasons: [`misfit_middleware_load_failed: ${reason}`],
      audit_id,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    // Re-throw so the /action handler renders the proper 500.
    if (e instanceof ServerError) throw e;
    throw new ServerError(
      "misfit_middleware_load_failed",
      `failed to load Misfit middleware: ${reason}`,
      500,
      { path: MISFIT_MIDDLEWARE_PATH },
    );
  }

  // Invoke middleware. We give it the same context shape we give to gates,
  // plus an explicit `risk_level` field if the caller (gateway) passed one
  // on the action envelope. Middleware is responsible for inferring risk
  // when not provided.
  /** @type {{decision:string, risk_level?:string, reasons?:string[], model_tag?:string|null, unreachable?:boolean, advisory?:boolean, evidence?:object}} */
  let raw;
  try {
    raw = await mw({
      lease: ctx.lease,
      actor: ctx.actor,
      actionVerb: ctx.actionVerb,
      order: ctx.order,
      report: ctx.report,
      action: ctx.action,
      risk_level: ctx.action && typeof ctx.action.risk_level === "string"
        ? ctx.action.risk_level
        : undefined,
    });
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "block",
      risk_level: "unknown",
      middleware_decision: "threw",
      reasons: [`misfit_middleware_threw: ${reason}`],
      audit_id,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    throw new ServerError(
      "misfit_middleware_failed",
      `Misfit middleware threw: ${reason}`,
      500,
    );
  }

  const risk_level =
    typeof raw.risk_level === "string" ? raw.risk_level : "unknown";
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.slice() : [];
  const middleware_decision =
    typeof raw.decision === "string" ? raw.decision : "unknown";

  // Unreachable path: AE Misfit Ollama tag missing. Middleware returns
  // "allow-with-warning" rather than pretending to confirm. Loud audit row,
  // proceed to LOOM, do NOT block.
  if (raw.unreachable === true || middleware_decision === "allow-with-warning") {
    try {
      console.error(
        "hermes: WARN Misfit second-opinion UNREACHABLE — allow-with-warning",
        `(lease=${baseAudit.lease_id}, verb=${baseAudit.action_verb}, model_tag=${raw.model_tag || "n/a"})`,
      );
    } catch { /* no-op */ }
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "pass",
      risk_level,
      middleware_decision: "allow-with-warning",
      reasons: reasons.length
        ? reasons
        : ["Misfit model tag unavailable — proceeding with warning, NOT pretend-confirming"],
      audit_id,
      model_tag: raw.model_tag || null,
      evidence: raw.evidence || null,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  // Risk-level matrix.
  // low      → pass-through. Middleware should have returned "skipped"; either
  //            way we don't block.
  if (risk_level === "low" || middleware_decision === "skipped") {
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "pass",
      risk_level,
      middleware_decision,
      reasons: reasons.length ? reasons : ["risk_level=low — second-opinion not required"],
      audit_id,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  // medium   → advisory; log the verdict but never block.
  if (risk_level === "medium") {
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "pass",
      risk_level,
      middleware_decision: "advisory",
      reasons: reasons.length
        ? reasons
        : [`Misfit advisory (medium risk): middleware returned ${middleware_decision}`],
      audit_id,
      evidence: raw.evidence || null,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  // high / critical → blocking semantics.
  // CONFIRM proceeds. REFUSE blocks unless signed override is present.
  if (middleware_decision === "confirm") {
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "pass",
      risk_level,
      middleware_decision: "confirm",
      reasons: reasons.length ? reasons : ["Misfit confirmed action"],
      audit_id,
      evidence: raw.evidence || null,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  if (middleware_decision === "refuse") {
    const override = await loadMisfitOverride(
      baseAudit.lease_id || "",
      baseAudit.action_verb || "",
    );
    if (override.overridden) {
      try {
        console.error(
          "hermes: NOTICE Misfit REFUSE overridden by signed operator approval",
          `(lease=${baseAudit.lease_id}, verb=${baseAudit.action_verb})`,
        );
      } catch { /* no-op */ }
      const verdict = {
        gate: "misfit_second_opinion",
        decision: "pass",
        risk_level,
        middleware_decision: "refuse",
        overridden: true,
        override: override.record,
        reasons: [
          "Misfit REFUSED but signed operator override is present",
          ...reasons,
        ],
        audit_id,
        evidence: raw.evidence || null,
      };
      await appendMisfitAudit({ ...baseAudit, ...verdict });
      return verdict;
    }
    const verdict = {
      gate: "misfit_second_opinion",
      decision: "block",
      risk_level,
      middleware_decision: "refuse",
      overridden: false,
      override_attempted: override.record ? override : null,
      reasons: reasons.length ? reasons : ["Misfit refused this action"],
      audit_id,
      evidence: raw.evidence || null,
    };
    await appendMisfitAudit({ ...baseAudit, ...verdict });
    return verdict;
  }

  // Unknown decision string at blocking-risk — fail closed.
  const verdict = {
    gate: "misfit_second_opinion",
    decision: "block",
    risk_level,
    middleware_decision,
    reasons: [
      `Misfit returned unknown decision "${middleware_decision}" at risk_level=${risk_level} — failing closed`,
      ...reasons,
    ],
    audit_id,
    evidence: raw.evidence || null,
  };
  await appendMisfitAudit({ ...baseAudit, ...verdict });
  return verdict;
}

// ─── LOOM chain runner ──────────────────────────────────────────────────────

/**
 * Run all 8 gates in order against an action context. Short-circuits on first
 * failure. The context object is constructed by /action handler; each gate
 * receives the slice of context it knows how to inspect.
 *
 * Argument shape per gate (chosen so existing gate signatures keep working):
 *   gate 1 order_schema   ← ctx.order
 *   gate 2 report_schema  ← ctx.report
 *   gate 3 receipt_spine  ← { receipt_path, lease, order } (probe order from §contract)
 *   gate 4 human_approval ← ctx.lease, { queuePath }
 *   gate 5 codexa_lease   ← ctx.lease, { actor, action: actionVerb }
 *   gate 6 openai_gateway ← ctx.action
 *   gate 7 mcp_default    ← ctx.action
 *   gate 8 false_green    ← ctx.action, { report: ctx.report }
 *
 * @param {object} ctx
 * @returns {Promise<{ pass: boolean, results: Array<{id:string,index:number,pass:boolean,reasons:string[],detail?:any}> }>}
 */
export async function runLoomChain(ctx) {
  const chain = await loadGateChain();
  const results = [];

  for (const { id, index, fn } of chain) {
    /** @type {{pass:boolean, reasons?:string[], detail?:any}} */
    let res;
    try {
      switch (id) {
        case "order_schema": {
          res = await fn(ctx.order);
          break;
        }
        case "report_schema": {
          res = await fn(ctx.report);
          break;
        }
        case "receipt_spine": {
          // Gate 3 reads receipt path off the input it gets; pass the order
          // (which is the canonical carrier of receipt_path per gate 3
          // contract: input.receipt_path → input.order.receipt_path).
          // Provide an override via ctx.receipt_path if the caller knows it
          // out of band (e.g. tests).
          const input = ctx.receipt_path
            ? { receipt_path: ctx.receipt_path, lease: ctx.lease, order: ctx.order }
            : { lease: ctx.lease, order: ctx.order };
          res = await fn(input);
          break;
        }
        case "human_approval": {
          res = await fn(ctx.lease, { queuePath: APPROVALS_QUEUE, sovereignPrincipal: SOVEREIGN_PRINCIPAL });
          break;
        }
        case "codexa_lease": {
          res = await fn(
            { lease: ctx.lease, actor: ctx.actor, action: ctx.actionVerb, order: ctx.order },
            { lease: ctx.lease, actor: ctx.actor, action: ctx.actionVerb },
          );
          break;
        }
        case "openai_gateway": {
          res = await fn(ctx.action);
          break;
        }
        case "mcp_default": {
          res = await fn(ctx.action);
          break;
        }
        case "false_green_guard": {
          res = await fn(ctx.action, { report: ctx.report });
          break;
        }
        default: {
          // Unknown gate id — should be impossible given the static file list,
          // but if a future gate is added without updating this switch we want
          // a clear failure rather than a silent skip.
          res = {
            pass: false,
            reasons: [`unrouted_gate: ${id} — server.mjs runLoomChain has no case for this gate id`],
          };
        }
      }
    } catch (err) {
      // A gate threw (not the same as returning { pass:false }). We treat a
      // thrown error as a hard fail of that gate and record the message.
      res = {
        pass: false,
        reasons: [`gate_threw: ${id}: ${err && err.message ? err.message : String(err)}`],
      };
    }

    const entry = {
      id,
      index,
      pass: Boolean(res && res.pass),
      reasons: (res && Array.isArray(res.reasons)) ? res.reasons : (res && res.pass ? [] : ["gate_returned_no_reasons"]),
    };
    // Surface any extra detail the gate attached (matched evidence, resolved
    // tool card, etc.) without leaking the entire return shape.
    if (res && typeof res === "object") {
      const detail = {};
      for (const k of ["matches", "surface", "tool", "card", "evidence", "approval", "lease", "actor", "action", "effectiveForbidden", "absPath"]) {
        if (k in res) detail[k] = res[k];
      }
      if (Object.keys(detail).length > 0) entry.detail = detail;
    }

    results.push(entry);
    if (!entry.pass) {
      return { pass: false, results };
    }
  }

  return { pass: true, results };
}

// ─── approvals queue ────────────────────────────────────────────────────────

/**
 * Ensure the approvals directory and JSONL file exist.
 */
async function ensureApprovalsFile() {
  await mkdir(APPROVALS_DIR, { recursive: true });
  if (!existsSync(APPROVALS_QUEUE)) {
    await writeFile(APPROVALS_QUEUE, "");
  }
}

/**
 * Read the approvals queue. Skips blank lines. Records that fail to parse are
 * surfaced as a structured error in the response (we do NOT swallow them).
 *
 * @returns {Promise<Array<object>>}
 */
async function readApprovalsQueue() {
  await ensureApprovalsFile();
  const raw = await readFile(APPROVALS_QUEUE, "utf8");
  /** @type {Array<object>} */
  const out = [];
  /** @type {Array<{line:number, error:string, raw:string}>} */
  const errors = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      errors.push({ line: i + 1, error: err.message, raw: line });
    }
  }
  if (errors.length > 0) {
    throw new ServerError("approvals_queue_corrupt", "approvals queue has unparseable lines", 500, { errors });
  }
  return out;
}

/**
 * Append a new approval record. Atomicity: best-effort. JSONL append is a
 * single write; on most filesystems this is atomic for sub-page writes. We
 * do NOT take a lock — multiple Hermes daemons against the same queue is
 * already documented as unsupported (see lease-engine.mjs honest gaps).
 *
 * @param {object} record
 */
async function appendApproval(record) {
  await ensureApprovalsFile();
  await appendFile(APPROVALS_QUEUE, JSON.stringify(record) + "\n");
}

// ─── request helpers ────────────────────────────────────────────────────────

/**
 * Defence-in-depth loopback check. Bun's listen({ hostname }) already binds
 * only to 127.0.0.1, but a misconfigured reverse proxy could still forward
 * external traffic at the kernel level. We assert the peer address here.
 *
 * @param {Request} req
 * @param {{ ip?: string } | null} info
 */
function assertLoopback(req, info) {
  const ip = (info && info.ip) || null;
  // Bun passes server info as second arg to fetch handler; if absent, fall
  // back to Host header inspection (best-effort).
  if (ip) {
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      throw new ServerError("not_loopback", `peer ${ip} is not on the loopback interface`, 401, { ip });
    }
    return;
  }
  const host = req.headers.get("host") || "";
  if (host && !/^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)) {
    throw new ServerError("not_loopback", `Host header ${host} is not loopback`, 401, { host });
  }
}

/**
 * Parse a JSON body. Empty bodies are treated as `{}`. Malformed JSON throws
 * a structured 400.
 *
 * @param {Request} req
 * @returns {Promise<object>}
 */
async function parseJsonBody(req) {
  const text = await req.text();
  if (!text || text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ServerError("invalid_request", "request body must be a JSON object", 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof ServerError) throw err;
    throw new ServerError("invalid_request", `body is not valid JSON: ${err.message}`, 400);
  }
}

/**
 * @param {boolean} ok
 * @param {object} payload
 * @param {number} [status]
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function ok(data, status = 200) {
  return jsonResponse({ ok: true, data }, status);
}

function err(code, message, status, detail) {
  const body = { ok: false, error: { code, message } };
  if (detail) body.error.detail = detail;
  return jsonResponse(body, status);
}

async function settleActionReceipt(body, outcome, reason, evidence = []) {
  const receiptPath = body.receipt_path || body.report?.receiptPath || body.order?.receipt_path;
  if (!receiptPath) return null;
  try {
    const result = await writePreActionSettlement({
      receiptPath,
      outcome,
      reason,
      leaseId: body.lease_id,
      actionVerb: body.action_verb,
      actor: body.actor,
      evidence,
    });
    return {
      ok: true,
      created: result.created,
      path: result.path,
      source_sha256: result.sourceSha256,
      outcome: result.record.status,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ─── route handlers ─────────────────────────────────────────────────────────

/**
 * POST /lease
 *
 * Body: CreateLeaseOpts (see lease-engine.mjs). The actor and targetProject
 * are required. allowed/forbidden default to []. DEFAULT_FORBIDDEN is merged
 * into forbidden by the engine — the client cannot opt out.
 */
async function handleCreateLease(req) {
  const body = await parseJsonBody(req);
  try {
    const lease = createLease(body);
    return ok({ lease, default_forbidden: DEFAULT_FORBIDDEN });
  } catch (e) {
    if (e instanceof HermesError) {
      return err(e.code, e.message, 400, e.detail);
    }
    throw e;
  }
}

/**
 * POST /lease/:id/revoke
 *
 * Body: { actor?: string, reason?: string }
 *
 * Revocation is a safety primitive, not an effectful host action. It is exposed
 * only on the loopback daemon and gateway-mediated route so smoke tests can
 * prove that a previously valid lease stops authorizing actions.
 */
async function handleRevokeLease(req, leaseId) {
  const body = await parseJsonBody(req);
  try {
    const actor = typeof body.actor === "string" ? body.actor : "unknown";
    const reason = typeof body.reason === "string" ? body.reason : "operator requested revocation";
    const revoked = revokeLease(leaseId, `${actor}: ${reason}`);
    return ok({ lease_id: leaseId, revoked: revoked !== false });
  } catch (e) {
    if (e instanceof HermesError) {
      return err(e.code, e.message, 400, e.detail);
    }
    throw e;
  }
}

/**
 * POST /action
 *
 * Body:
 *   {
 *     lease_id:    string  (required)
 *     action_verb: string  (required — the verb proposed; checked against lease)
 *     actor:       string  (required — must match lease.actor)
 *     order:       object  (orange.order.v1)
 *     report:      object  (orange.report.v1)
 *     action:      object  (the action envelope inspected by Misfit + gates 6/7/8;
 *                           may carry `risk_level` to drive Misfit branching)
 *     receipt_path: string (optional override; otherwise read from order)
 *   }
 *
 * Behaviour:
 *   1. lookup lease in active set → 404 if not found
 *   2. checkAction(lease, verb) → 403 if denied
 *   3. AE Misfit pre-action second-opinion (Wave 3-04) → 409 misfit_refused
 *      on REFUSE without signed override (kill-switch + unreachable handled)
 *   4. runLoomChain(ctx)        → 409 gate_failed on any gate fail (with full results)
 *   5. on full pass: return { pass: true, results, misfit, lease_id }
 *
 * This handler does NOT itself execute the action against the host. That is
 * the caller's responsibility — Hermes is the policy chokepoint, not the
 * effector. A passing /action response means "you are cleared to land it";
 * the caller then performs the side effect and posts the report path back
 * through the normal Orange5 receipt pipeline.
 */
async function handleAction(req) {
  const body = await parseJsonBody(req);
  const required = ["lease_id", "action_verb", "actor"];
  for (const k of required) {
    if (typeof body[k] !== "string" || body[k].length === 0) {
      return err("invalid_request", `missing or invalid required field: ${k}`, 400, { field: k });
    }
  }

  // Lease lookup
  const lease = listActive().find(l => l.id === body.lease_id);
  if (!lease) {
    const settlement = await settleActionReceipt(
      body,
      SETTLEMENT_OUTCOMES.REFUSED,
      "Hermes could not find an active lease for the requested action.",
      ["refusal:lease_not_found"],
    );
    return err("lease_not_found", `no active lease with id ${body.lease_id}`, 404, {
      pre_action_settlement: settlement,
    });
  }

  // First-pass policy decision (cheap, sync, no I/O)
  const policy = checkAction(lease, body.action_verb, { operator_approved: Boolean(body.operator_approved) });
  if (!policy.allowed) {
    const settlement = await settleActionReceipt(
      body,
      SETTLEMENT_OUTCOMES.REFUSED,
      `Hermes lease policy refused the action: ${policy.reason}`,
      [`refusal:${policy.reason}`],
    );
    return err("lease_refused", `lease policy refused: ${policy.reason}`, 403, {
      reason: policy.reason,
      detail: policy.detail,
      pre_action_settlement: settlement,
    });
  }

  // Build context for Misfit middleware AND LOOM chain (single shape).
  const ctx = {
    lease,
    actor: body.actor,
    actionVerb: body.action_verb,
    order: body.order,
    report: body.report,
    action: body.action,
    receipt_path: body.receipt_path,
  };

  // ── AE Misfit pre-action second-opinion (Wave 3-04, live) ────────────────
  // Runs BEFORE the LOOM gate chain. Risk-level matrix:
  //   low      → pass-through
  //   medium   → advisory (logged, never blocks)
  //   high     → blocking REFUSE unless signed operator override
  //   critical → blocking REFUSE unless signed override (gate 4 still runs)
  // Kill-switch: HERMES_MISFIT_DISABLED=1 → loud warning, pass-through.
  // Unreachable: middleware returns "allow-with-warning" → loud warning,
  //              pass-through (we do NOT pretend-confirm).
  let misfit;
  try {
    misfit = await runMisfitMiddleware(ctx);
  } catch (e) {
    const settlement = await settleActionReceipt(
      body,
      SETTLEMENT_OUTCOMES.REFUSED,
      `Misfit middleware failed before authorization: ${e?.message || String(e)}`,
      ["refusal:misfit_middleware_failed"],
    );
    if (e instanceof ServerError) {
      return err(e.code, e.message, e.status, {
        ...(e.detail || {}),
        pre_action_settlement: settlement,
      });
    }
    return err(
      "misfit_middleware_failed",
      e && e.message ? e.message : "Misfit middleware failed",
      500,
      { pre_action_settlement: settlement },
    );
  }
  if (misfit.decision === "block") {
    const settlement = await settleActionReceipt(
      body,
      SETTLEMENT_OUTCOMES.REFUSED,
      `AE Misfit refused the action at risk level ${misfit.risk_level}.`,
      [`misfit_audit:${misfit.audit_id}`],
    );
    return err(
      "misfit_refused",
      `AE Misfit second-opinion refused this action (risk_level=${misfit.risk_level})`,
      409,
      {
        misfit,
        override_hint:
          `Place a signed override at 08-HERMES/approvals/override-${lease.id}.json ` +
          `with { signed_by: "atom", lease_id: "${lease.id}", approved: true }`,
        pre_action_settlement: settlement,
      },
    );
  }

  // ── Full LOOM chain ──────────────────────────────────────────────────────
  const chain = await runLoomChain(ctx);

  if (!chain.pass) {
    const failedAt = chain.results.find(r => !r.pass);
    const settlement = await settleActionReceipt(
      body,
      SETTLEMENT_OUTCOMES.REFUSED,
      `LOOM chain halted at gate ${failedAt.index} (${failedAt.id}).`,
      [`failed_gate:${failedAt.id}`, `misfit_audit:${misfit.audit_id}`],
    );
    return err(
      "gate_failed",
      `LOOM chain halted at gate ${failedAt.index} (${failedAt.id})`,
      409,
      { results: chain.results, failed_gate: failedAt.id, misfit, pre_action_settlement: settlement },
    );
  }

  const settlement = await settleActionReceipt(
    body,
    SETTLEMENT_OUTCOMES.AUTHORIZED,
    "All eight LOOM gates passed; the action is authorized but not yet executed.",
    [`loom_gates:${chain.results.length}`, `misfit_audit:${misfit.audit_id}`],
  );
  if (!settlement?.ok) {
    return err(
      "receipt_settlement_failed",
      "LOOM passed but the pre-action receipt could not be settled; authorization is withheld.",
      500,
      { pre_action_settlement: settlement, results: chain.results, misfit },
    );
  }

  return ok({
    pass: true,
    lease_id: lease.id,
    misfit,
    results: chain.results,
    pre_action_settlement: settlement,
  });
}

/**
 * GET /healthz
 */
async function handleHealth() {
  const active = listActive();
  return ok({
    status: "alive",
    bind: `${HOST}:${PORT}`,
    active_leases: active.length,
    gates: GATE_FILES.length,
    sovereign: SOVEREIGN_PRINCIPAL,
    misfit: {
      enabled: !MISFIT_DISABLED,
      kill_switch_env: "HERMES_MISFIT_DISABLED",
      middleware_path: MISFIT_MIDDLEWARE_PATH,
      audit_log: MISFIT_AUDIT_LOG,
      load_error: _misfitLoadError,
    },
    time: new Date().toISOString(),
  });
}

/**
 * GET /approvals
 *
 * Returns the current pending-approvals queue, joined to live lease state so
 * the operator can see which approvals are still actionable (lease active +
 * not yet approved + not expired).
 */
async function handleListApprovals() {
  let records;
  try {
    records = await readApprovalsQueue();
  } catch (e) {
    if (e instanceof ServerError) {
      return err(e.code, e.message, e.status, e.detail);
    }
    throw e;
  }
  const active = listActive();
  const activeById = new Map(active.map(l => [l.id, l]));
  const out = records.map(rec => ({
    record: rec,
    lease_status: activeById.has(rec.lease_id) ? "active" : "missing_or_expired",
  }));
  const pending = out.filter(r => r.record && r.record.approved !== true);
  return ok({ count: out.length, pending: pending.length, items: out });
}

/**
 * POST /approvals/:id
 *
 * Body: { approved: boolean, note?: string }
 *
 * Records the Sovereign's decision against `lease_id = :id`. Writes a signed
 * record to pending.jsonl that gate 4 (human_approval) reads. Signature
 * semantics: see the honest-gaps preamble — this daemon trusts the loopback
 * peer because the gateway is the only public surface.
 */
async function handleApprove(req, leaseId) {
  if (!leaseId || typeof leaseId !== "string") {
    return err("invalid_request", "lease id missing from path", 400);
  }
  const body = await parseJsonBody(req);
  if (typeof body.approved !== "boolean") {
    return err("invalid_request", "body.approved must be boolean", 400);
  }

  // We do not require the lease to still be active to record the decision —
  // late approvals are useful in audit. But we DO surface that state so the
  // operator can see at a glance that the approval will not be honoured.
  const active = listActive();
  const lease = active.find(l => l.id === leaseId) || null;

  const record = {
    record_id: `appr_${Date.now()}_${randomUUID().slice(0, 8)}`,
    lease_id: leaseId,
    approved: body.approved,
    signed: true,
    signed_by: SOVEREIGN_PRINCIPAL,
    signature: null, // gateway-side signing not yet wired; see honest gaps
    note: typeof body.note === "string" ? body.note : null,
    decided_at: new Date().toISOString(),
    lease_active_at_decision: Boolean(lease),
  };
  await appendApproval(record);

  return ok({ approval: record, lease_active_at_decision: record.lease_active_at_decision });
}

// ─── top-level fetch handler ────────────────────────────────────────────────

/**
 * Bun.serve fetch handler. Pure async function so it can also be wrapped by
 * a Node `http.createServer` adapter if a future runtime swap is needed.
 *
 * @param {Request} req
 * @param {{ ip?: string } | null} info  — Bun passes server info here
 */
export async function handle(req, info = null) {
  const respond = (response) => withLocalAppCors(response, req);
  try {
    assertLoopback(req, info);

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      if (!localAppOrigin(req.headers.get("origin"))) {
        return respond(err("origin_refused", "browser origin is not an allowed local Orange app", 403));
      }
      return respond(new Response(null, { status: 204 }));
    }

    if (method === "GET" && path === "/healthz") return respond(await handleHealth());
    if (method === "POST" && path === "/lease") return respond(await handleCreateLease(req));
    const revokeMatch = /^\/lease\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revokeMatch) {
      return respond(await handleRevokeLease(req, decodeURIComponent(revokeMatch[1])));
    }
    if (method === "POST" && path === "/action") return respond(await handleAction(req));
    if (method === "GET" && path === "/approvals") return respond(await handleListApprovals());

    // POST /approvals/:id
    const approveMatch = path.match(/^\/approvals\/([^\/]+)\/?$/);
    if (method === "POST" && approveMatch) {
      return respond(await handleApprove(req, decodeURIComponent(approveMatch[1])));
    }

    return respond(err("not_found", `no route for ${method} ${path}`, 404));
  } catch (e) {
    if (e instanceof ServerError) {
      return respond(err(e.code, e.message, e.status, e.detail));
    }
    if (e instanceof HermesError) {
      return respond(err(e.code, e.message, 400, e.detail));
    }
    // Last-resort: never leak a stack to the client.
    return respond(err("internal", e && e.message ? e.message : "unexpected error", 500));
  }
}

// ─── bootstrap (Bun) ────────────────────────────────────────────────────────

/**
 * Start the Hermes daemon. Initializes the lease engine, preloads the gate
 * chain (so the first /action call doesn't pay the import latency), and
 * starts the Bun HTTP listener bound to 127.0.0.1:7430.
 *
 * @returns {Promise<{ stop: () => Promise<void>, port: number }>}
 */
export async function start() {
  initLeaseEngine();
  await loadGateChain(); // fail fast if any gate file is broken
  await ensureApprovalsFile();
  await ensureAuditFile(); // Misfit audit log directory + file ready before first request

  // Preload Misfit middleware unless kill-switch is set. We do NOT throw on
  // a load failure here — the failure is surfaced on every /action so the
  // operator sees it as a deliberate refusal, not a silent skip.
  if (MISFIT_DISABLED) {
    try {
      console.error(
        "hermes: WARN HERMES_MISFIT_DISABLED=1 at boot — Misfit second-opinion will be bypassed for all /action requests",
      );
    } catch { /* no-op */ }
  } else {
    try {
      await loadMisfitMiddleware();
    } catch (e) {
      try {
        console.error(
          "hermes: WARN Misfit middleware failed to preload — /action requests will fail-closed with misfit_middleware_load_failed:",
          e && e.message ? e.message : e,
        );
      } catch { /* no-op */ }
    }
  }

  if (typeof Bun === "undefined") {
    // We deliberately fail fast rather than half-starting a Node adapter that
    // isn't shipped. Add the adapter here if/when Node hosting is needed.
    throw new ServerError(
      "runtime_unsupported",
      "server.mjs requires Bun (no Node http adapter shipped) — see honest-gaps in the file header",
      500,
    );
  }

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 255,
    fetch: (req, srv) => {
      // Bun's server gives us req.headers and a way to read the peer ip via
      // `server.requestIP(req)`. Wrap so handle() gets a uniform info shape.
      let ip = null;
      try {
        const probe = srv.requestIP?.(req);
        if (probe && typeof probe.address === "string") ip = probe.address;
      } catch { /* no-op — fall back to Host header check */ }
      if (req.method !== "GET") srv.timeout(req, 255);
      return handle(req, { ip });
    },
    error(e) {
      return err("internal", e && e.message ? e.message : "server error", 500);
    },
  });

  // Graceful shutdown.
  const stop = async () => {
    try { server.stop(true); } catch { /* server already down */ }
    try { closeLeaseEngine(); } catch { /* engine already closed */ }
  };

  const onSignal = (sig) => {
    // Best-effort log; don't crash on console issues in unusual hosts.
    try { console.error(`hermes: received ${sig}, shutting down`); } catch { /* no-op */ }
    stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try { console.error(`hermes: listening on http://${HOST}:${PORT}`); } catch { /* no-op */ }
  return { stop, port: PORT };
}

// Auto-start when executed directly (Bun: `bun run src/server.mjs`).
// import.meta.main is true on Bun for the entry module.
if (import.meta.main) {
  start().catch((e) => {
    try { console.error("hermes failed to start:", e && e.message ? e.message : e); } catch { /* no-op */ }
    process.exit(1);
  });
}

// ─── exports for tests ──────────────────────────────────────────────────────

export {
  ServerError,
  APPROVALS_QUEUE,
  GATE_FILES,
  SOVEREIGN_PRINCIPAL,
  MISFIT_MIDDLEWARE_PATH,
  MISFIT_AUDIT_LOG,
  MISFIT_DISABLED,
  readApprovalsQueue,
  appendApproval,
  ensureApprovalsFile,
  ensureAuditFile,
  appendMisfitAudit,
  loadMisfitOverride,
};
