// route-packet.mjs — AELang-Core → ORANGEBOX Route Packet (FATCAT dial plan).
//
// Pipeline position:
//
//   AELang-High           (operator natural-language intent)
//        ↓ high-parser.mjs
//   AELang-High IR
//        ↓ core-emitter.mjs
//   AELang-Core Packet                — typed, machine-parseable
//        ↓ route-packet.mjs           ← YOU ARE HERE
//   ORANGEBOX Route Packet            — dispatch envelope keyed for FATCAT
//        ↓ dispatcher (out of scope)
//   Department extension (AE0..AE14)
//
// ─────────────────────────────────────────────────────────────────────────────
// FATCAT dial plan
// ─────────────────────────────────────────────────────────────────────────────
//
// FATCAT is the AtomEons phone-switch metaphor for routing a Core packet to
// an AE department "extension" with dispatch headers a switch needs to do
// its job. The mnemonic spells the six fields every Route Packet carries:
//
//   F  — From               (origin/operator lane; who placed the call)
//   A  — Authority          (risk_level + approval gates required)
//   T  — To                 (terminal department extension, e.g. "x06" for AE6)
//   C  — Class of service   (lane priority + composition; how the switch trunks it)
//   A  — Artifacts          (target lattice — what the call is about)
//   T  — Timing             (deadline + dial timestamps + ttl)
//
// Each Core packet becomes exactly ONE Route Packet. Multi-subject Core packets
// (scope = "set" or "universal") are NOT exploded at this layer — the route
// envelope carries `class_of_service.fan_out` so the dispatcher (FATCAT switch)
// can decide whether to broadcast or sequence. The route layer is the
// authoritative bridge between language (Core) and the switch (dispatcher).
//
// ─────────────────────────────────────────────────────────────────────────────
// Extension numbering — single source of truth
// ─────────────────────────────────────────────────────────────────────────────
//
// AE0..AE14 → x00..x14. The "x" prefix denotes an extension (PBX convention).
// We mirror DEPARTMENTS order from core-emitter.mjs. The map is built at module
// load and the table is frozen — no string formatting at dispatch time.
//
// ─────────────────────────────────────────────────────────────────────────────
// Real compiler code. No silent fall-back. Same Core packet + same dial options
// → byte-identical Route Packet. Mom's Law: every branch earns its place.

import {
  CORE_SCHEMA,
  CORE_VERBS,
  DEPARTMENTS,
  RISK_LEVELS,
  validateCorePacket,
} from "./core-emitter.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Constants & FATCAT tables.
// ─────────────────────────────────────────────────────────────────────────────

/** Route Packet schema string. Bumped on any breaking envelope change. */
export const ROUTE_SCHEMA = "orangebox.route.packet.v0";

/** PBX prefix for AE department extensions. */
export const EXTENSION_PREFIX = "x";

/**
 * Department → extension number, derived from DEPARTMENTS index.
 * AE0_FACTORY → "x00", AE6_CODE → "x06", AE14_BENCH → "x14".
 */
export const DEPARTMENT_EXTENSIONS = Object.freeze(
  DEPARTMENTS.reduce((acc, dept, i) => {
    acc[dept] = `${EXTENSION_PREFIX}${String(i).padStart(2, "0")}`;
    return acc;
  }, /** @type {Object<string,string>} */ ({})),
);

/**
 * Risk-level → dispatch priority. Higher number = switch should preempt other
 * traffic. Mirrors RISK_LEVELS ordinal position but exposed as an explicit
 * number so the dispatcher does not have to re-derive it.
 */
export const PRIORITY_BY_RISK = Object.freeze({
  read_only:   1,
  low:         2,
  medium:      3,
  high:        4,
  production:  5,
  destructive: 6,
});

/**
 * Risk-level → approval gates the dispatcher MUST satisfy before placing the
 * call. Conservative: anything ≥ "production" requires Human Final Stop.
 * Anything ≥ "high" requires Review. These are gate IDs the dispatcher
 * understands; this layer does not run them.
 */
export const GATES_BY_RISK = Object.freeze({
  read_only:   [],
  low:         [],
  medium:      ["gauntlet.unit"],
  high:        ["gauntlet.unit", "gauntlet.security", "review.AE7"],
  production:  ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop"],
  destructive: ["gauntlet.unit", "gauntlet.security", "review.AE7", "human_final_stop", "rollback.staged"],
});

/**
 * Composition → trunking strategy the FATCAT switch will use.
 *   solo     : single line, no trunking
 *   sequence : serial trunk, one extension at a time
 *   parallel : broadcast trunk, all extensions concurrently
 */
export const TRUNKING_BY_COMPOSITION = Object.freeze({
  solo:     "single_line",
  sequence: "serial_trunk",
  parallel: "broadcast_trunk",
});

/** Allowed origin lanes. "operator" is the human Atom; "scheduler" is cron-like. */
export const ORIGIN_LANES = Object.freeze([
  "operator", "scheduler", "agent", "system", "test",
]);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Public API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DialOptions
 * @property {string} [from]              - origin lane; default "operator"
 * @property {string} [operator_id]       - human/agent id; default "atom"
 * @property {string} [now]               - ISO timestamp for dial; default Date.now()
 * @property {number} [ttl_seconds]       - life of the packet on the wire; default 900
 * @property {string} [correlation_id]    - upstream correlation id; default packet_id
 * @property {string} [session_id]        - dispatcher session id; default null
 * @property {Object<string,string>} [trace_headers] - extra headers to merge into dispatch_meta
 */

/**
 * @typedef {Object} RoutePacket
 * @property {string} schema              - ROUTE_SCHEMA
 * @property {string} route_id            - "rp-<core packet_id>"
 * @property {string} core_schema         - CORE_SCHEMA (echoed for switch sanity)
 * @property {string} core_packet_id      - the wrapped Core packet's id
 * @property {From} from
 * @property {Authority} authority
 * @property {To} to
 * @property {ClassOfService} class_of_service
 * @property {Artifacts} artifacts
 * @property {Timing} timing
 * @property {Headers} headers            - flattened FATCAT dispatch headers (string→string)
 * @property {DispatchMeta} dispatch_meta - structured metadata for dispatcher state
 * @property {import("./core-emitter.mjs").CorePacket} core - the wrapped Core packet
 *
 * @typedef {Object} From
 * @property {string} lane                - ORIGIN_LANES member
 * @property {string} operator_id
 *
 * @typedef {Object} Authority
 * @property {string} risk_level
 * @property {number} priority            - PRIORITY_BY_RISK[risk_level]
 * @property {string[]} required_gates
 * @property {boolean} requires_human_final_stop
 *
 * @typedef {Object} To
 * @property {string} department          - terminal department (last in path)
 * @property {string} extension           - "x06" etc.
 * @property {string[]} path              - full path of departments to traverse
 * @property {string[]} extensions        - parallel array of extensions for path
 *
 * @typedef {Object} ClassOfService
 * @property {string} composition         - "solo" | "sequence" | "parallel"
 * @property {string} trunking            - TRUNKING_BY_COMPOSITION[composition]
 * @property {number} fan_out
 *
 * @typedef {Object} Artifacts
 * @property {string} primary
 * @property {Array<{name:string,count:number|null,universal:boolean}>} ordinals
 * @property {string[]} collateral
 * @property {string} scope
 * @property {string|null} version
 * @property {string|null} target_state
 * @property {string|null} beneficiary
 * @property {string[]} tools
 *
 * @typedef {Object} Timing
 * @property {string} dialed_at_iso
 * @property {number} ttl_seconds
 * @property {string} expires_at_iso
 * @property {import("./core-emitter.mjs").DeadlineResolved|null} deadline
 *
 * @typedef {Object} Headers
 * @property {string} [X-AE-Route-Schema]
 * @property {string} [X-AE-From]
 * @property {string} [X-AE-Operator]
 * @property {string} [X-AE-Authority-Risk]
 * @property {string} [X-AE-Authority-Priority]
 * @property {string} [X-AE-To-Extension]
 * @property {string} [X-AE-To-Department]
 * @property {string} [X-AE-Class-Composition]
 * @property {string} [X-AE-Class-Trunking]
 * @property {string} [X-AE-Class-FanOut]
 * @property {string} [X-AE-Artifact-Primary]
 * @property {string} [X-AE-Artifact-Scope]
 * @property {string} [X-AE-Timing-Expires]
 * @property {string} [X-AE-Timing-Deadline]
 * @property {string} [X-AE-Correlation-Id]
 * @property {string} [X-AE-Session-Id]
 * @property {string} [X-AE-Action-Verb]
 *
 * @typedef {Object} DispatchMeta
 * @property {string} correlation_id
 * @property {string|null} session_id
 * @property {string} action_verb
 * @property {string} source_intent
 * @property {Object<string,string>} trace
 */

/**
 * @typedef {Object} BuildResult
 * @property {boolean} ok
 * @property {RoutePacket|null} packet
 * @property {Array<{code:string,message:string}>} errors
 * @property {Array<{code:string,message:string}>} warnings
 */

/**
 * Wrap a single AELang-Core packet in an ORANGEBOX Route Packet.
 *
 * @param {import("./core-emitter.mjs").CorePacket} corePacket
 * @param {DialOptions} [opts]
 * @returns {BuildResult}
 */
export function buildRoutePacket(corePacket, opts = {}) {
  const errors = [];
  const warnings = [];

  // 1) Gate — refuse to wrap an invalid Core packet. The route layer is not
  //    allowed to "fix" an upstream schema break; that would let bad packets
  //    enter the switch under a route id and lose the offending lineage.
  const v = validateCorePacket(corePacket);
  if (!v.ok) {
    for (const e of v.errors) errors.push({ code: e.code, message: e.message });
    return { ok: false, packet: null, errors, warnings };
  }

  // 2) Origin (F).
  const from = _buildFrom(opts, warnings);

  // 3) Authority (A).
  const authority = _buildAuthority(corePacket);

  // 4) Destination (T).
  const to = _buildTo(corePacket, warnings);
  if (!to) {
    errors.push({ code: "E_NO_DESTINATION", message: "lane_route.department did not resolve to an extension" });
    return { ok: false, packet: null, errors, warnings };
  }

  // 5) Class of service (C).
  const class_of_service = _buildClassOfService(corePacket, warnings);

  // 6) Artifacts (A).
  const artifacts = _buildArtifacts(corePacket);

  // 7) Timing (T).
  const timing = _buildTiming(corePacket, opts, warnings);

  // 8) Headers — flattened FATCAT dispatch headers for transports that only
  //    speak string→string maps (HTTP, log lines, span attributes).
  const route_id = `rp-${corePacket.packet_id}`;
  const correlation_id = opts.correlation_id || corePacket.packet_id;
  const session_id = opts.session_id || null;

  const headers = _buildHeaders({
    route_id,
    from,
    authority,
    to,
    class_of_service,
    artifacts,
    timing,
    correlation_id,
    session_id,
    action_verb: corePacket.action_verb,
  });

  const dispatch_meta = {
    correlation_id,
    session_id,
    action_verb: corePacket.action_verb,
    source_intent: corePacket.source_intent,
    trace: { ...(opts.trace_headers || {}) },
  };

  /** @type {RoutePacket} */
  const packet = {
    schema: ROUTE_SCHEMA,
    route_id,
    core_schema: CORE_SCHEMA,
    core_packet_id: corePacket.packet_id,
    from,
    authority,
    to,
    class_of_service,
    artifacts,
    timing,
    headers,
    dispatch_meta,
    core: corePacket,
  };

  return { ok: errors.length === 0, packet, errors, warnings };
}

/**
 * Convenience: wrap an entire emitCore() result. Returns one Route Packet per
 * Core packet, in the same order.
 *
 * @param {import("./core-emitter.mjs").EmitResult} emitResult
 * @param {DialOptions} [opts]
 * @returns {{ ok: boolean, packets: RoutePacket[], errors: Array<{code:string,message:string,clause_index?:number}>, warnings: Array<{code:string,message:string}> }}
 */
export function buildRoutePacketsFromEmit(emitResult, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!emitResult || !Array.isArray(emitResult.packets)) {
    return {
      ok: false,
      packets: [],
      errors: [{ code: "E_BAD_EMIT", message: "emitResult.packets must be array" }],
      warnings,
    };
  }

  if (emitResult.ok === false) {
    return {
      ok: false,
      packets: [],
      errors: [{ code: "E_EMIT_NOT_OK", message: "refuse to wrap a non-ok emit result" }],
      warnings,
    };
  }

  const packets = [];
  emitResult.packets.forEach((core, idx) => {
    const r = buildRoutePacket(core, opts);
    if (!r.ok) {
      for (const e of r.errors) errors.push({ ...e, clause_index: idx });
      return;
    }
    for (const w of r.warnings) warnings.push(w);
    packets.push(r.packet);
  });

  return { ok: errors.length === 0 && packets.length > 0, packets, errors, warnings };
}

/**
 * Structural validator for a Route Packet. Catches header drift, missing FATCAT
 * fields, illegal enum values. Does NOT re-validate the wrapped Core packet
 * (call validateCorePacket on `pkt.core` if you need that).
 *
 * @param {RoutePacket} pkt
 * @returns {{ ok: boolean, errors: Array<{code:string,message:string,path:string}> }}
 */
export function validateRoutePacket(pkt) {
  const errs = [];

  if (!pkt || typeof pkt !== "object" || Array.isArray(pkt)) {
    return { ok: false, errors: [{ code: "E_ROOT_TYPE", message: "packet must be object", path: "$" }] };
  }
  if (pkt.schema !== ROUTE_SCHEMA) {
    errs.push({ code: "E_SCHEMA", message: `bad schema "${pkt.schema}"`, path: "$.schema" });
  }
  if (pkt.core_schema !== CORE_SCHEMA) {
    errs.push({ code: "E_CORE_SCHEMA", message: `bad core_schema "${pkt.core_schema}"`, path: "$.core_schema" });
  }
  if (typeof pkt.route_id !== "string" || !pkt.route_id.startsWith("rp-")) {
    errs.push({ code: "E_ROUTE_ID", message: "route_id must start with 'rp-'", path: "$.route_id" });
  }
  if (typeof pkt.core_packet_id !== "string" || pkt.core_packet_id.length === 0) {
    errs.push({ code: "E_CORE_PACKET_ID", message: "core_packet_id required", path: "$.core_packet_id" });
  }

  // from
  if (!pkt.from || typeof pkt.from !== "object") {
    errs.push({ code: "E_FROM", message: "from must be object", path: "$.from" });
  } else {
    if (!ORIGIN_LANES.includes(pkt.from.lane)) {
      errs.push({ code: "E_FROM_LANE", message: `unknown from.lane "${pkt.from.lane}"`, path: "$.from.lane" });
    }
    if (typeof pkt.from.operator_id !== "string" || pkt.from.operator_id.length === 0) {
      errs.push({ code: "E_FROM_OPID", message: "from.operator_id required", path: "$.from.operator_id" });
    }
  }

  // authority
  if (!pkt.authority || typeof pkt.authority !== "object") {
    errs.push({ code: "E_AUTHORITY", message: "authority must be object", path: "$.authority" });
  } else {
    if (!RISK_LEVELS.includes(pkt.authority.risk_level)) {
      errs.push({ code: "E_AUTH_RISK", message: `bad authority.risk_level "${pkt.authority.risk_level}"`, path: "$.authority.risk_level" });
    }
    if (!Number.isInteger(pkt.authority.priority) || pkt.authority.priority < 1) {
      errs.push({ code: "E_AUTH_PRIORITY", message: "authority.priority must be ≥1 integer", path: "$.authority.priority" });
    }
    if (!Array.isArray(pkt.authority.required_gates)) {
      errs.push({ code: "E_AUTH_GATES", message: "authority.required_gates must be array", path: "$.authority.required_gates" });
    }
    if (typeof pkt.authority.requires_human_final_stop !== "boolean") {
      errs.push({ code: "E_AUTH_HFS", message: "authority.requires_human_final_stop must be boolean", path: "$.authority.requires_human_final_stop" });
    }
  }

  // to
  if (!pkt.to || typeof pkt.to !== "object") {
    errs.push({ code: "E_TO", message: "to must be object", path: "$.to" });
  } else {
    if (!DEPARTMENTS.includes(pkt.to.department)) {
      errs.push({ code: "E_TO_DEPT", message: `unknown to.department "${pkt.to.department}"`, path: "$.to.department" });
    }
    if (pkt.to.extension !== DEPARTMENT_EXTENSIONS[pkt.to.department]) {
      errs.push({ code: "E_TO_EXT", message: `extension mismatch: expected ${DEPARTMENT_EXTENSIONS[pkt.to.department]}`, path: "$.to.extension" });
    }
    if (!Array.isArray(pkt.to.path) || pkt.to.path.length === 0) {
      errs.push({ code: "E_TO_PATH", message: "to.path must be non-empty array", path: "$.to.path" });
    }
    if (!Array.isArray(pkt.to.extensions) || pkt.to.extensions.length !== (pkt.to.path?.length || 0)) {
      errs.push({ code: "E_TO_EXTS", message: "to.extensions length must equal to.path length", path: "$.to.extensions" });
    }
  }

  // class_of_service
  if (!pkt.class_of_service || typeof pkt.class_of_service !== "object") {
    errs.push({ code: "E_COS", message: "class_of_service must be object", path: "$.class_of_service" });
  } else {
    if (!["solo", "sequence", "parallel"].includes(pkt.class_of_service.composition)) {
      errs.push({ code: "E_COS_COMP", message: `bad composition "${pkt.class_of_service.composition}"`, path: "$.class_of_service.composition" });
    }
    if (pkt.class_of_service.trunking !== TRUNKING_BY_COMPOSITION[pkt.class_of_service.composition]) {
      errs.push({ code: "E_COS_TRUNK", message: "trunking does not match composition", path: "$.class_of_service.trunking" });
    }
    if (!Number.isInteger(pkt.class_of_service.fan_out) || pkt.class_of_service.fan_out < 1) {
      errs.push({ code: "E_COS_FANOUT", message: "fan_out must be ≥1 integer", path: "$.class_of_service.fan_out" });
    }
  }

  // artifacts
  if (!pkt.artifacts || typeof pkt.artifacts !== "object") {
    errs.push({ code: "E_ARTIFACTS", message: "artifacts must be object", path: "$.artifacts" });
  } else if (typeof pkt.artifacts.primary !== "string") {
    errs.push({ code: "E_ART_PRIMARY", message: "artifacts.primary must be string", path: "$.artifacts.primary" });
  }

  // timing
  if (!pkt.timing || typeof pkt.timing !== "object") {
    errs.push({ code: "E_TIMING", message: "timing must be object", path: "$.timing" });
  } else {
    if (typeof pkt.timing.dialed_at_iso !== "string") {
      errs.push({ code: "E_TIMING_DIALED", message: "timing.dialed_at_iso required", path: "$.timing.dialed_at_iso" });
    }
    if (!Number.isInteger(pkt.timing.ttl_seconds) || pkt.timing.ttl_seconds < 1) {
      errs.push({ code: "E_TIMING_TTL", message: "timing.ttl_seconds must be ≥1 integer", path: "$.timing.ttl_seconds" });
    }
    if (typeof pkt.timing.expires_at_iso !== "string") {
      errs.push({ code: "E_TIMING_EXPIRES", message: "timing.expires_at_iso required", path: "$.timing.expires_at_iso" });
    }
  }

  // headers
  if (!pkt.headers || typeof pkt.headers !== "object") {
    errs.push({ code: "E_HEADERS", message: "headers must be object", path: "$.headers" });
  } else {
    const required = [
      "X-AE-Route-Schema",
      "X-AE-From",
      "X-AE-To-Extension",
      "X-AE-Authority-Risk",
      "X-AE-Class-Composition",
      "X-AE-Action-Verb",
      "X-AE-Correlation-Id",
    ];
    for (const h of required) {
      if (typeof pkt.headers[h] !== "string" || pkt.headers[h].length === 0) {
        errs.push({ code: "E_HEADER_MISSING", message: `header ${h} required`, path: `$.headers[${h}]` });
      }
    }
  }

  // wrapped core
  if (!pkt.core || typeof pkt.core !== "object" || pkt.core.schema !== CORE_SCHEMA) {
    errs.push({ code: "E_CORE_REF", message: "core must be a CORE_SCHEMA packet", path: "$.core" });
  }

  return { ok: errs.length === 0, errors: errs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Field builders.
// ─────────────────────────────────────────────────────────────────────────────

function _buildFrom(opts, warnings) {
  let lane = opts.from || "operator";
  if (!ORIGIN_LANES.includes(lane)) {
    warnings.push({ code: "W_UNKNOWN_FROM", message: `unknown from "${lane}", coerced to "operator"` });
    lane = "operator";
  }
  return {
    lane,
    operator_id: opts.operator_id || "atom",
  };
}

function _buildAuthority(core) {
  const risk = core.risk_level;
  const priority = PRIORITY_BY_RISK[risk] || 1;
  const gates = GATES_BY_RISK[risk] || [];
  return {
    risk_level: risk,
    priority,
    required_gates: [...gates],
    requires_human_final_stop: gates.includes("human_final_stop"),
  };
}

function _buildTo(core, warnings) {
  const dept = core.lane_route.department;
  const extension = DEPARTMENT_EXTENSIONS[dept];
  if (!extension) {
    warnings.push({ code: "W_NO_EXTENSION", message: `no extension for "${dept}"` });
    return null;
  }
  const path = [...core.lane_route.path];
  const extensions = path.map(d => DEPARTMENT_EXTENSIONS[d] || EXTENSION_PREFIX + "??");
  // Terminal department is the LAST entry in path (canonical Core convention
  // for ship/promote/deploy where path = [REVIEW, LAUNCH/OPS, dept]).
  const terminal = path[path.length - 1];
  return {
    department: terminal,
    extension: DEPARTMENT_EXTENSIONS[terminal] || extension,
    path,
    extensions,
  };
}

function _buildClassOfService(core, warnings) {
  const composition = core.lane_route.composition;
  const trunking = TRUNKING_BY_COMPOSITION[composition];
  if (!trunking) {
    warnings.push({ code: "W_BAD_COMPOSITION", message: `no trunking for composition "${composition}"` });
  }
  return {
    composition,
    trunking: trunking || "single_line",
    fan_out: core.lane_route.fan_out,
  };
}

function _buildArtifacts(core) {
  const tl = core.target_lattice;
  return {
    primary: tl.primary,
    ordinals: tl.ordinals.map(o => ({ name: o.name, count: o.count, universal: o.universal })),
    collateral: [...tl.collateral],
    scope: tl.scope,
    version: tl.version,
    target_state: tl.target_state,
    beneficiary: tl.beneficiary,
    tools: [...tl.tools],
  };
}

function _buildTiming(core, opts, warnings) {
  const dialed = _coerceISO(opts.now) || new Date().toISOString();
  const ttl = Number.isInteger(opts.ttl_seconds) && opts.ttl_seconds > 0 ? opts.ttl_seconds : 900;
  const expires = new Date(new Date(dialed).getTime() + ttl * 1000).toISOString();

  // If a hard deadline exists and falls before TTL expiry, warn — TTL must not
  // outlive the deadline or the dispatcher could dispatch a stale call.
  if (core.deadline?.resolved_iso) {
    const dlMs = new Date(core.deadline.resolved_iso).getTime();
    const expMs = new Date(expires).getTime();
    if (Number.isFinite(dlMs) && dlMs < expMs) {
      warnings.push({
        code: "W_TTL_PAST_DEADLINE",
        message: `ttl expires ${expires} after deadline ${core.deadline.resolved_iso}`,
      });
    }
  }

  return {
    dialed_at_iso: dialed,
    ttl_seconds: ttl,
    expires_at_iso: expires,
    deadline: core.deadline,
  };
}

function _buildHeaders(ctx) {
  const h = {
    "X-AE-Route-Schema":       ROUTE_SCHEMA,
    "X-AE-Route-Id":           ctx.route_id,
    "X-AE-From":               ctx.from.lane,
    "X-AE-Operator":           ctx.from.operator_id,
    "X-AE-Authority-Risk":     ctx.authority.risk_level,
    "X-AE-Authority-Priority": String(ctx.authority.priority),
    "X-AE-Authority-Gates":    ctx.authority.required_gates.join(","),
    "X-AE-To-Department":      ctx.to.department,
    "X-AE-To-Extension":       ctx.to.extension,
    "X-AE-To-Path":            ctx.to.path.join(">"),
    "X-AE-Class-Composition":  ctx.class_of_service.composition,
    "X-AE-Class-Trunking":     ctx.class_of_service.trunking,
    "X-AE-Class-FanOut":       String(ctx.class_of_service.fan_out),
    "X-AE-Artifact-Primary":   ctx.artifacts.primary,
    "X-AE-Artifact-Scope":     ctx.artifacts.scope,
    "X-AE-Timing-Expires":     ctx.timing.expires_at_iso,
    "X-AE-Action-Verb":        ctx.action_verb,
    "X-AE-Correlation-Id":     ctx.correlation_id,
  };
  if (ctx.session_id) h["X-AE-Session-Id"] = ctx.session_id;
  if (ctx.timing.deadline?.resolved_iso) {
    h["X-AE-Timing-Deadline"] = ctx.timing.deadline.resolved_iso;
  }
  if (ctx.artifacts.version) h["X-AE-Artifact-Version"] = ctx.artifacts.version;
  if (ctx.artifacts.target_state) h["X-AE-Artifact-State"] = ctx.artifacts.target_state;
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Tiny utilities.
// ─────────────────────────────────────────────────────────────────────────────

function _coerceISO(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — CLI: feed it a High intent, walk the full pipeline, print the
// resulting Route Packet(s).
//
//   node route-packet.mjs "ship Orange5 v1 with Æ Cobra LIVE by Friday"
//
// Pipes: high-parser → core-emitter → route-packet → validateRoutePacket.
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const high = await import("./high-parser.mjs");
  const core = await import("./core-emitter.mjs");
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error('usage: node route-packet.mjs "<intent string>"');
    process.exit(2);
  }
  const hr = high.parseHigh(input);
  if (!hr.ok) {
    console.error(JSON.stringify({ ok: false, stage: "high-parse", errors: hr.errors }, null, 2));
    process.exit(1);
  }
  const er = core.emitCore(hr.ir, { now: new Date().toISOString() });
  if (!er.ok) {
    console.error(JSON.stringify({ ok: false, stage: "core-emit", errors: er.errors }, null, 2));
    process.exit(1);
  }
  const rr = buildRoutePacketsFromEmit(er, {
    from: "operator",
    operator_id: "atom",
    now: new Date().toISOString(),
    ttl_seconds: 900,
  });
  const validations = rr.packets.map(validateRoutePacket);
  const allValid = validations.every(v => v.ok);
  const out = {
    ok: rr.ok && allValid,
    stage: "route-packet",
    high_ir: hr.ir,
    core_packets: er.packets,
    route_packets: rr.packets,
    errors: rr.errors,
    warnings: rr.warnings,
    validations,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
