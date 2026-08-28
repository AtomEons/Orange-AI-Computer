#!/usr/bin/env bun
// Standalone Bun harness for persistent-homology-lite binder.
// Deterministic. Zero deps. Emits `Summary: N pass / M fail of T`.

import { bind, DISCIPLINE } from "../persistent-homology-lite.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(label) {
  console.log(`\n--- ${label} ---`);
}

// ---------------------------------------------------------------------------
section("shape and identity");

const W1 = 8;
const H1 = 8;
const flat = new Float32Array(W1 * H1); // all zeros
const res0 = bind(flat, W1, H1, {});
assert(res0.discipline === "persistent-homology-lite", "discipline field is correct");
assert(DISCIPLINE === "persistent-homology-lite", "exported DISCIPLINE constant");
assert(Array.isArray(res0.entities), "entities is an array");
assert(Array.isArray(res0.notes), "notes is an array");

// ---------------------------------------------------------------------------
section("uniform-R → 0 entities with note");

assert(res0.entities.length === 0, "uniform-R produces zero entities");
const uniformNote = res0.notes.some((n) => /uniform/i.test(n));
assert(uniformNote, "uniform-R disclosed in notes", JSON.stringify(res0.notes));

// Also try uniform at nonzero value.
const flat05 = new Float32Array(W1 * H1);
for (let i = 0; i < flat05.length; i++) flat05[i] = 0.5;
const resFlat05 = bind(flat05, W1, H1, {});
assert(resFlat05.entities.length === 0, "uniform-R (nonzero) → 0 entities");
assert(
  resFlat05.notes.some((n) => /uniform/i.test(n)),
  "uniform-R (nonzero) discloses"
);

// ---------------------------------------------------------------------------
section("determinism");

// Random-ish deterministic pattern via LCG.
const W2 = 32;
const H2 = 32;
const seeded = new Float32Array(W2 * H2);
let seed = 1337;
for (let i = 0; i < seeded.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  seeded[i] = (seed & 0xffff) / 0xffff;
}
const A = bind(seeded, W2, H2, {});
const B = bind(seeded, W2, H2, {});
assert(A.entities.length === B.entities.length, "deterministic: same entity count");
let sameBoxes = true;
for (let i = 0; i < A.entities.length; i++) {
  const ra = A.entities[i].region;
  const rb = B.entities[i].region;
  if (ra[0] !== rb[0] || ra[1] !== rb[1] || ra[2] !== rb[2] || ra[3] !== rb[3]) {
    sameBoxes = false;
    break;
  }
}
assert(sameBoxes, "deterministic: identical bounding boxes across runs");

// ---------------------------------------------------------------------------
section("synthetic image with 3 bright bumps of decreasing brightness");

// 64x64 canvas, background 0.1, three disc-shaped bumps at three peaks.
const W3 = 64;
const H3 = 64;
const bg = 0.1;
const R3 = new Float32Array(W3 * H3);
for (let i = 0; i < R3.length; i++) R3[i] = bg;

function stampBump(field, w, h, cx, cy, radius, peak) {
  // Radial cosine-hump so bump has a smooth interior AND a distinct peak.
  const r2 = radius * radius;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / radius; // 1 at center, 0 at radius
      const v = bg + (peak - bg) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      const idx = y * w + x;
      if (v > field[idx]) field[idx] = v;
    }
  }
}

// Three widely-separated bumps with clearly decreasing brightness.
stampBump(R3, W3, H3, 14, 14, 6, 0.95); // brightest
stampBump(R3, W3, H3, 48, 16, 6, 0.75); // medium
stampBump(R3, W3, H3, 32, 48, 6, 0.55); // dim (still > bg + reasonable margin)

const res3 = bind(R3, W3, H3, { tauFrac: 0.05, quantLevels: 32 });
console.log(
  `  three-bumps → ${res3.entities.length} entities; persistences=` +
    res3.entities
      .map((e) => {
        const m = e.notes?.[0]?.match(/persistence=([0-9.]+)/);
        return m ? m[1] : "?";
      })
      .join(",")
);

assert(res3.entities.length === 3, "three bumps → exactly 3 entities", `got ${res3.entities.length}`);

// Persistences must be strictly decreasing (brightest bump = highest persistence).
function extractPersistence(entity) {
  const n = entity.notes?.[0];
  const m = n && n.match(/persistence=([0-9.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}
if (res3.entities.length === 3) {
  const ps = res3.entities.map(extractPersistence);
  const monotone = ps[0] > ps[1] && ps[1] > ps[2];
  assert(monotone, "persistences strictly decreasing", `ps=[${ps.join(",")}]`);

  // Each entity's bbox should sit near one of the three known bump centers.
  const centers = [
    [14, 14],
    [48, 16],
    [32, 48],
  ];
  const covered = new Set();
  for (const e of res3.entities) {
    const [x, y, w, h] = e.region;
    const cx = x + w / 2;
    const cy = y + h / 2;
    let bestI = -1;
    let bestD = Infinity;
    for (let ci = 0; ci < centers.length; ci++) {
      const dx = cx - centers[ci][0];
      const dy = cy - centers[ci][1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestI = ci;
      }
    }
    if (bestD < 100) covered.add(bestI); // within ~10px
  }
  assert(covered.size === 3, "each bump has a matching entity nearby", `covered=${[...covered].join(",")}`);
}

// ---------------------------------------------------------------------------
section("honest notes present");

assert(res3.notes.length >= 3, "notes: at least 3 disclosures");
assert(
  res3.notes.some((n) => /quantLevels/i.test(n)),
  "notes: discloses quantization"
);
assert(
  res3.notes.some((n) => /persistence threshold|tau/i.test(n)),
  "notes: discloses tau/persistence threshold"
);
assert(
  res3.notes.some((n) => /fails on/i.test(n)),
  "notes: discloses failure mode"
);

// ---------------------------------------------------------------------------
section("tauMode variants execute");

const resOtsu = bind(R3, W3, H3, { tauMode: "otsu", quantLevels: 32 });
assert(Array.isArray(resOtsu.entities), "otsu tauMode returns entities array");
assert(
  resOtsu.notes.some((n) => /otsu/i.test(n)),
  "otsu tauMode discloses in notes"
);

const resAbs = bind(R3, W3, H3, { tauMode: "abs", tauAbs: 0.2, quantLevels: 32 });
assert(Array.isArray(resAbs.entities), "abs tauMode returns entities array");
assert(
  resAbs.notes.some((n) => /abs tau/i.test(n)),
  "abs tauMode discloses in notes"
);

// ---------------------------------------------------------------------------
section("region validity");

for (const e of res3.entities) {
  const [x, y, w, h] = e.region;
  const ok =
    Number.isInteger(x) && Number.isInteger(y) &&
    Number.isInteger(w) && Number.isInteger(h) &&
    x >= 0 && y >= 0 && x + w <= W3 && y + h <= H3 &&
    w > 0 && h > 0;
  assert(ok, `entity #${e.id} region within frame`, `[${x},${y},${w},${h}]`);
}

// ---------------------------------------------------------------------------
const total = pass + fail;
console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) {
  console.log(`\nFailed cases:`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
