#!/usr/bin/env node
// AECode parser tests.
// Real tests: round-trip a canonical AECode source, force errors, exercise each section parser.

import { parseAECode, validateAECode, AECODE_SECTIONS } from "./parser.mjs";

let pass = 0, fail = 0;
const T = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  -- " + extra : ""}`); }
};

// ---------------------------------------------------------------------------
// 1) Canonical happy-path source covering all 13 sections.
// ---------------------------------------------------------------------------
const CANONICAL = `---
identity:
  id: ae.orange5.aecode.smoke.v0
  owner: atom-mccree
  department: AE0
  version: 0.1.0
---

## product_intent

Ship the AECode compiler under Mom's Law. Real parser, real AST, real validator.

## operator_laws

- No fake green; receipts required.
- Operator pause always available.
- Mom's Law governs every output.

## scope

include:
  - 04-CONTROL-PLANE/aecode
  - 09-SCHEMAS/aecode-final-format.schema.json
exclude:
  - 19-ARCHIVE

## target_matrix

| target | lane |
|--------|------|
| parser | compiler |
| validator | compiler |
| router | dispatch |

## artifact_contracts

- name: parser.mjs
  path: 04-CONTROL-PLANE/aecode/parser.mjs
  shape: esm-module
- name: parser.test.mjs
  path: 04-CONTROL-PLANE/aecode/parser.test.mjs
  shape: esm-test

## data_contracts

- name: aecode-source
  format: markdown+yaml
- name: aecode-ast
  format: json

## behavior_graph

nodes:
  - id: parse
  - id: validate
  - id: compile
edges:
  - from: parse
    to: validate
  - from: validate
    to: compile

## permissions

allow:
  - read:04-CONTROL-PLANE
  - read:09-SCHEMAS
deny:
  - write:19-ARCHIVE

## model_roles

planner: opus
syntax: sonnet
verifier: haiku

## gauntlets

- id: schema_check
  type: deterministic
- id: round_trip
  type: deterministic
- id: error_paths
  type: deterministic

## receipts

receipt_path: 10-RECEIPTS/orange5-build/2026-06-25-aecode-parser.md
hash_chain: required
prior_receipt: 10-RECEIPTS/orange5-build/2026-06-24-prior.md

## rollback

strategy: revert_commit
window_hours: 24
`;

const parsed = parseAECode(CANONICAL);

T("parse: ok=true", parsed.ok, JSON.stringify(parsed.errors));
T("parse: no error-severity errors",
  parsed.errors.every(e => e.severity !== "error"),
  JSON.stringify(parsed.errors));

const ae = parsed.ast.aecode;

T("identity present from front matter",
  ae.identity?.id === "ae.orange5.aecode.smoke.v0");
T("identity preserves owner", ae.identity?.owner === "atom-mccree");
T("product_intent is string",
  typeof ae.product_intent === "string" && ae.product_intent.includes("Mom's Law"));
T("operator_laws is array of length 3",
  Array.isArray(ae.operator_laws) && ae.operator_laws.length === 3);
T("operator_laws[0] is string law",
  typeof ae.operator_laws[0] === "string" && ae.operator_laws[0].includes("fake green"));
T("scope.include is array",
  Array.isArray(ae.scope?.include) && ae.scope.include.length === 2);
T("scope.exclude has 19-ARCHIVE",
  ae.scope?.exclude?.[0] === "19-ARCHIVE");
T("target_matrix parsed as object",
  ae.target_matrix && typeof ae.target_matrix === "object");
T("target_matrix.parser.lane === compiler",
  ae.target_matrix?.parser?.lane === "compiler");
T("artifact_contracts is array of 2",
  Array.isArray(ae.artifact_contracts) && ae.artifact_contracts.length === 2);
T("artifact_contracts[0].name is parser.mjs",
  ae.artifact_contracts[0]?.name === "parser.mjs");
T("data_contracts is array of 2",
  Array.isArray(ae.data_contracts) && ae.data_contracts.length === 2);
T("behavior_graph is object with nodes",
  ae.behavior_graph && Array.isArray(ae.behavior_graph.nodes));
T("behavior_graph.nodes has 3 entries",
  ae.behavior_graph?.nodes?.length === 3);
T("behavior_graph.edges has 2 entries",
  ae.behavior_graph?.edges?.length === 2);
T("permissions.allow includes read:04-CONTROL-PLANE",
  Array.isArray(ae.permissions?.allow) && ae.permissions.allow.includes("read:04-CONTROL-PLANE"));
T("model_roles.planner === opus",
  ae.model_roles?.planner === "opus");
T("gauntlets has 3 steps",
  Array.isArray(ae.gauntlets) && ae.gauntlets.length === 3);
T("gauntlets[0].id === schema_check",
  ae.gauntlets[0]?.id === "schema_check");
T("receipts.receipt_path is set",
  typeof ae.receipts?.receipt_path === "string" && ae.receipts.receipt_path.includes("10-RECEIPTS"));
T("rollback.strategy === revert_commit",
  ae.rollback?.strategy === "revert_commit");
T("rollback.window_hours === 24 (numeric)",
  ae.rollback?.window_hours === 24);

// validation
const v = parsed.validate();
T("validate: ok=true", v.ok, JSON.stringify(v.errors));

// ---------------------------------------------------------------------------
// 2) Missing required section → must fail validation.
// ---------------------------------------------------------------------------
const MISSING_INTENT = CANONICAL.replace(/## product_intent[\s\S]*?(?=## operator_laws)/, "");
const r2 = parseAECode(MISSING_INTENT);
T("missing product_intent: parse.ok=false",
  r2.ok === false);
T("missing product_intent: error code present",
  r2.errors.some(e => e.code === "E_MISSING_SECTION" && /product_intent/.test(e.message)));

const v2 = r2.validate();
T("missing product_intent: validate.ok=false", v2.ok === false);
T("missing product_intent: validate error path",
  v2.errors.some(e => e.path === "$.product_intent"));

// ---------------------------------------------------------------------------
// 3) Bad type → validateAECode catches it.
// ---------------------------------------------------------------------------
const badShape = {
  identity: {}, product_intent: "x", operator_laws: "not-array",
  scope: {}, target_matrix: {}, artifact_contracts: [], data_contracts: [],
  behavior_graph: {}, permissions: {}, model_roles: {},
  gauntlets: [], receipts: {}, rollback: {},
};
const vBad = validateAECode(badShape);
T("validate: rejects non-array operator_laws",
  vBad.ok === false && vBad.errors.some(e => e.code === "E_TYPE" && e.path === "$.operator_laws"));

// ---------------------------------------------------------------------------
// 4) Empty product_intent rejected.
// ---------------------------------------------------------------------------
const vEmpty = validateAECode({ ...badShape, operator_laws: ["a"], product_intent: "   " });
T("validate: rejects empty product_intent",
  vEmpty.errors.some(e => e.code === "E_EMPTY_INTENT"));

// ---------------------------------------------------------------------------
// 5) Empty operator_laws rejected.
// ---------------------------------------------------------------------------
const vEmptyLaws = validateAECode({ ...badShape, operator_laws: [], product_intent: "x" });
T("validate: rejects empty operator_laws",
  vEmptyLaws.errors.some(e => e.code === "E_EMPTY_LAWS"));

// ---------------------------------------------------------------------------
// 6) Unclosed front matter is an error.
// ---------------------------------------------------------------------------
const unclosed = "---\nidentity:\n  id: x\n## product_intent\nhello";
const r6 = parseAECode(unclosed);
T("unclosed front matter: error reported",
  r6.errors.some(e => e.code === "E_FRONT_MATTER_UNCLOSED"));

// ---------------------------------------------------------------------------
// 7) Section aliases work.
// ---------------------------------------------------------------------------
const aliased = `## Identity
id: alias.test
## Product-Intent
alias intent body.
## Laws
- one law
## scope
include: [a]
## targets
| k | v |
|---|---|
| foo | bar |
## artifacts
- name: a
## data
- name: d
## graph
nodes: [a]
## permissions
allow: [r]
## models
planner: opus
## gauntlet
- step1
## receipt
path: p
## rollback
strategy: noop
`;
const rA = parseAECode(aliased);
T("aliases: parses without errors",
  rA.errors.every(e => e.severity !== "error"),
  JSON.stringify(rA.errors));
T("aliases: identity.id === alias.test",
  rA.ast.aecode.identity?.id === "alias.test");
T("aliases: gauntlets has 1 entry",
  Array.isArray(rA.ast.aecode.gauntlets) && rA.ast.aecode.gauntlets.length === 1);
T("aliases: target_matrix.foo.v === bar",
  rA.ast.aecode.target_matrix?.foo?.v === "bar");

// ---------------------------------------------------------------------------
// 8) AECODE_SECTIONS export covers all 13.
// ---------------------------------------------------------------------------
T("AECODE_SECTIONS length === 13", AECODE_SECTIONS.length === 13);
T("AECODE_SECTIONS includes all required",
  ["identity","product_intent","operator_laws","scope","target_matrix",
   "artifact_contracts","data_contracts","behavior_graph","permissions",
   "model_roles","gauntlets","receipts","rollback"]
    .every(k => AECODE_SECTIONS.includes(k)));

// ---------------------------------------------------------------------------
// 9) Strict mode throws on error.
// ---------------------------------------------------------------------------
let threw = false;
try { parseAECode("## product_intent\nhi", { strict: true }); }
catch (e) { threw = true; }
T("strict mode: throws on missing sections", threw);

// ---------------------------------------------------------------------------
// 10) JSON fenced blocks parse for object sections.
// ---------------------------------------------------------------------------
const fencedJson = CANONICAL.replace(
  /## permissions[\s\S]*?(?=## model_roles)/,
  "## permissions\n\n```json\n{\"allow\":[\"x\"],\"deny\":[]}\n```\n\n"
);
const rJ = parseAECode(fencedJson);
T("fenced json: permissions.allow[0] === x",
  rJ.ast.aecode.permissions?.allow?.[0] === "x");

// ---------------------------------------------------------------------------
console.log(`\n[aecode-parser-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
