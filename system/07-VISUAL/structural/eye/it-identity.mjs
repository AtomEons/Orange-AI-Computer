// it-identity.mjs — Inferotemporal (IT) invariant object-identity code.
//
// IT is the terminal ventral-stream stage. Cells here fire for a specific
// object identity across a wide range of poses, sizes, illuminations, and
// partial occlusions. Freiwald & Tsao (2010) showed face-patch cells with
// stable identity codes across viewpoints.
//
// Our IT is a HIGH-LEVEL fusion: it takes downstream perception layers
// (parvo form + color, magno motion, konio color, V1 orientation, V2 contour,
// V4 shape, ILC signature) and produces a single ~40-D descriptor that
// SHOULD be near-invariant to lighting, viewpoint, and moderate deformation.
//
// This is the vector to hand to the pattern engine for family membership.
//
// Zero parameters. Weighted concatenation only.

/**
 * itIdentity({ lgnFlat, v1Summary, v2Summary, v4Summary, ilc, axisBundle }) → Float32Array(80)
 *
 * AWE-3.0.1 — 80-D IT with chromatic identity + axis-bundle discriminative slice.
 * FM/log-chroma expansion to 119-D was tested 2026-07-09 and regressed to 14/19
 * (FM's coarse coefficients washed out abstract-pattern distinctions and were
 * not robust to neon distortion). Reverted to 80-D.
 *
 * Deterministic ordering:
 *   [0..11]  = LGN parvo/magno/konio flat scalars (12)
 *   [12..15] = V1 orientation summary (4)
 *   [16..21] = V2 contour summary (6)
 *   [22..29] = V4 shape descriptors (8)
 *   [30..39] = ILC Y radial (10)
 *   [40..49] = ILC RG radial (10)
 *   [50..59] = ILC BY radial (10)
 *   [60..79] = axis-bundle discriminative slice (20)
 *
 * Each block is L2-normalized independently, then concatenated.
 */
export function itIdentity(inputs) {
  const D = 80;
  const vec = new Float32Array(D);

  const nb = (arr) => {
    let n = 0;
    for (const v of arr) n += v * v;
    n = Math.sqrt(n) || 1;
    return arr.map(v => v / n);
  };

  // Block 1: LGN flat 12
  const lgn = inputs.lgnFlat || {};
  const lgnKeys = [
    "parvo_form_color", "parvo_sustained_form", "parvo_spatial_sharpness", "parvo_rg_energy",
    "magno_motion_broadband", "magno_transient_energy", "magno_direction_energy",
    "magno_temporal_sharpness", "magno_sustained_ds",
    "konio_by_energy", "konio_blob_hue", "uniformity",
  ];
  const lgnVec = nb(lgnKeys.map(k => Number(lgn[k]) || 0));
  for (let i = 0; i < 12; i++) vec[i] = lgnVec[i];

  // Block 2: V1 — aggregate 24 orientation-scale into 4 scale-orientation-energy summaries
  const v1 = inputs.v1Summary || {};
  const v1Agg = [0, 0, 0, 0];  // [scale0_energy, scale1_energy, scale2_energy, oriDiversity]
  let oriSum = 0, oriSumSq = 0;
  for (let s = 0; s < 3; s++) {
    let e = 0;
    for (let o = 0; o < 8; o++) {
      const v = Number(v1[`v1_s${s}_o${o}`]) || 0;
      e += v;
      oriSum += v;
      oriSumSq += v * v;
    }
    v1Agg[s] = e / 8;
  }
  const oriMean = oriSum / 24;
  v1Agg[3] = Math.sqrt(oriSumSq / 24 - oriMean * oriMean);  // orientation-diversity
  const v1Norm = nb(v1Agg);
  for (let i = 0; i < 4; i++) vec[12 + i] = v1Norm[i];

  // Block 3: V2 contour — 6-D
  const v2 = inputs.v2Summary || {};
  const v2Keys = [
    "contour_energy", "contour_max", "texture_boundary_energy",
    "v2_scale_0_contour_mean", "v2_scale_1_contour_mean", "v2_scale_2_contour_mean",
  ];
  const v2Vec = nb(v2Keys.map(k => Number(v2[k]) || 0));
  for (let i = 0; i < 6; i++) vec[16 + i] = v2Vec[i];

  // Block 4: V4 shape — 8-D
  const v4 = inputs.v4Summary || {};
  const v4Keys = [
    "v4_curvature_mean", "v4_curvature_max", "v4_concavity_frac", "v4_complexity",
    "v4_centroid_x_norm", "v4_centroid_y_norm", "v4_rg_var_contour", "v4_by_var_contour",
  ];
  const v4Vec = nb(v4Keys.map(k => Number(v4[k]) || 0));
  for (let i = 0; i < 8; i++) vec[22 + i] = v4Vec[i];

  // Blocks 5–7: ILC Y / RG / BY radial (10 dims each = 30 dims total)
  const ilc = inputs.ilc || null;
  const downsample = (arr, targetLen) => {
    if (!arr || arr.length === 0) return new Array(targetLen).fill(0);
    const step = arr.length / targetLen;
    const out = new Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
      const i0 = Math.floor(i * step);
      const i1 = Math.max(i0 + 1, Math.floor((i + 1) * step));
      let sum = 0;
      for (let j = i0; j < i1; j++) sum += arr[j];
      out[i] = sum / (i1 - i0);
    }
    return out;
  };
  if (ilc) {
    if (ilc.rProf) {
      const v = nb(downsample(ilc.rProf, 10));
      for (let i = 0; i < 10; i++) vec[30 + i] = v[i];
    }
    if (ilc.rgProf) {
      const v = nb(downsample(ilc.rgProf, 10));
      for (let i = 0; i < 10; i++) vec[40 + i] = v[i];
    }
    if (ilc.byProf) {
      const v = nb(downsample(ilc.byProf, 10));
      for (let i = 0; i < 10; i++) vec[50 + i] = v[i];
    }
  }

  // Block 8: axis-bundle discriminative slice (20 dims).
  // We pull specific scalars known to discriminate across object categories:
  // subsurface (translucent/opaque), specular (glossy/matte), texture (rough/smooth),
  // spatial_frequency (grid-vs-natural), photon_correlation (color coupling).
  const ab = inputs.axisBundle || {};
  const pickScalar = (axisName, scalarKey, fallback = 0) => {
    const axis = ab[axisName];
    if (!axis || axis._error) return fallback;
    const v = axis[scalarKey];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const bundlePicks = [
    pickScalar("subsurface", "sss_edge_softness"),
    pickScalar("subsurface", "sss_shadow_glow"),
    pickScalar("subsurface", "sss_boundary_warm_shift"),
    pickScalar("specular", "specular_frac"),
    pickScalar("specular", "specular_peak"),
    pickScalar("texture", "lbp_entropy"),
    pickScalar("texture", "local_var_mean"),
    pickScalar("spatial_frequency", "sf_dc_frac"),
    pickScalar("spatial_frequency", "sf_low_frac"),
    pickScalar("spatial_frequency", "sf_high_frac"),
    pickScalar("photon_correlation", "corr_RG"),
    pickScalar("photon_correlation", "corr_RB"),
    pickScalar("photon_correlation", "corr_GB"),
    pickScalar("photon_correlation", "corr_RL"),
    pickScalar("photon_correlation", "corr_GL"),
    pickScalar("photon_correlation", "corr_BL"),
    pickScalar("edge", "edge_density"),
    pickScalar("edge", "edge_mean_magnitude"),
    pickScalar("dichromatic", "dichro_fit_residual"),
    pickScalar("color_ratio", "log_RG"),
  ];
  const bundleNorm = nb(bundlePicks);
  for (let i = 0; i < 20; i++) vec[60 + i] = bundleNorm[i];

  return vec;
}

/** Cosine similarity between two IT identity vectors. */
export function itSim(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
