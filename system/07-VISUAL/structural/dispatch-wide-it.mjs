#!/usr/bin/env bun
// dispatch-wide-it.mjs — wide-IT capture at 384px input, 100 samples per class.
//
// Combines pulls A + D from operator's directive:
//   A: expand feature space (80 → ~286 dims)
//   D: bigger input (96 → 384 pixels)
//
// Same clean augmentation grid as diagnostic recommended:
//   6 lighting + 8 rotations + 4 scales + 6 brightness/contrast + NEON/CRT
//   pose/scale combos — NO crops, NO random combos.
// = ~40 samples per class. Enough for training on wide vectors.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { buildWideIT } from "./build-wide-it.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
fs.mkdirSync(CACHE_DIR, { recursive: true });

function walkImages(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkImages(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const allImages = walkImages(FIX);
console.log(`sources: ${allImages.length}`);

// TARGET: capture 400 classes (matches current clean-grid available)
const TARGET_CLASSES = 409;
const CAPTURE_MAXSIZE = 384;   // BIGGER INPUT (pull D)
const SHARD_SIZE = 5;

// Clean augmentation grid (no crops, no random combos) — ~40 samples per class
const LIGHTINGS = ["raw","sun","candle","moon","crt","neon"];
const ROTATIONS = [0,45,90,135,180,225,270,315];
const SCALES = [1.0,0.85,1.15];
const BRIGHTS = [1.0,0.85,1.15];
const CONTRASTS = [1.0,0.85,1.15];

function cleanAugsForClass(seed) {
  const list = [];
  for (const l of LIGHTINGS) list.push({ lighting: l, rotation: 0, scale: 1.0, bright: 1.0, contrast: 1.0 });
  for (const r of ROTATIONS) list.push({ lighting: "raw", rotation: r, scale: 1.0, bright: 1.0, contrast: 1.0 });
  for (const s of SCALES) list.push({ lighting: "raw", rotation: 0, scale: s, bright: 1.0, contrast: 1.0 });
  for (const b of BRIGHTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, bright: b, contrast: 1.0 });
  for (const c of CONTRASTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, bright: 1.0, contrast: c });
  // NEON + CRT with rotation and scale
  for (const l of ["neon","crt"]) {
    for (const r of [45,90,135]) list.push({ lighting: l, rotation: r, scale: 1.0, bright: 1.0, contrast: 1.0 });
    for (const s of [0.85,1.15]) list.push({ lighting: l, rotation: 0, scale: s, bright: 1.0, contrast: 1.0 });
  }
  return list;
}

function applyAug(rgb, aug) {
  const W = rgb.width, H = rgb.height;
  const R = new Float32Array(rgb.R), G = new Float32Array(rgb.G), B = new Float32Array(rgb.B);
  let rW = W, rH = H, rR = R, rG = G, rB = B;
  if (aug.rotation !== 0) {
    const th = -aug.rotation * Math.PI / 180, cT = Math.cos(th), sT = Math.sin(th), cx = W/2, cy = H/2;
    rR = new Float32Array(W*H); rG = new Float32Array(W*H); rB = new Float32Array(W*H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.round(cT*(x-cx) - sT*(y-cy) + cx), sy = Math.round(sT*(x-cx) + cT*(y-cy) + cy);
      if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
        const src = sy*W + sx, dst = y*W + x;
        rR[dst] = R[src]; rG[dst] = G[src]; rB[dst] = B[src];
      }
    }
  }
  let sW = rW, sH = rH, sR = rR, sG = rG, sB = rB;
  if (aug.scale !== 1.0) {
    sW = Math.max(32, Math.floor(rW*aug.scale)); sH = Math.max(32, Math.floor(rH*aug.scale));
    sR = new Float32Array(sW*sH); sG = new Float32Array(sW*sH); sB = new Float32Array(sW*sH);
    for (let y = 0; y < sH; y++) for (let x = 0; x < sW; x++) {
      const px = Math.min(rW-1, Math.floor(x/aug.scale)), py = Math.min(rH-1, Math.floor(y/aug.scale));
      const d = y*sW + x, s = py*rW + px;
      sR[d] = rR[s]; sG[d] = rG[s]; sB[d] = rB[s];
    }
  }
  const bN = sW*sH;
  for (let i = 0; i < bN; i++) {
    let r = sR[i], g = sG[i], b = sB[i];
    switch (aug.lighting) {
      case "sun":    r *= 1.15; g *= 1.08; b *= 0.88; break;
      case "candle": r *= 1.35*0.72; g *= 0.82*0.72; b *= 0.35*0.72; break;
      case "moon":   r *= 0.28; g *= 0.38; b *= 0.72; break;
      case "crt":    r *= 0.28; g *= 1.12; b *= 0.28; break;
      case "neon":   { const a = (r+g+b)/3; r = a+(r-a)*2.6; g = a+(g-a)*2.6; b = a+(b-a)*2.6; r *= 1.25; b *= 1.25; g *= 0.65; break; }
    }
    r *= aug.bright; g *= aug.bright; b *= aug.bright;
    r = (r-128)*aug.contrast + 128; g = (g-128)*aug.contrast + 128; b = (b-128)*aug.contrast + 128;
    sR[i] = Math.min(255, Math.max(0, r)); sG[i] = Math.min(255, Math.max(0, g)); sB[i] = Math.min(255, Math.max(0, b));
  }
  return { R: sR, G: sG, B: sB, width: sW, height: sH, W: sW, H: sH };
}

function shardPath(i) { return path.join(CACHE_DIR, `wide_${String(i).padStart(5, "0")}.json`); }

const t0 = performance.now();
const t = () => ((performance.now() - t0) / 1000).toFixed(0);

async function processShard(idx) {
  const p = shardPath(idx);
  if (fs.existsSync(p)) {
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.classes?.length) return d; } catch {}
  }
  const start = idx * SHARD_SIZE, end = Math.min(start + SHARD_SIZE, TARGET_CLASSES);
  const shard = { shard_idx: idx, classes: [] };
  for (let ci = start; ci < end; ci++) {
    const src = allImages[ci % allImages.length];
    let rgb;
    try { rgb = await extractImageRGB(src, { maxSize: CAPTURE_MAXSIZE }); } catch { continue; }
    const augs = cleanAugsForClass(ci);
    const its = [];
    for (const aug of augs) {
      try {
        const augRgb = applyAug(rgb, aug);
        const can = captureCanonicalPhoton(augRgb, { x: 0, y: 0, w: augRgb.width, h: augRgb.height });
        const wide = buildWideIT(can);
        its.push({ v: Array.from(wide), light: aug.lighting });
      } catch {}
    }
    if (its.length > 0) shard.classes.push({ id: `cls_${ci}`, source: src, wide_dim: its[0].v.length, its });
  }
  fs.writeFileSync(p, JSON.stringify(shard));
  return shard;
}

const totalShards = Math.ceil(TARGET_CLASSES / SHARD_SIZE);
const rank = Number(process.env.PROC_RANK ?? 0);
const workers = Number(process.env.PROC_WORKERS ?? 1);
console.log(`[${t()}s] wide-IT capture: ${TARGET_CLASSES} classes at ${CAPTURE_MAXSIZE}px, ${totalShards} shards, worker rank=${rank}/${workers}`);

for (let s = 0; s < totalShards; s++) {
  if (s % workers !== rank) continue;
  const st = performance.now();
  const shard = await processShard(s);
  const dt = ((performance.now() - st) / 1000).toFixed(1);
  const wideDim = shard.classes[0]?.wide_dim ?? "?";
  if (s % 5 === 0 || s === totalShards - 1) {
    const done = shard.classes.reduce((a, c) => a + c.its.length, 0);
    const eta = ((performance.now() - t0) / (s+1)) * (totalShards - s - 1) / 60000;
    console.log(`[${t()}s] shard ${s+1}/${totalShards} wide_dim=${wideDim} ${done} caps in ${dt}s  ETA ${eta.toFixed(0)}min`);
  }
}
console.log(`[${t()}s] wide-IT capture complete`);
