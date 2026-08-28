#!/usr/bin/env bun
/**
 * test-envelope-validate.mjs — proves the hot-path validators are correct AND
 * that they agree with the generic schema-compiled validators (v1 order/report)
 * and with the generated v2 schema. Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import {
  validateOrderEnvelope,
  validateReportEnvelope,
  compileValidator,
  compileOrderV1,
  compileReportV1,
  loadSchema,
  ORDER_V1_ID,
  ORDER_V2_ID,
  REPORT_V1_ID,
} from "../envelope-validate.mjs";
import { buildOrderV2Schema } from "../order-v2-additions.mjs";
import { FIXTURES, allFixtures } from "../fixtures.mjs";

let pass = 0, fail = 0, total = 0;
function check(name, cond) {
  total += 1;
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// Compiled (generic) validators for cross-checking.
const cOrderV1 = compileOrderV1();
const cReportV1 = compileReportV1();
const cOrderV2 = compileValidator(buildOrderV2Schema());

// --- 1. Every fixture: hot-path verdict matches the fixture's declared validity.
for (const f of allFixtures()) {
  const kind = f.schemaKey === "report_v1" ? "report" : "order";
  const res = kind === "report" ? validateReportEnvelope(f.doc) : validateOrderEnvelope(f.doc);
  check(`${f.schemaKey}/${f.name} hot-path ok===${f.valid}`, res.ok === f.valid);
  // invalid fixtures must name the expected path (and rule if given)
  if (!f.valid && f.expect) {
    const hit = res.errors.some(
      (e) => (!f.expect.path || e.path === f.expect.path) && (!f.expect.rule || e.rule === f.expect.rule)
    );
    check(`${f.schemaKey}/${f.name} names expected ${f.expect.path ?? ""} ${f.expect.rule ?? ""}`.trim(), hit);
  }
}

// --- 2. AGREEMENT: hot-path v1 verdict === compiled-schema v1 verdict.
for (const f of FIXTURES.order_v1.valid.concat(FIXTURES.order_v1.invalid)) {
  const hot = validateOrderEnvelope(f.doc).ok;
  const comp = cOrderV1(f.doc).length === 0;
  check(`order_v1/${f.name} hot===compiled (${hot})`, hot === comp);
}
for (const f of FIXTURES.report_v1.valid.concat(FIXTURES.report_v1.invalid)) {
  const hot = validateReportEnvelope(f.doc).ok;
  const comp = cReportV1(f.doc).length === 0;
  check(`report_v1/${f.name} hot===compiled (${hot})`, hot === comp);
}

// --- 3. AGREEMENT for v2: hot-path v2 verdict === generated-v2-schema verdict.
//        (x_migration is enforced by the hot path but is additive/open in the
//         generated schema, so exclude the marker-only fixture from strict
//         equality and instead assert both accept it.)
for (const f of FIXTURES.order_v2.valid.concat(FIXTURES.order_v2.invalid)) {
  const hot = validateOrderEnvelope(f.doc).ok;
  const comp = cOrderV2(f.doc).length === 0;
  if (f.name === "with-x-migration-marker") {
    check(`order_v2/${f.name} both accept`, hot === true && comp === true);
  } else {
    check(`order_v2/${f.name} hot===compiled (${hot})`, hot === comp);
  }
}

// --- 4. Discriminator handling.
check("order: unknown schema id rejected", validateOrderEnvelope({ ...FIXTURES.order_v1.valid[0].doc, schema: "nope" }).version === null);
check("report: v1 id required", validateReportEnvelope({ ...FIXTURES.report_v1.valid[0].doc, schema: "orange.report.v2" }).version === null);
check("order v1 version tag", validateOrderEnvelope(FIXTURES.order_v1.valid[0].doc).version === ORDER_V1_ID);
check("order v2 version tag", validateOrderEnvelope(FIXTURES.order_v2.valid[0].doc).version === ORDER_V2_ID);
check("report version tag", validateReportEnvelope(FIXTURES.report_v1.valid[0].doc).version === REPORT_V1_ID);

// --- 5. Non-object inputs never throw, always return ok:false.
for (const bad of [null, undefined, 42, "str", [], true]) {
  let threw = false, ok = true;
  try { ok = validateOrderEnvelope(bad).ok; } catch { threw = true; }
  check(`order rejects non-object ${JSON.stringify(bad)} without throwing`, !threw && ok === false);
}

// --- 6. failFast returns exactly one error; full mode can return several.
const multiBad = { schema: ORDER_V1_ID, orderId: "x", intent: "", scope: "", allowedActions: 1, forbiddenActions: 2, targetProject: 3, riskLevel: "nope", requiresReceipt: "no" };
check("failFast yields <=1 error", validateOrderEnvelope(multiBad, { failFast: true }).errors.length <= 1);
check("full mode yields >1 error", validateOrderEnvelope(multiBad).errors.length > 1);

// --- 7. The frozen v1 schema on disk still has schema const === v1 (sanity that we read the real file).
check("loadSchema reads frozen v1 order const", loadSchema("orange.order.v1.schema.json").properties.schema.const === ORDER_V1_ID);
check("loadSchema reads frozen v1 report const", loadSchema("orange.report.v1.schema.json").properties.schema.const === REPORT_V1_ID);

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
