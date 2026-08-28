// fourier-mellin-axis.mjs — FABLE MOVE 7a: rotation+scale-invariant shape.
//
// Classic Fourier-Mellin: log-polar resample the region's luminance about
// its centroid, then take the 2-D FFT magnitude. Rotation becomes a circular
// shift along the angle axis; scale becomes a shift along the log-radius
// axis; the FFT magnitude kills both shifts exactly. The low-frequency block
// of |FFT| is the descriptor — strictly stronger than Hu moments (7 numbers,
// noise-fragile in h5-h7) while remaining zero-parameter and deterministic.
//
// Grid: 32 angles × 32 log-radius bins. Descriptor: the 6×6 low-frequency
// magnitude block (36 dims), L1-normalized so overall contrast cancels.
//
// OPT-IN: not wired into flattenSignature until the invariance ledger says
// which shape family wins (schema discipline).

const NA = 32;   // angular bins
const NR = 32;   // log-radius bins
const BLOCK = 6; // low-frequency block edge

// Radix-2 iterative FFT (in-place, complex interleaved re/im arrays).
function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("fft length must be power of 2");
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// 2-D FFT magnitude of an NA×NR real grid (rows = angle, cols = log-radius).
function fft2mag(grid) {
  // Row FFTs
  const rowsRe = [], rowsIm = [];
  for (let a = 0; a < NA; a++) {
    const re = new Float64Array(NR), im = new Float64Array(NR);
    for (let r = 0; r < NR; r++) re[r] = grid[a * NR + r];
    fft(re, im);
    rowsRe.push(re); rowsIm.push(im);
  }
  // Column FFTs
  const mag = new Float64Array(NA * NR);
  const colRe = new Float64Array(NA), colIm = new Float64Array(NA);
  for (let r = 0; r < NR; r++) {
    for (let a = 0; a < NA; a++) { colRe[a] = rowsRe[a][r]; colIm[a] = rowsIm[a][r]; }
    fft(colRe, colIm);
    for (let a = 0; a < NA; a++) mag[a * NR + r] = Math.hypot(colRe[a], colIm[a]);
  }
  return mag;
}

/**
 * Fourier-Mellin descriptor for a region.
 * @returns { fm_0 .. fm_35 } — 36 L1-normalized low-frequency magnitudes,
 *          plus fm_energy (log total spectral energy, scale-ish cue kept
 *          separate so the invariant block stays invariant).
 */
export function fourierMellinSummaryForRegion(R, G, B, W, H, region) {
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(W, Math.ceil(rx + rw)), y1 = Math.min(H, Math.ceil(ry + rh));
  if (x1 - x0 < 8 || y1 - y0 < 8) return emptyFM();

  // Luminance + intensity centroid
  let cx = 0, cy = 0, mass = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const L = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      cx += x * L; cy += y * L; mass += L;
    }
  }
  if (mass < 1e-6) return emptyFM();
  cx /= mass; cy /= mass;

  const maxR = Math.max(4, Math.min(Math.min(cx - x0, x1 - cx), Math.min(cy - y0, y1 - cy)));
  const logMin = Math.log(1);
  const logMax = Math.log(maxR);

  // Log-polar resample (nearest neighbor is fine at 32×32)
  const grid = new Float64Array(NA * NR);
  for (let a = 0; a < NA; a++) {
    const theta = (a / NA) * 2 * Math.PI;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    for (let r = 0; r < NR; r++) {
      const rad = Math.exp(logMin + (r / (NR - 1)) * (logMax - logMin));
      const x = Math.round(cx + rad * cosT);
      const y = Math.round(cy + rad * sinT);
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        const i = y * W + x;
        grid[a * NR + r] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      }
    }
  }
  // Remove DC (mean) so the descriptor reflects structure, not brightness
  let mean = 0;
  for (let i = 0; i < grid.length; i++) mean += grid[i];
  mean /= grid.length;
  for (let i = 0; i < grid.length; i++) grid[i] -= mean;

  const mag = fft2mag(grid);
  // Low-frequency block (skip pure DC at [0,0])
  const out = {};
  const block = [];
  for (let a = 0; a < BLOCK; a++) {
    for (let r = 0; r < BLOCK; r++) {
      if (a === 0 && r === 0) { block.push(0); continue; }
      block.push(mag[a * NR + r]);
    }
  }
  const sum = block.reduce((s, x) => s + x, 0) || 1;
  for (let i = 0; i < block.length; i++) out["fm_" + i] = block[i] / sum;
  let energy = 0;
  for (let i = 0; i < mag.length; i++) energy += mag[i] * mag[i];
  out.fm_energy = Math.log(energy + 1);
  return out;
}

function emptyFM() {
  const out = {};
  for (let i = 0; i < BLOCK * BLOCK; i++) out["fm_" + i] = 0;
  out.fm_energy = 0;
  return out;
}
