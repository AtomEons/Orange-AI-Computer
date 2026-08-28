// AE OrangeLLM — ToolMesh discovery routes
// Path: 06-ORANGELLM/server/routes/toolmesh.mjs
//
// Doctrine (operator-issued, Atom McCree):
//   - ToolMesh is the capability-discovery surface OrangeLLM consults BEFORE
//     it asks the operator for execution approval. The 11 capability labs
//     (image, video, audio, design, coding, automation, analytics,
//     public-agent, observability, security, releaseops) hold tool-cards.
//   - Tool-cards are CAPABILITY INDICATORS, not permission-to-execute.
//     They surface what the mesh can do, at what cost class, latency class,
//     and risk class. Execution remains gated by Hermes leases + the 8-gate
//     LOOM chain. Nothing in this file mints a lease, opens a socket, or
//     touches a host resource — it is a read-only window onto
//     13-TOOLMESH/registry.mjs.
//   - The registry is JSON-schema'd and hot-reloadable. We hold ONE shared
//     registry instance (lazy-loaded on first hit) and let its fs.watch
//     loop keep us current. Cards quarantined by the validator are never
//     surfaced through these routes — Mom's Law: receipts only, no theater.
//   - Mom's Law applies to the surface too: no fake-200s, no silent empty
//     payloads if the registry could not load, no inventing cards we did
//     not validate. Honest gaps over elegant fiction.
//
// Endpoints (all under /v1/toolmesh/):
//
//   GET /v1/toolmesh/labs
//     ->  200 { ok:true, data:{
//                 total_loaded, total_quarantined,
//                 labs: [{ id, name, tool_cards, loaded, quarantined,
//                          status }]
//               } }
//         The "labs" list always contains all 11 lab ids in canonical order
//         (matches 13-TOOLMESH/registry.mjs LAB_IDS). Labs with zero cards
//         get status:"STUB" so the operator can see at a glance which
//         domains are not yet populated.
//         503 toolmesh_unavailable if the registry refused to load.
//
//   GET /v1/toolmesh/labs/:lab/cards
//     ->  200 { ok:true, data:{ lab, count, cards: [card, ...] } }
//         404 toolmesh_unknown_lab if :lab is not one of the 11 enums.
//         503 toolmesh_unavailable if the registry refused to load.
//         Cards are returned in the registry's deterministic (lab, card_id)
//         order. Deprecated cards are excluded by default; pass
//         ?includeDeprecated=1 to include them.
//
//   GET /v1/toolmesh/search?q=&risk=&cost=&lab=&latency=&capability=
//                          &tag=&vendor=&includeDeprecated=&limit=
//     ->  200 { ok:true, data:{
//                 query: { ... echoed normalized ... },
//                 count, results: [card, ...]
//               } }
//         Multi-valued filters (lab, risk, cost, latency, tag) may repeat
//         the query parameter (?risk=read-only&risk=sandboxed) to widen the
//         match. Unknown enum values yield 400 invalid_request rather than
//         silently empty results — silent-empty is theater.
//         400 invalid_request on shape violation.
//         503 toolmesh_unavailable if the registry refused to load.
//
// Boundary update: these paths must be exported by
//   server/routes/toolmesh-boundary.mjs (TOOLMESH_ALLOWED + a
//   TOOLMESH_PATH_PREFIX predicate) and wired into server/boundary.mjs.
//   The middle path GET /v1/toolmesh/labs/:lab/cards is parametric so the
//   main boundary needs the predicate, not just a flat allow-list entry —
//   the same shape the receipts surface already uses.
//
// Smoke test: see 13-TOOLMESH/registry.mjs CLI (`node registry.mjs`) for
//   the underlying read surface; a route-level smoke test belongs in
//   06-ORANGELLM/server/routes/toolmesh.test.mjs (future PR).

import { URL } from "node:url";
import {
  LAB_IDS,
  ToolMeshRegistry,
  searchCards,
} from "../../../13-TOOLMESH/registry.mjs";
import { LABS as LAB_MANIFEST } from "../../../13-TOOLMESH/labs/index.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOOLMESH_PATH_PREFIX = "/v1/toolmesh";
export const TOOLMESH_LABS_PATH = `${TOOLMESH_PATH_PREFIX}/labs`;
export const TOOLMESH_SEARCH_PATH = `${TOOLMESH_PATH_PREFIX}/search`;

// /v1/toolmesh/labs/<labId>/cards — closed by the LAB_IDS enum. We mirror the
// receipts surface's parametric-route style rather than introducing a router.
const LAB_CARDS_RX = /^\/v1\/toolmesh\/labs\/([a-z][a-z0-9-]{0,30})\/cards$/;

// Closed enums mirrored from the tool-card schema. We do NOT import these as
// mutable references from the registry — the canonical place is the schema,
// and keeping a local closed enum here means the route layer fails closed if
// the registry ever loosens (which would itself be a separate review).
const COST_CLASSES = new Set(["free", "byo-key", "metered"]);
const LATENCY_CLASSES = new Set(["sub-second", "seconds", "minutes"]);
const RISK_CLASSES = new Set([
  "read-only",
  "sandboxed",
  "mutating",
  "external-side-effect",
]);

// Search query caps. Frontier-side requests are size-bounded by the gateway,
// but a defensive cap on free-text query + tag fan-out is cheap insurance.
const MAX_QUERY_LEN = 200;
const MAX_TAGS = 16;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// HTTP helpers (mirrored from sibling route modules so this file stays
// self-contained — the gateway core does not export them).
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(message, status, type, extra = {}) {
  return {
    ok: false,
    error: { message, type, code: status, ...extra },
  };
}

function errorResponse(res, message, status, type = "invalid_request_error", extra = {}) {
  jsonResponse(res, errorBody(message, status, type, extra), status);
}

// ---------------------------------------------------------------------------
// Shared registry instance — lazy-loaded, hot-reloads itself via fs.watch.
// ---------------------------------------------------------------------------
//
// We keep a single registry for the lifetime of the process. Its underlying
// fs.watch picks up new/changed/removed tool-cards on disk; we do not need to
// re-instantiate per request. A load failure is sticky for one tick so we do
// not stampede the disk on every miss — the next request retries.

let _registry = null;
let _registryReady = null; // Promise<ToolMeshRegistry> | null while loading
let _lastLoadError = null;

async function getRegistry(cfg) {
  if (_registry) return _registry;
  if (_registryReady) return _registryReady;

  _registryReady = (async () => {
    const reg = cfg.registryFactory
      ? cfg.registryFactory()
      : new ToolMeshRegistry({ watch: cfg.watch !== false });
    try {
      await reg.load();
      _registry = reg;
      _lastLoadError = null;
      return reg;
    } catch (err) {
      _lastLoadError = err && err.message ? err.message : String(err);
      throw err;
    } finally {
      _registryReady = null;
    }
  })();

  return _registryReady;
}

/**
 * Test-only: drop the cached registry so a unit test can re-load against a
 * temp labs/ root. Never called from production code paths.
 */
export function __resetToolmeshRegistryForTests() {
  if (_registry && typeof _registry.close === "function") {
    try {
      _registry.close();
    } catch {
      /* ignore */
    }
  }
  _registry = null;
  _registryReady = null;
  _lastLoadError = null;
}

function unavailableBody(detail = {}) {
  return errorBody(
    "ToolMesh registry failed to load; refusing to serve a fake-empty mesh. " +
      "Inspect 13-TOOLMESH/ on disk and the gateway logs for the load error.",
    503,
    "toolmesh_unavailable",
    {
      detail: {
        last_load_error: _lastLoadError,
        ...detail,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

function multiParam(url, name) {
  const all = url.searchParams.getAll(name);
  if (all.length === 0) return null;
  // Allow comma-separated values inside a single param for ergonomics, e.g.
  // ?risk=read-only,sandboxed. Mirror the way most HTTP search APIs behave.
  const out = [];
  for (const v of all) {
    if (typeof v !== "string") continue;
    for (const part of v.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out.length > 0 ? out : null;
}

function singleParam(url, name) {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function boolParam(url, name) {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return null;
}

function intParam(url, name) {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  if (!/^-?\d+$/.test(v)) return Number.NaN;
  return parseInt(v, 10);
}

/**
 * Parse + validate the /search query string. Returns either
 *   { ok: true, query: <object passed to searchCards()>, echo: <normalized> }
 * or
 *   { ok: false, status, message, detail }
 *
 * Unknown enum values are 400s (not silent-empty) so the frontier model
 * cannot mis-spell its way into "no tools available" theater.
 */
function parseSearchQuery(url) {
  const errors = [];

  // Free-text query — `q` is the documented spelling; we accept `query` too
  // for symmetry with the registry's internal field name.
  const q = singleParam(url, "q") || singleParam(url, "query");
  if (q !== null && q.length > MAX_QUERY_LEN) {
    errors.push({
      field: "q",
      msg: `query string exceeds ${MAX_QUERY_LEN} chars`,
    });
  }

  // Multi-valued enum filters.
  const labs = multiParam(url, "lab");
  if (labs) {
    for (const l of labs) {
      if (!LAB_IDS.includes(l)) {
        errors.push({
          field: "lab",
          msg: `unknown lab "${l}"; must be one of ${LAB_IDS.join(",")}`,
        });
      }
    }
  }
  const risk = multiParam(url, "risk");
  if (risk) {
    for (const r of risk) {
      if (!RISK_CLASSES.has(r)) {
        errors.push({
          field: "risk",
          msg: `unknown risk class "${r}"; must be one of ${[...RISK_CLASSES].join(",")}`,
        });
      }
    }
  }
  const cost = multiParam(url, "cost");
  if (cost) {
    for (const c of cost) {
      if (!COST_CLASSES.has(c)) {
        errors.push({
          field: "cost",
          msg: `unknown cost class "${c}"; must be one of ${[...COST_CLASSES].join(",")}`,
        });
      }
    }
  }
  const latency = multiParam(url, "latency");
  if (latency) {
    for (const lat of latency) {
      if (!LATENCY_CLASSES.has(lat)) {
        errors.push({
          field: "latency",
          msg: `unknown latency class "${lat}"; must be one of ${[...LATENCY_CLASSES].join(",")}`,
        });
      }
    }
  }

  // Capability — dotted string or trailing-.* prefix. Registry validates the
  // exact shape; here we only sanity-cap the length.
  const capability = singleParam(url, "capability");
  if (capability && capability.length > 128) {
    errors.push({ field: "capability", msg: "exceeds 128 chars" });
  }

  // Tags — repeated param, possibly comma-split. AND semantics (card must
  // include every listed tag), mirroring registry searchCards.
  const tags = multiParam(url, "tag");
  if (tags && tags.length > MAX_TAGS) {
    errors.push({
      field: "tag",
      msg: `more than ${MAX_TAGS} tag filters`,
    });
  }

  // Vendor — single value, case-insensitive match downstream.
  const vendor = singleParam(url, "vendor");
  if (vendor && vendor.length > 64) {
    errors.push({ field: "vendor", msg: "exceeds 64 chars" });
  }

  // Deprecated visibility.
  const includeDeprecatedRaw = url.searchParams.get("includeDeprecated");
  const includeDeprecated = boolParam(url, "includeDeprecated") ?? false;
  if (includeDeprecatedRaw !== null && includeDeprecated === false && includeDeprecatedRaw !== "0" && includeDeprecatedRaw !== "false" && includeDeprecatedRaw !== "no") {
    errors.push({
      field: "includeDeprecated",
      msg: "must be one of 0|1|true|false|yes|no",
    });
  }

  // Limit — defensive cap.
  let limit = intParam(url, "limit");
  if (limit !== null) {
    if (!Number.isInteger(limit) || limit <= 0) {
      errors.push({ field: "limit", msg: "must be a positive integer" });
      limit = null;
    } else if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
  } else {
    limit = DEFAULT_LIMIT;
  }

  if (errors.length > 0) {
    return {
      ok: false,
      status: 400,
      message: "search query validation failed",
      detail: { errors },
    };
  }

  // Shape passed to registry.search / searchCards.
  const query = {
    lab: labs || undefined,
    cost_class: cost || undefined,
    latency_class: latency || undefined,
    risk_class: risk || undefined,
    capability: capability || undefined,
    tags: tags || undefined,
    vendor: vendor || undefined,
    query: q || undefined,
    includeDeprecated,
    limit,
  };

  // Echo carries the normalized request back to the caller so they can see
  // exactly what filters matched (especially helpful when comma-splitting).
  const echo = {
    q: q || null,
    lab: labs || [],
    cost: cost || [],
    latency: latency || [],
    risk: risk || [],
    capability: capability || null,
    tag: tags || [],
    vendor: vendor || null,
    includeDeprecated,
    limit,
  };

  return { ok: true, query, echo };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/toolmesh/labs
 *
 * Join the canonical 11-lab manifest (id + display name) with the live
 * registry counts. Always returns all 11 entries in canonical order, even
 * when a lab has zero cards on disk — the planner needs to see the shape of
 * the mesh, not a sparse list that hides empty domains.
 */
export async function handleToolmeshLabsList(cfg) {
  let reg;
  try {
    reg = await getRegistry(cfg);
  } catch {
    return { status: 503, body: unavailableBody() };
  }

  const stats = reg.stats();
  const byId = new Map(stats.labs.map((l) => [l.id, l]));
  const manifestById = new Map(LAB_MANIFEST.map((l) => [l.id, l]));

  const labs = LAB_IDS.map((id) => {
    const live = byId.get(id) || { loaded: 0, quarantined: 0 };
    const manifest = manifestById.get(id);
    // Status mirrors the manifest's STUB/ACTIVE intent but is corrected by
    // ground truth: a lab declared STUB that has cards on disk is ACTIVE.
    const status = live.loaded > 0 ? "ACTIVE" : "STUB";
    return {
      id,
      name: manifest ? manifest.name : id,
      tool_cards: live.loaded,
      loaded: live.loaded,
      quarantined: live.quarantined,
      status,
    };
  });

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        total_loaded: stats.total_loaded,
        total_quarantined: stats.total_quarantined,
        labs,
      },
    },
  };
}

/**
 * GET /v1/toolmesh/labs/:lab/cards
 *
 * Return every validated card for the named lab, in deterministic
 * (lab, card_id) order. Unknown lab ids are 404 (never silent-empty).
 */
export async function handleToolmeshLabCards(labId, url, cfg) {
  if (!LAB_IDS.includes(labId)) {
    return {
      status: 404,
      body: errorBody(
        `unknown lab "${labId}"; must be one of ${LAB_IDS.join(",")}`,
        404,
        "toolmesh_unknown_lab",
        { detail: { lab: labId, valid_labs: LAB_IDS.slice() } },
      ),
    };
  }

  let reg;
  try {
    reg = await getRegistry(cfg);
  } catch {
    return { status: 503, body: unavailableBody({ lab: labId }) };
  }

  const includeDeprecated = boolParam(url, "includeDeprecated") ?? false;
  let cards = reg.byLab(labId);
  if (!includeDeprecated) {
    cards = cards.filter((c) => c.deprecated !== true);
  }

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        lab: labId,
        count: cards.length,
        cards,
      },
    },
  };
}

/**
 * GET /v1/toolmesh/search?q=&risk=&cost=&lab=&latency=&capability=&tag=&vendor=
 *
 * Cross-lab filtered + ranked search. All filters AND together. The
 * registry returns results in deterministic (lab, card_id) order.
 */
export async function handleToolmeshSearch(url, cfg) {
  const parsed = parseSearchQuery(url);
  if (!parsed.ok) {
    return {
      status: parsed.status,
      body: errorBody(parsed.message, parsed.status, "invalid_request_error", {
        detail: parsed.detail,
      }),
    };
  }

  let reg;
  try {
    reg = await getRegistry(cfg);
  } catch {
    return { status: 503, body: unavailableBody() };
  }

  // Use the registry's own search for index reuse, but fall back to the
  // pure searchCards helper if the registry instance was a bare class — both
  // produce identical, deterministic output.
  const results =
    typeof reg.search === "function"
      ? reg.search(parsed.query)
      : searchCards(reg.list(), parsed.query);

  return {
    status: 200,
    body: {
      ok: true,
      data: {
        query: parsed.echo,
        count: results.length,
        results,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Path classification — shared with toolmesh-boundary.mjs predicate so the
// main boundary can recognize the dynamic `:lab` segment without rewriting
// the regex in two places.
// ---------------------------------------------------------------------------

/**
 * Return true iff pathName is the toolmesh labs/:lab/cards parametric route
 * (the lab segment is constrained to the closed LAB_IDS enum so callers
 * never see arbitrary path payloads).
 */
export function isToolmeshLabCardsPath(pathName) {
  if (typeof pathName !== "string") return false;
  const m = LAB_CARDS_RX.exec(pathName);
  if (!m) return false;
  return LAB_IDS.includes(m[1]);
}

/**
 * Return true iff pathName is one of the toolmesh routes (literal or
 * parametric). Used by the main boundary's allow-list join.
 */
export function isToolmeshPath(pathName) {
  if (typeof pathName !== "string") return false;
  if (pathName === TOOLMESH_LABS_PATH) return true;
  if (pathName === TOOLMESH_SEARCH_PATH) return true;
  return isToolmeshLabCardsPath(pathName);
}

// ---------------------------------------------------------------------------
// Public: registerToolmeshRoutes(server, opts)
// ---------------------------------------------------------------------------

/**
 * Attach the ToolMesh discovery routes to a node:http Server. Follows the
 * same `prependListener("request", ...)` pattern as the Hermes, AtomSmasher,
 * AE Misfit, and Memory routes so each surface stays self-contained.
 *
 * @param {import("node:http").Server} server
 * @param {object} [opts]
 * @param {boolean} [opts.watch]              false to disable fs.watch
 *                                            (tests / one-shot envs).
 * @param {()=>ToolMeshRegistry} [opts.registryFactory]
 *                                            inject a pre-built registry
 *                                            (e.g. against a temp labs/).
 * @param {(line:string)=>void} [opts.log]
 * @returns {{ cfg: object, path_prefix: string, routes: Array<{method:string, path:string}> }}
 */
export function registerToolmeshRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerToolmeshRoutes: server must be a node:http Server");
  }

  const cfg = {
    watch: opts.watch !== false,
    registryFactory:
      typeof opts.registryFactory === "function" ? opts.registryFactory : null,
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

    // Fast path: ignore anything outside the /v1/toolmesh/ namespace so the
    // rest of the gateway router can claim it.
    if (
      pathName !== TOOLMESH_LABS_PATH &&
      pathName !== TOOLMESH_SEARCH_PATH &&
      !LAB_CARDS_RX.test(pathName)
    ) {
      return;
    }

    // Method enforcement — all three routes are read-only.
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: ["GET"] },
      );
    }

    try {
      if (pathName === TOOLMESH_LABS_PATH) {
        const { status, body } = await handleToolmeshLabsList(cfg);
        return jsonResponse(res, body, status);
      }
      if (pathName === TOOLMESH_SEARCH_PATH) {
        const { status, body } = await handleToolmeshSearch(url, cfg);
        return jsonResponse(res, body, status);
      }
      const m = LAB_CARDS_RX.exec(pathName);
      if (m) {
        const labId = m[1];
        const { status, body } = await handleToolmeshLabCards(labId, url, cfg);
        return jsonResponse(res, body, status);
      }
    } catch (err) {
      cfg.log(`[toolmesh] handler error: ${err && err.message ? err.message : err}`);
      return errorResponse(
        res,
        err && err.message ? err.message : "toolmesh internal error",
        500,
        "toolmesh_internal_error",
      );
    }
  });

  return {
    cfg,
    path_prefix: TOOLMESH_PATH_PREFIX,
    routes: [
      { method: "GET", path: TOOLMESH_LABS_PATH },
      { method: "GET", path: `${TOOLMESH_PATH_PREFIX}/labs/:lab/cards` },
      { method: "GET", path: TOOLMESH_SEARCH_PATH },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

export const __toolmeshInternals = {
  parseSearchQuery,
  multiParam,
  singleParam,
  boolParam,
  intParam,
  LAB_CARDS_RX,
  COST_CLASSES,
  LATENCY_CLASSES,
  RISK_CLASSES,
  MAX_QUERY_LEN,
  MAX_TAGS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
};
