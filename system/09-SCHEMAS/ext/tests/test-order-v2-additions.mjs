#!/usr/bin/env bun
/**
 * test-order-v2-additions.mjs — proves the v2 additions layer is a correct,
 * backward-compatible superset of frozen v1, and that its declared field rules
 * agree with the hot-path validator. Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import {
  buildOrderV2Schema,
  loadOrderV1Schema,
  v2Defaults,
  V2_ADDITIONS,
  V2_FIELD_NAMES,
  X_MIGRATION_SCHEMA,
  BUDGET_KEYS,
  ORDER_V1_ID,
  ORDER_V2_ID,
} from "../order-v2-additions.mjs";
import { compileValidator, validateOrderEnvelope } from "../envelope-validate.mjs";
import { FIXTURES } from "../fixtures.mjs";

let pass = 0, fail = 0, total = 0;
const check = (name, cond) => { total++; cond ? pass++ : (fail++, console.log(`  FAIL ${name}`)); };

const v1 = loadOrderV1Schema();
const v2 = buildOrderV2Schema();

// --- 1. Superset of required: v2.required === v1.required (v2 adds nothing required).
check("v2 required equals v1 required (set)",
  new Set(v2.required).size === new Set(v1.required).size &&
  v1.required.every((r) => v2.required.includes(r)));

// --- 2. Every v1 property survives in v2 (same or compatible).
for (const k of Object.keys(v1.properties)) {
  if (k === "schema") continue; // discriminator intentionally differs
  check(`v2 keeps v1 property "${k}"`, Object.hasOwn(v2.properties, k));
}

// --- 3. Discriminator bumped correctly.
check("v1 schema const", v1.properties.schema.const === ORDER_V1_ID);
check("v2 schema const bumped", v2.properties.schema.const === ORDER_V2_ID);

// --- 4. All four additions present, optional (not in required), typed.
for (const f of V2_FIELD_NAMES) {
  check(`v2 declares addition "${f}"`, Object.hasOwn(v2.properties, f));
  check(`addition "${f}" is optional`, !v2.required.includes(f));
}
check("V2_FIELD_NAMES is exactly the 4 additions",
  JSON.stringify([...V2_FIELD_NAMES].sort()) === JSON.stringify(["budget", "dry_run", "egress_declared", "seed"]));

// --- 5. x_migration marker present and closed (additionalProperties:false).
check("v2 has x_migration prop", Object.hasOwn(v2.properties, "x_migration"));
check("x_migration is closed", X_MIGRATION_SCHEMA.additionalProperties === false);
check("v2 stays open (superset)", v2.additionalProperties === true);

// --- 6. v2Defaults are the all-absent shape and each validates under v2.
const def = v2Defaults();
check("defaults: seed null", def.seed === null);
check("defaults: dry_run false", def.dry_run === false);
check("defaults: budget null", def.budget === null);
check("defaults: egress [] empty", Array.isArray(def.egress_declared) && def.egress_declared.length === 0);

// --- 7. Budget keys in the schema match the exported BUDGET_KEYS exactly.
check("budget keys match",
  JSON.stringify(Object.keys(V2_ADDITIONS.budget.schema.properties).sort()) ===
  JSON.stringify([...BUDGET_KEYS].sort()));

// --- 8. AGREEMENT: compiling the generated v2 schema agrees with the hot path
//        on the v2 fixtures (excluding the x_migration-only nuance, which both accept).
const cV2 = compileValidator(v2);
for (const f of FIXTURES.order_v2.valid.concat(FIXTURES.order_v2.invalid)) {
  const hot = validateOrderEnvelope(f.doc).ok;
  const comp = cV2(f.doc).length === 0;
  if (f.name === "with-x-migration-marker") check(`${f.name}: both accept`, hot && comp);
  else check(`v2 fixture "${f.name}": schema===hot (${comp})`, comp === hot);
}

// --- 9. A bare v1 golden order, with only its schema bumped, is a valid v2 doc
//        under the generated schema (proves true superset for the common case).
const bumped = { ...FIXTURES.order_v1.valid[0].doc, schema: ORDER_V2_ID };
check("v1-golden bumped-to-v2 validates under generated v2 schema", cV2(bumped).length === 0);

// --- 10. buildOrderV2Schema does not alias/mutate the frozen v1 object.
const v1Again = loadOrderV1Schema();
check("frozen v1 schema const unchanged after v2 build", v1Again.properties.schema.const === ORDER_V1_ID);
check("v2 build produced fresh properties object", v2.properties !== v1.properties);

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
