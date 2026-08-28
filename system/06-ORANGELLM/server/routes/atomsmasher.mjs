// AE OrangeLLM — AtomSmasher Commitment Atoms gateway routes
// Path: 06-ORANGELLM/server/routes/atomsmasher.mjs
//
// Doctrine:
//   - AtomSmasher Commitment Atoms are the smallest unit of operator-or-system
//     promise. Each atom is content-hashed, hash-chained, and append-only.
//   - The atom store at 12-ATOMSMASHER/commitment-atoms/store.mjs is the
//     single writer of record. These routes are thin HTTP adapters over it.
//   - Atoms are NEVER edited. The /revoke route does not mutate body; it marks
//     status='superseded' and lays down a revocation event in the Reality lane
//     via Æ Cobra Flux. To "change" an atom, mint a NEW atom whose `supersedes`
//     array includes the prior atom_id.
//   - Mom's Law applies: no silent success, no theatrical 200s. Every error
//     returns a structured error body with type and code. Receipts (atom_id,
//     hash, flux_record_hash) flow back to the caller so the chain is
//     externally verifiable.
//
// Exports:
//   registerAtomSmasherRoutes(server, opts)
//     server : node:http Server instance
//     opts   : {
//       fluxRoot?: string  // default <repo>/06-ORANGELLM/memory/ae-cobra/flux
//       dbPath?:   string  // default <repo>/06-ORANGELLM/memory/commitment-atoms.db
//       log?:      (line) => void
//     }
//
// Routes registered (all under /v1/atomsmasher/atoms):
//   POST /v1/atomsmasher/atoms
//        body: {kind, body, preconditions?, supersedes?, evidence?, actor,
//               expires_at?}
//        -> 201 {atom_id, hash, prev_hash, flux_record_hash, atom}
//
//   GET  /v1/atomsmasher/atoms?kind=&status=&since=
//        -> 200 {atoms: [...], count, filters}
//
//   GET  /v1/atomsmasher/atoms/:atom_id
//        -> 200 {atom, chain_summary, markdown}
//
//   GET  /v1/atomsmasher/atoms/:atom_id/chain
//        -> 200 {atom, preconditions_resolved, supersedes_chain}
//
//   POST /v1/atomsmasher/atoms/:atom_id/revoke
//        body: {superseded_by, reason}
//        -> 200 {atom_id, status, flux_record_hash}
//
// Boundary note: these paths must also be added to the gateway allow-list at
// 06-ORANGELLM/server/routes/atomsmasher-boundary.mjs and pulled into the
// main boundary.mjs ALLOWED list before they are reachable from outside.

import { URL } from "node:url";
import path from "node:path";
import { canonicalFluxRoot } from "../../memory/ae-cobra/paths.mjs";
import { fileURLToPath } from "node:url";

import {
  encodeCommitmentAtom,
  validateCommitmentAtom,
  VALID_KINDS,
  VALID_STATUSES,
} from "../../../12-ATOMSMASHER/commitment-atoms/encoder.mjs";
import {
  decodeCommitmentAtom,
  traverseChain,
} from "../../../12-ATOMSMASHER/commitment-atoms/decoder.mjs";
import * as store from "../../../12-ATOMSMASHER/commitment-atoms/store.mjs";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB cap on POST bodies
const ATOM_ID_RE = /^[a-f0-9]{64}$/;
const PATH_PREFIX = "/v1/atomsmasher/atoms";

function resolveDefaultFluxRoot() {
  return canonicalFluxRoot();
}

function resolveDefaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "memory", "commitment-atoms.db");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = "invalid_request_error", extra = {}) {
  jsonResponse(
    res,
    {
      error: {
        message,
        type: code,
        code: status,
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
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------
//
// Five route shapes share a /v1/atomsmasher/atoms prefix. We resolve them in
// a small dispatch table rather than a regex tangle.

function matchRoute(method, pathName) {
  if (!pathName.startsWith(PATH_PREFIX)) return null;
  const rest = pathName.slice(PATH_PREFIX.length); // "" | "/<id>" | "/<id>/revoke" | "/<id>/chain"

  if (rest === "" || rest === "/") {
    if (method === "POST") return { name: "create" };
    if (method === "GET") return { name: "list" };
    return { name: "method_not_allowed", allowed: ["POST", "GET"] };
  }

  // Strip leading slash and split.
  const segs = rest.replace(/^\//, "").split("/").filter(Boolean);
  // segs[0] = atom_id ; segs[1] (optional) = "revoke" | "chain"

  if (segs.length === 1) {
    const atomId = segs[0];
    if (method === "GET") return { name: "get", atomId };
    return { name: "method_not_allowed", allowed: ["GET"] };
  }

  if (segs.length === 2) {
    const atomId = segs[0];
    const action = segs[1];
    if (action === "revoke") {
      if (method === "POST") return { name: "revoke", atomId };
      return { name: "method_not_allowed", allowed: ["POST"] };
    }
    if (action === "chain") {
      if (method === "GET") return { name: "chain", atomId };
      return { name: "method_not_allowed", allowed: ["GET"] };
    }
    return { name: "not_found" };
  }

  return { name: "not_found" };
}

// ---------------------------------------------------------------------------
// Handlers — accept already-parsed input, return {status, body}
// ---------------------------------------------------------------------------

async function handleCreate(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const {
    kind,
    body,
    preconditions = [],
    supersedes = [],
    evidence = [],
    actor,
    expires_at = null,
  } = src;

  // Determine prev_hash for the new atom: chain off whatever atom was created
  // last (per-store latest hash). The store knows; if it can't tell us we
  // start a new sub-chain at GENESIS. This is the documented contract — the
  // global Æ Cobra Flux chain still witnesses the write regardless.
  let prevHash = "GENESIS";
  try {
    if (typeof store.getLatestHash === "function") {
      const latest = store.getLatestHash({ dbPath: cfg.dbPath });
      if (typeof latest === "string" && latest.length > 0) prevHash = latest;
    }
  } catch (err) {
    cfg.log(`[atomsmasher] getLatestHash failed (continuing with GENESIS): ${err.message}`);
  }

  // 1. Encode (validates kind/body/anti-fluff/evidence + computes hashes).
  let atom;
  try {
    atom = encodeCommitmentAtom({
      kind,
      body,
      preconditions,
      supersedes,
      evidence,
      actor,
      expires_at,
      prevHash,
    });
  } catch (err) {
    // Classify: anti-fluff and validation faults are 422; bad input is 400.
    const msg = err.message || "encode failed";
    const status = /anti-fluff|requires at least one evidence/.test(msg) ? 422 : 400;
    return {
      status,
      body: {
        error: {
          message: msg,
          type: status === 422 ? "atom_validation_error" : "invalid_request_error",
          code: status,
        },
      },
    };
  }

  // 2. Defence-in-depth: revalidate the encoded atom before handing to store.
  const v = validateCommitmentAtom(atom);
  if (!v.valid) {
    return {
      status: 500,
      body: {
        error: {
          message: "encoder produced an atom that fails validation",
          type: "atom_internal_error",
          code: 500,
          errors: v.errors,
        },
      },
    };
  }

  // 3. Persist (Flux record + SQLite row). The store is the single writer of
  //    record; we surface its receipt directly to the caller.
  let result;
  try {
    result = await store.createAtom(atom, {
      fluxRoot: cfg.fluxRoot,
      dbPath: cfg.dbPath,
    });
  } catch (err) {
    cfg.log(`[atomsmasher] store.createAtom failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `atom store write failed: ${err.message}`,
          type: "atom_store_error",
          code: 500,
        },
      },
    };
  }

  if (!result || result.ok !== true) {
    return {
      status: 500,
      body: {
        error: {
          message: "atom store returned non-ok result",
          type: "atom_store_error",
          code: 500,
          store_result: result || null,
        },
      },
    };
  }

  return {
    status: 201,
    body: {
      atom_id: atom.atom_id,
      hash: atom.signature.hash,
      prev_hash: atom.signature.prev_hash,
      flux_record_hash: result.flux_record_hash || null,
      atom,
      generated_at: nowIso(),
    },
  };
}

async function handleGet(atomId, cfg) {
  if (!ATOM_ID_RE.test(atomId)) {
    return {
      status: 400,
      body: {
        error: {
          message: "atom_id must be 64-char lowercase hex (sha256)",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  let atom;
  try {
    atom = await store.getAtom(atomId, { dbPath: cfg.dbPath });
  } catch (err) {
    cfg.log(`[atomsmasher] store.getAtom failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `atom store read failed: ${err.message}`,
          type: "atom_store_error",
          code: 500,
        },
      },
    };
  }

  if (!atom) {
    return {
      status: 404,
      body: {
        error: {
          message: `atom not found: ${atomId}`,
          type: "atom_not_found",
          code: 404,
        },
      },
    };
  }

  // Build a chain-aware store adapter so the decoder can resolve preconditions
  // / supersedes one-hop. Synchronous getAtom is what the decoder expects.
  const storeAdapter = {
    get(id) {
      try {
        // store.getAtom may return a Promise; the decoder's lookup() is
        // synchronous, so we only use the adapter when we know the store
        // exposes a sync variant.
        if (typeof store.getAtomSync === "function") {
          return store.getAtomSync(id, { dbPath: cfg.dbPath });
        }
        return null;
      } catch {
        return null;
      }
    },
  };

  const chainSummary = traverseChain(atomId, storeAdapter);
  const markdown = decodeCommitmentAtom(atom, { atomStore: storeAdapter });

  return {
    status: 200,
    body: {
      atom,
      chain_summary: {
        preconditions_resolved: chainSummary.preconditions_resolved,
        supersedes_chain: chainSummary.supersedes_chain,
      },
      markdown,
      generated_at: nowIso(),
    },
  };
}

async function handleList(query, cfg) {
  const filters = {
    kind: typeof query.kind === "string" && query.kind.length > 0 ? query.kind : undefined,
    status: typeof query.status === "string" && query.status.length > 0 ? query.status : undefined,
    since: typeof query.since === "string" && query.since.length > 0 ? query.since : undefined,
  };

  // Validate filter values before hitting the store — surface caller errors
  // honestly instead of silently returning [].
  if (filters.kind !== undefined && !VALID_KINDS.includes(filters.kind)) {
    return {
      status: 400,
      body: {
        error: {
          message: `kind filter must be one of: ${VALID_KINDS.join(", ")}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  if (filters.status !== undefined && !VALID_STATUSES.includes(filters.status)) {
    return {
      status: 400,
      body: {
        error: {
          message: `status filter must be one of: ${VALID_STATUSES.join(", ")}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  if (filters.since !== undefined && Number.isNaN(Date.parse(filters.since))) {
    return {
      status: 400,
      body: {
        error: {
          message: `since filter must be parseable ISO 8601 date, got: ${filters.since}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  let atoms;
  try {
    atoms = await store.listAtoms({
      kind: filters.kind,
      status: filters.status,
      since: filters.since,
      dbPath: cfg.dbPath,
    });
  } catch (err) {
    cfg.log(`[atomsmasher] store.listAtoms failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `atom store list failed: ${err.message}`,
          type: "atom_store_error",
          code: 500,
        },
      },
    };
  }

  const list = Array.isArray(atoms) ? atoms : [];

  return {
    status: 200,
    body: {
      atoms: list,
      count: list.length,
      filters,
      generated_at: nowIso(),
    },
  };
}

async function handleChain(atomId, cfg) {
  if (!ATOM_ID_RE.test(atomId)) {
    return {
      status: 400,
      body: {
        error: {
          message: "atom_id must be 64-char lowercase hex (sha256)",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  // For chain traversal we need a synchronous store accessor. If the store
  // exposes getAtomSync use it; otherwise we materialize a snapshot via
  // listAtoms and serve from that.
  let storeAdapter;
  if (typeof store.getAtomSync === "function") {
    storeAdapter = {
      get(id) {
        try {
          return store.getAtomSync(id, { dbPath: cfg.dbPath }) || null;
        } catch {
          return null;
        }
      },
    };
  } else {
    // Fallback: load everything once. This is honest about its cost — if the
    // store grows large, expose getAtomSync. Until then, correctness > speed.
    let all;
    try {
      all = await store.listAtoms({ dbPath: cfg.dbPath });
    } catch (err) {
      cfg.log(`[atomsmasher] chain fallback listAtoms failed: ${err.message}`);
      return {
        status: 500,
        body: {
          error: {
            message: `atom store list failed: ${err.message}`,
            type: "atom_store_error",
            code: 500,
          },
        },
      };
    }
    const map = new Map();
    for (const a of all || []) {
      if (a && typeof a.atom_id === "string") map.set(a.atom_id, a);
    }
    storeAdapter = map;
  }

  const result = traverseChain(atomId, storeAdapter);

  if (result.atom == null) {
    return {
      status: 404,
      body: {
        error: {
          message: `atom not found: ${atomId}`,
          type: "atom_not_found",
          code: 404,
          note: result.note || null,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      atom: result.atom,
      preconditions_resolved: result.preconditions_resolved,
      supersedes_chain: result.supersedes_chain,
      generated_at: nowIso(),
    },
  };
}

async function handleRevoke(atomId, rawBody, cfg) {
  if (!ATOM_ID_RE.test(atomId)) {
    return {
      status: 400,
      body: {
        error: {
          message: "atom_id must be 64-char lowercase hex (sha256)",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const supersededBy =
    typeof src.superseded_by === "string" && src.superseded_by.length > 0
      ? src.superseded_by
      : null;
  const reason = typeof src.reason === "string" ? src.reason : "";

  // superseded_by is optional — a pure revocation may have no replacement —
  // but if present it must be a valid atom_id shape.
  if (supersededBy !== null && !ATOM_ID_RE.test(supersededBy)) {
    return {
      status: 400,
      body: {
        error: {
          message: "superseded_by must be 64-char lowercase hex (sha256) or omitted",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  let result;
  try {
    result = await store.revokeAtom(atomId, supersededBy, {
      fluxRoot: cfg.fluxRoot,
      dbPath: cfg.dbPath,
      reason,
    });
  } catch (err) {
    cfg.log(`[atomsmasher] store.revokeAtom failed: ${err.message}`);
    // Distinguish "not found" from generic write failure if the store tells us.
    const msg = err.message || "revoke failed";
    if (/not found|no such atom/i.test(msg)) {
      return {
        status: 404,
        body: {
          error: {
            message: msg,
            type: "atom_not_found",
            code: 404,
          },
        },
      };
    }
    return {
      status: 500,
      body: {
        error: {
          message: `atom store revoke failed: ${msg}`,
          type: "atom_store_error",
          code: 500,
        },
      },
    };
  }

  if (!result || result.ok !== true) {
    return {
      status: 500,
      body: {
        error: {
          message: "atom store revoke returned non-ok result",
          type: "atom_store_error",
          code: 500,
          store_result: result || null,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      atom_id: atomId,
      status: result.status || "superseded",
      superseded_by: supersededBy,
      reason,
      flux_record_hash: result.flux_record_hash || null,
      generated_at: nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerAtomSmasherRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerAtomSmasherRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerAtomSmasherRoutes: server must be a node:http Server");
  }

  const cfg = {
    fluxRoot: opts.fluxRoot || resolveDefaultFluxRoot(),
    dbPath: opts.dbPath || resolveDefaultDbPath(),
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
      return; // malformed URL — let the main handler 400
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;

    if (!pathName.startsWith(PATH_PREFIX)) return;

    const route = matchRoute(method, pathName);
    if (!route) return; // not our namespace

    if (route.name === "not_found") {
      return errorResponse(
        res,
        `atomsmasher route not found: ${method} ${pathName}`,
        404,
        "atom_route_not_found",
      );
    }
    if (route.name === "method_not_allowed") {
      res.setHeader("Allow", route.allowed.join(", "));
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        "method_not_allowed",
        { allowed: route.allowed },
      );
    }

    try {
      if (route.name === "create") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleCreate(raw, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "list") {
        const query = Object.fromEntries(url.searchParams.entries());
        const { status, body } = await handleList(query, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "get") {
        const { status, body } = await handleGet(route.atomId, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "chain") {
        const { status, body } = await handleChain(route.atomId, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "revoke") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleRevoke(route.atomId, raw, cfg);
        return jsonResponse(res, body, status);
      }

      // unreachable
      return errorResponse(res, "unreachable router state", 500, "atom_internal_error");
    } catch (err) {
      cfg.log(`[atomsmasher] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(
        res,
        err.message || "atomsmasher internal error",
        500,
        "atom_internal_error",
      );
    }
  });

  return {
    cfg,
    prefix: PATH_PREFIX,
    routes: [
      { method: "POST", path: PATH_PREFIX },
      { method: "GET", path: PATH_PREFIX },
      { method: "GET", path: `${PATH_PREFIX}/:atom_id` },
      { method: "GET", path: `${PATH_PREFIX}/:atom_id/chain` },
      { method: "POST", path: `${PATH_PREFIX}/:atom_id/revoke` },
    ],
  };
}

// Re-export handlers for direct wiring + unit tests.
export const __atomsmasherHandlers = {
  handleCreate,
  handleGet,
  handleList,
  handleChain,
  handleRevoke,
  matchRoute,
};
