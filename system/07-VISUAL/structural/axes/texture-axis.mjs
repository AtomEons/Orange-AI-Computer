// 07-VISUAL/structural/axes/texture-axis.mjs
//
// Texture channel — local variance + LBP-lite frequency features.
// Discriminates surface microstructure: orange peel vs apple skin vs
// basketball leather. All can share color; texture separates them.

export function localVariance(L, w, h, windowSize = 5) {
  const N = w * h;
  const out = new Float32Array(N);
  const half = windowSize >> 1;
  let mx = 0;
  for (let y = half; y < h - half; y++) {
    for (let x = half; x < w - half; x++) {
      let sum = 0, sum2 = 0, count = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const v = L[(y + dy) * w + (x + dx)];
          sum += v; sum2 += v * v; count++;
        }
      }
      const mean = sum / count;
      const varv = Math.max(0, sum2 / count - mean * mean);
      const i = y * w + x;
      out[i] = varv;
      if (varv > mx) mx = varv;
    }
  }
  if (mx > 0) for (let i = 0; i < N; i++) out[i] /= mx;
  return out;
}

// Simple 8-neighbor LBP (Local Binary Pattern) — captures micro-texture
// signatures. Each pixel gets an 8-bit code from comparing 8 neighbors.
export function lbpCodes(L, w, h) {
  const N = w * h;
  const codes = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const c = L[i];
      let code = 0;
      code |= (L[i - w - 1] >= c ? 1 : 0) << 0;
      code |= (L[i - w    ] >= c ? 1 : 0) << 1;
      code |= (L[i - w + 1] >= c ? 1 : 0) << 2;
      code |= (L[i     + 1] >= c ? 1 : 0) << 3;
      code |= (L[i + w + 1] >= c ? 1 : 0) << 4;
      code |= (L[i + w    ] >= c ? 1 : 0) << 5;
      code |= (L[i + w - 1] >= c ? 1 : 0) << 6;
      code |= (L[i     - 1] >= c ? 1 : 0) << 7;
      codes[i] = code;
    }
  }
  return codes;
}

export function textureSummaryForRegion(L, w, h, region) {
  const varField = localVariance(L, w, h, 5);
  const lbp = lbpCodes(L, w, h);
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const hist = new Float32Array(256);
  let sumVar = 0, count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * w + x;
      hist[lbp[i]]++;
      sumVar += varField[i];
      count++;
    }
  }
  if (count) for (let i = 0; i < 256; i++) hist[i] /= count;
  // Compress 256-bin histogram to entropy scalar + top 16 bin activations
  let entropy = 0;
  for (let i = 0; i < 256; i++) if (hist[i] > 0) entropy -= hist[i] * Math.log2(hist[i]);
  // Get the top 16 most active LBP patterns (a coarse fingerprint)
  const sorted = Array.from(hist).map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 16);
  const topCodes = sorted.map(x => x.i);
  return {
    textureMeanVariance: count ? sumVar / count : 0,
    lbpEntropy: entropy,
    lbpTopCodes: topCodes,
  };
}
