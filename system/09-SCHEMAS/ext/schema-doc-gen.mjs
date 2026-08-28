#!/usr/bin/env bun
/**
 * schema-doc-gen.mjs — render human-readable Markdown from JSON Schema docs.
 *
 * ADDITIVE LANE LAW: READS schema files (frozen v1 on disk + the in-memory v2
 * from order-v2-additions.mjs) and RETURNS markdown strings. Writes nothing to
 * disk unless the CLI is given an explicit output path.
 *
 * Renders, per schema:
 *   - title, $id, description
 *   - a properties table: name | required | type | constraints | description
 *   - nested object properties (one level, indented) for objects like `budget`
 *   - a "additionalProperties" note
 *
 * The generator is deliberately dependency-free and deterministic: the same
 * schema always produces the same markdown (stable property order = insertion
 * order of the schema's `properties`). test-schema-doc-gen.mjs asserts the
 * frozen v1 fields all appear and that generation is stable.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_DIR } from "./envelope-validate.mjs";
import { buildOrderV2Schema } from "./order-v2-additions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Escape a cell value for GitHub-flavoured Markdown tables. */
function cell(s) {
  return String(s).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** Render a `type` field (string or array) into a readable string.
 *  Union types use " / " (not "|") so no literal pipe ever enters a table cell. */
function renderType(schema) {
  if (schema.const !== undefined) return `const \`${JSON.stringify(schema.const)}\``;
  if (schema.enum !== undefined) return `enum`;
  if (schema.type === undefined) return "(any)";
  return Array.isArray(schema.type) ? schema.type.join(" / ") : schema.type;
}

/** Collect the constraint keywords on a property into a compact string. */
function renderConstraints(schema) {
  const parts = [];
  const push = (k, label = k) => {
    if (schema[k] !== undefined) parts.push(`${label}: ${JSON.stringify(schema[k])}`);
  };
  if (schema.enum !== undefined) parts.push(`one of ${JSON.stringify(schema.enum)}`);
  push("minLength");
  push("maxLength");
  push("pattern");
  push("minimum", "min");
  push("maximum", "max");
  push("exclusiveMinimum", "exclMin");
  push("exclusiveMaximum", "exclMax");
  push("minItems");
  push("maxItems");
  if (schema.uniqueItems) parts.push("uniqueItems");
  push("minProperties");
  push("maxProperties");
  if (schema.format !== undefined) parts.push(`format: ${schema.format} (annotation)`);
  if (schema.items !== undefined && typeof schema.items === "object") {
    parts.push(`items: ${renderType(schema.items)}`);
  }
  if (schema.additionalProperties === false) parts.push("no extra props");
  return parts.join("; ") || "—";
}

/** Render one properties table (+ optional nested-object sub-tables). */
function renderPropsTable(schema) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return "_No properties defined._\n";

  const lines = [];
  lines.push("| Field | Required | Type | Constraints | Description |");
  lines.push("| --- | --- | --- | --- | --- |");
  const nested = [];
  for (const name of names) {
    const p = props[name];
    lines.push(
      `| \`${cell(name)}\` | ${required.has(name) ? "yes" : "no"} | ${cell(
        renderType(p)
      )} | ${cell(renderConstraints(p))} | ${cell(p.description ?? "")} |`
    );
    // one level of nested object properties
    if (p && typeof p === "object" && p.properties) {
      nested.push([name, p]);
    }
  }

  let out = lines.join("\n") + "\n";
  for (const [name, p] of nested) {
    out += `\n**\`${name}\`** object fields:\n\n`;
    out += renderPropsTable(p);
  }
  return out;
}

/**
 * Render a full Markdown section for one schema object.
 * @param {object} schema a JSON Schema
 * @returns {string} markdown
 */
export function renderSchemaDoc(schema) {
  const title = schema.title ?? schema.$id ?? "(untitled schema)";
  const out = [];
  out.push(`## ${title}`);
  out.push("");
  if (schema.$id) out.push(`- **\`$id\`**: \`${schema.$id}\``);
  if (schema.type) out.push(`- **type**: \`${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}\``);
  out.push(
    `- **additionalProperties**: \`${
      schema.additionalProperties === undefined ? "true (default)" : JSON.stringify(schema.additionalProperties)
    }\``
  );
  out.push("");
  if (schema.description) {
    out.push(schema.description);
    out.push("");
  }
  if (schema.required && schema.required.length) {
    out.push(`**Required:** ${schema.required.map((r) => `\`${r}\``).join(", ")}`);
    out.push("");
  }
  out.push(renderPropsTable(schema));
  return out.join("\n");
}

/**
 * Build the full "Orange5 Order/Report Schemas" markdown document covering the
 * frozen v1 order, the frozen v1 report, and the generated v2 order.
 * @returns {string} the complete markdown document
 */
export function generateSchemaDocs() {
  const orderV1 = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "orange.order.v1.schema.json"), "utf8")
  );
  const reportV1 = JSON.parse(
    readFileSync(join(SCHEMA_DIR, "orange.report.v1.schema.json"), "utf8")
  );
  const orderV2 = buildOrderV2Schema();

  const parts = [];
  parts.push("# Orange5 Order & Report Schemas");
  parts.push("");
  parts.push(
    "_Generated by `09-SCHEMAS/ext/schema-doc-gen.mjs`. Do not edit by hand — regenerate._"
  );
  parts.push("");
  parts.push(
    "The v1 schemas are frozen. `orange.order.v2` is a backward-compatible superset generated from v1 plus the optional additions in `order-v2-additions.mjs`."
  );
  parts.push("");
  parts.push(renderSchemaDoc(orderV1));
  parts.push("");
  parts.push(renderSchemaDoc(reportV1));
  parts.push("");
  parts.push(renderSchemaDoc(orderV2));
  parts.push("");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI: bun schema-doc-gen.mjs [-o out.md]
//   default: print the generated markdown to stdout
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("-o");
  const out = outIdx !== -1 ? args[outIdx + 1] : null;
  const md = generateSchemaDocs();
  if (out) {
    writeFileSync(out, md);
    console.log(`wrote ${out} (${md.length} bytes)`);
  } else {
    process.stdout.write(md);
  }
}
