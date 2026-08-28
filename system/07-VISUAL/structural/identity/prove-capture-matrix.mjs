#!/usr/bin/env bun
// prove-capture-matrix.mjs — FABLE MOVE 5 evaluator + INVARIANCE LEDGER.
//
// The narrow physics test that gates everything else:
// "Can the system identify the object AFTER the photon conditions change?"
//
// Protocol: LEAVE-ONE-CONDITION-OUT. For each condition axis value (e.g.
// light=cool-fluor), train each object's subspace on all its OTHER samples,
// test on the held-out condition's samples. This measures invariance
// directly — not benchmark luck.
//
// Also computes the INVARIANCE LEDGER: per flatten-dim × per condition axis,
//   stability(d, axis) = mean_over_objects Var(sig_d | object fixed, only axis varies)
//                        ÷ Var(sig_d | objects vary)
// Low = invariant (good). Published as JSON — Mom's Law as a data structure.
//
// Pass criteria (Milestone 1, from the protocol):
//   Top-1 ≥ 70% on held-out conditions · unknown-gate honesty on novel objects.

import fs from "node:fs";
import path from "node:path";
import { attachFisherRatioToStore, flattenSignature, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { buildConceptSubspace, recognizeFrameMultiCandidate } from "./subspace-recall.mjs";

const STORE_PATH = process.argv[2] || "C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-matrix/store-capture-matrix.json";
const LEDGER_OUT = process.argv[3] || "C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-matrix/invariance-ledger.json";

const STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
console.log("=== CAPTURE-MATRIX EVAL · N=" + STORE.labels.length + " objects ===\n");
attachFisherRatioToStore(STORE);
const D = STORE.fisher_stats.D;
console.log("D=" + D);

function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? v[i] : 0;
  return out;
}
function vecOf(s) {
  return sanitize(standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats));
}

// ============================================================
// 1) INVARIANCE LEDGER
// ============================================================
const AXES = ["light", "angle", "background", "camera"];
console.log("\nComputing invariance ledger over axes: " + AXES.join(", "));

// Global per-dim variance (across everything)
const allVecs = [];
for (const row of STORE.labels) for (const s of row.signatures) allVecs.push(vecOf(s));
const globalVar = new Float64Array(D);
{
  const mean = new Float64Array(D);
  for (const v of allVecs) for (let d = 0; d < D; d++) mean[d] += v[d];
  for (let d = 0; d < D; d++) mean[d] /= allVecs.length;
  for (const v of allVecs) for (let d = 0; d < D; d++) { const x = v[d] - mean[d]; globalVar[d] += x * x; }
  for (let d = 0; d < D; d++) globalVar[d] /= Math.max(1, allVecs.length - 1);
}

// stability(d, axis): for each object, group its sigs by ALL OTHER condition
// values held equal while `axis` varies; average the variance of dim d within
// those groups; then average over objects; divide by global variance.
const ledger = {};
for (const axis of AXES) {
  const perDimSum = new Float64Array(D);
  let groupCount = 0;
  for (const row of STORE.labels) {
    // Group key = all conditions EXCEPT the axis (so only axis varies in-group)
    const groups = new Map();
    for (const s of row.signatures) {
      const c = s.conditions;
      const key = AXES.filter(a => a !== axis).map(a => c[a]).join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(vecOf(s));
    }
    for (const vecs of groups.values()) {
      if (vecs.length < 2) continue; // axis didn't vary in this group
      const mean = new Float64Array(D);
      for (const v of vecs) for (let d = 0; d < D; d++) mean[d] += v[d];
      for (let d = 0; d < D; d++) mean[d] /= vecs.length;
      for (const v of vecs) for (let d = 0; d < D; d++) { const x = v[d] - mean[d]; perDimSum[d] += x * x / Math.max(1, vecs.length - 1); }
      groupCount++;
    }
  }
  const stability = new Array(D);
  for (let d = 0; d < D; d++) {
    const within = groupCount ? perDimSum[d] / groupCount : 0;
    stability[d] = globalVar[d] > 1e-12 ? within / globalVar[d] : 0;
  }
  ledger[axis] = stability;
  // Report the 5 most fragile + 5 most invariant dims for this axis
  const idx = stability.map((s, d) => ({ d, s })).sort((a, b) => b.s - a.s);
  console.log("\n  Axis '" + axis + "' (groups: " + groupCount + "):");
  console.log("    Most FRAGILE dims : " + idx.slice(0, 5).map(x => x.d + "(" + x.s.toFixed(2) + ")").join(", "));
  console.log("    Most INVARIANT    : " + idx.slice(-5).map(x => x.d + "(" + x.s.toFixed(3) + ")").join(", "));
}
fs.writeFileSync(LEDGER_OUT, JSON.stringify({ axes: AXES, D, ledger, computed: "capture-matrix" }, null, 2));
console.log("\nInvariance ledger → " + LEDGER_OUT);

// ============================================================
// 2) LEAVE-ONE-CONDITION-OUT recognition
// ============================================================
console.log("\n=== LEAVE-ONE-CONDITION-OUT ===");
let totalTests = 0, totalCorrect = 0, totalUnknown = 0, totalConfWrong = 0;
const perAxisResults = {};

for (const axis of AXES) {
  const values = new Set();
  for (const row of STORE.labels) for (const s of row.signatures) values.add(s.conditions[axis]);
  perAxisResults[axis] = {};
  for (const heldValue of values) {
    // Build models excluding held condition; collect test sigs = held condition
    const models = new Map();
    const tests = [];
    for (const row of STORE.labels) {
      const train = row.signatures.filter(s => s.conditions[axis] !== heldValue);
      const test = row.signatures.filter(s => s.conditions[axis] === heldValue);
      if (train.length >= 3) {
        models.set(row.label, buildConceptSubspace(train.map(vecOf), { kMax: 4 }));
      }
      for (const t of test) tests.push({ label: row.label, vec: vecOf(t) });
    }
    if (!models.size || !tests.length) continue;
    let correct = 0, unknown = 0, confWrong = 0;
    for (const t of tests) {
      if (!models.has(t.label)) continue; // can't test untrainable object
      const r = recognizeFrameMultiCandidate([t.vec], models);
      if (r.unknownGate || !r.winner) unknown++;
      else if (r.winner === t.label) correct++;
      else confWrong++;
    }
    const n = correct + unknown + confWrong;
    perAxisResults[axis][heldValue] = { n, correct, unknown, confWrong };
    totalTests += n; totalCorrect += correct; totalUnknown += unknown; totalConfWrong += confWrong;
    console.log("  hold " + axis + "=" + String(heldValue).padEnd(12) +
      " n=" + String(n).padStart(3) +
      " correct=" + correct + " unknown=" + unknown + " confWrong=" + confWrong);
  }
}

console.log("\n=== TOTALS ===");
const pct = totalTests ? Math.round(totalCorrect / totalTests * 100) : 0;
const confPool = totalCorrect + totalConfWrong;
const confPct = confPool ? Math.round(totalCorrect / confPool * 100) : 0;
console.log("Held-out condition tests : " + totalTests);
console.log("Top-1 (overall)          : " + totalCorrect + "/" + totalTests + " = " + pct + "%");
console.log("Confident-only precision : " + totalCorrect + "/" + confPool + " = " + confPct + "%");
console.log("Unknown rate             : " + Math.round(totalUnknown / Math.max(1, totalTests) * 100) + "%");
console.log("\nMilestone 1 gate: Top-1 ≥ 70% → " + (pct >= 70 ? "PASS" : "NOT YET"));
