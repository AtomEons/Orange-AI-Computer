#!/usr/bin/env node
// Light schema sanity: each schema is valid JSON + declares $id + $schema.
// Full ajv validation lands when ajv is sanctioned as a dep.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..");

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`));

const files = readdirSync(SCHEMA_DIR).filter(f => f.endsWith(".schema.json"));
assert(files.length >= 6, `at least 6 schemas present (got ${files.length})`);

for (const f of files) {
  const path = join(SCHEMA_DIR, f);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { fail++; console.log(`  FAIL ${f} — JSON parse: ${e.message}`); continue; }
  assert(parsed.$schema, `${f} declares $schema`);
  assert(parsed.$id, `${f} declares $id`);
  assert(parsed.title, `${f} declares title`);
  assert(parsed.type, `${f} declares type`);
}

console.log(`\n[schema-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
