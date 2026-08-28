// v1-orientation.mjs — V1 simple-cell orientation columns.
//
// V1 (primary visual cortex) is dominated by orientation-selective cells
// organized in columns — every ~0.5 mm² of V1 cycles through all orientations.
// Hubel & Wiesel (1962) discovered these cells; every subsequent visual model
// starts here.
//
// We use a fixed Gabor filter bank — the standard mathematical model of a
// V1 simple cell. Zero learned parameters: Gabor is closed-form.
//
//   ORIENTATIONS: 8 (0°, 22.5°, 45°, 67.5°, 90°, 112.5°, 135°, 157.5°)
//   SCALES:       3 (fine, mid, coarse)
//   → 24 orientation-scale channels per pixel.
//
// Per-region, we emit mean absolute response per (orientation, scale) so
// downstream V2 can integrate contours.
//
// Gabor kernel: g(x,y) = exp(-(x'² + γ²y'²)/(2σ²)) · cos(2π x'/λ)
//   x' =  x cos θ + y sin θ
//   y' = -x sin θ + y cos θ

const ORIENTATIONS = 8;
const SCALES = [
  { sigma: 1.5, lambda: 3.0, size: 5 },
  { sigma: 3.0, lambda: 6.0, size: 9 },
  { sigma: 6.0, lambda: 12.0, size: 17 },
];
const GAMMA = 0.5;  // aspect ratio

// Precompute all Gabor kernels — one per (orientation, scale)
function buildKernel(sigma, lambda, size, theta) {
  const K = new Float32Array(size * size);
  const half = (size - 1) / 2;
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const sigma2 = sigma * sigma;
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - half, dy = y - half;
      const xp = dx * cosT + dy * sinT;
      const yp = -dx * sinT + dy * cosT;
      const env = Math.exp(-(xp * xp + GAMMA * GAMMA * yp * yp) / (2 * sigma2));
      const wave = Math.cos(2 * Math.PI * xp / lambda);
      K[y * size + x] = env * wave;
      sum += K[y * size + x];
    }
  }
  // Zero-mean the kernel (V1 simple cells are contrast-only, not DC)
  const mean = sum / (size * size);
  for (let i = 0; i < K.length; i++) K[i] -= mean;
  return K;
}

const BANK = [];
for (let s = 0; s < SCALES.length; s++) {
  for (let o = 0; o < ORIENTATIONS; o++) {
    const theta = (o * Math.PI) / ORIENTATIONS;
    BANK.push({
      scale: s,
      orientation: o,
      theta,
      kernel: buildKernel(SCALES[s].sigma, SCALES[s].lambda, SCALES[s].size, theta),
      size: SCALES[s].size,
    });
  }
}

function conv2d(L, W, H, kernel, ksize) {
  const half = (ksize - 1) / 2;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let ky = 0; ky < ksize; ky++) {
        const sy = Math.max(0, Math.min(H - 1, y + ky - half));
        for (let kx = 0; kx < ksize; kx++) {
          const sx = Math.max(0, Math.min(W - 1, x + kx - half));
          acc += L[sy * W + sx] * kernel[ky * ksize + kx];
        }
      }
      out[y * W + x] = Math.abs(acc);   // rectified
    }
  }
  return out;
}

/**
 * v1Response(L, W, H) — full V1 orientation-scale response.
 * Returns 24 response fields + region-mean scalar summary.
 */
export function v1Response(L, W, H) {
  const fields = [];
  const summary = {};
  for (let i = 0; i < BANK.length; i++) {
    const f = conv2d(L, W, H, BANK[i].kernel, BANK[i].size);
    fields.push({ scale: BANK[i].scale, orientation: BANK[i].orientation, field: f });
    let sum = 0;
    for (let j = 0; j < f.length; j++) sum += f[j];
    summary[`v1_s${BANK[i].scale}_o${BANK[i].orientation}`] = sum / f.length;
  }
  return { fields, summary, W, H };
}

/**
 * Compact 24-D V1 signature: mean response per (orientation, scale).
 * Suitable to concat into ILC-signature or feed to V2.
 */
export function v1Signature(v1) {
  const vec = new Float32Array(BANK.length);
  for (let i = 0; i < BANK.length; i++) {
    vec[i] = v1.summary[`v1_s${BANK[i].scale}_o${BANK[i].orientation}`];
  }
  return vec;
}
