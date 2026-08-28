// AE OrangeLLM — Æ Cobra gateway boundary allow-list
// Path: 06-ORANGELLM/server/routes/cobra-boundary.mjs
//
// Doctrine reminder:
//   - The Æ Cobra memory daemon (Mamba 2.8B Q5_K_M, GBNF-locked AgentTurn
//     JSON output) runs on Codexa inside WSL2. It is NOT reachable from
//     N150 directly. The ONLY legal door is this gateway at 127.0.0.1:1337
//     via the routes declared below, which proxy to the daemon over the
//     Codexa-side WSL2 port-forward.
//   - Every endpoint must be on a strict allow-list. Nothing reachable by
//     accident, nothing reachable by header (Boundary law: forbidden
//     prefixes x-mirage-, x-orangebox-, x-codexa-, x-internal- are denied
//     before the route resolver ever sees them).
//   - Rail-token authentication is enforced inside the route handlers
//     (cobra.mjs) against the in-memory token from
//     server/middleware/rail-token-watcher.mjs. The token header name is
//     intentionally NOT one of the forbidden families so it survives the
//     main boundary check.
//   - Mom's Law: receipts only, no theater. Auth failure is a one-line
//     error with the rail-token fingerprint that was presented (sha256
//     prefix only — never the raw token). No silent fall-back to anonymous.
//
// Routes exposed:
//   POST /v1/cobra/turn        — proxy to daemon /completion with GBNF;
//                                returns the validated AgentTurn JSON the
//                                daemon emitted (no streaming on Night-1).
//   GET  /v1/cobra/healthz     — gateway-side liveness probe of the daemon
//                                (model loaded, ctx-size, mlock status,
//                                Flux lanes reachable).
//   GET  /v1/cobra/flux/tail   — read-only tail of the Flux JSONL lanes
//                                (reality + thought). Bounded by ?n=...
//                                and ?lane=reality|thought (default both,
//                                merged in time order).

export const COBRA_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/cobra/turn" },
  { method: "GET",  path: "/v1/cobra/healthz" },
  { method: "GET",  path: "/v1/cobra/flux/tail" },
]);

export function isCobraRouteAllowed(method, pathname) {
  const m = (method || "").toUpperCase();
  return COBRA_ALLOWED.some(r => r.method === m && r.path === pathname);
}

export function isCobraPath(pathname) {
  return (
    pathname === "/v1/cobra/turn" ||
    pathname === "/v1/cobra/healthz" ||
    pathname === "/v1/cobra/flux/tail"
  );
}

// Header name carrying the Codexa rail token. Intentionally NOT prefixed
// with any of the forbidden families (x-mirage-, x-orangebox-, x-codexa-,
// x-internal-) so the main boundary lets it through to the handler. The
// value is compared (constant-time) against the in-memory token surfaced
// by server/middleware/rail-token-watcher.mjs::getToken().
//
// Rotation: when the rail-token file on disk changes, the watcher swaps
// the in-memory reference WITHOUT restarting the gateway, so callers see
// the new accepted value on their next request. There is no grace window
// — old tokens become invalid the moment the new one is loaded.
export const RAIL_TOKEN_HEADER = "x-ae-rail-token";
