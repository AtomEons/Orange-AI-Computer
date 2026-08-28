#!/usr/bin/env bun
// Standalone test harness for predictive-error-grouping binder.
// Contract: prints `Summary: N pass / M fail of T`. Exit code 0 iff all pass.

import { bind, DISCIPLINE } from "../predictive-error-grouping.mjs";

let pass = 0, fail = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    if (e.stack) console.log(e.stack.split("\n").slice(1, 4).map((s) => "        " + s).join("\n"));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "not equal"}: got ${actual}, want ${expected}`);
}

// ---- Fixture builders ----

// A uniform field — no structure to surprise the predictor.
function uniformField(W, H, v = 0.5) {
  const R = new Float32Array(W * H);
  R.fill(v);
  return R;
}

// Background = one value; N smooth disk-shaped blobs at another value.
// The blob interiors are smooth (predictable) → each should bind as one entity.
function nBlobField(W, H, centers) {
  const R = new Float32Array(W * H);
  const bg = 0.1;
  R.fill(bg);
  const r = Math.max(4, Math.floor(Math.min(W, H) * 0.10));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const [cx, cy] of centers) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) {
          R[y * W + x] = 0.85;
        }
      }
    }
  }
  return R;
}

// Copy a Float32Array — for deterministic re-run comparisons.
function cloneF32(a) {
  const b = new Float32Array(a.length);
  b.set(a);
  return b;
}

// ---- Tests ----

console.log("=== predictive-error-grouping binder tests ===");

test("exports DISCIPLINE === 'predictive-error-grouping'", () => {
  assertEq(DISCIPLINE, "predictive-error-grouping");
});

test("exports bind() function", () => {
  assert(typeof bind === "function", "bind is not a function");
});

test("bind() returns valid shape on trivial input", () => {
  const R = uniformField(8, 8);
  const out = bind(R, 8, 8);
  assert(out && typeof out === "object", "no result");
  assertEq(out.discipline, "predictive-error-grouping");
  assert(Array.isArray(out.entities), "entities not array");
  assert(Array.isArray(out.notes), "notes not array");
  assert(out.notes.length > 0, "must always disclose predictor kernel + thresholds");
});

test("uniform-R (fully predictable) → exactly 1 entity spanning the whole frame", () => {
  const W = 40, H = 40;
  const R = uniformField(W, H, 0.5);
  const out = bind(R, W, H);
  assertEq(out.entities.length, 1, "uniform frame is one perfectly-predictable region");
  const region = out.entities[0].region;
  assertEq(region[0], 0, "uniform entity x=0");
  assertEq(region[1], 0, "uniform entity y=0");
  assertEq(region[2], W, "uniform entity w=W");
  assertEq(region[3], H, "uniform entity h=H");
  const joined = out.notes.join(" ").toLowerCase();
  assert(joined.includes("uniform"), "notes must honestly disclose uniform-R case, got: " + joined);
});

test("3 smooth blobs on a smooth background → ≥3 entities", () => {
  const W = 100, H = 60;
  // Three well-separated blob centers.
  const centers = [
    [Math.floor(W * 0.20), Math.floor(H * 0.50)],
    [Math.floor(W * 0.50), Math.floor(H * 0.50)],
    [Math.floor(W * 0.80), Math.floor(H * 0.50)],
  ];
  const R = nBlobField(W, H, centers);
  // Small blobs — drop minArea so they qualify.
  const out = bind(R, W, H, { minArea: 20 });
  assert(
    out.entities.length >= 3,
    `expected ≥3 entities for 3 blobs on smooth bg, got ${out.entities.length}`,
  );
});

test("determinism: identical R → identical entity list", () => {
  const W = 80, H = 60;
  const centers = [
    [Math.floor(W * 0.25), Math.floor(H * 0.50)],
    [Math.floor(W * 0.75), Math.floor(H * 0.50)],
  ];
  const R1 = nBlobField(W, H, centers);
  const R2 = cloneF32(R1);
  const a = bind(R1, W, H, { minArea: 20 });
  const b = bind(R2, W, H, { minArea: 20 });
  assertEq(a.entities.length, b.entities.length, "entity count differs across runs");
  for (let i = 0; i < a.entities.length; i++) {
    const ea = a.entities[i], eb = b.entities[i];
    assertEq(ea.id, eb.id, `id[${i}] differs`);
    assertEq(ea.region[0], eb.region[0], `region.x[${i}] differs`);
    assertEq(ea.region[1], eb.region[1], `region.y[${i}] differs`);
    assertEq(ea.region[2], eb.region[2], `region.w[${i}] differs`);
    assertEq(ea.region[3], eb.region[3], `region.h[${i}] differs`);
  }
});

test("all entity bboxes lie inside the frame with integer coords", () => {
  const W = 96, H = 72;
  const centers = [
    [Math.floor(W * 0.25), Math.floor(H * 0.30)],
    [Math.floor(W * 0.75), Math.floor(H * 0.30)],
    [Math.floor(W * 0.50), Math.floor(H * 0.75)],
  ];
  const R = nBlobField(W, H, centers);
  const out = bind(R, W, H, { minArea: 20 });
  for (const e of out.entities) {
    assert(Array.isArray(e.region) && e.region.length === 4, "region must be [x,y,w,h]");
    const [x, y, w, h] = e.region;
    assert(
      Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h),
      `region ints required, got ${JSON.stringify(e.region)}`,
    );
    assert(x >= 0 && y >= 0, `bbox origin negative: (${x},${y})`);
    assert(w > 0 && h > 0, `bbox zero-size: ${w}x${h}`);
    assert(x + w <= W, `bbox exceeds W: ${x}+${w} > ${W}`);
    assert(y + h <= H, `bbox exceeds H: ${y}+${h} > ${H}`);
  }
});

test("entity ids are unique and start at 1", () => {
  const W = 80, H = 60;
  const centers = [
    [Math.floor(W * 0.25), Math.floor(H * 0.50)],
    [Math.floor(W * 0.75), Math.floor(H * 0.50)],
  ];
  const R = nBlobField(W, H, centers);
  const out = bind(R, W, H, { minArea: 20 });
  const ids = out.entities.map((e) => e.id);
  const set = new Set(ids);
  assertEq(set.size, ids.length, "ids must be unique");
  if (ids.length > 0) {
    assertEq(Math.min(...ids), 1, "ids should start at 1");
  }
});

test("degenerate input (mismatched R length) → honest zero + disclosure note", () => {
  const bad = new Float32Array(10);
  const out = bind(bad, 32, 32);
  assertEq(out.entities.length, 0);
  const joined = out.notes.join(" ").toLowerCase();
  assert(
    joined.includes("mismatch") || joined.includes("length"),
    "must disclose length mismatch honestly, got: " + joined,
  );
});

test("frame too small for kernel (2x2 with K=3) → honest zero", () => {
  const R = new Float32Array(4);
  R[0] = 0.1; R[1] = 0.9; R[2] = 0.9; R[3] = 0.1;
  const out = bind(R, 2, 2);
  assertEq(out.entities.length, 0);
  const joined = out.notes.join(" ").toLowerCase();
  assert(
    joined.includes("smaller than kernel") || joined.includes("no valid residuals"),
    "must disclose kernel-vs-frame-size, got: " + joined,
  );
});

test("notes disclose kernel size, thresholds, and known-fail cases", () => {
  const W = 50, H = 40;
  const centers = [[25, 20]];
  const R = nBlobField(W, H, centers);
  const out = bind(R, W, H, { minArea: 20 });
  const joined = out.notes.join(" ").toLowerCase();
  assert(joined.includes("kernel"), "notes must state predictor kernel");
  assert(joined.includes("threshold"), "notes must state |eps| thresholds");
  // Contract: known-fail cases must be disclosed.
  assert(
    joined.includes("texture") || joined.includes("grass") || joined.includes("wood grain"),
    "notes must state known-fail cases (highly textured objects), got: " + joined,
  );
});

test("configurable kernel: K=5 runs and returns a valid result", () => {
  const W = 60, H = 60;
  const centers = [[30, 30]];
  const R = nBlobField(W, H, centers);
  const out = bind(R, W, H, { kernel: 5, minArea: 20 });
  assert(out.entities.length >= 1, "K=5 should still find the blob interior");
  const joined = out.notes.join(" ");
  assert(joined.includes("5x5") || joined.includes("kernel: 5"), "notes must reflect K=5, got: " + joined);
});

console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
