// AE OrangeLLM — Hermes MCP gateway routes
// Path: 06-ORANGELLM/server/routes/hermes-mcp.mjs
//
// Doctrine (operator-issued, Atom McCree):
//   - These routes are the ONLY door from outside the box to Hermes' MCP
//     adapter surface. They sit in front of `08-HERMES/mcp-router.mjs` which
//     in turn dispatches into the per-server adapters (playwright.mjs from
//     Wave 2, chrome-devtools.mjs and computer-use.mjs from Wave 3).
//   - Every MCP tool call from the frontier flows:
//       frontier turn → gateway /v1/hermes/mcp/{server}/{tool}
//       → hermes-mcp.mjs (this file: validate, classify, lease-cover check)
//       → mcp-router.routeMcpCall(...)
//       → adapter.<verb>(...)
//       → POST 127.0.0.1:7430/action  (8-gate LOOM chain)
//       → MCP server (chrome-devtools / computer-use / playwright)
//     The frontier never opens a socket to 127.0.0.1:7430. The MCP servers
//     are never reached without an active lease and a passing gate chain.
//   - The four "default forbidden" wide tokens (destructive_write,
//     production_deploy, scope_expansion, egress_unbounded) are auto-merged
//     by the Hermes daemon's lease engine. This file does not duplicate that
//     merging; it asks the policy layer to CLASSIFY the call so the lease
//     can be asserted before dispatch.
//   - Mom's Law applies: no theater 200s, no silent fall-throughs, no
//     "looks fine" defaults. Every refusal returns a structured body with
//     `ok:false`, a stable `error.code`, and (when relevant) the lease/risk
//     fields the operator needs to fix the call.
//
// Endpoint shape:
//   POST /v1/hermes/mcp/{server}/{tool}
//   body: {
//     args:             object        // tool arguments (server/tool-specific)
//     lease:            object        // active Hermes lease record (REQUIRED)
//     actor?:           string        // actor override (defaults to lease.actor)
//     targetProject?:   string        // project override (defaults to lease.targetProject)
//     operatorApproved?: boolean      // pre-signed approval (Gate 4)
//   }
//
//   Servers exposed (whitelist):
//     playwright       → adapter id `hermes.adapter.playwright.v1`
//     chrome-devtools  → adapter id `hermes.adapter.chrome-devtools.v1`
//     computer-use     → adapter id `hermes.adapter.computer-use.v1`
//
//   The wire-level server names accept aliases for resilience to MCP
//   registry churn:
//     "playwright"         | "playwright-mcp"
//     "chrome-devtools"    | "chrome-devtools-mcp"      | "chromedevtools"
//     "computer-use"       | "computer-use-mcp"         | "computeruse"
//
// Responses (always JSON, always `{ ok, ...}` envelope):
//   200 + { ok:true, data: orange.report.v1 }
//   400 invalid_request_error          — bad body / bad path / unknown tool
//   401 boundary_violation             — wrong auth shape (handled upstream)
//   403 lease_refused                  — policy/lease cover failure
//   404 router_unknown_route           — path doesn't match grammar
//   405 method_not_allowed             — non-POST
//   409 hermes_refused                 — adapter or Hermes gate refusal
//   502 hermes_upstream_error          — Hermes returned non-JSON / bad schema
//   503 hermes_unreachable             — Hermes daemon down (honest gap)
//   504 hermes_timeout                 — Hermes did not respond in time
//
// Boundary update:
//   These dynamic paths must be allowed via the matcher exported by
//   ./hermes-mcp-boundary.mjs (`isHermesMcpPath`, `isHermesMcpRouteAllowed`).
//   Until the main boundary wires those in, requests to /v1/hermes/mcp/*
//   are dead-on-arrival from the frontier (by design — Mom's Law).
//
// Honest gaps:
//   - This file does not start the Hermes daemon or the MCP servers. It
//     proxies through the router; if either is down, the appropriate
//     `503` / `409 mcp_default_failed` is surfaced.
//   - The "policy layer" referenced in the wave brief lives in
//     08-HERMES/policy/mcp-tool-policy.mjs and is consumed here for the
//     pre-flight classify call. The router also does its own deterministic
//     lease-cover check. Both run; defense in depth.
//   - Node 20+. ESM. No npm deps. Uses global fetch via the router.

import { URL } from "node:url";

import {
  routeMcpCall,
  parseMcpPath,
  lookupRoute,
  McpRouterError,
  ROUTER_META,
} from "../../../08-HERMES/mcp-router.mjs";

import {
  classifyToolCall,
} from "../../../08-HERMES/policy/mcp-tool-policy.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERMES_MCP_PATH_PREFIX = "/v1/hermes/mcp";

/**
 * Wire-level server alias → canonical server id used by mcp-router.mjs.
 * The router internally uses the "...-mcp" suffix; the wire-level shape
 * is the bare name (which is what the frontier model names in tool-use
 * turns and what the MCP registry / docs use).
 */
const SERVER_ALIASES = Object.freeze({
  "playwright": "playwright-mcp",
  "playwright-mcp": "playwright-mcp",
  "chrome-devtools": "chrome-devtools-mcp",
  "chrome-devtools-mcp": "chrome-devtools-mcp",
  "chromedevtools": "chrome-devtools-mcp",
  "computer-use": "computer-use-mcp",
  "computer-use-mcp": "computer-use-mcp",
  "computeruse": "computer-use-mcp",
});

/** The set of wire-level server tokens this gateway exposes. */
export const HERMES_MCP_EXPOSED_SERVERS = Object.freeze(
  Object.keys(SERVER_ALIASES),
);

/** Tool-name policy classifier "server" tokens — used to enrich error bodies. */
const POLICY_SERVER_FOR_ROUTER = Object.freeze({
  "playwright-mcp": "playwright",
  "chrome-devtools-mcp": "chrome-devtools",
  "computer-use-mcp": "computer-use",
});

const MAX_BODY_BYTES = 512 * 1024; // 512 KiB — args may carry small base64
const RISK_LADDER = Object.freeze(["read_only", "low", "medium", "high", "destructive", "production"]);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorResponse(res, message, status, code, extra = {}) {
  jsonResponse(
    res,
    {
      ok: false,
      error: {
        message,
        type: code,
        code,
        http_status: status,
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

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

/**
 * Parse `/v1/hermes/mcp/{server}/{tool}` into `{ wireServer, routerServer,
 * tool }`. Returns null if the path does not match.
 *
 * The router itself accepts a slightly looser grammar (parseMcpPath in
 * mcp-router.mjs); the gateway tightens it to require the leading `/v1/`
 * and to resolve the server alias here so a single error shape covers
 * "unknown server" at this layer.
 *
 * @param {string} pathname
 * @returns {{ wireServer: string, routerServer: string, tool: string } | null}
 */
export function parseHermesMcpPath(pathname) {
  if (typeof pathname !== "string" || !pathname) return null;
  const m = pathname.match(/^\/v1\/hermes\/mcp\/([^/]+)\/([^/?#]+)\/?$/);
  if (!m) return null;
  const wireServer = decodeURIComponent(m[1]).toLowerCase();
  const tool = decodeURIComponent(m[2]);
  if (!wireServer || !tool) return null;
  const routerServer = SERVER_ALIASES[wireServer];
  if (!routerServer) return null;
  return { wireServer, routerServer, tool };
}

/**
 * Predicate for the gateway boundary: does this path match the Hermes MCP
 * shape AND name a server we expose? Cheap, allocation-free regex match.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isHermesMcpPath(pathname) {
  return parseHermesMcpPath(pathname) !== null;
}

// ---------------------------------------------------------------------------
// Validation (gateway side, shallow)
// ---------------------------------------------------------------------------

function validateBody(body) {
  const errors = [];
  if (body.args !== undefined && (body.args === null || typeof body.args !== "object" || Array.isArray(body.args))) {
    errors.push("field 'args' must be a plain object when present");
  }
  if (!body.lease || typeof body.lease !== "object" || Array.isArray(body.lease)) {
    errors.push("field 'lease' is required and must be a plain object");
  } else {
    const l = body.lease;
    if (typeof l.id !== "string" || l.id.length === 0) {
      errors.push("field 'lease.id' is required and must be a non-empty string");
    }
    if (!Array.isArray(l.allowed)) {
      errors.push("field 'lease.allowed' must be an array");
    }
    if (typeof l.riskLevel !== "string" || l.riskLevel.length === 0) {
      errors.push("field 'lease.riskLevel' is required and must be a non-empty string");
    }
    if (l.forbidden !== undefined && !Array.isArray(l.forbidden)) {
      errors.push("field 'lease.forbidden', when present, must be an array");
    }
    if (l.expires_at !== undefined && (typeof l.expires_at !== "number" || !Number.isFinite(l.expires_at))) {
      errors.push("field 'lease.expires_at', when present, must be a finite number (epoch ms)");
    }
  }
  if (body.actor !== undefined && typeof body.actor !== "string") {
    errors.push("field 'actor' must be a string when present");
  }
  if (body.targetProject !== undefined && typeof body.targetProject !== "string") {
    errors.push("field 'targetProject' must be a string when present");
  }
  if (body.operatorApproved !== undefined && typeof body.operatorApproved !== "boolean") {
    errors.push("field 'operatorApproved' must be a boolean when present");
  }
  return errors;
}

function riskCovers(actual, required) {
  const a = RISK_LADDER.indexOf(actual);
  const r = RISK_LADDER.indexOf(required);
  return a >= 0 && r >= 0 && a >= r;
}

// ---------------------------------------------------------------------------
// Status-code mapping
// ---------------------------------------------------------------------------

/**
 * Map an McpRouterError or router-bubbled adapter error to an HTTP status.
 *
 * The router's own helper is internal; we restate the policy here so the
 * gateway has a single point of truth for what each code surfaces as. Any
 * code we don't recognize is funnelled to 409 (refused, but not 5xx — the
 * call is shaped right; some downstream contract said no).
 */
function statusForError(err) {
  if (err && typeof err.status === "number" && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  switch (err && err.code) {
    case "router_arg_invalid":
    case "router_unknown_server":
    case "router_unknown_tool":
    case "router_body_unparseable":
      return 400;
    case "router_unknown_route":
      return 404;
    case "router_lease_missing":
    case "router_lease_malformed":
    case "router_lease_expired":
    case "router_lease_risk_unknown":
    case "router_lease_risk_insufficient":
    case "router_lease_verb_not_allowed":
    case "router_lease_verb_forbidden":
    case "router_lease_wide_forbidden":
      return 403;
    case "hermes_timeout":
      return 504;
    case "hermes_unreachable":
    case "hermes_transport_failed":
    case "fetch_unavailable":
      return 503;
    case "report_schema_mismatch":
    case "router_report_schema_mismatch":
    case "router_report_not_ok":
    case "hermes_bad_response":
      return 502;
    default:
      return 409;
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handle a single POST /v1/hermes/mcp/{server}/{tool} request. Pure-ish:
 * does not write to `res` — returns a {status, body} pair so callers and
 * tests can render it however they want.
 *
 * @param {object} input
 * @param {string} input.pathname
 * @param {object} input.body
 * @param {object} [input.opts]   passes through to routeMcpCall (baseUrl,
 *                                fetchFn, timeoutMs — used by tests)
 * @returns {Promise<{ status:number, body:object }>}
 */
export async function handleHermesMcp({ pathname, body, opts = {} } = {}) {
  // 1. Parse path.
  const parsed = parseHermesMcpPath(pathname);
  if (!parsed) {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          message: "path must be /v1/hermes/mcp/{server}/{tool} with a known server",
          type: "router_unknown_route",
          code: "router_unknown_route",
          http_status: 404,
          detail: {
            exposed_servers: HERMES_MCP_EXPOSED_SERVERS,
          },
        },
      },
    };
  }

  // 2. Validate body shape.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: "invalid_request_error",
          http_status: 400,
        },
      },
    };
  }
  const verrs = validateBody(body);
  if (verrs.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: "request body validation failed",
          type: "invalid_request_error",
          code: "invalid_request_error",
          http_status: 400,
          detail: { errors: verrs },
        },
      },
    };
  }

  // 3. Pre-flight policy classification. Surfaces "this call would need an
  //    interactive approval" / "this call's risk level is destructive" before
  //    we even open the router's per-verb table.
  //
  //    The classifier server names use the bare form ("chrome-devtools");
  //    the router uses the "-mcp" suffixed form. We classify against the
  //    bare form so the policy verdict matches what the operator-facing
  //    docs print.
  const policyServer = POLICY_SERVER_FOR_ROUTER[parsed.routerServer] || parsed.wireServer;
  const policyVerdict = classifyToolCall(`mcp__${policyServer}__${parsed.tool}`);

  // If the policy classifier doesn't know this tool AT ALL (fail-closed
  // default), refuse here. The router would also refuse on lookupRoute,
  // but the policy verdict carries the more actionable "fail-closed:
  // unknown ..." reason and we want that in the body.
  if (policyVerdict.match === "default") {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          message: `tool not in policy registry: ${policyServer}/${parsed.tool}`,
          type: "router_unknown_tool",
          code: "router_unknown_tool",
          http_status: 400,
          detail: {
            server: policyServer,
            tool: parsed.tool,
            policy: policyVerdict,
          },
        },
      },
    };
  }

  // 4. Quick router-side route existence check before lease assertion. Lets
  //    us split "tool unknown" (400) from "lease doesn't cover" (403) cleanly.
  let route;
  try {
    route = lookupRoute(parsed.routerServer, parsed.tool);
  } catch (err) {
    if (err instanceof McpRouterError) {
      return {
        status: statusForError(err),
        body: {
          ok: false,
          error: {
            message: err.message,
            type: err.code,
            code: err.code,
            http_status: statusForError(err),
            detail: {
              server: parsed.wireServer,
              tool: parsed.tool,
              policy: policyVerdict,
            },
          },
        },
      };
    }
    throw err;
  }

  const requiredRisk = route.risk_level || policyVerdict.risk_level;
  if (requiredRisk && !riskCovers(body.lease?.riskLevel, requiredRisk)) {
    return {
      status: 403,
      body: {
        ok: false,
        error: {
          message: `tool "${parsed.routerServer}/${parsed.tool}" requires riskLevel ≥ ${requiredRisk}, lease has ${body.lease?.riskLevel}`,
          type: "router_lease_risk_insufficient",
          code: "router_lease_risk_insufficient",
          http_status: 403,
          detail: {
            server: parsed.wireServer,
            tool: parsed.tool,
            verb: route.verb,
            risk_level: requiredRisk,
            requiredRisk,
            leaseRisk: body.lease?.riskLevel,
            policy: policyVerdict,
          },
        },
      },
    };
  }

  if (
    policyVerdict.requires_approval === true &&
    body.operatorApproved !== true &&
    Array.isArray(body.lease?.allowed) &&
    body.lease.allowed.includes(route.verb)
  ) {
    return {
      status: 403,
      body: {
        ok: false,
        error: {
          message: `tool "${parsed.routerServer}/${parsed.tool}" requires operator approval`,
          type: "operator_approval_required",
          code: "operator_approval_required",
          http_status: 403,
          detail: {
            server: parsed.wireServer,
            tool: parsed.tool,
            verb: route.verb,
            risk_level: route.risk_level,
            policy: policyVerdict,
          },
        },
      },
    };
  }

  // 5. Dispatch through the router. The router runs its own deterministic
  //    lease-cover policy check and then calls the adapter's submitToHermes.
  try {
    const report = await routeMcpCall({
      server: parsed.routerServer,
      tool: parsed.tool,
      args: body.args || {},
      lease: body.lease,
      actor: body.actor,
      targetProject: body.targetProject,
      operatorApproved: body.operatorApproved === true,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      fetchFn: opts.fetchFn,
    });

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          ...report,
          server: parsed.wireServer,
          tool: parsed.tool,
          verb: route.verb,
          risk_level: route.risk_level,
          policy: policyVerdict,
        },
      },
    };
  } catch (err) {
    const status = statusForError(err);
    return {
      status,
      body: {
        ok: false,
        error: {
          message: err && err.message ? err.message : "hermes mcp dispatch failed",
          type: (err && err.code) || "router_unknown_error",
          code: (err && err.code) || "router_unknown_error",
          http_status: status,
          detail: {
            server: parsed.wireServer,
            tool: parsed.tool,
            verb: route.verb,
            risk_level: route.risk_level,
            requiredRisk: err && err.requiredRisk,
            leaseRisk: err && err.leaseRisk,
            gates: err && err.gates,
            policy: policyVerdict,
          },
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Public: registerHermesMcpRoutes(server, opts)
// ---------------------------------------------------------------------------

/**
 * Attach the Hermes MCP gateway routes to a node:http Server. Follows the
 * same `prependListener("request", ...)` pattern as hermes.mjs / memory.mjs
 * so each surface stays self-contained.
 *
 * @param {import("node:http").Server} server
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   override Hermes daemon base URL (tests)
 * @param {number} [opts.timeoutMs] override per-call timeout (tests)
 * @param {Function}[opts.fetchFn]  inject fetch (tests)
 * @param {(line:string)=>void} [opts.log]
 * @returns {{ cfg:object, path_prefix:string, exposed_servers:string[] }}
 */
export function registerHermesMcpRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerHermesMcpRoutes: server must be a node:http Server");
  }

  const cfg = {
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    fetchFn: opts.fetchFn,
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

    // Only handle /v1/hermes/mcp/* paths; let the rest of the gateway
    // router (and the main boundary) deal with everything else.
    if (!pathName.startsWith(`${HERMES_MCP_PATH_PREFIX}/`)) {
      return;
    }

    // Method enforcement.
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: ["POST"] },
      );
    }

    try {
      let raw;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        return errorResponse(
          res,
          err && err.message ? err.message : "bad request body",
          400,
          "invalid_request_body",
        );
      }

      const { status, body } = await handleHermesMcp({
        pathname: pathName,
        body: raw,
        opts: cfg,
      });
      return jsonResponse(res, body, status);
    } catch (err) {
      cfg.log(`[hermes-mcp-gateway] handler error: ${err && err.message ? err.message : err}`);
      return errorResponse(
        res,
        err && err.message ? err.message : "hermes mcp internal error",
        500,
        "hermes_mcp_internal_error",
      );
    }
  });

  return {
    cfg,
    path_prefix: HERMES_MCP_PATH_PREFIX,
    exposed_servers: HERMES_MCP_EXPOSED_SERVERS,
    router_meta: ROUTER_META,
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __hermesMcpInternals = Object.freeze({
  parseHermesMcpPath,
  validateBody,
  statusForError,
  SERVER_ALIASES,
  POLICY_SERVER_FOR_ROUTER,
  MAX_BODY_BYTES,
});
