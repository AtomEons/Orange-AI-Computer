// Tests that photoreceptor+retinal wiring is real, deterministic, and honest.
// Standalone Bun harness. Prints:  Summary: N pass / M fail of T

import {
  transformImageWithPhotoreceptor,
  transformSequenceWithPhotoreceptor,
  WIRED_VERSION_SUFFIX,
} from "../physical-retinal-transform.mjs";
import { transformImage, transformSequence } from "../retinal-transform.mjs";

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${a} !== ${b}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };

function makeCheckerboard(w, h) {
  const L = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      L[y * w + x] = ((x >> 3) + (y >> 3)) & 1 ? 220 : 40;
    }
  }
  return L;
}
function makeShiftingSquare(w, h, nFrames, shiftPerFrame = 4, bg = 30, fg = 200) {
  const frames = [];
  const sq = 10;
  for (let f = 0; f < nFrames; f++) {
    const L = new Uint8Array(w * h).fill(bg);
    const x0 = 5 + f * shiftPerFrame;
    const y0 = 20;
    for (let y = y0; y < y0 + sq && y < h; y++) {
      for (let x = x0; x < x0 + sq && x < w; x++) L[y * w + x] = fg;
    }
    frames.push({ data: L, ts_ms: f * 33 });
  }
  return frames;
}
function makeShiftingSquareAtBg(w, h, nFrames, bg, fg) {
  // Same shape, different background level — for a relative-contrast check.
  return makeShiftingSquare(w, h, nFrames, 4, bg, fg);
}

test("wired_still_returns_valid_record_with_photoreceptor_note", async () => {
  const L = makeCheckerboard(64, 48);
  const { record, photoreceptorMeta } = await transformImageWithPhotoreceptor(
    { data: L, meta: { width: 64, height: 48, source_kind: "renderer" } },
  );
  eq(record.schema, "ae.structural-tokens.v1", "schema id");
  ok(record.provenance.translator_version.endsWith(WIRED_VERSION_SUFFIX), "translator_version marks wired path");
  ok(record.notes.some((n) => n.includes("photoreceptor:")), "photoreceptor note present");
  ok(Number.isFinite(photoreceptorMeta.K), "photoreceptor meta has K");
  ok(record.entities.length >= 1, "still image with structure produces entities");
  return `ok (${record.entities.length} entities, K=${photoreceptorMeta.K.toFixed(4)})`;
});

test("wired_vs_raw_differ_on_same_input_proving_physics_did_something", async () => {
  const L = makeCheckerboard(64, 48);
  const raw = await transformImage({
    data: L, meta: { width: 64, height: 48, source_kind: "renderer" },
  });
  const { record: wired } = await transformImageWithPhotoreceptor({
    data: L, meta: { width: 64, height: 48, source_kind: "renderer" },
  });
  // The two records MUST differ — if they were identical, the photoreceptor
  // stage would be a no-op and the whole point of this module would be false.
  ok(raw.provenance.translator_version !== wired.provenance.translator_version, "translator versions differ");
  ok(
    raw.retinal_fields.gradient_energy_mean !== wired.retinal_fields.gradient_energy_mean,
    "gradient_energy_mean differs (raw=" + raw.retinal_fields.gradient_energy_mean +
      " wired=" + wired.retinal_fields.gradient_energy_mean + ")",
  );
  return `ok (raw grad=${raw.retinal_fields.gradient_energy_mean.toFixed(4)}, wired grad=${wired.retinal_fields.gradient_energy_mean.toFixed(4)})`;
});

test("wired_sequence_threads_adaptation_state_across_frames", async () => {
  const frames = makeShiftingSquare(64, 48, 5);
  const { record, photoreceptorState, photoreceptorMetaByFrame } =
    await transformSequenceWithPhotoreceptor({
      frames, meta: { width: 64, height: 48, source_kind: "renderer" },
    });
  eq(record.schema, "ae.structural-tokens.v1", "schema id");
  ok(record.provenance.translator_version.endsWith(WIRED_VERSION_SUFFIX), "wired path marker");
  eq(photoreceptorMetaByFrame.length, 5, "per-frame meta preserved");
  const K0 = photoreceptorMetaByFrame[0].K;
  const Kfinal = photoreceptorState.K;
  // Adaptation must have moved — the K at frame 0 (start of scene, K0=0.18)
  // must differ from the final K (state after 5 frames = 132 ms of the scene).
  ok(K0 !== Kfinal, `K advanced (K0=${K0.toFixed(4)}, final=${Kfinal.toFixed(4)})`);
  ok(
    record.notes.some((n) => n.includes("adaptation state threaded")),
    "adaptation-threaded note present",
  );
  ok(
    record.retinal_fields.motion_correlation_coherence > 0,
    "motion coherence detected on shifting-square sequence",
  );
  return `ok (K: ${K0.toFixed(4)} → ${Kfinal.toFixed(4)}, coherence=${record.retinal_fields.motion_correlation_coherence.toFixed(3)})`;
});

test("wired_path_is_deterministic", async () => {
  const L = makeCheckerboard(32, 32);
  const a = await transformImageWithPhotoreceptor({
    data: L, meta: { width: 32, height: 32, source_kind: "renderer" },
  });
  const b = await transformImageWithPhotoreceptor({
    data: L, meta: { width: 32, height: 32, source_kind: "renderer" },
  });
  eq(a.record.id, b.record.id, "record id");
  eq(a.record.retinal_fields.gradient_energy_mean, b.record.retinal_fields.gradient_energy_mean, "gradient mean");
  eq(a.record.entities.length, b.record.entities.length, "entity count");
  return `ok (identical id=${a.record.id.slice(0, 12)})`;
});

test("saturating_input_produces_photoreceptor_saturation_note", async () => {
  // Dark-adapted retina (K0 low) sees a bright uniform flash — realistic
  // saturation scenario (flashbulb after dark, oncoming headlights, etc.).
  const L = new Uint8Array(32 * 32).fill(253);
  const { record, photoreceptorMeta } = await transformImageWithPhotoreceptor(
    { data: L, meta: { width: 32, height: 32, source_kind: "renderer" } },
    { photoreceptor: { K0: 0.005 } },
  );
  ok(photoreceptorMeta.saturatedFraction > 0.5, `saturatedFraction=${photoreceptorMeta.saturatedFraction}`);
  ok(
    record.notes.some((n) => /saturated/i.test(n)),
    "record.notes discloses saturation honestly",
  );
  return `ok (${(photoreceptorMeta.saturatedFraction * 100).toFixed(1)}% saturated, note surfaced)`;
});

test("wired_sequence_matches_raw_schema_and_field_shape", async () => {
  const frames = makeShiftingSquare(48, 48, 4);
  const raw = await transformSequence({
    frames, meta: { width: 48, height: 48, source_kind: "renderer" },
  });
  const { record: wired } = await transformSequenceWithPhotoreceptor({
    frames, meta: { width: 48, height: 48, source_kind: "renderer" },
  });
  // Both must satisfy the schema — same required keys in retinal_fields.
  const keys = ["gradient_energy_mean", "temporal_derivative_mean", "log_intensity_range", "motion_correlation_coherence"];
  for (const k of keys) {
    ok(k in raw.retinal_fields, `raw missing ${k}`);
    ok(k in wired.retinal_fields, `wired missing ${k}`);
  }
  // Both should have non-empty notes (Mom's Law).
  ok(raw.notes.length > 0, "raw notes non-empty");
  ok(wired.notes.length > raw.notes.length, "wired notes has photoreceptor additions");
  return `ok (raw notes=${raw.notes.length}, wired notes=${wired.notes.length})`;
});

// ---- runner ----
console.log("AE Eyes physical retinal transform — photoreceptor wired into M3");
console.log("Bun " + (process.versions?.bun || "unknown"));
console.log("");
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = await t.fn();
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
