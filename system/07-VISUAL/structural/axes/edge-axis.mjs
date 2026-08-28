// 07-VISUAL/structural/axes/edge-axis.mjs
//
// Edge magnitude channel. Sobel |∇L| gives boundary energy per pixel.
// One of the 4 new axes the perfect-eyes brief called for. Discriminates
// same-material objects with different silhouettes (mug vs plate, apple
// vs orange) that pure color can't tell apart.
//
// Returns:
//   fullField    — Float32Array w*h in [0,1] (normalized to max)
//   meanEnergy   — mean edge energy (scalar summary)
//   orientationHistogram — 8-bin orientation histogram of gradient direction
//                          for the region (or global if no region given)

function sobel(L, w, h) {
  const N = w * h;
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1]
             +  L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
      gy[i] = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1]
             +  L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
    }
  }
  return { gx, gy };
}

export function edgeField(L, w, h) {
  const { gx, gy } = sobel(L, w, h);
  const N = w * h;
  const mag = new Float32Array(N);
  let mx = 0;
  for (let i = 0; i < N; i++) {
    mag[i] = Math.hypot(gx[i], gy[i]);
    if (mag[i] > mx) mx = mag[i];
  }
  if (mx > 0) for (let i = 0; i < N; i++) mag[i] /= mx;
  return { mag, gx, gy };
}

export function edgeSummaryForRegion(L, w, h, region) {
  const { gx, gy, mag } = edgeField(L, w, h);
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const BINS = 8;
  const hist = new Float32Array(BINS);
  let sum = 0, count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m > 0.05) {
        const theta = Math.atan2(gy[i], gx[i]);          // [-π, π]
        const norm = (theta + Math.PI) / (2 * Math.PI);   // [0, 1]
        const bin = Math.min(BINS - 1, Math.floor(norm * BINS));
        hist[bin] += m;
      }
      sum += m;
      count++;
    }
  }
  const meanEnergy = count ? sum / count : 0;
  const histSum = hist.reduce((a, b) => a + b, 0) || 1;
  const histNorm = Array.from(hist, (v) => v / histSum);
  const entropy = histNorm.reduce((a, p) => a + (p > 0 ? -p * Math.log2(p) : 0), 0);
  return { meanEnergy, orientationHistogram: histNorm, orientationEntropy: entropy };
}
