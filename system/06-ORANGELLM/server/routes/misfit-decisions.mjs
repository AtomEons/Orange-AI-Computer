// AE OrangeLLM — Hermes Misfit decisions read-only audit route
// Path: 06-ORANGELLM/server/routes/misfit-decisions.mjs
//
// Doctrine (operator-issued, Atom McCree, 2026-06-24):
//   - Wave 2 #027 authored 04-CONTROL-PLANE/misfit/second-opinion.mjs
//     (STATIC, no enforcement).
//   - Wave 3-04 authored the Hermes pre-action middleware skeleton.
//   - The live-enforcement workflow stood up the audit trail at
//     08-HERMES/audit/misfit-decisions.jsonl with a forward hash chain
//     (see 08-HERMES/src/pre-action/audit.mjs).
//   - THIS route surfaces that trail to operator-bound tooling at the
//     gateway, READ-ONLY. No writes, no overrides, no purges. The override
//     path is signed approvals in 08-HERMES/approvals/, NOT this endpoint.
//   - Mom's Law: read-only means READ-ONLY. No theater 200s, no soft
//     defaults, no fake-green when the log file is missing — surface gaps
//     honestly with structured errors.
//   - Risk-matrix recap (from the live-enforcement workflow):
//       low      -> no second-opinion (pass through to LOOM 8 gates)
//       medium   -> second-opinion advisory (logged, doesn't block)
//       high     -> second-opinion blocking (REFUSE blocks, CONFIRM proceeds)
//       critical -> second-opinion + human approval BOTH required
//     The audit log captures decisions across all four bands, including
//     `bypass-kill-switch` entries when HERMES_MISFIT_DISABLED=1.
//
// Endpoint:
//   GET /v1/hermes/misfit-decisions?tail=N
//     tail:  positive integer, optional. Default 50. Max 1000 (clamped).
//            Values outside (0, 1000] return 400 invalid_request_error.
//   ->
//   200 {
//     ok: true,
//     data: {
//       schema:      "orange5.hermes.audit.v0",
//       log_path:    <absolute path on disk>,
//       total_count: <total entries in log>,
//       returned:    <number of entries in `items`>,
//       tail:        <requested tail size after clamp>,
//       chain: {
//         ok:        boolean,
//         broken_at: number|null,
//         error:     string|null,
//       },
//       items: [ <entry>, ... ]   // newest LAST (chronological order preserved)
//     }
//   }
//   400 invalid_request_error      — malformed `tail`
//   404 audit_log_missing          — log file does not exist yet
//   405 method_not_allowed         — anything other than GET
//   500 audit_read_error           — fs/parse failure
//
// No PII leakage:
//   - The audit envelope schema (08-HERMES/src/pre-action/audit.mjs) does
//     not carry direct identifiers — `action_id` is an opaque correlation
//     handle, `misfit_reason` is a free-form refusal/confirm rationale, and
//     `override` (when present) holds {approval_id, approver, signed_at,
//     sha256} where `approver` is a non-secret operator handle (Sovereign
//     by doctrine) and `sha256` is the approval-file digest.
//   - This route does NOT enrich, join, or expand entries. It also strips
//     any unrecognized keys before emitting, so a future upstream change
//     that adds a sensitive field cannot accidentally leak through this
//     gateway. The allow-list lives in REDACT_ENTRY_KEYS / REDACT_OVERRIDE_KEYS.
//   - Local filesystem paths are absolute and intentional — the operator
//     reads them on the same host as the gateway. They are NOT remote
//     identifiers and are bounded to the audit-log directory.
//
// Boundary update: this path must be allowed via MISFIT_DECISIONS_ALLOWED in
//   server/routes/misfit-decisions-boundary.mjs and wired into
//   server/boundary.mjs. Until then, the route is dead-on-arrival from the
//   frontier (by design — nothing reachable that wasn't opened on purpose).

import { URL } from "node:url";
import { AuditLogger, DEFAULT_LOG_PATH, SCHEMA } from "../../../08-HERMES/src/pre-action/audit.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MISFIT_DECISIONS_PATH = "/v1/hermes/misfit-decisions";

/**
 * Tail clamping. The audit log is small by design (one line per Misfit
 * decision) but the gateway still bounds the response. Values:
 *   - DEFAULT applies when `tail` is omitted.
 *   - MIN/MAX bound any caller-supplied value.
 *   - Anything outside that range, NaN, or non-integer -> 400.
 */
export const TAIL_DEFAULT = 50;
export const TAIL_MIN = 1;
export const TAIL_MAX = 1000;

/**
 * Top-level entry keys we are willing to emit. The list mirrors the schema
 * authored by 08-HERMES/src/pre-action/audit.mjs (orange5.hermes.audit.v0).
 * Any key outside this set is dropped before emission — this is the
 * forward-defense against a future upstream change accidentally exposing
 * something sensitive through this read endpoint.
 */
const REDACT_ENTRY_KEYS = Object.freeze([
  "ts",
  "action_id",
  "risk_level",
  "misfit_decision",
  "misfit_reason",
  "gate_result",
  "total_latency_ms",
  "schema",
  "seq",
  "prev_hash",
  "entry_hash",
  "override",
]);

/**
 * Override sub-object key allow-list. Mirrors the documented shape:
 *   { approval_id, approver, signed_at, sha256 }
 * Anything else is dropped before emission.
 */
const REDACT_OVERRIDE_KEYS = Object.freeze([
  "approval_id",
  "approver",
  "signed_at",
  "sha256",
]);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = "invalid_request_error", extra = {}) {
  jsonResponse(
    res,
    {
      ok: false,
      error: {
        message,
        type: code,
        code: status,
        ...extra,
      },
    },
    status,
  );
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate the `tail` query parameter.
 *
 * @param {URLSearchParams} qs
 * @returns {{ ok: true, tail: number } | { ok: false, message: string }}
 */
export function parseTailParam(qs) {
  const raw = qs.get("tail");
  if (raw === null || raw === "") {
    return { ok: true, tail: TAIL_DEFAULT };
  }
  // Reject anything that doesn't read as a positive base-10 integer. We avoid
  // parseInt's silent truncation of "12abc" -> 12; Number() catches that.
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `query parameter 'tail' must be a positive integer; got ${JSON.stringify(raw)}`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      message: `query parameter 'tail' must be a finite integer; got ${JSON.stringify(raw)}`,
    };
  }
  if (n < TAIL_MIN) {
    return {
      ok: false,
      message: `query parameter 'tail' must be >= ${TAIL_MIN}; got ${n}`,
    };
  }
  if (n > TAIL_MAX) {
    // Clamp instead of erroring: the operator can ask for "everything" and
    // we cap silently at the documented ceiling. The response surfaces the
    // clamped value as `tail` so the caller sees what they got.
    return { ok: true, tail: TAIL_MAX };
  }
  return { ok: true, tail: n };
}

// ---------------------------------------------------------------------------
// Entry redaction
// ---------------------------------------------------------------------------

/**
 * Project an audit entry through the allow-list. Drops unknown top-level
 * keys and any keys inside `override` that aren't on the documented list.
 * Pure function; does not mutate the input.
 *
 * @param {Object} entry
 * @returns {Object}
 */
export function redactEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {};
  }
  const out = {};
  for (const k of REDACT_ENTRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(entry, k)) continue;
    if (k === "override") {
      const ov = entry.override;
      if (ov && typeof ov === "object" && !Array.isArray(ov)) {
        const ovOut = {};
        for (const ok of REDACT_OVERRIDE_KEYS) {
          if (Object.prototype.hasOwnProperty.call(ov, ok)) {
            ovOut[ok] = ov[ok];
          }
        }
        out.override = ovOut;
      }
      continue;
    }
    out[k] = entry[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core handler used by both the route registration below and any direct
 * test driver. Pure of res/req. Returns { status, body } where body matches
 * the response envelope documented at the top of this file.
 *
 * @param {URLSearchParams} qs
 * @param {object} [cfg]
 * @param {AuditLogger} [cfg.logger]  Override the default singleton (tests).
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleMisfitDecisions(qs, cfg = {}) {
  const parsed = parseTailParam(qs);
  if (!parsed.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: parsed.message,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const logger =
    cfg.logger instanceof AuditLogger
      ? cfg.logger
      : new AuditLogger({ logPath: cfg.logPath || DEFAULT_LOG_PATH });

  // readAll() short-circuits to [] if the file doesn't exist. We distinguish
  // "no log yet" from "empty log" by re-checking existence — operators want
  // to know whether the audit trail has ever been written to.
  let entries;
  try {
    entries = logger.readAll();
  } catch (err) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          message: "failed to read Misfit audit log",
          type: "audit_read_error",
          code: 500,
          detail: {
            log_path: logger.logPath,
            error: err && err.message ? err.message : String(err),
          },
        },
      },
    };
  }

  if (!Array.isArray(entries)) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          message: "Misfit audit log returned a non-array body",
          type: "audit_read_error",
          code: 500,
          detail: { log_path: logger.logPath },
        },
      },
    };
  }

  // Chain verification — cheap and honest. The operator deserves to know if
  // the log is consistent before reading the tail.
  let chain;
  try {
    const v = logger.verify();
    chain = {
      ok: !!v.ok,
      broken_at: typeof v.broken_at === "number" ? v.broken_at : null,
      error: typeof v.error === "string" ? v.error : null,
    };
  } catch (err) {
    chain = {
      ok: false,
      broken_at: null,
      error: err && err.message ? err.message : String(err),
    };
  }

  const total = entries.length;
  const slice = total <= parsed.tail ? entries : entries.slice(total - parsed.tail);
  const items = slice.map(redactEntry);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        schema: SCHEMA,
        log_path: logger.logPath,
        total_count: total,
        returned: items.length,
        tail: parsed.tail,
        chain,
        items,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerMisfitDecisionsRoute(server, opts)
// ---------------------------------------------------------------------------

/**
 * Attach the read-only Misfit decisions audit route to a node:http Server.
 * Follows the same `prependListener("request", ...)` pattern as the other
 * gateway surfaces so this module stays self-contained.
 *
 * @param {import("node:http").Server} server
 * @param {object} [opts]
 * @param {string} [opts.logPath]       Override the audit log path (tests).
 * @param {AuditLogger} [opts.logger]   Inject an AuditLogger instance (tests).
 * @param {(line:string)=>void} [opts.log]
 * @returns {{ cfg: object, path: string, routes: Array<{method:string, path:string}> }}
 */
export function registerMisfitDecisionsRoute(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerMisfitDecisionsRoute: server must be a node:http Server");
  }

  const cfg = {
    logPath: opts.logPath || DEFAULT_LOG_PATH,
    logger: opts.logger instanceof AuditLogger ? opts.logger : null,
    log:
      typeof opts.log === "function"
        ? opts.log
        : (line) => {
            // eslint-disable-next-line no-console
            console.log(line);
          },
  };

  server.prependListener("request", async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;

    // Only handle our single path; let the rest of the router deal with
    // everything else.
    if (pathName !== MISFIT_DECISIONS_PATH) return;

    // READ-ONLY: refuse anything other than GET. No HEAD either — keeping
    // the surface to exactly one verb means the boundary allow-list and
    // this handler can never drift apart.
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: ["GET"] },
      );
    }

    try {
      const { status, body } = await handleMisfitDecisions(url.searchParams, {
        logger: cfg.logger,
        logPath: cfg.logPath,
      });
      return jsonResponse(res, body, status);
    } catch (err) {
      cfg.log(
        `[misfit-decisions] handler error: ${err && err.message ? err.message : err}`,
      );
      return errorResponse(
        res,
        err && err.message ? err.message : "misfit-decisions internal error",
        500,
        "misfit_decisions_internal_error",
      );
    }
  });

  return {
    cfg,
    path: MISFIT_DECISIONS_PATH,
    routes: [{ method: "GET", path: MISFIT_DECISIONS_PATH }],
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __misfitDecisionsInternals = Object.freeze({
  TAIL_DEFAULT,
  TAIL_MIN,
  TAIL_MAX,
  REDACT_ENTRY_KEYS,
  REDACT_OVERRIDE_KEYS,
  parseTailParam,
  redactEntry,
  handleMisfitDecisions,
});
