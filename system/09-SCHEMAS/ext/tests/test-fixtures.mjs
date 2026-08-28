#!/usr/bin/env bun
/**
 * test-fixtures.mjs — proves the canonical fixture corpus is internally
 * consistent: every "valid" fixture validates under BOTH the hot-path validator
 * and the generic schema-compiled validator; every "invalid" fixture is
 * rejected AND names its declared expected field/rule. Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import { FIXTURES, allFixtures, goldenOrderV1, goldenOrderV2, goldenReportV1 } from "../fixtures.mjs";
import {
  validateOrderEnvelope,
  validateReportEnvelope,
  compileOrderV1,
  compileReportV1,
  compileValidator,
  ORDER_V1_ID,
  ORDER_V2_ID,
  REPORT_V1_ID,
} from "../envelope-validate.mjs";
import { buildOrderV2Schema } from "../order-v2-additions.mjs";

let pass = 0, fail = 0, total = 0;
const check = (name, cond) => { total++; cond ? pass++ : (fail++, console.log(`  FAIL ${name}`)); };

const cOrderV1 = compileOrderV1();
const cReportV1 = compileReportV1();
const cOrderV2 = compileValidator(buildOrderV2Schema());

function hotValidate(schemaKey, doc) {
  return schemaKey === "report_v1" ? validateReportEnvelope(doc) : validateOrderEnvelope(doc);
}
function compiledErrors(schemaKey, doc) {
  if (schemaKey === "report_v1") return cReportV1(doc);
  if (schemaKey === "order_v2") return cOrderV2(doc);
  return cOrderV1(doc);
}

// --- 1. Structural: each group has both valid and invalid arrays, non-empty.
for (const key of ["order_v1", "order_v2", "report_v1"]) {
  check(`${key} has valid fixtures`, Array.isArray(FIXTURES[key].valid) && FIXTURES[key].valid.length > 0);
  check(`${key} has invalid fixtures`, Array.isArray(FIXTURES[key].invalid) && FIXTURES[key].invalid.length > 0);
  for (const f of FIXTURES[key].valid) check(`${key} valid "${f?.name}" well-formed`, f && typeof f.name === "string" && f.doc && typeof f.doc === "object");
  for (const f of FIXTURES[key].invalid) check(`${key} invalid "${f?.name}" has expect`, f && f.expect && (f.expect.path || f.expect.rule));
}

// --- 2. Golden helpers produce valid documents.
check("goldenOrderV1 valid (hot)", validateOrderEnvelope(goldenOrderV1()).ok);
check("goldenOrderV2 valid (hot)", validateOrderEnvelope(goldenOrderV2()).ok);
check("goldenReportV1 valid (hot)", validateReportEnvelope(goldenReportV1()).ok);
check("goldenOrderV1 schema id", goldenOrderV1().schema === ORDER_V1_ID);
check("goldenOrderV2 schema id", goldenOrderV2().schema === ORDER_V2_ID);
check("goldenReportV1 schema id", goldenReportV1().schema === REPORT_V1_ID);

// --- 3. Every VALID fixture validates under hot AND compiled validators.
for (const f of allFixtures()) {
  if (!f.valid) continue;
  const hot = hotValidate(f.schemaKey, f.doc);
  check(`VALID ${f.schemaKey}/${f.name} passes hot-path`, hot.ok === true);
  const compErrs = compiledErrors(f.schemaKey, f.doc);
  // x_migration marker is enforced only by the hot path; the generic schema
  // treats it as an open extra object -> also passes. So compiled must pass too.
  check(`VALID ${f.schemaKey}/${f.name} passes compiled`, compErrs.length === 0);
}

// --- 4. Every INVALID fixture is rejected by the hot path AND names its field.
for (const f of allFixtures()) {
  if (f.valid) continue;
  const hot = hotValidate(f.schemaKey, f.doc);
  check(`INVALID ${f.schemaKey}/${f.name} rejected by hot-path`, hot.ok === false);
  const named = hot.errors.some(
    (e) => (!f.expect.path || e.path === f.expect.path) && (!f.expect.rule || e.rule === f.expect.rule)
  );
  check(`INVALID ${f.schemaKey}/${f.name} names ${f.expect.path ?? ""}${f.expect.rule ? " " + f.expect.rule : ""}`.trim(), named);
}

// --- 5. Every INVALID fixture is ALSO rejected by the compiled validator
//        (defence in depth — the two validators agree on rejection).
for (const f of allFixtures()) {
  if (f.valid) continue;
  const compErrs = compiledErrors(f.schemaKey, f.doc);
  check(`INVALID ${f.schemaKey}/${f.name} rejected by compiled`, compErrs.length > 0);
}

// --- 6. Fixture names are unique within each group (no silent shadowing).
for (const key of ["order_v1", "order_v2", "report_v1"]) {
  const names = [...FIXTURES[key].valid, ...FIXTURES[key].invalid].map((f) => f.name);
  check(`${key} fixture names unique`, new Set(names).size === names.length);
}

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
