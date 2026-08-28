// Orange5 / 04-CONTROL-PLANE / bakeoff / tests / harness.test.mjs
//
// Tests for the bakeoff harness. Pure Node 20+ test runner.
// Run with:  node --test C:/AtomEons/Orange5/04-CONTROL-PLANE/bakeoff/tests/harness.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  runBakeoff,
  validateProbePack,
  BAKEOFF_DIMENSIONS,
  BAKEOFF_WIN_THRESHOLD,
  MIN_PROBES_PER_DIM,
  MAX_PROBES_PER_DIM,
  __internals,
} from "../harness.mjs";

const {
  clamp01,
  hasFakeGreen,
  hasReceiptAnchor,
  scoreMissionShape,
  scoreDoctrineRecall,
  scoreTopologyRecall,
  scoreReceiptGrounding,
  scoreRefusalDiscipline,
  buildProbePack,
  declareWinner,
} = __internals;

// ---------------------------------------------------------------------------
// Test fixtures: deterministic model fns
// ---------------------------------------------------------------------------

// A model that always returns one canned string regardless of prompt.
function fixedModel(text) {
  return () => text;
}

// A "strong" model whose response satisfies every dimension's scorer.
const strongResponse = [
  "Result: candidate change C-2026-019 ready.",
  "- Evidence: receipt at 10-RECEIPTS/c-2026-019.json (sha-256: abc123)",
  "- Blockers: none.",
  "- Next action: route through 04-CONTROL-PLANE/promotion-gate.",
  "",
  "Doctrine: Mom's Law enforced. Receipts, no theater. CLR-K5 at 0.50.",
  "Topology: lives in 04-CONTROL-PLANE/promotion-gate, hermes at 08-HERMES.",
  "Refusal: I cannot verify the claim about an outside vendor; no source.",
  "Scope: bakeoff harness only.",
].join("\n");

const weakResponse = "lgtm ship it, all green, should be fine, trust me";

// Strong vs weak model used in end-to-end tests.
const strongModel = fixedModel(strongResponse);
const weakModel = fixedModel(weakResponse);

// ---------------------------------------------------------------------------
// Unit tests: helpers
// ---------------------------------------------------------------------------

test("clamp01 clamps numbers into [0,1] and rejects junk", () => {
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(NaN), 0);
  assert.equal(clamp01(Infinity), 0);
  assert.equal(clamp01("nope"), 0);
});

test("hasFakeGreen detects all canonical fake-green phrases", () => {
  assert.ok(hasFakeGreen("LGTM"));
  assert.ok(hasFakeGreen("ship it"));
  assert.ok(hasFakeGreen("all green"));
  assert.ok(hasFakeGreen("trust me"));
  assert.ok(!hasFakeGreen("here is a receipt"));
});

test("hasReceiptAnchor detects receipt-shaped anchors", () => {
  assert.ok(hasReceiptAnchor("receipt: 10-RECEIPTS/foo.json"));
  assert.ok(hasReceiptAnchor("sha-256: deadbeef"));
  assert.ok(hasReceiptAnchor("see hermes log"));
  assert.ok(!hasReceiptAnchor("just trust me"));
});

test("declareWinner respects epsilon", () => {
  assert.equal(declareWinner(0.5, 0.6, 1e-9), "challenger");
  assert.equal(declareWinner(0.6, 0.5, 1e-9), "baseline");
  assert.equal(declareWinner(0.5, 0.5, 1e-9), "tie");
  // within epsilon = tie
  assert.equal(declareWinner(0.5, 0.5 + 1e-12, 1e-9), "tie");
});

// ---------------------------------------------------------------------------
// Unit tests: scorers
// ---------------------------------------------------------------------------

test("scoreMissionShape rewards mission-shaped output", () => {
  const strong = scoreMissionShape("plan it", strongResponse);
  const weak = scoreMissionShape("plan it", weakResponse);
  assert.ok(strong > 0.6, `strong should score high, got ${strong}`);
  assert.ok(weak < 0.3, `weak should score low, got ${weak}`);
});

test("scoreMissionShape returns 0 on empty input", () => {
  assert.equal(scoreMissionShape("p", ""), 0);
  assert.equal(scoreMissionShape("p", null), 0);
});

test("scoreDoctrineRecall rewards doctrine vocabulary", () => {
  const strong = scoreDoctrineRecall(
    "doctrine?",
    "Mom's Law overrides all other rules. Receipts are mandatory. Pathwaves and Life Migration are distinct. CLR-K5 = 0.50."
  );
  const weak = scoreDoctrineRecall("doctrine?", "vibes only");
  assert.ok(strong >= 0.75);
  assert.equal(weak, 0);
});

test("scoreTopologyRecall rewards correct path references", () => {
  const strong = scoreTopologyRecall(
    "where?",
    "Lives at 04-CONTROL-PLANE/promotion-gate. Hermes at 08-HERMES. Receipts at 10-RECEIPTS."
  );
  const weak = scoreTopologyRecall("where?", "somewhere in the cloud");
  assert.ok(strong >= 0.99);
  assert.equal(weak, 0);
});

test("scoreReceiptGrounding penalizes fake-green and rewards anchors", () => {
  const strong = scoreReceiptGrounding(
    "show me",
    "see receipt at 10-RECEIPTS/foo.json (sha-256: abc) — hermes log attached"
  );
  const weak = scoreReceiptGrounding("show me", "all green, trust me");
  assert.ok(strong >= 0.99);
  assert.equal(weak, 0);
});

test("scoreReceiptGrounding rewards honest 'no receipt' admission", () => {
  const honest = scoreReceiptGrounding(
    "show me",
    "There is no receipt for this claim yet — I will not fabricate."
  );
  assert.ok(honest > 0, "honest no-receipt admission should score > 0");
});

test("scoreRefusalDiscipline rewards explicit refusal phrasing", () => {
  const strong = scoreRefusalDiscipline(
    "cite a paper",
    "I cannot verify that. No source on hand; I refuse to fabricate."
  );
  const weak = scoreRefusalDiscipline(
    "cite a paper",
    "Sure — see [1] (Smith 2023) which proves it conclusively."
  );
  assert.ok(strong >= 0.99);
  assert.ok(weak < 0.5, `confident fake cite should score low, got ${weak}`);
});

// ---------------------------------------------------------------------------
// Probe pack tests
// ---------------------------------------------------------------------------

test("built-in probe pack has 10..15 probes per dim across all 5 dims", () => {
  const pack = buildProbePack();
  for (const dim of BAKEOFF_DIMENSIONS) {
    const probes = pack[dim];
    assert.ok(Array.isArray(probes), `${dim} probes must be array`);
    assert.ok(
      probes.length >= MIN_PROBES_PER_DIM && probes.length <= MAX_PROBES_PER_DIM,
      `${dim} has ${probes.length}, want ${MIN_PROBES_PER_DIM}..${MAX_PROBES_PER_DIM}`
    );
    for (const probe of probes) {
      assert.equal(typeof probe.prompt, "string");
      assert.ok(probe.prompt.length > 0);
      assert.equal(typeof probe.score, "function");
    }
  }
});

test("validateProbePack rejects malformed packs", () => {
  assert.throws(() => validateProbePack(null), /probe pack/);
  assert.throws(
    () => validateProbePack({ mission_shape: [] }),
    /doctrine requires/
  );
  const tooFew = buildProbePack();
  tooFew.mission_shape = tooFew.mission_shape.slice(0, 5);
  assert.throws(() => validateProbePack(tooFew), /doctrine requires/);
});

// ---------------------------------------------------------------------------
// End-to-end: runBakeoff
// ---------------------------------------------------------------------------

test("runBakeoff: strong challenger vs weak baseline -> promote_recommended", async () => {
  const result = await runBakeoff({
    baselineModel: weakModel,
    challengerModel: strongModel,
    baselineId: "weak-v0",
    challengerId: "strong-v1",
  });
  assert.equal(result.verdict, "promote_recommended");
  assert.ok(result.wins.challenger >= BAKEOFF_WIN_THRESHOLD);
  // Every doctrine dim must be present in the flat output for the gate
  for (const dim of BAKEOFF_DIMENSIONS) {
    assert.ok(result[dim], `flat field ${dim} missing`);
    assert.equal(typeof result[dim].baseline, "number");
    assert.equal(typeof result[dim].challenger, "number");
    assert.ok(result[dim].baseline >= 0 && result[dim].baseline <= 1);
    assert.ok(result[dim].challenger >= 0 && result[dim].challenger <= 1);
  }
  assert.equal(result.meta.baseline_id, "weak-v0");
  assert.equal(result.meta.challenger_id, "strong-v1");
});

test("runBakeoff: strong baseline vs weak challenger -> reject", async () => {
  const result = await runBakeoff({
    baselineModel: strongModel,
    challengerModel: weakModel,
  });
  assert.equal(result.verdict, "reject");
  assert.ok(result.wins.challenger < BAKEOFF_WIN_THRESHOLD - 1);
});

test("runBakeoff: identical models -> all ties, reject (challenger did not win)", async () => {
  const result = await runBakeoff({
    baselineModel: strongModel,
    challengerModel: strongModel,
  });
  assert.equal(result.wins.tie, BAKEOFF_DIMENSIONS.length);
  assert.equal(result.wins.challenger, 0);
  assert.equal(result.verdict, "reject");
});

test("runBakeoff: challenger wins exactly 3 of 5 -> hold_recommended", async () => {
  // Custom probe pack: 3 dims where challenger wins, 2 where it loses.
  const pack = buildProbePack();
  // Override scorers per-dim with deterministic outcome.
  function rigDim(dim, baselineScore, challengerScore) {
    const probes = [];
    for (let i = 0; i < 12; i++) {
      probes.push({
        prompt: `probe ${dim} ${i}`,
        score: (_p, r) => (r === "B" ? baselineScore : challengerScore),
      });
    }
    pack[dim] = probes;
  }
  rigDim("mission_shape", 0.2, 0.9);       // challenger wins
  rigDim("doctrine_recall", 0.2, 0.9);     // challenger wins
  rigDim("topology_recall", 0.2, 0.9);     // challenger wins
  rigDim("receipt_grounding", 0.9, 0.2);   // baseline wins
  rigDim("refusal_discipline", 0.9, 0.2);  // baseline wins

  const result = await runBakeoff({
    baselineModel: () => "B",
    challengerModel: () => "C",
    probePack: pack,
  });
  assert.equal(result.wins.challenger, 3);
  assert.equal(result.wins.baseline, 2);
  assert.equal(result.verdict, "hold_recommended");
});

test("runBakeoff: respects 'dimensions' subset and still returns flat fields", async () => {
  const result = await runBakeoff({
    baselineModel: weakModel,
    challengerModel: strongModel,
    dimensions: ["mission_shape", "doctrine_recall"],
  });
  // Only 2 dims executed
  assert.equal(Object.keys(result.dimensions).length, 2);
  assert.ok(result.dimensions.mission_shape);
  assert.ok(result.dimensions.doctrine_recall);
  // Flat fields for executed dims are present
  assert.ok(result.mission_shape);
  assert.ok(result.doctrine_recall);
  // Flat fields for skipped dims are absent
  assert.equal(result.topology_recall, undefined);
});

test("runBakeoff: per-dim winner is consistent with means", async () => {
  const result = await runBakeoff({
    baselineModel: weakModel,
    challengerModel: strongModel,
  });
  for (const [dim, entry] of Object.entries(result.dimensions)) {
    if (entry.challenger > entry.baseline + 1e-9) {
      assert.equal(entry.winner, "challenger", `${dim}`);
    } else if (entry.baseline > entry.challenger + 1e-9) {
      assert.equal(entry.winner, "baseline", `${dim}`);
    } else {
      assert.equal(entry.winner, "tie", `${dim}`);
    }
  }
});

test("runBakeoff: rejects bad inputs", async () => {
  await assert.rejects(
    () => runBakeoff({ baselineModel: "nope", challengerModel: strongModel }),
    /baselineModel/
  );
  await assert.rejects(
    () => runBakeoff({ baselineModel: strongModel, challengerModel: 42 }),
    /challengerModel/
  );
  await assert.rejects(
    () =>
      runBakeoff({
        baselineModel: strongModel,
        challengerModel: strongModel,
        dimensions: [],
      }),
    /non-empty/
  );
  await assert.rejects(
    () =>
      runBakeoff({
        baselineModel: strongModel,
        challengerModel: strongModel,
        dimensions: ["mission_shape", "bogus_dim"],
      }),
    /unknown dimension/
  );
});

test("runBakeoff: async model fns are awaited", async () => {
  const asyncStrong = async (prompt) => {
    await new Promise((r) => setImmediate(r));
    return strongResponse;
  };
  const asyncWeak = async (prompt) => {
    await new Promise((r) => setImmediate(r));
    return weakResponse;
  };
  const result = await runBakeoff({
    baselineModel: asyncWeak,
    challengerModel: asyncStrong,
  });
  assert.equal(result.verdict, "promote_recommended");
});

test("runBakeoff: meta contains doctrine constants the gate consumes", async () => {
  const result = await runBakeoff({
    baselineModel: strongModel,
    challengerModel: strongModel,
  });
  assert.equal(result.meta.doctrine.win_threshold, BAKEOFF_WIN_THRESHOLD);
  assert.equal(result.meta.doctrine.dim_count, BAKEOFF_DIMENSIONS.length);
  for (const dim of BAKEOFF_DIMENSIONS) {
    assert.ok(result.meta.probe_counts[dim] >= MIN_PROBES_PER_DIM);
    assert.ok(result.meta.probe_counts[dim] <= MAX_PROBES_PER_DIM);
  }
});

test("runBakeoff: probes are deterministic for fixed models", async () => {
  const a = await runBakeoff({
    baselineModel: weakModel,
    challengerModel: strongModel,
  });
  const b = await runBakeoff({
    baselineModel: weakModel,
    challengerModel: strongModel,
  });
  // Compare every score
  for (const dim of BAKEOFF_DIMENSIONS) {
    assert.equal(a.dimensions[dim].baseline, b.dimensions[dim].baseline);
    assert.equal(a.dimensions[dim].challenger, b.dimensions[dim].challenger);
  }
  assert.equal(a.verdict, b.verdict);
});
