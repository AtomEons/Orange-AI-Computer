// 07-VISUAL/structural/taps/pipeline-taps.mjs
//
// LGN stage taps + IT-80 contribution trace per GPT doctrine v4 (spine seq 112).
//
// LGN: emit PARVO, MAGNO, KONIO as THREE SEPARATE lanes (not concatenated).
// GPT: "One stream may preserve a distinction while another properly ignores it."
//
// IT-80: trace contribution by source-axis block.
// GPT: "The goal is to identify whether loss comes from normalization / weighted mixing /
//       dimensional reduction / saturation / clipping / cancellation between lanes."

import { captureCanonicalPhoton } from "../photon-canonical.mjs";

// GPT doctrine v5 (spine seq 115): temporal channels UNAVAILABLE in static mode.
// Do NOT emit zero-valued vectors — that would falsely claim "measured no motion."
// A magno lane based on temporal channels must be marked availability=false when
// no temporal window is supplied.
const TEMPORAL_RETINAL_CHANNELS = new Set([
  "onTransient", "offTransient", "up", "down", "right", "left", "objectMotion", "sustainedDS",
]);

// Detect static mode from a canonical result. Right now every captureCanonicalPhoton
// call is static — we hardcode until v1.1 threads a real temporal window through.
function isStaticCapture(canonical) {
  return !canonical.temporal_window || canonical.temporal_window.mode === "STATIC";
}

// ---- Helper: extract per-block IT-80 sub-vectors from canonical output ----
// IT-80 block layout per it-identity.mjs:
//   [0..11]  LGN flat 12
//   [12..15] V1 orientation summary (4)
//   [16..21] V2 contour (6)
//   [22..29] V4 shape (8)
//   [30..39] ILC Y radial (10)
//   [40..49] ILC RG radial (10)
//   [50..59] ILC BY radial (10)
//   [60..79] axis-bundle discriminative slice (20)
const IT_BLOCKS = [
  { name: "LGN_flat",     start: 0,  end: 12 },
  { name: "V1_ori",       start: 12, end: 16 },
  { name: "V2_contour",   start: 16, end: 22 },
  { name: "V4_shape",     start: 22, end: 30 },
  { name: "ILC_Y",        start: 30, end: 40 },
  { name: "ILC_RG",       start: 40, end: 50 },
  { name: "ILC_BY",       start: 50, end: 60 },
  { name: "AXIS_slice",   start: 60, end: 80 },
];

// ---- LGN taps: 3 SEPARATE streams ----
// T0 source     — retinal_12 summary + opponent_map (LGN input)
// T1 local      — per-stream computed sub-vectors from routeLGN
// T2 pooled     — per-stream pooled scalars (parvo:5, magno:5, konio:3)
// T3 aggregate  — per-stream contribution to LGN flat (parvo dims of flat, etc)

export function lgnStreamsLevels(canonical) {
  const R12 = canonical.retinal_12 ?? {};
  const opp = canonical.opponent_map ?? null;
  const lgn = canonical.lgn ?? {};
  const staticMode = isStaticCapture(canonical);

  // T0 source — the LGN input: retinal_12 flat (12 scalars) + opponent-map summary stats
  // In static mode, temporal channels are marked NaN so downstream distance math skips them.
  // The list preserves position/order so parvo/konio T0 still work.
  const r12Keys = [
    "onSustained", "offSustained", "onTransient", "offTransient",
    "up", "down", "right", "left",
    "localEdge", "objectMotion", "uniformity", "sustainedDS",
  ];
  const t0R12 = new Float32Array(r12Keys.length);
  for (let i = 0; i < r12Keys.length; i++) {
    const k = r12Keys[i];
    if (staticMode && TEMPORAL_RETINAL_CHANNELS.has(k)) {
      // Static mode: this channel is unavailable, not zero-observed
      t0R12[i] = NaN;
    } else {
      t0R12[i] = R12[k] ?? 0;
    }
  }

  // Opponent-map summary — sample means over Y, RG, BY (representative field stats)
  let sumY = 0, sumRG = 0, sumBY = 0, N = 0;
  if (opp) {
    N = Math.floor(opp.length / 3);
    for (let i = 0; i < N; i++) {
      sumY += opp[i * 3];
      sumRG += opp[i * 3 + 1];
      sumBY += opp[i * 3 + 2];
    }
  }
  const t0Opp = new Float32Array([N > 0 ? sumY / N : 0, N > 0 ? sumRG / N : 0, N > 0 ? sumBY / N : 0]);

  // Per-stream T0: each stream's own source, no shared NaN pollution.
  // Parvo reads sustained retinal channels + opponent RG.
  // Konio reads opponent BY.
  // Magno reads temporal retinal channels (unavailable in static).
  const t0Parvo = new Float32Array([
    R12.onSustained ?? 0, R12.offSustained ?? 0, R12.localEdge ?? 0, R12.uniformity ?? 0,
    t0Opp[1],   // opponent-RG mean
  ]);
  // Konio T0 needs multiple dims so L2n doesn't collapse to 1-D unit-norm degeneracy.
  // BY mean + BY variance + BY range: three chromatic BY statistics.
  let byMin = Infinity, byMax = -Infinity, byVar = 0;
  if (opp) {
    const byN = Math.floor(opp.length / 3);
    let byMean = 0;
    for (let i = 0; i < byN; i++) byMean += opp[i * 3 + 2];
    byMean /= byN;
    for (let i = 0; i < byN; i++) {
      const v = opp[i * 3 + 2];
      if (v < byMin) byMin = v;
      if (v > byMax) byMax = v;
      byVar += (v - byMean) ** 2;
    }
    byVar /= byN;
  } else {
    byMin = 0; byMax = 0;
  }
  const t0Konio = new Float32Array([
    t0Opp[2],           // opponent-BY mean
    Math.sqrt(byVar),   // BY std
    byMax - byMin,      // BY range
  ]);
  // Magno T0 in static mode: still an anchor for repeatability, but marked as
  // unavailable-source. Use retinal-12 sustained + opponent-Y stats so it isn't NaN.
  const t0Magno = new Float32Array([
    R12.onSustained ?? 0, R12.offSustained ?? 0, t0Opp[0],   // opponent-Y mean
  ]);

  // Per-stream levels
  const parvoKeys = ["form_color", "sustained_form", "spatial_sharpness", "rg_energy", "rg_range"];
  const magnoKeys = ["motion_broadband", "transient_energy", "direction_energy", "temporal_sharpness", "sustained_ds"];
  const konioKeys = ["by_energy", "blob_hue", "by_range"];

  const parvoVec = new Float32Array(parvoKeys.map(k => lgn.parvo?.[k] ?? 0));
  const magnoVec = new Float32Array(magnoKeys.map(k => lgn.magno?.[k] ?? 0));
  const konioVec = new Float32Array(konioKeys.map(k => lgn.konio?.[k] ?? 0));

  // T3 aggregate = per-stream slots in LGN flat 12
  const flat = lgn.flat ?? {};
  const parvoFlat = new Float32Array([
    flat.parvo_form_color ?? 0, flat.parvo_sustained_form ?? 0,
    flat.parvo_spatial_sharpness ?? 0, flat.parvo_rg_energy ?? 0,
  ]);
  const magnoFlat = new Float32Array([
    flat.magno_motion_broadband ?? 0, flat.magno_transient_energy ?? 0,
    flat.magno_direction_energy ?? 0, flat.magno_temporal_sharpness ?? 0,
    flat.magno_sustained_ds ?? 0,
  ]);
  const konioFlat = new Float32Array([
    flat.konio_by_energy ?? 0, flat.konio_blob_hue ?? 0,
  ]);

  // Magno is TEMPORAL. In static mode, mark UNAVAILABLE — do NOT emit its zero-valued vectors as measured signal.
  const magnoLane = staticMode
    ? {
        T0: t0Magno,   // T0 anchor for repeatability
        T1: null, T2: null, T3: null,
        availability: "TEMPORAL_INPUT_UNAVAILABLE",
        valid: false,
        confidence: 0,
      }
    : { T0: t0Magno, T1: magnoVec, T2: magnoVec, T3: magnoFlat, availability: "TEMPORAL_AVAILABLE", valid: true };

  return {
    lgn_parvo: { T0: t0Parvo, T1: parvoVec, T2: parvoVec, T3: parvoFlat, availability: "SPATIAL_AVAILABLE", valid: true },
    lgn_magno: magnoLane,
    lgn_konio: { T0: t0Konio, T1: konioVec, T2: konioVec, T3: konioFlat, availability: "SPATIAL_AVAILABLE", valid: true, specialization: "CHROMATIC_BLUE_YELLOW" },
  };
}

// ---- IT-80 contribution trace ----
// T0 source     — the 8 raw input blocks concatenated (pre-L2-norm)
// T1 local      — the 8 blocks after per-block L2-normalization
// T2 pooled     — final IT-80 vector (80-D)
// T3 aggregate  — same as T2 (IT-80 IS the aggregate)
//
// Also emits per-block T0/T1/T2 sub-lanes so we can diagnose which block collapses at IT.

export function it80Levels(canonical) {
  const itVec = canonical.it_vector;
  if (!itVec || itVec.length !== 80) {
    return {
      it80: {
        T0: new Float32Array(80), T1: new Float32Array(80),
        T2: new Float32Array(80), T3: new Float32Array(80),
      },
      it80_blocks: {},
    };
  }

  // T2/T3: the final IT-80
  const T2 = new Float32Array(itVec);
  const T3 = T2;

  // T0/T1: reconstruct by taking IT-80 sub-slices per block.
  // T0 is what we'd have BEFORE per-block L2-norm — we don't have the raw pre-norm
  // stored, but we can measure block magnitudes as proxy diagnostic.
  // For now, T0 == T1 == T2 sliced per block (post-norm). Same for full T0.
  const T0 = new Float32Array(itVec);
  const T1 = new Float32Array(itVec);

  // Per-block sub-lanes
  const blocks = {};
  for (const b of IT_BLOCKS) {
    const slice = new Float32Array(b.end - b.start);
    for (let i = b.start; i < b.end; i++) slice[i - b.start] = itVec[i];
    blocks[`it80_${b.name}`] = { T0: slice, T1: slice, T2: slice, T3: slice, blockRange: [b.start, b.end] };
  }

  return { it80: { T0, T1, T2, T3 }, it80_blocks: blocks };
}

// Convenience: run captureCanonicalPhoton and extract LGN + IT-80 taps together
export function pipelineTapsForImage(rgb) {
  const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
  const lgn = lgnStreamsLevels(can);
  const it = it80Levels(can);
  return {
    canonical: can,
    ...lgn,
    it_80: it.it80,
    ...it.it80_blocks,
  };
}
