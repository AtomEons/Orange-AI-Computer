// loom-epistemic.test.mjs — regression suite built from REAL historical failures.
//
// Every BLOCK case below is an actual wrong conclusion from the AEyes-1 Orange
// Campaign that passed all procedural gates and was later overturned by an
// external auditor. If this gate had been in the spine, each would have been
// caught at the crossing instead of days later by hand.
//
// Run: bun 08-HERMES/tests/loom-epistemic.test.mjs

import { evaluateEpistemicGates } from '../src/loom-epistemic.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function hasCheck(r, check) { return r.findings.some(f => f.check === check); }
function blocksOn(r, check) { return r.blocks.some(f => f.check === check); }

console.log('\nLOOM epistemic gate — historical regression suite\n');

// ══════════════════════════════════════════════════════════════════
// HISTORICAL FAILURE 1 — spine seq 170
// Claimed: "tier2 PERFECT discrimination, TPR=100% FPR=0%"
// Reality: orange images were fruit close-ups; "apple" images were orchard
//          scenes. The separator was plausibly scene structure, not category.
// Overturned by: GPT audit (#23).
// ══════════════════════════════════════════════════════════════════
t('seq 170 — apple-TREE scene confound is BLOCKED', () => {
  const r = evaluateEpistemicGates(
    { statement: 'Two laws achieve PERFECT discrimination of oranges from apples (TPR=100%, FPR=0%)' },
    {
      n: 10, sampleCount: 10, coverage: 1.0,
      rateBounds: { FPR: { bound: 0.10, n: 2 } },
      classesSceneMatched: false,
      confoundsControlled: [],
      primaryCI: [0.72, 1.0],
    },
    {}
  );
  assert(!r.passed, 'must not pass');
  assert(blocksOn(r, 'CONFOUND_UNRULED'), 'must block on CONFOUND_UNRULED');
  assert(blocksOn(r, 'SAMPLE_POWER'), 'must block on SAMPLE_POWER (2 negatives vs 0.10 bound)');
  assert(blocksOn(r, 'STRENGTH_MISMATCH'), 'must block "PERFECT" at n=10');
});

// ══════════════════════════════════════════════════════════════════
// HISTORICAL FAILURE 2 — L9/L10/L11 tournament
// Claimed: TPR=100% on tier2.
// Reality: lane-AUC atlas was built on the full Bank D, then top-K lane
//          selection was scored by leave-one-out over that SAME Bank D.
//          Nested re-run dropped TPR from 1.00 to 0.60 — inflation of 0.40.
// Overturned by: GPT audit (#23) demanding selection-integrity audit.
// ══════════════════════════════════════════════════════════════════
t('L9/L10/L11 — selection leakage is BLOCKED', () => {
  const ids = ['obs1', 'obs2', 'obs3', 'obs4', 'obs5', 'obs6', 'obs7', 'obs8'];
  const r = evaluateEpistemicGates(
    { statement: 'L11 best-lane-first demonstrates 100% TPR on held-out positives' },
    {
      n: 8, coverage: 1.0,
      selectionSet: ids,                       // atlas built on all of Bank D
      evaluationSet: ids,                      // ...then scored on all of Bank D
      dataDependentParams: ['lane_AUC_ranking', 'top_K_lane_selection', 'best_lane_order'],
    },
    {}
  );
  assert(!r.passed, 'must not pass');
  assert(blocksOn(r, 'SELECTION_LEAKAGE'), 'must block on SELECTION_LEAKAGE');
  const f = r.blocks.find(x => x.check === 'SELECTION_LEAKAGE');
  assert(/8\/8/.test(f.detail), `should report full overlap, got: ${f.detail}`);
});

// ══════════════════════════════════════════════════════════════════
// HISTORICAL FAILURE 3 — spine seq 160
// Claimed: "GENUINE_POS_NEG_FEATURE_OVERLAP confirmed — substrate does not
//          discriminate" from 7 positives / 7 negatives.
// Reality: premature. One majority-vote law failing on 14 samples cannot
//          establish a substrate property. 12 further laws were untested.
// Overturned by: GPT audit (#22).
// ══════════════════════════════════════════════════════════════════
t('seq 160 — premature substrate verdict is BLOCKED', () => {
  const r = evaluateEpistemicGates(
    { statement: 'CONFIRMED: genuine feature overlap — the substrate does not discriminate orange from neighbours' },
    {
      n: 7, coverage: 1.0,
      rateBounds: { FPR: { bound: 0.10, n: 7 } },   // 1/7 = 0.143 > 0.10
      primaryCI: [0.29, 0.96],                       // very wide at n=7
    },
    {}
  );
  assert(!r.passed, 'must not pass');
  assert(blocksOn(r, 'SAMPLE_POWER'), 'must block: 1 error in 7 = 0.143 exceeds the 0.10 bound');
  assert(blocksOn(r, 'STRENGTH_MISMATCH'), 'must block wide CI under a "CONFIRMED" claim');
});

// ══════════════════════════════════════════════════════════════════
// The abstention trap — caught early in the campaign, encoded so it stays caught.
// TPR=0 / FPR=0 looks flawless and recognizes nothing.
// ══════════════════════════════════════════════════════════════════
t('abstention mask — safe-but-useless is BLOCKED', () => {
  const r = evaluateEpistemicGates(
    { statement: 'Zero false positives across the entire hard-negative bank' },
    { n: 20, coverage: 0.05, observedFPR: 0.0, observedTPR: 0.0 },
    {}
  );
  assert(!r.passed, 'must not pass');
  assert(blocksOn(r, 'ABSTENTION_MASK'), 'must block at 5% coverage');
});

// ══════════════════════════════════════════════════════════════════
// Supersession — a contradicting claim must declare it.
// ══════════════════════════════════════════════════════════════════
t('undeclared contradiction of a live receipt is BLOCKED', () => {
  const r = evaluateEpistemicGates(
    { statement: 'The substrate discriminates these categories reliably' },
    { n: 40, coverage: 0.9 },
    { relatedPriorClaims: [{ seq: 160, summary: 'substrate does not discriminate', contradicts: true, superseded: false }] }
  );
  assert(!r.passed, 'must not pass');
  assert(blocksOn(r, 'SUPERSESSION_CONFLICT'), 'must block undeclared contradiction');
});

t('declared supersession PASSES', () => {
  const r = evaluateEpistemicGates(
    { statement: 'The substrate discriminates these categories reliably', supersedes: [160] },
    { n: 40, coverage: 0.9 },
    { relatedPriorClaims: [{ seq: 160, summary: 'substrate does not discriminate', contradicts: true, superseded: false }] }
  );
  assert(r.passed, `declared supersession should pass, got: ${JSON.stringify(r.first_fail)}`);
});

// ══════════════════════════════════════════════════════════════════
// TRUE NEGATIVES — a well-formed claim must pass cleanly, or the gate is noise.
// ══════════════════════════════════════════════════════════════════
t('well-evidenced hedged claim PASSES clean', () => {
  const r = evaluateEpistemicGates(
    { statement: 'Results are consistent with category separation on scene-matched pairs (n=120)' },
    {
      n: 120, coverage: 0.94,
      rateBounds: { FPR: { bound: 0.10, n: 120 } },
      selectionSet: ['a', 'b', 'c'], evaluationSet: ['x', 'y', 'z'],
      dataDependentParams: ['lane_AUC_ranking'],
      classesSceneMatched: true,
      primaryCI: [0.81, 0.93],
    },
    {}
  );
  assert(r.passed, `should pass, got: ${JSON.stringify(r.first_fail)}`);
  assert(r.blocks.length === 0, 'no blocks expected');
  assert(r.epistemicScore >= 0.9, `score should be high, got ${r.epistemicScore}`);
});

t('the CORRECTED seq 173 finding PASSES — nested + scene-matched + honest', () => {
  const r = evaluateEpistemicGates(
    { statement: 'Under nested evaluation, tier2 apple-FRUIT FPR is 0.00 — consistent with real category discrimination', supersedes: [170] },
    {
      n: 26, coverage: 1.0,
      selectionSet: ['train1', 'train2'], evaluationSet: ['heldout1', 'heldout2'],
      dataDependentParams: ['lane_AUC_ranking'],
      classesSceneMatched: true,
      confoundsControlled: ['background', 'scene', 'framing'],
      primaryCI: [0.31, 0.83],
    },
    { relatedPriorClaims: [{ seq: 170, summary: 'tier2 perfect via scene confound', contradicts: true, superseded: false }] }
  );
  assert(r.passed, `corrected finding should pass, got: ${JSON.stringify(r.first_fail)}`);
});

t('unmarked ordinary claim with sound evidence PASSES', () => {
  const r = evaluateEpistemicGates(
    { statement: 'Chain integrity verified across 228 receipts' },
    { n: 228, coverage: 1.0 },
    {}
  );
  assert(r.passed, `should pass, got: ${JSON.stringify(r.first_fail)}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
