// axis-bundle.mjs — the FULL WIRE-BACK.
//
// Operator directive 2026-07-09: "FULL WIRE BACKKKKKKKK WIRE HANGERS YES."
//
// Every axis module in axes/ ran on the linearized, illuminant-corrected
// region — one function call → 15+ axis summaries fused into the canonical
// output. Nothing thrown away. Every photon feature the earlier waves built
// is back in the capture path.
//
// Called from captureCanonicalPhoton on the linRegion (post gamma/wb/exposure,
// pre-illuminant-divide). Individual axes that need illuminant-invariance
// (radial-photon, color-ratio, dichromatic) compute their own.
//
// Multi-frame axes (temporal-spectrum, retinal-12 with proper temporal state)
// are wired separately in captureCanonicalPhotonSequence.

import { radialPhotonSummary } from "./axes/radial-photon-axis.mjs";
import { photonHistogramSummary } from "./axes/photon-histogram-axis.mjs";
import { photonCorrelationsForRegion } from "./axes/photon-correlation-axis.mjs";
import { subsurfaceSummaryForRegion } from "./axes/subsurface-axis.mjs";
import { spatialColorSummaryForRegion } from "./axes/spatial-color-axis.mjs";
import { colorRatioSummaryForRegion } from "./axes/color-ratio-axis.mjs";
import { textureVocabSummary } from "./axes/texture-vocab-axis.mjs";
import { huMomentsForRegion } from "./axes/hu-moments-axis.mjs";
import { persistentHomologySummary } from "./axes/persistent-homology-axis.mjs";
import { dichromaticSummaryForRegion } from "./axes/dichromatic-axis.mjs";
import { fourierMellinSummaryForRegion } from "./axes/fourier-mellin-axis.mjs";
import { textureSummaryForRegion } from "./axes/texture-axis.mjs";
import { edgeSummaryForRegion } from "./axes/edge-axis.mjs";
import { specularSummaryForRegion } from "./axes/specular-axis.mjs";
import { spatialFrequencySummaryForRegion } from "./axes/spatial-frequency-axis.mjs";

/**
 * Compute luminance channel from R/G/B (linear-light space, per-channel).
 */
function luminanceChannel(R, G, B, W, H) {
  const N = W * H;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  }
  return L;
}

/**
 * bundleAllAxes(R, G, B, W, H, opts) — run every axis module on the region.
 * Region defaults to the whole frame. Returns an object keyed by axis name
 * whose values are the summaries emitted by each module.
 *
 * Contract: every axis is called with try/catch so a single failure never
 * kills the canonical output. Failed axes get { _error: message }.
 */
export function bundleAllAxes(R, G, B, W, H, opts = {}) {
  const region = opts.region || [0, 0, W, H];
  const L = luminanceChannel(R, G, B, W, H);

  const safe = (name, fn) => {
    try {
      const t0 = performance.now();
      const result = fn();
      const t1 = performance.now();
      return { ...result, _ms: t1 - t0 };
    } catch (e) {
      return { _error: e.message };
    }
  };

  return {
    radial_photon:      safe("radial_photon",      () => radialPhotonSummary(R, G, B, W, H, region)),
    photon_histogram:   safe("photon_histogram",   () => photonHistogramSummary(R, G, B, W, H, region)),
    photon_correlation: safe("photon_correlation", () => photonCorrelationsForRegion(R, G, B, W, H, region)),
    subsurface:         safe("subsurface",         () => subsurfaceSummaryForRegion(R, G, B, W, H, region)),
    spatial_color:      safe("spatial_color",      () => spatialColorSummaryForRegion(R, G, B, W, H, region)),
    color_ratio:        safe("color_ratio",        () => colorRatioSummaryForRegion(R, G, B, W, H, region)),
    texture_vocab:      safe("texture_vocab",      () => textureVocabSummary(R, G, B, W, H, region)),
    hu_moments:         safe("hu_moments",         () => huMomentsForRegion(R, G, B, W, H, region)),
    persistent_homology:safe("persistent_homology",() => persistentHomologySummary(R, G, B, W, H, region)),
    dichromatic:        safe("dichromatic",        () => dichromaticSummaryForRegion(R, G, B, W, H, region)),
    fourier_mellin:     safe("fourier_mellin",     () => fourierMellinSummaryForRegion(R, G, B, W, H, region)),
    texture:            safe("texture",            () => textureSummaryForRegion(L, W, H, region)),
    edge:               safe("edge",               () => edgeSummaryForRegion(L, W, H, region)),
    specular:           safe("specular",           () => specularSummaryForRegion(L, W, H, region)),
    spatial_frequency:  safe("spatial_frequency",  () => spatialFrequencySummaryForRegion(L, W, H, region)),
  };
}

/**
 * flattenAxisBundle(bundle) — turn the nested axis outputs into one flat
 * dictionary of {axis_key: scalar_value} suitable for signature construction.
 */
export function flattenAxisBundle(bundle) {
  const out = {};
  for (const [axis, summary] of Object.entries(bundle)) {
    if (!summary || summary._error) continue;
    for (const [k, v] of Object.entries(summary)) {
      if (k.startsWith("_")) continue;
      if (typeof v === "number") out[axis + "__" + k] = v;
    }
  }
  return out;
}

/**
 * Report utility: how many axes emitted non-trivial data.
 */
export function bundleReport(bundle) {
  let ok = 0, failed = 0, scalars = 0;
  const failures = [];
  for (const [name, summary] of Object.entries(bundle)) {
    if (summary._error) {
      failed++;
      failures.push({ axis: name, error: summary._error });
    } else {
      ok++;
      for (const [k, v] of Object.entries(summary)) {
        if (!k.startsWith("_") && typeof v === "number" && Number.isFinite(v)) scalars++;
      }
    }
  }
  return { ok, failed, failures, scalars, totalAxes: ok + failed };
}
