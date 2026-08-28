// Alpha Wolf Eyes — Synthetic Same-Scene Photon-Identity Proof
// C:/AtomEons/Orange5/07-VISUAL/structural/prove-photon-identity.mjs
//
// Generates:
//   A: orange body (chroma [0.5,0.35,0.15]) under WARM tungsten (1.00,0.85,0.65)
//   B: orange body (same chroma)             under COOL daylight  (0.85,0.95,1.00)
//   C: banana body (chroma [0.5,0.5,0.15])   under WARM tungsten
// Same-scene: MSE(A,B) should be near-zero.
// Different-scene: MSE(A,C) should be measurably large.
// Also runs a real-image capture if a corpus image can be located.

import { captureCanonicalPhoton, canonicalPhotonMSE, AWE_VERSION, CANONICAL_SIZE } from './photon-canonical.mjs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const W = 256, H = 256;

// ---- synthesize a scene ----
// body_chroma is the reflectance of the object at every foreground pixel (linear)
// illum is the illuminant chromaticity (linear multipliers)
// gamma-encodes to sRGB (approx pow 1/2.2) and returns uint8 R/G/B channels.
function synthScene({ bodyChroma, illum, shape }) {
  const R = new Uint8Array(W * H);
  const G = new Uint8Array(W * H);
  const B = new Uint8Array(W * H);
  const cx = W / 2, cy = H / 2, rad = 80;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const inCircle = dx * dx + dy * dy <= rad * rad;
      let r_lin, g_lin, b_lin;
      if (inCircle) {
        // shading: positive-only, varies across the sphere
        const nx = dx / rad, ny = dy / rad;
        // simple Lambertian-ish: light from upper-left
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const shade = Math.max(0.1, 0.4 + 0.6 * (0.7 * nz - 0.3 * ny - 0.3 * nx));
        r_lin = bodyChroma[0] * illum[0] * shade;
        g_lin = bodyChroma[1] * illum[1] * shade;
        b_lin = bodyChroma[2] * illum[2] * shade;
      } else {
        // white background under the same illuminant
        const bgRefl = 0.9;
        r_lin = bgRefl * illum[0];
        g_lin = bgRefl * illum[1];
        b_lin = bgRefl * illum[2];
      }
      // sRGB gamma encode + clip
      const enc = v => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255)));
      const idx = y * W + x;
      R[idx] = enc(r_lin);
      G[idx] = enc(g_lin);
      B[idx] = enc(b_lin);
    }
  }
  return { R, G, B, W, H };
}

function summarizeCanonical(canon, label) {
  const map = canon.reflectance_map;
  let sumR = 0, sumG = 0, sumB = 0, sumV = 0, n = 0;
  let minR = 1e9, maxR = -1e9;
  for (let i = 0; i < CANONICAL_SIZE.W * CANONICAL_SIZE.H; i++) {
    const v = map[i * 4 + 3];
    if (!v) continue;
    const r = map[i * 4 + 0];
    sumR += r; sumG += map[i * 4 + 1]; sumB += map[i * 4 + 2]; sumV += v;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    n++;
  }
  return {
    label,
    valid_frac: (sumV / (CANONICAL_SIZE.W * CANONICAL_SIZE.H)).toFixed(4),
    valid_px: n,
    mean_rgb: n ? [sumR / n, sumG / n, sumB / n].map(x => Number(x.toFixed(4))) : [0, 0, 0],
    r_range: n ? [Number(minR.toFixed(4)), Number(maxR.toFixed(4))] : [0, 0],
    illuminant_c: Array.from(canon.meta.illuminant.c).map(x => Number(x.toFixed(4))),
    illuminant_conf: Number(canon.meta.illuminant.confidence.toFixed(4)),
    camera_gamma: Number(canon.meta.camera.gamma.toFixed(3)),
    camera_wb: canon.meta.camera.wb.map(x => Number(x.toFixed(4))),
    shape_moments_head: Array.from(canon.shape_moments.slice(0, 4)).map(x => Number(x.toFixed(6))),
    spectral_moments: Array.from(canon.spectral_moments).map(x => Number(x.toFixed(4))),
  };
}

// -------- run synthetic test --------
console.log(`[AWE ${AWE_VERSION}] Canonical size: ${CANONICAL_SIZE.W}x${CANONICAL_SIZE.H}`);

const orangeChroma = [0.5, 0.35, 0.15];
const bananaChroma = [0.5, 0.50, 0.15];
const warm = [1.00, 0.85, 0.65]; // tungsten
const cool = [0.85, 0.95, 1.00]; // daylight

const frameA = synthScene({ bodyChroma: orangeChroma, illum: warm });
const frameB = synthScene({ bodyChroma: orangeChroma, illum: cool });
const frameC = synthScene({ bodyChroma: bananaChroma, illum: warm });

const region = { x: 48, y: 48, w: 160, h: 160 }; // foreground bbox around the sphere

const A = captureCanonicalPhoton(frameA, region);
const B = captureCanonicalPhoton(frameB, region);
const C = captureCanonicalPhoton(frameC, region);

const mse_same  = canonicalPhotonMSE(A, B);
const mse_diff  = canonicalPhotonMSE(A, C);
const ratio     = mse_diff / (mse_same + 1e-12);

console.log('\n--- SYNTHETIC PHOTON-IDENTITY RECEIPT ---');
console.log(JSON.stringify({
  A_orange_warm: summarizeCanonical(A, 'orange_warm'),
  B_orange_cool: summarizeCanonical(B, 'orange_cool'),
  C_banana_warm: summarizeCanonical(C, 'banana_warm'),
}, null, 2));
console.log('\nMSE(same-scene A vs B)   =', mse_same.toExponential(6));
console.log('MSE(diff-scene A vs C)   =', mse_diff.toExponential(6));
console.log('separation ratio (diff / same) =', ratio.toExponential(4));
const verdict_synth =
  mse_same < 1e-3 ? 'PHOTON-IDENTITY: PASS'
  : mse_same < 5e-2 ? 'PHOTON-IDENTITY: partial (illuminant/shading residual)'
  : 'PHOTON-IDENTITY: FAIL';
console.log('verdict:', verdict_synth);

// -------- real-image receipt (best-effort) --------
async function findFirstImage(root) {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(jpe?g|png|bmp|gif)$/i.test(e.name)) return p;
    }
  }
  return null;
}

// Try to use existing image decode helpers if available.
let decodeRGB = null;
try {
  const mod = await import('./identity/recognize-human-grade.mjs');
  if (typeof mod.extractImageRGB === 'function') decodeRGB = mod.extractImageRGB;
} catch {}
if (!decodeRGB) {
  try {
    const mod = await import('./identity/fisher-ratio-signature.mjs');
    if (typeof mod.extractImageRGB === 'function') decodeRGB = mod.extractImageRGB;
  } catch {}
}
if (!decodeRGB) {
  try {
    const mod = await import('./image-io.mjs');
    if (typeof mod.extractImageRGB === 'function') decodeRGB = mod.extractImageRGB;
  } catch {}
}
if (!decodeRGB) {
  try {
    const mod = await import('./prism.mjs');
    if (typeof mod.extractImageRGB === 'function') decodeRGB = mod.extractImageRGB;
  } catch {}
}

const roots = [
  'C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus',
  'C:/AtomEons/Orange5/07-VISUAL/fixtures/meme-corpus',
];
let realImg = null;
for (const r of roots) { realImg = await findFirstImage(r); if (realImg) break; }

console.log('\n--- REAL-IMAGE RECEIPT ---');
if (!realImg) {
  console.log('no image found in corpus dirs; skipping real-image capture');
} else {
  console.log('image:', realImg);
  try {
    const s = await stat(realImg);
    console.log('size_bytes:', s.size);
  } catch {}
  if (!decodeRGB) {
    console.log('no extractImageRGB helper found in project; skipping decode');
  } else {
    try {
      const frame = await decodeRGB(realImg);
      const canon = captureCanonicalPhoton(frame);
      console.log(JSON.stringify(summarizeCanonical(canon, 'real_image'), null, 2));
    } catch (e) {
      console.log('decode/capture failed:', e?.message || e);
    }
  }
}
