// 07-VISUAL/structural/build-static-capture.mjs
//
// Freeze gate 5 (GPT doctrine v5, spine seq 115): the audit must consume the record
// and its emitted tap evidence, NOT call axis modules directly.
//
// buildStaticCaptureWithTaps(rgb, meta) is the SOLE ENTRY POINT for a static capture.
// It returns { record, taps }:
//   - record: lean PhotonCaptureRecord v1.0-STATIC with schema + lanes + integrity
//   - taps:   side-channel evidence — T0/T1/T2/T3 typed arrays per lane, hash-linked
//             to record.lanes.<name>.tap_hashes for lineage verification.
//
// Downstream consumers (recognition, memory, Pattern Engine) read the LEAN record.
// Only the audit reads the taps.

import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { buildPhotonCaptureRecord, hashRecord } from "./photon-capture-record.mjs";
import { hashField } from "./axis-tap.mjs";
import { spatialColorSummaryForRegion } from "./axes/spatial-color-axis.mjs";
import { localVariance, lbpCodes, textureSummaryForRegion } from "./axes/texture-axis.mjs";
import { phLevels, pcLevels, crLevels, dcLevels, huLevels } from "./taps/watch-lanes-taps.mjs";
import { lgnStreamsLevels, it80Levels } from "./taps/pipeline-taps.mjs";

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

// ---- Tap-level extractors mirroring the sweep code ----
function scLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i];
    T0[N * 3 + i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  }
  const cellW = w / 3, cellH = h / 3;
  const sumR = new Array(9).fill(0), sumG = new Array(9).fill(0), sumB = new Array(9).fill(0), cnt = new Array(9).fill(0);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      sumR[c] += R[i]; sumG[c] += G[i]; sumB[c] += B[i]; cnt[c]++;
    }
  }
  const T1 = new Float32Array(27);
  for (let c = 0; c < 9; c++) { const n = cnt[c] || 1; T1[c * 3] = sumR[c] / n; T1[c * 3 + 1] = sumG[c] / n; T1[c * 3 + 2] = sumB[c] / n; }
  const pool = spatialColorSummaryForRegion(R, G, B, w, h, [0, 0, w, h]);
  const keys = Object.keys(pool).filter(k => !k.startsWith("_")).sort();
  const T2 = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) T2[i] = pool[keys[i]];
  return { T0, T1, T2, T3: T2 };
}

function txLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  const T0 = L;
  const varField = localVariance(L, w, h, 5);
  const lbp = lbpCodes(L, w, h);
  const cellW = w / 3, cellH = h / 3;
  const cellVarSum = new Array(9).fill(0), cellCount = new Array(9).fill(0);
  const cellHist = Array.from({ length: 9 }, () => new Float32Array(256));
  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      cellVarSum[c] += varField[i]; cellHist[c][lbp[i]]++; cellCount[c]++;
    }
  }
  const T1 = new Float32Array(9 * 257);
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    T1[c * 257] = cellVarSum[c] / n;
    for (let b = 0; b < 256; b++) T1[c * 257 + 1 + b] = cellHist[c][b] / n;
  }
  const pool = textureSummaryForRegion(L, w, h, [0, 0, w, h]);
  const T2 = new Float32Array([pool.textureMeanVariance, pool.lbpEntropy]);
  return { T0, T1, T2, T3: T2 };
}

/**
 * SOLE ENTRY POINT for a static capture with full audit evidence.
 * @param {object} rgb — extractImageRGB output ({R, G, B, width, height})
 * @param {object} meta — captureId, rawRef, pipelineHash, configHash
 * @returns {{ record, taps }}
 *   record: lean PhotonCaptureRecord v1.0-STATIC + integrity hashes
 *   taps: { <laneName>: { T0, T1, T2, T3, availability, hashes: {T0, T1, T2, T3} } }
 */
export function buildStaticCaptureWithTaps(rgb, meta = {}) {
  const region = { x: 0, y: 0, w: rgb.width, h: rgb.height };
  const can = captureCanonicalPhoton(rgb, region);

  // Compute all tap levels
  const axisTaps = {
    spatial_color: scLevels(rgb),
    texture: txLevels(rgb),
    photon_histogram: phLevels(rgb),
    photon_correlation: pcLevels(rgb),
    color_ratio: crLevels(rgb),
    dichromatic: dcLevels(rgb),
    hu_moments: huLevels(rgb),
  };

  const lgnLevels = lgnStreamsLevels(can);
  const itLevels = it80Levels(can);

  const allTaps = {
    ...axisTaps,
    lgn_parvo: lgnLevels.lgn_parvo,
    lgn_magno: lgnLevels.lgn_magno,
    lgn_konio: lgnLevels.lgn_konio,
    it_80: itLevels.it80,
  };

  // Add per-block IT slices
  for (const [key, val] of Object.entries(itLevels.it80_blocks ?? {})) {
    allTaps[key] = val;
  }

  // Attach hashes for lineage
  const tapHashes = {};
  for (const [name, tap] of Object.entries(allTaps)) {
    tapHashes[name] = {
      T0: tap.T0 !== null ? hashField(tap.T0) : null,
      T1: tap.T1 !== null ? hashField(tap.T1) : null,
      T2: tap.T2 !== null ? hashField(tap.T2) : null,
      T3: tap.T3 !== null ? hashField(tap.T3) : null,
      availability: tap.availability ?? "SPATIAL_AVAILABLE",
    };
  }

  // Build the lean record and annotate with tap hashes
  let record = buildPhotonCaptureRecord(can, meta);
  record.tapHashes = tapHashes;
  record = hashRecord(record);

  return { record, taps: allTaps };
}
