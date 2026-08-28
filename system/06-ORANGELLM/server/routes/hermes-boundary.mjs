// AE OrangeLLM — Hermes boundary allow-list
// Path: 06-ORANGELLM/server/routes/hermes-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. Hermes gateway routes live under
//   /v1/hermes/* and must be added to that allow-list before they are
//   reachable from anywhere outside the loopback.
//
// Doctrine reminder (operator, Atom McCree):
//   - Hermes is the bounded execution layer. It replaces "OpenClaw". Every
//     action by every LLM in the superstack — frontier, OrangeLLM-fatty,
//     AE Misfit, Codexa worker, MCP tool adapter — flows through a Hermes
//     lease and the 8-gate LOOM chain.
//   - The Hermes daemon listens on 127.0.0.1:7430 (loopback only). It is
//     NEVER exposed to the public surface. The frontier model never opens a
//     socket there directly. The /v1/hermes/* routes registered by
//     server/routes/hermes.mjs are gateway-mediated proxies: the gateway
//     receives a Hermes-shaped request, applies the same Frontier-Isolation
//     contract every other gateway route applies, then proxies to
//     127.0.0.1:7430.
//   - The default forbidden verbs (destructive_write, production_deploy,
//     scope_expansion, egress_unbounded) are auto-merged inside the Hermes
//     daemon — see 08-HERMES/src/lease-engine.mjs `DEFAULT_FORBIDDEN`. The
//     client cannot opt out. The boundary here only governs reachability of
//     the gateway routes themselves; per-action enforcement is the daemon's
//     job.
//   - Mom's Law applies: the boundary is the last calm thing between the
//     frontier and the bounded-execution layer. No silent allow. No
//     dynamic route opening. If a verb is not on this list, it does not
//     exist from the frontier's perspective.
//
// Usage (in boundary.mjs):
//
//     import { HERMES_ALLOWED } from "./routes/hermes-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...RECEIPTS_ALLOWED,
//       ...MISFIT_ALLOWED,
//       ...HERMES_ALLOWED,
//     ];
//
//   All three Hermes gateway routes are literal {method,path} pairs — no
//   parameter slots are exposed at the gateway. (The daemon's
//   POST /approvals/:id route is NOT proxied; the Sovereign signs approvals
//   through a separate trusted channel, not through the frontier-reachable
//   gateway. Surfacing :id here would expand the attack surface for no
//   gain.)
//
//   The FORBIDDEN_PATH_PATTERNS regex
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` matches paths that
//   START with `/hermes/`. The Hermes gateway routes live under `/v1/hermes/`,
//   which does NOT match that regex (it starts with `/v1/`). So no
//   carve-out is needed. The naming is deliberate: keeping the Hermes
//   gateway routes under `/v1/` keeps them OpenAI-shape-adjacent and out
//   of the forbidden-prefix family that fences off internal-only rails.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERMES_PATH_PREFIX = "/v1/hermes";

export const HERMES_LEASE_PATH = `${HERMES_PATH_PREFIX}/lease`;
export const HERMES_ACTION_PATH = `${HERMES_PATH_PREFIX}/action`;
export const HERMES_APPROVALS_PATH = `${HERMES_PATH_PREFIX}/approvals`;
export const HERMES_LEASE_REVOKE_RX = /^\/v1\/hermes\/lease\/[^/]+\/revoke$/;

/**
 * Literal {method,path} pairs for the Hermes gateway routes. These can sit
 * verbatim in the main boundary's flat ALLOWED list.
 *
 * Surface:
 *   POST /v1/hermes/lease      — mint a Hermes lease
 *   POST /v1/hermes/action     — propose an action through all 8 LOOM gates
 *   GET  /v1/hermes/approvals  — list pending approvals (read-only)
 *
 * NOT exposed at the gateway:
 *   POST /approvals/:id        — the Sovereign signs through a trusted
 *                                local channel, not the frontier surface.
 *   GET  /healthz              — Hermes has its own healthz; the gateway
 *                                healthz already covers liveness.
 *   POST /lease (root)         — the daemon root is loopback-only by design.
 */
export const HERMES_ALLOWED = Object.freeze([
  { method: "POST", path: HERMES_LEASE_PATH },
  { method: "POST", path: HERMES_ACTION_PATH },
  { method: "GET", path: HERMES_APPROVALS_PATH },
]);

/**
 * Headers that Hermes consumes internally — must not be forwarded from the
 * frontier. The main boundary already blocks `x-hermes-` via the shared
 * FORBIDDEN_HEADER_PREFIXES list (`x-internal-` and similar). These are
 * restated here so future maintainers see the dependency in the same folder
 * and so a boundary refactor that loosens the global list does not silently
 * loosen Hermes' surface.
 */
export const HERMES_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-hermes-",
  "x-codexa-",
  "x-orangebox-",
  "x-mirage-",
  "x-loom-",
  "x-internal-",
]);

// ---------------------------------------------------------------------------
// Predicate (for symmetry with other boundary modules)
// ---------------------------------------------------------------------------

/**
 * Returns true iff (method, pathName) names one of the Hermes gateway
 * routes exported by registerHermesRoutes. All routes are literal — no
 * parameter slots — so this is a flat match.
 *
 * @param {string} method   - HTTP method (case-insensitive)
 * @param {string} pathName - URL pathname, no query string
 * @returns {boolean}
 */
export function isHermesRouteAllowed(method, pathName) {
  if (typeof method !== "string" || typeof pathName !== "string") return false;
  const m = method.toUpperCase();
  if (m === "POST" && HERMES_LEASE_REVOKE_RX.test(pathName)) return true;
  for (const r of HERMES_ALLOWED) {
    if (r.method === m && r.path === pathName) return true;
  }
  return false;
}
