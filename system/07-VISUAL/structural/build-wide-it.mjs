// build-wide-it.mjs — extract wide IT vector from canonical output.
//
// Concatenates every discriminative signal:
//   [0..79]      existing IT-80
//   [80..241]   all 162 axis-bundle scalars (in stable order)
//   [242..253]  retinal-12 summary (12 scalars)
//   [254..266]  LGN parvo+magno+konio sub-descriptors (~13 scalars)
//   [267..285]  shape+spectral moments (19 scalars)
//
// Total: ~286 dimensions (up from 80).

const AXIS_ORDER = [
  "radial_photon","photon_histogram","photon_correlation","subsurface",
  "spatial_color","color_ratio","texture_vocab","hu_moments",
  "persistent_homology","dichromatic","fourier_mellin","texture",
  "edge","specular","spatial_frequency",
];

/**
 * Extract wide IT vector from a canonical output.
 * @returns Float32Array of ~286 dims, plus metadata.
 */
export function buildWideIT(can) {
  const parts = [];
  // 1. Base IT-80
  parts.push(...Array.from(can.it_vector || []));

  // 2. Axis-bundle scalars in stable order
  const axisScalars = [];
  for (const axisName of AXIS_ORDER) {
    const axis = can.axis_bundle?.[axisName];
    if (!axis || axis._error) continue;
    const keys = Object.keys(axis).filter(k => !k.startsWith("_")).sort();
    for (const k of keys) {
      const v = axis[k];
      if (typeof v === "number" && Number.isFinite(v)) axisScalars.push(v);
    }
  }
  parts.push(...axisScalars);

  // 3. Retinal-12 summary
  if (can.retinal_12) {
    const r12keys = Object.keys(can.retinal_12).sort();
    for (const k of r12keys) {
      const v = can.retinal_12[k];
      if (typeof v === "number" && Number.isFinite(v)) parts.push(v);
    }
  }

  // 4. LGN sub-descriptors (parvo + magno + konio, not the flat one)
  const lgnSubs = [];
  for (const sub of ["parvo","magno","konio"]) {
    const s = can.lgn?.[sub];
    if (!s) continue;
    const keys = Object.keys(s).sort();
    for (const k of keys) {
      const v = s[k];
      if (typeof v === "number" && Number.isFinite(v)) lgnSubs.push(v);
    }
  }
  parts.push(...lgnSubs);

  // 5. Shape + spectral moments
  if (can.shape_moments) for (const v of can.shape_moments) parts.push(v);
  if (can.spectral_moments) for (const v of can.spectral_moments) parts.push(v);

  // Sanitize
  const wide = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i];
    wide[i] = (typeof v === "number" && Number.isFinite(v)) ? v : 0;
  }
  return wide;
}
