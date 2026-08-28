#!/usr/bin/env bun
/**
 * test-schema-lint.mjs — proves the linter detects the conditions it claims
 * (missing descriptions, unbounded strings, missing/broken required arrays)
 * on crafted inputs, and that it is READ-ONLY / advisory over the frozen v1
 * corpus (never errors on it). Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import { lintSchema, lintCorpus, failsGate, SEVERITY } from "../schema-lint.mjs";
import { buildOrderV2Schema } from "../order-v2-additions.mjs";
import { loadSchema } from "../envelope-validate.mjs";

let pass = 0, fail = 0, total = 0;
const check = (name, cond) => { total++; cond ? pass++ : (fail++, console.log(`  FAIL ${name}`)); };

const has = (res, rule, path) =>
  res.findings.some((f) => f.rule === rule && (path === undefined || f.path === path));

// --- 1. missing-description: a property with no description is flagged.
{
  const s = {
    $schema: "x", $id: "t.missing.desc", title: "T", type: "object",
    required: ["a"],
    properties: { a: { type: "string", maxLength: 10 } }, // no description
    additionalProperties: false,
  };
  const res = lintSchema(s);
  check("flags missing-description", has(res, "missing-description", "/properties/a"));
}

// --- 2. unbounded-string: a string with no maxLength/enum/const/pattern/format.
{
  const s = {
    $schema: "x", $id: "t.unbounded", title: "T", type: "object",
    required: ["a"],
    properties: { a: { type: "string", description: "d" } },
    additionalProperties: false,
  };
  const res = lintSchema(s);
  check("flags unbounded-string", has(res, "unbounded-string", "/properties/a"));

  // bounded string (maxLength) is NOT flagged
  const s2 = { ...s, properties: { a: { type: "string", maxLength: 5, description: "d" } } };
  check("does not flag bounded string", !has(lintSchema(s2), "unbounded-string"));
  // enum-bounded string not flagged
  const s3 = { ...s, properties: { a: { type: "string", enum: ["x", "y"], description: "d" } } };
  check("does not flag enum string", !has(lintSchema(s3), "unbounded-string"));
}

// --- 3. missing-required: object with properties but no required array.
{
  const s = {
    $schema: "x", $id: "t.noreq", title: "T", type: "object",
    properties: { a: { type: "string", maxLength: 3, description: "d" } },
    additionalProperties: false,
  };
  check("flags missing-required", has(lintSchema(s), "missing-required"));
}

// --- 4. required-not-in-props: a required name with no property is an ERROR.
{
  const s = {
    $schema: "x", $id: "t.badreq", title: "T", type: "object",
    required: ["ghost"],
    properties: { a: { type: "string", maxLength: 3, description: "d" } },
    additionalProperties: false,
  };
  const res = lintSchema(s);
  check("flags required-not-in-props", has(res, "required-not-in-props"));
  check("required-not-in-props is severity error", res.findings.some((f) => f.rule === "required-not-in-props" && f.severity === "error"));
  check("failsGate(error) true for broken required", failsGate([res], "error"));
}

// --- 5. no-id / no-title on root are errors.
{
  const res = lintSchema({ type: "object", properties: {}, additionalProperties: false });
  check("flags no-id", has(res, "no-id"));
  check("flags no-title", has(res, "no-title"));
}

// --- 6. A clean schema (all descriptions, bounded, required present) yields no warn/error.
{
  const clean = {
    $schema: "x", $id: "t.clean", title: "Clean", type: "object",
    description: "root desc",
    required: ["a", "b"],
    properties: {
      a: { type: "string", maxLength: 8, description: "a field" },
      b: { type: "integer", minimum: 0, description: "b field" },
    },
    additionalProperties: false,
  };
  const res = lintSchema(clean);
  check("clean schema has no warnings", res.counts.warn === 0);
  check("clean schema has no errors", res.counts.error === 0);
  check("clean schema passes error gate", !failsGate([res], "error"));
  check("clean schema passes warn gate", !failsGate([res], "warn"));
}

// --- 7. READ-ONLY / advisory over the real corpus: the frozen v1 schemas may
//        warn (they lack descriptions) but MUST NOT produce lint ERRORS, and
//        the default error-gate must pass for the whole corpus.
{
  const results = lintCorpus();
  check("corpus lints >= 12 schemas", results.length >= 12);
  const v1order = results.find((r) => r.name === "orange.order.v1.schema.json");
  const v1report = results.find((r) => r.name === "orange.report.v1.schema.json");
  check("v1 order present in corpus lint", !!v1order);
  check("v1 report present in corpus lint", !!v1report);
  check("v1 order has 0 lint errors", v1order.counts.error === 0);
  check("v1 report has 0 lint errors", v1report.counts.error === 0);
  check("whole corpus passes error gate (no schema errors)", !failsGate(results, "error"));
  // generated v2 appears and is error-clean too
  const v2 = results.find((r) => r.name.startsWith("orange.order.v2"));
  check("generated v2 present in corpus lint", !!v2);
  check("generated v2 has 0 lint errors", v2.counts.error === 0);
}

// --- 8. Sanity: frozen v1 order really is description-light (justifies advisory
//        stance) — confirms we are linting the real file, not a stub.
{
  const raw = loadSchema("orange.order.v1.schema.json");
  const anyDesc = Object.values(raw.properties).some((p) => p && p.description !== undefined);
  check("frozen v1 order has no property descriptions (advisory warns expected)", anyDesc === false);
}

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
