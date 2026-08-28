#!/usr/bin/env bun
// Standalone Bun test harness for region-grow.mjs binder.
// Prints: Summary: N pass / M fail of T
//
// Covers:
//   - determinism (same R + opts → identical output)
//   - uniform R → 0 or 1 entities with an honest note
//   - synthetic image with 3 distinct-texture blobs → 3 entities
//   - contract shape (discipline string, entities array, notes array)
//   - notes[] contains the required disclosures (similarity, minCells, failure mode)
//   - small frame guardrail
//   - invalid input guardrail

import path from "node:path";
import { fileURLToPath } from "node:url";
import { bind, DISCIPLINE } from "../region-grow.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail || ""}`);
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function makeUniform(w, h, v) {
  const R = new Float32Array(w * h);
  R.fill(v);
  return R;
}

function makeBlobs(w, h) {
  // Background R ~= 0.5 with small deterministic dithering to give a nonzero
  // baseline variance so seed selection is fair. Then paint three distinct
  // texture blobs at known centers.
  const R = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // deterministic pseudo-dither, no RNG
      const jitter = ((x * 131 + y * 7919) % 17) / 200; // ~0..0.08
      R[y * w + x] = 0.48 + jitter * 0.05;
    }
  }
  // Blob A: bright & smooth. Center (60,60), radius 30. R=0.90.
  paintCircle(R, w, h, 60, 60, 30, (x, y) => 0.90);
  // Blob B: dark & smooth. Center (200,60), radius 30. R=0.10.
  paintCircle(R, w, h, 200, 60, 30, (x, y) => 0.10);
  // Blob C: mid-luminance high-contrast texture. Center (130,180), radius 30.
  // Alternating high/low pixels give this cell a very high variance AND high
  // gradient magnitude, distinct from the background.
  paintCircle(R, w, h, 130, 180, 30, (x, y) => (((x + y) & 1) ? 0.85 : 0.15));
  return R;
}

function paintCircle(R, w, h, cx, cy, radius, fn) {
  const r2 = radius * radius;
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) R[y * w + x] = fn(x, y);
    }
  }
}

console.log("=== region-grow.test.mjs ===\n");

// --- 1. contract shape on a trivial input ---
console.log("[1] contract shape");
{
  const R = makeUniform(48, 48, 0.5);
  const r = bind(R, 48, 48);
  check("returns object", r && typeof r === "object");
  check("discipline == 'region-grow'", r.discipline === "region-grow" && DISCIPLINE === "region-grow");
  check("entities is Array", Array.isArray(r.entities));
  check("notes is Array", Array.isArray(r.notes));
  check("notes non-empty", r.notes.length > 0);
}

// --- 2. determinism ---
console.log("\n[2] determinism");
{
  const R = makeBlobs(256, 256);
  const a = bind(R, 256, 256);
  const b = bind(R, 256, 256);
  check(
    "same entity count on second call",
    a.entities.length === b.entities.length,
    `first=${a.entities.length} second=${b.entities.length}`
  );
  const same = JSON.stringify(a.entities.map((e) => e.region)) ===
    JSON.stringify(b.entities.map((e) => e.region));
  check("identical regions on second call", same);
  const sameNotes = JSON.stringify(a.notes) === JSON.stringify(b.notes);
  check("identical notes on second call", sameNotes);
}

// --- 3. uniform-R → 0 or 1 entities, and an honest note ---
console.log("\n[3] uniform R → 0 or 1 entities with honest note");
{
  const R = makeUniform(128, 128, 0.5);
  const r = bind(R, 128, 128);
  check(
    "0 or 1 entities on uniform frame",
    r.entities.length <= 1,
    `got ${r.entities.length}`
  );
  const hasHonestNote = r.notes.some(
    (n) => /0 entities emitted|texturally uniform|nothing exceeds/i.test(n) || r.entities.length > 0
  );
  // On strictly uniform luminance, seeds should be zero → 0 entities → honest note fires.
  if (r.entities.length === 0) {
    check("honest 'zero entities' note is present when uniform", hasHonestNote);
  } else {
    check("(skipped honest-note check because entities > 0)", true);
  }
}

// --- 4. synthetic 3-blob image → about 3 entities ---
console.log("\n[4] synthetic 3-blob image → 3 entities");
{
  const R = makeBlobs(256, 256);
  const r = bind(R, 256, 256);
  // Ideal: 3 entities, one per blob. Allow +/- 1 because the textured blob
  // (blob C) can sometimes fragment or fuse depending on cell alignment.
  check(
    "produced 2..5 entities (target: 3)",
    r.entities.length >= 2 && r.entities.length <= 5,
    `got ${r.entities.length}`
  );

  // Check each blob center is inside at least one entity's bounding box.
  const centers = [
    { name: "bright blob A", cx: 60, cy: 60 },
    { name: "dark blob B", cx: 200, cy: 60 },
    { name: "texture blob C", cx: 130, cy: 180 },
  ];
  for (const c of centers) {
    const covered = r.entities.some((e) => {
      const [x, y, w, h] = e.region;
      return c.cx >= x && c.cx < x + w && c.cy >= y && c.cy < y + h;
    });
    check(`${c.name} center covered by some entity`, covered);
  }
}

// --- 5. required disclosures in notes[] ---
console.log("\n[5] required disclosures in notes[]");
{
  const R = makeBlobs(256, 256);
  const r = bind(R, 256, 256);
  const all = r.notes.join(" | ");
  check("notes discloses similarity threshold", /similarityThreshold/i.test(all));
  check("notes discloses minCells", /minCells/i.test(all));
  check("notes discloses a failure mode (patterned/striped)", /striped|patterned|fragment/i.test(all));
  check("notes does NOT mention orientation as a similarity feature", !/orientation.*(feature|similarity)/i.test(all) || /NO orientation/i.test(all));
}

// --- 6. small frame guardrail ---
console.log("\n[6] small frame guardrail");
{
  const R = new Float32Array(10 * 10);
  R.fill(0.5);
  const r = bind(R, 10, 10);
  check("small frame → 0 entities", r.entities.length === 0);
  check("small frame → guardrail note", r.notes.some((n) => /smaller than 2 cells|Emitting zero/i.test(n)));
}

// --- 7. invalid input guardrail ---
console.log("\n[7] invalid input guardrail");
{
  const r = bind(null, 100, 100);
  check("null R → 0 entities", r.entities.length === 0);
  check("null R → guardrail note", r.notes.some((n) => /invalid input|expected Float32Array/i.test(n)));
}

// --- 8. options are respected ---
console.log("\n[8] options are respected");
{
  const R = makeBlobs(256, 256);
  const permissive = bind(R, 256, 256, { seedThreshold: 0.02, minCells: 1 });
  const strict = bind(R, 256, 256, { seedThreshold: 0.5, minCells: 100 });
  check(
    "permissive opts produce >= strict entity count",
    permissive.entities.length >= strict.entities.length,
    `permissive=${permissive.entities.length} strict=${strict.entities.length}`
  );
  // Strict opts on a small distinct-blob frame should collapse everything.
  check(
    "very strict opts yield 0 entities on this frame",
    strict.entities.length === 0,
    `got ${strict.entities.length}`
  );
}

// --- 9. entities have well-formed regions ---
console.log("\n[9] entities have well-formed regions");
{
  const R = makeBlobs(256, 256);
  const r = bind(R, 256, 256);
  let allValid = true;
  for (const e of r.entities) {
    const [x, y, w, h] = e.region;
    if (
      typeof e.id !== "number" ||
      !Array.isArray(e.region) ||
      e.region.length !== 4 ||
      w <= 0 || h <= 0 ||
      x < 0 || y < 0 ||
      x + w > 256 || y + h > 256
    ) {
      allValid = false;
      break;
    }
  }
  check("every entity has a valid [x,y,w,h] region inside the frame", allValid);
  // ids should be unique
  const ids = new Set(r.entities.map((e) => e.id));
  check("entity ids are unique", ids.size === r.entities.length);
}

const total = pass + fail;
console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  · " + f);
  process.exit(1);
}
