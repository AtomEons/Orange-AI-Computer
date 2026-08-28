#!/usr/bin/env bun
/**
 * test-schema-doc-gen.mjs — proves the markdown generator is deterministic,
 * covers every field of the frozen v1 schemas, and reflects the v2 additions.
 * Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import { renderSchemaDoc, generateSchemaDocs } from "../schema-doc-gen.mjs";
import { loadSchema, ORDER_V1_ID, ORDER_V2_ID, REPORT_V1_ID } from "../envelope-validate.mjs";
import { buildOrderV2Schema, V2_FIELD_NAMES } from "../order-v2-additions.mjs";

let pass = 0, fail = 0, total = 0;
const check = (name, cond) => { total++; cond ? pass++ : (fail++, console.log(`  FAIL ${name}`)); };

const orderV1 = loadSchema("orange.order.v1.schema.json");
const reportV1 = loadSchema("orange.report.v1.schema.json");
const md = generateSchemaDocs();

// --- 1. Output is non-trivial markdown with the three sections.
check("doc is a non-empty string", typeof md === "string" && md.length > 500);
check("has top-level heading", md.startsWith("# Orange5 Order & Report Schemas"));
check("mentions Orange Order v1 title", md.includes("## Orange Order v1"));
check("mentions Orange Report v1 title", md.includes("## Orange Report v1"));
check("mentions Orange Order v2 title", md.includes("## Orange Order v2"));

// --- 2. Every v1 order property name appears in the doc.
for (const k of Object.keys(orderV1.properties)) {
  check(`doc mentions order.v1 field "${k}"`, md.includes("`" + k + "`"));
}
// --- 3. Every v1 report property name appears.
for (const k of Object.keys(reportV1.properties)) {
  check(`doc mentions report.v1 field "${k}"`, md.includes("`" + k + "`"));
}
// --- 4. Every v2 addition appears.
for (const k of V2_FIELD_NAMES) {
  check(`doc mentions v2 addition "${k}"`, md.includes("`" + k + "`"));
}
check("doc mentions x_migration", md.includes("`x_migration`"));

// --- 5. Required markers rendered: orderId is required -> row shows "yes".
{
  const single = renderSchemaDoc(orderV1);
  // find the orderId row and confirm a required "yes"
  const line = single.split("\n").find((l) => l.startsWith("| `orderId`"));
  check("orderId row exists", !!line);
  check("orderId marked required=yes", !!line && /\|\s*yes\s*\|/.test(line));
  const optLine = single.split("\n").find((l) => l.startsWith("| `operatorApproved`"));
  check("operatorApproved marked required=no", !!optLine && /\|\s*no\s*\|/.test(optLine));
}

// --- 6. Risk enum surfaced in constraints for riskLevel.
{
  const single = renderSchemaDoc(orderV1);
  const line = single.split("\n").find((l) => l.startsWith("| `riskLevel`"));
  check("riskLevel row shows enum options", !!line && line.includes("production"));
}

// --- 7. Nested budget object fields rendered as a sub-table in v2.
{
  const single = renderSchemaDoc(buildOrderV2Schema());
  check("v2 doc renders budget sub-table header", single.includes("**`budget`** object fields"));
  check("v2 budget sub-table lists max_tokens", single.includes("`max_tokens`"));
}

// --- 8. DETERMINISM: generating twice yields byte-identical output.
check("generation is deterministic", generateSchemaDocs() === md);

// --- 9. Table escaping: every field data row has exactly 6 column separators.
//        Count only REAL separators — strip escaped pipes (\|) first so a cell
//        value that legitimately escapes a pipe can't be miscounted.
{
  const rows = md.split("\n").filter((l) => l.startsWith("| `"));
  const sepCount = (r) => (r.replaceAll("\\|", "").match(/\|/g) || []).length;
  const allSixCols = rows.every((r) => sepCount(r) === 6);
  check(`all ${rows.length} field rows have 6 column separators`, allSixCols);
  // and no cell should contain a raw (unescaped) pipe at all, given our renderer
  const noRawPipe = rows.every((r) => !r.replaceAll("\\|", "").slice(1, -1).includes("|") ? true : sepCount(r) === 6);
  check("no field row has a stray raw pipe", noRawPipe);
}

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
