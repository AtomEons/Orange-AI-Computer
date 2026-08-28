// 07-VISUAL/structural/photoreceptor-adapt-frame.mjs
//
// PHOTORECEPTOR-ADAPTED FRAME — apply Naka-Rushton compression to a full
// RGB frame so downstream signature extraction is lighting-invariant.
//
// The retina uses:  R(L) = L^n / (L^n + K^n)
// where K = current adaptation set-point (roughly local mean luminance).
//
// If we apply this per-channel independently, chromaticity of neutral
// (gray) surfaces gets preserved (each channel adapts symmetrically) but
// COLORED surfaces get their hue slightly compressed by adaptation. That's
// the same thing a human eye does — a bright orange looks the same in
// dim and bright light because BOTH the R channel AND the G channel adapt.
//
// This is single-frame mode (no temporal adaptation trajectory). The
// state's K starts at the frame's mean luminance PER CHANNEL, then a
// single compression step applied. Good approximation of steady-state.

import { initAdaptationState, photoreceptorResponse } from "./photoreceptor.mjs";

/**
 * Apply photoreceptor adaptation to an RGB frame. Returns a new frame
 * object { R, G, B, width, height } with adapted channels.
 *
 * @param {object} frame  {R, G, B, width, height}
 * @returns {object}      {R, G, B, width, height, adaptation_meta}
 */
export function photoreceptorAdaptFrame(frame) {
  const stateR = initAdaptationState();
  const stateG = initAdaptationState();
  const stateB = initAdaptationState();
  // Single-frame mode: pass tsMs=0 so K jumps to meanL immediately.
  // Better: pass small tsMs to nudge state gradually. Use null for pure steady-state.
  const respR = photoreceptorResponse(frame.R, stateR, null);
  const respG = photoreceptorResponse(frame.G, stateG, null);
  const respB = photoreceptorResponse(frame.B, stateB, null);
  // Because dt=0, K stays at initial value K0=0.18 (mid-gray).
  // For proper adaptation, we need K to reflect the SCENE mean.
  // Manually run one adaptation step by setting K to mean-luminance then re-computing.
  const meanR = mean(frame.R);
  const meanG = mean(frame.G);
  const meanB = mean(frame.B);
  // Naka-Rushton at K = scene mean gives ~0.5 response at scene mean.
  const R2 = applyNakaRushton(frame.R, meanR);
  const G2 = applyNakaRushton(frame.G, meanG);
  const B2 = applyNakaRushton(frame.B, meanB);
  return {
    R: R2, G: G2, B: B2,
    width: frame.width, height: frame.height,
    adaptation_meta: { meanR, meanG, meanB },
  };
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function applyNakaRushton(channel, K, n = 0.75) {
  const N = channel.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const L = channel[i];
    if (L <= 0) { out[i] = 0; continue; }
    const Ln = Math.pow(L, n);
    const Kn = Math.pow(K, n);
    out[i] = Ln / (Ln + Kn);
  }
  return out;
}
