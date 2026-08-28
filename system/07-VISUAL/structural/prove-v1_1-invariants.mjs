#!/usr/bin/env bun
// prove-v1_1-invariants.mjs — verify v1.1 temporal capture doctrine invariants.
// GPT doctrine v6 (spine seq 122):
//   1. hash(v1.1.staticCapture) === hash(fresh v1.0 record for current frame)
//   2. Temporal never modifies static
//   3. CAUSAL mode does not read next frame
//   4. Same 3 frames + same cadence → identical temporalCacheKey
//   5. Different cadence with same frames → different cacheKey
//   6. Magno reports MEASURED_STATIC not UNAVAILABLE when 3 frames supplied but no motion
//   7. Magno reports MEASURED_MOTION when frames differ
//   8. W+2..W+8 channels marked UNWOKEN_CHANNEL, not zero-valued

import { extractImageRGB } from "./prism.mjs";
import { buildStaticCaptureWithTaps } from "./build-static-capture.mjs";
import { buildTemporalCaptureRecord, V1_1_SCHEMA } from "./photon-capture-record-v1_1.mjs";

const passes = [];
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { passes.push(name); console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// Load two distinct frames for testing
const orangeA = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/orange.jpg", { maxSize: 384 });
const orangeB = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/baby-cinema/frames-single/orange_t1.5.png", { maxSize: 384 });
const apple = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/apple.jpg", { maxSize: 384 });

console.log("═══ v1.1 INVARIANT TESTS (doctrine v6) ═══\n");

// ---- Invariant 1: static hash equals fresh v1.0 hash ----
const { record: freshStatic } = buildStaticCaptureWithTaps(orangeA, { rawRef: "orange.jpg" });
const freshHash = freshStatic.integrity.recordHash;

const v11_causal = buildTemporalCaptureRecord({
  previous: apple, current: orangeA,
  deltaPreviousMs: 33,
  meta: { rawRef: "orange.jpg" },
});
check(
  "invariant_1_static_hash_matches_fresh_v1_0",
  v11_causal.staticCapture.recordHash === freshHash,
  `v1.1.staticCapture=${v11_causal.staticCapture.recordHash} fresh=${freshHash}`,
);

// ---- Invariant 2: temporal cannot alter static ----
const staticInsideV11 = v11_causal.staticCapture.recordRef;
check(
  "invariant_2_static_integrity_untouched",
  staticInsideV11.integrity.recordHash === freshStatic.integrity.recordHash
    && staticInsideV11.integrity.schemaVersion === freshStatic.integrity.schemaVersion
    && staticInsideV11.integrity.cacheKey === freshStatic.integrity.cacheKey,
  "recordHash + schema + cacheKey all match",
);

// ---- Invariant 3: CAUSAL mode does not read next frame ----
// If we pass no next frame, CAUSAL is inferred. Forward channel should be null.
check(
  "invariant_3_causal_mode_no_next_frame_read",
  v11_causal.temporalCapture.mode === "CAUSAL"
    && v11_causal.temporalCapture.retinalTemporal.w1_luminance_transient.forward === null
    && v11_causal.temporalCapture.frames.next === null,
  "mode=CAUSAL, no forward channel, no next frame",
);

// CENTERED mode should populate forward
const v11_centered = buildTemporalCaptureRecord({
  previous: apple, current: orangeA, next: orangeB,
  deltaPreviousMs: 33, deltaNextMs: 33,
  meta: { rawRef: "orange.jpg" },
});
check(
  "invariant_3b_centered_mode_reads_next",
  v11_centered.temporalCapture.mode === "CENTERED"
    && v11_centered.temporalCapture.retinalTemporal.w1_luminance_transient.forward !== null,
  "forward channel populated in CENTERED",
);

// ---- Invariant 4: same 3 frames + same cadence → identical cacheKey ----
const v11_a = buildTemporalCaptureRecord({ previous: apple, current: orangeA, next: orangeB, deltaPreviousMs: 33, deltaNextMs: 33, meta: { rawRef: "orange.jpg" } });
const v11_b = buildTemporalCaptureRecord({ previous: apple, current: orangeA, next: orangeB, deltaPreviousMs: 33, deltaNextMs: 33, meta: { rawRef: "orange.jpg" } });
check(
  "invariant_4_same_frames_same_cadence_identical_key",
  v11_a.integrity.temporalCacheKey === v11_b.integrity.temporalCacheKey
    && v11_a.integrity.temporalRecordHash === v11_b.integrity.temporalRecordHash,
  `${v11_a.integrity.temporalCacheKey}`,
);

// ---- Invariant 5: different cadence → different cacheKey ----
const v11_c = buildTemporalCaptureRecord({ previous: apple, current: orangeA, next: orangeB, deltaPreviousMs: 100, deltaNextMs: 33, meta: { rawRef: "orange.jpg" } });
check(
  "invariant_5_different_cadence_different_key",
  v11_a.integrity.temporalCacheKey !== v11_c.integrity.temporalCacheKey,
  `33ms=${v11_a.integrity.temporalCacheKey} 100ms=${v11_c.integrity.temporalCacheKey}`,
);

// ---- Invariant 6: 3-frame with NO motion → magno MEASURED_STATIC ----
const v11_no_motion = buildTemporalCaptureRecord({
  previous: orangeA, current: orangeA, next: orangeA,
  deltaPreviousMs: 33, deltaNextMs: 33,
  meta: { rawRef: "orange.jpg" },
});
check(
  "invariant_6_no_motion_magno_MEASURED_STATIC",
  v11_no_motion.temporalCapture.lgnMagno.valid === true
    && v11_no_motion.temporalCapture.lgnMagno.interpretation === "MEASURED_STATIC",
  `valid=true, interpretation=${v11_no_motion.temporalCapture.lgnMagno.interpretation}`,
);

// ---- Invariant 7: frames differ → magno MEASURED_MOTION ----
check(
  "invariant_7_frames_differ_magno_MEASURED_MOTION",
  v11_causal.temporalCapture.lgnMagno.valid === true
    && v11_causal.temporalCapture.lgnMagno.interpretation === "MEASURED_MOTION",
  `interpretation=${v11_causal.temporalCapture.lgnMagno.interpretation}, meanAbs=${v11_causal.temporalCapture.retinalTemporal.w1_luminance_transient.backward.meanAbs.toFixed(4)}`,
);

// ---- Invariant 8: W+4..W+8 marked UNWOKEN_CHANNEL not zero (W+2/W+3 now WOKEN per seq 125) ----
const unwoken = ["w4_normalized_contrast", "w5_horizontal_motion", "w6_vertical_motion",
                 "w7_radial_motion", "w8_temporal_spectrum"];
let allUnwokenTagged = true;
for (const key of unwoken) {
  const ch = v11_causal.temporalCapture.retinalTemporal[key];
  if (!(ch?.valid === false && ch?.availability === "UNWOKEN_CHANNEL")) {
    allUnwokenTagged = false;
    console.log(`    ${key}: ${JSON.stringify(ch)}`);
  }
}
check("invariant_8_W4_W8_UNWOKEN_CHANNEL_not_zero", allUnwokenTagged, "5 channels still UNWOKEN (W+2/W+3 now awake per seq 125)");

// W+2 and W+3 are woken — verify they produce valid TEMPORAL_MEASURED output
const w2 = v11_causal.temporalCapture.retinalTemporal.w2_on_events.backward;
const w3 = v11_causal.temporalCapture.retinalTemporal.w3_off_events.backward;
check("invariant_8b_W2_TEMPORAL_MEASURED",
      w2?.valid === true && w2?.availability === "TEMPORAL_MEASURED",
      `W+2 mean=${w2?.mean?.toFixed(3)}, energy=${w2?.energy?.toFixed(0)}`);
check("invariant_8c_W3_TEMPORAL_MEASURED",
      w3?.valid === true && w3?.availability === "TEMPORAL_MEASURED",
      `W+3 mean=${w3?.mean?.toFixed(3)}, energy=${w3?.energy?.toFixed(0)}`);

// ---- Invariant 9: identical-frame triplet - W+1 delta ~0 (null test) ----
const w1_no_motion = v11_no_motion.temporalCapture.retinalTemporal.w1_luminance_transient.backward;
check(
  "invariant_9_null_test_static_triplet_zero_delta",
  Math.abs(w1_no_motion.meanAbs) < 1e-9 && Math.abs(w1_no_motion.std) < 1e-9,
  `meanAbs=${w1_no_motion.meanAbs} std=${w1_no_motion.std}`,
);

// ---- Invariant 10: motion triplet - W+1 delta nonzero ----
const w1_motion = v11_causal.temporalCapture.retinalTemporal.w1_luminance_transient.backward;
check(
  "invariant_10_motion_triplet_nonzero_delta",
  w1_motion.meanAbs > 0.005,
  `meanAbs=${w1_motion.meanAbs.toFixed(4)}`,
);

console.log(`\n═══ v1.1 INVARIANT SCORE ═══`);
console.log(`  passed: ${passes.length}/${passes.length + fails.length}`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
process.exit(fails.length === 0 ? 0 : 1);
