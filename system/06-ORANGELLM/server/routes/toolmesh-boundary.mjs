// AE OrangeLLM — ToolMesh boundary allow-list
// Path: 06-ORANGELLM/server/routes/toolmesh-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. ToolMesh discovery routes live
//   under /v1/toolmesh/* and must be added to that allow-list before they
//   are reachable from anywhere outside the loopback.
//
// Doctrine reminder (operator, Atom McCree):
//   - ToolMesh is the capability-discovery surface. It exposes what the
//     mesh CAN do (cards, cost/latency/risk classes) so OrangeLLM can plan
//     before asking the operator for approval. It does NOT execute; that
//     is Hermes' job and only Hermes' job.
//   - All three routes are GET. There is no write surface here — adding
//     cards is a disk operation on 13-TOOLMESH/labs/ that the registry
//     picks up via fs.watch. The boundary does not expose card mutation.
//   - The middle route GET /v1/toolmesh/labs/:lab/cards is parametric.
//     The `:lab` segment is constrained to the closed LAB_IDS enum
//     (image, video, audio, design, coding, automation, analytics,
//     public-agent, observability, security, releaseops). The predicate
//     isToolmeshRouteAllowed enforces that closed enum, so the main
//     boundary can express ToolMesh in two pieces:
//       1) flat literal pairs in TOOLMESH_ALLOWED (labs root, search)
//       2) the predicate for the parametric labs/:lab/cards route
//     The receipts surface already uses this two-piece pattern; we mirror
//     it here so future maintainers see consistent shapes.
//   - Mom's Law applies: no dynamic allow-list expansion at runtime. If a
//     new lab id appears in the schema, it must show up in LAB_IDS in
//     13-TOOLMESH/registry.mjs first, which means a code review touched
//     the enum on purpose.
//
// Usage (in boundary.mjs):
//
//     import {
//       TOOLMESH_ALLOWED,
//       isToolmeshPath,
//       isToolmeshRouteAllowed,
//     } from "./routes/toolmesh-boundary.mjs";
//
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...RECEIPTS_ALLOWED,
//       ...MISFIT_ALLOWED,
//       ...GUARDRAILS_ALLOWED,
//       ...TOOLMESH_ALLOWED,
//     ];
//
//     const allowed =
//       ALLOWED.some(a => a.method === method && a.path === path) ||
//       (isReceiptsPath(path) && isReceiptsRouteAllowed(method, path)) ||
//       (isToolmeshPath(path) && isToolmeshRouteAllowed(method, path));
//
//   The FORBIDDEN_PATH_PATTERNS regex in boundary.mjs is
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i`. ToolMesh paths begin
//   with `/v1/`, so they are not caught by that pattern — no carve-out is
//   needed.

import { LAB_IDS } from "../../../13-TOOLMESH/registry.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOOLMESH_PATH_PREFIX = "/v1/toolmesh";
export const TOOLMESH_LABS_PATH = `${TOOLMESH_PATH_PREFIX}/labs`;
export const TOOLMESH_SEARCH_PATH = `${TOOLMESH_PATH_PREFIX}/search`;

const LAB_CARDS_RX = /^\/v1\/toolmesh\/labs\/([a-z][a-z0-9-]{0,30})\/cards$/;

/**
 * Literal {method,path} pairs for the two non-parametric ToolMesh routes.
 * The parametric labs/:lab/cards route is matched by predicate.
 *
 * Surface:
 *   GET /v1/toolmesh/labs              — list 11 labs + counts
 *   GET /v1/toolmesh/labs/:lab/cards   — per-lab cards (predicate-matched)
 *   GET /v1/toolmesh/search?q=...      — cross-lab search
 */
export const TOOLMESH_ALLOWED = Object.freeze([
  { method: "GET", path: TOOLMESH_LABS_PATH },
  { method: "GET", path: TOOLMESH_SEARCH_PATH },
]);

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Return true iff pathName begins the ToolMesh namespace. Used by the main
 * boundary to short-circuit allow-list matching for the parametric route.
 *
 * @param {string} pathName  URL pathname, no query string
 * @returns {boolean}
 */
export function isToolmeshPath(pathName) {
  if (typeof pathName !== "string") return false;
  return pathName.startsWith(`${TOOLMESH_PATH_PREFIX}/`) || pathName === TOOLMESH_PATH_PREFIX;
}

/**
 * Return true iff (method, pathName) names a ToolMesh route — including the
 * parametric labs/:lab/cards endpoint whose lab segment is constrained to
 * the closed LAB_IDS enum.
 *
 * @param {string} method   HTTP method (case-insensitive)
 * @param {string} pathName URL pathname
 * @returns {boolean}
 */
export function isToolmeshRouteAllowed(method, pathName) {
  if (typeof method !== "string" || typeof pathName !== "string") return false;
  const m = method.toUpperCase();
  if (m !== "GET") return false;

  for (const r of TOOLMESH_ALLOWED) {
    if (r.path === pathName) return true;
  }
  const labMatch = LAB_CARDS_RX.exec(pathName);
  if (labMatch && LAB_IDS.includes(labMatch[1])) return true;

  return false;
}
