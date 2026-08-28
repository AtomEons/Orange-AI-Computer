// 07-VISUAL/structural/binders/preprocessing.mjs
//
// Preprocessors applied to the photoreceptor-response R before an object
// binder sees it. Each is deterministic, pure JS, Bun-native. Any binder can
// receive a preprocessed R and treat it as its own input.
//
// Failure modes disclosed per-preprocessor in the returned notes[] so the
// sweep can trace WHY a given config over- or under-segmented.

export const PREPROCESSORS = [
  "identity",
  "gaussian_1",
  "gaussian_2",
  "gaussian_3",
  "gaussian_5",
  "median_3",
  "median_5",
  "log_normalize",
  "gamma_04",
  "gamma_25",
];

/**
 * Apply a named preprocessor to R.
 * @returns { R2: Float32Array, notes: string[] }
 */
export function preprocess(name, R, width, height) {
  switch (name) {
    case "identity":       return { R2: R, notes: ["preproc:identity — R passed through unchanged"] };
    case "gaussian_1":     return gaussian(R, width, height, 1);
    case "gaussian_2":     return gaussian(R, width, height, 2);
    case "gaussian_3":     return gaussian(R, width, height, 3);
    case "gaussian_5":     return gaussian(R, width, height, 5);
    case "median_3":       return medianK(R, width, height, 3);
    case "median_5":       return medianK(R, width, height, 5);
    case "log_normalize":  return logNormalize(R);
    case "gamma_04":       return gamma(R, 0.4);
    case "gamma_25":       return gamma(R, 2.5);
    default:               throw new Error(`unknown preprocessor: ${name}`);
  }
}

function medianK(R, w, h, k) {
  const half = (k - 1) >> 1;
  const out = new Float32Array(R.length);
  const buf = new Float32Array(k * k);
  const mid = (k * k - 1) >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          buf[n++] = R[yy * w + xx];
        }
      }
      for (let i = 1; i < k * k; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      out[y * w + x] = buf[mid];
    }
  }
  return { R2: out, notes: [`preproc:median_${k} — edge-preserving denoise with ${k}x${k} kernel`] };
}

function gamma(R, g) {
  const out = new Float32Array(R.length);
  for (let i = 0; i < R.length; i++) out[i] = Math.pow(Math.max(0, Math.min(1, R[i])), g);
  return {
    R2: out,
    notes: [`preproc:gamma γ=${g} — ${g < 1 ? "boosts dim regions (dark detail visible)" : "compresses dim regions (bright emphasized)"}`],
  };
}

// Separable 1D Gaussian, integer sigma, radius = 3*sigma.
function gaussian(R, w, h, sigma) {
  const radius = Math.max(1, sigma * 3);
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let ksum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    ksum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(R.length);
  const out = new Float32Array(R.length);

  // horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        let xk = x + k - radius;
        if (xk < 0) xk = 0;
        if (xk >= w) xk = w - 1;
        acc += R[y * w + xk] * kernel[k];
      }
      tmp[y * w + x] = acc;
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        let yk = y + k - radius;
        if (yk < 0) yk = 0;
        if (yk >= h) yk = h - 1;
        acc += tmp[yk * w + x] * kernel[k];
      }
      out[y * w + x] = acc;
    }
  }
  return { R2: out, notes: [`preproc:gaussian σ=${sigma} — smoothing kills fine texture; small objects (<${sigma * 4}px) risk being erased`] };
}

// 3x3 median filter — edge-preserving denoise.
function median3(R, w, h) {
  const out = new Float32Array(R.length);
  const buf = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          buf[n++] = R[yy * w + xx];
        }
      }
      // partial sort to find median (small n, insertion sort is fine)
      for (let i = 1; i < 9; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      out[y * w + x] = buf[4];
    }
  }
  return { R2: out, notes: ["preproc:median_3 — edge-preserving denoise; kills salt-and-pepper but doesn't smooth texture blocks"] };
}

// Log-normalize: log(R+ε) then rescale to [0,1]. Equalizes dynamic range.
function logNormalize(R) {
  const eps = 1e-3;
  const N = R.length;
  const tmp = new Float32Array(N);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = Math.log(R[i] + eps);
    tmp[i] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn || 1;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = (tmp[i] - mn) / range;
  return { R2: out, notes: ["preproc:log_normalize — dynamic range compressed; bright regions attenuated, dim regions boosted"] };
}
