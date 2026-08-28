#!/usr/bin/env bun
/**
 * envelope-validate.mjs — fast runtime validation for Orange5 order/report
 * envelopes at the boundary (the hot-path check), plus a generic JSON Schema
 * subset compiler used by the rest of the 09-SCHEMAS/ext lane.
 *
 * ADDITIVE LANE LAW: this module READS the frozen v1 schemas; it never writes
 * to or mutates anything outside 09-SCHEMAS/ext/.
 *
 * Two tiers:
 *
 *  1. HOT PATH — hand-rolled `validateOrderEnvelope()` / `validateReportEnvelope()`.
 *     Zero schema-walking at call time, no exceptions for control flow, Set
 *     lookups for enums, early exit with `failFast`. This is what the
 *     order->action->report loop should call per envelope. The hand-rolled
 *     checks are proven equivalent to the real schema files by
 *     ext/tests/test-envelope-validate.mjs (agreement cross-check + seeded fuzz).
 *
 *  2. GENERIC — `compileValidator(schemaJson)` compiles a JSON Schema
 *     (Draft 2020-12 SUBSET, see below) into a closure tree once, then
 *     validates documents against it. Used by fixtures/migration/doc tooling
 *     and available for the non-envelope schemas (receipt, mission, pathwave...).
 *
 * Supported subset (everything the 09-SCHEMAS corpus actually uses):
 *   type (incl. union arrays), const, enum (incl. null), required, properties,
 *   additionalProperties (false | schema), items (schema | boolean),
 *   minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   minProperties, maxProperties, allOf, anyOf, oneOf, not, if/then/else,
 *   $ref (local "#/..." only), $defs.
 *
 * Deliberately NOT enforced (documented, matching Draft 2020-12 defaults):
 *   format          — annotation-only per 2020-12 default vocabulary
 *   default         — annotation-only
 *   patternProperties, unevaluated* — not used by the corpus; compile throws
 *                     on $ref to another document (non-local).
 *
 * Error shape: { path, rule, message } with `path` a JSON Pointer into the doc.
 * Result shape: { ok, errors, version } — never throws on bad documents.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Canonical schema locations (read-only). */
export const SCHEMA_DIR = join(__dirname, "..");
export const ORDER_V1_PATH = join(SCHEMA_DIR, "orange.order.v1.schema.json");
export const REPORT_V1_PATH = join(SCHEMA_DIR, "orange.report.v1.schema.json");

export const ORDER_V1_ID = "orange.order.v1";
export const ORDER_V2_ID = "orange.order.v2";
export const REPORT_V1_ID = "orange.report.v1";

/** Frozen enum from orange.order.v1.schema.json — kept in exact sync (tested). */
export const RISK_LEVELS = Object.freeze([
  "read_only", "low", "medium", "high", "destructive", "production",
]);
const RISK_SET = new Set(RISK_LEVELS);

export const V2_FIELD_NAMES = Object.freeze(["seed", "dry_run", "budget", "egress_declared"]);
const BUDGET_KEYS = new Set(["max_tokens", "max_seconds", "max_usd", "max_subagents"]);
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
const MIGRATION_ADDED = new Set(V2_FIELD_NAMES);

/** Load a schema JSON file from the canonical 09-SCHEMAS dir (read-only). */
export function loadSchema(fileName) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, fileName), "utf8"));
}

// ---------------------------------------------------------------------------
// Tier 1 — HOT PATH (hand-rolled envelope checks)
// ---------------------------------------------------------------------------

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isBool = (v) => typeof v === "boolean";
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

function err(errors, path, rule, message, failFast) {
  errors.push({ path, rule, message });
  return failFast;
}

/**
 * Validate an orange.order envelope (v1 exactly as frozen; v2 = v1 law plus
 * typed checks on the four v2 additions and the x_migration marker).
 * v1 documents get v1 semantics, byte-for-byte with the frozen schema:
 * extra fields are ALLOWED (additionalProperties: true) and NOT type-checked.
 * @returns {{ok: boolean, errors: Array, version: string|null}}
 */
export function validateOrderEnvelope(doc, { failFast = false } = {}) {
  const errors = [];
  if (!isObj(doc)) {
    return { ok: false, errors: [{ path: "", rule: "type", message: "order must be a JSON object" }], version: null };
  }
  const version = doc.schema === ORDER_V1_ID ? ORDER_V1_ID : doc.schema === ORDER_V2_ID ? ORDER_V2_ID : null;
  if (version === null) {
    return {
      ok: false, version: null,
      errors: [{ path: "/schema", rule: "const", message: `schema must be "${ORDER_V1_ID}" or "${ORDER_V2_ID}", got ${JSON.stringify(doc.schema)}` }],
    };
  }
  const stop = () => failFast && errors.length > 0;

  // v1 law (identical for v2 — superset contract)
  if (!(isStr(doc.orderId) && doc.orderId.length >= 3) && err(errors, "/orderId", "minLength", "orderId must be a string with minLength 3", failFast)) return { ok: false, errors, version };
  if (!(isStr(doc.action) && doc.action.length >= 1) && err(errors, "/action", "minLength", "action must be a non-empty string", failFast)) return { ok: false, errors, version };
  if (!(isStr(doc.intent) && doc.intent.length >= 1) && err(errors, "/intent", "minLength", "intent must be a non-empty string", failFast)) return { ok: false, errors, version };
  if (!(isStr(doc.scope) && doc.scope.length >= 1) && err(errors, "/scope", "minLength", "scope must be a non-empty string", failFast)) return { ok: false, errors, version };
  if (!isStrArray(doc.allowedActions) && err(errors, "/allowedActions", "type", "allowedActions must be an array of strings", failFast)) return { ok: false, errors, version };
  if (!isStrArray(doc.forbiddenActions) && err(errors, "/forbiddenActions", "type", "forbiddenActions must be an array of strings", failFast)) return { ok: false, errors, version };
  if (!isStr(doc.targetProject) && err(errors, "/targetProject", "type", "targetProject must be a string", failFast)) return { ok: false, errors, version };
  if (!RISK_SET.has(doc.riskLevel) && err(errors, "/riskLevel", "enum", `riskLevel must be one of ${RISK_LEVELS.join("|")}`, failFast)) return { ok: false, errors, version };
  if (!isBool(doc.requiresReceipt) && err(errors, "/requiresReceipt", "type", "requiresReceipt must be a boolean", failFast)) return { ok: false, errors, version };
  if (doc.operatorApproved !== undefined && !isBool(doc.operatorApproved) && err(errors, "/operatorApproved", "type", "operatorApproved must be a boolean when present", failFast)) return { ok: false, errors, version };
  if (doc.createdAt !== undefined && !isStr(doc.createdAt) && err(errors, "/createdAt", "type", "createdAt must be a string when present", failFast)) return { ok: false, errors, version };

  // v2 additions — typed ONLY under the v2 discriminator.
  if (version === ORDER_V2_ID && !stop()) {
    if (doc.seed !== undefined && doc.seed !== null && !(isInt(doc.seed) && doc.seed >= 0 && doc.seed <= Number.MAX_SAFE_INTEGER)) {
      if (err(errors, "/seed", "type", "seed must be null or an integer in [0, 2^53-1]", failFast)) return { ok: false, errors, version };
    }
    if (doc.dry_run !== undefined && !isBool(doc.dry_run)) {
      if (err(errors, "/dry_run", "type", "dry_run must be a boolean", failFast)) return { ok: false, errors, version };
    }
    if (doc.budget !== undefined && doc.budget !== null) {
      if (!isObj(doc.budget)) {
        if (err(errors, "/budget", "type", "budget must be null or an object", failFast)) return { ok: false, errors, version };
      } else {
        const keys = Object.keys(doc.budget);
        if (keys.length < 1 && err(errors, "/budget", "minProperties", "budget object must declare at least one limit", failFast)) return { ok: false, errors, version };
        for (const k of keys) {
          if (!BUDGET_KEYS.has(k)) {
            if (err(errors, `/budget/${k}`, "additionalProperties", `unknown budget key "${k}" (allowed: ${[...BUDGET_KEYS].join(", ")})`, failFast)) return { ok: false, errors, version };
            continue;
          }
          const v = doc.budget[k];
          const wantInt = k === "max_tokens" || k === "max_subagents";
          const okVal = wantInt ? isInt(v) && v >= 0 : isNum(v) && v >= 0;
          if (!okVal && err(errors, `/budget/${k}`, "type", `${k} must be a non-negative ${wantInt ? "integer" : "number"}`, failFast)) return { ok: false, errors, version };
        }
      }
    }
    if (doc.egress_declared !== undefined) {
      if (!Array.isArray(doc.egress_declared)) {
        if (err(errors, "/egress_declared", "type", "egress_declared must be an array of host strings", failFast)) return { ok: false, errors, version };
      } else {
        if (doc.egress_declared.length > 64 && err(errors, "/egress_declared", "maxItems", "egress_declared allows at most 64 entries", failFast)) return { ok: false, errors, version };
        const seen = new Set();
        for (let i = 0; i < doc.egress_declared.length; i++) {
          const h = doc.egress_declared[i];
          if (!(isStr(h) && h.length >= 1 && h.length <= 253 && HOST_RE.test(h))) {
            if (err(errors, `/egress_declared/${i}`, "pattern", `entry must be a lowercase host[:port] (optional leading "*.") — got ${JSON.stringify(h)}`, failFast)) return { ok: false, errors, version };
          } else if (seen.has(h)) {
            if (err(errors, `/egress_declared/${i}`, "uniqueItems", `duplicate egress host "${h}"`, failFast)) return { ok: false, errors, version };
          }
          seen.add(h);
        }
      }
    }
    if (doc.x_migration !== undefined) {
      const m = doc.x_migration;
      const shapeOk = isObj(m) && m.from === ORDER_V1_ID && m.to === ORDER_V2_ID
        && Array.isArray(m.added) && m.added.every((k) => MIGRATION_ADDED.has(k))
        && new Set(m.added).size === m.added.length
        && (m.tool === undefined || (isStr(m.tool) && m.tool.length <= 64))
        && (m.migrated_at === undefined || (isStr(m.migrated_at) && m.migrated_at.length <= 64))
        && Object.keys(m).every((k) => ["from", "to", "added", "tool", "migrated_at"].includes(k));
      if (!shapeOk && err(errors, "/x_migration", "shape", "x_migration must be {from:orange.order.v1, to:orange.order.v2, added:[v2 field names], tool?, migrated_at?}", failFast)) return { ok: false, errors, version };
    }
  }

  return { ok: errors.length === 0, errors, version };
}

/**
 * Validate an orange.report.v1 envelope — exact hand-rolled mirror of the
 * frozen schema (proven by agreement test).
 * @returns {{ok: boolean, errors: Array, version: string|null}}
 */
export function validateReportEnvelope(doc, { failFast = false } = {}) {
  const errors = [];
  if (!isObj(doc)) {
    return { ok: false, errors: [{ path: "", rule: "type", message: "report must be a JSON object" }], version: null };
  }
  if (doc.schema !== REPORT_V1_ID) {
    return {
      ok: false, version: null,
      errors: [{ path: "/schema", rule: "const", message: `schema must be "${REPORT_V1_ID}", got ${JSON.stringify(doc.schema)}` }],
    };
  }
  if (!(isStr(doc.orderId) && doc.orderId.length >= 3) && err(errors, "/orderId", "minLength", "orderId must be a string with minLength 3", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!(isStr(doc.status) && doc.status.length >= 2) && err(errors, "/status", "minLength", "status must be a string with minLength 2", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!(isNum(doc.confidence) && doc.confidence >= 0 && doc.confidence <= 1) && err(errors, "/confidence", "range", "confidence must be a number in [0,1]", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!isStrArray(doc.actionsTaken) && err(errors, "/actionsTaken", "type", "actionsTaken must be an array of strings", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!(Array.isArray(doc.evidence) && doc.evidence.every(isObj)) && err(errors, "/evidence", "type", "evidence must be an array of objects", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!isStrArray(doc.blockers) && err(errors, "/blockers", "type", "blockers must be an array of strings", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!isStr(doc.nextAction) && err(errors, "/nextAction", "type", "nextAction must be a string", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (!(isStr(doc.receiptPath) && doc.receiptPath.length >= 1) && err(errors, "/receiptPath", "minLength", "receiptPath must be a non-empty string", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (doc.ae_lane !== undefined && !isStr(doc.ae_lane) && err(errors, "/ae_lane", "type", "ae_lane must be a string when present", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  if (doc.ae_host !== undefined && !isStr(doc.ae_host) && err(errors, "/ae_host", "type", "ae_host must be a string when present", failFast)) return { ok: false, errors, version: REPORT_V1_ID };
  return { ok: errors.length === 0, errors, version: REPORT_V1_ID };
}

// ---------------------------------------------------------------------------
// Tier 2 — GENERIC subset compiler
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Key-order-independent stringify, used for uniqueItems identity. */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  return t; // string | boolean | object
}

function matchesType(v, want) {
  const t = typeOf(v);
  if (want === "number") return t === "number" || t === "integer";
  if (want === "integer") return t === "integer";
  return t === want;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#")) throw new Error(`compileValidator: only local $ref supported, got "${ref}"`);
  if (ref === "#") return root;
  const parts = ref.slice(2).split("/").map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  let node = root;
  for (const p of parts) {
    if (node === undefined || node === null || typeof node !== "object") {
      throw new Error(`compileValidator: cannot resolve $ref "${ref}" (missing segment "${p}")`);
    }
    node = node[p];
  }
  if (node === undefined) throw new Error(`compileValidator: $ref "${ref}" resolves to nothing`);
  return node;
}

/**
 * Compile a JSON Schema (subset above) into `(doc) => errors[]`.
 * Compilation happens once; validation reuses the closure tree.
 * Throws at COMPILE time on unsupported constructs; never throws at validate time.
 */
export function compileValidator(rootSchema) {
  const refCache = new Map();

  function compileNode(schema, ptr) {
    if (schema === true) return () => {};
    if (schema === false) return (v, path, errors) => errors.push({ path, rule: "false-schema", message: "schema forbids any value here" });
    if (!isObj(schema)) throw new Error(`compileValidator: schema node at ${ptr} must be object/boolean`);

    if (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (!refCache.has(ref)) {
        refCache.set(ref, null); // placeholder to allow recursion
        refCache.set(ref, compileNode(resolveRef(rootSchema, ref), ref));
      }
      return (v, path, errors) => {
        const fn = refCache.get(ref);
        fn(v, path, errors);
      };
    }

    const checks = [];

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      checks.push((v, path, errors) => {
        if (!types.some((t) => matchesType(v, t))) {
          errors.push({ path, rule: "type", message: `expected ${types.join("|")}, got ${typeOf(v)}` });
        }
      });
    }
    if (schema.const !== undefined) {
      const c = schema.const;
      checks.push((v, path, errors) => {
        if (!deepEqual(v, c)) errors.push({ path, rule: "const", message: `must equal ${JSON.stringify(c)}` });
      });
    }
    if (schema.enum !== undefined) {
      const opts = schema.enum;
      checks.push((v, path, errors) => {
        if (!opts.some((o) => deepEqual(v, o))) errors.push({ path, rule: "enum", message: `must be one of ${JSON.stringify(opts)}` });
      });
    }

    // string keywords
    if (schema.minLength !== undefined) checks.push((v, path, errors) => { if (isStr(v) && v.length < schema.minLength) errors.push({ path, rule: "minLength", message: `string shorter than ${schema.minLength}` }); });
    if (schema.maxLength !== undefined) checks.push((v, path, errors) => { if (isStr(v) && v.length > schema.maxLength) errors.push({ path, rule: "maxLength", message: `string longer than ${schema.maxLength}` }); });
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern); // unanchored per spec
      checks.push((v, path, errors) => { if (isStr(v) && !re.test(v)) errors.push({ path, rule: "pattern", message: `does not match /${schema.pattern}/` }); });
    }

    // numeric keywords
    if (schema.minimum !== undefined) checks.push((v, path, errors) => { if (typeof v === "number" && v < schema.minimum) errors.push({ path, rule: "minimum", message: `below minimum ${schema.minimum}` }); });
    if (schema.maximum !== undefined) checks.push((v, path, errors) => { if (typeof v === "number" && v > schema.maximum) errors.push({ path, rule: "maximum", message: `above maximum ${schema.maximum}` }); });
    if (schema.exclusiveMinimum !== undefined) checks.push((v, path, errors) => { if (typeof v === "number" && v <= schema.exclusiveMinimum) errors.push({ path, rule: "exclusiveMinimum", message: `must be > ${schema.exclusiveMinimum}` }); });
    if (schema.exclusiveMaximum !== undefined) checks.push((v, path, errors) => { if (typeof v === "number" && v >= schema.exclusiveMaximum) errors.push({ path, rule: "exclusiveMaximum", message: `must be < ${schema.exclusiveMaximum}` }); });

    // array keywords
    const itemsFn = schema.items !== undefined ? compileNode(schema.items, `${ptr}/items`) : null;
    if (itemsFn || schema.minItems !== undefined || schema.maxItems !== undefined || schema.uniqueItems) {
      checks.push((v, path, errors) => {
        if (!Array.isArray(v)) return;
        if (schema.minItems !== undefined && v.length < schema.minItems) errors.push({ path, rule: "minItems", message: `fewer than ${schema.minItems} items` });
        if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push({ path, rule: "maxItems", message: `more than ${schema.maxItems} items` });
        if (schema.uniqueItems) {
          const seen = new Set();
          for (let i = 0; i < v.length; i++) {
            const key = stableStringify(v[i]);
            if (seen.has(key)) { errors.push({ path: `${path}/${i}`, rule: "uniqueItems", message: "duplicate item" }); break; }
            seen.add(key);
          }
        }
        if (itemsFn) for (let i = 0; i < v.length; i++) itemsFn(v[i], `${path}/${i}`, errors);
      });
    }

    // object keywords
    const propFns = schema.properties
      ? Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, compileNode(s, `${ptr}/properties/${k}`)]))
      : null;
    const apRaw = schema.additionalProperties;
    const apFn = isObj(apRaw) ? compileNode(apRaw, `${ptr}/additionalProperties`) : null;
    if (propFns || schema.required || apRaw === false || apFn || schema.minProperties !== undefined || schema.maxProperties !== undefined) {
      checks.push((v, path, errors) => {
        if (!isObj(v)) return;
        if (schema.required) {
          for (const r of schema.required) {
            if (!Object.hasOwn(v, r)) errors.push({ path: `${path}/${r}`, rule: "required", message: `missing required property "${r}"` });
          }
        }
        const keys = Object.keys(v);
        if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push({ path, rule: "minProperties", message: `fewer than ${schema.minProperties} properties` });
        if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push({ path, rule: "maxProperties", message: `more than ${schema.maxProperties} properties` });
        for (const k of keys) {
          if (propFns && Object.hasOwn(propFns, k)) propFns[k](v[k], `${path}/${k}`, errors);
          else if (apRaw === false) errors.push({ path: `${path}/${k}`, rule: "additionalProperties", message: `unexpected property "${k}"` });
          else if (apFn) apFn(v[k], `${path}/${k}`, errors);
        }
      });
    }

    // applicators
    if (schema.allOf) {
      const fns = schema.allOf.map((s, i) => compileNode(s, `${ptr}/allOf/${i}`));
      checks.push((v, path, errors) => { for (const fn of fns) fn(v, path, errors); });
    }
    if (schema.anyOf) {
      const fns = schema.anyOf.map((s, i) => compileNode(s, `${ptr}/anyOf/${i}`));
      checks.push((v, path, errors) => {
        if (!fns.some((fn) => { const e = []; fn(v, path, e); return e.length === 0; })) {
          errors.push({ path, rule: "anyOf", message: "matched no anyOf branch" });
        }
      });
    }
    if (schema.oneOf) {
      const fns = schema.oneOf.map((s, i) => compileNode(s, `${ptr}/oneOf/${i}`));
      checks.push((v, path, errors) => {
        const hits = fns.filter((fn) => { const e = []; fn(v, path, e); return e.length === 0; }).length;
        if (hits !== 1) errors.push({ path, rule: "oneOf", message: `matched ${hits} oneOf branches, need exactly 1` });
      });
    }
    if (schema.not !== undefined) {
      const fn = compileNode(schema.not, `${ptr}/not`);
      checks.push((v, path, errors) => {
        const e = []; fn(v, path, e);
        if (e.length === 0) errors.push({ path, rule: "not", message: "must NOT match the 'not' schema" });
      });
    }
    if (schema.if !== undefined) {
      const ifFn = compileNode(schema.if, `${ptr}/if`);
      const thenFn = schema.then !== undefined ? compileNode(schema.then, `${ptr}/then`) : null;
      const elseFn = schema.else !== undefined ? compileNode(schema.else, `${ptr}/else`) : null;
      checks.push((v, path, errors) => {
        const e = []; ifFn(v, path, e);
        if (e.length === 0) { if (thenFn) thenFn(v, path, errors); }
        else if (elseFn) elseFn(v, path, errors);
      });
    }

    return (v, path, errors) => { for (const c of checks) c(v, path, errors); };
  }

  const rootFn = compileNode(rootSchema, "#");
  return (doc) => {
    const errors = [];
    rootFn(doc, "", errors);
    return errors;
  };
}

/** Convenience: compile the frozen v1 order/report schemas straight from disk. */
export function compileOrderV1() { return compileValidator(JSON.parse(readFileSync(ORDER_V1_PATH, "utf8"))); }
export function compileReportV1() { return compileValidator(JSON.parse(readFileSync(REPORT_V1_PATH, "utf8"))); }

// ---------------------------------------------------------------------------
// CLI: bun envelope-validate.mjs <file.json> [--kind order|report]
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const kindIdx = args.indexOf("--kind");
  const kind = kindIdx !== -1 ? args[kindIdx + 1] : "order";
  if (!file) {
    console.log("usage: bun envelope-validate.mjs <file.json> [--kind order|report]");
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const res = kind === "report" ? validateReportEnvelope(doc) : validateOrderEnvelope(doc);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
