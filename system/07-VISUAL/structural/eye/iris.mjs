// iris.mjs — adaptive aperture, dynamic-range control.
//
// Biological iris varies pupil aperture 0.1–10 mm² (~100× area range) so
// the retina receives a workable photon count in any lighting condition.
// For a photograph that's already been captured, the input's dynamic range
// is fixed — the iris's job is to compress that range into a form where
// both highlights and shadows survive downstream processing.
//
// Two operations:
//   1) Adaptive gain: estimate scene mean luminance, boost or attenuate so
//      the mean lands at the perceptual midpoint (0.5).
//   2) Reinhard global tone map: L_out = L / (1 + L / L_white) — preserves
//      shadows in near-linear, compresses highlights softly toward L_white.
//
// Zero parameters. Closed-form. Bun-native.

/**
 * Compute per-channel iris-adapted RGB. R/G/B input in linear-light space
 * (post gamma+wb). Returns { R, G, B, aperture_gain, dr_stops_in, dr_stops_out }.
 *
 * @param R Float32Array luminance-space R
 * @param G ...
 * @param B ...
 * @param opts.target_mean  desired mean luminance (default 0.30)
 * @param opts.L_white     white point (default 1.0 after gain)
 */
export function irisAdapt(R, G, B, opts = {}) {
  const N = R.length;
  const target = opts.target_mean ?? 0.30;
  const L_white_base = opts.L_white ?? 1.0;

  const L = new Float32Array(N);
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < N; i++) {
    const v = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    L[i] = v;
    sum += v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = sum / N;
  const dr_in = mx > 0 && mn > 0 ? Math.log2(mx / mn) : 0;

  // Adaptive gain: multiply input so mean lands at target luminance.
  const gain = mean > 1e-6 ? target / mean : 1;

  // Reinhard global tone map, scene-adaptive white point.
  const L_white = Math.max(target * 2, L_white_base * gain);
  const L_white_sq = L_white * L_white;

  const Ro = new Float32Array(N);
  const Go = new Float32Array(N);
  const Bo = new Float32Array(N);
  let mn_out = Infinity, mx_out = -Infinity;
  for (let i = 0; i < N; i++) {
    const rr = R[i] * gain;
    const gg = G[i] * gain;
    const bb = B[i] * gain;
    const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    // Reinhard extended: L * (1 + L/L_white²) / (1 + L)
    const mapped_l = l * (1 + l / L_white_sq) / (1 + l);
    const scale = l > 1e-8 ? mapped_l / l : 1;
    Ro[i] = rr * scale;
    Go[i] = gg * scale;
    Bo[i] = bb * scale;
    const lo = 0.2126 * Ro[i] + 0.7152 * Go[i] + 0.0722 * Bo[i];
    if (lo < mn_out && lo > 0) mn_out = lo;
    if (lo > mx_out) mx_out = lo;
  }
  const dr_out = mx_out > 0 && mn_out > 0 ? Math.log2(mx_out / mn_out) : 0;

  return {
    R: Ro, G: Go, B: Bo,
    aperture_gain: gain,
    scene_mean: mean,
    dr_stops_in: dr_in,
    dr_stops_out: dr_out,
    L_white,
  };
}
