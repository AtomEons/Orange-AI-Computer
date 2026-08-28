#!/usr/bin/env bun
// The baby-learns-orange experiment.
//
// A baby watches an orange (single image), the parent says "orange", the
// system stores the descriptor. Then the system is shown DIFFERENT images
// and asked to find "orange" in them.
//
// Uses the empirical light-string pipeline established by 6702 experiments:
//   photoreceptor → density-cluster → merge_overlap
// on Y or RG axis (whichever regime wins per image).
//
// Steps:
//   1. Train: load orange.jpg. Run attention. Auto-pick the largest
//      chromatic-orange region (max RG + moderate mean-color-in-warm-range).
//      Extract descriptor. Store as label "orange".
//   2. Test A: load fruits.jpg. Run attention. Rank all entities by
//      similarity to the stored "orange" descriptor. Report + overlay.
//   3. Test B: load apple.jpg. Same. See if the red apple correctly does
//      NOT match orange (different chromaticity).
//   4. Test C: load lemon-yellow region. See what happens.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB, prismDecompose, opponentToUnit } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "../binders/preprocessing.mjs";
import { postprocess } from "../binders/post-processing.mjs";
import { bind as densityBind } from "../binders/density-cluster.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { loadStore, saveStore, learnLabel, recognize, rankByLabel } from "./identity-store.mjs";
import { descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT_DIR = path.join(FIXTURES, "baby-learn");
fs.mkdirSync(OUT_DIR, { recursive: true });
const STORE_PATH = path.join(OUT_DIR, "identity-store.json");

// The empirical light-string pipeline
async function attentionOn(imgPath, opts = {}) {
  const rgb = await extractImageRGB(imgPath, { maxSize: 512 });
  const { R: cR, G: cG, B: cB, width, height } = rgb;
  // Baseline: Y (Rec.601)
  const Y = new Float32Array(cR.length);
  for (let i = 0; i < cR.length; i++) Y[i] = 0.30 * cR[i] + 0.59 * cG[i] + 0.11 * cB[i];
  // Preproc → density-cluster → merge_overlap (empirical winning family)
  const pre = preprocess(opts.preproc || "gaussian_2", photoreceptorResponse(Y, initAdaptationState(), null).R, width, height);
  const rawEntities = densityBind(pre.R2, width, height, {}).entities || [];
  const { entities } = postprocess("merge_overlap", rawEntities, { frameArea: width * height });
  return { entities, R: cR, G: cG, B: cB, width, height, imgPath };
}

// Given a set of entities, pick the "most orange" one by color heuristic:
// high red-green (positive RG), high red channel, low blue.
function pickOrangeEntity(entities, R, G, B, width, height) {
  let best = null, bestScore = -Infinity;
  for (const e of entities) {
    const desc = computeDescriptor(e.region, R, G, B, width, height);
    if (!desc) continue;
    // "Oranginess" heuristic: RG positive, R high, B low
    const score = desc.mean_RG * 2 + desc.mean_R - desc.mean_B;
    if (score > bestScore) { bestScore = score; best = { entity: e, descriptor: desc, orangeScore: score }; }
  }
  return best;
}

// The union-of-warm-entities pick.
//
// Filter entities whose mean color is "warm" (red channel dominates blue,
// combined R+G brightness is high). Then compute ONE descriptor from the
// union of all their pixel sets — this is closer to what a baby actually
// sees: not one narrow strip, but the whole orange as one chromatic object.
function pickWarmUnion(entities, R, G, B, width, height) {
  const warm = [];
  for (const e of entities) {
    const desc = computeDescriptor(e.region, R, G, B, width, height);
    if (!desc) continue;
    // Chromatic-warm rule (tightened): require actual red-over-green dominance
    // AND red significantly above blue. Rejects green background regions.
    const isWarm = (desc.mean_RG > 0.03)                    // R>G at all
                && (desc.mean_R > desc.mean_B + 0.15)       // R clearly above B
                && (desc.mean_R + desc.mean_G > 0.5)        // still reasonably bright
                && (desc.mean_B < 0.5);
    if (isWarm) warm.push({ entity: e, descriptor: desc });
  }
  if (!warm.length) return null;
  const regions = warm.map((w) => w.entity.region);
  const union = computeUnionDescriptor(regions, R, G, B, width, height);
  return { entities: warm.map((w) => w.entity), descriptor: union, count: warm.length };
}

async function drawOverlayWithLabel(imgPath, entities, labelIdx, labelText, distance, outPath) {
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const parts = [];
  for (let i = 0; i < entities.length && i < 15; i++) {
    const e = entities[i];
    const r = e.region;
    const col = i === labelIdx ? "lime" : colors[i % colors.length];
    const th = i === labelIdx ? 4 : 2;
    parts.push(`drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${col}:thickness=${th}`);
  }
  if (labelIdx >= 0 && labelIdx < entities.length) {
    const r = entities[labelIdx].region;
    const tx = r[0] + 2, ty = Math.max(15, r[1] - 5);
    const text = `${labelText.replace(/'/g, "")} d=${distance.toFixed(2)}`;
    parts.push(`drawtext=text='${text}':x=${tx}:y=${ty}:fontsize=18:fontcolor=lime:box=1:boxcolor=black@0.6:boxborderw=3`);
  }
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", imgPath, "-vf", parts.join(",") || "null", outPath],
  });
  return proc.exitCode === 0;
}

console.log("=== BABY LEARNS ORANGE ===\n");

// --- STEP 1: TRAIN ---
console.log("STEP 1: baby watches orange.jpg — parent says 'orange'");
const orangeImg = path.join(FIXTURES, "orange.jpg");
const train = await attentionOn(orangeImg);
console.log(`  attention: ${train.entities.length} entities detected`);

// Union-of-warm-entities training. Not a single strip — the whole warm object.
const pick = pickWarmUnion(train.entities, train.R, train.G, train.B, train.width, train.height);
if (!pick) throw new Error("could not auto-pick warm entities on orange.jpg");
console.log(`  auto-picked ${pick.count} warm entities (union descriptor):`);
for (const e of pick.entities) console.log(`    region=${JSON.stringify(e.region)}`);
console.log(`  UNION descriptor:`);
for (const [k, v] of Object.entries(pick.descriptor)) console.log(`    ${k}: ${v.toFixed(4)}`);

let store = loadStore(STORE_PATH);
store = learnLabel(store, "orange", pick.descriptor, "orange.jpg (union of "+pick.count+" warm regions)", "2026-07-06T00:00:00Z");
saveStore(STORE_PATH, store);
console.log(`  → stored 'orange' at ${STORE_PATH}\n`);

// Draw all warm regions in lime, others in cyan
{
  const parts = [];
  for (let i = 0; i < train.entities.length && i < 15; i++) {
    const e = train.entities[i];
    const r = e.region;
    const isWarm = pick.entities.includes(e);
    const col = isWarm ? "lime" : "cyan";
    const th = isWarm ? 4 : 2;
    parts.push(`drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${col}:thickness=${th}`);
  }
  parts.push(`drawtext=text='TRAINED\\: orange (union of ${pick.count})':x=8:y=8:fontsize=16:fontcolor=lime:box=1:boxcolor=black@0.6:boxborderw=3`);
  Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", orangeImg, "-vf", parts.join(","), path.join(OUT_DIR, "01-train-orange.png")],
  });
}

// --- STEP 2: TEST — dual metric: (a) best-entity match, (b) warm-union match
async function testOn(imgName, storeToUse) {
  console.log(`STEP: test on ${imgName}`);
  const p = path.join(FIXTURES, imgName);
  const t = await attentionOn(p);
  const descriptors = t.entities.map((e) => computeDescriptor(e.region, t.R, t.G, t.B, t.width, t.height));
  console.log(`  ${t.entities.length} entities → computing descriptors`);

  // (a) best-entity ranking
  const ranked = rankByLabel(descriptors, storeToUse, "orange");
  if (ranked.length === 0) {
    console.log(`  no descriptors could be computed`);
    return;
  }
  const best = ranked[0];
  const bestEntity = t.entities[best.index];
  const bestDesc = descriptors[best.index];
  const rec = recognize(bestDesc, storeToUse);
  console.log(`  (a) best-entity match: entity #${best.index}, distance=${best.distance.toFixed(3)}`);
  console.log(`      region=${JSON.stringify(bestEntity.region)}, size=${bestEntity.region[2]}x${bestEntity.region[3]}`);
  console.log(`      descriptor: mean_R=${bestDesc.mean_R.toFixed(3)} mean_G=${bestDesc.mean_G.toFixed(3)} mean_B=${bestDesc.mean_B.toFixed(3)} RG=${bestDesc.mean_RG.toFixed(3)} BY=${bestDesc.mean_BY.toFixed(3)}`);
  console.log(`      recognition: label=${rec?.label ?? "none"} confidence=${(rec?.confidence ?? 0).toFixed(2)}${rec?.rejected_reason ? " ["+rec.rejected_reason+"]" : ""}`);

  // (b) warm-union match — same rule as training
  const warmPick = pickWarmUnion(t.entities, t.R, t.G, t.B, t.width, t.height);
  let unionDist = Infinity;
  if (warmPick) {
    const target = storeToUse.labels.find((r) => r.label === "orange");
    if (target) unionDist = descriptorDistance(warmPick.descriptor, target.descriptor);
    console.log(`  (b) warm-union match: ${warmPick.count} warm regions, distance=${unionDist.toFixed(3)}`);
    console.log(`      union descriptor: mean_R=${warmPick.descriptor.mean_R.toFixed(3)} mean_G=${warmPick.descriptor.mean_G.toFixed(3)} mean_B=${warmPick.descriptor.mean_B.toFixed(3)} RG=${warmPick.descriptor.mean_RG.toFixed(3)} BY=${warmPick.descriptor.mean_BY.toFixed(3)}`);
  } else {
    console.log(`  (b) warm-union match: NO WARM REGIONS FOUND — image has no orange-like content`);
  }

  await drawOverlayWithLabel(
    p, t.entities, best.index, `orange? d=${best.distance.toFixed(2)}`, best.distance,
    path.join(OUT_DIR, `02-test-${imgName.replace(/\.\w+$/, "")}.png`),
  );
  return { best, ranked, entities: t.entities, descriptors, unionDist, warmPick };
}

console.log("");
const r1 = await testOn("fruits.jpg", store);
console.log("");
const r2 = await testOn("apple.jpg", store);
console.log("");
const r3 = await testOn("lena.jpg", store);
console.log("");

// --- SUMMARY ---
console.log("=== VERDICT ===");
console.log(`training: orange descriptor from orange.jpg`);
console.log(`test on fruits.jpg (contains orange slice): best distance = ${r1?.best.distance.toFixed(3)}`);
console.log(`test on apple.jpg   (red apple, different color): best distance = ${r2?.best.distance.toFixed(3)}`);
console.log(`test on lena.jpg    (portrait, no orange): best distance = ${r3?.best.distance.toFixed(3)}`);

const fruitsBest = r1?.best.distance ?? Infinity;
const appleBest = r2?.best.distance ?? Infinity;
const lenaBest = r3?.best.distance ?? Infinity;
const fruitsUnion = r1?.unionDist ?? Infinity;
const appleUnion = r2?.unionDist ?? Infinity;
const lenaUnion = r3?.unionDist ?? Infinity;

console.log(`\nsuccess signature: fruits < apple ~ fruits < lena on BOTH metrics`);
console.log(`\n(a) BEST-ENTITY distance:`);
console.log(`    fruits=${fruitsBest.toFixed(3)}  apple=${appleBest.toFixed(3)}  lena=${lenaBest.toFixed(3)}`);
console.log(`(b) WARM-UNION distance:`);
console.log(`    fruits=${fruitsUnion.toFixed(3)}  apple=${appleUnion.toFixed(3)}  lena=${lenaUnion.toFixed(3)}`);

const bestVerdict = (fruitsBest < appleBest && fruitsBest < lenaBest);
const unionVerdict = (fruitsUnion < appleUnion && fruitsUnion < lenaUnion);
console.log(`\n(a) best-entity verdict: ${bestVerdict ? "IDENTITY LEARNED" : "identity not learned"}`);
console.log(`(b) warm-union verdict: ${unionVerdict ? "IDENTITY LEARNED" : "identity not learned"}`);
if (bestVerdict && unionVerdict) console.log(`\nOVERALL: IDENTITY LEARNED on both metrics.`);
else if (bestVerdict || unionVerdict) console.log(`\nOVERALL: PARTIAL — one metric succeeds. Investigate.`);
else console.log(`\nOVERALL: IDENTITY NOT LEARNED — needs more views (video) or better auto-pick.`);
console.log(`\noverlays written to: ${OUT_DIR}`);
