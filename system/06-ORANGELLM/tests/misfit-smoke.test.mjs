#!/usr/bin/env node
// AE Misfit smoke test
// Path: 06-ORANGELLM/tests/misfit-smoke.test.mjs
//
// Doctrine: deterministic smoke checks that do not require the qwen2.5:7b
// + ae-misfit Ollama instance to be live. The upstream call is stubbed via
// a mock fetch so we test the route shape, validation, fail-closed floor,
// and verdict shaping — the parts WE own. Real upstream calls happen in
// the operator-run integration probe (next to upstream-probe.mjs).
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/tests/misfit-smoke.test.mjs
//
// Exit code:
//   0 — all smoke checks passed
//   1 — at least one smoke check failed (prints failure list)

import { createServer } from "node:http";
import { once } from "node:events";

import {
  registerMisfitRoutes,
  handleSecondOpinion,
  handlePreflight,
  handleEvalGet,
  __misfitInternals,
  MISFIT_PATH,
  MISFIT_EVAL_PATH,
  MISFIT_PREFLIGHT_PATH,
  MISFIT_UPSTREAM,
} from "../server/routes/misfit.mjs";
import {
  isMisfitRouteAllowed,
  MISFIT_ALLOWED,
} from "../server/routes/misfit-boundary.mjs";
import { boundary } from "../server/boundary.mjs";

const {
  shapeVerdict,
  inferRiskFromVerb,
  verdictToDecision,
  VALID_VERDICT,
  VALID_RISK,
  VERB_RISK_FLOOR,
} = __misfitInternals;

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
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// 1. Module shape
// ---------------------------------------------------------------------------

console.log("[misfit-smoke] 1. module shape");

check(
  "MISFIT_PATH is the documented path",
  MISFIT_PATH === "/v1/misfit/second-opinion",
);
check(
  "VALID_VERDICT contains the 4 doctrine verdicts",
  VALID_VERDICT.length === 4 &&
    VALID_VERDICT.includes("approve") &&
    VALID_VERDICT.includes("approve_with_conditions") &&
    VALID_VERDICT.includes("refuse") &&
    VALID_VERDICT.includes("block"),
);
check(
  "VALID_RISK contains the 4 doctrine risk levels",
  VALID_RISK.length === 4 &&
    VALID_RISK.includes("low") &&
    VALID_RISK.includes("medium") &&
    VALID_RISK.includes("high") &&
    VALID_RISK.includes("critical"),
);
check(
  "MISFIT_UPSTREAM base model is qwen2.5:7b-instruct",
  MISFIT_UPSTREAM.base_model === "qwen2.5:7b-instruct",
);

// ---------------------------------------------------------------------------
// 2. Boundary wiring
// ---------------------------------------------------------------------------

console.log("\n[misfit-smoke] 2. boundary wiring");

check(
  "isMisfitRouteAllowed accepts POST on the misfit path",
  isMisfitRouteAllowed("POST", MISFIT_PATH) === true,
);
check(
  "isMisfitRouteAllowed rejects GET on the misfit path",
  isMisfitRouteAllowed("GET", MISFIT_PATH) === false,
);
check(
  "isMisfitRouteAllowed rejects an unrelated path",
  isMisfitRouteAllowed("POST", "/v1/chat/completions") === false,
);

// Main boundary must allow our POST. Headers stripped to the safe minimum.
const mainAllow = boundary({
  method: "POST",
  path: MISFIT_PATH,
  headers: { "content-type": "application/json" },
});
check("main boundary allows POST /v1/misfit/second-opinion", mainAllow.reject === false);

const mainReject = boundary({
  method: "GET",
  path: MISFIT_PATH,
  headers: {},
});
check("main boundary rejects GET on the misfit path", mainReject.reject === true);

check(
  "MISFIT_ALLOWED exposes the three documented surfaces",
  MISFIT_ALLOWED.length === 3 &&
    MISFIT_ALLOWED.some((p) => p.method === "POST" && p.path === MISFIT_PATH) &&
    MISFIT_ALLOWED.some((p) => p.method === "POST" && p.path === MISFIT_PREFLIGHT_PATH) &&
    MISFIT_ALLOWED.some((p) => p.method === "GET" && p.path === MISFIT_EVAL_PATH),
);

check(
  "main boundary allows POST /v1/misfit/preflight",
  boundary({
    method: "POST",
    path: MISFIT_PREFLIGHT_PATH,
    headers: { "content-type": "application/json" },
  }).reject === false,
);
check(
  "main boundary allows GET /v1/misfit/eval",
  boundary({
    method: "GET",
    path: MISFIT_EVAL_PATH,
    headers: {},
  }).reject === false,
);
check(
  "main boundary rejects PUT on preflight",
  boundary({ method: "PUT", path: MISFIT_PREFLIGHT_PATH, headers: {} }).reject === true,
);

// ---------------------------------------------------------------------------
// 2b. Risk inference (verb -> floor)
// ---------------------------------------------------------------------------

console.log("\n[misfit-smoke] 2b. risk inference");

const r_dwLow = inferRiskFromVerb("destructive_write", "low");
assertEqual("destructive_write hint=low -> critical", r_dwLow.risk_level, "critical");
check("destructive_write promotes", r_dwLow.risk_promoted === true);

const r_pdMed = inferRiskFromVerb("production_deploy", "medium");
assertEqual("production_deploy hint=medium -> critical", r_pdMed.risk_level, "critical");

const r_critHonored = inferRiskFromVerb("filesystem_write", "critical");
assertEqual(
  "filesystem_write hint=critical stays critical (no downgrade)",
  r_critHonored.risk_level,
  "critical",
);
check("filesystem_write hint=critical not promoted", r_critHonored.risk_promoted === false);

const r_unknown = inferRiskFromVerb("some_made_up_verb", null);
assertEqual("unknown verb + no hint -> medium baseline", r_unknown.risk_level, "medium");
check("unknown verb + no hint not promoted", r_unknown.risk_promoted === false);

const r_unknownLow = inferRiskFromVerb("some_made_up_verb", "low");
assertEqual("unknown verb honors low hint", r_unknownLow.risk_level, "low");

assertEqual("verdictToDecision(refuse)=refuse", verdictToDecision("refuse"), "refuse");
assertEqual("verdictToDecision(block)=refuse", verdictToDecision("block"), "refuse");
assertEqual("verdictToDecision(approve)=confirm", verdictToDecision("approve"), "confirm");
assertEqual(
  "verdictToDecision(approve_with_conditions)=confirm",
  verdictToDecision("approve_with_conditions"),
  "confirm",
);

check(
  "VERB_RISK_FLOOR contains destructive_write at critical",
  VERB_RISK_FLOOR.destructive_write === "critical",
);

// ---------------------------------------------------------------------------
// 3. Verdict shaping — deterministic, no upstream needed
// ---------------------------------------------------------------------------

console.log("\n[misfit-smoke] 3. verdict shaping");

// 3a. Well-formed JSON output
const shaped1 = shapeVerdict(
  JSON.stringify({
    verdict: "refuse",
    reason: "the action references a retired corpus",
    fake_green_check: { suspected: true, indicators: ["retired_dataset"] },
  }),
  "high",
);
assertEqual("well-formed refuse: verdict", shaped1.verdict, "refuse");
check(
  "well-formed refuse: indicators carried through",
  shaped1.fake_green_check.indicators[0] === "retired_dataset",
);

// 3b. JSON wrapped in code fence (defensive strip)
const shaped2 = shapeVerdict(
  "```json\n" +
    JSON.stringify({
      verdict: "approve",
      reason: "no concern",
      fake_green_check: { suspected: false, indicators: [] },
    }) +
    "\n```",
  "low",
);
assertEqual("code-fence-wrapped approve: verdict", shaped2.verdict, "approve");

// 3c. Empty output at critical risk -> fail-closed to refuse
const shaped3 = shapeVerdict("", "critical");
assertEqual("empty output at critical: floor=refuse", shaped3.verdict, "refuse");
check(
  "empty output at critical: reason mentions failing closed",
  /failing closed/i.test(shaped3.reason),
);

// 3d. Garbage at low risk -> approve_with_conditions
const shaped4 = shapeVerdict("not json at all, just prose", "low");
assertEqual(
  "garbage output at low: floor=approve_with_conditions",
  shaped4.verdict,
  "approve_with_conditions",
);
check(
  "garbage output at low: condition includes human_confirmation_required",
  Array.isArray(shaped4.conditions) && shaped4.conditions.includes("human_confirmation_required"),
);

// 3e. approve_with_conditions returned with no conditions -> default supplied
const shaped5 = shapeVerdict(
  JSON.stringify({
    verdict: "approve_with_conditions",
    reason: "needs follow-up",
    fake_green_check: { suspected: false, indicators: [] },
  }),
  "medium",
);
check(
  "approve_with_conditions: missing conditions defaults to human_confirmation_required",
  Array.isArray(shaped5.conditions) &&
    shaped5.conditions.includes("human_confirmation_required"),
);

// 3f. Invalid verdict value -> fail-closed at high risk
const shaped6 = shapeVerdict(
  JSON.stringify({
    verdict: "looks_good_to_me",
    reason: "vibes",
    fake_green_check: { suspected: false, indicators: [] },
  }),
  "high",
);
assertEqual("invalid verdict at high: floor=refuse", shaped6.verdict, "refuse");

// ---------------------------------------------------------------------------
// 4. handleSecondOpinion input validation (no upstream call)
// ---------------------------------------------------------------------------

console.log("\n[misfit-smoke] 4. input validation");

const stubCfg = {
  upstream: {
    ...MISFIT_UPSTREAM,
    // Point at an unroutable port so probe fails fast; that exercises the
    // 503 unreachable path for the validation tests that should NOT reach
    // upstream because they reject first.
    base_url: "http://127.0.0.1:1", // unroutable
    timeout_ms: 500,
  },
  log: () => {},
};

const r1 = await handleSecondOpinion(null, stubCfg);
assertEqual("null body -> 400", r1.status, 400);

const r2 = await handleSecondOpinion({ risk_level: "low" }, stubCfg);
assertEqual("missing action -> 400", r2.status, 400);

const r3 = await handleSecondOpinion({ action: "do thing", risk_level: "spicy" }, stubCfg);
assertEqual("bad risk_level -> 400", r3.status, 400);

const r4 = await handleSecondOpinion(
  { action: "x".repeat(8_001), risk_level: "low" },
  stubCfg,
);
assertEqual("oversize action -> 422", r4.status, 422);

// Valid input, but upstream is unroutable -> 503 (fail-closed, not fake-approve).
const r5 = await handleSecondOpinion(
  { action: "deploy to production", risk_level: "high" },
  stubCfg,
);
assertEqual("valid input + dead upstream -> 503", r5.status, 503);
check(
  "503 surfaces misfit_upstream_unreachable type",
  r5.body?.error?.type === "misfit_upstream_unreachable",
);

// ---------------------------------------------------------------------------
// 5. End-to-end HTTP smoke against a mock upstream
// ---------------------------------------------------------------------------
//
// Spin up a tiny mock Ollama-shaped server that:
//   - GET /api/tags -> 200 {models:[]}
//   - POST /v1/chat/completions -> 200 with a stubbed AE Misfit verdict
// Then point the route at it and round-trip a real POST through the
// node:http server.

console.log("\n[misfit-smoke] 5. http round-trip with mock upstream");

const mock = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "ae-misfit" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      // Stub: refuse a critical deploy with a fake-green flag.
      const verdict = {
        verdict: "refuse",
        reason: "production deploy on a friday without rollback plan",
        fake_green_check: {
          suspected: true,
          indicators: ["no_rollback_evidence", "ci_green_but_smoke_skipped"],
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) } }],
        }),
      );
    });
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;

// Don't attach a default "request" listener — registerMisfitRoutes uses
// prependListener with async handlers. If we attached a sync default 404
// listener it would fire BEFORE the async misfit handler had a chance to
// take over the response. The misfit handler also short-circuits on
// pathName !== MISFIT_PATH, returning quickly without writing, so any
// non-misfit path would just hang here — but in this smoke test every
// request hits MISFIT_PATH.
const gateway = createServer();

registerMisfitRoutes(gateway, {
  upstream: {
    ...MISFIT_UPSTREAM,
    base_url: `http://127.0.0.1:${mockPort}`,
    timeout_ms: 3_000,
  },
  log: () => {},
});

await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gwPort = gateway.address().port;

try {
  const res = await fetch(`http://127.0.0.1:${gwPort}${MISFIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "deploy v0.4.2 to prod from main",
      risk_level: "critical",
      context: "ci green but smoke suite was skipped",
      actor: "hermes-deploy",
      correlation_id: "smoke-001",
    }),
  });

  assertEqual("round-trip status", res.status, 200);
  const body = await res.json();
  assertEqual("round-trip verdict", body.verdict, "refuse");
  check(
    "round-trip reason mentions rollback",
    typeof body.reason === "string" && /rollback/i.test(body.reason),
  );
  check(
    "round-trip fake-green suspected=true",
    body.fake_green_check && body.fake_green_check.suspected === true,
  );
  check(
    "round-trip fake-green indicators include ci_green_but_smoke_skipped",
    body.fake_green_check?.indicators?.includes("ci_green_but_smoke_skipped"),
  );
  assertEqual("round-trip correlation_id echoed", body.correlation_id, "smoke-001");
  check(
    "round-trip model.name === ae-misfit",
    body.model?.name === "ae-misfit",
  );
  check(
    "round-trip model.base === qwen2.5:7b-instruct",
    body.model?.base === "qwen2.5:7b-instruct",
  );

  // Method not allowed
  const resGet = await fetch(`http://127.0.0.1:${gwPort}${MISFIT_PATH}`);
  assertEqual("GET -> 405", resGet.status, 405);

  // -----------------------------------------------------------------------
  // 5b. Preflight round-trip — verb promotion + decision collapse
  // -----------------------------------------------------------------------
  console.log("\n[misfit-smoke] 5b. preflight round-trip");

  const pre = await fetch(`http://127.0.0.1:${gwPort}${MISFIT_PREFLIGHT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action_verb: "production_deploy",
      action: "promote v0.4.2 to prod",
      risk_level: "low", // caller lied; verb floor must promote to critical
      actor: "hermes-deploy",
      lease_id: "lease-abc",
      report: "ci green but smoke suite was skipped",
      correlation_id: "preflight-001",
    }),
  });
  assertEqual("preflight status", pre.status, 200);
  const preBody = await pre.json();
  assertEqual("preflight decision == refuse", preBody.decision, "refuse");
  assertEqual("preflight risk promoted to critical", preBody.risk_level, "critical");
  check("preflight risk_promoted flag set", preBody.risk_promoted === true);
  check(
    "preflight verdict is refuse (mock stubbed it)",
    preBody.verdict === "refuse",
  );
  check(
    "preflight echoes correlation_id",
    preBody.correlation_id === "preflight-001",
  );

  // Preflight missing action_verb -> 400
  const preBad = await fetch(`http://127.0.0.1:${gwPort}${MISFIT_PREFLIGHT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "deploy", risk_level: "high" }),
  });
  assertEqual("preflight missing verb -> 400", preBad.status, 400);

  // Preflight method-not-allowed
  const preGet = await fetch(`http://127.0.0.1:${gwPort}${MISFIT_PREFLIGHT_PATH}`);
  assertEqual("preflight GET -> 405", preGet.status, 405);

  // -----------------------------------------------------------------------
  // 5c. Eval GET — honest 404 when no report on disk
  // -----------------------------------------------------------------------
  console.log("\n[misfit-smoke] 5c. eval GET round-trip");

  // Point the eval reader at an empty/nonexistent dir so we test the
  // honest-404 path without touching the operator's real eval tree.
  const tmpDir = await (await import("node:fs/promises")).mkdtemp(
    (await import("node:os")).tmpdir() + "/ae-misfit-eval-",
  );

  // Spin up a second gateway pinned at the empty eval dir.
  const gw2 = createServer();
  registerMisfitRoutes(gw2, {
    upstream: {
      ...MISFIT_UPSTREAM,
      base_url: `http://127.0.0.1:${mockPort}`,
      timeout_ms: 3_000,
    },
    evalDir: tmpDir,
    log: () => {},
  });
  await new Promise((resolve) => gw2.listen(0, "127.0.0.1", resolve));
  const gw2Port = gw2.address().port;
  try {
    const evalRes = await fetch(`http://127.0.0.1:${gw2Port}${MISFIT_EVAL_PATH}`);
    assertEqual("eval GET on empty dir -> 404", evalRes.status, 404);
    const evalBody = await evalRes.json();
    check(
      "eval 404 surfaces misfit_eval_not_found",
      evalBody?.error?.type === "misfit_eval_not_found",
    );

    // Write a tiny report and re-read.
    const { writeFile } = await import("node:fs/promises");
    const reportPath = `${tmpDir}/eval-report.ae-misfit_v0.json`;
    await writeFile(
      reportPath,
      JSON.stringify({
        schema: "orange5.ae-misfit.eval.v0",
        disclosure_id: "ATOM-AEMISFIT-EVAL-2026-0624",
        model: "ae-misfit:v0",
        host: "http://127.0.0.1:11434",
        tag: "ae-misfit_v0",
        seed_path: "/x/seed.jsonl",
        seed_sha256: "deadbeef",
        started_at: "2026-06-24T00:00:00.000Z",
        finished_at: "2026-06-24T00:01:00.000Z",
        ran_in_ollama: true,
        summary: {
          n: 100,
          refusal_n: 50,
          refusal_correct: 49,
          refusal_accuracy: 0.98,
          yield_n: 50,
          yield_correct: 50,
          yield_accuracy: 1.0,
          fake_green_clean_pairs: 100,
          fake_green_hits_total: 0,
          fake_green_clean_rate: 1.0,
          responded: 100,
          mean_elapsed_ms: 412,
        },
        records: [
          {
            id: "pair-001",
            category: "refusal",
            input: "SECRET_CORPUS_INPUT", // must NOT appear in response
            gold_output: "SECRET_CORPUS_OUTPUT",
            response: "Refuse: scope drift",
            response_ok: true,
            elapsed_ms: 400,
            error: null,
            score: { gold_class: "refusal", refusal_correct: true, fake_green_count: 0 },
          },
        ],
      }),
      "utf8",
    );

    const evalRes2 = await fetch(`http://127.0.0.1:${gw2Port}${MISFIT_EVAL_PATH}`);
    assertEqual("eval GET with report -> 200", evalRes2.status, 200);
    const evalBody2 = await evalRes2.json();
    check("eval body ok=true", evalBody2.ok === true);
    assertEqual("eval body model", evalBody2.model, "ae-misfit:v0");
    check(
      "eval summary refusal_accuracy preserved",
      evalBody2.summary?.refusal_accuracy === 0.98,
    );
    check(
      "eval records[0] has no 'input' leak",
      evalBody2.records?.[0] && !("input" in evalBody2.records[0]),
    );
    check(
      "eval records[0] has no 'gold_output' leak",
      evalBody2.records?.[0] && !("gold_output" in evalBody2.records[0]),
    );
    check(
      "eval records[0] has no 'response' leak",
      evalBody2.records?.[0] && !("response" in evalBody2.records[0]),
    );
    // Path-separator normalization: handler uses path.join, test wrote with
    // forward slashes, both must resolve to the same file. Compare by
    // basename rather than literal string to stay Windows/POSIX clean.
    check(
      "eval report_paths.json points at the written report",
      typeof evalBody2.report_paths?.json === "string" &&
        evalBody2.report_paths.json.replace(/\\/g, "/").endsWith("/eval-report.ae-misfit_v0.json"),
    );

    // Eval method-not-allowed
    const evalPost = await fetch(`http://127.0.0.1:${gw2Port}${MISFIT_EVAL_PATH}`, {
      method: "POST",
    });
    assertEqual("eval POST -> 405", evalPost.status, 405);
  } finally {
    if (typeof gw2.closeAllConnections === "function") gw2.closeAllConnections();
    await new Promise((r) => gw2.close(r));
    try {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
} finally {
  // closeAllConnections (Node 18.2+) drops any keep-alive sockets so the
  // event loop drains cleanly on Windows. Without it the process exits via
  // a libuv UV_HANDLE_CLOSING assertion (cosmetic but loud).
  if (typeof gateway.closeAllConnections === "function") gateway.closeAllConnections();
  if (typeof mock.closeAllConnections === "function") mock.closeAllConnections();
  await new Promise((r) => gateway.close(r));
  await new Promise((r) => mock.close(r));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;

console.log(`\n[misfit-smoke] ${pass}/${results.length} passed`);
if (fail > 0) {
  console.log(`[misfit-smoke] failures:`);
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(1);
}
process.exit(0);
