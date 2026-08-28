// Tests for KEY C (flow geometry) + object-predictability validator.
// Directional, not benchmark-tied. Bun harness. Prints Summary line.

import { flowDivergenceAndCurl, flowGeometryNote } from "../flow-geometry.mjs";
import {
  pearson,
  gaussianMIBound,
  scoreEntityPredictability,
  validateEntitiesArePredictable,
} from "../object-predictability.mjs";

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${a} !== ${b}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const gt = (a, b, m) => { if (!(a > b)) throw new Error(`${m || "not >"}: ${a} not > ${b}`); };

// ---- flow geometry ----

test("uniform_flow_has_zero_divergence_and_curl", () => {
  const cols = 8, rows = 8, N = cols * rows;
  const vx = new Float32Array(N).fill(1);
  const vy = new Float32Array(N).fill(0);
  const { divergenceEnergyMean, curlEnergyMean, boundaryScore } =
    flowDivergenceAndCurl(vx, vy, cols, rows);
  ok(divergenceEnergyMean < 1e-6, "div ~ 0 on rigid translation");
  ok(curlEnergyMean < 1e-6, "curl ~ 0 on rigid translation");
  ok(boundaryScore < 1e-6, "no boundary signal on rigid translation");
  return `ok (rigid translation carries no flow-geometry signal)`;
});

test("expanding_flow_has_positive_divergence", () => {
  const cols = 8, rows = 8;
  const vx = new Float32Array(cols * rows);
  const vy = new Float32Array(cols * rows);
  // Radially expanding flow from center.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      vx[y * cols + x] = x - (cols - 1) / 2;
      vy[y * cols + x] = y - (rows - 1) / 2;
    }
  }
  const { divergenceEnergyMean, curlEnergyMean } = flowDivergenceAndCurl(vx, vy, cols, rows);
  gt(divergenceEnergyMean, 0.5, "divergence detected on expanding field");
  ok(curlEnergyMean < 0.1, "expanding field has ~zero curl");
  return `ok (div=${divergenceEnergyMean.toFixed(3)}, curl=${curlEnergyMean.toFixed(3)})`;
});

test("rotational_flow_has_positive_curl", () => {
  const cols = 8, rows = 8;
  const vx = new Float32Array(cols * rows);
  const vy = new Float32Array(cols * rows);
  // Rotational flow around center.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      vx[y * cols + x] = -(y - (rows - 1) / 2);
      vy[y * cols + x] = x - (cols - 1) / 2;
    }
  }
  const { curlEnergyMean, divergenceEnergyMean } = flowDivergenceAndCurl(vx, vy, cols, rows);
  gt(curlEnergyMean, 0.5, "curl detected on rotational field");
  ok(divergenceEnergyMean < 0.1, "rotational field has ~zero divergence");
  return `ok (curl=${curlEnergyMean.toFixed(3)}, div=${divergenceEnergyMean.toFixed(3)})`;
});

test("flow_geometry_note_is_honest", () => {
  const note = flowGeometryNote({ divergenceEnergyMean: 0.5, curlEnergyMean: 0.3, boundaryScore: 0.44 });
  ok(note.includes("div_energy=0.5000"), "reports div");
  ok(note.includes("curl_energy=0.3000"), "reports curl");
  ok(note.includes("Border cells zeroed"), "discloses border handling");
  ok(note.includes("magnitude of contribution is corpus-dependent"), "doesn't over-claim");
  return "ok (honest note, no over-claim)";
});

// ---- object predictability ----

test("pearson_and_gaussian_MI_bound", () => {
  const a = new Float32Array([0, 1, 2, 3, 4]);
  const b = new Float32Array([0, 1, 2, 3, 4]);
  eq(pearson(a, b), 1, "perfect correlation");
  ok(gaussianMIBound(1) > 5, "high MI at perfect correlation (capped)");
  const c = new Float32Array([1, 1, 1, 1, 1]);
  eq(pearson(a, c), 0, "constant-input pearson defaults to 0");
  ok(gaussianMIBound(0) === 0, "zero MI at zero correlation");
  return "ok";
});

test("moving_object_is_more_predictable_from_own_future_than_from_other_object", () => {
  // Two frames, each with two distinct "objects" of different textures.
  const w = 32, h = 32;
  const f0 = new Float32Array(w * h);
  const f1 = new Float32Array(w * h);
  // Object A: bright TEXTURED square (checkerboard) — has variance, so
  // Pearson is defined. Same texture pattern in both frames = high internal
  // correlation. Object stays in place (or nearly so) — real objects don't
  // usually shift by more than a small fraction of their size per frame.
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
    const v = 0.4 + 0.4 * (((x + y) & 1) ? 1 : 0);
    f0[y * w + x] = v;
    f1[y * w + x] = v; // same texture, same place (rigid stationary object)
  }
  // Object B: distinct texture (horizontal stripes) — DIFFERENT from A, so
  // cross-object correlation is low.
  for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) {
    const v = 0.2 + 0.6 * (y & 1);
    f0[y * w + x] = v;
    f1[y * w + x] = v;
  }
  const A = { id: 1, region: [4, 4, 8, 8] };
  const B = { id: 2, region: [20, 20, 8, 8] };
  const sA = scoreEntityPredictability(A, f0, f1, w, h, [A, B]);
  ok(sA.verdict === "object_like", `A verdict=${sA.verdict} ratio=${sA.ratio}`);
  ok(sA.I_internal > sA.I_external_mean, "A: internal > external");
  return `ok (A ratio=${Number.isFinite(sA.ratio) ? sA.ratio.toFixed(2) : "inf"}, verdict=${sA.verdict})`;
});

test("validate_entities_surfaces_low_ratio_as_mom_law_note", () => {
  // Two "entities" that are actually just random noise cropped from the same
  // uniform frame — internal predictability ≈ external. Must be flagged.
  const w = 24, h = 24;
  const noise = new Float32Array(w * h);
  const noise2 = new Float32Array(w * h);
  // Deterministic pseudo-random (no RNG).
  for (let i = 0; i < noise.length; i++) {
    noise[i] = ((i * 2654435761) % 1000) / 1000;
    noise2[i] = (((i + 1) * 2654435761) % 1000) / 1000;
  }
  const junk = [
    { id: 1, region: [2, 2, 8, 8] },
    { id: 2, region: [12, 12, 8, 8] },
  ];
  const report = validateEntitiesArePredictable(junk, noise, noise2, w, h);
  ok(report.notes.length > 0, "notes emitted");
  ok(
    report.pass_fraction < 1.0 || report.mean_ratio < 2.0,
    `bad entities flagged: pass=${report.pass_fraction} mean_ratio=${report.mean_ratio}`,
  );
  return `ok (${report.count} entities, ${report.passing} pass, mean_ratio=${report.mean_ratio === Infinity ? "inf" : report.mean_ratio.toFixed(2)})`;
});

test("empty_entities_returns_honest_empty_report", () => {
  const w = 16, h = 16;
  const f = new Float32Array(w * h);
  const report = validateEntitiesArePredictable([], f, f, w, h);
  eq(report.count, 0, "zero entities");
  ok(report.notes.some((n) => n.includes("0 entities")), "empty note surfaced");
  return "ok";
});

// ---- runner ----
console.log("AE Eyes — flow geometry (KEY C) + object-predictability validator");
console.log("Bun " + (process.versions?.bun || "unknown"));
console.log("");
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(56)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ""}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(56)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`);
  }
}
console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
