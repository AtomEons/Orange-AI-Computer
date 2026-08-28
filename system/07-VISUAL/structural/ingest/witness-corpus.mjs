#!/usr/bin/env bun
// Witness the corpus.
//
// Operator: "what is it seeing everything?"
//
// Numbers were on the ledger; the system's actual perception of these frames
// wasn't shown. This script picks the middle frame from every corpus row,
// runs the full 8-axis attention + warm-union + monocular depth pipeline,
// and writes an overlay PNG per clip so we can SEE what the system sees.
//
// Reports per clip:
//   · N entities detected by tri-axis vote merge
//   · K warm-colored entities (would-be fruit candidates)
//   · nearest / farthest attention entity by fused depth
//   · nearest identity match against the trained {orange, apple} store

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { sharpnessMap, aerialPerspectiveMap, fuseDepthCues, entityMeanDepth } from "../mono-depth.mjs";
import { computeDescriptor, computeUnionDescriptor, descriptorDistance } from "../identity/descriptor.mjs";
import { loadStore } from "../identity/identity-store.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dir, "..", "..", "fixtures", "training-corpus");
const OUT = path.join(CORPUS, "witness");
fs.mkdirSync(OUT, { recursive: true });
const STORE = path.resolve(__dir, "..", "..", "fixtures", "baby-learn", "identity-store-cinema.json");

const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const store = fs.existsSync(STORE) ? loadStore(STORE) : { labels: [] };
console.log(`identity store: ${store.labels.length} labels — [${store.labels.map(r => r.label).join(", ")}]\n`);

function isWarm(d) {
  return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}

async function witnessClip(row) {
  const videoPath = path.join(CORPUS, row.video_path);
  if (!fs.existsSync(videoPath)) { console.log(`  ! missing video: ${videoPath}`); return null; }
  const frames = await extractVideoFrames(videoPath, { frames: 3, size: 384 });
  const f = frames[Math.floor(frames.length / 2)];   // middle frame

  // 8-axis attention
  const combo = attentionMultiAxisV2(f.R, f.G, f.B, f.width, f.height, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const entities = combo.entities;

  // warm-union descriptors
  const warmEntities = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, f.R, f.G, f.B, f.width, f.height);
    if (isWarm(d)) warmEntities.push({ ...e, descriptor: d });
  }

  // mono depth (single-frame, no OF here)
  const L = new Float32Array(f.R.length);
  for (let i = 0; i < L.length; i++) L[i] = 0.30 * f.R[i] + 0.59 * f.G[i] + 0.11 * f.B[i];
  const sharp = sharpnessMap(L, f.width, f.height, 5);
  const aerial = aerialPerspectiveMap(f.R, f.G, f.B);
  const fused = fuseDepthCues([{ map: sharp, weight: 0.7 }, { map: aerial, weight: 0.3 }]);

  // per-entity depth
  const withDepth = entities.slice(0, 12).map((e) => ({
    ...e, depth: entityMeanDepth(e.region, fused, f.width, f.height),
  }));
  withDepth.sort((a, b) => a.depth - b.depth);
  const nearest = withDepth[0], farthest = withDepth[withDepth.length - 1];

  // identity nearest against store
  let bestId = null;
  if (warmEntities.length && store.labels.length) {
    const union = computeUnionDescriptor(warmEntities.map(w => w.region), f.R, f.G, f.B, f.width, f.height);
    for (const label of store.labels) {
      const d = descriptorDistance(union, label.descriptor);
      if (!bestId || d < bestId.distance) bestId = { label: label.label, distance: d };
    }
  }

  // write overlay
  const overlayPath = path.join(OUT, `${path.basename(videoPath, ".mp4")}-middle.png`);
  await drawOverlay(videoPath, f, entities, warmEntities, withDepth, overlayPath);

  return {
    title: row.title, clip: `${row.clip_start_s}s+${row.clip_duration_s}s`,
    entities_total: entities.length,
    warm_entities: warmEntities.length,
    top_entity_votes: entities.slice(0, 3).map(e => e.votes),
    nearest_depth: nearest?.depth ?? null,
    farthest_depth: farthest?.depth ?? null,
    depth_span: (farthest?.depth ?? 0) - (nearest?.depth ?? 0),
    identity_nearest: bestId,
    overlay: path.relative(CORPUS, overlayPath),
  };
}

async function drawOverlay(videoPath, frame, entities, warmEntities, entWithDepth, outPath) {
  // Extract the middle frame as PNG first (simpler than piping RGB back)
  const tmpFrame = outPath.replace(/\.png$/, "-src.png");
  Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", videoPath, "-vf", `select='eq(n\\,${Math.floor(15/2)})',scale=384:384`, "-frames:v", "1", "-update", "1", tmpFrame],
  });
  // Now overlay boxes via ffmpeg drawbox chain
  const parts = [];
  for (let i = 0; i < entities.length && i < 12; i++) {
    const e = entities[i], r = e.region;
    const isWarmEnt = warmEntities.some(w => w.region[0] === r[0] && w.region[1] === r[1]);
    const col = isWarmEnt ? "lime" : "cyan";
    parts.push(`drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${col}:thickness=3`);
  }
  // Depth-nearest annotation
  const near = entWithDepth[0];
  if (near) {
    parts.push(`drawbox=x=${near.region[0]}:y=${near.region[1]}:w=${near.region[2]}:h=${near.region[3]}:color=magenta:thickness=5`);
    parts.push(`drawtext=text='NEAR d=${near.depth.toFixed(2)}':x=${near.region[0]+4}:y=${Math.max(15, near.region[1]-4)}:fontsize=16:fontcolor=magenta:box=1:boxcolor=black@0.7`);
  }
  Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", tmpFrame, "-vf", parts.join(",") || "null", outPath],
  });
  try { fs.unlinkSync(tmpFrame); } catch {}
}

const rows = fs.readFileSync(path.join(CORPUS, "manifest.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
console.log(`=== WITNESSING ${rows.length} CORPUS CLIPS ===\n`);

const witnessed = [];
for (const row of rows) {
  const title = `${row.title} ${row.clip_start_s}s+${row.clip_duration_s}s`;
  console.log(`▸ ${title}`);
  try {
    const w = await witnessClip(row);
    if (!w) continue;
    console.log(`  entities: ${w.entities_total} (top-3 votes: [${w.top_entity_votes.join(",")}])`);
    console.log(`  warm entities (fruit-colored): ${w.warm_entities}`);
    console.log(`  depth: nearest=${w.nearest_depth?.toFixed(3)}  farthest=${w.farthest_depth?.toFixed(3)}  span=${w.depth_span?.toFixed(3)}`);
    if (w.identity_nearest) {
      const acc = w.identity_nearest.distance <= 1.0 ? " (WITHIN threshold — spurious given clip content)" : " (rejected, above 1.0)";
      console.log(`  identity nearest: '${w.identity_nearest.label}' d=${w.identity_nearest.distance.toFixed(3)}${acc}`);
    } else {
      console.log(`  identity nearest: (no warm content — nothing to recognize)`);
    }
    console.log(`  overlay: ${w.overlay}`);
    witnessed.push(w);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
  console.log("");
}

// Summary
console.log("=== SUMMARY — what is AE Eyes actually seeing? ===\n");
const totalEnt = witnessed.reduce((a, b) => a + b.entities_total, 0);
const totalWarm = witnessed.reduce((a, b) => a + b.warm_entities, 0);
console.log(`across ${witnessed.length} witnessed frames:`);
console.log(`  total entities perceived: ${totalEnt}  (avg ${(totalEnt/witnessed.length).toFixed(1)}/frame)`);
console.log(`  total warm entities (fruit-family): ${totalWarm}  (avg ${(totalWarm/witnessed.length).toFixed(1)}/frame)`);
const nearestVotes = witnessed.map(w => w.identity_nearest?.distance).filter(x => x !== undefined && x !== null);
if (nearestVotes.length) {
  const mean = nearestVotes.reduce((a,b)=>a+b,0)/nearestVotes.length;
  const belowThresh = nearestVotes.filter(x => x <= 1.0).length;
  console.log(`  identity distances (nearest of {orange,apple} per frame): mean=${mean.toFixed(2)} — ${belowThresh} of ${nearestVotes.length} accepted at threshold 1.0`);
  console.log(`  (any acceptance here is spurious — Blender open movies have no oranges or apples)`);
}
console.log(`\noverlays: ${OUT}`);
