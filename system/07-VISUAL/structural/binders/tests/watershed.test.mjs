#!/usr/bin/env bun
// Standalone test harness for watershed binder.
// Contract: prints `Summary: N pass / M fail of T`. Exit code 0 iff all pass.

import { bind, DISCIPLINE } from "../watershed.mjs";

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
    if (e.stack) console.log(e.stack.split("\n").slice(1, 4).map(s => "        " + s).join("\n"));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "not equal"}: got ${actual}, want ${expected}`);
}

// ---- Fixture builders ----

// A dark background with two bright disk-like regions.
function twoDiskField(W, H) {
  const R = new Float32Array(W * H);
  const cx1 = Math.floor(W * 0.25), cy1 = Math.floor(H * 0.5);
  const cx2 = Math.floor(W * 0.75), cy2 = Math.floor(H * 0.5);
  const r = Math.max(3, Math.floor(Math.min(W, H) * 0.15));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.hypot(x - cx1, y - cy1);
      const d2 = Math.hypot(x - cx2, y - cy2);
      // Smooth gaussian-ish bumps so |∇R| forms real ridges.
      const v1 = Math.exp(-(d1 * d1) / (2 * r * r));
      const v2 = Math.exp(-(d2 * d2) / (2 * r * r));
      R[y * W + x] = Math.min(1, 0.05 + 0.9 * Math.max(v1, v2));
    }
  }
  return R;
}

// A uniform field — no gradient structure.
function uniformField(W, H, v = 0.5) {
  const R = new Float32Array(W * H);
  R.fill(v);
  return R;
}

// Copy a Float32Array — for deterministic re-runs.
function cloneF32(a) {
  const b = new Float32Array(a.length);
  b.set(a);
  return b;
}

// ---- Tests ----

console.log("=== watershed binder tests ===");

test("exports DISCIPLINE === 'watershed'", () => {
  assertEq(DISCIPLINE, "watershed");
});

test("exports bind() function", () => {
  assert(typeof bind === "function", "bind is not a function");
});

test("bind() returns valid shape on trivial input", () => {
  const R = uniformField(8, 8);
  const out = bind(R, 8, 8);
  assert(out && typeof out === "object", "no result");
  assertEq(out.discipline, "watershed");
  assert(Array.isArray(out.entities), "entities not array");
  assert(Array.isArray(out.notes), "notes not array");
});

test("uniform field yields 0 entities + honest note", () => {
  const R = uniformField(32, 32, 0.5);
  const out = bind(R, 32, 32);
  assertEq(out.entities.length, 0, "should emit no entities on uniform input");
  assert(out.notes.length > 0, "must disclose why zero entities");
  // Note should mention "uniform" or "zero entities" honestly.
  const joined = out.notes.join(" ").toLowerCase();
  assert(
    joined.includes("uniform") || joined.includes("zero entities") || joined.includes("no local minima"),
    "notes must honestly disclose uniform/no-marker case, got: " + joined
  );
});

test("32x32 with two bright regions produces ≥1 entity", () => {
  const R = twoDiskField(32, 32);
  const out = bind(R, 32, 32);
  assert(out.entities.length >= 1, `expected ≥1 entity on two-disk field, got ${out.entities.length}`);
});

test("all entity bboxes lie inside the frame", () => {
  const W = 64, H = 48;
  const R = twoDiskField(W, H);
  const out = bind(R, W, H);
  for (const e of out.entities) {
    assert(Array.isArray(e.region) && e.region.length === 4, "region must be [x,y,w,h]");
    const [x, y, w, h] = e.region;
    assert(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h),
      `region ints required, got ${JSON.stringify(e.region)}`);
    assert(x >= 0 && y >= 0, `bbox origin negative: (${x},${y})`);
    assert(w > 0 && h > 0, `bbox zero-size: ${w}x${h}`);
    assert(x + w <= W, `bbox exceeds W: ${x}+${w} > ${W}`);
    assert(y + h <= H, `bbox exceeds H: ${y}+${h} > ${H}`);
  }
});

test("determinism: identical R → identical entities", () => {
  const R1 = twoDiskField(48, 36);
  const R2 = cloneF32(R1);
  const a = bind(R1, 48, 36);
  const b = bind(R2, 48, 36);
  assertEq(a.entities.length, b.entities.length, "entity count differs");
  for (let i = 0; i < a.entities.length; i++) {
    const ea = a.entities[i], eb = b.entities[i];
    assertEq(ea.id, eb.id, `id[${i}] differs`);
    assertEq(ea.region[0], eb.region[0], `region.x[${i}] differs`);
    assertEq(ea.region[1], eb.region[1], `region.y[${i}] differs`);
    assertEq(ea.region[2], eb.region[2], `region.w[${i}] differs`);
    assertEq(ea.region[3], eb.region[3], `region.h[${i}] differs`);
  }
});

test("entity ids are unique and start at 1", () => {
  const R = twoDiskField(32, 32);
  const out = bind(R, 32, 32);
  const ids = out.entities.map((e) => e.id);
  const set = new Set(ids);
  assertEq(set.size, ids.length, "ids must be unique");
  if (ids.length > 0) {
    assertEq(Math.min(...ids), 1, "ids should start at 1");
  }
});

test("degenerate input (mismatched R length) → honest zero", () => {
  const bad = new Float32Array(10);
  const out = bind(bad, 32, 32);
  assertEq(out.entities.length, 0);
  const joined = out.notes.join(" ").toLowerCase();
  assert(joined.includes("invalid") || joined.includes("no entities") || joined.includes("mismatched") || joined.includes("length"),
    "must disclose length mismatch honestly, got: " + joined);
});

test("frame too small (2x2) → honest zero", () => {
  const R = new Float32Array(4);
  R[0] = 0.1; R[1] = 0.9; R[2] = 0.9; R[3] = 0.1;
  const out = bind(R, 2, 2);
  assertEq(out.entities.length, 0);
  assert(out.notes.some(n => n.toLowerCase().includes("too small") || n.toLowerCase().includes("sobel")),
    "must disclose why too small");
});

console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
