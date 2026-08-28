// 07-VISUAL/structural/axes/spatial-frequency-axis.mjs
//
// Spatial-frequency signature — closes the sub-pixel structure gap the
// emitter/reflector experiment named as future work.
//
// Physical basis: repeating spatial patterns (LCD RGB triad grid, printed
// halftone dots, paper fiber, natural surface texture) produce characteristic
// peaks in the 2D FFT magnitude spectrum. Real natural surfaces have broad
// 1/f-like spectra with no dominant peaks; artificial grids have sharp
// peaks at their period.
//
// Signature returned per region:
//   - dominant_freq_mag: peak magnitude in the mid-high band (excludes DC)
//   - peak_location_x, peak_location_y: which frequency dominates (in cycles/pixel)
//   - band_energy_low / mid / high: energy per band
//   - grid_score: heuristic 0..1 — "does this look like a repeating grid?"
//   - spectrum_flatness: geometric_mean / arithmetic_mean of |F| (real
//     surfaces are flatter; grids are peakier)
//
// Small radix-2 FFT for power-of-two block sizes. If region isn't power-of-2,
// nearest-crop is used. Bun-native, zero-param, deterministic.

/**
 * In-place complex 1D FFT (Cooley-Tukey radix-2).
 * Input: interleaved real,imag arrays of length N (must be power of 2).
 */
function fft1D(re, im) {
  const N = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterflies
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const iA = i + k, iB = i + k + half;
        const tRe = cRe * re[iB] - cIm * im[iB];
        const tIm = cRe * im[iB] + cIm * re[iB];
        re[iB] = re[iA] - tRe;
        im[iB] = im[iA] - tIm;
        re[iA] += tRe;
        im[iA] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        const nIm = cRe * wIm + cIm * wRe;
        cRe = nRe; cIm = nIm;
      }
    }
  }
}

/**
 * 2D FFT via separable 1D FFTs. Input: real luminance NxN (N power of 2).
 * Returns magnitude spectrum shifted so DC is at (N/2, N/2).
 */
function fft2DMagnitudeShifted(L, N) {
  // Copy into complex plane
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) re[i] = L[i];
  // Row FFTs
  const rowRe = new Float32Array(N), rowIm = new Float32Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { rowRe[x] = re[y * N + x]; rowIm[x] = im[y * N + x]; }
    fft1D(rowRe, rowIm);
    for (let x = 0; x < N; x++) { re[y * N + x] = rowRe[x]; im[y * N + x] = rowIm[x]; }
  }
  // Column FFTs
  const colRe = new Float32Array(N), colIm = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { colRe[y] = re[y * N + x]; colIm[y] = im[y * N + x]; }
    fft1D(colRe, colIm);
    for (let y = 0; y < N; y++) { re[y * N + x] = colRe[y]; im[y * N + x] = colIm[y]; }
  }
  // Magnitude + fftshift
  const mag = new Float32Array(N * N);
  const half = N >> 1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sy = (y + half) % N, sx = (x + half) % N;
      const i = y * N + x, j = sy * N + sx;
      mag[j] = Math.hypot(re[i], im[i]);
    }
  }
  return mag;
}

/**
 * Nearest power-of-two ≤ n.
 */
function pow2Floor(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Compute the spatial-frequency signature for a region.
 *
 * @param {Float32Array} L  luminance in [0,1], w*h
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number,number]} region
 * @returns {{
 *   grid_score, spectrum_flatness,
 *   band_energy: {low, mid, high},
 *   dominant_freq_mag, peak_cycles_per_px_x, peak_cycles_per_px_y,
 *   N_used
 * }}
 */
export function spatialFrequencySummaryForRegion(L, width, height, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(width, x0 + rw), y1 = Math.min(height, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rawW = x1 - xs, rawH = y1 - ys;
  const N = Math.min(pow2Floor(rawW), pow2Floor(rawH), 128);   // cap at 128×128 for cost
  if (N < 8) {
    return { grid_score: 0, spectrum_flatness: 1, band_energy: { low: 0, mid: 0, high: 0 }, dominant_freq_mag: 0, peak_cycles_per_px_x: 0, peak_cycles_per_px_y: 0, N_used: N };
  }
  // Crop central NxN sub-region
  const sX = xs + Math.floor((rawW - N) / 2);
  const sY = ys + Math.floor((rawH - N) / 2);
  const sub = new Float32Array(N * N);
  // Subtract region mean (removes DC dominance) and apply Hann window
  let sum = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      sum += L[(sY + y) * width + (sX + x)];
  const mean = sum / (N * N);
  for (let y = 0; y < N; y++) {
    const wy = 0.5 * (1 - Math.cos(2 * Math.PI * y / (N - 1)));
    for (let x = 0; x < N; x++) {
      const wx = 0.5 * (1 - Math.cos(2 * Math.PI * x / (N - 1)));
      sub[y * N + x] = (L[(sY + y) * width + (sX + x)] - mean) * wx * wy;
    }
  }
  const mag = fft2DMagnitudeShifted(sub, N);

  // Suppress DC neighborhood (already zero-mean, but window bleeds)
  const half = N >> 1;
  const dcRadius = 2;
  for (let y = half - dcRadius; y <= half + dcRadius; y++) {
    for (let x = half - dcRadius; x <= half + dcRadius; x++) {
      if (y >= 0 && y < N && x >= 0 && x < N) mag[y * N + x] = 0;
    }
  }

  // Band energy — three concentric annuli around DC in shifted spectrum
  let lowE = 0, midE = 0, highE = 0;
  let peakM = 0, peakX = 0, peakY = 0;
  const rMax = half;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dy = y - half, dx = x - half;
      const r = Math.hypot(dx, dy);
      const m = mag[y * N + x];
      if (r < rMax * 0.25) lowE += m * m;
      else if (r < rMax * 0.6) midE += m * m;
      else if (r < rMax) highE += m * m;
      if (m > peakM) { peakM = m; peakX = dx; peakY = dy; }
    }
  }
  const totalE = lowE + midE + highE || 1;

  // Spectrum flatness = geometric_mean / arithmetic_mean of nonzero |F|
  let logSum = 0, arithSum = 0, count = 0;
  for (let i = 0; i < N * N; i++) {
    if (mag[i] > 1e-12) {
      logSum += Math.log(mag[i]);
      arithSum += mag[i];
      count++;
    }
  }
  const flatness = count ? Math.exp(logSum / count) / (arithSum / count) : 1;

  // Grid score — heuristic 0..1. High when there's a strong single peak in mid/high band
  // and the spectrum is NOT flat.
  const peakRatio = peakM / Math.sqrt(totalE / count || 1);
  const spikiness = 1 - flatness;
  const grid_score = Math.max(0, Math.min(1, (peakRatio - 5) / 20 * spikiness * 4));

  return {
    grid_score,
    spectrum_flatness: flatness,
    band_energy: { low: lowE / totalE, mid: midE / totalE, high: highE / totalE },
    dominant_freq_mag: peakM / (arithSum / count || 1),
    peak_cycles_per_px_x: peakX / N,
    peak_cycles_per_px_y: peakY / N,
    N_used: N,
  };
}

/**
 * Distance between two spatial-frequency signatures.
 */
export function spatialFrequencyDistance(a, b) {
  if (!a || !b) return Infinity;
  let s = 0;
  s += (a.grid_score - b.grid_score) ** 2 * 2;
  s += (a.spectrum_flatness - b.spectrum_flatness) ** 2 * 2;
  s += (a.band_energy.low - b.band_energy.low) ** 2;
  s += (a.band_energy.mid - b.band_energy.mid) ** 2;
  s += (a.band_energy.high - b.band_energy.high) ** 2;
  s += (a.dominant_freq_mag - b.dominant_freq_mag) ** 2 * 0.5;
  return Math.sqrt(s);
}
