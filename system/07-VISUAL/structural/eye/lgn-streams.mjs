// lgn-streams.mjs — Parvo / Magno / Konio parallel channels.
//
// Lateral Geniculate Nucleus (LGN) has 6 layers organized into 3 streams,
// each with specific properties:
//
//   PARVOCELLULAR (P-cells, layers 3–6): ~80% of RGC projection.
//     - High spatial resolution, low temporal resolution
//     - Red–green color opponency (L-M cone difference)
//     - Sustained response
//     - Feeds V1 → V2 → V4 → IT (form + color)
//
//   MAGNOCELLULAR (M-cells, layers 1–2): ~10% of RGC projection.
//     - Low spatial resolution, high temporal resolution
//     - Broadband (luminance), no color
//     - Transient response
//     - Feeds V1 → MT/MST (motion + depth)
//
//   KONIOCELLULAR (K-cells, interlaminar): ~10%.
//     - Blue–yellow opponency (S vs L+M)
//     - Feeds V1 blob regions (color/hue processing)
//
// Zero parameters. Closed-form partitioning of the retinal-12 stack.

const KEYS = [
  "onSustained", "offSustained", "onTransient", "offTransient",
  "up", "down", "right", "left",
  "localEdge", "objectMotion", "uniformity", "sustainedDS",
];

/**
 * routeLGN(retinal_12_summary, opponent_map, W, H)
 *
 * Takes the 12-channel retinal summary (scalars) + full opponent maps
 * (Float32Array W*H*3 packed Y/RG/BY) and produces LGN-stream scalar
 * descriptors.
 *
 * @returns {
 *   parvo:  { form_color: number, sustained_form: number, spatial_sharpness: number, rg_energy: number },
 *   magno:  { motion_broadband: number, transient_energy: number, direction_energy: number, temporal_sharpness: number },
 *   konio:  { by_energy: number, blob_hue: number },
 *   flat:   { ... 12 stream-flattened scalars for signature use ... }
 * }
 */
export function routeLGN(retinal_12_summary, opponent_map, W, H) {
  const s = retinal_12_summary;
  const N = W * H;

  // Compute per-channel energy from the opponent map
  let sumY = 0, sumRG = 0, sumBY = 0;
  let sumY2 = 0, sumRG2 = 0, sumBY2 = 0;
  let minRG = Infinity, maxRG = -Infinity;
  let minBY = Infinity, maxBY = -Infinity;
  for (let i = 0; i < N; i++) {
    const y = opponent_map[i * 3 + 0];
    const rg = opponent_map[i * 3 + 1];
    const by = opponent_map[i * 3 + 2];
    sumY += y; sumRG += rg; sumBY += by;
    sumY2 += y * y; sumRG2 += rg * rg; sumBY2 += by * by;
    if (rg < minRG) minRG = rg; if (rg > maxRG) maxRG = rg;
    if (by < minBY) minBY = by; if (by > maxBY) maxBY = by;
  }
  const meanY = sumY / N, meanRG = sumRG / N, meanBY = sumBY / N;
  const varY = sumY2 / N - meanY * meanY;
  const varRG = sumRG2 / N - meanRG * meanRG;
  const varBY = sumBY2 / N - meanBY * meanBY;

  // PARVO: sustained + high spatial + color (RG) — form and detail
  const parvo = {
    form_color: (s.onSustained + s.offSustained) * 0.5 + Math.abs(meanRG),
    sustained_form: s.onSustained - s.offSustained,      // signed form response
    spatial_sharpness: s.localEdge,                       // fine spatial edges
    rg_energy: Math.sqrt(varRG),                          // chromatic contrast
    rg_range: maxRG - minRG,
  };

  // MAGNO: transient + broadband + motion — action stream
  const parasolTransient = s.onTransient + s.offTransient;
  const dsEnergy = s.up + s.down + s.left + s.right;
  const magno = {
    motion_broadband: Math.sqrt(varY),                     // luminance contrast
    transient_energy: parasolTransient,                    // ON/OFF flicker
    direction_energy: dsEnergy,                            // any-direction motion
    temporal_sharpness: s.objectMotion,                    // object-vs-background flow
    sustained_ds: s.sustainedDS,                           // long-timescale motion
  };

  // KONIO: BY opponent — color hue
  const konio = {
    by_energy: Math.sqrt(varBY),
    blob_hue: Math.abs(meanBY),
    by_range: maxBY - minBY,
  };

  // Flat 12-scalar summary for signature concat downstream
  const flat = {
    parvo_form_color: parvo.form_color,
    parvo_sustained_form: parvo.sustained_form,
    parvo_spatial_sharpness: parvo.spatial_sharpness,
    parvo_rg_energy: parvo.rg_energy,
    magno_motion_broadband: magno.motion_broadband,
    magno_transient_energy: magno.transient_energy,
    magno_direction_energy: magno.direction_energy,
    magno_temporal_sharpness: magno.temporal_sharpness,
    magno_sustained_ds: magno.sustained_ds,
    konio_by_energy: konio.by_energy,
    konio_blob_hue: konio.blob_hue,
    uniformity: s.uniformity,
  };

  return { parvo, magno, konio, flat };
}
