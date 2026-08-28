// ilc-signature.mjs — Invariant Light Code signature.
//
// AEyes¹ Research Grade Part 1: peak-fidelity photon pattern recognition.
// The ILC signature compresses a canonical photon capture into a 160-dim
// vector that is invariant to:
//   - rotation (radial averaging around canonical centroid)
//   - brightness/gain (normalized histograms)
//   - contrast (normalized gradient histogram)
//   - illumination color (built on canonical which already illuminant-corrected)
//
// Same object under sun / candle / moon / CRT / neon → same signature.
//
// Storage cost: 160 floats × 4 bytes = 640 bytes per pattern.
// vs raw canonical (256×256×4 float32 = 1MB).
// 1600× compression, mission-critical for the Pattern Engine substrate.

import { CANON_W, CANON_H } from "./photon-canonical.mjs";

// AWE-2.0: color-aware ILC. Whole-scene grayscale signatures collapsed
// distinct fixtures to the same node (baboon/apple/basketball indistinguishable
// in luminance-only space). Adding opponent-color radial profiles preserves
// the chromatic identity that lets apple ≠ orange ≠ baboon ≠ building.
export const RAD_BINS = 32;            // luminance radial profile
export const RAD_RG_BINS = 32;         // red-green opponent radial profile
export const RAD_BY_BINS = 32;         // blue-yellow opponent radial profile
export const HIST_BINS = 32;           // luminance histogram
export const HIST_RG_BINS = 16;        // RG histogram
export const HIST_BY_BINS = 16;        // BY histogram
export const GRAD_BINS = 32;           // gradient histogram
export const SIG_LEN = RAD_BINS + RAD_RG_BINS + RAD_BY_BINS + HIST_BINS + HIST_RG_BINS + HIST_BY_BINS + GRAD_BINS; // 192

/**
 * extractILCSignature(canonical) → { data, rProf, lHist, gHist, radE, entropy, gradE }
 *   data:    Float32Array(160), the concatenated invariant signature
 *   rProf:   Float32Array(64), radial luminance profile
 *   lHist:   Float32Array(64), luminance histogram (probability distribution)
 *   gHist:   Float32Array(32), gradient magnitude histogram
 *   radE:    scalar, mean radial energy (first manifold axis)
 *   entropy: scalar, Shannon entropy of luminance histogram (second manifold axis)
 *   gradE:   scalar, mean gradient energy
 */
function rescale(field, N) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = field[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = (mx - mn) || 1;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = ((field[i] - mn) / range) * 255;
  return out;
}

function radialAndHist(vals, W, H, N_RAD, N_HIST) {
  const cx = W / 2, cy = H / 2;
  const maxR = Math.hypot(cx, cy);
  const rSum = new Float32Array(N_RAD);
  const rCnt = new Float32Array(N_RAD);
  const hist = new Float32Array(N_HIST);
  const N = W * H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = vals[i];
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      const rb = Math.min(N_RAD - 1, Math.floor((r / maxR) * N_RAD));
      rSum[rb] += v;
      rCnt[rb]++;
      const hb = Math.min(N_HIST - 1, Math.floor((v / 256) * N_HIST));
      hist[hb]++;
    }
  }
  const prof = new Float32Array(N_RAD);
  for (let i = 0; i < N_RAD; i++) prof[i] = rCnt[i] > 0 ? rSum[i] / rCnt[i] / 255 : 0;
  let hs = 0; for (let i = 0; i < N_HIST; i++) hs += hist[i];
  if (hs > 0) for (let i = 0; i < N_HIST; i++) hist[i] /= hs;
  return { prof, hist };
}

export function extractILCSignature(canonical) {
  const W = CANON_W, H = CANON_H;
  const N = W * H;
  const opp = canonical.opponent_map;

  // Split opponent channels into three fields
  const Y = new Float32Array(N);
  const RG = new Float32Array(N);
  const BY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    Y[i] = opp[i * 3 + 0];
    RG[i] = opp[i * 3 + 1];
    BY[i] = opp[i * 3 + 2];
  }
  // Rescale each channel independently (invariant to amplitude)
  const Yn = rescale(Y, N);
  const RGn = rescale(RG, N);
  const BYn = rescale(BY, N);

  // Radial profiles + histograms per channel
  const yAnal = radialAndHist(Yn, W, H, RAD_BINS, HIST_BINS);
  const rgAnal = radialAndHist(RGn, W, H, RAD_RG_BINS, HIST_RG_BINS);
  const byAnal = radialAndHist(BYn, W, H, RAD_BY_BINS, HIST_BY_BINS);

  // Gradient histogram on luminance
  const gHist = new Float32Array(GRAD_BINS);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const v = Yn[i];
      const gm = Math.hypot(Yn[i + 1] - v, Yn[i + W] - v);
      const gb = Math.min(GRAD_BINS - 1, Math.floor((gm / 180) * GRAD_BINS));
      gHist[gb]++;
    }
  }
  let gs = 0; for (let i = 0; i < GRAD_BINS; i++) gs += gHist[i];
  if (gs > 0) for (let i = 0; i < GRAD_BINS; i++) gHist[i] /= gs;

  // Concatenate blocks, then whole-sig L2 normalize (single normalization pass).
  const sig = new Float32Array(SIG_LEN);
  let off = 0;
  sig.set(yAnal.prof, off);  off += RAD_BINS;
  sig.set(rgAnal.prof, off); off += RAD_RG_BINS;
  sig.set(byAnal.prof, off); off += RAD_BY_BINS;
  sig.set(yAnal.hist, off);  off += HIST_BINS;
  sig.set(rgAnal.hist, off); off += HIST_RG_BINS;
  sig.set(byAnal.hist, off); off += HIST_BY_BINS;
  sig.set(gHist, off);

  let norm = 0;
  for (let i = 0; i < SIG_LEN; i++) norm += sig[i] * sig[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < SIG_LEN; i++) sig[i] /= norm;

  // Manifold projection axes (kept for compat with any 2D viz downstream)
  let radE = 0;
  for (let i = 0; i < RAD_BINS; i++) radE += yAnal.prof[i] * (i / RAD_BINS);
  let entropy = 0;
  for (let i = 0; i < HIST_BINS; i++) if (yAnal.hist[i] > 0) entropy -= yAnal.hist[i] * Math.log2(yAnal.hist[i]);
  let gradE = 0;
  for (let i = 0; i < GRAD_BINS; i++) gradE += gHist[i] * (i / GRAD_BINS);

  return {
    data: sig,
    rProf: yAnal.prof, rgProf: rgAnal.prof, byProf: byAnal.prof,
    lHist: yAnal.hist, rgHist: rgAnal.hist, byHist: byAnal.hist,
    gHist,
    radE, entropy, gradE,
  };
}

/** Cosine similarity (both must be L2-normalized) */
export function ilcCosSim(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
