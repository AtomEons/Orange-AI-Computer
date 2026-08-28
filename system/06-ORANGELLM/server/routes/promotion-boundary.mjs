// AE OrangeLLM — Promotion / Bakeoff / CLR boundary allow-list
// Path: 06-ORANGELLM/server/routes/promotion-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. The Promotion Gate plus its
//   neighbours (Bakeoff harness, CLR-K5 verifier) expose a small REST
//   surface that must be added to that allow-list before it is reachable
//   from anywhere outside the loopback.
//
// Doctrine reminder (operator, 2026-06-24):
//   - Promotion Gate decides promote / hold / reject for any candidate
//     change. Backed by 04-CONTROL-PLANE/promotion-gate/engine.mjs. The
//     gateway is the only public surface; it does not relax doctrine,
//     only marshals it as HTTP.
//   - Bakeoff harness is the 5-dimension head-to-head eval at
//     04-CONTROL-PLANE/bakeoff/harness.mjs. The gateway runs canned
//     bakeoffs against named adapters and stores receipts; raw model
//     fns never cross the wire.
//   - CLR-K5 (Claim-Level Reliability Phase-5) is the K=5 reliability
//     contract: clr.k === 5 AND clr.score >= 0.50. Replaces Æ Cobra
//     Night-1 K=1 sampling.
//
// Usage (in boundary.mjs):
//
//     import { PROMOTION_ALLOWED, isPromotionRouteAllowed } from
//       "./routes/promotion-boundary.mjs";
//     const ALLOWED = [
//       ...,
//       ...PROMOTION_ALLOWED,
//     ];
//     // For the parameterized GET /v1/bakeoff/:id path, the main
//     // boundary should call isPromotionRouteAllowed(method, path) for
//     // any path matching PROMOTION_PATH_PREFIXES before doing the
//     // literal-pair check.
//
// The FORBIDDEN_PATH_PATTERNS regex
// `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` does not match /v1/,
// so no carve-out is needed even though promotion records its receipts
// downstream of Hermes.

// ---------------------------------------------------------------------------
// Path prefixes / templates
// ---------------------------------------------------------------------------

export const PROMOTION_DECIDE_PATH = "/v1/promotion/decide";
export const BAKEOFF_RUN_PATH = "/v1/bakeoff/run";
export const BAKEOFF_GET_PREFIX = "/v1/bakeoff/"; // followed by :id
export const CLR_VERIFY_PATH = "/v1/clr/verify";

// Literal {method,path} pairs for the unparameterized endpoints. These
// can sit verbatim in the main boundary's flat ALLOWED list.
export const PROMOTION_ALLOWED = Object.freeze([
  { method: "POST", path: PROMOTION_DECIDE_PATH },
  { method: "POST", path: BAKEOFF_RUN_PATH },
  { method: "POST", path: CLR_VERIFY_PATH },
]);

// Parameterized routes — these need the predicate below because the :id
// slot is dynamic.
export const PROMOTION_PARAMETERIZED = Object.freeze([
  { method: "GET", template: `${BAKEOFF_GET_PREFIX}:id` },
]);

// All prefixes the predicate cares about. The main boundary can use this
// to decide whether to defer to isPromotionRouteAllowed.
export const PROMOTION_PATH_PREFIXES = Object.freeze([
  "/v1/promotion/",
  "/v1/bakeoff/",
  "/v1/clr/",
]);

// Bakeoff id shape: 64-char lowercase hex (sha256 of the run record).
// Reject anything else at the boundary so malformed ids never reach the
// handlers.
const BAKEOFF_ID_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * Returns true iff (method, pathName) names one of the promotion-plane
 * routes exported by registerPromotionRoutes. Handles both literal and
 * parameterized shapes.
 *
 * @param {string} method   - HTTP method (case-insensitive)
 * @param {string} pathName - URL pathname, no query string
 * @returns {boolean}
 */
export function isPromotionRouteAllowed(method, pathName) {
  if (typeof pathName !== "string") return false;
  if (typeof method !== "string") return false;
  const m = method.toUpperCase();

  // Literal pairs.
  for (const r of PROMOTION_ALLOWED) {
    if (r.method === m && r.path === pathName) return true;
  }

  // Parameterized: GET /v1/bakeoff/:id (but NOT /v1/bakeoff/run which is
  // already covered by the literal allow-list above; we still match it
  // here defensively so a hostile caller can't smuggle GET /v1/bakeoff/run).
  if (pathName.startsWith(BAKEOFF_GET_PREFIX)) {
    if (m !== "GET") return false;
    const rest = pathName.slice(BAKEOFF_GET_PREFIX.length);
    if (rest.length === 0) return false;
    // Disallow path traversal in the id slot.
    if (rest.includes("/")) return false;
    return BAKEOFF_ID_RE.test(rest);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Headers that promotion routes consume internally — must not be forwarded
// from the frontier. Restated here so future maintainers see the dependency
// in the same folder.
// ---------------------------------------------------------------------------

export const PROMOTION_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-promotion-",
  "x-bakeoff-",
  "x-clr-",
  "x-hermes-",
  "x-internal-",
]);
