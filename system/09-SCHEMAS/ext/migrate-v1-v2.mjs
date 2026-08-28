#!/usr/bin/env bun
/**
 * migrate-v1-v2.mjs — pure, reversible v1 -> v2 upgrader for orange.order.
 *
 * ADDITIVE LANE LAW: pure function of its input. Reads nothing, writes nothing
 * to disk (the CLI reads/writes a file the caller names, nothing else). Never
 * mutates its argument — returns a fresh object.
 *
 * CONTRACT:
 *   - NEVER drops a field. Every key on the v1 order survives verbatim.
 *   - Bumps `schema` from "orange.order.v1" to "orange.order.v2".
 *   - Fills the four v2 additions with their explicit defaults ONLY when the
 *     v1 order did not already carry them:
 *         seed -> null, dry_run -> false, budget -> null, egress_declared -> []
 *     If the v1 order already carried one of these (legal under v1's
 *     additionalProperties: true), its value is preserved untouched.
 *   - Records an `x_migration` provenance marker listing exactly which fields
 *     the migrator ADDED (so downgrade can strip precisely those and nothing
 *     else). If x_migration already exists it is treated as a carried field and
 *     preserved — but such an input is rejected as already-migrated by default.
 *
 * REVERSIBILITY:
 *   downgradeV2ToV1(upgradeV1ToV2(order)) deep-equals `order`, for every valid
 *   v1 order. Proven by test-migrate-v1-v2.mjs over hand fixtures + seeded fuzz.
 *   Downgrade removes the schema bump, removes exactly the fields x_migration
 *   says were added, and removes the marker itself.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  ORDER_V1_ID,
  ORDER_V2_ID,
  V2_FIELD_NAMES,
  validateOrderEnvelope,
} from "./envelope-validate.mjs";
import { v2Defaults } from "./order-v2-additions.mjs";

export { ORDER_V1_ID, ORDER_V2_ID };

const DEFAULTS = v2Defaults();

/** Deep clone that is safe for plain JSON (the only thing an order ever is). */
function clone(v) {
  return structuredClone(v);
}

/**
 * Upgrade a v1 order to v2. Pure; returns a new object.
 * @param {object} order a document with schema === "orange.order.v1"
 * @param {object} [opts]
 * @param {string} [opts.tool]        recorded in x_migration.tool
 * @param {string} [opts.migratedAt]  recorded in x_migration.migrated_at (ISO string)
 * @param {boolean} [opts.validate]   if true (default), assert the input is a
 *                                     valid v1 order before migrating
 * @returns {object} a fresh v2 order
 * @throws if the input is not a valid v1 order (when validate !== false)
 */
export function upgradeV1ToV2(order, opts = {}) {
  if (order == null || typeof order !== "object" || Array.isArray(order)) {
    throw new Error("migrate: order must be a JSON object");
  }
  if (order.schema !== ORDER_V1_ID) {
    throw new Error(
      `migrate: expected schema "${ORDER_V1_ID}", got ${JSON.stringify(order.schema)}`
    );
  }
  if (Object.hasOwn(order, "x_migration")) {
    throw new Error(
      "migrate: order already carries an x_migration marker (already migrated?)"
    );
  }
  if (opts.validate !== false) {
    const v1 = validateOrderEnvelope(order);
    if (!v1.ok) {
      throw new Error(
        `migrate: input is not a valid orange.order.v1 (${v1.errors
          .map((e) => `${e.path} ${e.rule}`)
          .join("; ")})`
      );
    }
  }

  // Copy every field verbatim (never drop), then bump the discriminator.
  const out = clone(order);
  out.schema = ORDER_V2_ID;

  // Fill defaults ONLY for additions the v1 order lacked. Track what we added.
  const added = [];
  for (const name of V2_FIELD_NAMES) {
    if (!Object.hasOwn(order, name)) {
      out[name] = clone(DEFAULTS[name]);
      added.push(name);
    }
  }

  // Provenance marker: exactly the fields we synthesized.
  out.x_migration = {
    from: ORDER_V1_ID,
    to: ORDER_V2_ID,
    added,
    ...(opts.tool !== undefined ? { tool: String(opts.tool) } : { tool: "migrate-v1-v2.mjs" }),
    ...(opts.migratedAt !== undefined ? { migrated_at: String(opts.migratedAt) } : {}),
  };

  return out;
}

/**
 * Downgrade a v2 order produced by upgradeV1ToV2 back to the exact original v1.
 * Pure; returns a new object. Requires the x_migration marker (that is what
 * makes the operation lossless and precise).
 * @param {object} order a v2 order carrying an x_migration marker
 * @returns {object} the reconstructed v1 order
 * @throws if the marker is missing or malformed
 */
export function downgradeV2ToV1(order) {
  if (order == null || typeof order !== "object" || Array.isArray(order)) {
    throw new Error("migrate: order must be a JSON object");
  }
  if (order.schema !== ORDER_V2_ID) {
    throw new Error(
      `migrate: expected schema "${ORDER_V2_ID}", got ${JSON.stringify(order.schema)}`
    );
  }
  const m = order.x_migration;
  if (
    m == null ||
    typeof m !== "object" ||
    m.from !== ORDER_V1_ID ||
    m.to !== ORDER_V2_ID ||
    !Array.isArray(m.added)
  ) {
    throw new Error(
      "migrate: cannot downgrade without a well-formed x_migration marker"
    );
  }
  const addedSet = new Set(m.added);
  for (const k of addedSet) {
    if (!V2_FIELD_NAMES.includes(k)) {
      throw new Error(`migrate: x_migration.added lists unknown field "${k}"`);
    }
  }

  const out = clone(order);
  // Strip exactly the synthesized additions, then the marker, then un-bump.
  for (const name of addedSet) delete out[name];
  delete out.x_migration;
  out.schema = ORDER_V1_ID;
  return out;
}

/** True round-trip check: upgrade then downgrade deep-equals the input. */
export function isReversible(v1Order, opts = {}) {
  const up = upgradeV1ToV2(v1Order, opts);
  const down = downgradeV2ToV1(up);
  return deepEqual(down, v1Order);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI: bun migrate-v1-v2.mjs <in.json> [-o out.json] [--down]
//   default:  upgrade v1 -> v2, print (or write) the result
//   --down:   downgrade v2 -> v1
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("-"));
  const outIdx = args.indexOf("-o");
  const out = outIdx !== -1 ? args[outIdx + 1] : null;
  const down = args.includes("--down");
  if (!file) {
    console.log("usage: bun migrate-v1-v2.mjs <in.json> [-o out.json] [--down]");
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const result = down ? downgradeV2ToV1(doc) : upgradeV1ToV2(doc);
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) {
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}
