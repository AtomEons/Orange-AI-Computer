// AE OrangeLLM — Hermes Misfit decisions read-only boundary allow-list
// Path: 06-ORANGELLM/server/routes/misfit-decisions-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. The read-only Misfit-decisions
//   audit endpoint lives at GET /v1/hermes/misfit-decisions and must be
//   added to that allow-list before it is reachable from anywhere outside
//   the loopback.
//
// Doctrine reminder (operator, Atom McCree, 2026-06-24):
//   - The endpoint is READ-ONLY: GET, no body, no side effects, no override
//     path. Sovereign overrides of Misfit REFUSE verdicts live in
//     08-HERMES/approvals/ as signed approval files — NOT through this
//     gateway surface.
//   - Only GET is allowed. HEAD, POST, PUT, PATCH, DELETE, OPTIONS are all
//     rejected by the route itself, but the boundary intentionally lists
//     only the (GET, path) pair so a future routing change that accidentally
//     wires another verb here is still fenced at the gateway.
//   - The path lives under `/v1/hermes/` to keep it adjacent to the other
//     Hermes-shaped surfaces. The FORBIDDEN_PATH_PATTERNS regex
//     `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` matches paths that
//     START with `/hermes/`. Ours starts with `/v1/`, so no carve-out is
//     needed (same reasoning as hermes-boundary.mjs).
//   - Kill-switch: env HERMES_MISFIT_DISABLED=1 disables Misfit
//     enforcement upstream (the pre-action middleware records a
//     `bypass-kill-switch` audit entry instead). This read endpoint stays
//     reachable either way — operators need MORE visibility, not less, when
//     the kill-switch is engaged.
//
// Usage (in boundary.mjs):
//
//     import { MISFIT_DECISIONS_ALLOWED } from "./routes/misfit-decisions-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...RECEIPTS_ALLOWED,
//       ...MISFIT_ALLOWED,
//       ...HERMES_ALLOWED,
//       ...MISFIT_DECISIONS_ALLOWED,
//     ];
//
//   The single route has no parameter slots — the literal-pair check in
//   the main boundary is enough. The `tail` query parameter is read by
//   the route handler, not by the boundary.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MISFIT_DECISIONS_PATH = "/v1/hermes/misfit-decisions";

export const MISFIT_DECISIONS_ALLOWED = Object.freeze([
  { method: "GET", path: MISFIT_DECISIONS_PATH },
]);

/**
 * Headers that the Misfit audit lane consumes internally — must not be
 * forwarded from the frontier. Restated here so future maintainers see the
 * dependency in the same folder, and so a refactor that loosens the global
 * FORBIDDEN_HEADER_PREFIXES list does not silently loosen this surface.
 */
export const MISFIT_DECISIONS_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-hermes-",
  "x-misfit-",
  "x-ae-misfit-",
  "x-audit-",
  "x-internal-",
]);

// ---------------------------------------------------------------------------
// Predicate (for symmetry with other boundary modules)
// ---------------------------------------------------------------------------

/**
 * Returns true iff (method, pathName) names the read-only Misfit decisions
 * audit route. Single literal pair, so this is a flat match.
 *
 * @param {string} method
 * @param {string} pathName
 * @returns {boolean}
 */
export function isMisfitDecisionsRouteAllowed(method, pathName) {
  if (typeof method !== "string" || typeof pathName !== "string") return false;
  return method.toUpperCase() === "GET" && pathName === MISFIT_DECISIONS_PATH;
}
