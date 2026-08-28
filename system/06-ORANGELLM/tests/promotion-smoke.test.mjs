#!/usr/bin/env node
// Promotion / Bakeoff / CLR gateway smoke test
// Path: 06-ORANGELLM/tests/promotion-smoke.test.mjs
//
// Doctrine: deterministic smoke checks that exercise the gateway handlers
// without needing an upstream model live. The bakeoff harness is run
// against an injected pair of cheap deterministic adapters whose scores
// we can predict. Persistence uses a per-run scratch dir under os.tmpdir
// so the real memory/promotion store is never touched.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/tests/promotion-smoke.test.mjs
//
// Exit code:
//   0 — all smoke checks passed
//   1 — at least one smoke check failed (prints failure list)

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  registerPromotionRoutes,
  handleDecide,
  handleBakeoffRun,
  handleBakeoffGet,
  handleClrVerify,
  __promotionInternals,
  PROMOTION_DECIDE_PATH,
  BAKEOFF_RUN_PATH,
  BAKEOFF_GET_PREFIX,
  CLR_VERIFY_PATH,
  CLR_K5_K,
  CLR_K5_THRESHOLD,
} from "../server/routes/promotion.mjs";
import {
  isPromotionRouteAllowed,
  PROMOTION_ALLOWED,
} from "../server/routes/promotion-boundary.mjs";

const { matchRoute, BAKEOFF_ID_RE } = __promotionInternals;

// ---------------------------------------------------------------------------
// Mini test harness
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}

function assertEqual(name, actual, expected) {
  const ok = actual === expected;
  check(
    name,
    ok,
    ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// Scratch dir for bakeoff persistence — isolated per run.
const scratchDir = mkdtempSync(path.join(tmpdir(), "promotion-smoke-"));
const scratchStore = path.join(scratchDir, "store");
mkdirSync(scratchStore, { recursive: true });

// Receipt fixture: a real non-empty JSON file on disk.
const receiptPath = path.join(scratchDir, "receipt.json");
writeFileSync(
  receiptPath,
  JSON.stringify({
    receipt_id: "r-smoke-001",
    candidate: "promotion-smoke",
    timestamp: new Date().toISOString(),
  }),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1. Module shape & boundary wiring
// ---------------------------------------------------------------------------

console.log("[promotion-smoke] 1. module shape & boundary");

assertEqual(
  "PROMOTION_DECIDE_PATH is /v1/promotion/decide",
  PROMOTION_DECIDE_PATH,
  "/v1/promotion/decide",
);
assertEqual("BAKEOFF_RUN_PATH is /v1/bakeoff/run", BAKEOFF_RUN_PATH, "/v1/bakeoff/run");
assertEqual("CLR_VERIFY_PATH is /v1/clr/verify", CLR_VERIFY_PATH, "/v1/clr/verify");
assertEqual("CLR_K5_K === 5", CLR_K5_K, 5);
assertEqual("CLR_K5_THRESHOLD === 0.50", CLR_K5_THRESHOLD, 0.5);

check(
  "PROMOTION_ALLOWED contains decide/run/clr literals",
  PROMOTION_ALLOWED.some(
    (r) => r.method === "POST" && r.path === PROMOTION_DECIDE_PATH,
  ) &&
    PROMOTION_ALLOWED.some(
      (r) => r.method === "POST" && r.path === BAKEOFF_RUN_PATH,
    ) &&
    PROMOTION_ALLOWED.some(
      (r) => r.method === "POST" && r.path === CLR_VERIFY_PATH,
    ),
);

check(
  "isPromotionRouteAllowed accepts the three literal POSTs",
  isPromotionRouteAllowed("POST", PROMOTION_DECIDE_PATH) &&
    isPromotionRouteAllowed("POST", BAKEOFF_RUN_PATH) &&
    isPromotionRouteAllowed("POST", CLR_VERIFY_PATH),
);

check(
  "isPromotionRouteAllowed accepts GET on 64-hex bakeoff id",
  isPromotionRouteAllowed("GET", `${BAKEOFF_GET_PREFIX}${"a".repeat(64)}`),
);

check(
  "isPromotionRouteAllowed rejects GET on non-hex bakeoff id",
  !isPromotionRouteAllowed("GET", `${BAKEOFF_GET_PREFIX}not-a-hash`),
);

check(
  "isPromotionRouteAllowed rejects path traversal in id slot",
  !isPromotionRouteAllowed("GET", `${BAKEOFF_GET_PREFIX}${"a".repeat(64)}/..`),
);

check(
  "isPromotionRouteAllowed rejects unrelated path",
  !isPromotionRouteAllowed("POST", "/v1/chat/completions"),
);

check(
  "matchRoute returns method_not_allowed for GET on /v1/promotion/decide",
  matchRoute("GET", PROMOTION_DECIDE_PATH).name === "method_not_allowed",
);

check(
  "matchRoute returns null for unrelated /v1/models",
  matchRoute("GET", "/v1/models") === null,
);

// ---------------------------------------------------------------------------
// 2. CLR-K5 verifier handler
// ---------------------------------------------------------------------------

console.log("\n[promotion-smoke] 2. CLR-K5 verifier");

{
  const { status, body } = await handleClrVerify({ k: 5, score: 0.75 }, {});
  assertEqual("clr/verify happy path → 200", status, 200);
  assertEqual("clr/verify ok=true on 5/0.75", body.ok, true);
  assertEqual("clr/verify threshold echoed", body.threshold, 0.5);
  assertEqual("clr/verify required_k echoed", body.required_k, 5);
}
{
  const { status, body } = await handleClrVerify({ k: 1, score: 0.99 }, {});
  assertEqual("clr/verify rejects k=1 → still 200", status, 200);
  assertEqual("clr/verify ok=false when k≠5", body.ok, false);
}
{
  const { status, body } = await handleClrVerify({ k: 5, score: 0.49 }, {});
  assertEqual("clr/verify rejects sub-threshold → 200", status, 200);
  assertEqual("clr/verify ok=false on score<0.5", body.ok, false);
}
{
  const { status, body } = await handleClrVerify(
    { clr: { k: 5, score: 0.8 } },
    {},
  );
  assertEqual("clr/verify accepts nested {clr:{...}}", status, 200);
  assertEqual("clr/verify ok=true on nested shape", body.ok, true);
}
{
  const { status } = await handleClrVerify(null, {});
  assertEqual("clr/verify rejects non-object body → 400", status, 400);
}

// ---------------------------------------------------------------------------
// 3. Promotion-gate decide handler
// ---------------------------------------------------------------------------

console.log("\n[promotion-smoke] 3. promotion-gate decide");

// 3a. Fake-green hard reject
{
  const { status, body } = await handleDecide(
    {
      receipt_path: receiptPath,
      bakeoff: bakeoffPassing(),
      status: "passed",
      risk_level: "low",
      candidate_text: "LGTM, ship it anyway",
    },
    {},
  );
  assertEqual("decide fake-green → 200", status, 200);
  assertEqual("decide fake-green verdict = reject", body.decision, "reject");
  check(
    "decide fake-green reason mentions fake-green",
    /fake-green/i.test(body.reason || ""),
  );
}

// 3b. Missing receipt → hold
{
  const { status, body } = await handleDecide(
    {
      receipt_path: "",
      bakeoff: bakeoffPassing(),
      status: "passed",
      risk_level: "low",
    },
    {},
  );
  assertEqual("decide missing receipt → 200", status, 200);
  assertEqual("decide missing receipt verdict = hold", body.decision, "hold");
}

// 3c. High risk without operator_approved → hold
{
  const { status, body } = await handleDecide(
    {
      receipt_path: receiptPath,
      bakeoff: bakeoffPassing(),
      status: "passed",
      risk_level: "production",
    },
    {},
  );
  assertEqual("decide high-risk no-approval → 200", status, 200);
  assertEqual(
    "decide high-risk no-approval verdict = hold",
    body.decision,
    "hold",
  );
}

// 3d. Bakeoff loss → reject (3 of 5 → below threshold of 4)
{
  const { status, body } = await handleDecide(
    {
      receipt_path: receiptPath,
      bakeoff: bakeoffMostlyLosing(),
      status: "passed",
      risk_level: "low",
    },
    {},
  );
  assertEqual("decide bakeoff-loss → 200", status, 200);
  assertEqual("decide bakeoff-loss verdict = reject", body.decision, "reject");
}

// 3e. CLR-K5 contract violation → reject
{
  const { status, body } = await handleDecide(
    {
      receipt_path: receiptPath,
      bakeoff: bakeoffPassing(),
      status: "passed",
      risk_level: "low",
      clr: { k: 5, score: 0.3 },
    },
    {},
  );
  assertEqual("decide clr-violation → 200", status, 200);
  assertEqual(
    "decide clr-violation verdict = reject",
    body.decision,
    "reject",
  );
}

// 3f. Happy path → promote
{
  const { status, body } = await handleDecide(
    {
      receipt_path: receiptPath,
      bakeoff: bakeoffPassing(),
      status: "passed",
      risk_level: "low",
      clr: { k: 5, score: 0.9 },
    },
    {},
  );
  assertEqual("decide happy-path → 200", status, 200);
  assertEqual("decide happy-path verdict = promote", body.decision, "promote");
}

// 3g. Malformed body → 400
{
  const { status } = await handleDecide(null, {});
  assertEqual("decide null body → 400", status, 400);
}

// ---------------------------------------------------------------------------
// 4. Bakeoff harness handler with predictable adapters
// ---------------------------------------------------------------------------

console.log("\n[promotion-smoke] 4. bakeoff run + get");

// Build adapters whose scores are predictable per dimension. Baseline:
// terse essay. Challenger: doctrine + receipts + mission shape + refusal.
function essayBaseline(_p) {
  return "It is generally thought that things work out.";
}
function disciplinedChallenger(_p) {
  return [
    "Result: applies Mom's Law and receipts discipline.",
    "Evidence: file: 10-RECEIPTS/r.json, sha-256: deadbeef.",
    "Scope: 04-CONTROL-PLANE promotion-gate + bakeoff.",
    "I cannot verify the IP of the cockpit. No source.",
    "- mission_shape\n- doctrine: Pathwaves, Hermes, CLR-K5.",
    "- blockers: none\n- next action: gate the candidate",
  ].join("\n");
}

const adapterCfg = {
  dbDir: scratchStore,
  fluxRoot: path.join(scratchDir, "flux"),
  adapters: {
    "stub-baseline": essayBaseline,
    "stub-challenger": disciplinedChallenger,
  },
  defaultBaseline: "stub-baseline",
  defaultChallenger: "stub-challenger",
  probePackFactory: null,
  log: () => {},
};

{
  const { status, body } = await handleBakeoffRun({}, adapterCfg);
  assertEqual("bakeoff/run default adapters → 201", status, 201);
  check(
    "bakeoff/run returns 64-hex run_id",
    typeof body.run_id === "string" && BAKEOFF_ID_RE.test(body.run_id),
    body.run_id,
  );
  check(
    "bakeoff/run result has all 5 canonical dimensions",
    body.result &&
      body.result.dimensions &&
      Object.keys(body.result.dimensions).length === 5,
  );
  check(
    "bakeoff/run verdict is one of the doctrine triplet",
    body.result &&
      ["promote_recommended", "hold_recommended", "reject"].includes(
        body.result.verdict,
      ),
  );

  // Retrieve via GET handler.
  const get = await handleBakeoffGet(body.run_id, adapterCfg);
  assertEqual("bakeoff/:id round-trip → 200", get.status, 200);
  assertEqual(
    "bakeoff/:id returns same run_id",
    get.body.run_id,
    body.run_id,
  );
}

// 4b. Unknown adapter → 400
{
  const { status, body } = await handleBakeoffRun(
    { baseline_id: "does-not-exist" },
    adapterCfg,
  );
  assertEqual("bakeoff/run unknown adapter → 400", status, 400);
  check(
    "bakeoff/run lists known adapters in error",
    Array.isArray(body?.error?.known_adapters),
  );
}

// 4c. Unknown dimension → 400
{
  const { status } = await handleBakeoffRun(
    { dimensions: ["not_a_real_dim"] },
    adapterCfg,
  );
  assertEqual("bakeoff/run unknown dim → 400", status, 400);
}

// 4d. probe_pack over the wire → 400 (refuse-rather-than-drop)
{
  const { status } = await handleBakeoffRun(
    { probe_pack: { mission_shape: [] } },
    adapterCfg,
  );
  assertEqual("bakeoff/run rejects wire-supplied probe_pack → 400", status, 400);
}

// 4e. Bad bakeoff id → 400
{
  const { status } = await handleBakeoffGet("not-hex", adapterCfg);
  assertEqual("bakeoff/:id bad id → 400", status, 400);
}

// 4f. Missing bakeoff id → 404
{
  const { status } = await handleBakeoffGet("f".repeat(64), adapterCfg);
  assertEqual("bakeoff/:id unknown id → 404", status, 404);
}

// ---------------------------------------------------------------------------
// 5. HTTP wiring — end-to-end via a real node:http server
// ---------------------------------------------------------------------------

console.log("\n[promotion-smoke] 5. HTTP wiring");

// No default request handler — registerPromotionRoutes uses
// prependListener with async handlers. A sync default 404 would fire
// BEFORE the async handler awaited the body and responded. The
// promotion handler short-circuits cleanly on paths it does not own,
// so this smoke test only hits paths the handler claims.
const server = createServer();

registerPromotionRoutes(server, {
  dbPath: scratchStore,
  adapters: {
    "stub-baseline": essayBaseline,
    "stub-challenger": disciplinedChallenger,
  },
  log: () => {},
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function post(p, body) {
  const r = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function get(p) {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.json() };
}

{
  const r = await post(CLR_VERIFY_PATH, { k: 5, score: 0.6 });
  assertEqual("HTTP POST /v1/clr/verify → 200", r.status, 200);
  assertEqual("HTTP /v1/clr/verify ok=true on 5/0.6", r.body.ok, true);
}

{
  const r = await post(PROMOTION_DECIDE_PATH, {
    receipt_path: receiptPath,
    bakeoff: bakeoffPassing(),
    status: "passed",
    risk_level: "low",
    clr: { k: 5, score: 0.9 },
  });
  assertEqual("HTTP POST /v1/promotion/decide happy → 200", r.status, 200);
  assertEqual("HTTP /v1/promotion/decide verdict = promote", r.body.decision, "promote");
}

{
  const r = await post(BAKEOFF_RUN_PATH, {});
  assertEqual("HTTP POST /v1/bakeoff/run → 201", r.status, 201);
  check(
    "HTTP /v1/bakeoff/run returned run_id",
    typeof r.body.run_id === "string" && BAKEOFF_ID_RE.test(r.body.run_id),
  );

  const g = await get(`${BAKEOFF_GET_PREFIX}${r.body.run_id}`);
  assertEqual("HTTP GET /v1/bakeoff/:id → 200", g.status, 200);
  assertEqual("HTTP /v1/bakeoff/:id same run_id", g.body.run_id, r.body.run_id);
}

{
  const r = await fetch(`${base}${PROMOTION_DECIDE_PATH}`, { method: "GET" });
  assertEqual("HTTP GET /v1/promotion/decide → 405", r.status, 405);
}

await new Promise((resolve) => server.close(() => resolve()));

// ---------------------------------------------------------------------------
// 6. Tidy + summary
// ---------------------------------------------------------------------------

try {
  rmSync(scratchDir, { recursive: true, force: true });
} catch {
  /* best effort */
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n[promotion-smoke] ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) {
    console.log(`  - ${f.name}${f.detail ? "  — " + f.detail : ""}`);
  }
  process.exit(1);
}
process.exit(0);

// ---------------------------------------------------------------------------
// Bakeoff payload helpers (mirror promotion-gate/engine.mjs contract:
// {candidate: {...dims}, baseline: {...dims}}, each dim in [0,1].
// ---------------------------------------------------------------------------

function bakeoffPassing() {
  // Candidate wins all 5 — well clear of the 4-of-5 threshold.
  return {
    candidate: {
      mission_shape: 0.9,
      doctrine_recall: 0.9,
      topology_recall: 0.9,
      receipt_grounding: 0.9,
      refusal_discipline: 0.9,
    },
    baseline: {
      mission_shape: 0.5,
      doctrine_recall: 0.5,
      topology_recall: 0.5,
      receipt_grounding: 0.5,
      refusal_discipline: 0.5,
    },
  };
}

function bakeoffMostlyLosing() {
  // Candidate wins only 3 of 5 — below threshold → engine should reject.
  return {
    candidate: {
      mission_shape: 0.9,
      doctrine_recall: 0.9,
      topology_recall: 0.9,
      receipt_grounding: 0.1,
      refusal_discipline: 0.1,
    },
    baseline: {
      mission_shape: 0.5,
      doctrine_recall: 0.5,
      topology_recall: 0.5,
      receipt_grounding: 0.5,
      refusal_discipline: 0.5,
    },
  };
}
