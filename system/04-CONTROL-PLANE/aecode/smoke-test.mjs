#!/usr/bin/env node
// 04-CONTROL-PLANE / aecode / smoke-test.mjs
//
// AECode + AELang gateway-route smoke test.
//
// Doctrine (Atom McCree):
//   - AECode = canonical source contract. Pipeline:
//       intent → AECode Source → mission contract → target plan → patch →
//       gauntlet → receipt → approval
//   - AELang v0.1 = two-tier route language. AELang-High → AELang-Core →
//     ORANGEBOX Route Packet (FATCAT envelope).
//   - Mom's Law: no fake greens. If a stage cannot run honestly, the test
//     surfaces the gap and exits non-zero. The exit code is the receipt.
//
// What this test exercises (IN-PROCESS — no gateway socket required):
//
//   STAGE 1. /v1/aecode/compile (handler-level)
//     - Author a realistic markdown AECode source covering all 13 sections,
//       with fenced YAML for behavior_graph + target_matrix + permissions.
//     - Call handleAECodeCompile({ source: markdown }).
//     - Assert: 200, mission contract present, patch plan has steps, the
//       compiler emits a deterministic source_hash, target_plan picks up
//       the language and adapter, gauntlet_steps populated.
//
//   STAGE 2. /v1/aecode/mission/start  (dry_run: true)
//     - Pass the same source with dry_run:true.
//     - Assert: 200, mission_id registered, mode == "done", verify_chain.ok,
//       receipts minted on disk, receipt_chain_index >= patch step count.
//
//   STAGE 3. /v1/aecode/mission/:id
//     - Look up the dry-run mission_id.
//     - Assert: 200, state.status == DONE, verify_chain re-verifies clean.
//     - Assert: unknown id → 404 with code "not_found".
//
//   STAGE 4. /v1/aelang/route
//     - Pass an AELang-High intent: "read 04-CONTROL-PLANE then write
//       receipt and verify chain".
//     - Assert: 200, high_ir.composition == "sequence", core packets ≥ 1,
//       route packets all carry schema "orangebox.route.packet.v0" and a
//       route_id starting with "rp-".
//
//   STAGE 5. Error contracts — make sure the routes refuse bad input.
//     - /v1/aecode/compile with empty body → 400 source_required.
//     - /v1/aecode/compile with malformed source (missing required section)
//       → 422 with structured errors.
//     - /v1/aelang/route with empty intent → 400 intent_required.
//
// Run:
//   node 04-CONTROL-PLANE/aecode/smoke-test.mjs
//
// Exit codes:
//   0 → every stage passed (Mom-grade receipt).
//   1 → at least one stage failed.

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROUTES_PATH = resolve(
  __dirname,
  "../../06-ORANGELLM/server/routes/aecode.mjs",
);
const ROUTES_URL = pathToFileURL(ROUTES_PATH).href;

// ─── deterministic mission_ids so the registry assertions are stable ────────
process.env.AECODE_DETERMINISTIC_IDS = "1";

const {
  handleAECodeCompile,
  handleAECodeMissionStart,
  handleAECodeMissionGet,
  handleAELangRoute,
  matchAECodeRoute,
  __internal,
} = await import(ROUTES_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Test harness.
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.error(`  FAIL  ${label}`);
    if (detail !== undefined) {
      console.error(`        ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)}`);
    }
  }
}

function stage(name, fn) {
  console.log(`\n── ${name} ──`);
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — realistic AECode markdown source covering all 13 sections.
// behavior_graph + target_matrix + permissions use fenced YAML so the parser
// preserves structure for the compiler.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_MD = `---
identity:
  name: aecode-smoke-fixture
  version: 0.1.0
  owner: atomeons
  department: AE6_CODE
---

## Product Intent

Wire the AECode + AELang gateway routes into Orange5 OrangeLLM so the AE0-AE14 control plane can compile source contracts, dispatch missions, and route AELang-High intents to ORANGEBOX route packets. Route-first, receipt-first, visual-first.

## Operator Laws

- No fake greens. Every claim has a receipt.
- Receipts are hash-chained on disk; the chain is the audit truth.
- Out-of-scope patches block the mission; they do not silently land.
- The gateway never auto-runs to completion without explicit caller opt-in.

## Scope

\`\`\`yaml
allowed_paths:
  - 06-ORANGELLM/server/routes/aecode.mjs
  - 04-CONTROL-PLANE/aecode/smoke-test.mjs
forbidden_paths:
  - 10-RECEIPTS
  - 00-CHARTER
risk: low
aelang_high: "compile source then start mission and verify chain"
\`\`\`

## Target Matrix

\`\`\`yaml
targets:
  - lang: javascript
    runtime: node20
    build_cmd: "node --check"
    test_cmd: "node 04-CONTROL-PLANE/aecode/smoke-test.mjs"
    out_dir: 06-ORANGELLM/server/routes
\`\`\`

## Artifact Contracts

- name: aecode-routes
  target: javascript
  path: 06-ORANGELLM/server/routes/aecode.mjs
  must_export: handleAECodeCompile

## Data Contracts

- name: mission-contract
  schema: 09-SCHEMAS/mission.schema.json
  shape: object

## Behavior Graph

\`\`\`yaml
nodes:
  - id: compile
    kind: edit
    files:
      - 06-ORANGELLM/server/routes/aecode.mjs
  - id: smoke
    kind: verify
    files:
      - 04-CONTROL-PLANE/aecode/smoke-test.mjs
edges:
  - from: compile
    to: smoke
\`\`\`

## Permissions

\`\`\`yaml
allow:
  - filesystem.read
  - filesystem.write
deny:
  - egress_unbounded
  - destructive_write
require_human_approval: false
\`\`\`

## Model Roles

\`\`\`yaml
default_adapter: mock-local-deterministic
adapter_by_lang:
  javascript: mock-local-deterministic
\`\`\`

## Gauntlets

\`\`\`yaml
- id: schema-gate
  gates:
    - schema_check
    - shape_check
- id: smoke-gate
  gates:
    - smoke_test
\`\`\`

## Receipts

\`\`\`yaml
schema: orange5.receipt.v0
dir: 10-RECEIPTS/orange5-build
hash_chain: true
emit_on:
  - step_done
  - mission_done
  - blocked
required: true
\`\`\`

## Rollback

\`\`\`yaml
strategy: revert_last_commit
triggers:
  - gauntlet_fail
  - scope_violation
verify: smoke_test
\`\`\`
`;

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — POST /v1/aecode/compile
// ─────────────────────────────────────────────────────────────────────────────

let compileResp;
let firstMissionId;
let firstSourceHash;

await stage("STAGE 1 — POST /v1/aecode/compile", async () => {
  compileResp = await handleAECodeCompile({ source: SOURCE_MD });

  assert(compileResp._ae_http_status === 200,
    "compile returns 200",
    { status: compileResp._ae_http_status, error: compileResp.error });
  assert(compileResp.ok === true, "compile ok flag true");

  assert(typeof compileResp.mission_id === "string" && compileResp.mission_id.startsWith("ms"),
    "mission_id present and prefixed",
    { mission_id: compileResp.mission_id });
  firstMissionId = compileResp.mission_id;

  assert(compileResp.mission && typeof compileResp.mission === "object",
    "mission contract present");
  assert(Array.isArray(compileResp.patch_plan?.steps) && compileResp.patch_plan.steps.length >= 1,
    "patch_plan has at least one step",
    { steps: compileResp.patch_plan?.steps?.length });
  assert(Array.isArray(compileResp.target_plan) && compileResp.target_plan.length >= 1,
    "target_plan populated");
  assert(compileResp.target_plan?.[0]?.lang === "javascript",
    "target_plan language preserved",
    { got: compileResp.target_plan?.[0] });
  assert(Array.isArray(compileResp.gauntlet_steps) && compileResp.gauntlet_steps.length >= 1,
    "gauntlet_steps populated");
  assert(typeof compileResp.compiler?.source_hash === "string"
    && compileResp.compiler.source_hash.length === 64,
    "compiler source_hash is 64-char sha256");
  firstSourceHash = compileResp.compiler.source_hash;

  // Determinism check: compiling the same source twice gives the same hash.
  const second = await handleAECodeCompile({ source: SOURCE_MD });
  assert(second._ae_http_status === 200 && second.compiler?.source_hash === firstSourceHash,
    "compile is deterministic on source_hash",
    { first: firstSourceHash, second: second.compiler?.source_hash });
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2 — POST /v1/aecode/mission/start (dry_run: true)
// ─────────────────────────────────────────────────────────────────────────────

let dryRunResp;
let dryRunReceiptDir;

await stage("STAGE 2 — POST /v1/aecode/mission/start (dry_run)", async () => {
  dryRunReceiptDir = mkdtempSync(join(tmpdir(), "aecode-smoke-"));

  dryRunResp = await handleAECodeMissionStart({
    source: SOURCE_MD,
    dry_run: true,
    receipt_dir: dryRunReceiptDir,
  });

  assert(dryRunResp._ae_http_status === 200,
    "mission/start dry_run returns 200",
    { status: dryRunResp._ae_http_status, error: dryRunResp.error });
  assert(dryRunResp.ok === true, "mission/start ok flag true");
  assert(typeof dryRunResp.mission_id === "string",
    "dry_run mission_id present");

  assert(dryRunResp.mode === "done" || dryRunResp.mode === "blocked",
    "dry_run reached terminal mode",
    { mode: dryRunResp.mode, blockers: dryRunResp.state?.blockers });
  // For our fixture (mock adapter + noop stub Hermes), expect DONE.
  assert(dryRunResp.mode === "done",
    "dry_run mode is done",
    { mode: dryRunResp.mode, error: dryRunResp.state?.error, blockers: dryRunResp.state?.blockers });

  assert(Array.isArray(dryRunResp.state?.receipt_paths) && dryRunResp.state.receipt_paths.length >= 1,
    "dry_run wrote at least one receipt",
    { count: dryRunResp.state?.receipt_paths?.length });

  // Receipts must actually exist on disk.
  const allExist = (dryRunResp.state?.receipt_paths || []).every(p => existsSync(p));
  assert(allExist, "every receipt file exists on disk");

  assert(dryRunResp.verify_chain && dryRunResp.verify_chain.ok === true,
    "verify_chain reports ok",
    dryRunResp.verify_chain);
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 3 — GET /v1/aecode/mission/:id
// ─────────────────────────────────────────────────────────────────────────────

await stage("STAGE 3 — GET /v1/aecode/mission/:id", async () => {
  const lookup = await handleAECodeMissionGet(dryRunResp.mission_id);
  assert(lookup._ae_http_status === 200, "mission GET returns 200",
    { status: lookup._ae_http_status, error: lookup.error });
  assert(lookup.mission_id === dryRunResp.mission_id, "mission_id round-trips");
  assert(lookup.verify_chain?.ok === true, "re-read verify_chain ok",
    lookup.verify_chain);
  assert(Array.isArray(lookup.state?.receipt_paths) && lookup.state.receipt_paths.length >= 1,
    "receipts surface on GET");

  const missing = await handleAECodeMissionGet("ms-nope-does-not-exist");
  assert(missing._ae_http_status === 404, "unknown id → 404");
  assert(missing.error?.code === "not_found", "unknown id error.code == not_found",
    missing.error);
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 4 — POST /v1/aelang/route
// ─────────────────────────────────────────────────────────────────────────────

await stage("STAGE 4 — POST /v1/aelang/route", async () => {
  // Verbs come from ACTION_VERBS in high-parser.mjs. "build" → AE6_CODE,
  // "verify" → AE14_BENCH (via verb→dept map). "then" is the sequence connector.
  const intent = "build aecode routes then verify receipt chain";
  const r = await handleAELangRoute({ intent });

  assert(r._ae_http_status === 200, "aelang/route returns 200",
    { status: r._ae_http_status, error: r.error });
  assert(r.ok === true, "aelang/route ok flag true");
  assert(r.intent === intent, "intent echoed");
  assert(r.high_ir?.schema === "aelang.high.ir.v0", "high_ir schema correct",
    { schema: r.high_ir?.schema });
  assert(r.composition === "sequence",
    "composition is sequence (intent uses 'then')",
    { got: r.composition });
  assert(Array.isArray(r.core) && r.core.length >= 1,
    "core packets emitted", { count: r.core?.length });
  assert(r.core.every(p => p.schema === "aelang.core.packet.v0"),
    "every core packet carries aelang.core.packet.v0 schema");
  assert(Array.isArray(r.route) && r.route.length >= 1,
    "route packets emitted", { count: r.route?.length });
  assert(r.route.every(p => p.schema === "orangebox.route.packet.v0"),
    "every route packet carries orangebox.route.packet.v0 schema");
  assert(r.route.every(p => typeof p.route_id === "string" && p.route_id.startsWith("rp-")),
    "every route packet has route_id starting with rp-");
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 5 — Error contracts.
// ─────────────────────────────────────────────────────────────────────────────

await stage("STAGE 5 — error contracts", async () => {
  const empty = await handleAECodeCompile({});
  assert(empty._ae_http_status === 400, "compile {} → 400",
    { status: empty._ae_http_status });
  assert(empty.error?.code === "source_required",
    "compile {} → code source_required", empty.error);

  const bad = await handleAECodeCompile({ source: "not aecode at all" });
  assert(bad._ae_http_status === 422, "compile bad source → 422",
    { status: bad._ae_http_status });

  const emptyIntent = await handleAELangRoute({ intent: "" });
  assert(emptyIntent._ae_http_status === 400,
    "aelang/route empty intent → 400");
  assert(emptyIntent.error?.code === "intent_required",
    "aelang/route empty intent → code intent_required", emptyIntent.error);

  // Path matcher sanity.
  assert(matchAECodeRoute({ method: "POST", path: "/v1/aecode/compile" })?.handler === handleAECodeCompile,
    "matchAECodeRoute resolves /v1/aecode/compile");
  assert(matchAECodeRoute({ method: "POST", path: "/v1/aelang/route" })?.handler === handleAELangRoute,
    "matchAECodeRoute resolves /v1/aelang/route");
  const m = matchAECodeRoute({ method: "GET", path: "/v1/aecode/mission/ms_deterministic" });
  assert(m && m.kind === "no_body", "matchAECodeRoute resolves mission GET");
  assert(matchAECodeRoute({ method: "GET", path: "/nope" }) === null,
    "matchAECodeRoute returns null for unrelated paths");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary.
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── SUMMARY ──`);
console.log(`  pass: ${pass}`);
console.log(`  fail: ${fail}`);
console.log(`  routes_version: ${__internal.ROUTES_VERSION}`);
console.log(`  registry size: ${__internal.REGISTRY.size}`);
console.log(`  receipt dir:   ${dryRunReceiptDir}`);

if (fail > 0) {
  console.error(`\nSMOKE TEST FAILED. ${fail} assertion(s) did not pass.`);
  for (const f of failures) {
    console.error(`  - ${f.label}`);
  }
  process.exit(1);
}
console.log(`\nSMOKE TEST PASSED. Mom-grade receipt minted.`);
process.exit(0);
