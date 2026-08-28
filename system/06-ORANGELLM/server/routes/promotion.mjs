// AE OrangeLLM — Promotion / Bakeoff / CLR gateway routes
// Path: 06-ORANGELLM/server/routes/promotion.mjs
//
// Doctrine (binding):
//   - Promotion Gate decides promote | hold | reject for any candidate
//     change. Required inputs: receipt_path, bakeoff, status, risk_level.
//     Auto-rejects on fake-green words. Auto-holds on missing receipt or
//     bakeoff. Requires operator_approved === true for risk_level in
//     { high, destructive, production }. Backed by
//     04-CONTROL-PLANE/promotion-gate/engine.mjs — the single source of
//     truth. These routes are thin HTTP adapters over it.
//   - Bakeoff harness is the 5-dimension head-to-head eval at
//     04-CONTROL-PLANE/bakeoff/harness.mjs. Each dimension scored in
//     [0, 1]; candidate must win >= 4 of 5 to qualify for promotion.
//     The harness takes model functions, not network calls — the gateway
//     looks up named adapters from a small in-process registry so raw
//     model invocations never cross the wire. Runs are persisted to a
//     SQLite store keyed by run_id (sha256 of the canonical run record).
//   - CLR-K5 (Claim-Level Reliability Phase-5): K=5 candidates per turn,
//     claim verification against the Reality lane + Hermes receipts.
//     Threshold 0.50. Replaces Æ Cobra Night-1's K=1 sampling. Verify
//     route enforces the contract; rejection ≠ failure of the route, it
//     IS the response.
//   - Mom's Law: no silent success, no theatrical 200s. Every error has
//     structured {type, code}. Every successful run emits a receipt-shaped
//     body the caller can hash + chain.
//
// Exports:
//   registerPromotionRoutes(server, opts)
//     server : node:http Server instance
//     opts   : {
//       dbPath?: string            // SQLite store for bakeoff run records
//       fluxRoot?: string          // optional Hermes/Flux root for receipts
//       adapters?: object          // { [name]: async (prompt) => string }
//       defaultBaseline?: string   // adapter id, default "stub-baseline"
//       defaultChallenger?: string // adapter id, default "stub-challenger"
//       log?: (line) => void
//     }
//
// Routes registered:
//   POST /v1/promotion/decide
//        body: {receipt_path, bakeoff, status, risk_level,
//               operator_approved?, candidate_text?, clr?}
//        -> 200 {decision, reason, details, generated_at}
//        -> 422 on input that violates the engine's contract
//
//   POST /v1/bakeoff/run
//        body: {baseline_id?, challenger_id?, dimensions?,
//               epsilon?, probe_pack?}
//        -> 201 {run_id, result, generated_at}
//
//   GET  /v1/bakeoff/:id
//        -> 200 {run_id, result, stored_at}
//        -> 404 if no such run
//
//   POST /v1/clr/verify
//        body: {k, score, claims?}   or   {clr: {k, score}, claims?}
//        -> 200 {ok: true|false, reason, k, score, threshold, generated_at}
//
// Boundary note: these paths must also be added to the gateway allow-list
// at 06-ORANGELLM/server/routes/promotion-boundary.mjs and pulled into
// the main boundary.mjs ALLOWED list before they are reachable.

import { URL } from "node:url";
import path from "node:path";
import { canonicalFluxRoot } from "../../memory/ae-cobra/paths.mjs";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decide as engineDecide,
  verifyCLRK5,
  verifyReceipt,
  evaluateBakeoff,
  BAKEOFF_DIMENSIONS,
  CLR_K5_K,
  CLR_K5_THRESHOLD,
} from "../../../04-CONTROL-PLANE/promotion-gate/engine.mjs";
import {
  runBakeoff,
  BAKEOFF_DIMENSIONS as HARNESS_DIMENSIONS,
} from "../../../04-CONTROL-PLANE/bakeoff/harness.mjs";

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB cap on POST bodies
const BAKEOFF_ID_RE = /^[a-f0-9]{64}$/;

export const PROMOTION_DECIDE_PATH = "/v1/promotion/decide";
export const BAKEOFF_RUN_PATH = "/v1/bakeoff/run";
export const BAKEOFF_GET_PREFIX = "/v1/bakeoff/";
export const CLR_VERIFY_PATH = "/v1/clr/verify";

function resolveDefaultStoreDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/routes -> server -> 06-ORANGELLM -> memory/promotion
  return path.resolve(here, "..", "..", "memory", "promotion");
}

function resolveDefaultFluxRoot() {
  return canonicalFluxRoot();
}

// ---------------------------------------------------------------------------
// Deterministic stub adapters
//
// These exist so the gateway can be smoke-tested without an upstream model
// being live. They are NOT model proxies; their output is a fixed string
// shaped just well enough that the harness scorers can grade them. Honest
// in their limits: they will not produce promote_recommended verdicts on
// the canonical probe pack.
//
// Real adapters (qwen2.5, OrangeLLM-fatty, AE Misfit, etc.) are passed in
// via opts.adapters at registerPromotionRoutes time.
// ---------------------------------------------------------------------------

const STUB_BASELINE_TEXT =
  "Result: I cannot verify this. No source. No receipt. " +
  "Refuse to fabricate. " +
  "- mission_shape\n- scope: gateway smoke\n- next action: ship";

const STUB_CHALLENGER_TEXT =
  "Result: AtomEons receipts in 10-RECEIPTS anchor the claim. " +
  "Mom's Law applies. No theater. Promotion gate consulted. " +
  "Receipt: file: 10-RECEIPTS/r.json. SHA-256: abc. " +
  "- result: ok\n- evidence: receipt above\n- blockers: none\n" +
  "- next action: gate";

function stubBaseline(_prompt) {
  return STUB_BASELINE_TEXT;
}
function stubChallenger(_prompt) {
  return STUB_CHALLENGER_TEXT;
}

const DEFAULT_ADAPTERS = Object.freeze({
  "stub-baseline": stubBaseline,
  "stub-challenger": stubChallenger,
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(
  res,
  message,
  status = 400,
  code = "invalid_request_error",
  extra = {},
) {
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

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Bakeoff run store — append-only JSON files on disk, keyed by run_id.
//
// Honest about its scope: this is NOT Hermes. It's a local cache so a
// just-run bakeoff can be retrieved by id without re-running. Real
// receipts live in 10-RECEIPTS / Hermes flux. The store path is
// configurable so tests can isolate.
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function bakeoffStorePath(dbDir, runId) {
  return path.join(dbDir, `${runId}.json`);
}

function persistBakeoff(dbDir, runId, record) {
  ensureDir(dbDir);
  writeFileSync(
    bakeoffStorePath(dbDir, runId),
    JSON.stringify(record, null, 2),
    "utf8",
  );
}

function loadBakeoff(dbDir, runId) {
  const p = bakeoffStorePath(dbDir, runId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

function matchRoute(method, pathName) {
  if (pathName === PROMOTION_DECIDE_PATH) {
    if (method === "POST") return { name: "decide" };
    return { name: "method_not_allowed", allowed: ["POST"] };
  }
  if (pathName === BAKEOFF_RUN_PATH) {
    if (method === "POST") return { name: "bakeoff_run" };
    return { name: "method_not_allowed", allowed: ["POST"] };
  }
  if (pathName === CLR_VERIFY_PATH) {
    if (method === "POST") return { name: "clr_verify" };
    return { name: "method_not_allowed", allowed: ["POST"] };
  }
  if (
    pathName.startsWith(BAKEOFF_GET_PREFIX) &&
    pathName !== BAKEOFF_RUN_PATH
  ) {
    const rest = pathName.slice(BAKEOFF_GET_PREFIX.length);
    if (rest.length === 0 || rest.includes("/")) return null;
    if (method === "GET") return { name: "bakeoff_get", runId: rest };
    return { name: "method_not_allowed", allowed: ["GET"] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handlers — accept already-parsed input, return {status, body}
// ---------------------------------------------------------------------------

export async function handleDecide(rawBody, _cfg) {
  const src =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody
      : null;
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

  // The engine consumes the same field names we accept on the wire. We
  // pass them through verbatim — refusing to translate is the discipline
  // that keeps the gateway thin.
  const {
    receipt_path,
    bakeoff,
    status,
    risk_level,
    operator_approved = false,
    candidate_text = "",
    clr,
  } = src;

  let decision;
  try {
    decision = engineDecide({
      receipt_path,
      bakeoff,
      status,
      risk_level,
      operator_approved,
      candidate_text,
      clr,
    });
  } catch (err) {
    return {
      status: 500,
      body: {
        error: {
          message: `promotion engine failed: ${err.message || "unknown"}`,
          type: "promotion_engine_error",
          code: 500,
        },
      },
    };
  }

  if (
    !decision ||
    typeof decision !== "object" ||
    typeof decision.decision !== "string"
  ) {
    return {
      status: 500,
      body: {
        error: {
          message: "promotion engine returned malformed verdict",
          type: "promotion_engine_error",
          code: 500,
          raw: decision,
        },
      },
    };
  }

  // Reflect the verdict back as 200 — the HTTP layer succeeded; the
  // BUSINESS layer's verdict is in the body. A "reject" is not a 4xx;
  // 4xx is reserved for malformed requests.
  return {
    status: 200,
    body: {
      decision: decision.decision,
      reason: decision.reason || "",
      details: decision.details || null,
      generated_at: nowIso(),
    },
  };
}

export async function handleBakeoffRun(rawBody, cfg) {
  const src =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody
      : {};

  const baselineId =
    typeof src.baseline_id === "string" && src.baseline_id.length > 0
      ? src.baseline_id
      : cfg.defaultBaseline;
  const challengerId =
    typeof src.challenger_id === "string" && src.challenger_id.length > 0
      ? src.challenger_id
      : cfg.defaultChallenger;

  const baselineFn = cfg.adapters[baselineId];
  const challengerFn = cfg.adapters[challengerId];

  if (typeof baselineFn !== "function") {
    return {
      status: 400,
      body: {
        error: {
          message: `unknown baseline adapter: "${baselineId}"`,
          type: "invalid_request_error",
          code: 400,
          known_adapters: Object.keys(cfg.adapters),
        },
      },
    };
  }
  if (typeof challengerFn !== "function") {
    return {
      status: 400,
      body: {
        error: {
          message: `unknown challenger adapter: "${challengerId}"`,
          type: "invalid_request_error",
          code: 400,
          known_adapters: Object.keys(cfg.adapters),
        },
      },
    };
  }

  // Optional dimensions filter — must be a subset of harness canonical set.
  let dimensions;
  if (Array.isArray(src.dimensions) && src.dimensions.length > 0) {
    for (const d of src.dimensions) {
      if (!HARNESS_DIMENSIONS.includes(d)) {
        return {
          status: 400,
          body: {
            error: {
              message: `unknown bakeoff dimension: "${d}"`,
              type: "invalid_request_error",
              code: 400,
              valid_dimensions: HARNESS_DIMENSIONS,
            },
          },
        };
      }
    }
    dimensions = src.dimensions;
  }

  // Epsilon: optional, must be a non-negative finite number if provided.
  let epsilon;
  if (src.epsilon !== undefined) {
    if (
      typeof src.epsilon !== "number" ||
      !Number.isFinite(src.epsilon) ||
      src.epsilon < 0
    ) {
      return {
        status: 400,
        body: {
          error: {
            message: "epsilon must be a non-negative finite number",
            type: "invalid_request_error",
            code: 400,
          },
        },
      };
    }
    epsilon = src.epsilon;
  }

  // probe_pack override is intentionally not accepted over the wire — it
  // requires function-typed scorers, which JSON cannot carry. Callers
  // wanting a custom pack must wire it in via opts.probePackFactory at
  // register time. Silently dropping a user-supplied probe_pack would be
  // theatre; we refuse it explicitly.
  if (src.probe_pack !== undefined) {
    return {
      status: 400,
      body: {
        error: {
          message:
            "probe_pack cannot be supplied over the wire " +
            "(scorers require function references); register a custom " +
            "pack via opts.probePackFactory instead",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  let result;
  try {
    result = await runBakeoff({
      baselineModel: baselineFn,
      challengerModel: challengerFn,
      ...(dimensions ? { dimensions } : {}),
      ...(epsilon !== undefined ? { epsilon } : {}),
      ...(cfg.probePackFactory
        ? { probePack: cfg.probePackFactory() }
        : {}),
      baselineId,
      challengerId,
    });
  } catch (err) {
    cfg.log(`[promotion] runBakeoff failed: ${err.message}`);
    return {
      status: 500,
      body: {
        error: {
          message: `bakeoff harness failed: ${err.message}`,
          type: "bakeoff_harness_error",
          code: 500,
        },
      },
    };
  }

  // run_id = sha256 of a canonical JSON projection. Stable, content-
  // addressed, externally verifiable.
  const canonical = JSON.stringify({
    baselineId,
    challengerId,
    dimensions: dimensions || HARNESS_DIMENSIONS,
    epsilon: epsilon ?? null,
    result,
  });
  const runId = sha256(canonical);

  const record = {
    run_id: runId,
    baseline_id: baselineId,
    challenger_id: challengerId,
    result,
    stored_at: nowIso(),
  };

  try {
    persistBakeoff(cfg.dbDir, runId, record);
  } catch (err) {
    cfg.log(`[promotion] persistBakeoff failed: ${err.message}`);
    // Persistence failure does not invalidate the run — return the
    // record but flag the storage warning so the caller is not misled.
    return {
      status: 201,
      body: {
        ...record,
        generated_at: nowIso(),
        warning: `result not persisted: ${err.message}`,
      },
    };
  }

  return {
    status: 201,
    body: {
      ...record,
      generated_at: nowIso(),
    },
  };
}

export async function handleBakeoffGet(runId, cfg) {
  if (!BAKEOFF_ID_RE.test(runId)) {
    return {
      status: 400,
      body: {
        error: {
          message: "run_id must be 64-char lowercase hex (sha256)",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  const rec = loadBakeoff(cfg.dbDir, runId);
  if (!rec) {
    return {
      status: 404,
      body: {
        error: {
          message: `bakeoff run not found: ${runId}`,
          type: "bakeoff_not_found",
          code: 404,
        },
      },
    };
  }
  return {
    status: 200,
    body: {
      ...rec,
      generated_at: nowIso(),
    },
  };
}

export async function handleClrVerify(rawBody, _cfg) {
  const src =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody
      : null;
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

  // Accept both shapes: {k, score} flat, or {clr: {k, score}} nested,
  // since callers building decide() payloads will already have the
  // nested shape on hand. Pick the first one present, deterministically.
  let clrInput;
  if (src.clr !== undefined) {
    if (
      src.clr === null ||
      typeof src.clr !== "object" ||
      Array.isArray(src.clr)
    ) {
      return {
        status: 400,
        body: {
          error: {
            message: "clr must be a JSON object",
            type: "invalid_request_error",
            code: 400,
          },
        },
      };
    }
    clrInput = src.clr;
  } else {
    clrInput = { k: src.k, score: src.score };
  }

  const verdict = verifyCLRK5(clrInput);

  // ok===false is the CONTENT of a successful verification call, not
  // a 4xx. The contract was applied; its result is below.
  return {
    status: 200,
    body: {
      ok: verdict.ok === true,
      reason: verdict.ok === true ? "clr-k5 contract satisfied" : verdict.reason,
      k: clrInput.k ?? null,
      score: typeof clrInput.score === "number" ? clrInput.score : null,
      threshold: CLR_K5_THRESHOLD,
      required_k: CLR_K5_K,
      generated_at: nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerPromotionRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerPromotionRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError(
      "registerPromotionRoutes: server must be a node:http Server",
    );
  }

  const adapters = {
    ...DEFAULT_ADAPTERS,
    ...(opts.adapters && typeof opts.adapters === "object"
      ? opts.adapters
      : {}),
  };

  // Validate adapter shape early — Mom's Law: surface contract violations
  // at startup, not on first request.
  for (const [name, fn] of Object.entries(adapters)) {
    if (typeof fn !== "function") {
      throw new TypeError(
        `registerPromotionRoutes: adapter "${name}" is not a function`,
      );
    }
  }

  const defaultBaseline = opts.defaultBaseline || "stub-baseline";
  const defaultChallenger = opts.defaultChallenger || "stub-challenger";
  if (typeof adapters[defaultBaseline] !== "function") {
    throw new TypeError(
      `registerPromotionRoutes: defaultBaseline "${defaultBaseline}" not in adapters`,
    );
  }
  if (typeof adapters[defaultChallenger] !== "function") {
    throw new TypeError(
      `registerPromotionRoutes: defaultChallenger "${defaultChallenger}" not in adapters`,
    );
  }

  const cfg = {
    dbDir: opts.dbPath || resolveDefaultStoreDir(),
    fluxRoot: opts.fluxRoot || resolveDefaultFluxRoot(),
    adapters,
    defaultBaseline,
    defaultChallenger,
    probePackFactory:
      typeof opts.probePackFactory === "function"
        ? opts.probePackFactory
        : null,
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

    // Fast-path filter: not our namespace.
    if (
      !pathName.startsWith("/v1/promotion/") &&
      !pathName.startsWith("/v1/bakeoff/") &&
      !pathName.startsWith("/v1/clr/")
    ) {
      return;
    }

    const route = matchRoute(method, pathName);
    if (!route) return; // not a route we own — let main handler 404

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
      if (route.name === "decide") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(
            res,
            err.message || "bad request body",
            400,
            "invalid_request_body",
          );
        }
        const { status, body } = await handleDecide(raw, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "bakeoff_run") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(
            res,
            err.message || "bad request body",
            400,
            "invalid_request_body",
          );
        }
        const { status, body } = await handleBakeoffRun(raw, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "bakeoff_get") {
        const { status, body } = await handleBakeoffGet(route.runId, cfg);
        return jsonResponse(res, body, status);
      }

      if (route.name === "clr_verify") {
        let raw;
        try {
          raw = await readJsonBody(req);
        } catch (err) {
          return errorResponse(
            res,
            err.message || "bad request body",
            400,
            "invalid_request_body",
          );
        }
        const { status, body } = await handleClrVerify(raw, cfg);
        return jsonResponse(res, body, status);
      }

      // unreachable
      return errorResponse(
        res,
        "unreachable router state",
        500,
        "promotion_internal_error",
      );
    } catch (err) {
      cfg.log(
        `[promotion] handler error on ${method} ${pathName}: ${err.message}`,
      );
      return errorResponse(
        res,
        err.message || "promotion internal error",
        500,
        "promotion_internal_error",
      );
    }
  });

  return {
    cfg,
    routes: [
      { method: "POST", path: PROMOTION_DECIDE_PATH },
      { method: "POST", path: BAKEOFF_RUN_PATH },
      { method: "GET", path: `${BAKEOFF_GET_PREFIX}:id` },
      { method: "POST", path: CLR_VERIFY_PATH },
    ],
  };
}

// Re-export handlers + helpers for direct wiring and unit tests.
export const __promotionInternals = Object.freeze({
  matchRoute,
  handleDecide,
  handleBakeoffRun,
  handleBakeoffGet,
  handleClrVerify,
  sha256,
  bakeoffStorePath,
  persistBakeoff,
  loadBakeoff,
  STUB_BASELINE_TEXT,
  STUB_CHALLENGER_TEXT,
  DEFAULT_ADAPTERS,
  BAKEOFF_ID_RE,
});

// Re-export doctrine constants so callers and tests anchor on a single source.
export {
  BAKEOFF_DIMENSIONS,
  CLR_K5_K,
  CLR_K5_THRESHOLD,
  verifyCLRK5,
  verifyReceipt,
  evaluateBakeoff,
};
