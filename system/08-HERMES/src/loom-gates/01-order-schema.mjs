// LOOM gate 1 — order_schema
//
// Hermes pre-flight gate 1 of 8. Validates an `orange.order.v1` envelope
// against the canonical schema at 09-SCHEMAS/orange.order.v1.schema.json.
//
// Contract: every action proposed by any LLM in the superstack must arrive
// inside a lease whose order document passes this gate before the LOOM
// chain advances to gate 2 (report_schema). If this gate fails, Hermes
// refuses the action and surfaces the reasons to the operator.
//
// Module shape:
//   - default export: async function orderSchemaGate(order, opts?) → { pass, reasons }
//   - named exports: orderSchemaGate, loadOrderSchema, validateOrder, GATE_ID, GATE_INDEX
//
// Honest gaps (read me):
//   - This is a hand-written validator tuned to `orange.order.v1` as it stands
//     today (required keys, primitive types, enum, const, minLength, array
//     item types). It is NOT a full JSON Schema 2020-12 implementation. If the
//     schema ever adds new keywords ($ref, oneOf, pattern, format-strict,
//     dependentRequired, etc.), this gate will silently ignore them. Swap in
//     Ajv when that day comes; the surface (pass/reasons) does not change.
//   - `format: "date-time"` is checked with a permissive RFC 3339-ish regex,
//     not a full RFC 3339 parser. Strings that pass the regex but are
//     semantically invalid dates (e.g. month 13) are caught by `Date.parse`,
//     but no timezone normalisation is performed.
//   - Schema file is cached after first successful load. Pass `opts.reload`
//     to force re-read in tests or hot-reload scenarios.
//   - Requires Node 20+ (uses `node:fs/promises`, `import.meta.url`, top-level
//     `URL` resolution).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GATE_ID = "order_schema";
export const GATE_INDEX = 1;

// Resolved at module load — points at the canonical schema file.
// 08-HERMES/src/loom-gates/01-order-schema.mjs → ../../../09-SCHEMAS/orange.order.v1.schema.json
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "09-SCHEMAS",
  "orange.order.v1.schema.json",
);

let _schemaCache = null;

/**
 * Load and parse the orange.order.v1 schema from disk.
 * @param {{ reload?: boolean }} [opts]
 * @returns {Promise<object>} parsed JSON Schema document
 * @throws {Error} with code "ORDER_SCHEMA_LOAD_FAILED" if the file is missing or unparseable
 */
export async function loadOrderSchema({ reload = false } = {}) {
  if (_schemaCache && !reload) return _schemaCache;
  let raw;
  try {
    raw = await readFile(SCHEMA_PATH, "utf8");
  } catch (err) {
    const e = new Error(`order_schema: cannot read ${SCHEMA_PATH}: ${err.message}`);
    e.code = "ORDER_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`order_schema: malformed JSON at ${SCHEMA_PATH}: ${err.message}`);
    e.code = "ORDER_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  if (parsed?.$id !== "orange.order.v1") {
    const e = new Error(`order_schema: schema $id mismatch — expected "orange.order.v1", got "${parsed?.$id}"`);
    e.code = "ORDER_SCHEMA_LOAD_FAILED";
    throw e;
  }
  _schemaCache = parsed;
  return parsed;
}

// ----- minimal JSON-Schema-subset validator ---------------------------------
// Supported keywords, by design: type, required, properties, additionalProperties,
// const, enum, minLength, items (single schema), format ("date-time" only).
// Everything else is ignored (and that's a documented gap above).

const RFC3339_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object" | "undefined" | "function"
}

function validateNode(value, schema, pathParts, reasons) {
  // const
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) {
      reasons.push(`${pathParts.join(".") || "<root>"}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      reasons.push(`${pathParts.join(".") || "<root>"}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  // type
  if (schema.type) {
    const actual = typeOf(value);
    const expected = schema.type;
    const ok = expected === "number"
      ? (actual === "number")
      : expected === "integer"
        ? (actual === "number" && Number.isInteger(value))
        : actual === expected;
    if (!ok) {
      reasons.push(`${pathParts.join(".") || "<root>"}: expected type "${expected}", got "${actual}"`);
      return;
    }
  }

  // string keywords
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      reasons.push(`${pathParts.join(".") || "<root>"}: minLength ${schema.minLength}, got length ${value.length}`);
    }
    if (schema.format === "date-time") {
      if (!RFC3339_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
        reasons.push(`${pathParts.join(".") || "<root>"}: invalid date-time "${value}"`);
      }
    }
  }

  // object keywords
  if (schema.type === "object" || (schema.properties && typeOf(value) === "object")) {
    if (typeOf(value) !== "object") return; // type error already reported above

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          reasons.push(`${pathParts.join(".") || "<root>"}: missing required property "${key}"`);
        }
      }
    }

    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], sub, [...pathParts, key], reasons);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          reasons.push(`${pathParts.join(".") || "<root>"}: additional property "${key}" not allowed`);
        }
      }
    }
    // additionalProperties: true (or absent) → allow extras silently. This
    // matches the current schema which sets additionalProperties: true.
  }

  // array keywords
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    // Only single-schema items form is supported (matches current schema).
    value.forEach((item, i) => {
      validateNode(item, schema.items, [...pathParts, String(i)], reasons);
    });
  }
}

/**
 * Pure validator — no I/O. Useful for tests and for callers that already
 * have the schema in hand.
 * @param {unknown} order
 * @param {object} schema
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function validateOrder(order, schema) {
  const reasons = [];
  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    return { pass: false, reasons: ["<root>: order must be a JSON object"] };
  }
  if (!schema || typeof schema !== "object") {
    return { pass: false, reasons: ["<root>: schema unavailable"] };
  }
  validateNode(order, schema, [], reasons);
  return { pass: reasons.length === 0, reasons };
}

/**
 * LOOM gate 1 entry point. Loads the schema from disk (cached) and runs
 * the validator. Never throws on validation failure — only on
 * unrecoverable schema load failure.
 *
 * @param {unknown} order
 * @param {{ reload?: boolean, schema?: object }} [opts]
 *   - `schema`: inject a pre-loaded schema (skips disk read; for tests).
 *   - `reload`: bypass the schema cache on this call.
 * @returns {Promise<{ pass: boolean, reasons: string[] }>}
 */
export async function orderSchemaGate(order, opts = {}) {
  let schema;
  if (opts.schema) {
    schema = opts.schema;
  } else {
    try {
      schema = await loadOrderSchema({ reload: opts.reload });
    } catch (err) {
      return {
        pass: false,
        reasons: [`order_schema_load_failed: ${err.message}`],
      };
    }
  }
  return validateOrder(order, schema);
}

export default orderSchemaGate;
