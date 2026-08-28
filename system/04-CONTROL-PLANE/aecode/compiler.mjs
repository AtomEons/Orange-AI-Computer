// AE Orange5 Control Plane — AECode compiler.
//
// Pipeline:
//   intent → AECode Source → mission contract → target plan
//          → patch plan → gauntlet → receipt plan → rollback plan
//
// This module owns: parse(source) → AST, validate(ast), compile(ast) → bundle
//   bundle = { order, mission, targetPlan, patchPlan, gauntletSteps,
//              receiptPlan, rollbackPlan, aelangCore }
//
// AECode Source is JSON-shaped (extension .ae.json) OR a relaxed line-form
// (extension .ae) that this parser folds into the same AST.
//
// Doctrine refs:
//   - Schema: 09-SCHEMAS/aecode-final-format.schema.json
//   - Mission: 09-SCHEMAS/mission.schema.json
//   - Order:   09-SCHEMAS/orange.order.v1.schema.json
//   - Receipt: 09-SCHEMAS/receipt.schema.json
//   - Gauntlet:09-SCHEMAS/gauntlet_result.schema.json
//
// No silent fallback. Every failure mode names itself. Receipts always required.

import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1. Constants — required AECode sections + risk lattice.
// ─────────────────────────────────────────────────────────────────────────────

export const REQUIRED_SECTIONS = Object.freeze([
  "identity",
  "product_intent",
  "operator_laws",
  "scope",
  "target_matrix",
  "artifact_contracts",
  "data_contracts",
  "behavior_graph",
  "permissions",
  "model_roles",
  "gauntlets",
  "receipts",
  "rollback",
]);

export const RISK_LEVELS = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
  "production",
]);

// AE0-AE14 department lanes — used by router and mission.provider_lane.
export const DEPARTMENTS = Object.freeze([
  "AE0_FACTORY", "AE1_PRODUCT", "AE2_RESEARCH", "AE3_DESIGN",
  "AE4_MARKETING", "AE5_SALES", "AE6_CODE", "AE7_REVIEW",
  "AE8_LAUNCH", "AE9_LEGAL", "AE10_OPS", "AE11_SECURITY",
  "AE12_DATA", "AE13_AUTOMATION", "AE14_BENCH",
]);

const COMPILER_VERSION = "0.1.0";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2. Parser — relaxed AECode line-form → AST.
//
// Two accepted source shapes:
//   (a) JSON object with the 13 required sections (most common; ParseError if
//       any section is missing).
//   (b) line-form `.ae` text. Sections are introduced with `:section name`,
//       k/v lines with `  key = value`, list items with `  - value`,
//       comments with `# ...`. Each section terminates at the next `:`.
//
// Both forms produce the SAME AST shape:
//   { kind: "aecode.v0", source_hash, sections: { [name]: <value> } }
// ─────────────────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message, { line, section } = {}) {
    super(message);
    this.name = "ParseError";
    this.line = line ?? null;
    this.section = section ?? null;
  }
}

export class ValidationError extends Error {
  constructor(message, { section, field, code } = {}) {
    super(message);
    this.name = "ValidationError";
    this.section = section ?? null;
    this.field = field ?? null;
    this.code = code ?? "validation_failed";
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function coerceScalar(raw) {
  const s = String(raw).trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  // quoted string
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseLineForm(text) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let current = null;
  let currentValue = null;

  const commit = () => {
    if (current !== null) sections[current] = currentValue;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/\s+#.*$/, "").trimEnd();
    if (stripped === "" || stripped.trimStart().startsWith("#")) continue;

    if (stripped.startsWith(":")) {
      commit();
      current = stripped.slice(1).trim();
      if (!current) {
        throw new ParseError("empty section name", { line: i + 1 });
      }
      currentValue = {}; // default object; auto-promote to array on `- item`
      continue;
    }

    if (current === null) {
      throw new ParseError(`content before any :section (line ${i + 1})`, { line: i + 1 });
    }

    const indented = /^\s/.test(raw);
    if (!indented) {
      throw new ParseError(`unindented content in section '${current}'`,
        { line: i + 1, section: current });
    }
    const body = stripped.trim();

    if (body.startsWith("- ")) {
      if (!Array.isArray(currentValue)) {
        // promote — but only if object is still empty
        if (currentValue && typeof currentValue === "object" &&
            Object.keys(currentValue).length === 0) {
          currentValue = [];
        } else {
          throw new ParseError(
            `cannot mix list items with key=value in section '${current}'`,
            { line: i + 1, section: current });
        }
      }
      currentValue.push(coerceScalar(body.slice(2)));
      continue;
    }

    const eq = body.indexOf("=");
    if (eq < 0) {
      throw new ParseError(
        `expected '<key> = <value>' or '- <item>' in section '${current}': ${body}`,
        { line: i + 1, section: current });
    }
    if (!currentValue || Array.isArray(currentValue)) {
      throw new ParseError(
        `cannot mix key=value with list items in section '${current}'`,
        { line: i + 1, section: current });
    }
    const key = body.slice(0, eq).trim();
    const val = body.slice(eq + 1).trim();
    if (!key) throw new ParseError("empty key", { line: i + 1, section: current });
    currentValue[key] = coerceScalar(val);
  }
  commit();
  return sections;
}

/**
 * Parse AECode source into an AST.
 *
 * @param {string|Buffer|object} input — JSON string, line-form string,
 *   Buffer, or already-parsed object.
 * @returns {{ kind: "aecode.v0", source_hash: string, sections: object }}
 */
export function parse(input) {
  if (input == null) {
    throw new ParseError("parse: input is required");
  }

  let raw;
  if (typeof input === "object" && !(input instanceof Buffer)) {
    // already-decoded — serialize stably for the hash.
    raw = JSON.stringify(input);
    return {
      kind: "aecode.v0",
      source_hash: sha256Hex(raw),
      sections: normalizeSections(input),
    };
  }

  const text = input instanceof Buffer ? input.toString("utf8") : String(input);
  const trimmed = text.trim();
  if (trimmed === "") throw new ParseError("empty source");

  let sections;
  if (trimmed.startsWith("{")) {
    let obj;
    try { obj = JSON.parse(trimmed); }
    catch (e) { throw new ParseError(`JSON parse: ${e.message}`); }
    sections = normalizeSections(obj);
  } else {
    sections = parseLineForm(text);
  }

  return {
    kind: "aecode.v0",
    source_hash: sha256Hex(text),
    sections,
  };
}

function normalizeSections(obj) {
  // Accept either {sections:{...}} or a flat object where keys ARE sections.
  if (obj && typeof obj === "object" && obj.sections && typeof obj.sections === "object") {
    return { ...obj.sections };
  }
  return { ...obj };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3. Validator — AST → typed validation report.
//
// Soft contract over aecode-final-format.schema.json: every required section
// must be present and non-empty, plus shape checks per section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an AECode AST.
 *
 * @param {object} ast — output of parse()
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function validate(ast) {
  const errors = [];
  if (!ast || ast.kind !== "aecode.v0") {
    errors.push(new ValidationError("invalid AST: missing kind=aecode.v0",
      { code: "bad_ast" }));
    return { ok: false, errors };
  }
  const s = ast.sections || {};

  for (const name of REQUIRED_SECTIONS) {
    if (!(name in s)) {
      errors.push(new ValidationError(`missing required section: ${name}`,
        { section: name, code: "missing_section" }));
      continue;
    }
    const v = s[name];
    if (v === null || v === undefined || v === "" ||
        (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
        (Array.isArray(v) && v.length === 0)) {
      errors.push(new ValidationError(`section is empty: ${name}`,
        { section: name, code: "empty_section" }));
    }
  }

  // identity must carry an id-like field
  if (s.identity && typeof s.identity === "object" && !Array.isArray(s.identity)) {
    if (!s.identity.id && !s.identity.name) {
      errors.push(new ValidationError("identity must have id or name",
        { section: "identity", field: "id", code: "identity_no_id" }));
    }
  }

  // product_intent must be a non-empty string
  if (s.product_intent !== undefined && typeof s.product_intent !== "string") {
    errors.push(new ValidationError("product_intent must be a string",
      { section: "product_intent", code: "wrong_type" }));
  }

  // operator_laws must be an array of strings
  if (s.operator_laws !== undefined) {
    if (!Array.isArray(s.operator_laws)) {
      errors.push(new ValidationError("operator_laws must be an array",
        { section: "operator_laws", code: "wrong_type" }));
    } else {
      for (let i = 0; i < s.operator_laws.length; i++) {
        if (typeof s.operator_laws[i] !== "string") {
          errors.push(new ValidationError(`operator_laws[${i}] must be a string`,
            { section: "operator_laws", code: "wrong_type" }));
        }
      }
    }
  }

  // scope must define allowed_paths and forbidden_paths
  if (s.scope && typeof s.scope === "object") {
    if (!Array.isArray(s.scope.allowed_paths)) {
      errors.push(new ValidationError("scope.allowed_paths must be an array",
        { section: "scope", field: "allowed_paths", code: "missing_field" }));
    }
    if (!Array.isArray(s.scope.forbidden_paths)) {
      errors.push(new ValidationError("scope.forbidden_paths must be an array",
        { section: "scope", field: "forbidden_paths", code: "missing_field" }));
    }
    if (s.scope.risk && !RISK_LEVELS.includes(s.scope.risk)) {
      errors.push(new ValidationError(
        `scope.risk '${s.scope.risk}' not in ${RISK_LEVELS.join("|")}`,
        { section: "scope", field: "risk", code: "bad_enum" }));
    }
  }

  // target_matrix must list at least one target
  if (s.target_matrix && typeof s.target_matrix === "object") {
    const targets = s.target_matrix.targets ?? s.target_matrix.list;
    if (!Array.isArray(targets) || targets.length === 0) {
      errors.push(new ValidationError("target_matrix must list ≥1 target",
        { section: "target_matrix", code: "no_targets" }));
    } else {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!t || typeof t !== "object" || !t.lang) {
          errors.push(new ValidationError(
            `target_matrix.targets[${i}] must be {lang, ...}`,
            { section: "target_matrix", code: "bad_target" }));
        }
      }
    }
  }

  // gauntlets must be a non-empty array of {id, gates}
  if (Array.isArray(s.gauntlets)) {
    if (s.gauntlets.length === 0) {
      errors.push(new ValidationError("gauntlets must contain ≥1 gauntlet",
        { section: "gauntlets", code: "empty" }));
    } else {
      for (let i = 0; i < s.gauntlets.length; i++) {
        const g = s.gauntlets[i];
        if (!g || typeof g !== "object" || !g.id || !Array.isArray(g.gates)) {
          errors.push(new ValidationError(
            `gauntlets[${i}] must be {id, gates: []}`,
            { section: "gauntlets", code: "bad_gauntlet" }));
        }
      }
    }
  }

  // receipts must declare emitter
  if (s.receipts && typeof s.receipts === "object") {
    if (!s.receipts.emit_on && !s.receipts.required) {
      errors.push(new ValidationError(
        "receipts must define emit_on or required",
        { section: "receipts", code: "no_emitter" }));
    }
  }

  // rollback must declare strategy
  if (s.rollback && typeof s.rollback === "object") {
    if (!s.rollback.strategy) {
      errors.push(new ValidationError("rollback.strategy is required",
        { section: "rollback", field: "strategy", code: "missing_field" }));
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4. AELang router — High → Core → ORANGEBOX Route Packet.
//
// AELang-High is the human intent line (e.g. "compile aecode -> mission").
// AELang-Core is a deterministic verb+object+lane+department tuple.
// The Route Packet binds Core to a department adapter and gauntlet plan.
// ─────────────────────────────────────────────────────────────────────────────

const VERB_TO_DEPT = Object.freeze({
  compile: "AE6_CODE",
  build:   "AE6_CODE",
  patch:   "AE6_CODE",
  test:    "AE14_BENCH",
  bench:   "AE14_BENCH",
  review:  "AE7_REVIEW",
  audit:   "AE11_SECURITY",
  scan:    "AE11_SECURITY",
  secure:  "AE11_SECURITY",
  data:    "AE12_DATA",
  ingest:  "AE12_DATA",
  research:"AE2_RESEARCH",
  design:  "AE3_DESIGN",
  ship:    "AE8_LAUNCH",
  launch:  "AE8_LAUNCH",
  ops:     "AE10_OPS",
  deploy:  "AE10_OPS",
  legal:   "AE9_LEGAL",
  market:  "AE4_MARKETING",
  sell:    "AE5_SALES",
  product: "AE1_PRODUCT",
  automate:"AE13_AUTOMATION",
  factory: "AE0_FACTORY",
});

/**
 * @param {string} highLine — AELang-High intent line.
 * @returns {{ verb: string, object: string, lane: string, department: string, raw: string }}
 */
export function aelangHighToCore(highLine) {
  if (typeof highLine !== "string" || !highLine.trim()) {
    throw new ValidationError("aelang: high line must be a non-empty string",
      { code: "bad_aelang_high" });
  }
  const tokens = highLine.trim().split(/\s+/);
  const verb = (tokens[0] || "").toLowerCase();
  if (!verb) {
    throw new ValidationError("aelang: missing verb", { code: "bad_aelang_high" });
  }
  // strip arrows; default object is the joined remainder.
  const rest = tokens.slice(1).join(" ").replace(/->.*$/, "").trim();
  const object = rest || "default";
  const department = VERB_TO_DEPT[verb] || "AE6_CODE";
  const lane = department === "AE0_FACTORY" ? "factory" : "department";
  return { verb, object, lane, department, raw: highLine.trim() };
}

/**
 * @param {object} core — output of aelangHighToCore
 * @param {object} [opts]
 * @returns {object} ORANGEBOX Route Packet
 */
export function aelangCoreToRoutePacket(core, opts = {}) {
  if (!core || !core.verb || !core.department) {
    throw new ValidationError("aelang: core must have verb+department",
      { code: "bad_aelang_core" });
  }
  return {
    schema: "ae.route_packet.v0",
    route_id: opts.routeId || makeId("rt"),
    verb: core.verb,
    object: core.object,
    department: core.department,
    lane: core.lane,
    adapter_hint: opts.adapter_hint || "mock-local-deterministic",
    requires_approval: opts.requires_approval ?? false,
    high: core.raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5. Compiler — AST → mission contract + target plan + the rest.
// ─────────────────────────────────────────────────────────────────────────────

function makeId(prefix) {
  // deterministic-ish: prefix + 12-hex random — but test-mode override allowed.
  if (process.env.AECODE_DETERMINISTIC_IDS === "1") {
    return `${prefix}_deterministic`;
  }
  const r = createHash("sha256")
    .update(`${prefix}:${Date.now()}:${Math.random()}`)
    .digest("hex").slice(0, 12);
  return `${prefix}_${r}`;
}

function inferRisk(sections) {
  if (sections.scope?.risk) return sections.scope.risk;
  // Heuristic: production target_matrix or destructive permissions → bump.
  const perms = sections.permissions || {};
  if (perms.allow_delete || perms.allow_force_push) return "destructive";
  if (perms.allow_write_production) return "production";
  if (perms.allow_write) return "medium";
  if (perms.allow_read_only) return "read_only";
  return "low";
}

function buildOrder(sections, mission_id) {
  const intent = sections.product_intent || "(no intent supplied)";
  const scope = sections.scope?.summary
    || sections.scope?.description
    || JSON.stringify(sections.scope?.allowed_paths || []);
  const risk = inferRisk(sections);
  const order = {
    schema: "orange.order.v1",
    orderId: mission_id,
    intent,
    scope,
    allowedActions: Array.isArray(sections.scope?.allowed_actions)
      ? sections.scope.allowed_actions
      : [],
    forbiddenActions: Array.isArray(sections.scope?.forbidden_actions)
      ? sections.scope.forbidden_actions
      : [],
    targetProject: sections.identity?.project
      || sections.identity?.name
      || sections.identity?.id
      || "unknown",
    riskLevel: risk,
    requiresReceipt: sections.receipts?.required ?? true,
    operatorApproved: false,
    createdAt: new Date().toISOString(),
  };
  return order;
}

function buildMission(sections, mission_id, targets) {
  const primaryTarget = targets[0] || { lang: "unknown" };
  const mission = {
    mission_id,
    intent: sections.product_intent || "",
    scope: sections.scope?.summary
      || sections.scope?.description
      || "(scope summary not provided)",
    allowed_paths: Array.isArray(sections.scope?.allowed_paths)
      ? sections.scope.allowed_paths : [],
    forbidden_paths: Array.isArray(sections.scope?.forbidden_paths)
      ? sections.scope.forbidden_paths : [],
    target: primaryTarget,
    provider_lane: sections.model_roles?.lane
      || sections.model_roles?.provider_lane
      || "subscription_cli",
    gauntlet: {
      gauntlets: sections.gauntlets || [],
      strategy: "all_must_pass",
    },
    receipt_plan: {
      emit_on: sections.receipts?.emit_on || ["compile", "patch", "gauntlet", "promote"],
      required: sections.receipts?.required ?? true,
      writer: sections.receipts?.writer || "control-plane",
    },
    rollback_plan: {
      strategy: sections.rollback?.strategy || "git_reset_hard",
      checkpoint: sections.rollback?.checkpoint || "pre_patch_head",
      verify: sections.rollback?.verify || "smoke_test",
    },
    approval_required: !!sections.permissions?.require_human_approval,
  };
  return mission;
}

function extractTargets(sections) {
  const tm = sections.target_matrix;
  if (!tm) return [];
  if (Array.isArray(tm.targets)) return tm.targets;
  if (Array.isArray(tm.list)) return tm.list;
  return [];
}

function buildTargetPlan(sections, targets, mission_id) {
  return targets.map((t, i) => {
    const lang = t.lang;
    const adapter = pickAdapterForLang(lang, sections);
    return {
      plan_id: `${mission_id}__t${i}`,
      lang,
      runtime: t.runtime || null,
      build_cmd: t.build_cmd || null,
      test_cmd: t.test_cmd || null,
      out_dir: t.out_dir || null,
      adapter,
      artifact_contracts: pickArtifactsForTarget(
        Array.isArray(sections.artifact_contracts) ? sections.artifact_contracts : [],
        t),
      data_contracts: pickDataContractsForTarget(
        Array.isArray(sections.data_contracts) ? sections.data_contracts : [],
        t),
    };
  });
}

function pickAdapterForLang(lang, sections) {
  const mr = sections.model_roles || {};
  if (mr.adapter_by_lang && typeof mr.adapter_by_lang === "object" && mr.adapter_by_lang[lang]) {
    return mr.adapter_by_lang[lang];
  }
  if (mr.default_adapter) return mr.default_adapter;
  return "mock-local-deterministic";
}

function pickArtifactsForTarget(contracts, target) {
  // attach contracts that name no target OR explicitly name this lang.
  return contracts.filter(c =>
    !c.target || c.target === "all" || c.target === target.lang);
}

function pickDataContractsForTarget(contracts, target) {
  return contracts.filter(c =>
    !c.target || c.target === "all" || c.target === target.lang);
}

function buildPatchPlan(sections, targets, mission_id) {
  // Behavior graph → ordered patch steps. Each node becomes a patch entry.
  const bg = sections.behavior_graph || {};
  const nodes = Array.isArray(bg.nodes) ? bg.nodes : [];
  const edges = Array.isArray(bg.edges) ? bg.edges : [];
  const order = topoSort(nodes, edges);
  return {
    plan_id: `${mission_id}__patch`,
    target_count: targets.length,
    steps: order.map((nodeId, i) => {
      const node = nodes.find(n => (n.id || n.name) === nodeId) || { id: nodeId };
      return {
        step_id: `${mission_id}__patch__s${i}`,
        node: nodeId,
        kind: node.kind || "edit",
        files: Array.isArray(node.files) ? node.files : [],
        precondition: node.precondition || null,
        postcondition: node.postcondition || null,
      };
    }),
  };
}

function topoSort(nodes, edges) {
  const ids = nodes.map(n => n.id || n.name).filter(Boolean);
  if (ids.length === 0) return [];
  const inDeg = new Map(ids.map(id => [id, 0]));
  const adj = new Map(ids.map(id => [id, []]));
  for (const e of edges) {
    const from = e.from, to = e.to;
    if (!from || !to) continue;
    if (!adj.has(from) || !inDeg.has(to)) continue;
    adj.get(from).push(to);
    inDeg.set(to, inDeg.get(to) + 1);
  }
  const q = ids.filter(id => inDeg.get(id) === 0);
  const out = [];
  while (q.length) {
    const n = q.shift();
    out.push(n);
    for (const m of adj.get(n)) {
      inDeg.set(m, inDeg.get(m) - 1);
      if (inDeg.get(m) === 0) q.push(m);
    }
  }
  if (out.length !== ids.length) {
    // cycle — return original order rather than throw; caller can detect.
    return ids;
  }
  return out;
}

function buildGauntletSteps(sections, mission_id) {
  const gs = Array.isArray(sections.gauntlets) ? sections.gauntlets : [];
  const steps = [];
  for (const g of gs) {
    const gauntletId = g.id || makeId("gnt");
    const gates = Array.isArray(g.gates) ? g.gates : [];
    for (let i = 0; i < gates.length; i++) {
      const gate = gates[i];
      steps.push({
        step_id: `${mission_id}__gauntlet__${gauntletId}__g${i}`,
        gauntlet_id: gauntletId,
        gate_id: gate.id || `gate_${i}`,
        name: gate.name || gate.id || `gate_${i}`,
        kind: gate.kind || "deterministic",
        blocking: gate.blocking ?? true,
        evidence_required: gate.evidence_required ?? true,
      });
    }
  }
  return steps;
}

function buildReceiptPlan(sections, mission_id, gauntletSteps, patchPlan) {
  const r = sections.receipts || {};
  const emit_on = r.emit_on || ["compile", "patch", "gauntlet", "promote"];
  const planned = [];
  if (emit_on.includes("compile")) {
    planned.push({ stage: "compile", receipt_id: `${mission_id}__rcpt__compile` });
  }
  if (emit_on.includes("patch")) {
    for (const step of patchPlan.steps) {
      planned.push({ stage: "patch", step_id: step.step_id,
        receipt_id: `${step.step_id}__rcpt` });
    }
  }
  if (emit_on.includes("gauntlet")) {
    for (const step of gauntletSteps) {
      planned.push({ stage: "gauntlet", step_id: step.step_id,
        receipt_id: `${step.step_id}__rcpt` });
    }
  }
  if (emit_on.includes("promote")) {
    planned.push({ stage: "promote", receipt_id: `${mission_id}__rcpt__promote` });
  }
  return {
    plan_id: `${mission_id}__receipts`,
    schema: "orange5.receipt.v0",
    actor: r.writer || "control-plane",
    emit_on,
    planned,
    hash_chain_required: true,
  };
}

function buildRollbackPlan(sections, mission_id, patchPlan) {
  const rb = sections.rollback || {};
  return {
    plan_id: `${mission_id}__rollback`,
    strategy: rb.strategy || "git_reset_hard",
    checkpoint: rb.checkpoint || "pre_patch_head",
    verify: rb.verify || "smoke_test",
    triggers: rb.triggers || ["gauntlet_fail", "receipt_chain_broken", "operator_abort"],
    revert_steps: patchPlan.steps.slice().reverse().map(s => ({
      step_id: `${s.step_id}__revert`,
      reverts: s.step_id,
    })),
  };
}

/**
 * Compile an AECode AST into the full execution bundle.
 *
 * @param {object} ast — output of parse()
 * @param {object} [opts]
 * @returns {{
 *   order: object,
 *   mission: object,
 *   targetPlan: object[],
 *   patchPlan: object,
 *   gauntletSteps: object[],
 *   receiptPlan: object,
 *   rollbackPlan: object,
 *   aelangCore: object|null,
 *   compiler: { version: string, source_hash: string, compiled_at: string }
 * }}
 */
export function compile(ast, opts = {}) {
  const v = validate(ast);
  if (!v.ok) {
    const msg = v.errors.map(e => `[${e.code}] ${e.message}`).join("; ");
    const err = new ValidationError(`AECode validation failed: ${msg}`,
      { code: "compile_validation_failed" });
    err.errors = v.errors;
    throw err;
  }
  const s = ast.sections;
  const mission_id = opts.mission_id || makeId("ms");
  const targets = extractTargets(s);
  const order = buildOrder(s, mission_id);
  const mission = buildMission(s, mission_id, targets);
  const targetPlan = buildTargetPlan(s, targets, mission_id);
  const patchPlan = buildPatchPlan(s, targets, mission_id);
  const gauntletSteps = buildGauntletSteps(s, mission_id);
  const receiptPlan = buildReceiptPlan(s, mission_id, gauntletSteps, patchPlan);
  const rollbackPlan = buildRollbackPlan(s, mission_id, patchPlan);

  // Optional AELang routing if a high line is present in scope.
  let aelangCore = null;
  if (typeof s.scope?.aelang_high === "string" && s.scope.aelang_high.trim()) {
    aelangCore = aelangHighToCore(s.scope.aelang_high);
  }

  return {
    order,
    mission,
    targetPlan,
    patchPlan,
    gauntletSteps,
    receiptPlan,
    rollbackPlan,
    aelangCore,
    compiler: {
      version: COMPILER_VERSION,
      source_hash: ast.source_hash,
      compiled_at: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6. High-level façade — parse + validate + compile in one call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-shot: AECode source → bundle. Throws ParseError or ValidationError.
 * @param {string|Buffer|object} source
 * @param {object} [opts]
 */
export function compileSource(source, opts = {}) {
  const ast = parse(source);
  return compile(ast, opts);
}

export const __internal = Object.freeze({
  parseLineForm, coerceScalar, topoSort, inferRisk,
  buildOrder, buildMission, buildTargetPlan, buildPatchPlan,
  buildGauntletSteps, buildReceiptPlan, buildRollbackPlan,
  pickAdapterForLang, VERB_TO_DEPT, COMPILER_VERSION,
});
