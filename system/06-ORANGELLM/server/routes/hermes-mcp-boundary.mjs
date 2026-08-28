// AE OrangeLLM — Hermes MCP boundary allow-list
// Path: 06-ORANGELLM/server/routes/hermes-mcp-boundary.mjs
//
// Purpose:
//   The main gateway boundary (server/boundary.mjs) enforces a strict
//   allow-list of {method, path} pairs PLUS a small set of dynamic-namespace
//   predicates (e.g. receipts). The Hermes MCP gateway routes are dynamic by
//   nature — the path embeds {server} and {tool} — so they cannot be
//   represented as literal {method, path} pairs in the flat ALLOWED list.
//
//   This module exports:
//     - HERMES_MCP_PATH_PREFIX     the namespace string "/v1/hermes/mcp"
//     - HERMES_MCP_EXPOSED_SERVERS the whitelist of wire-level server tokens
//     - isHermesMcpPath(pathname)         — does the path match the grammar?
//     - isHermesMcpRouteAllowed(method, pathname) — is the path + method ok?
//
//   The main boundary should be updated to:
//
//     import {
//       isHermesMcpPath,
//       isHermesMcpRouteAllowed,
//     } from "./routes/hermes-mcp-boundary.mjs";
//
//     // inside boundary({ method, path, headers }):
//     const allowed =
//       ALLOWED.some(a => a.method === method && a.path === path) ||
//       (isReceiptsPath(path) && isReceiptsRouteAllowed(method, path)) ||
//       (isHermesMcpPath(path) && isHermesMcpRouteAllowed(method, path));
//
// Doctrine reminder (operator, Atom McCree):
//   - Hermes is the bounded execution layer. The MCP adapter surface
//     (playwright, chrome-devtools, computer-use) is the most dangerous
//     family of verbs in the superstack — desktop control, arbitrary JS
//     evaluation, arbitrary navigation. None of those verbs ever lands on
//     the host without an active lease and a passing 8-gate LOOM chain.
//   - These boundary predicates only govern REACHABILITY at the gateway.
//     The per-call lease policy, the policy classifier, the router's
//     deterministic checks, and the daemon's gates all still run.
//   - The forbidden-path pattern `/^\/(mirage|codexa|orangebox|hermes|vault)\//i`
//     in the main boundary matches paths that START with `/hermes/`. The
//     Hermes MCP gateway routes live under `/v1/hermes/mcp/`, which does
//     NOT match that regex (it starts with `/v1/`). The naming is
//     deliberate — keep the gateway-mediated MCP routes under `/v1/` so the
//     `/hermes/...` regex still slams the door on raw daemon-style paths.
//   - Mom's Law applies: the boundary is the last calm thing between the
//     frontier and the MCP adapters. No silent allow. No dynamic surface
//     expansion. If a server isn't on HERMES_MCP_EXPOSED_SERVERS, it does
//     not exist from the frontier's perspective.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERMES_MCP_PATH_PREFIX = "/v1/hermes/mcp";

/**
 * Whitelist of wire-level MCP server tokens that the gateway exposes. The
 * gateway resolves each to a canonical "...-mcp" router server id; aliases
 * here let the operator name a server the way the MCP docs / registry name
 * it without forcing a route rename.
 *
 * Keep this list in sync with SERVER_ALIASES in hermes-mcp.mjs. The two
 * cannot trivially share the source because this module must remain
 * importable from the boundary path (which is loaded BEFORE any route
 * module — keeping it dependency-free here keeps the boot order calm).
 */
export const HERMES_MCP_EXPOSED_SERVERS = Object.freeze([
  "playwright",
  "playwright-mcp",
  "chrome-devtools",
  "chrome-devtools-mcp",
  "chromedevtools",
  "computer-use",
  "computer-use-mcp",
  "computeruse",
]);

const EXPOSED_SET = new Set(HERMES_MCP_EXPOSED_SERVERS);

/**
 * Path grammar. Anchored: must start with /v1/hermes/mcp/{server}/{tool}
 * (optional trailing slash), no extra segments. The path must not contain
 * a query string when handed in — boundary callers should pass `url.pathname`.
 */
const PATH_RE = /^\/v1\/hermes\/mcp\/([^/]+)\/([^/?#]+)\/?$/;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Returns true iff `pathname` matches /v1/hermes/mcp/{server}/{tool} AND
 * names an exposed server. Tool name is NOT whitelisted here — the router
 * has the canonical (server, tool) → verb table; the gateway's
 * hermes-mcp.mjs surfaces "unknown tool" as a structured 400. The boundary
 * only enforces NAMESPACE reachability.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isHermesMcpPath(pathname) {
  if (typeof pathname !== "string" || !pathname) return false;
  const m = pathname.match(PATH_RE);
  if (!m) return false;
  const server = decodeURIComponent(m[1]).toLowerCase();
  return EXPOSED_SET.has(server);
}

/**
 * Returns true iff (method, pathname) names a reachable Hermes MCP route.
 * Only POST is exposed — the routes are command-shaped, not read-shaped.
 *
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
export function isHermesMcpRouteAllowed(method, pathname) {
  if (typeof method !== "string") return false;
  if (method.toUpperCase() !== "POST") return false;
  return isHermesMcpPath(pathname);
}

// ---------------------------------------------------------------------------
// Allowed-list export
// ---------------------------------------------------------------------------
//
// The main boundary's flat ALLOWED list cannot contain {method,path} pairs
// for dynamic routes. We export a placeholder so future refactors that
// switch to a more expressive allow-list shape have a stable import point;
// for now it is empty by design and the predicate above is the operative
// admit-check.

export const HERMES_MCP_ALLOWED = Object.freeze([]);

/**
 * Headers that the MCP adapter chain consumes internally — must not be
 * forwarded from the frontier. Restated here so a boundary refactor that
 * loosens the global FORBIDDEN_HEADER_PREFIXES list does not silently
 * loosen the MCP surface.
 */
export const HERMES_MCP_FORBIDDEN_HEADER_PREFIXES = Object.freeze([
  "x-hermes-",
  "x-mcp-",
  "x-codexa-",
  "x-orangebox-",
  "x-mirage-",
  "x-loom-",
  "x-internal-",
]);
