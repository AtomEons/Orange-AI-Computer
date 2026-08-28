// LOOM gate 2 — report_schema
//
// Hermes pre-flight gate 2 of 8. Validates an `orange.report.v1` envelope
// against the canonical schema at 09-SCHEMAS/orange.report.v1.schema.json.
//
// Contract: every report emitted by any LLM in the superstack — whether the
// actor is a frontier model behind the OpenAI gateway, a local Codexa worker,
// or an MCP tool adapter — must pass this gate before its `receiptPath`
// becomes addressable to gate 3 (receipt_spine). If this gate fails, Hermes
// refuses to accept the action's report and the lease is not retired; the
// LOOM chain returns control to the operator with structured reasons.
//
// Module shape:
//   - default export: async function reportSchemaGate(report, opts?) → { pass, reasons }
//   - named exports: reportSchemaGate, loadReportSchema, validateReport, GATE_ID, GATE_INDEX
//
// Honest gaps (read me):
//   - This is a hand-written validator tuned to `orange.report.v1` as it stands
//     today. Supported JSON Schema keywords: type, required, properties,
//     additionalProperties, const, enum, minLength, minimum, maximum, items
//     (single schema), format ("date-time" only). Anything else the schema
//     gains later ($ref, oneOf, pattern, exclusiveMinimum, dependentRequired,
//     etc.) will be silently ignored. Swap in Ajv when that day comes; the
//     surface (pass/reasons) does not change.
//   - The current orange.report.v1 schema sets `additionalProperties: true`,
//     so unknown top-level fields pass. This is deliberate — reports often
//     carry adapter-specific tails (e.g. Playwright MCP screenshots,
//     Chrome DevTools MCP trace ids). If the schema later tightens this,
//     the validator will honour the new value with no code change.
//   - `confidence` is checked as a number in [0, 1] inclusive. NaN and
//     Infinity are rejected by the type check (`Number.isFinite`).
//   - `format: "date-time"` uses a permissive RFC 3339-ish regex plus
//     `Date.parse`. Strings that pass the regex but are semantically
//     impossible (e.g. month 13) are caught by `Date.parse`. Timezone
//     normalisation is not performed.
//   - Schema file is cached after first successful load. Pass `opts.reload`
//     to force re-read in tests or hot-reload scenarios. Pass `opts.schema`
//     to inject a pre-loaded schema and skip disk I/O.
//   - This gate validates SHAPE only. It does NOT check that `receiptPath`
//     resolves to a real file on disk — that is gate 3's job (receipt_spine).
//     It does NOT check `status` for fake-green words — that is gate 8's job
//     (false_green_guard). Separation of concerns is intentional: each LOOM
//     gate owns one assertion so failure reasons are localised.
//   - Requires Node 20+ (uses `node:fs/promises`, `import.meta.url`,
//     top-level `URL` resolution).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GATE_ID = "report_schema";
export const GATE_INDEX = 2;

// Resolved at module load — points at the canonical schema file.
// 08-HERMES/src/loom-gates/02-report-schema.mjs → ../../../09-SCHEMAS/orange.report.v1.schema.json
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "09-SCHEMAS",
  "orange.report.v1.schema.json",
);

let _schemaCache = null;

/**
 * Load and parse the orange.report.v1 schema from disk.
 * @param {{ reload?: boolean }} [opts]
 * @returns {Promise<object>} parsed JSON Schema document
 * @throws {Error} with code "REPORT_SCHEMA_LOAD_FAILED" if the file is missing,
 *   unparseable, or has a mismatched $id.
 */
export async function loadReportSchema({ reload = false } = {}) {
  if (_schemaCache && !reload) return _schemaCache;
  let raw;
  try {
    raw = await readFile(SCHEMA_PATH, "utf8");
  } catch (err) {
    const e = new Error(`report_schema: cannot read ${SCHEMA_PATH}: ${err.message}`);
    e.code = "REPORT_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`report_schema: malformed JSON at ${SCHEMA_PATH}: ${err.message}`);
    e.code = "REPORT_SCHEMA_LOAD_FAILED";
    e.cause = err;
    throw e;
  }
  if (parsed?.$id !== "orange.report.v1") {
    const e = new Error(`report_schema: schema $id mismatch — expected "orange.report.v1", got "${parsed?.$id}"`);
    e.code = "REPORT_SCHEMA_LOAD_FAILED";
    throw e;
  }
  _schemaCache = parsed;
  return parsed;
}

// ----- minimal JSON-Schema-subset validator ---------------------------------
// Supported keywords, by design: type, required, properties, additionalProperties,
// const, enum, minLength, minimum, maximum, items (single schema), format
// ("date-time" only). Everything else is ignored (and that's a documented gap).

const RFC3339_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object" | "undefined" | "function"
}

function validateNode(value, schema, pathParts, reasons) {
  const where = pathParts.join(".") || "<root>";

  // const
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (value !== schema.const) {
      reasons.push(`${where}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      reasons.push(`${where}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
      return;
    }
  }

  // type
  if (schema.type) {
    const actual = typeOf(value);
    const expected = schema.type;
    let ok;
    if (expected === "number") {
      ok = actual === "number" && Number.isFinite(value);
    } else if (expected === "integer") {
      ok = actual === "number" && Number.isInteger(value);
    } else {
      ok = actual === expected;
    }
    if (!ok) {
      reasons.push(`${where}: expected type "${expected}", got "${actual}"`);
      return;
    }
  }

  // string keywords
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      reasons.push(`${where}: minLength ${schema.minLength}, got length ${value.length}`);
    }
    if (schema.format === "date-time") {
      if (!RFC3339_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
        reasons.push(`${where}: invalid date-time "${value}"`);
      }
    }
  }

  // numeric keywords (inclusive bounds, per JSON Schema 2020-12 defaults)
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      reasons.push(`${where}: minimum ${schema.minimum}, got ${value}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      reasons.push(`${where}: maximum ${schema.maximum}, got ${value}`);
    }
  }

  // object keywords
  if (schema.type === "object" || (schema.properties && typeOf(value) === "object")) {
    if (typeOf(value) !== "object") return; // type error already reported above

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          reasons.push(`${where}: missing required property "${key}"`);
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
          reasons.push(`${where}: additional property "${key}" not allowed`);
        }
      }
    }
    // additionalProperties: true (or absent) → allow extras silently. This
    // matches the current schema which sets additionalProperties: true so
    // adapter-specific tails (Playwright MCP, Chrome DevTools MCP, etc.)
    // can ride along without breaking the gate.
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
 * @param {unknown} report
 * @param {object} schema
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function validateReport(report, schema) {
  const reasons = [];
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { pass: false, reasons: ["<root>: report must be a JSON object"] };
  }
  if (!schema || typeof schema !== "object") {
    return { pass: false, reasons: ["<root>: schema unavailable"] };
  }
  validateNode(report, schema, [], reasons);
  return { pass: reasons.length === 0, reasons };
}

/**
 * LOOM gate 2 entry point. Loads the schema from disk (cached) and runs
 * the validator. Never throws on validation failure — only on
 * unrecoverable schema load failure, and even then it returns a
 * structured `{ pass: false, reasons }` so the LOOM chain can record
 * the failure as a gate-2 reject rather than an unhandled exception.
 *
 * @param {unknown} report
 * @param {{ reload?: boolean, schema?: object }} [opts]
 *   - `schema`: inject a pre-loaded schema (skips disk read; for tests).
 *   - `reload`: bypass the schema cache on this call.
 * @returns {Promise<{ pass: boolean, reasons: string[] }>}
 */
export async function reportSchemaGate(report, opts = {}) {
  let schema;
  if (opts.schema) {
    schema = opts.schema;
  } else {
    try {
      schema = await loadReportSchema({ reload: opts.reload });
    } catch (err) {
      return {
        pass: false,
        reasons: [`report_schema_load_failed: ${err.message}`],
      };
    }
  }
  return validateReport(report, schema);
}

export default reportSchemaGate;
