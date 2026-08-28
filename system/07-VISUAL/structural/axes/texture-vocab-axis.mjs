// 07-VISUAL/structural/axes/texture-vocab-axis.mjs
//
// TEXTURE VOCABULARY SIGNATURE — bag-of-visual-words from orientation-histogram
// cell codes (retinal-transform.mjs::textureVocabularyFull).
//
// Each 8×8 cell of the image gets a base64 signature of its 8-bin orientation
// histogram. Cells with the same signature share a code. The FREQUENCY
// DISTRIBUTION of codes over the region is a rotation/pose-invariant texture
// fingerprint:
//
//   - Cat fur: broad low-code distribution (many cells look similar-random)
//   - Clock numbers: sharp high-code distribution (specific text patterns)
//   - Strawberry seed field: multi-modal (seed cells + flesh cells)
//   - Tomato skin: near-uniform (few code varieties, high frequency each)
//
// Summary: 8 scalars — vocab_size, entropy, top-1/2/3/4/5 code frequencies,
// dominant_code_ratio (top1/total).
//
// Zero learned parameters. Deterministic. Bun-native.

import { textureVocabularyFull } from "../retinal-transform.mjs";

function extractRegionL(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rw = x1 - xs, rh = y1 - ys;
  if (rw < 8 || rh < 8) return null;
  const L = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = (ys + y) * width + (xs + x);
    L[y * rw + x] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  }
  return { L, w: rw, h: rh };
}

export function textureVocabSummary(R, G, B, width, height, region) {
  const roi = extractRegionL(R, G, B, width, height, region);
  if (!roi) return { tv_vocab_size: 0, tv_entropy: 0, tv_top1: 0, tv_top2: 0, tv_top3: 0, tv_top4: 0, tv_top5: 0, tv_dominant_ratio: 0 };
  try {
    const result = textureVocabularyFull(roi.L, roi.w, roi.h);
    const freqs = (result.vocabulary || []).map(v => v.frequency ?? 0).filter(f => f > 0);
    if (!freqs.length) return { tv_vocab_size: 0, tv_entropy: 0, tv_top1: 0, tv_top2: 0, tv_top3: 0, tv_top4: 0, tv_top5: 0, tv_dominant_ratio: 0 };
    freqs.sort((a, b) => b - a);
    const total = freqs.reduce((a, b) => a + b, 0);
    // Normalized entropy of code distribution
    let entropy = 0;
    for (const f of freqs) {
      const p = f / total;
      if (p > 0) entropy -= p * Math.log(p);
    }
    return {
      tv_vocab_size: freqs.length,
      tv_entropy: entropy,
      tv_top1: (freqs[0] ?? 0) / total,
      tv_top2: (freqs[1] ?? 0) / total,
      tv_top3: (freqs[2] ?? 0) / total,
      tv_top4: (freqs[3] ?? 0) / total,
      tv_top5: (freqs[4] ?? 0) / total,
      tv_dominant_ratio: (freqs[0] ?? 0) / total,
    };
  } catch (e) {
    return { tv_vocab_size: 0, tv_entropy: 0, tv_top1: 0, tv_top2: 0, tv_top3: 0, tv_top4: 0, tv_top5: 0, tv_dominant_ratio: 0 };
  }
}
