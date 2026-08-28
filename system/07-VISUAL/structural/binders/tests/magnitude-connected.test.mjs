// Tests for the magnitude-connected binder — the null-hypothesis baseline.
// Standalone Bun harness. Prints: Summary: N pass / M fail of T
//
// Proves the binder honors the contract:
//   - Deterministic: same input → identical output
//   - Uniform R (no gradient) → 0 entities
//   - Two synthetic blobs → exactly 2 entities with sensible bboxes
//   - Refuses malformed inputs cleanly (not by throwing)
//   - notes[] populated with honest disclosures
//   - Contract shape: { discipline, entities:[{id, region:[x,y,w,h]}], notes }
//   - Region bboxes are within image bounds

import { bind, DISCIPLINE, __internals } from "../magnitude-connected.mjs";

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${a} !== ${b}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const close = (a, b, tol, m) => {
  if (Math.abs(a - b) > tol) throw new Error(`${m || "not close"}: |${a} - ${b}| > ${tol}`);
};

// -- helpers --

function uniformR(w, h, v = 0.5) {
  const R = new Float32Array(w * h);
  for (let i = 0; i < R.length; i++) R[i] = v;
  return R;
}

// Draw a filled square blob of value `v` into R at (cx,cy) with radius r.
// Background is `bg`. Any pixel inside the box gets set.
function drawSquare(R, w, h, cx, cy, r, v) {
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= w) continue;
      R[y * w + x] = v;
    }
  }
}

// A two-blob scene: dark background, two bright square blobs far apart.
// Sobel |∇R| lights up on the blob edges (rings), so the "edge" strategy
// gives 2 ring components; the "interior" strategy gives 3 components
// (background + 2 blob interiors). Either way you get to 2 real objects.
function twoBlobScene(w, h) {
  const R = new Float32Array(w * h);
  // background
  for (let i = 0; i < R.length; i++) R[i] = 0.1;
  // blob A
  drawSquare(R, w, h, Math.floor(w * 0.3), Math.floor(h * 0.5), 20, 0.9);
  // blob B — well separated from A so they don't merge under 3x3 close
  drawSquare(R, w, h, Math.floor(w * 0.7), Math.floor(h * 0.5), 20, 0.9);
  return R;
}

// -- tests --

test("exports_contract_correctly", () => {
  eq(typeof bind, "function", "bind is function");
  eq(DISCIPLINE, "magnitude-connected", "DISCIPLINE constant");
  return "ok (bind and DISCIPLINE exported)";
});

test("uniform_R_yields_zero_entities", () => {
  const w = 64, h = 48;
  const R = uniformR(w, h, 0.5);
  const out = bind(R, w, h, {});
  eq(out.discipline, "magnitude-connected", "discipline echoed");
  ok(Array.isArray(out.entities), "entities is array");
  eq(out.entities.length, 0, "zero entities on uniform field");
  ok(Array.isArray(out.notes) && out.notes.length > 0, "notes populated even at zero");
  return `ok (0 entities on uniform ${w}x${h} field)`;
});

test("two_blob_synthetic_yields_two_entities", () => {
  const w = 128, h = 96;
  const R = twoBlobScene(w, h);
  // Force edge strategy for a clean 2-object read.
  const out = bind(R, w, h, { strategy: "edge", minPixels: 20 });
  // Edge strategy of two square blobs = two ring components.
  eq(out.entities.length, 2, `expected 2 entities, got ${out.entities.length}`);
  // Bboxes must be within image bounds and centered near the blobs.
  for (const e of out.entities) {
    const [x, y, rw, rh] = e.region;
    ok(x >= 0 && y >= 0, `region origin in-bounds: (${x},${y})`);
    ok(x + rw <= w && y + rh <= h, `region extent in-bounds: ${x + rw}x${y + rh}`);
    ok(rw > 0 && rh > 0, `region has positive size: ${rw}x${rh}`);
  }
  // One centered around x≈w*0.3, the other x≈w*0.7.
  const centers = out.entities.map((e) => e.region[0] + e.region[2] / 2).sort((a, b) => a - b);
  close(centers[0] / w, 0.3, 0.1, "left blob center near 30%");
  close(centers[1] / w, 0.7, 0.1, "right blob center near 70%");
  return `ok (2 entities, centers ~${(centers[0] / w * 100).toFixed(0)}% and ~${(centers[1] / w * 100).toFixed(0)}%)`;
});

test("determinism_same_input_same_output", () => {
  const w = 128, h = 96;
  const R1 = twoBlobScene(w, h);
  const R2 = twoBlobScene(w, h);
  const a = bind(R1, w, h, { strategy: "edge", minPixels: 20 });
  const b = bind(R2, w, h, { strategy: "edge", minPixels: 20 });
  eq(a.entities.length, b.entities.length, "entity count differs");
  for (let i = 0; i < a.entities.length; i++) {
    const ra = a.entities[i].region, rb = b.entities[i].region;
    for (let k = 0; k < 4; k++) eq(ra[k], rb[k], `region[${i}][${k}] differs`);
  }
  return `ok (bit-exact same output over ${a.entities.length} entities)`;
});

test("refuses_bad_dimensions_cleanly", () => {
  const R = new Float32Array(100);
  const out = bind(R, 20, 3, {}); // 20*3=60, R has 100 → mismatch
  eq(out.entities.length, 0, "refuse yields 0 entities");
  ok(
    out.notes.some((n) => n.toLowerCase().includes("refused")),
    "refusal note present",
  );
  return "ok (dimension-mismatch refused cleanly, no throw)";
});

test("refuses_too_small_image_cleanly", () => {
  const R = new Float32Array(4);
  const out = bind(R, 2, 2, {});
  eq(out.entities.length, 0, "refuse yields 0 entities");
  ok(out.notes.some((n) => n.includes("too small")), "small-image refusal noted");
  return "ok (2x2 image refused for Sobel)";
});

test("notes_disclose_known_failure_modes", () => {
  const w = 64, h = 48;
  const R = twoBlobScene(w, h);
  const out = bind(R, w, h, {});
  const joined = out.notes.join(" ");
  ok(joined.includes("KNOWN FAIL"), "at least one KNOWN FAIL disclosed");
  ok(joined.includes("touching"), "touching-object merge disclosed");
  ok(joined.includes("thin") || joined.includes("broken"), "thin/broken rim disclosed");
  ok(joined.includes("strategy"), "strategy disclosed");
  return `ok (${out.notes.length} honest notes, KNOWN FAILs present)`;
});

test("min_pixels_filter_drops_tiny_components", () => {
  const w = 64, h = 48;
  const R = new Float32Array(w * h).fill(0.1);
  // one tiny 3x3 blob (radius 1)
  drawSquare(R, w, h, 10, 10, 1, 0.9);
  // one bigger 21x21 blob
  drawSquare(R, w, h, 40, 24, 10, 0.9);
  const out = bind(R, w, h, { strategy: "edge", minPixels: 30 });
  // Only the bigger blob's rim should have enough pixels.
  eq(out.entities.length, 1, `expected 1 entity, got ${out.entities.length}`);
  return "ok (tiny component correctly filtered)";
});

test("region_shape_is_x_y_w_h_ints", () => {
  const w = 64, h = 48;
  const R = twoBlobScene(w, h);
  const out = bind(R, w, h, { strategy: "edge", minPixels: 20 });
  for (const e of out.entities) {
    eq(typeof e.id, "number", "id number");
    ok(Array.isArray(e.region) && e.region.length === 4, "region has 4 slots");
    for (const v of e.region) {
      ok(Number.isFinite(v) && v >= 0, `region value is finite non-negative: ${v}`);
      ok(Number.isInteger(v), `region value is integer: ${v}`);
    }
  }
  return `ok (${out.entities.length} entities with valid region shape)`;
});

test("sobel_zero_on_flat_field_internal", () => {
  const w = 16, h = 16;
  const R = new Float32Array(w * h).fill(0.5);
  const g = __internals.sobelMagnitude(R, w, h);
  let maxG = 0;
  for (let i = 0; i < g.length; i++) if (g[i] > maxG) maxG = g[i];
  close(maxG, 0, 1e-12, "sobel of flat field is zero");
  return "ok (Sobel internal check: |∇| = 0 on flat)";
});

test("labelAndFilter_counts_components_correctly", () => {
  // A 10x10 mask with two isolated on-blocks, well separated.
  const w = 10, h = 10;
  const m = new Uint8Array(w * h);
  // Top-left 3x3 block (9 px)
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) m[y * w + x] = 1;
  // Bottom-right 4x4 block (16 px)
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) m[y * w + x] = 1;
  const res = __internals.labelAndFilter(m, w, h, 1);
  eq(res.entities.length, 2, `expected 2, got ${res.entities.length}`);
  // First (row-major, lowest-root) is top-left 3x3 → region (0,0,3,3)
  eq(res.entities[0].region[0], 0, "first entity x=0");
  eq(res.entities[0].region[1], 0, "first entity y=0");
  eq(res.entities[0].region[2], 3, "first entity w=3");
  eq(res.entities[0].region[3], 3, "first entity h=3");
  return "ok (2 CC labeled with correct bboxes)";
});

test("morph_close_bridges_one_pixel_gap", () => {
  // A 3-pixel gap in a horizontal edge — after 3x3 close (1 iter dilate,
  // 1 iter erode) the two ends should be connected.
  const w = 20, h = 5;
  const m = new Uint8Array(w * h);
  // Row 2: pixels 0..8 on, 9..10 OFF (2-pixel gap), 11..19 on
  for (let x = 0; x < 9; x++) m[2 * w + x] = 1;
  for (let x = 11; x < 20; x++) m[2 * w + x] = 1;
  // Before close: two components
  const before = __internals.labelAndFilter(m, w, h, 1);
  eq(before.entities.length, 2, "expected 2 components before close");
  // After 1-iter close: 3x3 dilate closes a 2-px gap; erode shrinks back
  const closed = __internals.morphClose(m, w, h, 1);
  const after = __internals.labelAndFilter(closed, w, h, 1);
  eq(after.entities.length, 1, `expected 1 component after close, got ${after.entities.length}`);
  return "ok (2-px gap bridged by 3x3 close)";
});

// ---- runner ----
console.log("AE Eyes binder — magnitude-connected (null-hypothesis baseline)");
console.log("Bun " + (process.versions?.bun || "unknown"));
console.log("");
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = await t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(48)} ${(Date.now() - t0).toString().padStart(4)}ms  ${note || ""}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(48)} ${(Date.now() - t0).toString().padStart(4)}ms  ${e.message}`);
  }
}
console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
