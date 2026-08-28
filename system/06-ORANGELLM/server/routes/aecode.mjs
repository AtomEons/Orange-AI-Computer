// AE Orange5 OrangeLLM gateway — AECode + AELang routes.
//
// The ONLY public door for the AECode source contract and the AELang route
// language. Every call here is loopback-only (the boundary at 127.0.0.1:1337
// already enforced that). These handlers compose:
//
//   POST /v1/aecode/compile       markdown AECode source     → mission contract bundle
//   POST /v1/aecode/mission/start bundle | source            → mission_id + initial state
//   GET  /v1/aecode/mission/:id   mission_id                 → state snapshot + receipts
//   POST /v1/aelang/route         AELang-High intent (text)  → ORANGEBOX Route Packet(s)
//
// Doctrine (Atom McCree, AECode + AELang v0.1):
//   - AECode = canonical source contract. Pipeline (route-first, receipt-first):
//       intent → AECode Source → mission contract → target plan → patch →
//       gauntlet → receipt → approval
//   - AECode Source has 13 sections (identity, product_intent, operator_laws,
//     scope, target_matrix, artifact_contracts, data_contracts, behavior_graph,
//     permissions, model_roles, gauntlets, receipts, rollback). Schema lives at
//     09-SCHEMAS/aecode-final-format.schema.json.
//   - AELang v0.1 is two-tier:
//       AELang-High (human-readable intent)
//         → AELang-Core (machine-parseable, schema aelang.core.packet.v0)
//         → ORANGEBOX Route Packet (FATCAT-shaped dispatch envelope)
//   - Operates under AE0-AE14 departments. Route-first, receipt-first,
//     visual-first. Mom is watching: no fake greens, no silent fallback, every
//     failure mode names itself.
//
// Architecture notes:
//   - The heavy lifting (parser + AST + validator + compiler + emitter +
//     route-packet builder + mission runner) already exists under
//     04-CONTROL-PLANE/aecode and 04-CONTROL-PLANE/aelang. This file ONLY
//     wires those into the gateway HTTP surface. It does not duplicate the
//     compiler logic and it does not "fix" upstream schema breaks.
//   - Mission state is held in a process-local registry. Receipts are
//     hash-chained to disk by the runner (10-RECEIPTS/orange5-build/<id>/).
//     Restarting the gateway loses the in-memory registry; the receipt chain
//     on disk is the source of truth for audit.
//   - The gateway never auto-runs a mission to completion unless the caller
//     explicitly sets `run: true`. Default is "compile + return initial
//     state". `dry_run: true` runs the mission with a stub Hermes that emits
//     noop actions, so smoke tests can exercise the pipeline without the
//     Hermes daemon.
//
// Honest gaps:
//   - applyPatch only mutates files under mission.allowed_paths. Out-of-scope
//     proposed patches surface as `blockers: [{ code: "scope_violation" }]`.
//   - Receipts are append-only on disk. Re-running a mission_id appends a new
//     chain; it does not overwrite prior receipts.
//   - Markdown input is parsed by `parseAECode` (parser.mjs). Compiler then
//     re-canonicalises through `compile(parse(aecode))`. Both source_hash
//     fingerprints (parser-side and compiler-side) are returned so callers
//     can pin receipts to either layer.

// Path math: this file lives at
//   <ORANGE5_ROOT>/06-ORANGELLM/server/routes/aecode.mjs
// so "../../../04-CONTROL-PLANE/..." resolves to <ORANGE5_ROOT>/04-CONTROL-PLANE/...
import {
  parseAECode,
  validateAECode,
  AECODE_SECTIONS,
} from "../../../04-CONTROL-PLANE/aecode/parser.mjs";

import {
  parse as compilerParse,
  validate as compilerValidate,
  compile as compilerCompile,
  ParseError as CompilerParseError,
  ValidationError as CompilerValidationError,
} from "../../../04-CONTROL-PLANE/aecode/compiler.mjs";

import {
  initialState,
  runMission,
  verifyReceiptChain,
  MISSION_STATUS,
} from "../../../04-CONTROL-PLANE/aecode/mission-runner.mjs";

import { parseHigh } from "../../../04-CONTROL-PLANE/aelang/high-parser.mjs";
import { emitCore } from "../../../04-CONTROL-PLANE/aelang/core-emitter.mjs";
import { buildRoutePacketsFromEmit } from "../../../04-CONTROL-PLANE/aelang/route-packet.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1. Constants + in-memory mission registry.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES_VERSION = "orange5.aecode-routes.v0.1.0";
// compiler.mjs makeId emits "ms_<12-hex>" or "ms_deterministic" in test mode.
// Accept either underscore or hyphen separators, alnum tail, length-bounded.
const MISSION_ID_RE = /^ms[_-][a-z0-9_-]{4,128}$/i;

/**
 * Mission registry. Key = mission_id. Value = {
 *   status, bundle, state, receipts, created_at, updated_at, source_hash,
 *   compiler_source_hash, mode ("queued" | "running" | "dry_run" | "done" | "blocked" | "rolled_back" | "aborted"),
 *   error?: { code, message }
 * }
 *
 * Process-local. The receipt chain on disk is the durable audit trail.
 */
const REGISTRY = new Map();

// Soft cap to keep an unbounded gateway from leaking memory in long sessions.
const REGISTRY_SOFT_CAP = 256;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2. Helpers — input parsing, error shaping, stub Hermes for dry-run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce HTTP body's `source` field into a string suitable for parseAECode.
 * Accepts:
 *   - body.source = "markdown string"
 *   - body.source = { ... 13-section object ... }  (JSON form)
 *   - body.source = base64 string when body.source_encoding === "base64"
 */
function _coerceSource(body) {
  if (body == null) {
    throw new RouteError("source field required", 400, "source_required");
  }
  const enc = body.source_encoding;
  let src = body.source;

  if (src === undefined || src === null) {
    throw new RouteError("source field required", 400, "source_required");
  }

  if (typeof src === "object") {
    // Caller passed the 13-section JSON object directly. Compiler accepts that.
    return { kind: "object", value: src };
  }

  if (typeof src !== "string") {
    throw new RouteError(
      `source must be string or object, got ${typeof src}`,
      400, "source_type",
    );
  }

  if (enc === "base64") {
    try {
      src = Buffer.from(src, "base64").toString("utf8");
    } catch (e) {
      throw new RouteError(`base64 decode failed: ${e.message}`, 400, "source_b64");
    }
  }

  if (src.trim() === "") {
    throw new RouteError("source is empty", 400, "source_empty");
  }
  return { kind: "string", value: src };
}

/**
 * Run the markdown source through parseAECode (Markdown + YAML front matter
 * aware) then hand the 13-section object to the compiler. Returns:
 *   {
 *     aecode,                 // parser-side 13-section object
 *     parserErrors,           // parser diagnostics
 *     parserValidation,       // soft schema check from parser.mjs
 *     compilerAst,            // compiler-side AST (canonical)
 *     bundle,                 // compiler output (mission contract + plans)
 *   }
 *
 * The parser layer is markdown-friendly; the compiler layer is strict and
 * emits the canonical mission/order/patch/gauntlet/receipt plans.
 */
function _compileFromSource(input) {
  // 1) Parser pass — accepts markdown OR a 13-section object (passthrough).
  let aecode;
  let parserErrors = [];
  let parserValidation = { ok: true, errors: [] };

  if (input.kind === "object") {
    aecode = input.value;
    parserValidation = validateAECode(aecode);
  } else {
    const p = parseAECode(input.value, {});
    parserErrors = p.errors;
    if (!p.ok) {
      const first = p.errors.find(e => e.severity === "error");
      throw new RouteError(
        `AECode parse failed: ${first?.code || "unknown"} ${first?.message || ""}`.trim(),
        422, "parse_failed", { errors: p.errors },
      );
    }
    aecode = p.ast.aecode;
    parserValidation = p.validate();
  }

  if (!parserValidation.ok) {
    throw new RouteError(
      "AECode validation failed",
      422, "validation_failed",
      { errors: parserValidation.errors },
    );
  }

  // 2) Compiler pass — re-canonicalises the 13 sections and emits the bundle.
  let compilerAst;
  try {
    compilerAst = compilerParse(aecode);
  } catch (e) {
    if (e instanceof CompilerParseError) {
      throw new RouteError(`compiler parse: ${e.message}`, 422, "compile_parse_failed");
    }
    throw e;
  }

  const v = compilerValidate(compilerAst);
  if (!v.ok) {
    throw new RouteError(
      "compiler validation failed",
      422, "compile_validation_failed",
      { errors: v.errors.map(err => ({ code: err.code, message: err.message })) },
    );
  }

  let bundle;
  try {
    bundle = compilerCompile(compilerAst);
  } catch (e) {
    if (e instanceof CompilerValidationError) {
      throw new RouteError(
        `compile failed: ${e.message}`,
        422, "compile_failed",
        { errors: e.errors || [] },
      );
    }
    throw e;
  }

  return {
    aecode,
    parserErrors,
    parserValidation,
    compilerAst,
    bundle,
  };
}

/**
 * Stub Hermes used by `dry_run: true` mission starts. Always proposes a no-op
 * action so the runner can walk the patch plan, mint receipts, and reach DONE
 * without contacting the Hermes daemon. This is for pipeline-shape tests; it
 * is NOT a substitute for a real Hermes lease in production.
 */
function _stubHermes() {
  return {
    async action({ step }) {
      return {
        action: {
          kind: "noop",
          step_id: step.step_id,
          reason: "dry_run_stub",
          changes: [],
        },
        proof: { stub: true, source: "aecode-route-dry-run" },
      };
    },
  };
}

/**
 * Project a registry entry into the public state-snapshot shape returned by
 * GET /v1/aecode/mission/:id. Strips bundle internals that are not safe to
 * expose verbatim (Order body is large; receipts on disk are the truth).
 */
function _projectState(entry) {
  return {
    mission_id: entry.mission_id,
    mode: entry.mode,
    status: entry.state?.status ?? entry.status ?? null,
    cursor: entry.state?.cursor ?? null,
    patch_step_count: entry.bundle?.patchPlan?.steps?.length ?? 0,
    gauntlet_step_count: entry.bundle?.gauntletSteps?.length ?? 0,
    iterations: entry.state?.iterations ?? 0,
    blockers: entry.state?.blockers ?? [],
    aborted_reason: entry.state?.aborted_reason ?? null,
    receipt_paths: entry.state?.receipt_paths ?? [],
    receipt_chain_index: entry.state?.receipt_chain_index ?? 0,
    prior_receipt_hash: entry.state?.prior_receipt_hash ?? null,
    mission: entry.bundle?.mission ?? null,
    receipt_plan: entry.bundle?.receiptPlan ?? null,
    rollback_plan: entry.bundle?.rollbackPlan ?? null,
    compiler: entry.bundle?.compiler ?? null,
    source_hash: entry.source_hash,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    error: entry.error ?? null,
  };
}

class RouteError extends Error {
  constructor(message, status, code, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function _toErrorBody(err) {
  if (err instanceof RouteError) {
    return {
      _ae_http_status: err.status,
      error: {
        type: "aecode_route_error",
        code: err.code,
        message: err.message,
        ...(err.extra || {}),
      },
    };
  }
  return {
    _ae_http_status: 500,
    error: {
      type: "internal_error",
      code: "unhandled",
      message: err?.message || String(err),
    },
  };
}

function _evictIfFull() {
  if (REGISTRY.size <= REGISTRY_SOFT_CAP) return;
  // Drop the oldest non-running entry.
  let oldestId = null;
  let oldestT = Infinity;
  for (const [id, e] of REGISTRY) {
    if (e.mode === "running") continue;
    if (e.updated_at < oldestT) {
      oldestT = e.updated_at;
      oldestId = id;
    }
  }
  if (oldestId) REGISTRY.delete(oldestId);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3. Handlers — POST /v1/aecode/compile
//
// Input:
//   {
//     "source": "<markdown>" | { ... 13-section object ... },
//     "source_encoding": "utf8" | "base64"   // optional, default utf8
//   }
//
// Output (200):
//   {
//     "ok": true,
//     "mission_id": "ms-...",
//     "mission": { ... mission contract ... },
//     "order": { ... orange.order.v1 ... },
//     "target_plan": [...],
//     "patch_plan": { ... },
//     "gauntlet_steps": [...],
//     "receipt_plan": { ... },
//     "rollback_plan": { ... },
//     "aelang_core": { ... } | null,
//     "compiler": { version, source_hash, compiled_at },
//     "parser_diagnostics": [...]
//   }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAECodeCompile(body) {
  try {
    const src = _coerceSource(body);
    const { aecode, parserErrors, bundle } = _compileFromSource(src);

    return {
      _ae_http_status: 200,
      ok: true,
      mission_id: bundle.mission.mission_id,
      mission: bundle.mission,
      order: bundle.order,
      target_plan: bundle.targetPlan,
      patch_plan: bundle.patchPlan,
      gauntlet_steps: bundle.gauntletSteps,
      receipt_plan: bundle.receiptPlan,
      rollback_plan: bundle.rollbackPlan,
      aelang_core: bundle.aelangCore,
      compiler: bundle.compiler,
      parser: {
        sections: AECODE_SECTIONS,
        diagnostics: parserErrors,
        product_intent_preview: typeof aecode.product_intent === "string"
          ? aecode.product_intent.slice(0, 240)
          : null,
      },
      routes_version: ROUTES_VERSION,
    };
  } catch (e) {
    return _toErrorBody(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4. POST /v1/aecode/mission/start
//
// Input (one of):
//   { "source": "...", "source_encoding": "...", "run": false, "dry_run": false,
//     "max_steps": 32, "receipt_dir": "..." }
//   { "bundle": { ... pre-compiled bundle from /compile ... }, ... }
//
// Behavior:
//   - Compile (or accept compiled bundle).
//   - Register mission in process registry.
//   - If `run` is true → run to completion (uses Hermes baseUrl from
//     opts.hermes_base_url or defaults). Returns final state.
//   - If `dry_run` is true → run with stub Hermes (no-op every step). Returns
//     final state and the receipt chain that was minted.
//   - Otherwise → return queued initial state. Caller polls GET .../:id.
//
// Output (200):
//   {
//     "ok": true,
//     "mission_id": "ms-...",
//     "mode": "queued" | "dry_run" | "done" | "blocked" | ...,
//     "state": { ... projected state ... },
//     "verify_chain": { ok, length, tip } | null    // only on dry_run/run
//   }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAECodeMissionStart(body) {
  try {
    if (body == null || typeof body !== "object") {
      throw new RouteError("body required", 400, "body_required");
    }

    // 1) Either compile fresh from source, or accept an already-compiled bundle.
    let bundle;
    let source_hash = null;
    if (body.bundle && typeof body.bundle === "object") {
      bundle = body.bundle;
      if (!bundle.mission || !bundle.patchPlan) {
        throw new RouteError(
          "bundle must include mission and patchPlan",
          400, "bad_bundle",
        );
      }
      source_hash = bundle.compiler?.source_hash || null;
    } else {
      const src = _coerceSource(body);
      const compiled = _compileFromSource(src);
      bundle = compiled.bundle;
      source_hash = bundle.compiler.source_hash;
    }

    const mission_id = bundle.mission.mission_id;
    if (!MISSION_ID_RE.test(mission_id)) {
      throw new RouteError(
        `invalid mission_id "${mission_id}" — must match ${MISSION_ID_RE}`,
        422, "bad_mission_id",
      );
    }

    const now = Date.now();
    const entry = {
      mission_id,
      bundle,
      state: initialState(bundle, { maxSteps: body.max_steps }),
      source_hash,
      compiler_source_hash: bundle.compiler?.source_hash || null,
      created_at: now,
      updated_at: now,
      mode: "queued",
      error: null,
    };

    REGISTRY.set(mission_id, entry);
    _evictIfFull();

    // 2) Optional immediate execution.
    let verify_chain = null;
    if (body.dry_run === true) {
      entry.mode = "running";
      try {
        const result = await runMission(bundle, {
          hermes: _stubHermes(),
          receiptDir: body.receipt_dir,
          maxSteps: body.max_steps,
          dryRun: true,
        });
        entry.state = result.state;
        entry.mode = result.status === MISSION_STATUS.DONE ? "done" : result.status;
        if (result.receipts && result.receipts.length > 0) {
          verify_chain = verifyReceiptChain(result.receipts);
        }
      } catch (e) {
        entry.mode = "aborted";
        entry.error = { code: "dry_run_runner_fail", message: e.message };
      } finally {
        entry.updated_at = Date.now();
      }
    } else if (body.run === true) {
      // Live run — needs Hermes reachable. We do NOT swallow Hermes errors
      // here; they surface to the caller as 502.
      entry.mode = "running";
      try {
        const result = await runMission(bundle, {
          hermesBaseUrl: body.hermes_base_url || "http://127.0.0.1:7430",
          receiptDir: body.receipt_dir,
          maxSteps: body.max_steps,
        });
        entry.state = result.state;
        entry.mode = result.status === MISSION_STATUS.DONE ? "done" : result.status;
        if (result.receipts && result.receipts.length > 0) {
          verify_chain = verifyReceiptChain(result.receipts);
        }
      } catch (e) {
        entry.mode = "aborted";
        entry.error = { code: "live_run_runner_fail", message: e.message };
        entry.updated_at = Date.now();
        return _toErrorBody(new RouteError(
          `mission runner failed: ${e.message}`,
          502, "runner_failed",
          { mission_id },
        ));
      } finally {
        entry.updated_at = Date.now();
      }
    }

    return {
      _ae_http_status: 200,
      ok: true,
      mission_id,
      mode: entry.mode,
      state: _projectState(entry),
      verify_chain,
      routes_version: ROUTES_VERSION,
    };
  } catch (e) {
    return _toErrorBody(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5. GET /v1/aecode/mission/:id
//
// Returns a state snapshot. 404 if unknown mission_id.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAECodeMissionGet(missionId) {
  try {
    if (typeof missionId !== "string" || missionId.length === 0) {
      throw new RouteError("mission_id required", 400, "id_required");
    }
    const entry = REGISTRY.get(missionId);
    if (!entry) {
      throw new RouteError(`unknown mission_id "${missionId}"`, 404, "not_found");
    }
    // Re-verify chain on read if there are receipts. Cheap, deterministic.
    let verify_chain = null;
    const paths = entry.state?.receipt_paths || [];
    if (paths.length > 0) {
      try { verify_chain = verifyReceiptChain(paths); }
      catch (e) { verify_chain = { ok: false, reason: "verify_threw", detail: e.message }; }
    }
    return {
      _ae_http_status: 200,
      ok: true,
      mission_id: entry.mission_id,
      state: _projectState(entry),
      verify_chain,
      routes_version: ROUTES_VERSION,
    };
  } catch (e) {
    return _toErrorBody(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6. POST /v1/aelang/route
//
// Input:
//   {
//     "intent":      "<AELang-High text>",      // required
//     "origin":      { ... DialOptions ... },   // optional
//     "correlation_id": "...",                  // optional
//     "session_id":     "...",                  // optional
//     "trace_headers":  { ... }                 // optional
//   }
//
// Output (200):
//   {
//     "ok": true,
//     "intent":     "...",
//     "high_ir":    { ... aelang.high.ir.v0 ... },
//     "core":       [ ... aelang.core.packet.v0 ... ],
//     "route":      [ ... orangebox.route.packet.v0 ... ],
//     "composition": "parallel" | "sequence",
//     "diagnostics": { high_warnings, core_warnings, route_warnings }
//   }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAELangRoute(body) {
  try {
    if (body == null || typeof body !== "object") {
      throw new RouteError("body required", 400, "body_required");
    }
    const intent = body.intent;
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new RouteError("intent field required (string)", 400, "intent_required");
    }

    // 1) AELang-High → IR
    const high = parseHigh(intent);
    if (!high.ok) {
      throw new RouteError(
        "AELang-High parse failed",
        422, "high_parse_failed",
        { errors: high.errors },
      );
    }

    // 2) IR → Core packets
    const core = emitCore(high.ir, { now: body.now });
    if (!core.ok) {
      throw new RouteError(
        "AELang-Core emission failed",
        422, "core_emit_failed",
        { errors: core.errors },
      );
    }

    // 3) Core → Route packets (FATCAT envelopes)
    const route = buildRoutePacketsFromEmit(core, {
      correlation_id: body.correlation_id,
      session_id: body.session_id,
      trace_headers: body.trace_headers,
      ...(body.origin || {}),
    });
    if (!route.ok) {
      throw new RouteError(
        "ORANGEBOX route packet build failed",
        422, "route_build_failed",
        { errors: route.errors },
      );
    }

    return {
      _ae_http_status: 200,
      ok: true,
      intent,
      high_ir: high.ir,
      core: core.packets,
      route: route.packets,
      composition: high.ir.composition || "parallel",
      diagnostics: {
        high_warnings: high.warnings,
        core_warnings: core.warnings,
        route_warnings: route.warnings,
      },
      routes_version: ROUTES_VERSION,
    };
  } catch (e) {
    return _toErrorBody(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7. Path matcher — used by 06-ORANGELLM/server/index.mjs to wire
// these routes alongside the existing /v1/chat/completions surface.
//
// Returns null when no route matches. Otherwise: { handler, args } where the
// caller is responsible for reading the body (or extracting the path param)
// and invoking `await handler(...args)`.
// ─────────────────────────────────────────────────────────────────────────────

const MISSION_GET_RE = /^\/v1\/aecode\/mission\/([A-Za-z0-9_-]+)$/;

export function matchAECodeRoute({ method, path }) {
  if (method === "POST" && path === "/v1/aecode/compile") {
    return { kind: "body", handler: handleAECodeCompile };
  }
  if (method === "POST" && path === "/v1/aecode/mission/start") {
    return { kind: "body", handler: handleAECodeMissionStart };
  }
  if (method === "GET") {
    const m = MISSION_GET_RE.exec(path);
    if (m) {
      const missionId = m[1];
      return {
        kind: "no_body",
        handler: () => handleAECodeMissionGet(missionId),
      };
    }
  }
  if (method === "POST" && path === "/v1/aelang/route") {
    return { kind: "body", handler: handleAELangRoute };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8. Internal handles for tests + smoke harness.
// ─────────────────────────────────────────────────────────────────────────────

export const __internal = Object.freeze({
  REGISTRY,
  ROUTES_VERSION,
  _coerceSource,
  _compileFromSource,
  _stubHermes,
  _projectState,
  RouteError,
});
