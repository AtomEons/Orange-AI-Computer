// self-calibration.mjs — FABLE MOVE 3: the camera front-end.
//
// "Humans don't see the camera. AEyes¹ needs to stop seeing the camera."
//
// Before recognition, estimate what the sensor+scene did to the photons and
// normalize it away:
//   image → camera normalization → vision normalization → recognition
//
// Outputs a CALIBRATION VECTOR c⃗ (attached to every signature downstream —
// the fitted-nuisance part of the explanation output) and an ADAPTED frame
// whose Naka-Rushton set-point is anchored on the ESTIMATED ILLUMINANT, not
// the scene mean. The scene-mean flaw: same object on a white vs dark table
// got different adaptation because the background albedo leaked into K.
// The illuminant is a property of the LIGHT; the scene mean is a property
// of the furniture.
//
// Also emits shadow and specular masks so downstream statistics can skip
// pixels that carry illumination geometry rather than object identity.
//
// Zero learned parameters. Closed-form. Bun-native. OPT-IN: nothing imports
// this by default until the parity-store results justify rewiring the
// default path (schema discipline — never change signature semantics while
// a store build is in flight).

import { robustIlluminant, whitePatchIlluminant, grayEdgeIlluminant, brightPixelIlluminant } from "./axes/dichromatic-axis.mjs";

const NAKA_N = 0.75;

function nakaRushton(channel, K, n = NAKA_N) {
  const N = channel.length;
  const out = new Float32Array(N);
  const Kn = Math.pow(Math.max(1e-6, K), n);
  for (let i = 0; i < N; i++) {
    const L = channel[i];
    if (L <= 0) { out[i] = 0; continue; }
    const Ln = Math.pow(L, n);
    out[i] = Ln / (Ln + Kn);
  }
  return out;
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

/**
 * Estimate the frame-level calibration vector.
 * @param frame {R, G, B, width, height} — raw (pre-adaptation) 0..1 floats
 * @returns {
 *   illuminant: [r, g, b]           — chromaticity-normalized (sums to 1)
 *   illumConfidence: number          — agreement of the 3 estimators (1 = perfect)
 *   exposureProxy: number            — log median luminance
 *   gammaProxy: number               — median/mean log-luminance ratio
 *   blurScore: number                — mean |Laplacian| (low = blurry)
 *   noiseScore: number               — median |Laplacian| in flat areas
 *   vec: Float32Array(9)             — the flattened calibration vector
 * }
 */
export function calibrationForFrame(frame) {
  const { R, G, B, width: W, height: H } = frame;
  const region = [0, 0, W, H];
  const gamma = 2.2;

  // Illuminant: 3-estimator chromaticity median (reuses Move 2 estimators)
  const est = [
    whitePatchIlluminant(R, G, B, W, H, region, gamma),
    grayEdgeIlluminant(R, G, B, W, H, region, gamma),
    brightPixelIlluminant(R, G, B, W, H, region, gamma),
  ].filter(Boolean);
  const chromaticize = (v) => {
    const s = v[0] + v[1] + v[2];
    return s > 1e-9 ? [v[0] / s, v[1] / s, v[2] / s] : [1 / 3, 1 / 3, 1 / 3];
  };
  const chromas = est.map(chromaticize);
  const illum = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const vals = chromas.map(c => c[ch]).sort((a, b) => a - b);
    illum[ch] = vals.length ? vals[Math.floor(vals.length / 2)] : 1 / 3;
  }
  // Renormalize the median chromaticity onto the simplex
  const iSum = illum[0] + illum[1] + illum[2];
  if (iSum > 1e-9) { illum[0] /= iSum; illum[1] /= iSum; illum[2] /= iSum; }
  // Confidence: pairwise chromatic spread
  let spread = 0, pairs = 0;
  for (let i = 0; i < chromas.length; i++) {
    for (let j = i + 1; j < chromas.length; j++) {
      spread += Math.hypot(chromas[i][0] - chromas[j][0], chromas[i][1] - chromas[j][1], chromas[i][2] - chromas[j][2]);
      pairs++;
    }
  }
  const illumConfidence = Math.max(0, 1 - (pairs ? spread / pairs : 1));

  // Exposure proxy: log median luminance; gamma proxy: median/mean of log L.
  const N = W * H;
  const stride = N > 65536 ? Math.floor(N / 65536) : 1;
  const lums = [];
  for (let i = 0; i < N; i += stride) {
    lums.push(0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]);
  }
  const medL = median(lums);
  const exposureProxy = Math.log(medL + 1e-4);
  let meanLogL = 0, cnt = 0;
  for (const L of lums) { meanLogL += Math.log(L + 1e-4); cnt++; }
  meanLogL /= Math.max(1, cnt);
  const gammaProxy = meanLogL !== 0 ? exposureProxy / meanLogL : 1;

  // Blur + noise from the Laplacian of luminance (subsampled interior).
  const lapVals = [];
  for (let y = 1; y < H - 1; y += 2) {
    for (let x = 1; x < W - 1; x += 2) {
      const i = y * W + x;
      const L = (p) => 0.2126 * R[p] + 0.7152 * G[p] + 0.0722 * B[p];
      const lap = 4 * L(i) - L(i - 1) - L(i + 1) - L(i - W) - L(i + W);
      lapVals.push(Math.abs(lap));
    }
  }
  lapVals.sort((a, b) => a - b);
  const blurScore = lapVals.length ? lapVals.reduce((a, x) => a + x, 0) / lapVals.length : 0;
  const noiseScore = lapVals.length ? lapVals[Math.floor(lapVals.length * 0.5)] : 0;

  const vec = new Float32Array([
    illum[0], illum[1], illum[2],
    illumConfidence,
    exposureProxy,
    gammaProxy,
    blurScore,
    noiseScore,
    Math.log(W * H),
  ]);
  return { illuminant: illum, illumConfidence, exposureProxy, gammaProxy, blurScore, noiseScore, vec };
}

/**
 * Illuminant-anchored photoreceptor adaptation (replaces scene-mean K).
 * Per channel: K_c = illuminant chromaticity_c × overall luminance scale.
 * The set-point is now a property of the LIGHT, not of the background.
 */
export function illuminantAnchoredAdapt(frame, calibration = null) {
  const cal = calibration ?? calibrationForFrame(frame);
  const { R, G, B, width, height } = frame;
  // Overall luminance scale from exposure proxy (median luminance)
  const scale = Math.exp(cal.exposureProxy); // = median luminance
  // Per-channel set-point: illuminant chromaticity re-scaled so the three
  // channels' K values average to the scene's median luminance. A neutral
  // illuminant reproduces the old behavior; a colored illuminant tilts the
  // per-channel adaptation exactly against the tint.
  const kBase = 3 * scale; // since chromaticities sum to 1
  const KR = Math.min(0.999, Math.max(0.001, cal.illuminant[0] * kBase));
  const KG = Math.min(0.999, Math.max(0.001, cal.illuminant[1] * kBase));
  const KB = Math.min(0.999, Math.max(0.001, cal.illuminant[2] * kBase));
  return {
    R: nakaRushton(R, KR),
    G: nakaRushton(G, KG),
    B: nakaRushton(B, KB),
    width, height,
    adaptation_meta: { KR, KG, KB, calibration: cal },
  };
}

/**
 * Shadow + specular masks for a frame (Uint8Array, 1 = masked).
 * Specular: pixels above the 95th luminance percentile whose chromaticity is
 *   close to the ILLUMINANT chromaticity (mirror-like: reflect the light, not
 *   the body).
 * Shadow: pixels below 0.35 × median luminance whose chromaticity matches the
 *   local body (same material, less light — an illumination edge, not a
 *   reflectance edge).
 */
export function shadowSpecularMasks(frame, calibration = null) {
  const cal = calibration ?? calibrationForFrame(frame);
  const { R, G, B, width: W, height: H } = frame;
  const N = W * H;
  const specular = new Uint8Array(N);
  const shadow = new Uint8Array(N);
  // Luminance percentiles
  const lums = new Float32Array(N);
  for (let i = 0; i < N; i++) lums[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  const sorted = Float32Array.from(lums).sort();
  const p95 = sorted[Math.floor(N * 0.95)];
  const medL = sorted[N >> 1];
  const shadowT = 0.35 * medL;
  const [iR, iG, iB] = cal.illuminant;
  for (let i = 0; i < N; i++) {
    const L = lums[i];
    const sum = R[i] + G[i] + B[i];
    if (sum < 1e-6) { if (L < shadowT) shadow[i] = 1; continue; }
    const cr = R[i] / sum, cg = G[i] / sum, cb = B[i] / sum;
    if (L > p95) {
      // Chromatic distance to the illuminant
      const d = Math.hypot(cr - iR, cg - iG, cb - iB);
      if (d < 0.08) specular[i] = 1;
    } else if (L < shadowT) {
      shadow[i] = 1;
    }
  }
  return { specular, shadow, meta: { p95, medL, shadowT } };
}
