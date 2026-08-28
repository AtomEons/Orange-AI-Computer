// AE OrangeLLM — AtomSmasher boundary allow-list
// Path: 06-ORANGELLM/server/routes/atomsmasher-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs. AtomSmasher routes live under
//   /v1/atomsmasher/atoms/* and must be added to that allow-list before they
//   are reachable from anywhere outside the loopback.
//
// Doctrine reminder:
//   - AtomSmasher Commitment Atoms are the smallest unit of operator-or-system
//     promise. Append-only, hash-chained, content-addressed.
//   - The atom store at 12-ATOMSMASHER/commitment-atoms/store.mjs is the
//     single writer of record; the gateway exposes it as a typed REST surface.
//   - Atoms are NEVER edited. To "change" an atom, mint a new one whose
//     `supersedes` array includes the prior atom_id. The /revoke endpoint
//     simply marks status='superseded'; it does not mutate body or signature.
//   - Mom's Law applies: this is the only public surface, so it carries the
//     burden of truth. Every error is structured. Every receipt (atom_id,
//     hash, flux_record_hash) flows back to the caller so the chain is
//     externally verifiable.
//
// Usage (in boundary.mjs):
//
//     import { ATOMSMASHER_ALLOWED } from "./routes/atomsmasher-boundary.mjs";
//     const ALLOWED = [
//       { method: "GET",  path: "/healthz" },
//       { method: "GET",  path: "/v1/models" },
//       { method: "POST", path: "/v1/chat/completions" },
//       ...MEMORY_ALLOWED,
//       ...ATOMSMASHER_ALLOWED,
//     ];
//
//   The five logical routes include two with parameter segments (:atom_id and
//   :atom_id/{chain,revoke}). Because the main boundary works on literal
//   {method,path} pairs, we ALSO export `isAtomSmasherRouteAllowed(method,
//   pathName)` which knows how to match parameterized routes. Wire the main
//   boundary to call that predicate for any path matching
//   ATOMSMASHER_PATH_PREFIX before doing the literal-pair check.
//
//   And, like memory routes, AtomSmasher deliberately lives under /v1/ to
//   stay OpenAI-shape-adjacent. The FORBIDDEN_PATH_PATTERNS regex
//   `/^\/(mirage|codexa|orangebox|hermes|vault)\//i` does not match /v1/, so
//   no additional carve-out is needed there.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ATOMSMASHER_PATH_PREFIX = "/v1/atomsmasher/atoms";

// Literal {method,path} pairs for the two unparameterized endpoints. These
// can sit verbatim in the main boundary's flat ALLOWED list.
export const ATOMSMASHER_ALLOWED = Object.freeze([
  { method: "POST", path: ATOMSMASHER_PATH_PREFIX },
  { method: "GET", path: ATOMSMASHER_PATH_PREFIX },
]);

// Parameterized route shapes — these need the predicate below because the
// :atom_id slot is dynamic.
export const ATOMSMASHER_PARAMETERIZED = Object.freeze([
  { method: "GET", template: `${ATOMSMASHER_PATH_PREFIX}/:atom_id` },
  { method: "GET", template: `${ATOMSMASHER_PATH_PREFIX}/:atom_id/chain` },
  { method: "POST", template: `${ATOMSMASHER_PATH_PREFIX}/:atom_id/revoke` },
]);

// atom_id is 64-char lowercase hex (sha256). Reject anything else at the
// boundary so malformed ids never reach the handlers.
const ATOM_ID_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * Returns true if (method, pathName) names one of the AtomSmasher routes
 * exported by registerAtomSmasherRoutes. Handles both literal and
 * parameterized shapes.
 *
 * @param {string} method   - HTTP method (case-insensitive)
 * @param {string} pathName - URL pathname, no query string
 * @returns {boolean}
 */
export function isAtomSmasherRouteAllowed(method, pathName) {
  if (typeof pathName !== "string") return false;
  if (typeof method !== "string") return false;
  const m = method.toUpperCase();

  // Literal pairs.
  for (const r of ATOMSMASHER_ALLOWED) {
    if (r.method === m && r.path === pathName) return true;
  }

  // Must live under our prefix.
  if (!pathName.startsWith(ATOMSMASHER_PATH_PREFIX + "/")) return false;
  const rest = pathName.slice(ATOMSMASHER_PATH_PREFIX.length + 1); // strip prefix + "/"
  const segs = rest.split("/").filter(Boolean);

  if (segs.length === 1) {
    // /v1/atomsmasher/atoms/:atom_id (GET)
    if (m !== "GET") return false;
    return ATOM_ID_RE.test(segs[0]);
  }

  if (segs.length === 2) {
    const [atomId, action] = segs;
    if (!ATOM_ID_RE.test(atomId)) return false;
    if (action === "chain") return m === "GET";
    if (action === "revoke") return m === "POST";
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Headers that AtomSmasher consumes internally — must not be forwarded from
// the frontier. Restated here so future maintainers see the dependency in
// the same folder.
// ---------------------------------------------------------------------------

export const ATOMSMASHER_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-atom-",
  "x-atomsmasher-",
  "x-cobra-",
  "x-mirage-",
  "x-codexa-",
  "x-orangebox-",
  "x-internal-",
]);
