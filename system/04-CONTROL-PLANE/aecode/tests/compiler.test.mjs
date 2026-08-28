#!/usr/bin/env node
// AECode compiler tests — parser, validator, router, full compile.
import {
  parse, validate, compile, compileSource,
  aelangHighToCore, aelangCoreToRoutePacket,
  REQUIRED_SECTIONS, RISK_LEVELS, DEPARTMENTS,
  ParseError, ValidationError, __internal,
} from "../compiler.mjs";

let pass = 0, fail = 0;
const assert = (c, m) => c
  ? (pass++, console.log(`  PASS ${m}`))
  : (fail++, console.log(`  FAIL ${m}`));

process.env.AECODE_DETERMINISTIC_IDS = "1";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
function fullSections(overrides = {}) {
  return {
    identity: { id: "orange5.compiler", project: "Orange5", name: "AECode Compiler" },
    product_intent: "Compile AECode AST into mission contract + target plan.",
    operator_laws: [
      "receipts only, no theater",
      "no silent fallback",
      "human final stop authority reachable",
    ],
    scope: {
      summary: "compile AECode → mission + target plan",
      allowed_paths: ["04-CONTROL-PLANE/aecode/"],
      forbidden_paths: ["02-APP/", "10-RECEIPTS/"],
      allowed_actions: ["read", "write_inside_scope"],
      forbidden_actions: ["force_push", "drop_table"],
      risk: "low",
      aelang_high: "compile aecode -> mission",
    },
    target_matrix: {
      targets: [
        { lang: "javascript", runtime: "node>=20", build_cmd: "node compiler.mjs",
          test_cmd: "node tests/compiler.test.mjs" },
        { lang: "typescript", runtime: "node>=20" },
      ],
    },
    artifact_contracts: [
      { name: "compiler.mjs", target: "all", required: true },
      { name: "types.d.ts", target: "typescript" },
    ],
    data_contracts: [
      { name: "aecode.ast.v0", target: "all", shape: "{kind, source_hash, sections}" },
    ],
    behavior_graph: {
      nodes: [
        { id: "parse",    kind: "edit", files: ["compiler.mjs"] },
        { id: "validate", kind: "edit", files: ["compiler.mjs"] },
        { id: "compile",  kind: "edit", files: ["compiler.mjs"] },
        { id: "test",     kind: "verify", files: ["tests/compiler.test.mjs"] },
      ],
      edges: [
        { from: "parse",    to: "validate" },
        { from: "validate", to: "compile" },
        { from: "compile",  to: "test" },
      ],
    },
    permissions: {
      allow_read: true,
      allow_write: true,
      allow_delete: false,
      require_human_approval: false,
    },
    model_roles: {
      lane: "subscription_cli",
      default_adapter: "mock-local-deterministic",
      adapter_by_lang: { javascript: "mock-local-deterministic" },
    },
    gauntlets: [
      {
        id: "compile-gauntlet",
        gates: [
          { id: "schema", name: "schema integrity", kind: "deterministic", blocking: true },
          { id: "tests",  name: "tests green",     kind: "execute",       blocking: true },
        ],
      },
    ],
    receipts: {
      required: true,
      emit_on: ["compile", "patch", "gauntlet", "promote"],
      writer: "control-plane",
    },
    rollback: {
      strategy: "git_reset_hard",
      checkpoint: "pre_patch_head",
      verify: "smoke_test",
      triggers: ["gauntlet_fail", "operator_abort"],
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parser — JSON form
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[parser/json]");
{
  const ast = parse(JSON.stringify(fullSections()));
  assert(ast.kind === "aecode.v0", "AST kind is aecode.v0");
  assert(typeof ast.source_hash === "string" && ast.source_hash.length === 64,
    "source_hash is 64-hex SHA-256");
  assert(ast.sections.product_intent.startsWith("Compile AECode"),
    "sections.product_intent round-trips");
  assert(REQUIRED_SECTIONS.every(n => n in ast.sections),
    "all 13 required sections present in AST");
}
{
  // pre-parsed object also accepted
  const ast = parse(fullSections());
  assert(ast.kind === "aecode.v0", "object input → AST");
  assert(ast.sections.identity.id === "orange5.compiler",
    "identity round-trips from object input");
}
{
  // {sections: {...}} envelope accepted
  const ast = parse({ sections: fullSections() });
  assert("identity" in ast.sections, "envelope shape normalized");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Parser — line form
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[parser/line-form]");
{
  const src = `
# comment
:identity
  id = orange5.compiler
  name = AECode Compiler
:product_intent
  text = compile AECode
:operator_laws
  - receipts only
  - no silent fallback
`;
  // line-form is partial coverage of sections; just probe the mechanics.
  const ast = parse(src);
  assert(ast.sections.identity.id === "orange5.compiler",
    "line-form parses key=value");
  assert(Array.isArray(ast.sections.operator_laws) &&
    ast.sections.operator_laws.length === 2,
    "line-form parses '-' list items");
  assert(ast.sections.product_intent.text === "compile AECode",
    "line-form section becomes object");
}
{
  // mixed list + kv must throw
  let threw = false;
  try {
    parse(`:operator_laws\n  - one\n  key = val\n`);
  } catch (e) { threw = e instanceof ParseError; }
  assert(threw, "mixing list and kv in one section is a ParseError");
}
{
  let threw = false;
  try { parse(""); } catch (e) { threw = e instanceof ParseError; }
  assert(threw, "empty source is a ParseError");
}
{
  // scalar coercion
  assert(__internal.coerceScalar("true") === true, "coerce true");
  assert(__internal.coerceScalar("42") === 42, "coerce integer");
  assert(__internal.coerceScalar("3.14") === 3.14, "coerce float");
  assert(__internal.coerceScalar('"hello"') === "hello", "coerce quoted string");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validator
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[validator]");
{
  const v = validate(parse(fullSections()));
  assert(v.ok === true, "full sections validate clean");
  assert(v.errors.length === 0, "no errors on full sections");
}
{
  // missing required section
  const s = fullSections(); delete s.gauntlets;
  const v = validate(parse(s));
  assert(v.ok === false, "missing gauntlets fails validation");
  assert(v.errors.some(e => e.code === "missing_section" && e.section === "gauntlets"),
    "error names the missing section");
}
{
  // empty section
  const s = fullSections(); s.operator_laws = [];
  const v = validate(parse(s));
  assert(v.ok === false && v.errors.some(e => e.code === "empty_section"),
    "empty operator_laws fails as empty_section");
}
{
  // wrong type
  const s = fullSections(); s.operator_laws = "not an array";
  const v = validate(parse(s));
  assert(v.ok === false && v.errors.some(e => e.code === "wrong_type"),
    "non-array operator_laws fails as wrong_type");
}
{
  // bad risk enum
  const s = fullSections(); s.scope.risk = "nuclear";
  const v = validate(parse(s));
  assert(v.ok === false && v.errors.some(e => e.code === "bad_enum"),
    "unknown risk value fails as bad_enum");
}
{
  // no targets
  const s = fullSections(); s.target_matrix.targets = [];
  const v = validate(parse(s));
  assert(v.ok === false && v.errors.some(e => e.code === "no_targets"),
    "empty target list fails as no_targets");
}
{
  // identity needs id or name
  const s = fullSections(); s.identity = { project: "x" };
  const v = validate(parse(s));
  assert(v.ok === false && v.errors.some(e => e.code === "identity_no_id"),
    "identity without id/name fails");
}
{
  // bad ast
  const v = validate({ kind: "wrong" });
  assert(v.ok === false && v.errors.some(e => e.code === "bad_ast"),
    "non-AECode AST is rejected");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. AELang router
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[aelang]");
{
  const core = aelangHighToCore("compile aecode -> mission");
  assert(core.verb === "compile", "aelang verb extracted");
  assert(core.department === "AE6_CODE", "compile routes to AE6_CODE");
  assert(core.object === "aecode", "object extracted before '->'");
}
{
  const core = aelangHighToCore("audit secrets");
  assert(core.department === "AE11_SECURITY", "audit routes to AE11_SECURITY");
}
{
  const core = aelangHighToCore("research market");
  assert(core.department === "AE2_RESEARCH", "research routes to AE2_RESEARCH");
}
{
  const core = aelangHighToCore("xenoglossy frobnicate");
  assert(core.department === "AE6_CODE", "unknown verb defaults to AE6_CODE");
}
{
  let threw = false;
  try { aelangHighToCore(""); } catch (e) { threw = e instanceof ValidationError; }
  assert(threw, "empty aelang-high throws ValidationError");
}
{
  const core = aelangHighToCore("compile aecode");
  const pkt = aelangCoreToRoutePacket(core, { adapter_hint: "mock-local-deterministic" });
  assert(pkt.schema === "ae.route_packet.v0", "route packet schema set");
  assert(pkt.department === "AE6_CODE", "route packet keeps department");
  assert(pkt.adapter_hint === "mock-local-deterministic",
    "route packet honors adapter hint");
}
{
  assert(DEPARTMENTS.length === 15, "AE0-AE14 = 15 departments declared");
  assert(DEPARTMENTS[0] === "AE0_FACTORY" && DEPARTMENTS[6] === "AE6_CODE",
    "departments indexed correctly");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Compile — full bundle
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[compile]");
{
  const bundle = compileSource(fullSections());

  // order — orange.order.v1
  assert(bundle.order.schema === "orange.order.v1", "order schema set");
  assert(RISK_LEVELS.includes(bundle.order.riskLevel), "order risk in lattice");
  assert(bundle.order.requiresReceipt === true, "order requires receipt by default");
  assert(bundle.order.targetProject === "Orange5",
    "order targetProject derived from identity.project");
  assert(typeof bundle.order.createdAt === "string", "order has createdAt");

  // mission — ae.mission.v0
  assert(typeof bundle.mission.mission_id === "string", "mission has id");
  assert(bundle.mission.target.lang === "javascript",
    "mission picks first target as primary");
  assert(bundle.mission.allowed_paths.includes("04-CONTROL-PLANE/aecode/"),
    "mission inherits allowed_paths");
  assert(bundle.mission.receipt_plan.required === true,
    "mission.receipt_plan required");
  assert(bundle.mission.rollback_plan.strategy === "git_reset_hard",
    "mission.rollback_plan strategy threaded through");

  // target plan
  assert(Array.isArray(bundle.targetPlan) && bundle.targetPlan.length === 2,
    "target plan has 2 entries");
  assert(bundle.targetPlan[0].lang === "javascript", "first target is javascript");
  assert(bundle.targetPlan[0].adapter === "mock-local-deterministic",
    "javascript adapter from adapter_by_lang");
  assert(bundle.targetPlan[1].adapter === "mock-local-deterministic",
    "typescript adapter from default_adapter");
  assert(bundle.targetPlan[0].artifact_contracts.length === 1,
    "compiler.mjs contract attached to javascript target");
  assert(bundle.targetPlan[1].artifact_contracts.length === 2,
    "typescript target also gets all+typescript contracts");

  // patch plan — topo order
  assert(bundle.patchPlan.steps.length === 4, "patch plan has 4 steps (one per node)");
  const stepNodes = bundle.patchPlan.steps.map(s => s.node);
  assert(stepNodes[0] === "parse" && stepNodes[3] === "test",
    "topo sort respects edges");

  // gauntlet steps
  assert(bundle.gauntletSteps.length === 2, "gauntlet flattened to 2 gate steps");
  assert(bundle.gauntletSteps[0].blocking === true,
    "gauntlet step inherits blocking flag");

  // receipt plan
  const stages = new Set(bundle.receiptPlan.planned.map(p => p.stage));
  assert(stages.has("compile") && stages.has("patch") &&
         stages.has("gauntlet") && stages.has("promote"),
    "receipt plan covers all 4 emit_on stages");
  assert(bundle.receiptPlan.hash_chain_required === true,
    "receipt plan requires hash chain");

  // rollback plan
  assert(bundle.rollbackPlan.strategy === "git_reset_hard", "rollback strategy");
  assert(bundle.rollbackPlan.revert_steps.length === bundle.patchPlan.steps.length,
    "every patch step has a revert step");
  assert(bundle.rollbackPlan.revert_steps[0].reverts ===
         bundle.patchPlan.steps[bundle.patchPlan.steps.length - 1].step_id,
    "revert order is reverse of patch order");

  // aelang
  assert(bundle.aelangCore && bundle.aelangCore.verb === "compile",
    "scope.aelang_high compiled to core");

  // compiler stamp
  assert(typeof bundle.compiler.version === "string", "compiler version stamped");
  assert(typeof bundle.compiler.source_hash === "string" &&
         bundle.compiler.source_hash.length === 64,
    "compiler stamps source_hash");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Compile — risk inference + failure modes
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[compile/risk + failure]");
{
  const s = fullSections();
  delete s.scope.risk;
  s.permissions = { allow_delete: true };
  const b = compileSource(s);
  assert(b.order.riskLevel === "destructive",
    "allow_delete → destructive risk");
}
{
  const s = fullSections();
  delete s.scope.risk;
  s.permissions = { allow_read_only: true };
  const b = compileSource(s);
  assert(b.order.riskLevel === "read_only", "allow_read_only → read_only risk");
}
{
  // compile must throw when validation fails
  let threw = null;
  try {
    const s = fullSections();
    delete s.rollback;
    compileSource(s);
  } catch (e) { threw = e; }
  assert(threw instanceof ValidationError, "compile throws ValidationError on bad input");
  assert(Array.isArray(threw.errors) && threw.errors.length > 0,
    "thrown error carries an errors[] list");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Topo sort — internal
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[topo-sort]");
{
  const order = __internal.topoSort(
    [{id:"a"}, {id:"b"}, {id:"c"}],
    [{from:"a",to:"b"}, {from:"b",to:"c"}],
  );
  assert(JSON.stringify(order) === '["a","b","c"]', "linear topo sort");
}
{
  // cycle — function returns the original order rather than throwing,
  // but the result still has every id (no silent drop).
  const order = __internal.topoSort(
    [{id:"a"}, {id:"b"}],
    [{from:"a",to:"b"}, {from:"b",to:"a"}],
  );
  assert(order.length === 2, "cycle preserves node count");
}

// ─────────────────────────────────────────────────────────────────────────────
// summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n[aecode-compiler-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
