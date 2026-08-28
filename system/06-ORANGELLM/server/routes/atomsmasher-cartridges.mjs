// AE OrangeLLM — AtomSmasher Cartridges gateway routes
// Path: 06-ORANGELLM/server/routes/atomsmasher-cartridges.mjs
//
// Doctrine:
//   - Cartridges are pre-compiled domain capability units. They are inert
//     descriptors carrying a system_prompt + tool_cards + capabilities[]. The
//     loader at 12-ATOMSMASHER/cartridges/loader.mjs is the single in-memory
//     owner; these routes are a thin HTTP adapter over it.
//   - "Hot-swap" means the loader's mutations live in memory by default. The
//     POST /load route accepts an optional {persist: true} flag that triggers
//     an atomic rewrite of registry.json AFTER the mutation succeeds.
//   - POST /load chooses load() vs swap() based on whether the named cartridge
//     is already known: new name -> load; known name -> swap (with
//     expected_version honored as a compare-and-set primitive).
//   - Mom's Law: every error returns a structured body with type + code. No
//     silent 200s. Receipts (cartridge_id, prev_version, persisted_path) flow
//     back to the caller.
//
// Exports:
//   registerCartridgesRoutes(server, opts)
//     server : node:http Server instance
//     opts   : {
//       registryPath?: string  // default 12-ATOMSMASHER/cartridges/registry.json
//       loader?:       Loader  // inject for tests
//       log?:          (line) => void
//     }
//
// Routes (all under /v1/atomsmasher/cartridges):
//   GET  /v1/atomsmasher/cartridges
//        -> 200 {cartridges: [...summaries], count}
//
//   GET  /v1/atomsmasher/cartridges/:name
//        -> 200 {cartridge: {...full}}
//        -> 404 if unknown
//
//   POST /v1/atomsmasher/cartridges/load
//        body: {cartridge, expected_version?, persist?}
//        -> 201 {action: 'loaded', cartridge_id}
//        -> 200 {action: 'swapped', cartridge_id, prev_version}
//        -> 422 on validation/anti-fluff failure
//
//   POST /v1/atomsmasher/cartridges/:name/unload
//        body: {persist?: boolean}
//        -> 200 {action: 'unloaded', cartridge_id}
//        -> 404 if unknown
//
//   POST /v1/atomsmasher/cartridges/persist
//        -> 200 {ok: true, path, count}
//
// Boundary note: these paths must be added to the gateway allow-list at
// 06-ORANGELLM/server/routes/atomsmasher-boundary.mjs (or its sibling
// cartridges-boundary file) before they are reachable from outside loopback.

import { URL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLoader,
  validateCartridge,
  CARTRIDGE_SCHEMA_ID,
} from "../../../12-ATOMSMASHER/cartridges/loader.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB cap on POST bodies (system_prompts can be long)
const NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const PATH_PREFIX = "/v1/atomsmasher/cartridges";

function resolveDefaultRegistryPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/routes -> server -> 06-ORANGELLM -> .. -> 12-ATOMSMASHER/cartridges/registry.json
  return path.resolve(here, "..", "..", "..", "12-ATOMSMASHER", "cartridges", "registry.json");
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

function matchRoute(method, pathName) {
  if (!pathName.startsWith(PATH_PREFIX)) return null;
  const rest = pathName.slice(PATH_PREFIX.length); // "" | "/<name>" | "/<name>/unload" | "/load" | "/persist"

  if (rest === "" || rest === "/") {
    if (method === "GET") return { name: "list" };
    return { name: "method_not_allowed", allowed: ["GET"] };
  }

  const segs = rest.replace(/^\//, "").split("/").filter(Boolean);

  if (segs.length === 1) {
    const seg = segs[0];
    if (seg === "load") {
      if (method === "POST") return { name: "load" };
      return { name: "method_not_allowed", allowed: ["POST"] };
    }
    if (seg === "persist") {
      if (method === "POST") return { name: "persist" };
      return { name: "method_not_allowed", allowed: ["POST"] };
    }
    // Treat as :name
    if (method === "GET") return { name: "describe", cartridgeName: seg };
    return { name: "method_not_allowed", allowed: ["GET"] };
  }

  if (segs.length === 2) {
    const [cartridgeName, action] = segs;
    if (action === "unload") {
      if (method === "POST") return { name: "unload", cartridgeName };
      return { name: "method_not_allowed", allowed: ["POST"] };
    }
    return { name: "not_found" };
  }

  return { name: "not_found" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleList(cfg) {
  const list = cfg.loader.list();
  return {
    status: 200,
    body: {
      cartridges: list,
      count: list.length,
      generated_at: nowIso(),
    },
  };
}

function handleDescribe(name, cfg) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return {
      status: 400,
      body: {
        error: {
          message: `cartridge name must match ${NAME_RE}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  const c = cfg.loader.describe(name);
  if (!c) {
    return {
      status: 404,
      body: {
        error: {
          message: `cartridge not found: ${name}`,
          type: "cartridge_not_found",
          code: 404,
        },
      },
    };
  }
  return {
    status: 200,
    body: {
      cartridge: c,
      generated_at: nowIso(),
    },
  };
}

async function handleLoad(rawBody, cfg) {
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

  const { cartridge, expected_version, persist } = src;

  if (cartridge == null || typeof cartridge !== "object" || Array.isArray(cartridge)) {
    return {
      status: 400,
      body: {
        error: {
          message: "body.cartridge must be a cartridge object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  // Validate cartridge shape up front so we return 422 with the precise field
  // errors instead of waiting for the loader to surface them.
  const v = validateCartridge(cartridge);
  if (!v.valid) {
    return {
      status: 422,
      body: {
        error: {
          message: "cartridge validation failed",
          type: "cartridge_validation_error",
          code: 422,
          errors: v.errors,
        },
      },
    };
  }

  // Decide load vs swap based on whether the name is already known.
  const existing = cfg.loader.get(cartridge.name);
  let result;
  let action;
  if (existing) {
    action = "swapped";
    result = cfg.loader.swap(cartridge, { expected_version });
  } else {
    if (expected_version !== undefined) {
      // expected_version on a fresh load is a category error — fail honestly.
      return {
        status: 409,
        body: {
          error: {
            message: `expected_version supplied but cartridge '${cartridge.name}' is not loaded; omit expected_version for first-time load`,
            type: "cartridge_state_error",
            code: 409,
          },
        },
      };
    }
    action = "loaded";
    result = cfg.loader.load(cartridge);
  }

  if (!result || result.ok !== true) {
    // Distinguish compare-and-set / version-bump failures (409) from generic.
    const reason = (result?.errors || []).join("; ");
    const status = /expected_version|would not change version/.test(reason) ? 409 : 500;
    return {
      status,
      body: {
        error: {
          message: `cartridge ${action === "swapped" ? "swap" : "load"} failed: ${reason || "unknown"}`,
          type: status === 409 ? "cartridge_state_error" : "cartridge_internal_error",
          code: status,
          errors: result?.errors || [],
        },
      },
    };
  }

  let persisted = null;
  if (persist === true) {
    try {
      const p = await cfg.loader.persist();
      persisted = { path: p.path, count: p.count };
    } catch (err) {
      cfg.log(`[cartridges] persist after ${action} failed: ${err.message}`);
      return {
        status: 500,
        body: {
          error: {
            message: `mutation succeeded in-memory but persist failed: ${err.message}`,
            type: "cartridge_persist_error",
            code: 500,
            partial: { action, cartridge_id: result.cartridge_id },
          },
        },
      };
    }
  }

  return {
    status: action === "loaded" ? 201 : 200,
    body: {
      action,
      cartridge_id: result.cartridge_id,
      name: cartridge.name,
      version: cartridge.version,
      prev_version: result.prev_version || null,
      persisted,
      generated_at: nowIso(),
    },
  };
}

async function handleUnload(name, rawBody, cfg) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return {
      status: 400,
      body: {
        error: {
          message: `cartridge name must match ${NAME_RE}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const src = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const persist = src.persist === true;

  const result = cfg.loader.unload(name);
  if (!result || result.ok !== true) {
    return {
      status: 404,
      body: {
        error: {
          message: `cartridge not loaded: ${name}`,
          type: "cartridge_not_found",
          code: 404,
          errors: result?.errors || [],
        },
      },
    };
  }

  let persisted = null;
  if (persist) {
    try {
      const p = await cfg.loader.persist();
      persisted = { path: p.path, count: p.count };
    } catch (err) {
      cfg.log(`[cartridges] persist after unload failed: ${err.message}`);
      return {
        status: 500,
        body: {
          error: {
            message: `unload succeeded in-memory but persist failed: ${err.message}`,
            type: "cartridge_persist_error",
            code: 500,
            partial: { action: "unloaded", cartridge_id: result.cartridge_id },
          },
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      action: "unloaded",
      name,
      cartridge_id: result.cartridge_id,
      persisted,
      generated_at: nowIso(),
    },
  };
}

async function handlePersist(cfg) {
  try {
    const p = await cfg.loader.persist();
    return {
      status: 200,
      body: {
        ok: true,
        path: p.path,
        count: p.count,
        generated_at: nowIso(),
      },
    };
  } catch (err) {
    cfg.log(`[cartridges] persist failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `persist failed: ${err.message}`,
          type: "cartridge_persist_error",
          code: 500,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Public: registerCartridgesRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerCartridgesRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerCartridgesRoutes: server must be a node:http Server");
  }

  const log =
    typeof opts.log === "function"
      ? opts.log
      : (line) => {
          // eslint-disable-next-line no-console
          console.log(line);
        };

  // Allow injection for tests; otherwise construct a default loader and
  // schedule its init(). Requests that arrive before init() resolves get a
  // 503 so we never serve from a half-initialized state.
  const loader = opts.loader || createLoader({ registryPath: opts.registryPath || resolveDefaultRegistryPath(), log });
  let ready = false;
  let initError = null;
  const initPromise = loader
    .init()
    .then((res) => {
      if (res && res.ok === true) {
        ready = true;
        log(`[cartridges] loader ready: ${res.loaded} cartridges`);
      } else {
        initError = res;
        log(`[cartridges] loader init failed: ${JSON.stringify(res?.errors || res)}`);
      }
    })
    .catch((err) => {
      initError = { ok: false, errors: [{ errors: [err.message] }] };
      log(`[cartridges] loader init threw: ${err.message}`);
    });

  const cfg = { loader, log };

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

    if (!pathName.startsWith(PATH_PREFIX)) return;

    const route = matchRoute(method, pathName);
    if (!route) return;

    if (route.name === "not_found") {
      return errorResponse(
        res,
        `cartridges route not found: ${method} ${pathName}`,
        404,
        "cartridge_route_not_found",
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

    // Wait out the in-flight init() if we got a request very early.
    if (!ready) {
      await initPromise;
    }
    if (!ready) {
      return errorResponse(
        res,
        "cartridges loader failed to initialize",
        503,
        "cartridge_loader_unavailable",
        { init_error: initError },
      );
    }

    try {
      if (route.name === "list") {
        const { status, body } = handleList(cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === "describe") {
        const { status, body } = handleDescribe(route.cartridgeName, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === "load") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleLoad(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === "unload") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
        }
        const { status, body } = await handleUnload(route.cartridgeName, raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === "persist") {
        const { status, body } = await handlePersist(cfg);
        return jsonResponse(res, body, status);
      }
      return errorResponse(res, "unreachable router state", 500, "cartridge_internal_error");
    } catch (err) {
      cfg.log(`[cartridges] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(
        res,
        err.message || "cartridges internal error",
        500,
        "cartridge_internal_error",
      );
    }
  });

  return {
    cfg,
    prefix: PATH_PREFIX,
    initPromise,
    routes: [
      { method: "GET", path: PATH_PREFIX },
      { method: "GET", path: `${PATH_PREFIX}/:name` },
      { method: "POST", path: `${PATH_PREFIX}/load` },
      { method: "POST", path: `${PATH_PREFIX}/:name/unload` },
      { method: "POST", path: `${PATH_PREFIX}/persist` },
    ],
  };
}

// Re-export handlers + schema id for direct wiring + unit tests.
export const __cartridgeHandlers = {
  handleList,
  handleDescribe,
  handleLoad,
  handleUnload,
  handlePersist,
  matchRoute,
  CARTRIDGE_SCHEMA_ID,
};
