// Tests for the photoreceptor (Naka-Rushton + adaptation) stage.
// Standalone Bun harness. Prints:  Summary: N pass / M fail of T
//
// Proves the physics is faithful, not decorative:
//   - Response at L=K is exactly 0.5 (Michaelis identity)
//   - Response is monotonic in L
//   - Weber-like relative contrast: same ΔL/K gives same ΔR at any K
//   - Adaptation converges toward mean L with time constant τ (5τ → ≈ 99%)
//   - Determinism: same (L, state, tsMs) → bit-exact same R
//   - Saturation is flagged honestly when the signal clips
//   - honestNotes() surfaces real limits when they occur

import {
  initAdaptationState,
  nakaRushton,
  updateAdaptationK,
  photoreceptorResponse,
  logCompressedResponse,
  honestNotes,
  __photoreceptorInternals,
} from "../photoreceptor.mjs";

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${a} !== ${b}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const close = (a, b, tol, m) => {
  if (Math.abs(a - b) > tol) throw new Error(`${m || "not close"}: |${a} - ${b}| > ${tol}`);
};

test("naka_rushton_identity_at_L_equals_K", () => {
  // The physical identity: when L == K, R = 0.5. That's the definition of K.
  for (const K of [0.05, 0.18, 0.5, 0.8]) {
    close(nakaRushton(K, K, 1.0), 0.5, 1e-12, `L=K=${K}`);
    close(nakaRushton(K, K, 0.7), 0.5, 1e-12, `L=K=${K} n=0.7`);
  }
  return "ok (Michaelis identity holds at four operating points)";
});

test("response_monotonic_in_L", () => {
  const K = 0.3;
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const L = i / 100;
    const r = nakaRushton(L, K, 1.0);
    if (r < prev) throw new Error(`non-monotonic at L=${L}: ${r} < ${prev}`);
    prev = r;
  }
  return "ok (R monotonically increases with L across 0..1)";
});

test("weber_like_relative_contrast_invariance", () => {
  // The whole point of adaptation: the SAME relative contrast (L/K) produces
  // the SAME response, regardless of the absolute luminance level. That's
  // Weber's law expressed through the Michaelis-Menten form.
  const ratio = 1.5; // stimulus is 1.5× the background
  const r1 = nakaRushton(0.10 * ratio, 0.10, 1.0);
  const r2 = nakaRushton(0.50 * ratio, 0.50, 1.0);
  const r3 = nakaRushton(0.80 * ratio, 0.80, 1.0);
  // All three must be the same response — this is the invariance.
  close(r1, r2, 1e-12, "ratio-response at K=0.10 vs K=0.50");
  close(r2, r3, 1e-12, "ratio-response at K=0.50 vs K=0.80");
  return `ok (R=${r1.toFixed(6)} identical at three background levels)`;
});

test("adaptation_converges_to_mean_over_5_tau", () => {
  // τ = 250 ms by default. After 5τ = 1250 ms of constant input, K should be
  // within ~1% of the input mean (1 - e^-5 = 0.9933).
  const luminance = new Float32Array(64 * 64).fill(0.7);
  let state = initAdaptationState();
  const targetMean = 0.7;

  // First call: no dt available, K unchanged. Establishes lastTsMs.
  ({ state } = photoreceptorResponse(luminance, state, 0));
  eq(state.K, __photoreceptorInternals.DEFAULTS.K0, "initial K unchanged");

  // Advance by 250 ms, five times — total 5τ.
  for (let i = 1; i <= 5; i++) {
    ({ state } = photoreceptorResponse(luminance, state, i * 250));
  }

  const expected = 0.18 + (targetMean - 0.18) * (1 - Math.exp(-5));
  close(state.K, expected, 1e-6, "K after 5τ");
  ok(Math.abs(state.K - targetMean) / targetMean < 0.02, "K within 2% of mean after 5τ");
  return `ok (K=${state.K.toFixed(4)}, target=${targetMean})`;
});

test("update_adaptation_K_is_closed_form_correct", () => {
  const K1 = updateAdaptationK(0.18, 0.5, 250, 250);
  // α = 1 - e^-1 ≈ 0.6321; expected = 0.18 + (0.5 - 0.18) * 0.6321 ≈ 0.3823
  close(K1, 0.18 + (0.5 - 0.18) * (1 - Math.exp(-1)), 1e-12, "one-τ step");

  // dt=0 → no change.
  eq(updateAdaptationK(0.4, 0.9, 250, 0), 0.4, "dt=0 no advance");

  // Clamps.
  const clamped = updateAdaptationK(0.999, 10, 250, 100000);
  ok(clamped <= 0.999, "K clamped at Kmax");
  return "ok";
});

test("response_is_deterministic_bit_exact", () => {
  // Same inputs, same state, same tsMs → byte-identical R.
  const L = new Float32Array(32 * 32);
  for (let i = 0; i < L.length; i++) L[i] = (i * 37 % 256) / 255;
  const s1 = initAdaptationState();
  const s2 = initAdaptationState();
  const r1 = photoreceptorResponse(L, s1, 100);
  const r2 = photoreceptorResponse(L, s2, 100);

  eq(r1.R.length, r2.R.length, "length");
  for (let i = 0; i < r1.R.length; i++) {
    if (r1.R[i] !== r2.R[i]) {
      throw new Error(`bit-mismatch at ${i}: ${r1.R[i]} vs ${r2.R[i]}`);
    }
  }
  eq(r1.state.K, r2.state.K, "state.K matches");
  return `ok (${r1.R.length} samples bit-exact)`;
});

test("saturation_flagged_honestly_when_clipped", () => {
  // A very bright uniform field: R should be near ceiling → saturation set.
  const L = new Float32Array(16 * 16).fill(0.999);
  let state = initAdaptationState();
  // Force adaptation to a low K so the field is well above semi-saturation.
  state = { ...state, K: 0.01 };
  const { saturation, meta } = photoreceptorResponse(L, state, 0);
  const satCount = saturation.reduce((a, b) => a + b, 0);
  ok(satCount === L.length, `expected all ${L.length} saturated, got ${satCount}`);
  ok(meta.saturatedFraction === 1, `saturatedFraction=${meta.saturatedFraction}`);
  return `ok (${satCount}/${L.length} pixels flagged as clipped)`;
});

test("honest_notes_surfaces_real_limits", () => {
  // Split cases: saturation and scene-reset can't co-occur because if dt >> τ,
  // adaptation catches up and nothing saturates (that's the correct physics).
  // A. Saturation note — dt=0 so adaptation cannot compensate.
  const Lbright = new Float32Array(4).fill(0.999);
  let stateA = initAdaptationState();
  stateA = { ...stateA, K: 0.005, step: 3, lastTsMs: 0 };
  const rA = photoreceptorResponse(Lbright, stateA, 0);
  const notesA = honestNotes(rA.meta, rA.state);
  ok(notesA.some((n) => n.includes("saturated")), "saturation note emitted");

  // B. Scene-reset note — huge dt with a plain field.
  const Lplain = new Float32Array(4).fill(0.4);
  let stateB = initAdaptationState();
  stateB = { ...stateB, step: 3, lastTsMs: 0 };
  const rB = photoreceptorResponse(Lplain, stateB, 10_000_000);
  const notesB = honestNotes(rB.meta, rB.state);
  ok(notesB.some((n) => n.includes("scene reset")), "dt >> τ note emitted");

  // C. dt=0 mid-stream — undefined ∂L/∂t warning
  const Lany = new Float32Array(4).fill(0.5);
  let stateC = initAdaptationState();
  stateC = { ...stateC, step: 5, lastTsMs: 500 };
  const rC = photoreceptorResponse(Lany, stateC, 500);
  const notesC = honestNotes(rC.meta, rC.state);
  ok(notesC.some((n) => n.includes("undefined")), "dt=0 undefined-∂L/∂t note emitted");

  return `ok (all three honest notes emitted in isolation)`;
});

test("log_compressed_response_completes_the_third_field", () => {
  // The third of the four retinal fields is log(R + ε), NOT log(L + ε).
  // This test just proves the helper is deterministic and monotonic.
  const R = new Float32Array([0.01, 0.1, 0.5, 0.9, 0.99]);
  const N = logCompressedResponse(R);
  eq(N.length, R.length, "length");
  for (let i = 1; i < N.length; i++) {
    ok(N[i] >= N[i - 1], `monotonic at ${i}: ${N[i]} >= ${N[i - 1]}`);
  }
  // Range spans several decades of log space (log(0.01) ≈ -4.6, log(0.99) ≈ -0.01)
  ok(N[N.length - 1] - N[0] > 4, "spans several decades of log space");
  return `ok (log-space span ${(N[N.length - 1] - N[0]).toFixed(2)} nats)`;
});

test("uint8_input_is_auto_normalized", () => {
  // Feeding raw Uint8 (0..255) must produce the same result as feeding the
  // equivalent Float32 (0..1) — the module handles the conversion.
  const uint8 = new Uint8Array([0, 64, 128, 192, 255]);
  const float = new Float32Array([0, 64 / 255, 128 / 255, 192 / 255, 1]);
  const s1 = initAdaptationState();
  const s2 = initAdaptationState();
  const r1 = photoreceptorResponse(uint8, s1, 0);
  const r2 = photoreceptorResponse(float, s2, 0);
  for (let i = 0; i < uint8.length; i++) {
    close(r1.R[i], r2.R[i], 1e-6, `sample ${i}`);
  }
  return "ok (Uint8 auto-normalized to match Float32)";
});

// ---- runner ----
console.log("AE Eyes photoreceptor (Naka-Rushton + adaptation) — physics stage");
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
