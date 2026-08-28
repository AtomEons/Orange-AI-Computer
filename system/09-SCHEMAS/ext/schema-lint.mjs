#!/usr/bin/env bun
/**
 * schema-lint.mjs — quality linter for JSON Schema documents.
 *
 * ADDITIVE LANE LAW: READ-ONLY over the schema corpus. It reports findings; it
 * NEVER edits a schema. In particular it does not "fix" the frozen v1 schemas —
 * their findings are surfaced as advisory, and the CLI exit code is governed by
 * a caller-chosen severity gate (default: warn, so v1's known gaps do not fail
 * anything).
 *
 * Rules (each finding => { rule, severity, path, message }):
 *   missing-description   a property (or the root) has no `description`     warn
 *   unbounded-string      type includes "string" with no maxLength/enum/const/format/pattern   warn
 *   missing-required      an object with `properties` declares no `required` array              warn
 *   empty-required        `required` is present but an empty array          info
 *   required-not-in-props a name in `required` has no matching property     error
 *   open-object           object is additionalProperties:true (or default)  info
 *   no-title / no-id      root schema missing $id or title                  error
 *
 * `lintSchema(schema, {name})` returns { name, findings, counts }.
 * `severityGate` decides pass/fail: a run "fails" only if it contains a finding
 * at or above the gate severity. Default gate = "error" for exit code, so the
 * advisory warns on frozen v1 never break CI.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_DIR } from "./envelope-validate.mjs";
import { buildOrderV2Schema } from "./order-v2-additions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SEVERITY = Object.freeze({ info: 0, warn: 1, error: 2 });

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function typeIncludes(schema, t) {
  if (schema.type === undefined) return false;
  return Array.isArray(schema.type) ? schema.type.includes(t) : schema.type === t;
}

/** Does this subschema constrain a string's length/shape at all? */
function stringIsBounded(schema) {
  return (
    schema.maxLength !== undefined ||
    schema.enum !== undefined ||
    schema.const !== undefined ||
    schema.pattern !== undefined ||
    schema.format !== undefined
  );
}

/**
 * Recursively lint a schema node.
 * @param {object} schema
 * @param {object} [opts]
 * @param {string} [opts.name]  label for the schema (file name / id)
 * @param {boolean} [opts.requireDescriptions=true]
 * @returns {{name:string, findings:Array, counts:{info:number,warn:number,error:number}}}
 */
export function lintSchema(schema, opts = {}) {
  const name = opts.name ?? schema.$id ?? "(anonymous)";
  const requireDescriptions = opts.requireDescriptions !== false;
  const findings = [];
  const add = (rule, severity, path, message) =>
    findings.push({ rule, severity, path, message });

  // Root-level identity checks.
  if (!schema.$id) add("no-id", "error", "", "root schema is missing $id");
  if (!schema.title) add("no-title", "error", "", "root schema is missing title");

  walk(schema, "", true);

  function walk(node, path, isRoot) {
    if (!isObj(node)) return;

    // string bounds
    if (typeIncludes(node, "string") && !stringIsBounded(node)) {
      add(
        "unbounded-string",
        "warn",
        path || "/",
        "string type has no maxLength/enum/const/pattern/format bound"
      );
    }

    // object-shape checks
    if (isObj(node.properties)) {
      if (!Array.isArray(node.required)) {
        add(
          "missing-required",
          "warn",
          path || "/",
          "object declares `properties` but no `required` array"
        );
      } else {
        if (node.required.length === 0) {
          add("empty-required", "info", path || "/", "`required` is an empty array");
        }
        for (const r of node.required) {
          if (!Object.hasOwn(node.properties, r)) {
            add(
              "required-not-in-props",
              "error",
              `${path}/required`,
              `required name "${r}" has no matching property`
            );
          }
        }
      }
      // additionalProperties openness (info only)
      if (node.additionalProperties === undefined || node.additionalProperties === true) {
        add("open-object", "info", path || "/", "object is open (additionalProperties not false)");
      }
      // recurse into each property, and check for descriptions
      for (const [k, sub] of Object.entries(node.properties)) {
        const subPath = `${path}/properties/${k}`;
        if (requireDescriptions && isObj(sub) && sub.description === undefined && sub.$ref === undefined) {
          // const/enum discriminators are self-documenting; still flag as advisory
          add("missing-description", "warn", subPath, `property "${k}" has no description`);
        }
        walk(sub, subPath, false);
      }
    }

    // array items
    if (isObj(node.items)) walk(node.items, `${path}/items`, false);

    // applicators
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(node[key])) node[key].forEach((s, i) => walk(s, `${path}/${key}/${i}`, false));
    }
    for (const key of ["not", "if", "then", "else"]) {
      if (isObj(node[key])) walk(node[key], `${path}/${key}`, false);
    }
    if (isObj(node.$defs)) {
      for (const [k, sub] of Object.entries(node.$defs)) walk(sub, `${path}/$defs/${k}`, false);
    }
  }

  const counts = { info: 0, warn: 0, error: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { name, findings, counts };
}

/** Lint every *.schema.json in the schema dir + the generated v2 (in memory). */
export function lintCorpus(opts = {}) {
  const results = [];
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));
  for (const f of files) {
    let schema;
    try {
      schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
    } catch (e) {
      results.push({ name: f, findings: [{ rule: "parse", severity: "error", path: "", message: e.message }], counts: { info: 0, warn: 0, error: 1 } });
      continue;
    }
    results.push(lintSchema(schema, { ...opts, name: f }));
  }
  // the generated v2 (not on disk)
  results.push(lintSchema(buildOrderV2Schema(), { ...opts, name: "orange.order.v2 (generated)" }));
  return results;
}

/** True if any finding meets/exceeds the gate severity. */
export function failsGate(results, gate = "error") {
  const threshold = SEVERITY[gate];
  return results.some((r) => r.findings.some((f) => SEVERITY[f.severity] >= threshold));
}

// ---------------------------------------------------------------------------
// CLI: bun schema-lint.mjs [--gate info|warn|error] [--quiet]
//   prints findings; exit non-zero only if the gate is tripped (default error).
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const gateIdx = args.indexOf("--gate");
  const gate = gateIdx !== -1 ? args[gateIdx + 1] : "error";
  const quiet = args.includes("--quiet");
  const results = lintCorpus();
  let totals = { info: 0, warn: 0, error: 0 };
  for (const r of results) {
    for (const s of ["info", "warn", "error"]) totals[s] += r.counts[s];
    if (!quiet && r.findings.length) {
      console.log(`\n${r.name}  (info:${r.counts.info} warn:${r.counts.warn} error:${r.counts.error})`);
      for (const f of r.findings) console.log(`  [${f.severity}] ${f.rule} @ ${f.path || "/"} — ${f.message}`);
    }
  }
  console.log(`\n[schema-lint] totals — info:${totals.info} warn:${totals.warn} error:${totals.error} (gate: ${gate})`);
  process.exit(failsGate(results, gate) ? 1 : 0);
}
