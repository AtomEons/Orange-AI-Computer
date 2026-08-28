// it-variants.mjs — W+n additive experimenter for IT vector.
//
// Edison/Tesla method: hold winner W. Vary ONE thing at a time. Measure.
// Never regress W. Stack proven winners.
//
// This module builds IT vectors from CACHED canonical inputs (no re-capture),
// so each W+n variant takes milliseconds not minutes. The base itIdentity
// function is preserved; variants override or add specific blocks.

const nb = (arr) => {
  let n = 0;
  for (const v of arr) n += v * v;
  n = Math.sqrt(n) || 1;
  return arr.map(v => v / n);
};

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v)) ? v : fallback;

/**
 * Build IT vector from cached inputs with variant-specific override.
 *
 *   inputs = {
 *     lgnFlat, v1Summary, v2Summary, v4Summary,
 *     ilcRProf, ilcRgProf, ilcByProf,
 *     axisBundle
 *   }
 *
 *   variant = one of:
 *     "W"           = 80-D baseline (winner)
 *     "W+1_fm_dc"   = W + 1 dim of FM (fm_1 magnitude only)
 *     "W+2_fm_head" = W + 4 dims of FM (fm_0..fm_3)
 *     "W+3_specular"= W + 4 dims of specular/subsurface additions
 *     "W+4_log_chroma"= W + 3 dims of log-chroma differences
 *     "W+5_photon_corr" = W + 6 dims of photon-correlation
 *     "W+6_downweight_by"= W with ILC-BY block halved
 *     "W+7_downweight_rg"= W with ILC-RG block halved
 *     "W+8_stronger_axis" = W with axis-bundle slice doubled (40 dims)
 *     "W+9_ori_diversity" = W + orientation-diversity feature
 *     "W+10_uniformity_ratio" = W + magno-parvo ratio
 */
export function buildITVariant(inputs, variant = "W") {
  const dimsByBlock = {
    lgn: 12, v1: 4, v2: 6, v4: 8, ilcY: 10, ilcRG: 10, ilcBY: 10, axis: 20,
  };
  let extra = 0;
  const extraBlocks = [];

  // Base blocks
  const lgn = inputs.lgnFlat || {};
  const lgnKeys = [
    "parvo_form_color", "parvo_sustained_form", "parvo_spatial_sharpness", "parvo_rg_energy",
    "magno_motion_broadband", "magno_transient_energy", "magno_direction_energy",
    "magno_temporal_sharpness", "magno_sustained_ds",
    "konio_by_energy", "konio_blob_hue", "uniformity",
  ];
  const lgnVec = nb(lgnKeys.map(k => num(lgn[k])));

  const v1 = inputs.v1Summary || {};
  const v1Agg = [0, 0, 0, 0];
  let oriSum = 0, oriSumSq = 0;
  for (let s = 0; s < 3; s++) {
    let e = 0;
    for (let o = 0; o < 8; o++) {
      const v = num(v1[`v1_s${s}_o${o}`]);
      e += v; oriSum += v; oriSumSq += v * v;
    }
    v1Agg[s] = e / 8;
  }
  const oriMean = oriSum / 24;
  v1Agg[3] = Math.sqrt(oriSumSq / 24 - oriMean * oriMean);
  const v1Vec = nb(v1Agg);

  const v2 = inputs.v2Summary || {};
  const v2Keys = [
    "contour_energy", "contour_max", "texture_boundary_energy",
    "v2_scale_0_contour_mean", "v2_scale_1_contour_mean", "v2_scale_2_contour_mean",
  ];
  const v2Vec = nb(v2Keys.map(k => num(v2[k])));

  const v4 = inputs.v4Summary || {};
  const v4Keys = [
    "v4_curvature_mean", "v4_curvature_max", "v4_concavity_frac", "v4_complexity",
    "v4_centroid_x_norm", "v4_centroid_y_norm", "v4_rg_var_contour", "v4_by_var_contour",
  ];
  const v4Vec = nb(v4Keys.map(k => num(v4[k])));

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
  const ilcY = nb(downsample(inputs.ilcRProf, 10));
  const ilcRG = nb(downsample(inputs.ilcRgProf, 10));
  const ilcBY = nb(downsample(inputs.ilcByProf, 10));

  const ab = inputs.axisBundle || {};
  const pick = (axisName, key) => {
    const axis = ab[axisName];
    return (axis && !axis._error) ? num(axis[key]) : 0;
  };
  const bundlePicks = [
    pick("subsurface", "sss_edge_softness"), pick("subsurface", "sss_shadow_glow"),
    pick("subsurface", "sss_boundary_warm_shift"),
    pick("specular", "specular_frac"), pick("specular", "specular_peak"),
    pick("texture", "lbp_entropy"), pick("texture", "local_var_mean"),
    pick("spatial_frequency", "sf_dc_frac"), pick("spatial_frequency", "sf_low_frac"),
    pick("spatial_frequency", "sf_high_frac"),
    pick("photon_correlation", "corr_RG"), pick("photon_correlation", "corr_RB"),
    pick("photon_correlation", "corr_GB"), pick("photon_correlation", "corr_RL"),
    pick("photon_correlation", "corr_GL"), pick("photon_correlation", "corr_BL"),
    pick("edge", "edge_density"), pick("edge", "edge_mean_magnitude"),
    pick("dichromatic", "dichro_fit_residual"), pick("color_ratio", "log_RG"),
  ];
  const axisVec = nb(bundlePicks);

  // Optional weight overrides per variant
  let wILC_RG = 1.0, wILC_BY = 1.0, wLGN = 1.0, wAxis = 1.0;
  let axisExtras = [];  // additional block appended after axis
  let axisSlot = null;  // to override axis block content

  const buildFmHead = () => {
    const fm = ab.fourier_mellin && !ab.fourier_mellin._error ? ab.fourier_mellin : {};
    return nb([num(fm.fm_0), num(fm.fm_1), num(fm.fm_2), num(fm.fm_3)]);
  };

  switch (variant) {
    case "W":
      break;
    case "W+1_fm_head":
      axisExtras = buildFmHead();
      break;
    // Stacks — proven winners combined
    case "W+1+5_fm_head_+_dwLGN":
      axisExtras = buildFmHead();
      wLGN = 0.7;
      break;
    case "W+1+6_fm_head_+_upAxis":
      axisExtras = buildFmHead();
      wAxis = 2.0;
      break;
    case "W+5+6_dwLGN_+_upAxis":
      wLGN = 0.7; wAxis = 2.0;
      break;
    case "W+1+5+6_all_three":
      axisExtras = buildFmHead();
      wLGN = 0.7; wAxis = 2.0;
      break;
    // Targeted candidates for starry_night × neon → home
    case "W+13_fm_0_only":
      axisExtras = (() => {
        const fm = ab.fourier_mellin && !ab.fourier_mellin._error ? ab.fourier_mellin : {};
        return nb([num(fm.fm_0)]);
      })();
      break;
    case "W+14_fm_head_8":
      axisExtras = (() => {
        const fm = ab.fourier_mellin && !ab.fourier_mellin._error ? ab.fourier_mellin : {};
        return nb([num(fm.fm_0), num(fm.fm_1), num(fm.fm_2), num(fm.fm_3),
                   num(fm.fm_4), num(fm.fm_5), num(fm.fm_6), num(fm.fm_7)]);
      })();
      break;
    case "W+15_v4_curvature_boost":
      // Boost specifically the curvature dims of V4
      axisExtras = nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max),
                       num(v4.v4_complexity), num(v4.v4_concavity_frac)]);
      break;
    case "W+16_v2_contour_boost":
      axisExtras = nb([num(v2.contour_energy), num(v2.contour_max), num(v2.texture_boundary_energy)]);
      break;
    case "W+17_dwLGN_stronger":
      wLGN = 0.5;
      break;
    case "W+18_upAxis_stronger":
      wAxis = 3.0;
      break;
    case "W+19_dwLGN_upAxis_med":
      wLGN = 0.85; wAxis = 1.5;
      break;
    case "W+1_stack_v4curve":
      axisExtras = [
        ...buildFmHead(),
        ...nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max),
               num(v4.v4_complexity), num(v4.v4_concavity_frac)]),
      ];
      break;
    // Round 3 — target starry_night × neon → home (margin 0.004 at W+17)
    case "W+20_dwLGN_0.4":         wLGN = 0.4; break;
    case "W+21_dwLGN_0.3":         wLGN = 0.3; break;
    case "W+22_dwLGN_0.2":         wLGN = 0.2; break;
    case "W+23_dwLGN_0.0":         wLGN = 0.0; break;
    case "W+1+17_fm_head_dwLGN_0.5":
      axisExtras = buildFmHead(); wLGN = 0.5; break;
    case "W+1+20_fm_head_dwLGN_0.4":
      axisExtras = buildFmHead(); wLGN = 0.4; break;
    case "W+1+21_fm_head_dwLGN_0.3":
      axisExtras = buildFmHead(); wLGN = 0.3; break;
    case "W+1+22_fm_head_dwLGN_0.2":
      axisExtras = buildFmHead(); wLGN = 0.2; break;
    case "W+17+6_dwLGN_0.5_upAxis":
      wLGN = 0.5; wAxis = 2.0; break;
    case "W+17+6_stronger":
      wLGN = 0.5; wAxis = 3.0; break;
    case "W+1+17+6_all_stack":
      axisExtras = buildFmHead(); wLGN = 0.5; wAxis = 2.0; break;
    case "W+curvature_only_block":
      // Add PURE v4 curvature as its own block for high weight
      axisExtras = nb([num(v4.v4_curvature_mean) * 2, num(v4.v4_curvature_max) * 2,
                       num(v4.v4_complexity) * 2, num(v4.v4_concavity_frac) * 2]);
      break;
    case "W+1_and_curve_and_dwLGN_0.5":
      axisExtras = [
        ...buildFmHead(),
        ...nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max),
               num(v4.v4_complexity), num(v4.v4_concavity_frac)]),
      ];
      wLGN = 0.5;
      break;
    case "W+centroid_position":
      // Position of image content centroid (from V4)
      axisExtras = nb([num(v4.v4_centroid_x_norm), num(v4.v4_centroid_y_norm),
                       num(v4.v4_complexity)]);
      break;
    // Round 4 — SHAPE-ONLY / drop chromatic
    case "W+drop_ILC_RG_BY":       wILC_RG = 0.0; wILC_BY = 0.0; break;
    case "W+drop_LGN_and_chroma":  wLGN = 0.0; wILC_RG = 0.0; wILC_BY = 0.0; break;
    case "W+1+drop_ILC_RG_BY":     axisExtras = buildFmHead(); wILC_RG = 0.0; wILC_BY = 0.0; break;
    case "W+heavy_shape":          wLGN = 0.5; wILC_RG = 0.3; wILC_BY = 0.3; wAxis = 2.0; break;
    case "W+shape_only":           wLGN = 0.3; wILC_RG = 0.1; wILC_BY = 0.1; wAxis = 3.0; break;
    // Spatial-freq high boost (starry_night has paint texture — high sf_high)
    case "W+sf_high":
      axisExtras = (() => {
        const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
        return nb([num(f.sf_high_frac)]);
      })();
      break;
    case "W+sf_high_x3":
      axisExtras = (() => {
        const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
        return nb([num(f.sf_high_frac) * 3, num(f.sf_low_frac) * 3, num(f.sf_dc_frac) * 3]);
      })();
      break;
    case "W+1+sf_high":
      axisExtras = [
        ...buildFmHead(),
        ...(() => {
          const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
          return nb([num(f.sf_high_frac)]);
        })(),
      ];
      break;
    case "W+massive_v4":
      // V4 as its own extra block, heavily weighted
      axisExtras = nb([
        num(v4.v4_curvature_mean) * 3, num(v4.v4_curvature_max) * 3,
        num(v4.v4_concavity_frac) * 3, num(v4.v4_complexity) * 3,
        num(v4.v4_centroid_x_norm) * 3, num(v4.v4_centroid_y_norm) * 3,
        num(v4.v4_rg_var_contour) * 3, num(v4.v4_by_var_contour) * 3,
      ]);
      break;
    case "W+1+heavy_shape":
      axisExtras = buildFmHead(); wLGN = 0.5; wILC_RG = 0.3; wILC_BY = 0.3; wAxis = 2.0;
      break;
    case "W+extreme_shape_bias":
      axisExtras = [
        ...buildFmHead(),
        ...nb([
          num(v4.v4_curvature_mean) * 2, num(v4.v4_curvature_max) * 2,
          num(v4.v4_concavity_frac) * 2, num(v4.v4_complexity) * 2,
        ]),
      ];
      wLGN = 0.5; wILC_RG = 0.5; wILC_BY = 0.5; wAxis = 1.5;
      break;
    case "W+radial_photon":
      // Add radial-photon rings from axis bundle
      axisExtras = (() => {
        const rp = ab.radial_photon && !ab.radial_photon._error ? ab.radial_photon : {};
        const keys = [];
        for (let r = 0; r < 8; r++) for (const c of ["R","G","B","L"]) keys.push(num(rp[`ring${r}_${c}`]));
        return nb(keys);
      })();
      break;
    // Round 5 — Grand stacks of all discovered winners
    case "W+GRAND_1":
      // fm_head + curvature + dwLGN_0.2 + upAxis_2 + sf_high
      axisExtras = [
        ...buildFmHead(),
        ...nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max),
               num(v4.v4_complexity), num(v4.v4_concavity_frac)]),
        ...(() => {
          const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
          return nb([num(f.sf_high_frac)]);
        })(),
      ];
      wLGN = 0.2; wAxis = 2.0;
      break;
    case "W+GRAND_2":
      // Focused chromatic strip + heavy shape
      axisExtras = [
        ...buildFmHead(),
        ...nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max), num(v4.v4_complexity)]),
      ];
      wLGN = 0.3; wILC_RG = 0.3; wILC_BY = 0.3; wAxis = 2.5;
      break;
    case "W+GRAND_3":
      // Everything all-shape
      axisExtras = [
        ...buildFmHead(),
        ...nb([
          num(v4.v4_curvature_mean) * 2, num(v4.v4_curvature_max) * 2,
          num(v4.v4_concavity_frac) * 2, num(v4.v4_complexity) * 2,
          num(v2.contour_energy), num(v2.texture_boundary_energy),
        ]),
      ];
      wLGN = 0.3; wILC_RG = 0.4; wILC_BY = 0.4; wAxis = 2.0;
      break;
    case "W+GRAND_4":
      // Multi-block stack
      axisExtras = [
        ...buildFmHead(),
        ...nb([num(v4.v4_curvature_mean), num(v4.v4_curvature_max),
               num(v4.v4_complexity), num(v4.v4_concavity_frac)]),
        ...(() => {
          const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
          return nb([num(f.sf_high_frac), num(f.sf_low_frac)]);
        })(),
      ];
      wLGN = 0.2; wAxis = 1.5;
      break;
    case "W+ALL_WINNERS":
      // All Round 3 and Round 4 winners combined
      axisExtras = [
        ...buildFmHead(),
        ...(() => {
          const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
          return nb([num(f.sf_high_frac)]);
        })(),
      ];
      wLGN = 0.2; wILC_RG = 0.4; wILC_BY = 0.4; wAxis = 2.0;
      break;
    case "W+FOCUSED_starrynight":
      // Target starry_night specifically: heavy curvature + FM + shape
      axisExtras = [
        ...buildFmHead(),
        ...nb([
          num(v4.v4_curvature_mean) * 4,
          num(v4.v4_curvature_max) * 4,
          num(v4.v4_complexity) * 3,
          num(v4.v4_concavity_frac) * 2,
        ]),
      ];
      wLGN = 0.3;
      break;
    case "W+narrow_LGN_only":
      // Only use parvo/magno separators — drop konio
      wLGN = 1.0;
      // (keep base blocks; just baseline for narrow inspection)
      axisExtras = nb([num(lgn.parvo_spatial_sharpness), num(lgn.magno_direction_energy)]);
      break;
    case "W+2_fm_dc_only":
      axisExtras = (() => {
        const fm = ab.fourier_mellin && !ab.fourier_mellin._error ? ab.fourier_mellin : {};
        return nb([num(fm.fm_1)]);
      })();
      break;
    case "W+3_log_chroma":
      axisExtras = (() => {
        const d = ab.dichromatic && !ab.dichromatic._error ? ab.dichromatic : {};
        return nb([num(d.bodyLogRG), num(d.bodyLogGB), num(d.bodyLogRB)]);
      })();
      break;
    case "W+4_downweight_RG_BY":
      wILC_RG = 0.5; wILC_BY = 0.5;
      break;
    case "W+5_downweight_LGN":
      wLGN = 0.7;
      break;
    case "W+6_upweight_axis":
      wAxis = 2.0;
      break;
    case "W+7_photon_corr_extra":
      axisExtras = (() => {
        const p = ab.photon_correlation && !ab.photon_correlation._error ? ab.photon_correlation : {};
        return nb([num(p.corr_RG), num(p.corr_RB), num(p.corr_GB), num(p.corr_RL), num(p.corr_GL), num(p.corr_BL)]);
      })();
      break;
    case "W+8_ori_diversity_only":
      axisExtras = nb([v1Agg[3]]);
      break;
    case "W+9_subsurface_extra":
      axisExtras = (() => {
        const s = ab.subsurface && !ab.subsurface._error ? ab.subsurface : {};
        return nb([num(s.sss_edge_softness), num(s.sss_shadow_glow), num(s.sss_boundary_warm_shift)]);
      })();
      break;
    case "W+10_spatial_freq_extra":
      axisExtras = (() => {
        const f = ab.spatial_frequency && !ab.spatial_frequency._error ? ab.spatial_frequency : {};
        return nb([num(f.sf_dc_frac), num(f.sf_low_frac), num(f.sf_high_frac)]);
      })();
      break;
    case "W+11_v4_double":
      axisExtras = nb([...v4Keys.map(k => num(v4[k]))]);
      break;
    case "W+12_texture_extra":
      axisExtras = (() => {
        const t = ab.texture && !ab.texture._error ? ab.texture : {};
        return nb([num(t.lbp_entropy), num(t.local_var_mean)]);
      })();
      break;
    default:
      throw new Error("Unknown variant: " + variant);
  }

  const D = 80 + axisExtras.length;
  const vec = new Float32Array(D);
  for (let i = 0; i < 12; i++) vec[i] = lgnVec[i] * wLGN;
  for (let i = 0; i < 4; i++)  vec[12 + i] = v1Vec[i];
  for (let i = 0; i < 6; i++)  vec[16 + i] = v2Vec[i];
  for (let i = 0; i < 8; i++)  vec[22 + i] = v4Vec[i];
  for (let i = 0; i < 10; i++) vec[30 + i] = ilcY[i];
  for (let i = 0; i < 10; i++) vec[40 + i] = ilcRG[i] * wILC_RG;
  for (let i = 0; i < 10; i++) vec[50 + i] = ilcBY[i] * wILC_BY;
  for (let i = 0; i < 20; i++) vec[60 + i] = axisVec[i] * wAxis;
  for (let i = 0; i < axisExtras.length; i++) vec[80 + i] = axisExtras[i];

  return vec;
}

export function itVariantSim(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}
