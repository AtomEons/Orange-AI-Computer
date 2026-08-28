// AELang-Core emitter — AELang-High IR → AELang-Core packet(s).
//
// Pipeline position:
//
//   AELang-High           (operator natural-language intent)
//        ↓ high-parser.mjs           — tokens → AST → HighIR
//   AELang-High IR
//        ↓ core-emitter.mjs          ← YOU ARE HERE
//   AELang-Core Packet                — typed, machine-parseable
//        ↓ route-packet builder
//   ORANGEBOX Route Packet
//
// A Core Packet is the first machine-grade contract in the pipeline. Every
// downstream router, dispatcher, and gauntlet reads Core, not High. The Core
// emitter is deterministic: same HighIR + same emit options → byte-identical
// Core packet (modulo the explicit "now" anchor for deadline resolution).
//
// Required fields on every Core packet:
//
//   action_verb   : canonical verb (build/ship/verify/...) from ACTION_VERBS
//   target_lattice: { primary, ordinals[], collateral[], scope, version }
//   lane_route    : { department, path[], composition, fan_out }
//   risk_level    : "read_only" | "low" | "medium" | "high" | "production" | "destructive"
//   deadline      : { kind, value, anchor_iso, resolved_iso, raw } | null
//
// Doctrine refs:
//   - AECode pipeline:        04-CONTROL-PLANE/aecode/compiler.mjs
//   - Departments AE0..AE14: rules/departments.json (verb→lane defaults)
//   - High parser:           04-CONTROL-PLANE/aelang/high-parser.mjs
//
// Real compiler code. No silent fall-back. Every emission produces either a
// valid Core packet OR a tagged error with the offending clause index and
// human-readable cause. Mom's Law: every branch earns its place.

import {
  ACTION_VERBS,
  STATE_TOKENS,
  LANE_HINTS,
  validateHighIR,
} from "./high-parser.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Constants & dispatch tables.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical Core packet schema string. Bumped on breaking field changes. */
export const CORE_SCHEMA = "aelang.core.packet.v0";

/** Risk-level enum, ordered low→high. Used by route-packet and gauntlet. */
export const RISK_LEVELS = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "production",
  "destructive",
]);

/** Canonical action verbs (mirror of high-parser.ACTION_VERBS values). */
export const CORE_VERBS = Object.freeze([
  "ship", "build", "compress", "fix", "refactor",
  "verify", "promote", "deploy", "rollback", "pause",
  "analyze", "route", "archive",
]);

/** All known department lanes. AE0..AE14. */
export const DEPARTMENTS = Object.freeze([
  "AE0_FACTORY", "AE1_PRODUCT", "AE2_RESEARCH", "AE3_DESIGN", "AE4_MARKETING",
  "AE5_SALES", "AE6_CODE", "AE7_REVIEW", "AE8_LAUNCH", "AE9_LEGAL",
  "AE10_OPS", "AE11_SECURITY", "AE12_DATA", "AE13_AUTOMATION", "AE14_BENCH",
]);

/**
 * Default verb → department mapping. Used when the operator did not name a
 * lane and the target name does not match a known department artifact. These
 * defaults are conservative: anything risky lands in REVIEW, not CODE.
 */
export const VERB_DEFAULT_LANE = Object.freeze({
  ship:     "AE8_LAUNCH",
  build:    "AE6_CODE",
  compress: "AE6_CODE",
  fix:      "AE6_CODE",
  refactor: "AE6_CODE",
  verify:   "AE7_REVIEW",
  promote:  "AE8_LAUNCH",
  deploy:   "AE10_OPS",
  rollback: "AE10_OPS",
  pause:    "AE10_OPS",
  analyze:  "AE2_RESEARCH",
  route:    "AE13_AUTOMATION",
  archive:  "AE12_DATA",
});

/**
 * Default verb → risk_level. Overridden by:
 *   1. explicit operator risk hint (RISK token)
 *   2. target_state escalation (LIVE/PRODUCTION → at least "production")
 */
export const VERB_DEFAULT_RISK = Object.freeze({
  ship:     "production",
  build:    "medium",
  compress: "low",
  fix:      "medium",
  refactor: "medium",
  verify:   "read_only",
  promote:  "production",
  deploy:   "production",
  rollback: "high",
  pause:    "low",
  analyze:  "read_only",
  route:    "low",
  archive:  "medium",
});

/**
 * Target-state risk escalations. If the clause resolves to one of these states,
 * the packet's risk_level is at LEAST the value listed here.
 */
export const STATE_RISK_FLOOR = Object.freeze({
  LIVE:       "production",
  PRODUCTION: "production",
  BETA:       "high",
  ALPHA:      "medium",
  PREVIEW:    "low",
  STAGING:    "medium",
  DRAFT:      "read_only",
  HELD:       "read_only",
  ARCHIVED:   "read_only",
});

/**
 * EOD/EOW/EOM/EOQ/EOY → hours offset from "anchor" (the resolution wall clock).
 * Coarse but deterministic.
 */
const KEYWORD_OFFSET_HOURS = Object.freeze({
  ASAP: 0,
  NOW:  0,
  COB:  8,
  EOD:  10,
  EOW:  24 * 5,
  EOM:  24 * 21,
  EOQ:  24 * 70,
  EOY:  24 * 200,
});

const DAY_INDEX = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Public API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} EmitOptions
 * @property {string} [now]               - ISO timestamp anchor for deadline resolution (default: Date.now())
 * @property {boolean} [strict]           - throw on first error
 * @property {Object<string,string>} [knownArtifacts] - target name → department mapping
 *                                          (e.g. { "Orange5": "AE0_FACTORY", "Cobra": "AE3_DESIGN" })
 */

/**
 * @typedef {Object} CorePacket
 * @property {string} schema              - constant CORE_SCHEMA
 * @property {string} packet_id           - deterministic id "core-<verb>-<n>"
 * @property {number} clause_index        - index in source HighIR.clauses
 * @property {string} action_verb         - canonical verb
 * @property {TargetLattice} target_lattice
 * @property {LaneRoute} lane_route
 * @property {string} risk_level
 * @property {DeadlineResolved|null} deadline
 * @property {string} source_intent       - raw HighIR.raw_intent
 *
 * @typedef {Object} TargetLattice
 * @property {string} primary             - first subject name
 * @property {Array<{name:string,count:number|null,universal:boolean}>} ordinals
 * @property {string[]} collateral        - "with" / "in" / "at" attachments
 * @property {("singleton"|"set"|"universal"|"none")} scope
 * @property {string|null} version
 * @property {string|null} target_state
 * @property {string|null} beneficiary
 * @property {string[]} tools
 *
 * @typedef {Object} LaneRoute
 * @property {string} department          - AE0..AE14
 * @property {string[]} path              - ordered chain of departments to visit
 * @property {("solo"|"sequence"|"parallel")} composition
 * @property {number} fan_out             - number of subjects this packet covers
 *
 * @typedef {Object} DeadlineResolved
 * @property {string} kind                - "absolute" | "relative" | "keyword" | "quarter"
 * @property {string} value
 * @property {string} raw
 * @property {string} anchor_iso          - the "now" used for resolution
 * @property {string|null} resolved_iso   - resolved wall-clock ISO; null if not resolvable
 */

/**
 * @typedef {Object} EmitError
 * @property {string} code
 * @property {string} message
 * @property {number} [clause_index]
 */

/**
 * @typedef {Object} EmitResult
 * @property {boolean} ok
 * @property {CorePacket[]} packets
 * @property {EmitError[]} errors
 * @property {EmitError[]} warnings
 * @property {string} composition         - "sequence" | "parallel" (mirrors HighIR)
 */

/**
 * Convert an AELang-High IR into an array of AELang-Core packets.
 *
 * One packet is emitted per clause. Multi-subject clauses are kept as a single
 * packet with `target_lattice.scope = "set"` and `lane_route.fan_out = N`;
 * the downstream route-packet builder is the layer that decides whether to
 * physically explode the set into N sub-routes.
 *
 * @param {import("./high-parser.mjs").HighIR} highIR
 * @param {EmitOptions} [opts]
 * @returns {EmitResult}
 */
export function emitCore(highIR, opts = {}) {
  const errors = [];
  const warnings = [];

  // 1) Structural gate — refuse to emit on an invalid IR.
  const v = validateHighIR(highIR);
  if (!v.ok) {
    for (const e of v.errors) errors.push({ code: e.code, message: e.message });
    if (opts.strict) _throwFirst(errors);
    return { ok: false, packets: [], errors, warnings, composition: "parallel" };
  }

  const anchorISO = _anchorISO(opts.now);
  const anchorDate = new Date(anchorISO);

  const packets = [];
  highIR.clauses.forEach((clause, idx) => {
    try {
      const pkt = _emitOne(clause, idx, highIR, anchorISO, anchorDate, opts, warnings);
      packets.push(pkt);
    } catch (err) {
      errors.push({ code: "E_EMIT", message: err.message, clause_index: idx });
    }
  });

  const ok = errors.length === 0 && packets.length > 0;
  if (!ok && opts.strict) _throwFirst(errors);
  return {
    ok,
    packets,
    errors,
    warnings,
    composition: highIR.composition || "parallel",
  };
}

/**
 * Validate a single Core packet structurally. Catches schema drift, missing
 * fields, illegal enum values, malformed deadlines. Does NOT re-run High
 * parsing.
 *
 * @param {CorePacket} pkt
 * @returns {{ ok: boolean, errors: Array<{code:string,message:string,path:string}> }}
 */
export function validateCorePacket(pkt) {
  const errs = [];

  if (!pkt || typeof pkt !== "object" || Array.isArray(pkt)) {
    return { ok: false, errors: [{ code: "E_ROOT_TYPE", message: "packet must be object", path: "$" }] };
  }
  if (pkt.schema !== CORE_SCHEMA) {
    errs.push({ code: "E_SCHEMA", message: `bad schema "${pkt.schema}"`, path: "$.schema" });
  }
  if (typeof pkt.packet_id !== "string" || pkt.packet_id.length === 0) {
    errs.push({ code: "E_PACKET_ID", message: "packet_id required", path: "$.packet_id" });
  }
  if (!Number.isInteger(pkt.clause_index) || pkt.clause_index < 0) {
    errs.push({ code: "E_CLAUSE_INDEX", message: "clause_index must be ≥0 integer", path: "$.clause_index" });
  }
  if (!CORE_VERBS.includes(pkt.action_verb)) {
    errs.push({ code: "E_ACTION_VERB", message: `unknown verb "${pkt.action_verb}"`, path: "$.action_verb" });
  }
  if (!RISK_LEVELS.includes(pkt.risk_level)) {
    errs.push({ code: "E_RISK_LEVEL", message: `bad risk_level "${pkt.risk_level}"`, path: "$.risk_level" });
  }
  if (typeof pkt.source_intent !== "string") {
    errs.push({ code: "E_SOURCE_INTENT", message: "source_intent must be string", path: "$.source_intent" });
  }

  // target_lattice
  const tl = pkt.target_lattice;
  if (!tl || typeof tl !== "object") {
    errs.push({ code: "E_TARGET_LATTICE", message: "target_lattice must be object", path: "$.target_lattice" });
  } else {
    if (typeof tl.primary !== "string") {
      errs.push({ code: "E_TL_PRIMARY", message: "target_lattice.primary must be string", path: "$.target_lattice.primary" });
    }
    if (!Array.isArray(tl.ordinals)) {
      errs.push({ code: "E_TL_ORDINALS", message: "target_lattice.ordinals must be array", path: "$.target_lattice.ordinals" });
    }
    if (!Array.isArray(tl.collateral)) {
      errs.push({ code: "E_TL_COLLATERAL", message: "target_lattice.collateral must be array", path: "$.target_lattice.collateral" });
    }
    if (!["singleton", "set", "universal", "none"].includes(tl.scope)) {
      errs.push({ code: "E_TL_SCOPE", message: `bad scope "${tl.scope}"`, path: "$.target_lattice.scope" });
    }
  }

  // lane_route
  const lr = pkt.lane_route;
  if (!lr || typeof lr !== "object") {
    errs.push({ code: "E_LANE_ROUTE", message: "lane_route must be object", path: "$.lane_route" });
  } else {
    if (!DEPARTMENTS.includes(lr.department)) {
      errs.push({ code: "E_LR_DEPT", message: `unknown department "${lr.department}"`, path: "$.lane_route.department" });
    }
    if (!Array.isArray(lr.path) || lr.path.length === 0) {
      errs.push({ code: "E_LR_PATH", message: "lane_route.path must be non-empty array", path: "$.lane_route.path" });
    } else {
      for (const d of lr.path) {
        if (!DEPARTMENTS.includes(d)) {
          errs.push({ code: "E_LR_PATH_DEPT", message: `unknown department in path "${d}"`, path: "$.lane_route.path" });
        }
      }
    }
    if (!["solo", "sequence", "parallel"].includes(lr.composition)) {
      errs.push({ code: "E_LR_COMPOSITION", message: `bad composition "${lr.composition}"`, path: "$.lane_route.composition" });
    }
    if (!Number.isInteger(lr.fan_out) || lr.fan_out < 1) {
      errs.push({ code: "E_LR_FAN_OUT", message: "fan_out must be ≥1 integer", path: "$.lane_route.fan_out" });
    }
  }

  // deadline (optional, but if present must be well-formed)
  if (pkt.deadline !== null && pkt.deadline !== undefined) {
    const d = pkt.deadline;
    if (typeof d !== "object") {
      errs.push({ code: "E_DEADLINE_TYPE", message: "deadline must be object or null", path: "$.deadline" });
    } else {
      if (!["absolute", "relative", "keyword", "quarter"].includes(d.kind)) {
        errs.push({ code: "E_DEADLINE_KIND", message: `bad deadline.kind "${d.kind}"`, path: "$.deadline.kind" });
      }
      if (typeof d.anchor_iso !== "string") {
        errs.push({ code: "E_DEADLINE_ANCHOR", message: "deadline.anchor_iso required", path: "$.deadline.anchor_iso" });
      }
      if (d.resolved_iso !== null && typeof d.resolved_iso !== "string") {
        errs.push({ code: "E_DEADLINE_RESOLVED", message: "deadline.resolved_iso must be string or null", path: "$.deadline.resolved_iso" });
      }
    }
  }

  return { ok: errs.length === 0, errors: errs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Per-clause emission.
// ─────────────────────────────────────────────────────────────────────────────

function _emitOne(clause, idx, highIR, anchorISO, anchorDate, opts, warnings) {
  const verb = clause.action.verb;
  if (!CORE_VERBS.includes(verb)) {
    throw new Error(`unknown action verb "${verb}"`);
  }

  const targetLattice = _buildTargetLattice(clause);
  const laneRoute = _buildLaneRoute(clause, verb, targetLattice, highIR.composition, opts, warnings);
  const riskLevel = _resolveRisk(clause, verb, targetLattice.target_state, warnings);
  const deadline = clause.deadline
    ? _resolveDeadline(clause.deadline, anchorISO, anchorDate, warnings)
    : null;

  const packet_id = `core-${verb}-${idx + 1}-${_shortHash(`${verb}|${targetLattice.primary}|${idx}`)}`;

  return {
    schema: CORE_SCHEMA,
    packet_id,
    clause_index: idx,
    action_verb: verb,
    target_lattice: targetLattice,
    lane_route: laneRoute,
    risk_level: riskLevel,
    deadline,
    source_intent: highIR.raw_intent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Target lattice construction.
//
// The lattice describes WHAT the action operates on. Three orthogonal axes:
//   - primary: the headline target name (first subject)
//   - ordinals: every subject (including count/universal flags)
//   - collateral: side-attachments from "with"/"in"/"at"
//   - scope: collapsed shape — singleton / set / universal / none
// ─────────────────────────────────────────────────────────────────────────────

function _buildTargetLattice(clause) {
  const subjects = clause.subjects || [];
  const primary = subjects[0]?.name || (clause.lane ? `<lane:${clause.lane}>` : "<none>");
  const ordinals = subjects.map(s => ({
    name: s.name,
    count: Number.isInteger(s.count) ? s.count : null,
    universal: !!s.universal,
  }));

  let scope;
  if (subjects.length === 0) {
    scope = "none";
  } else if (subjects.some(s => s.universal)) {
    scope = "universal";
  } else if (subjects.length > 1 || (subjects[0].count && subjects[0].count > 1)) {
    scope = "set";
  } else {
    scope = "singleton";
  }

  return {
    primary,
    ordinals,
    collateral: [...(clause.collateral || [])],
    scope,
    version: clause.version || null,
    target_state: clause.target_state || null,
    beneficiary: clause.beneficiary || null,
    tools: [...(clause.tools || [])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Lane routing.
//
// Resolution order (first hit wins):
//   1. Explicit clause.lane (operator named a department)
//   2. opts.knownArtifacts[primary] (caller-supplied artifact registry)
//   3. opts.knownArtifacts[collateral[i]] (any collateral has a known lane)
//   4. VERB_DEFAULT_LANE[verb]
//
// `path` is then computed by walking sensible department predecessors —
//   ship    → [AE7_REVIEW, AE8_LAUNCH]
//   deploy  → [AE7_REVIEW, AE10_OPS]
//   promote → [AE7_REVIEW, AE8_LAUNCH]
//   else    → [department]
// Composition mirrors HighIR.composition, but clauses with universal scope
// are flagged `parallel` regardless.
// ─────────────────────────────────────────────────────────────────────────────

function _buildLaneRoute(clause, verb, lattice, irComposition, opts, warnings) {
  const known = opts.knownArtifacts || {};
  let department = null;

  if (clause.lane && DEPARTMENTS.includes(clause.lane)) {
    department = clause.lane;
  } else if (lattice.primary && known[lattice.primary]) {
    department = known[lattice.primary];
  } else {
    for (const c of lattice.collateral) {
      if (known[c]) { department = known[c]; break; }
    }
  }
  if (!department) {
    department = VERB_DEFAULT_LANE[verb];
  }
  if (!DEPARTMENTS.includes(department)) {
    warnings.push({
      code: "W_UNKNOWN_DEPARTMENT",
      message: `fell back to AE0_FACTORY: "${department}" not in DEPARTMENTS`,
    });
    department = "AE0_FACTORY";
  }

  const path = _buildPath(verb, department);

  let composition;
  if (lattice.scope === "universal" || (lattice.scope === "set" && irComposition !== "sequence")) {
    composition = "parallel";
  } else if (irComposition === "sequence") {
    composition = "sequence";
  } else {
    composition = "solo";
  }

  const fan_out = _computeFanOut(lattice);

  return { department, path, composition, fan_out };
}

function _buildPath(verb, department) {
  // High-stakes verbs always pass through REVIEW before their terminal lane.
  if (verb === "ship" || verb === "promote") {
    return _dedupe(["AE7_REVIEW", "AE8_LAUNCH", department]);
  }
  if (verb === "deploy") {
    return _dedupe(["AE7_REVIEW", "AE10_OPS", department]);
  }
  if (verb === "rollback") {
    return _dedupe(["AE10_OPS", department, "AE7_REVIEW"]);
  }
  if (verb === "verify" || verb === "analyze") {
    return [department];
  }
  return [department];
}

function _computeFanOut(lattice) {
  if (lattice.scope === "none") return 1;
  // Universal scope: honor explicit count when given ("all 12 modules" → 12),
  // otherwise fall back to the number of named ordinals.
  if (lattice.scope === "universal") {
    let n = 0;
    for (const o of lattice.ordinals) {
      n += Number.isInteger(o.count) && o.count > 0 ? o.count : 1;
    }
    return Math.max(1, n);
  }
  let n = 0;
  for (const o of lattice.ordinals) {
    n += Number.isInteger(o.count) && o.count > 0 ? o.count : 1;
  }
  return Math.max(1, n);
}

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Risk resolution.
//
// Final risk_level = MAX(
//   VERB_DEFAULT_RISK[verb],
//   STATE_RISK_FLOOR[target_state] (if any),
//   explicit risk_hint from clause (if any)
// )
// "MAX" is by ordinal position in RISK_LEVELS — destructive > production > high > ...
// ─────────────────────────────────────────────────────────────────────────────

function _resolveRisk(clause, verb, targetState, warnings) {
  const candidates = [];

  const verbRisk = VERB_DEFAULT_RISK[verb];
  if (verbRisk) candidates.push(verbRisk);

  if (targetState && STATE_RISK_FLOOR[targetState]) {
    candidates.push(STATE_RISK_FLOOR[targetState]);
  }

  if (clause.risk_hint) {
    if (!RISK_LEVELS.includes(clause.risk_hint)) {
      warnings.push({ code: "W_BAD_RISK_HINT", message: `unknown risk_hint "${clause.risk_hint}"` });
    } else {
      candidates.push(clause.risk_hint);
    }
  }

  if (candidates.length === 0) return "medium";
  return _maxRisk(candidates);
}

function _maxRisk(levels) {
  let best = levels[0];
  let bestIdx = RISK_LEVELS.indexOf(best);
  for (let i = 1; i < levels.length; i++) {
    const idx = RISK_LEVELS.indexOf(levels[i]);
    if (idx > bestIdx) { best = levels[i]; bestIdx = idx; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Deadline resolution.
//
// Deadline kinds from high-parser:
//   absolute  : "2026-09-01"           → resolved_iso = "2026-09-01T23:59:59Z"
//   relative  : "friday" / "next monday" → next occurrence after anchor
//   keyword   : "EOD" / "EOW" / "ASAP"  → anchor + offset hours
//   quarter   : "Q3"                    → last day of that quarter
//
// On unresolvable input, resolved_iso = null. The packet still ships; the
// dispatcher can ask the operator to clarify.
// ─────────────────────────────────────────────────────────────────────────────

function _resolveDeadline(dl, anchorISO, anchorDate, warnings) {
  const out = {
    kind: dl.kind,
    value: dl.value,
    raw: dl.raw,
    anchor_iso: anchorISO,
    resolved_iso: null,
  };

  if (dl.kind === "absolute" && /^\d{4}-\d{2}-\d{2}$/.test(dl.value)) {
    out.resolved_iso = `${dl.value}T23:59:59.000Z`;
    return out;
  }

  if (dl.kind === "relative") {
    const parts = dl.value.toLowerCase().split(" ");
    let day = parts[parts.length - 1];
    let modifier = parts.length > 1 ? parts[0] : null;
    if (day === "today")     return _setEod(out, anchorDate, 0);
    if (day === "tonight")   return _setHour(out, anchorDate, 0, 22);
    if (day === "tomorrow")  return _setEod(out, anchorDate, 1);
    if (day === "yesterday") return _setEod(out, anchorDate, -1);
    if (day in DAY_INDEX) {
      const offset = _daysUntil(anchorDate, DAY_INDEX[day], modifier);
      return _setEod(out, anchorDate, offset);
    }
    warnings.push({ code: "W_UNRESOLVED_RELATIVE", message: `could not resolve relative "${dl.value}"` });
    return out;
  }

  if (dl.kind === "keyword") {
    const key = String(dl.value).toUpperCase();
    if (key in KEYWORD_OFFSET_HOURS) {
      const ms = KEYWORD_OFFSET_HOURS[key] * 3600 * 1000;
      out.resolved_iso = new Date(anchorDate.getTime() + ms).toISOString();
      return out;
    }
    warnings.push({ code: "W_UNRESOLVED_KEYWORD", message: `unknown deadline keyword "${dl.value}"` });
    return out;
  }

  if (dl.kind === "quarter") {
    const q = parseInt(String(dl.value).replace(/^Q/i, ""), 10);
    if (q >= 1 && q <= 4) {
      const y = anchorDate.getUTCFullYear();
      // Q1→Mar 31, Q2→Jun 30, Q3→Sep 30, Q4→Dec 31
      const endMonth = q * 3 - 1;       // 0-indexed
      const endDay = [31, 30, 30, 31][q - 1];
      const dt = new Date(Date.UTC(y, endMonth, endDay, 23, 59, 59));
      out.resolved_iso = dt.toISOString();
      return out;
    }
    warnings.push({ code: "W_BAD_QUARTER", message: `bad quarter value "${dl.value}"` });
    return out;
  }

  warnings.push({ code: "W_UNRESOLVED_DEADLINE", message: `unhandled deadline kind "${dl.kind}"` });
  return out;
}

function _daysUntil(anchorDate, targetDow, modifier) {
  const todayDow = anchorDate.getUTCDay();
  let diff = (targetDow - todayDow + 7) % 7;
  if (diff === 0) diff = 7;                  // "by Friday" said on Friday → next Friday
  if (modifier === "next" && diff < 7) diff += 7;  // "next Friday" = following week's Friday
  if (modifier === "this" && diff === 7) diff = 0; // "this Friday" today = today
  return diff;
}

function _setEod(out, anchorDate, dayOffset) {
  const dt = new Date(Date.UTC(
    anchorDate.getUTCFullYear(),
    anchorDate.getUTCMonth(),
    anchorDate.getUTCDate() + dayOffset,
    23, 59, 59,
  ));
  out.resolved_iso = dt.toISOString();
  return out;
}

function _setHour(out, anchorDate, dayOffset, hour) {
  const dt = new Date(Date.UTC(
    anchorDate.getUTCFullYear(),
    anchorDate.getUTCMonth(),
    anchorDate.getUTCDate() + dayOffset,
    hour, 0, 0,
  ));
  out.resolved_iso = dt.toISOString();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Internals.
// ─────────────────────────────────────────────────────────────────────────────

function _anchorISO(now) {
  if (typeof now === "string" && now.length > 0) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function _shortHash(s) {
  // Tiny, deterministic, non-cryptographic. Good enough for packet ids.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

function _throwFirst(errors) {
  if (errors.length === 0) return;
  const e = errors[0];
  const err = new Error(`AELang-Core emit failed: ${e.code} ${e.message}`);
  err.errors = errors;
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CLI: feed it a High intent and inspect the resulting Core packet.
//
//   node core-emitter.mjs "ship Orange5 v1 with Æ Cobra LIVE by Friday"
//
// Pipes through high-parser → emitCore → validateCorePacket and prints JSON.
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const mod = await import("./high-parser.mjs");
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.error('usage: node core-emitter.mjs "<intent string>"');
    process.exit(2);
  }
  const high = mod.parseHigh(input);
  if (!high.ok) {
    console.error(JSON.stringify({ ok: false, stage: "high-parse", errors: high.errors }, null, 2));
    process.exit(1);
  }
  const emit = emitCore(high.ir, { now: new Date().toISOString() });
  const validations = emit.packets.map(validateCorePacket);
  const allValid = validations.every(v => v.ok);
  const out = {
    ok: emit.ok && allValid,
    stage: "core-emit",
    high_ir: high.ir,
    emit,
    validations,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
