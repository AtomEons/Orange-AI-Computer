#!/usr/bin/env bun
// Tests for the density-cluster binder.
// Standalone Bun harness. Prints:  Summary: N pass / M fail of T
//
// Coverage:
//   - Determinism: same R + opts → bit-exact identical entities + notes
//   - Uniform R → 0 entities with an honest note
//   - Two synthetic bright blobs on dark bg → >= 2 entities
//   - Input shape mismatch → 0 entities with a note (no throw)
//   - notes[] is non-empty for any successful run (Mom's Law channel)
//   - Entities are sorted largest-first
//   - Contract shape: entities each carry { id, region:[x,y,w,h], notes? }

import { bind, DISCIPLINE, __densityClusterInternals } from "../density-cluster.mjs";

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${a} !== ${b}`); };

// --- fixture builders ---

function uniformR(w, h, v = 0.5) {
  const R = new Float32Array(w * h).fill(v);
  return R;
}

// Two Gaussian bright blobs on a dark background.
function twoBlobsR(w, h) {
  const R = new Float32Array(w * h);
  const blobs = [
    { cx: w * 0.28, cy: h * 0.5, sigma: Math.min(w, h) * 0.10, amp: 0.9 },
    { cx: w * 0.72, cy: h * 0.5, sigma: Math.min(w, h) * 0.10, amp: 0.9 },
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0.02; // dark bg
      for (const b of blobs) {
        const dx = x - b.cx;
        const dy = y - b.cy;
        const r2 = dx * dx + dy * dy;
        v += b.amp * Math.exp(-r2 / (2 * b.sigma * b.sigma));
      }
      if (v > 1) v = 1;
      R[y * w + x] = v;
    }
  }
  return R;
}

// A single centered bright disc, sized so it must span at least minPts cells.
function singleDiscR(w, h) {
  const R = new Float32Array(w * h).fill(0.02);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const radius = Math.min(w, h) * 0.25;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) R[y * w + x] = 0.9;
    }
  }
  return R;
}

// --- tests ---

test("exports_expected_shape", () => {
  eq(DISCIPLINE, "density-cluster", "DISCIPLINE constant");
  ok(typeof bind === "function", "bind is a function");
  ok(__densityClusterInternals && __densityClusterInternals.DEFAULTS, "internals exported");
  return "ok";
});

test("input_shape_mismatch_returns_empty_no_throw", () => {
  const R = new Float32Array(10);
  const result = bind(R, 5, 5, {}); // 25 expected vs 10 given
  eq(result.discipline, "density-cluster");
  ok(Array.isArray(result.entities) && result.entities.length === 0, "no entities");
  ok(result.notes.some((n) => /input mismatch/.test(n)), "mismatch note present");
  return "ok";
});

test("uniform_R_yields_zero_entities_with_note", () => {
  const w = 200, h = 200;
  const R = uniformR(w, h, 0.5);
  const result = bind(R, w, h, {});
  eq(result.entities.length, 0, "uniform → 0 entities");
  ok(result.notes.some((n) => /uniform-R/.test(n)), "uniform-R note present");
  return `ok (${result.notes.length} notes emitted)`;
});

test("two_bright_blobs_yield_at_least_two_entities", () => {
  const w = 200, h = 200;
  const R = twoBlobsR(w, h);
  const result = bind(R, w, h, {});
  ok(result.entities.length >= 2, `expected >=2 entities, got ${result.entities.length}`);
  // Both blobs are bright + big; largest two should occupy sensible-size boxes.
  const top2 = result.entities.slice(0, 2);
  for (const e of top2) {
    ok(Array.isArray(e.region) && e.region.length === 4, "region is [x,y,w,h]");
    const [x, y, rw, rh] = e.region;
    ok(x >= 0 && y >= 0 && rw > 0 && rh > 0, "region positive");
    ok(x + rw <= w && y + rh <= h, "region within image bounds");
  }
  return `ok (${result.entities.length} entities on two-blob fixture)`;
});

test("single_bright_disc_yields_one_entity", () => {
  const w = 200, h = 200;
  const R = singleDiscR(w, h);
  const result = bind(R, w, h, {});
  ok(result.entities.length >= 1, `expected >=1 entity, got ${result.entities.length}`);
  const e = result.entities[0];
  // Region should sit somewhere around the center.
  const [x, y, rw, rh] = e.region;
  const cx = x + rw / 2, cy = y + rh / 2;
  ok(Math.abs(cx - w / 2) < w * 0.25, `region center x=${cx.toFixed(1)} not near ${w / 2}`);
  ok(Math.abs(cy - h / 2) < h * 0.25, `region center y=${cy.toFixed(1)} not near ${h / 2}`);
  return `ok (top region center at ${cx.toFixed(0)},${cy.toFixed(0)})`;
});

test("determinism_same_input_same_output", () => {
  const w = 200, h = 200;
  const R = twoBlobsR(w, h);
  const a = bind(R, w, h, {});
  const b = bind(R, w, h, {});
  eq(a.entities.length, b.entities.length, "same entity count");
  for (let i = 0; i < a.entities.length; i++) {
    const ra = a.entities[i].region;
    const rb = b.entities[i].region;
    eq(ra[0], rb[0], `entity ${i} x`);
    eq(ra[1], rb[1], `entity ${i} y`);
    eq(ra[2], rb[2], `entity ${i} w`);
    eq(ra[3], rb[3], `entity ${i} h`);
  }
  eq(a.notes.length, b.notes.length, "same notes count");
  for (let i = 0; i < a.notes.length; i++) eq(a.notes[i], b.notes[i], `note ${i} identical`);
  return `ok (${a.entities.length} entities identical across runs)`;
});

test("entities_sorted_largest_first", () => {
  const w = 240, h = 240;
  // Two blobs of different sizes so ordering is unambiguous.
  const R = new Float32Array(w * h).fill(0.02);
  const putGauss = (cx, cy, sigma, amp) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy;
        const v = amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        const idx = y * w + x;
        const combined = R[idx] + v;
        R[idx] = combined > 1 ? 1 : combined;
      }
    }
  };
  // Both blobs must be at least cellSize-large or DBSCAN will drop them.
  // Place them on opposite corners so density does not chain-link them into
  // one cluster (DBSCAN's known behavior: adjacent dense cells merge).
  putGauss(w * 0.22, h * 0.25, 25, 0.9); // big upper-left
  putGauss(w * 0.78, h * 0.75, 18, 0.9); // smaller lower-right
  const result = bind(R, w, h, {});
  ok(result.entities.length >= 2, `expected >=2 entities, got ${result.entities.length}`);
  const areas = result.entities.map((e) => e.region[2] * e.region[3]);
  for (let i = 1; i < areas.length; i++) {
    ok(areas[i] <= areas[i - 1], `entity ${i} area ${areas[i]} > previous ${areas[i - 1]}`);
  }
  return `ok (${areas.length} entities, area sequence descending)`;
});

test("notes_are_populated_on_successful_bind", () => {
  const w = 200, h = 200;
  const R = twoBlobsR(w, h);
  const result = bind(R, w, h, {});
  ok(Array.isArray(result.notes) && result.notes.length > 0, "notes non-empty");
  ok(result.notes.some((n) => /fails on:/.test(n)), "standing failure-modes note present");
  ok(result.notes.some((n) => /assumes:/.test(n)), "standing assumptions note present");
  ok(result.notes.some((n) => /deterministic/.test(n)), "determinism note present");
  ok(result.notes.some((n) => /dbscan:/.test(n)), "dbscan config note present");
  ok(result.notes.some((n) => /grid:/.test(n)), "grid config note present");
  return `ok (${result.notes.length} notes emitted)`;
});

test("entity_ids_are_sequential_from_zero", () => {
  const w = 200, h = 200;
  const R = twoBlobsR(w, h);
  const result = bind(R, w, h, {});
  ok(result.entities.length >= 2, "need >=2 entities to test");
  for (let i = 0; i < result.entities.length; i++) {
    eq(result.entities[i].id, i, `entity[${i}].id`);
  }
  return `ok (${result.entities.length} sequential ids)`;
});

test("opts_override_changes_output", () => {
  const w = 200, h = 200;
  const R = twoBlobsR(w, h);
  const defaultOut = bind(R, w, h, {});
  const strictOut = bind(R, w, h, { minPts: 100 }); // impossible → no clusters
  ok(defaultOut.entities.length >= 2, "default finds blobs");
  eq(strictOut.entities.length, 0, "impossible minPts → 0 entities");
  ok(strictOut.notes.some((n) => /no-cluster/.test(n)), "no-cluster note present");
  return "ok";
});

// --- runner ---

let pass = 0, fail = 0;
for (const t of TESTS) {
  try {
    const msg = t.fn();
    console.log(`PASS  ${t.name}${msg ? "  — " + msg : ""}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${t.name}  — ${e.message}`);
    fail++;
  }
}
console.log(`\nSummary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
process.exit(fail === 0 ? 0 : 1);
