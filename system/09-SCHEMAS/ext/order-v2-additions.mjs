#!/usr/bin/env bun
/**
 * order-v2-additions.mjs — the OPTIONAL v2 field layer for orange.order.
 *
 * ADDITIVE LANE LAW: this module is the single source of truth for what v2 ADDS
 * on top of the frozen orange.order.v1 schema. It READS the frozen v1 schema
 * (never writes it) and produces `orange.order.v2` as a strict, backward-
 * compatible SUPERSET:
 *
 *   - Every field required by v1 is still required by v2.
 *   - v2 changes the `schema` const from "orange.order.v1" to "orange.order.v2"
 *     (the only breaking-looking change, and it is a discriminator, not a
 *     semantic shift — a v1 doc is a valid v2 doc once its `schema` is bumped).
 *   - v2 adds four OPTIONAL fields, all absent-by-default:
 *
 *       seed            null | integer[0, 2^53-1]   deterministic replay key
 *       dry_run         boolean                     plan-only, write nothing
 *       budget          null | { max_tokens?, max_seconds?, max_usd?, max_subagents? }
 *       egress_declared string[]  (host[:port], optional leading "*.")  declared network reach
 *
 *   - v2 also permits an OPTIONAL `x_migration` provenance marker written by
 *     migrate-v1-v2.mjs. It is annotation-only and never affects execution.
 *
 * Because every v2 addition is optional and the frozen v1 schema is
 * `additionalProperties: true`, a v1 order that simply carries these fields is
 * ALREADY valid against v1 — v2 exists to give those fields *types and bounds*,
 * not to gate them. The hot-path validator (envelope-validate.mjs) enforces the
 * exact same rules encoded here; test-order-v2-additions.mjs proves the two
 * agree field-for-field.
 *
 * Nothing here mutates a file on disk. `buildOrderV2Schema()` returns a fresh
 * JSON Schema object in memory for doc-gen, fixtures, and linting to consume.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORDER_V1_ID,
  ORDER_V2_ID,
  ORDER_V1_PATH,
  V2_FIELD_NAMES,
  RISK_LEVELS,
} from "./envelope-validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Re-export the canonical identifiers so downstream tools import from one place. */
export { ORDER_V1_ID, ORDER_V2_ID, V2_FIELD_NAMES, RISK_LEVELS };

/** Budget keys — kept in exact sync with envelope-validate BUDGET_KEYS (tested). */
export const BUDGET_KEYS = Object.freeze([
  "max_tokens",
  "max_seconds",
  "max_usd",
  "max_subagents",
]);

/**
 * Declarative spec for the four v2 additions. Each entry is a JSON Schema
 * fragment plus prose. `schema-doc-gen.mjs` renders the prose; the schema
 * fragments are spliced into `buildOrderV2Schema()`.
 */
export const V2_ADDITIONS = Object.freeze({
  seed: {
    optional: true,
    doc: "Deterministic replay key. When set, the spine derives every id and timestamp from it, so the same (seed, order) pair yields a byte-identical receipt. null (or absent) means wall-clock, non-deterministic ids.",
    schema: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Deterministic replay key (null = non-deterministic). Integer in [0, 2^53-1].",
    },
  },
  dry_run: {
    optional: true,
    doc: "Plan-only flag. When true, the executor returns a plan describing what it WOULD do and writes nothing (no receipt, no side effects).",
    schema: {
      type: "boolean",
      description: "If true, produce a plan and write nothing. Defaults to false.",
    },
  },
  budget: {
    optional: true,
    doc: "Resource ceiling for the order. An object declaring one or more non-negative limits. Absent or null means unbounded (subject to the governor).",
    schema: {
      type: ["object", "null"],
      minProperties: 1,
      additionalProperties: false,
      description:
        "Resource ceiling. At least one limit when present; null = unbounded.",
      properties: {
        max_tokens: {
          type: "integer",
          minimum: 0,
          description: "Maximum model tokens the order may consume.",
        },
        max_seconds: {
          type: "number",
          minimum: 0,
          description: "Maximum wall-clock seconds the order may run.",
        },
        max_usd: {
          type: "number",
          minimum: 0,
          description: "Maximum spend in USD the order may incur.",
        },
        max_subagents: {
          type: "integer",
          minimum: 0,
          description: "Maximum number of sub-agents the order may spawn.",
        },
      },
    },
  },
  egress_declared: {
    optional: true,
    doc: "Declared network reach: the set of hosts the order intends to contact. Each entry is a lowercase host[:port] with an optional leading \"*.\" wildcard. Empty or absent means no network egress is declared.",
    schema: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      description:
        "Declared outbound hosts (host[:port], optional leading \"*.\"). At most 64, unique.",
      items: {
        type: "string",
        minLength: 1,
        maxLength: 253,
        pattern:
          "^(\\*\\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$",
        description: "A lowercase host with optional wildcard label and port.",
      },
    },
  },
});

/** JSON Schema fragment for the optional x_migration provenance marker. */
export const X_MIGRATION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  description:
    "Provenance marker written by migrate-v1-v2.mjs. Annotation-only; never affects execution.",
  required: ["from", "to", "added"],
  properties: {
    from: { const: ORDER_V1_ID, description: "Source schema id." },
    to: { const: ORDER_V2_ID, description: "Target schema id." },
    added: {
      type: "array",
      uniqueItems: true,
      description: "Names of the v2 fields the migrator populated.",
      items: { enum: [...V2_FIELD_NAMES] },
    },
    tool: {
      type: "string",
      maxLength: 64,
      description: "Identifier of the tool that performed the migration.",
    },
    migrated_at: {
      type: "string",
      maxLength: 64,
      description: "Timestamp the migration was performed (ISO 8601 recommended).",
    },
  },
});

/** Load the frozen v1 schema straight from disk (read-only). */
export function loadOrderV1Schema() {
  return JSON.parse(readFileSync(ORDER_V1_PATH, "utf8"));
}

/**
 * Build the orange.order.v2 JSON Schema as a fresh in-memory object.
 * Derived from the frozen v1 schema: same required set, same v1 properties,
 * `schema` const bumped to v2, and the optional v2 additions + x_migration
 * spliced in. Never touches disk beyond READING v1.
 * @returns {object} a Draft 2020-12 JSON Schema for orange.order.v2
 */
export function buildOrderV2Schema() {
  const v1 = loadOrderV1Schema();

  // Start from a deep copy of v1's properties so we never alias the frozen doc.
  const properties = structuredClone(v1.properties ?? {});
  properties.schema = {
    const: ORDER_V2_ID,
    description: "Envelope discriminator. Fixed to orange.order.v2.",
  };

  // Splice the four optional additions.
  for (const name of V2_FIELD_NAMES) {
    properties[name] = structuredClone(V2_ADDITIONS[name].schema);
  }
  properties.x_migration = structuredClone(X_MIGRATION_SCHEMA);

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ORDER_V2_ID,
    title: "Orange Order v2",
    description:
      "Backward-compatible superset of orange.order.v1: same required fields, plus optional seed/dry_run/budget/egress_declared and an x_migration provenance marker. Every v1 order is a valid v2 order once its `schema` discriminator is bumped.",
    type: "object",
    // Same required set as v1 — v2 adds nothing to the required contract.
    required: [...(v1.required ?? [])],
    properties,
    // v2 stays open like v1 (additionalProperties: true) so it remains a true
    // superset and never rejects a field a v1 producer might carry.
    additionalProperties: true,
  };
}

/** The default (all-absent) shape of the v2 additions, for reference/tests. */
export function v2Defaults() {
  return { seed: null, dry_run: false, budget: null, egress_declared: [] };
}

// ---------------------------------------------------------------------------
// CLI: `bun order-v2-additions.mjs` prints the generated v2 schema as JSON.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  process.stdout.write(JSON.stringify(buildOrderV2Schema(), null, 2) + "\n");
}
