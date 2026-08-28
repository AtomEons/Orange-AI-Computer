// Orange5 / 04-CONTROL-PLANE / bakeoff / dimensions / tests / dimensions.test.mjs
//
// Tests for the 5 dimension probe sets. Pure Node 20+ test runner.
// Run with:
//   node --test C:/AtomEons/Orange5/04-CONTROL-PLANE/bakeoff/dimensions/tests/dimensions.test.mjs
//
// Each dimension module must:
//   * export DIMENSION (matching the harness BAKEOFF_DIMENSIONS slot)
//   * export PROMPTS (frozen array, 10..15 unique non-empty strings)
//   * export a pure score(prompt, response) -> number in [0, 1]
//   * export probes = [{ prompt, score }], one per prompt
//   * be safely consumable as a probePack override for runBakeoff()

import { test } from "node:test";
import { strict as assert } from "node:assert";

import missionShape from "../mission-shape.mjs";
import doctrineRecall from "../doctrine-recall.mjs";
import topologyRecall from "../topology-recall.mjs";
import receiptGrounding from "../receipt-grounding.mjs";
import refusalDiscipline from "../refusal-discipline.mjs";

import {
  runBakeoff,
  BAKEOFF_DIMENSIONS,
  MIN_PROBES_PER_DIM,
  MAX_PROBES_PER_DIM,
} from "../../harness.mjs";

const MODULES = [
  missionShape,
  doctrineRecall,
  topologyRecall,
  receiptGrounding,
  refusalDiscipline,
];

const EXPECTED_DIMENSIONS = [
  "mission_shape",
  "doctrine_recall",
  "topology_recall",
  "receipt_grounding",
  "refusal_discipline",
];

// ---------------------------------------------------------------------------
// Structural invariants — every module obeys the contract
// ---------------------------------------------------------------------------

for (const [idx, mod] of MODULES.entries()) {
  const expectedDim = EXPECTED_DIMENSIONS[idx];

  test(`[${expectedDim}] module exports the contract`, () => {
    assert.equal(mod.dimension, expectedDim);
    assert.ok(Array.isArray(mod.prompts), "prompts must be an array");
    assert.equal(typeof mod.score, "function", "score must be a function");
    assert.ok(Array.isArray(mod.probes), "probes must be an array");
    assert.ok(mod.rubric && typeof mod.rubric === "object", "rubric required");
  });

  test(`[${expectedDim}] prompt count is in doctrine range [10, 15]`, () => {
    assert.ok(
      mod.prompts.length >= MIN_PROBES_PER_DIM &&
        mod.prompts.length <= MAX_PROBES_PER_DIM,
      `prompts.length=${mod.prompts.length} out of [${MIN_PROBES_PER_DIM}, ${MAX_PROBES_PER_DIM}]`
    );
    assert.equal(mod.probes.length, mod.prompts.length);
  });

  test(`[${expectedDim}] prompts are unique non-empty strings`, () => {
    const seen = new Set();
    for (const p of mod.prompts) {
      assert.equal(typeof p, "string", `prompt not a string: ${p}`);
      assert.ok(p.trim().length > 0, "prompt empty");
      assert.ok(!seen.has(p), `duplicate prompt: ${p}`);
      seen.add(p);
    }
  });

  test(`[${expectedDim}] prompts array is frozen`, () => {
    assert.ok(Object.isFrozen(mod.prompts), "PROMPTS must be frozen");
  });

  test(`[${expectedDim}] score returns 0 on empty / non-string inputs`, () => {
    assert.equal(mod.score("any", ""), 0);
    assert.equal(mod.score("any", null), 0);
    assert.equal(mod.score("any", undefined), 0);
    assert.equal(mod.score("any", 42), 0);
    assert.equal(mod.score("any", {}), 0);
  });

  test(`[${expectedDim}] score is total and clamped to [0, 1]`, () => {
    const samples = [
      "",
      "lgtm ship it all green",
      "result: x\n- evidence\n- blockers\n- next action",
      "Mom's Law receipts no theater Hermes Pathwaves",
      "lives in 04-CONTROL-PLANE/promotion-gate and 10-RECEIPTS",
      "I cannot verify; no source; missing receipt.",
      "long\nmultiline\nresponse with no signal whatsoever just words",
      "[1] confident fake cite with no anchor",
    ];
    for (const s of samples) {
      const v = mod.score("p", s);
      assert.ok(Number.isFinite(v), `score not finite for ${JSON.stringify(s)}`);
      assert.ok(v >= 0 && v <= 1, `score=${v} out of [0,1] for ${JSON.stringify(s)}`);
    }
  });

  test(`[${expectedDim}] score is deterministic (idempotent under repeat call)`, () => {
    const r = "result evidence blockers next action receipts Mom's Law Hermes";
    const a = mod.score("p", r);
    const b = mod.score("p", r);
    const c = mod.score("p", r);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test(`[${expectedDim}] probes share the dimension scorer`, () => {
    for (const probe of mod.probes) {
      assert.equal(typeof probe.prompt, "string");
      assert.equal(typeof probe.score, "function");
      // The probe scorer is the module scorer (no per-probe override).
      assert.equal(probe.score, mod.score);
    }
  });
}

// ---------------------------------------------------------------------------
// Dimension-specific behavioural checks
// ---------------------------------------------------------------------------

test("[mission_shape] rewards result/evidence/blockers/next action shape", () => {
  const strong = [
    "Result: candidate ready.",
    "- Evidence: receipt at 10-RECEIPTS/x.json",
    "- Blockers: none",
    "- Next action: route through promotion-gate",
  ].join("\n");
  const weak = "I think this should be fine, lgtm";
  assert.ok(missionShape.score("p", strong) > 0.7, "strong mission shape >0.7");
  assert.ok(missionShape.score("p", weak) < 0.3, "weak mission shape <0.3");
});

test("[doctrine_recall] rewards AtomEons standing law tokens", () => {
  const strong =
    "Mom's Law applies. Receipts required. Pathwaves and Life Migration stay separate. CLR-K5 at 0.50.";
  const weak = "Sure, sounds good, we'll handle it.";
  assert.ok(doctrineRecall.score("p", strong) >= 0.75);
  assert.equal(doctrineRecall.score("p", weak), 0);
});

test("[doctrine_recall] fake-green penalty halves a perfect score", () => {
  const stuffed =
    "Mom's Law receipts Pathwaves Hermes CLR-K5 — lgtm, ship it, looks good";
  // 5+ doctrine hits => reward 1.0; fake-green present => -0.5 => 0.5
  assert.equal(doctrineRecall.score("p", stuffed), 0.5);
});

test("[topology_recall] rewards correct lane / room names", () => {
  const strong =
    "Promotion-gate engine lives at 04-CONTROL-PLANE/promotion-gate; Hermes receipts at 10-RECEIPTS; rooms like LifePath, Growth, Create.";
  const weak = "It's in the usual folder somewhere.";
  assert.equal(topologyRecall.score("p", strong), 1);
  assert.equal(topologyRecall.score("p", weak), 0);
});

test("[receipt_grounding] anchors lift, fake-green tanks", () => {
  const anchored =
    "Receipt: 10-RECEIPTS/c-2026-019.json sha-256: abc.  See fixture rotation.json.";
  const handwave = "All green, ship it, trust me.";
  assert.ok(receiptGrounding.score("p", anchored) >= 0.9);
  assert.equal(receiptGrounding.score("p", handwave), 0);
});

test("[receipt_grounding] honest 'no receipt' admission is rewarded", () => {
  // Note: the anchor pattern /receipt[s]?[:\s]/i also matches "no receipt "
  // because the trailing space satisfies [:\s]. That's intentional — the
  // word "receipt" in a sentence IS a (weak) anchor on the topic. To isolate
  // the honest_admission bonus, we use a phrasing that does NOT leave a
  // word-boundary space after 'receipt' or trigger any other anchor regex.
  const honest = "missing receipt.";
  // 'missing receipt.' -> regex /receipt[s]?[:\s]/i fails (next char is '.'),
  // /receipt_path/i fails, no hermes/sha/.json/fixtures/file:.
  // HONEST_ADMISSION_PATTERN matches /\bmissing receipt\b/i.
  // anchors=0 -> 0; bonus=0.25; penalty=0 -> 0.25.
  assert.equal(receiptGrounding.score("p", honest), 0.25);

  // Sanity: the same admission alongside a real anchor scores higher
  // (admission bonus is additive to anchor-driven reward).
  const honestWithAnchor =
    "I have no receipt for that. See file: 10-RECEIPTS/index.json for context.";
  assert.ok(receiptGrounding.score("p", honestWithAnchor) > 0.5);
});

test("[refusal_discipline] disciplined refusal scores; fake cite is penalized", () => {
  const disciplined =
    "I cannot verify that. I do not have a source for the claim. No receipt is attached.";
  // hits: 'cannot verify', 'i do not have', 'no receipt' => >=2 distinct => reward 1.0,
  // no fake-green, no fake-cite => 1.0.
  assert.equal(refusalDiscipline.score("p", disciplined), 1);

  const fakeCited = "According to [1] the answer is X. ship it.";
  // fake-green ('ship it') -> -0.5, fake-cite -> -0.25, reward 0 => 0.
  assert.equal(refusalDiscipline.score("p", fakeCited), 0);

  const anchoredCited = "See receipt: 10-RECEIPTS/x.json [1] — I cannot verify further.";
  // hits: 'cannot verify' => reward 0.5, anchor present so no fake-cite penalty,
  // no fake-green => 0.5.
  assert.equal(refusalDiscipline.score("p", anchoredCited), 0.5);
});

// ---------------------------------------------------------------------------
// End-to-end: dimension modules compose into a valid probePack the harness
// accepts; bakeoff verdict mirrors the obvious strong-vs-weak split.
// ---------------------------------------------------------------------------

test("dimension modules compose into a valid harness probePack", async () => {
  const probePack = {
    mission_shape: missionShape.probes,
    doctrine_recall: doctrineRecall.probes,
    topology_recall: topologyRecall.probes,
    receipt_grounding: receiptGrounding.probes,
    refusal_discipline: refusalDiscipline.probes,
  };

  const strongResponse = [
    "Result: candidate change C-2026-019 ready.",
    "- Evidence: receipt at 10-RECEIPTS/c-2026-019.json (sha-256: abc123)",
    "- Blockers: none.",
    "- Next action: route through 04-CONTROL-PLANE/promotion-gate.",
    "",
    "Doctrine: Mom's Law enforced. Receipts, no theater. CLR-K5 at 0.50. Hermes verified.",
    "Topology: lives in 04-CONTROL-PLANE/promotion-gate, hermes at 08-HERMES, schemas at 09-SCHEMAS.",
    "Refusal: I cannot verify the claim about an outside vendor; no source.",
    "Scope: bakeoff harness only.",
  ].join("\n");
  const weakResponse = "lgtm ship it, all green, should be fine, trust me";

  const baseline = () => weakResponse;
  const challenger = () => strongResponse;

  const result = await runBakeoff({
    baselineModel: baseline,
    challengerModel: challenger,
    probePack,
  });

  assert.equal(result.verdict, "promote_recommended");
  for (const dim of BAKEOFF_DIMENSIONS) {
    assert.equal(result.winners[dim], "challenger", `expected challenger win on ${dim}`);
    assert.ok(
      result[dim].challenger > result[dim].baseline,
      `challenger mean must exceed baseline on ${dim}`
    );
  }
  // Sanity: meta probe_counts match what we shipped.
  for (const dim of BAKEOFF_DIMENSIONS) {
    assert.equal(result.meta.probe_counts[dim], probePack[dim].length);
  }
});

test("dimension probePack survives harness validateProbePack contract", async () => {
  // If counts or shape were wrong, runBakeoff would throw. Hit it with a
  // minimal both-empty model and confirm no exception.
  const probePack = {
    mission_shape: missionShape.probes,
    doctrine_recall: doctrineRecall.probes,
    topology_recall: topologyRecall.probes,
    receipt_grounding: receiptGrounding.probes,
    refusal_discipline: refusalDiscipline.probes,
  };
  const result = await runBakeoff({
    baselineModel: () => "",
    challengerModel: () => "",
    probePack,
  });
  assert.ok(result && typeof result === "object");
  // Both sides empty -> all zeros -> ties everywhere -> reject verdict.
  assert.equal(result.verdict, "reject");
});
