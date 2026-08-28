// rod-pathway.mjs — periphery/scotopic rod system.
//
// Human retina has ~120M rods vs ~6M cones. Rods dominate the periphery,
// are ~100× more light-sensitive than cones, have no color discrimination,
// and are strongly biased toward motion detection. This module simulates
// that pathway as a low-resolution, high-sensitivity, monochrome field
// with temporal boost.
//
// Scientific anchors:
//   - Rod spectral sensitivity peaks at 498 nm (blue-green).
//   - Rod density peaks at ~18° eccentricity (mid-periphery).
//   - Rods saturate above ~1 cd/m²; cones take over.
//   - Rod-driven parasol RGCs feed the magnocellular pathway.
//
// Zero parameters. Closed-form.

/**
 * rodField(R, G, B, W, H) → { rod, W_out, H_out, saturated_frac, sensitivity_gain }
 *
 * Rod luminance uses scotopic weights (498 nm peak):
 *   L_rod = 0.02·R + 0.71·G + 0.27·B
 * Downsampled 4× (rods have lower spatial resolution than cones), high-gain.
 *
 * The rod field is downstream input to the magnocellular stream and the
 * peripheral saliency map.
 */
export function rodField(R, G, B, W, H) {
  const N = W * H;
  const W_out = Math.max(8, Math.floor(W / 4));
  const H_out = Math.max(8, Math.floor(H / 4));
  const rod_full = new Float32Array(N);
  let mn = Infinity, mx = -Infinity, saturated = 0;
  for (let i = 0; i < N; i++) {
    // Scotopic luminance weights (peak sensitivity 498 nm)
    const v = 0.02 * R[i] + 0.71 * G[i] + 0.27 * B[i];
    rod_full[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    // Rods saturate above ~1.0 (mesopic transition)
    if (v > 1.0) saturated++;
  }
  const range = (mx - mn) || 1;

  // Adaptive rod gain: high sensitivity in dark, saturates in light
  const mean_v = mx > 0 ? (mn + mx) / 2 : 0.5;
  const sensitivity_gain = Math.min(50, 1 / Math.max(0.02, mean_v));

  // Downsample 4× via box average
  const rod = new Float32Array(W_out * H_out);
  const step_x = W / W_out;
  const step_y = H / H_out;
  for (let y = 0; y < H_out; y++) {
    for (let x = 0; x < W_out; x++) {
      let sum = 0, count = 0;
      const y0 = Math.floor(y * step_y);
      const y1 = Math.min(H, Math.floor((y + 1) * step_y));
      const x0 = Math.floor(x * step_x);
      const x1 = Math.min(W, Math.floor((x + 1) * step_x));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += rod_full[yy * W + xx];
          count++;
        }
      }
      const v = count > 0 ? sum / count : 0;
      // Apply sensitivity gain + soft saturation (Naka-Rushton lite)
      const gained = v * sensitivity_gain;
      rod[y * W_out + x] = gained / (1 + gained);
    }
  }

  return {
    rod, W_out, H_out,
    saturated_frac: saturated / N,
    sensitivity_gain,
    scotopic_range: range,
  };
}
