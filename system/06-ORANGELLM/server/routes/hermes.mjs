// AE OrangeLLM — Hermes gateway routes
// Path: 06-ORANGELLM/server/routes/hermes.mjs
//
// Doctrine (operator-issued, Atom McCree):
//   - Hermes is the bounded execution layer for the Orange5 superstack. It
//     replaces "OpenClaw". Every action by any LLM in the superstack must
//     pass through a Hermes lease + the 8-gate LOOM chain before it can
//     land on the host.
//   - The Hermes daemon listens on 127.0.0.1:7430. The daemon is LOOPBACK
//     ONLY. The frontier model never opens a socket there directly. These
//     gateway routes are the only door from outside the box, and they live
//     inside the OrangeLLM gateway at 127.0.0.1:1337 which the main
//     boundary already fences with the Frontier-Isolation contract.
//   - Default forbidden verbs (destructive_write, production_deploy,
//     scope_expansion, egress_unbounded) are auto-merged by the daemon's
//     lease engine. The gateway does not duplicate that merging; it would
//     drift. The gateway is a thin proxy and surfaces whatever the daemon
//     returns.
//   - Mom's Law applies: no theater 200s, no silent fall-throughs, no
//     soft "looks fine" defaults. Every error returns a structured body
//     with `type` and `code`. When the daemon is unreachable, the gateway
//     refuses to render a fake-green; it returns 503 with an honest gap
//     pointing at how to bring the daemon up.
//
// Endpoints (all under /v1/hermes/):
//   POST /v1/hermes/lease
//     body:  see 08-HERMES/src/lease-engine.mjs createLease (actor,
//            allowed[], forbidden[], targetProject, riskLevel,
//            requires_approval, ttl_ms, etc.)
//     ->     200 { ok:true, data:{ lease, default_forbidden } }
//            400 invalid_request, 502 hermes_upstream_error,
//            503 hermes_unreachable
//
//   POST /v1/hermes/action
//     body:  { lease_id, action_verb, actor, order, report, action,
//              receipt_path?, operator_approved? }
//     ->     200 { ok:true, data:{ pass:true, lease_id, results } }
//            403 lease_refused, 404 lease_not_found,
//            409 gate_failed (with full per-gate results),
//            502 hermes_upstream_error, 503 hermes_unreachable
//
//   GET  /v1/hermes/approvals
//     ->     200 { ok:true, data:{ count, pending, items } }
//            502 hermes_upstream_error, 503 hermes_unreachable
//
// Boundary update: these paths must be allowed via HERMES_ALLOWED in
//   server/routes/hermes-boundary.mjs and wired into server/boundary.mjs.
//   Until then, the routes are dead-on-arrival from the frontier (by
//   design — Mom's Law: nothing reachable that wasn't opened on purpose).
//
// Smoke test: 08-HERMES/smoke-test.mjs

import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERMES_PATH_PREFIX = "/v1/hermes";
export const HERMES_LEASE_PATH = `${HERMES_PATH_PREFIX}/lease`;
export const HERMES_ACTION_PATH = `${HERMES_PATH_PREFIX}/action`;
export const HERMES_APPROVALS_PATH = `${HERMES_PATH_PREFIX}/approvals`;
export const HERMES_LEASE_REVOKE_RX = /^\/v1\/hermes\/lease\/([^/]+)\/revoke$/;

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB cap on Hermes envelopes

// Hermes daemon upstream — loopback only by doctrine. The operator can point
// this at a different host via env (e.g. for a hermetic test sandbox) but
// the production default is 127.0.0.1:7430 and nothing else.
export const HERMES_UPSTREAM = Object.freeze({
  name: "hermes",
  base_url: process.env.AE_HERMES_BASE_URL || "http://127.0.0.1:7430",
  lease_path: "/lease",
  action_path: "/action",
  approvals_path: "/approvals",
  lease_revoke_path: "/lease",
  healthz_path: "/healthz",
  timeout_ms: Number(process.env.AE_HERMES_TIMEOUT_MS || 30_000),
  probe_timeout_ms: Number(process.env.AE_HERMES_PROBE_TIMEOUT_MS || 10_000),
});

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

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error(`request body exceeds ${capBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Hermes daemon probe + proxy
// ---------------------------------------------------------------------------

/**
 * Probe the Hermes daemon's /healthz. Surfaces "down" honestly rather than
 * silently degrading. No fake-greens from the gateway itself.
 *
 * @param {object} cfg
 * @returns {Promise<{ live: boolean, http?: number, error?: string }>}
 */
async function probeHermes(cfg) {
  try {
    const res = await fetchWithTimeout(
      `${cfg.upstream.base_url}${cfg.upstream.healthz_path}`,
      { method: "GET" },
      cfg.upstream.probe_timeout_ms,
    );
    return { live: res.ok, http: res.status };
  } catch (err) {
    return { live: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Forward a request to the Hermes daemon and parse its uniform response
 * envelope `{ ok, data?, error? }`. Returns a {status, body} pair so the
 * caller can render it back to the gateway client without losing the
 * daemon's intended HTTP status code.
 *
 * @param {object} cfg
 * @param {"POST"|"GET"} method
 * @param {string} path                 — daemon-side path (e.g. "/lease")
 * @param {object|null} payload
 * @returns {Promise<{ status: number, body: object }>}
 */
async function proxyToHermes(cfg, method, path, payload) {
  const url = `${cfg.upstream.base_url}${path}`;
  const init = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(payload ?? {});
  }

  let res;
  try {
    res = await fetchWithTimeout(url, init, cfg.upstream.timeout_ms);
  } catch (err) {
    // Network-level failure (refused, timed out, DNS, abort). Don't pretend.
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          message:
            "Hermes daemon unreachable; refusing to render a verdict rather than " +
            "silently approve. Bring up 08-HERMES (bun run src/server.mjs).",
          type: "hermes_unreachable",
          code: 503,
          detail: {
            upstream: cfg.upstream.base_url,
            target: path,
            error: err && err.message ? err.message : String(err),
          },
        },
      },
    };
  }

  // Read body once; tolerate non-JSON (the daemon should not emit it, but
  // we surface honestly if it ever does).
  const text = await res.text().catch(() => "");
  let parsed = null;
  let parseError = null;
  if (text && text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parseError = err && err.message ? err.message : String(err);
    }
  }

  // Daemon returned non-2xx with an unparseable body: structured 502.
  if (parseError) {
    return {
      status: 502,
      body: {
        ok: false,
        error: {
          message: `Hermes daemon returned non-JSON body (http ${res.status})`,
          type: "hermes_upstream_error",
          code: 502,
          detail: {
            upstream: cfg.upstream.base_url,
            target: path,
            http: res.status,
            parse_error: parseError,
            body_preview: text.slice(0, 200),
          },
        },
      },
    };
  }

  if (parsed === null) {
    // Empty body, non-OK status: still structured.
    if (!res.ok) {
      return {
        status: 502,
        body: {
          ok: false,
          error: {
            message: `Hermes daemon returned empty body (http ${res.status})`,
            type: "hermes_upstream_error",
            code: 502,
            detail: {
              upstream: cfg.upstream.base_url,
              target: path,
              http: res.status,
            },
          },
        },
      };
    }
    // Empty body, 2xx: weird but not fatal — surface as ok:true with no data.
    return { status: res.status, body: { ok: true, data: null } };
  }

  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Validation (gateway side)
// ---------------------------------------------------------------------------
//
// The daemon does its own deep validation. The gateway does shallow shape
// checks ONLY so we can return 400s for obvious client errors without paying
// a round-trip. Anything subtle (lease policy, gate enforcement) belongs to
// the daemon.

function validateLeaseBody(body) {
  const errors = [];
  if (typeof body.actor !== "string" || body.actor.length === 0) {
    errors.push("field 'actor' is required and must be a non-empty string");
  }
  if (typeof body.targetProject !== "string" || body.targetProject.length === 0) {
    errors.push("field 'targetProject' is required and must be a non-empty string");
  }
  if (body.allowed !== undefined && !Array.isArray(body.allowed)) {
    errors.push("field 'allowed' must be an array of action-verb strings");
  }
  if (body.forbidden !== undefined && !Array.isArray(body.forbidden)) {
    errors.push("field 'forbidden' must be an array of action-verb strings");
  }
  if (body.riskLevel !== undefined && typeof body.riskLevel !== "string") {
    errors.push("field 'riskLevel' must be a string");
  }
  if (body.ttl_ms !== undefined && (typeof body.ttl_ms !== "number" || body.ttl_ms <= 0)) {
    errors.push("field 'ttl_ms' must be a positive number when present");
  }
  if (body.requires_approval !== undefined && typeof body.requires_approval !== "boolean") {
    errors.push("field 'requires_approval' must be a boolean when present");
  }
  return errors;
}

function validateActionBody(body) {
  const errors = [];
  for (const k of ["lease_id", "action_verb", "actor"]) {
    if (typeof body[k] !== "string" || body[k].length === 0) {
      errors.push(`field '${k}' is required and must be a non-empty string`);
    }
  }
  if (body.order !== undefined && (body.order === null || typeof body.order !== "object" || Array.isArray(body.order))) {
    errors.push("field 'order' must be an object when present (orange.order.v1)");
  }
  if (body.report !== undefined && (body.report === null || typeof body.report !== "object" || Array.isArray(body.report))) {
    errors.push("field 'report' must be an object when present (orange.report.v1)");
  }
  if (body.action !== undefined && (body.action === null || typeof body.action !== "object" || Array.isArray(body.action))) {
    errors.push("field 'action' must be an object when present");
  }
  if (body.receipt_path !== undefined && typeof body.receipt_path !== "string") {
    errors.push("field 'receipt_path' must be a string when present");
  }
  if (body.operator_approved !== undefined && typeof body.operator_approved !== "boolean") {
    errors.push("field 'operator_approved' must be a boolean when present");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/hermes/lease
 *
 * Thin proxy to Hermes daemon POST /lease. Shallow shape validation only.
 * Default forbidden verbs are auto-merged inside the daemon — see
 * 08-HERMES/src/lease-engine.mjs DEFAULT_FORBIDDEN. The gateway does not
 * duplicate that merging.
 */
export async function handleHermesLease(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const errors = validateLeaseBody(src);
  if (errors.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "lease body validation failed",
          type: "invalid_request_error",
          code: 400,
          detail: { errors },
        },
      },
    };
  }

  const probe = await probeHermes(cfg);
  if (!probe.live) {
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          message:
            "Hermes daemon is not reachable on healthz; refusing to mint a lease " +
            "rather than silently approve. Bring up 08-HERMES on 127.0.0.1:7430.",
          type: "hermes_unreachable",
          code: 503,
          detail: {
            probe,
            upstream: cfg.upstream.base_url,
          },
        },
      },
    };
  }

  return proxyToHermes(cfg, "POST", cfg.upstream.lease_path, src);
}

/**
 * POST /v1/hermes/action
 *
 * Thin proxy to Hermes daemon POST /action. The daemon runs the 8-gate
 * LOOM chain and returns 200 (pass), 403 (lease policy refused), 404
 * (lease not found), or 409 (gate fail with full per-gate results). The
 * gateway surfaces all of those verbatim.
 */
export async function handleHermesAction(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const errors = validateActionBody(src);
  if (errors.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "action body validation failed",
          type: "invalid_request_error",
          code: 400,
          detail: { errors },
        },
      },
    };
  }

  const probe = await probeHermes(cfg);
  if (!probe.live) {
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          message:
            "Hermes daemon is not reachable on healthz; refusing to propose an " +
            "action rather than silently approve. Bring up 08-HERMES on 127.0.0.1:7430.",
          type: "hermes_unreachable",
          code: 503,
          detail: {
            probe,
            upstream: cfg.upstream.base_url,
          },
        },
      },
    };
  }

  return proxyToHermes(cfg, "POST", cfg.upstream.action_path, src);
}

/**
 * POST /v1/hermes/lease/:id/revoke
 *
 * Thin proxy to Hermes daemon POST /lease/:id/revoke. Revocation is exposed
 * because MCP safety proof must show a valid lease can be invalidated and
 * then refused on replay.
 */
export async function handleHermesLeaseRevoke(pathname, rawBody, cfg) {
  const match = HERMES_LEASE_REVOKE_RX.exec(pathname);
  if (!match) {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          message: `not a Hermes lease revoke path: ${pathname}`,
          type: "not_found",
          code: 404,
        },
      },
    };
  }

  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const probe = await probeHermes(cfg);
  if (!probe.live) {
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          message:
            "Hermes daemon is not reachable on healthz; refusing to revoke through a stale gateway.",
          type: "hermes_unreachable",
          code: 503,
          detail: {
            probe,
            upstream: cfg.upstream.base_url,
          },
        },
      },
    };
  }

  const leaseId = decodeURIComponent(match[1]);
  return proxyToHermes(cfg, "POST", `/lease/${encodeURIComponent(leaseId)}/revoke`, src);
}

/**
 * GET /v1/hermes/approvals
 *
 * Thin proxy to Hermes daemon GET /approvals. Read-only. Returns the
 * pending-approvals queue joined to live lease state so the operator
 * (via gateway-bound tooling) can see which approvals are still actionable.
 */
export async function handleHermesApprovals(cfg) {
  const probe = await probeHermes(cfg);
  if (!probe.live) {
    return {
      status: 503,
      body: {
        ok: false,
        error: {
          message:
            "Hermes daemon is not reachable on healthz; refusing to render the " +
            "approvals queue rather than show a stale picture. Bring up 08-HERMES.",
          type: "hermes_unreachable",
          code: 503,
          detail: {
            probe,
            upstream: cfg.upstream.base_url,
          },
        },
      },
    };
  }

  return proxyToHermes(cfg, "GET", cfg.upstream.approvals_path, null);
}

// ---------------------------------------------------------------------------
// Public: registerHermesRoutes(server, opts)
// ---------------------------------------------------------------------------

/**
 * Attach the Hermes gateway routes to a node:http Server. Follows the same
 * `prependListener("request", ...)` pattern as the AtomSmasher, AE Misfit,
 * and Memory routes so each surface stays self-contained.
 *
 * @param {import("node:http").Server} server
 * @param {object} [opts]
 * @param {object} [opts.upstream]   Overrides for HERMES_UPSTREAM defaults.
 * @param {(line:string)=>void} [opts.log]
 * @returns {{ cfg: object, path_prefix: string, routes: Array<{method:string, path:string}> }}
 */
export function registerHermesRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerHermesRoutes: server must be a node:http Server");
  }

  const cfg = {
    upstream: {
      ...HERMES_UPSTREAM,
      ...(opts.upstream || {}),
    },
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

    // Only handle Hermes-prefix paths; let the rest of the gateway router
    // (and the main boundary) deal with everything else.
    if (
      pathName !== HERMES_LEASE_PATH &&
      pathName !== HERMES_ACTION_PATH &&
      pathName !== HERMES_APPROVALS_PATH
    ) {
      return;
    }

    // Method enforcement per-route.
    if (pathName === HERMES_LEASE_PATH && method !== "POST") {
      res.setHeader("Allow", "POST");
      return errorResponse(res, `method ${method} not allowed on ${pathName}`, 405, "method_not_allowed", { allowed: ["POST"] });
    }
    if (pathName === HERMES_ACTION_PATH && method !== "POST") {
      res.setHeader("Allow", "POST");
      return errorResponse(res, `method ${method} not allowed on ${pathName}`, 405, "method_not_allowed", { allowed: ["POST"] });
    }
    if (pathName === HERMES_APPROVALS_PATH && method !== "GET") {
      res.setHeader("Allow", "GET");
      return errorResponse(res, `method ${method} not allowed on ${pathName}`, 405, "method_not_allowed", { allowed: ["GET"] });
    }

    try {
      if (pathName === HERMES_LEASE_PATH) {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleHermesLease(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === HERMES_ACTION_PATH) {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleHermesAction(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === HERMES_APPROVALS_PATH) {
        const { status, body } = await handleHermesApprovals(cfg);
        return jsonResponse(res, body, status);
      }
    } catch (err) {
      cfg.log(`[hermes-gateway] handler error: ${err && err.message ? err.message : err}`);
      return errorResponse(
        res,
        err && err.message ? err.message : "hermes internal error",
        500,
        "hermes_internal_error",
      );
    }
  });

  return {
    cfg,
    path_prefix: HERMES_PATH_PREFIX,
    routes: [
      { method: "POST", path: HERMES_LEASE_PATH },
      { method: "POST", path: HERMES_ACTION_PATH },
      { method: "GET", path: HERMES_APPROVALS_PATH },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __hermesInternals = {
  probeHermes,
  proxyToHermes,
  validateLeaseBody,
  validateActionBody,
  HERMES_UPSTREAM,
};
