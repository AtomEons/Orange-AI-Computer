// 07-VISUAL/structural/photoreceptor.mjs
//
// The photon-→ retinal-signal stage. Runs BEFORE the four-field extractor.
// NOT a codec. NOT a metaphor. This is the biological front-end: nonlinear
// photoreceptor response with temporal adaptation, as measured in real retinae.
//
// Input:  luminance L(x,y,t) — normalized 0..1 (already integrated over the
//         visible spectrum, i.e. Y). Any downstream retinal-transform must
//         compute its four fields (∇L, ∂L/∂t, log L, motion corr) on the
//         OUTPUT of this stage, R(x,y,t), NOT on the raw L.
// Output: R(x,y,t) = Φ(L, K(t))
//         where Φ is Naka-Rushton (see Naka & Rushton 1966, Michaelis-Menten
//         form on photoreceptor response):
//
//              R = L^n / (L^n + K^n)
//
//         and K(t) is the adaptation state — a temporal low-pass of the mean
//         luminance, τ ≈ 100–500 ms in vivo. K is what makes vision
//         relative-contrast (Weber-like), not absolute-intensity. It is the
//         reason a candle in a dark room and the sun through a window both
//         resolve to structure your brain can act on.
//
// Determinism: given (L, state, tsMs) inputs, output R is bit-exact identical
// across runs. No RNG. No wall clock read. State advance is closed-form.
//
// Anti-drift:
//   - Backend only. No UI.
//   - Bun-only (pure JS + typed arrays). No native deps.
//   - No paid dependency.
//   - Honest disclosures via the returned `meta` — saturated fraction, current
//     adaptation state K, effective dt used. A caller that ignores meta is
//     violating Mom's Law; a caller that reports these numbers is honest.

const DEFAULTS = Object.freeze({
  // Naka-Rushton exponent. Photopic cone response ≈ 0.9–1.0 in most fits;
  // rod (scotopic) closer to 0.7. We default to 1.0 for the plainest, most
  // interpretable Michaelis form; overridable per-call.
  n: 1.0,

  // Initial semi-saturation constant. Mid-gray is a reasonable prior for a
  // system starting in the dark before any adaptation has occurred.
  K0: 0.18,

  // Adaptation time constant, ms. In real retina, luminance adaptation runs
  // ~100–500 ms depending on rod/cone regime; 250 ms is a defensible middle.
  adaptationTauMs: 250,

  // K is clamped to this range so the response never truly saturates the math
  // (K=0 → division blowup at L=0; K=1 → R ≈ 0 for any typical L). These are
  // physical guardrails, not fitted parameters.
  Kmin: 0.001,
  Kmax: 0.999,

  // Log-compression epsilon (for logCompressedResponse below).
  epsilon: 1e-6,

  // Saturation-flag thresholds. Values of R below floorSat or above ceilSat
  // are counted as "clipped" — the signal at that pixel carries less real
  // information. Downstream must know this.
  floorSat: 0.02,
  ceilSat: 0.98,
});

/**
 * Initialize an adaptation state. Pass `opts` to override any DEFAULTS.
 * State is a plain object — safe to serialize, safe to pass across records.
 */
export function initAdaptationState(opts = {}) {
  const cfg = Object.freeze({ ...DEFAULTS, ...opts });
  return {
    K: cfg.K0,
    cfg,
    lastTsMs: null,
    // History for diagnostics only. Never read by the response math.
    step: 0,
  };
}

// Naka-Rushton response: R = L^n / (L^n + K^n).
// Kept as a named helper for clarity + so tests can call it directly.
export function nakaRushton(L, K, n) {
  if (L < 0) L = 0;
  if (n === 1.0) {
    // Fast path (Michaelis-Menten). Also numerically nicer near L=0.
    return L / (L + K);
  }
  const Ln = Math.pow(L, n);
  return Ln / (Ln + Math.pow(K, n));
}

// Exponential-tracking update for K:  K(t) = K(t-1) + (target - K(t-1)) * α,
// where α = 1 - exp(-dt/τ). Closed form; no simulation loop needed.
export function updateAdaptationK(prevK, targetL, tauMs, dtMs, { Kmin, Kmax } = DEFAULTS) {
  if (!(dtMs > 0)) return prevK;
  const alpha = 1 - Math.exp(-dtMs / tauMs);
  let K = prevK + (targetL - prevK) * alpha;
  if (K < Kmin) K = Kmin;
  if (K > Kmax) K = Kmax;
  return K;
}

/**
 * Apply the photoreceptor response to a luminance field.
 *
 * @param {Float32Array | Uint8Array} luminance  L values in 0..1 (Float32) or
 *                                               0..255 (Uint8, auto-normalized).
 * @param {object} state    from initAdaptationState. Not mutated; a new state
 *                          is returned in the result.
 * @param {number} tsMs     current sample timestamp (ms). Used to compute dt
 *                          against `state.lastTsMs`. If null, no adaptation
 *                          advance happens (single-frame use).
 * @returns { R, saturation, state, meta }
 *   R          Float32Array, same length as luminance, 0..1
 *   saturation Uint8Array (0/1), 1 where R is clipped
 *   state      next-step adaptation state — pass into the next call
 *   meta       { K, meanL, saturatedFraction, dtMs, n }
 */
export function photoreceptorResponse(luminance, state, tsMs = null) {
  if (!luminance || !luminance.length) {
    throw new Error("photoreceptorResponse: luminance is empty");
  }
  const cfg = state.cfg;
  const N = luminance.length;
  const isU8 = luminance instanceof Uint8Array;
  const scale = isU8 ? 1 / 255 : 1;

  // Mean luminance drives adaptation.
  let sumL = 0;
  for (let i = 0; i < N; i++) sumL += luminance[i] * scale;
  const meanL = sumL / N;

  // Advance K.
  const dtMs = state.lastTsMs == null || tsMs == null ? 0 : tsMs - state.lastTsMs;
  const K = updateAdaptationK(state.K, meanL, cfg.adaptationTauMs, dtMs, cfg);

  const R = new Float32Array(N);
  const saturation = new Uint8Array(N);
  let satCount = 0;
  const n = cfg.n;

  for (let i = 0; i < N; i++) {
    const L = luminance[i] * scale;
    const r = nakaRushton(L, K, n);
    R[i] = r;
    if (r < cfg.floorSat || r > cfg.ceilSat) {
      saturation[i] = 1;
      satCount++;
    }
  }

  const nextState = { K, cfg, lastTsMs: tsMs, step: state.step + 1 };
  const meta = {
    K,
    meanL,
    saturatedFraction: satCount / N,
    dtMs,
    n,
  };
  return { R, saturation, state: nextState, meta };
}

/**
 * log(R + ε) — the third of the four retinal fields. Applied to the
 * post-photoreceptor signal R, NOT to raw luminance. This is the biology.
 */
export function logCompressedResponse(R, epsilon = DEFAULTS.epsilon) {
  const out = new Float32Array(R.length);
  for (let i = 0; i < R.length; i++) out[i] = Math.log(R[i] + epsilon);
  return out;
}

/**
 * Honest disclosures that a caller SHOULD include in the record's `notes[]`.
 * Returns an array of strings describing the physical limits hit for a given
 * (state, meta) pair. Mom's Law channel.
 */
export function honestNotes(meta, state) {
  const notes = [];
  const cfg = state.cfg;
  if (meta.saturatedFraction > 0.10) {
    notes.push(
      `photoreceptor: ${(meta.saturatedFraction * 100).toFixed(1)}% of pixels ` +
        `saturated (R < ${cfg.floorSat} or R > ${cfg.ceilSat}). Real signal is ` +
        `attenuated in those regions; downstream field magnitudes should not be ` +
        `trusted where saturation=1.`,
    );
  }
  if (meta.dtMs === 0 && state.step > 0) {
    notes.push(
      `photoreceptor: dtMs=0 between samples — adaptation did not advance. ` +
        `Temporal derivative (∂L/∂t) is undefined at this step.`,
    );
  }
  if (meta.dtMs > 0 && meta.dtMs > cfg.adaptationTauMs * 5) {
    notes.push(
      `photoreceptor: sample gap dt=${meta.dtMs}ms ≫ τ=${cfg.adaptationTauMs}ms. ` +
        `Adaptation is effectively re-initialized; treat this as a scene reset.`,
    );
  }
  if (state.K <= cfg.Kmin * 1.01 || state.K >= cfg.Kmax * 0.99) {
    notes.push(
      `photoreceptor: adaptation K clamped near boundary (K=${state.K.toFixed(4)}). ` +
        `Response is operating at the edge of the physical model.`,
    );
  }
  if (meta.n !== 1.0) {
    notes.push(`photoreceptor: Naka-Rushton exponent n=${meta.n} (non-Michaelis).`);
  }
  return notes;
}

// Internals exposed for tests / calibration only.
export const __photoreceptorInternals = Object.freeze({ DEFAULTS });
