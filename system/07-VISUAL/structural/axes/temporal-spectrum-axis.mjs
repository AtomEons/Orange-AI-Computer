// temporal-spectrum-axis.mjs — FABLE MOVE 7b: motion as a photon signature.
//
// A static image throws away information: the photon pattern EVOLVES.
//   Water  → continuous low-frequency drift
//   Fire   → chaotic broadband flicker
//   Animal → periodic gait band
//   Machine/rigid object → DC only
//
// Per region across the frames already extracted for a clip: mean log-
// luminance time series → detrend → DFT magnitude → band energies +
// spectral flatness. A handful of dims that discriminate exactly the
// classes color cannot (fire vs orange cloth; screen flicker vs printed
// photo — pairs with the spatialFreq LCD-grid detector).
//
// Zero parameters. The series is 4-8 samples, so a direct DFT is exact and
// instant. OPT-IN until wired into the video ingest path.

/**
 * @param frames  array of {R, G, B, width, height} — consecutive clip frames
 * @param region  [x, y, w, h] in frame coordinates (same region across frames)
 * @returns {
 *   ts_dc        — mean level (log-luminance)
 *   ts_low       — band energy: lowest non-DC frequency
 *   ts_mid       — band energy: middle frequencies
 *   ts_high      — band energy: highest frequency (Nyquist-ish)
 *   ts_flatness  — spectral flatness of non-DC bins (1 = white/chaotic, 0 = tonal)
 *   ts_total     — total non-DC energy (how much the region CHANGES at all)
 * }
 */
export function temporalSpectrumForRegion(frames, region) {
  const n = frames.length;
  if (n < 3) return { ts_dc: 0, ts_low: 0, ts_mid: 0, ts_high: 0, ts_flatness: 0, ts_total: 0 };
  const [rx, ry, rw, rh] = region;

  // Mean log-luminance per frame over the region (subsampled)
  const series = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const { R, G, B, width: W, height: H } = frames[f];
    const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(W, Math.ceil(rx + rw)), y1 = Math.min(H, Math.ceil(ry + rh));
    let s = 0, c = 0;
    const stepY = Math.max(1, Math.floor((y1 - y0) / 48));
    const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        const i = y * W + x;
        s += Math.log(0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i] + 1e-4);
        c++;
      }
    }
    series[f] = c ? s / c : 0;
  }

  // Detrend (remove linear fit — camera exposure drift is nuisance)
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += series[i]; sxx += i * i; sxy += i * series[i]; }
  const denom = n * sxx - sx * sx || 1;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const det = new Float64Array(n);
  for (let i = 0; i < n; i++) det[i] = series[i] - (intercept + slope * i);

  // Direct DFT magnitude (n is tiny)
  const nBins = Math.floor(n / 2) + 1;
  const mags = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const ang = -2 * Math.PI * k * t / n;
      re += det[t] * Math.cos(ang);
      im += det[t] * Math.sin(ang);
    }
    mags[k] = Math.hypot(re, im);
  }

  // Bands: dc = k0 (≈0 after detrend); low = k1; mid = middle ks; high = last k
  const ts_dc = sy / n;
  const ts_low = nBins > 1 ? mags[1] : 0;
  let ts_mid = 0;
  for (let k = 2; k < nBins - 1; k++) ts_mid += mags[k];
  const ts_high = nBins > 2 ? mags[nBins - 1] : 0;
  let total = 0, logSum = 0, cnt = 0;
  for (let k = 1; k < nBins; k++) {
    total += mags[k] * mags[k];
    logSum += Math.log(mags[k] + 1e-9);
    cnt++;
  }
  const geoMean = Math.exp(logSum / Math.max(1, cnt));
  const ariMean = cnt ? Math.sqrt(total / cnt) : 0;
  const ts_flatness = ariMean > 1e-9 ? geoMean / ariMean : 0;
  return {
    ts_dc,
    ts_low,
    ts_mid,
    ts_high,
    ts_flatness,
    ts_total: Math.log(total + 1e-9),
  };
}
