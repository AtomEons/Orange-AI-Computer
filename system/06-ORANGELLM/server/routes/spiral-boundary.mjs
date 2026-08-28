// AE OrangeLLM — Spiral Reasoning boundary allow-list
// Path: 06-ORANGELLM/server/routes/spiral-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. Spiral Reasoning gateway routes
//   live under /v1/spiral/* and must be added to that allow-list before
//   they are reachable from anywhere outside the loopback.
//
// Doctrine reminder (Atom McCree, ATOM-SPIRAL-INTEGRATION-v1-2026-0618):
//   - Spiral Reasoning is the canonical reasoning primitive for any
//     iterative multi-step thinking the substrate does. The SoT update
//     rule is: z_{k+1} = z_0 + r_k * exp(β·Δθ_k) * (cos(Δθ_k)·u_k +
//     sin(Δθ_k)·v_k) with α-bounded Δθ.
//   - z_0 (the anchor) is the Soul Genome — the substrate's identity at
//     first ignition. The /anchor endpoint pulls a deterministic vector
//     derived from canonical Soul Genome identity fields.
//   - Belief Discipline = bounded α (no lurching beyond what the substrate
//     can stay coherent through). LEARN imperative = radial accounting
//     r_k · exp(β·Δθ_k) — the substrate grows only in measured proportion
//     to how much it just turned. Graceful degeneration: no curvature
//     without signal — fall back to linear when ||g^⊥|| is below epsilon.
//   - Mom's Law applies: real math, real receipts, no theater. Every
//     trajectory step writes a structured audit row.
//
// Surface (read + compute; no Soul Genome mutation):
//   POST /v1/spiral/anchor      — derive z_0 from Soul Genome
//   POST /v1/spiral/step        — compute next z_{k+1} from a single signal
//   POST /v1/spiral/trajectory  — compute full trajectory from signal array
//   GET  /v1/spiral/audit       — read append-only audit log (since= filter)
//
// Usage (in boundary.mjs):
//
//     import { SPIRAL_ALLOWED } from "./routes/spiral-boundary.mjs";
//     const ALLOWED = [
//       ...,
//       ...SPIRAL_ALLOWED,
//     ];
//
//   All four Spiral gateway routes are literal {method, path} pairs.
//   No dynamic-id slot is exposed; the audit filter is a query-string
//   parameter, which the boundary does not need to enumerate.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPIRAL_PATH_PREFIX = "/v1/spiral";

export const SPIRAL_ANCHOR_PATH = `${SPIRAL_PATH_PREFIX}/anchor`;
export const SPIRAL_STEP_PATH = `${SPIRAL_PATH_PREFIX}/step`;
export const SPIRAL_TRAJECTORY_PATH = `${SPIRAL_PATH_PREFIX}/trajectory`;
export const SPIRAL_AUDIT_PATH = `${SPIRAL_PATH_PREFIX}/audit`;

/**
 * Literal {method,path} pairs for the Spiral gateway routes. These can sit
 * verbatim in the main boundary's flat ALLOWED list.
 *
 * Surface:
 *   POST /v1/spiral/anchor      — pull z_0 from Soul Genome
 *   POST /v1/spiral/step        — compute single SoT update
 *   POST /v1/spiral/trajectory  — compute full SoT path from signal array
 *   GET  /v1/spiral/audit       — read append-only audit log
 */
export const SPIRAL_ALLOWED = Object.freeze([
  { method: "POST", path: SPIRAL_ANCHOR_PATH },
  { method: "POST", path: SPIRAL_STEP_PATH },
  { method: "POST", path: SPIRAL_TRAJECTORY_PATH },
  { method: "GET", path: SPIRAL_AUDIT_PATH },
]);

// ---------------------------------------------------------------------------
// Predicates (for symmetry with other boundary modules)
// ---------------------------------------------------------------------------

/**
 * Returns true iff pathname is within the Spiral namespace. Useful for
 * the main boundary's path-prefix early-out before deeper matching.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isSpiralPath(pathname) {
  return (
    typeof pathname === "string" &&
    (pathname === SPIRAL_PATH_PREFIX || pathname.startsWith(`${SPIRAL_PATH_PREFIX}/`))
  );
}

/**
 * Returns true iff (method, pathName) names one of the Spiral gateway
 * routes. All routes are literal — no parameter slots — so this is a
 * flat match.
 *
 * @param {string} method   - HTTP method (case-insensitive)
 * @param {string} pathName - URL pathname, no query string
 * @returns {boolean}
 */
export function isSpiralRouteAllowed(method, pathName) {
  if (typeof method !== "string" || typeof pathName !== "string") return false;
  const m = method.toUpperCase();
  for (const r of SPIRAL_ALLOWED) {
    if (r.method === m && r.path === pathName) return true;
  }
  return false;
}
