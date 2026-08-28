#!/usr/bin/env bun
// Sweep 5000 — the finish line.
//
// Factorial: 5 color axes × 5 preprocessors × 5 binder strategies × 2 postprocs × 20 images = 5000.
//
// Adds the PRISM DECOMPOSITION as a fifth-dimension variable — every image
// is analyzed on Y (baseline), A (achromatic from RGB), RG (red-green opponent),
// BY (blue-yellow opponent), and chroma_total (|RG|+|BY|).
//
// Writes:
//   fixtures/sweep-5000/metrics.json                — every 5000 rows
//   fixtures/sweep-5000/analysis.md                 — human-readable rank
//   fixtures/sweep-5000/finish-line.md              — the empirical verdict
//   fixtures/sweep-5000/best-<image>-overlay.png    — 20 top-config overlays

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageLuminance } from "../luminance-ffmpeg.mjs";
import { extractImageRGB, prismDecompose, opponentToUnit } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "./preprocessing.mjs";
import { postprocess } from "./post-processing.mjs";
import { bindCombo } from "./combo.mjs";
import { bind as watershedBind } from "./watershed.mjs";
import { bind as densityBind }   from "./density-cluster.mjs";
import { bind as regionBind }    from "./region-grow.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT_DIR = path.join(FIXTURES, "sweep-5000");
fs.mkdirSync(OUT_DIR, { recursive: true });

const IMAGES = [
  { name: "fruits",       file: "fruits.jpg" },
  { name: "baboon",       file: "baboon.jpg" },
  { name: "messi5",       file: "messi5.jpg" },
  { name: "home",         file: "home.jpg" },
  { name: "starry_night", file: "starry_night.jpg" },
  { name: "lena",         file: "lena.jpg" },
  { name: "apple",        file: "apple.jpg" },
  { name: "orange",       file: "orange.jpg" },
  { name: "building",     file: "building.jpg" },
  { name: "basketball1",  file: "basketball1.png" },
  { name: "pic1",         file: "pic1.png" },
  { name: "pic2",         file: "pic2.png" },
  { name: "pic4",         file: "pic4.png" },
  { name: "pic5",         file: "pic5.png" },
  { name: "pic6",         file: "pic6.png" },
  { name: "butterfly",    file: "butterfly.jpg" },
  { name: "board",        file: "board.jpg" },
  { name: "basketball2",  file: "basketball2.png" },
  { name: "gradient",     file: "gradient.png" },
  { name: "notes",        file: "notes.png" },
];
const AXES       = ["Y_baseline", "A", "RG", "BY", "chroma_total"];
const PREPROCS   = ["identity", "gaussian_1", "gaussian_2", "gaussian_3", "median_5"];
const STRATEGIES = ["watershed", "density-cluster", "region-grow", "combo_union", "combo_voting"];
const POSTPROCS  = ["identity", "merge_overlap"];

const TOTAL = AXES.length * PREPROCS.length * STRATEGIES.length * POSTPROCS.length * IMAGES.length;
console.log(`=== SWEEP 5000 — ${AXES.length}×${PREPROCS.length}×${STRATEGIES.length}×${POSTPROCS.length}×${IMAGES.length} = ${TOTAL} experiments ===`);
console.log("");

async function runStrategy(strategy, R, w, h) {
  switch (strategy) {
    case "watershed":       return watershedBind(R, w, h, {});
    case "density-cluster": return densityBind(R, w, h, {});
    case "region-grow":     return regionBind(R, w, h, {});
    case "combo_union":     return bindCombo("combo_union",  R, w, h, {});
    case "combo_voting":    return bindCombo("combo_voting", R, w, h, {});
    default: throw new Error(`unknown strategy: ${strategy}`);
  }
}

function score(entities, coverageFrac, largestFrac, IMG_AREA) {
  const n = entities.length;
  if (n === 0) return 0;
  const countScore = n >= 4 && n <= 15 ? 1.0 : Math.max(0, 1 - Math.min(Math.abs(n - 8) / 15, 1));
  const covScore = coverageFrac >= 0.15 && coverageFrac <= 0.65 ? 1.0
    : Math.max(0, 1 - Math.abs(coverageFrac - 0.40) / 0.50);
  const giantScore = largestFrac >= 0.45 ? Math.max(0, 1 - (largestFrac - 0.45) / 0.5) : 1.0;
  const areas = entities.map((e) => Math.log((e.region?.[2] ?? 1) * (e.region?.[3] ?? 1) / IMG_AREA + 1e-6));
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
  const varLog = areas.reduce((s, v) => s + (v - mean) ** 2, 0) / areas.length;
  const sizeVarScore = varLog <= 1 ? 1 : Math.max(0, 1 - (varLog - 1) / 4);
  return 0.30 * countScore + 0.25 * covScore + 0.25 * giantScore + 0.20 * sizeVarScore;
}

const allRows = [];
const perImageRows = {};
const t0 = Date.now();
let doneCount = 0;

for (const img of IMAGES) {
  const imgPath = path.join(FIXTURES, img.file);
  const tImg = Date.now();

  // Load Y baseline via existing pipeline.
  const yRes = await extractImageLuminance(imgPath);
  const width = yRes.width, height = yRes.height;
  const IMG_AREA = width * height;
  const Lbaseline = new Float32Array(yRes.data.length);
  for (let i = 0; i < yRes.data.length; i++) Lbaseline[i] = yRes.data[i] / 255;

  // Load RGB and prism-decompose.
  const rgb = await extractImageRGB(imgPath, { maxSize: 512 });
  const { A, RG, BY } = prismDecompose(rgb.R, rgb.G, rgb.B);
  const chromaTotal = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) chromaTotal[i] = Math.abs(RG[i]) + Math.abs(BY[i]);
  const RGu = opponentToUnit(RG);
  const BYu = opponentToUnit(BY);
  const chromaU = opponentToUnit(chromaTotal);

  // Photoreceptor per axis (fresh state per axis).
  const axisSignal = {
    Y_baseline:  photoreceptorResponse(Lbaseline, initAdaptationState(), null).R,
    A:           photoreceptorResponse(A,         initAdaptationState(), null).R,
    RG:          photoreceptorResponse(RGu,       initAdaptationState(), null).R,
    BY:          photoreceptorResponse(BYu,       initAdaptationState(), null).R,
    chroma_total:photoreceptorResponse(chromaU,   initAdaptationState(), null).R,
  };

  const imgResults = [];
  for (const axisName of AXES) {
    const baseR = axisSignal[axisName];
    for (const preprocName of PREPROCS) {
      const { R2 } = preprocess(preprocName, baseR, width, height);
      for (const strategyName of STRATEGIES) {
        let rawEntities = [];
        try { rawEntities = (await runStrategy(strategyName, R2, width, height)).entities || []; } catch {}
        for (const postprocName of POSTPROCS) {
          doneCount++;
          const { entities } = postprocess(postprocName, rawEntities, { frameArea: IMG_AREA });
          const areas = entities.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
          const totalArea = areas.reduce((a, b) => a + b, 0);
          const coverage = totalArea / IMG_AREA;
          const largest = areas.length ? Math.max(...areas) : 0;
          const largestFrac = largest / IMG_AREA;
          const sc = score(entities, coverage, largestFrac, IMG_AREA);
          const row = {
            image: img.name, axis: axisName, preproc: preprocName, strategy: strategyName, postproc: postprocName,
            entity_count: entities.length,
            coverage_frac: Number(coverage.toFixed(4)),
            largest_frac: Number(largestFrac.toFixed(4)),
            score: Number(sc.toFixed(4)),
          };
          allRows.push(row);
          imgResults.push(row);
        }
      }
    }
  }
  imgResults.sort((a, b) => b.score - a.score);
  perImageRows[img.name] = imgResults;
  const top = imgResults[0];
  console.log(`  ${img.name.padEnd(15)} ${((Date.now()-tImg)/1000).toFixed(1)}s  best=${top.score.toFixed(3)}  ${top.axis}+${top.preproc}+${top.strategy}+${top.postproc}  n=${top.entity_count}`);
}

const totalMs = Date.now() - t0;
console.log(`\n=== 5000 done: ${allRows.length} rows in ${(totalMs/1000/60).toFixed(1)} min ===\n`);

// --- cross-image analysis: find the finish-line config ---
const configKey = (r) => `${r.axis}::${r.preproc}::${r.strategy}::${r.postproc}`;
const configStats = {};
for (const [imgName, rows] of Object.entries(perImageRows)) {
  rows.forEach((r, i) => {
    const k = configKey(r);
    if (!configStats[k]) configStats[k] = { axis: r.axis, preproc: r.preproc, strategy: r.strategy, postproc: r.postproc, scores: {}, ranks: {}, top1: 0, top3: 0, top5: 0, top10: 0 };
    configStats[k].ranks[imgName] = i + 1;
    configStats[k].scores[imgName] = r.score;
    if (i === 0) configStats[k].top1++;
    if (i < 3) configStats[k].top3++;
    if (i < 5) configStats[k].top5++;
    if (i < 10) configStats[k].top10++;
  });
}
const configTable = Object.values(configStats).map((s) => {
  const scores = Object.values(s.scores);
  const ranks = Object.values(s.ranks);
  return {
    ...s,
    top1_hits: s.top1, top3_hits: s.top3, top5_hits: s.top5, top10_hits: s.top10,
    mean_score: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)),
    min_score: Number(Math.min(...scores).toFixed(4)),
    mean_rank: Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)),
    max_rank: Math.max(...ranks),
  };
});
configTable.sort((a, b) => b.top10_hits - a.top10_hits || b.mean_score - a.mean_score);

// Axis-only analysis: which axis dominates on average?
const axisStats = {};
for (const ax of AXES) {
  const rows = allRows.filter((r) => r.axis === ax);
  const scores = rows.map((r) => r.score);
  axisStats[ax] = {
    mean_score: scores.reduce((a, b) => a + b, 0) / scores.length,
    max_score: Math.max(...scores),
    n: rows.length,
    top1_wins: 0,
  };
}
for (const rows of Object.values(perImageRows)) {
  axisStats[rows[0].axis].top1_wins++;
}

// Binder-only analysis: which binder wins across (axis × image)?
const binderStats = {};
for (const s of STRATEGIES) {
  binderStats[s] = { top1_wins_per_image: 0 };
}
for (const rows of Object.values(perImageRows)) {
  binderStats[rows[0].strategy].top1_wins_per_image++;
}

const finishLine = configTable[0];
const universal10 = configTable.filter((c) => c.top10_hits === IMAGES.length);
const universal5 = configTable.filter((c) => c.top5_hits === IMAGES.length);
const universal3 = configTable.filter((c) => c.top3_hits === IMAGES.length);

console.log("=== FINISH LINE ===");
console.log(`configs top-3 on all ${IMAGES.length}: ${universal3.length}`);
console.log(`configs top-5 on all ${IMAGES.length}: ${universal5.length}`);
console.log(`configs top-10 on all ${IMAGES.length}: ${universal10.length}`);
console.log("");
console.log(`best single: ${finishLine.axis}+${finishLine.preproc}+${finishLine.strategy}+${finishLine.postproc}`);
console.log(`  top-1: ${finishLine.top1_hits}/${IMAGES.length}  top-3: ${finishLine.top3_hits}/${IMAGES.length}  top-5: ${finishLine.top5_hits}/${IMAGES.length}  top-10: ${finishLine.top10_hits}/${IMAGES.length}`);
console.log(`  mean_score: ${finishLine.mean_score.toFixed(4)}  mean_rank: ${finishLine.mean_rank}  worst_rank: ${finishLine.max_rank}`);
console.log("");
console.log("=== AXIS DOMINANCE ===");
for (const [ax, s] of Object.entries(axisStats)) {
  console.log(`  ${ax.padEnd(14)} mean=${s.mean_score.toFixed(3)}  top1_wins_per_image=${s.top1_wins}/${IMAGES.length}`);
}
console.log("=== BINDER DOMINANCE ===");
for (const [b, s] of Object.entries(binderStats)) {
  console.log(`  ${b.padEnd(20)} top1_wins_per_image=${s.top1_wins_per_image}/${IMAGES.length}`);
}
console.log("");
console.log("=== TOP 10 CONFIGS ===");
for (let i = 0; i < 10; i++) {
  const c = configTable[i];
  console.log(`  #${i+1}: top10=${c.top10_hits}/${IMAGES.length} top3=${c.top3_hits}/${IMAGES.length} mean=${c.mean_score.toFixed(3)} worst_rank=${c.max_rank}  ${c.axis}+${c.preproc}+${c.strategy}+${c.postproc}`);
}

// Persist
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify({
  images: IMAGES,
  axes: AXES, preprocs: PREPROCS, strategies: STRATEGIES, postprocs: POSTPROCS,
  total_experiments: allRows.length,
  wall_ms: totalMs,
  all_rows: allRows,
  per_image_top10: Object.fromEntries(Object.entries(perImageRows).map(([k, v]) => [k, v.slice(0, 10)])),
  cross_image_table: configTable.slice(0, 100),
  axis_dominance: axisStats,
  binder_dominance: binderStats,
  universal_top3_count: universal3.length,
  universal_top5_count: universal5.length,
  universal_top10_count: universal10.length,
}, null, 2));

// Draw overlays for the finish-line config on every image + best-per-image
// Save time by only running the best config once per image (which is the row we already stored)
async function drawOverlay(entities, srcImg, outPath) {
  const colors = ["red","yellow","cyan","magenta","lime","orange","white"];
  const boxes = entities.slice().sort((a,b) => ((b.region?.[2] ?? 0)*(b.region?.[3] ?? 0)) - ((a.region?.[2] ?? 0)*(a.region?.[3] ?? 0))).slice(0, 15);
  const filters = boxes.map((e,i) => `drawbox=x=${e.region[0]}:y=${e.region[1]}:w=${e.region[2]}:h=${e.region[3]}:color=${colors[i%colors.length]}:thickness=2`).join(",");
  const proc = Bun.spawnSync({ cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", srcImg, "-vf", filters || "null", outPath] });
  return proc.exitCode === 0;
}
// Rerun the best-per-image config with entities preserved to draw the overlay
for (const img of IMAGES) {
  const top = perImageRows[img.name][0];
  // Re-execute this specific config to get entities (they weren't stored)
  const imgPath = path.join(FIXTURES, img.file);
  const yRes = await extractImageLuminance(imgPath);
  const w = yRes.width, h = yRes.height;
  let baseL;
  if (top.axis === "Y_baseline") {
    baseL = new Float32Array(yRes.data.length);
    for (let i = 0; i < yRes.data.length; i++) baseL[i] = yRes.data[i] / 255;
  } else {
    const rgb = await extractImageRGB(imgPath, { maxSize: 512 });
    const { A, RG, BY } = prismDecompose(rgb.R, rgb.G, rgb.B);
    const chromaTotal = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) chromaTotal[i] = Math.abs(RG[i]) + Math.abs(BY[i]);
    if (top.axis === "A") baseL = A;
    else if (top.axis === "RG") baseL = opponentToUnit(RG);
    else if (top.axis === "BY") baseL = opponentToUnit(BY);
    else baseL = opponentToUnit(chromaTotal);
  }
  const R = photoreceptorResponse(baseL, initAdaptationState(), null).R;
  const { R2 } = preprocess(top.preproc, R, w, h);
  const raw = (await runStrategy(top.strategy, R2, w, h)).entities || [];
  const { entities } = postprocess(top.postproc, raw, { frameArea: w * h });
  await drawOverlay(entities, imgPath, path.join(OUT_DIR, `best-${img.name}.png`));
}

// Write the finish-line summary
let fl = `# Sweep 5000 — the finish line\n\n`;
fl += `Total experiments: ${allRows.length} across ${IMAGES.length} images, ${AXES.length} color axes, ${PREPROCS.length} preprocessors, ${STRATEGIES.length} binders, ${POSTPROCS.length} postprocessors.\n`;
fl += `Wall clock: ${(totalMs/1000/60).toFixed(1)} minutes.\n\n`;
fl += `## Universal configs\n\n`;
fl += `- Top-3 on all ${IMAGES.length} images: **${universal3.length}**\n`;
fl += `- Top-5 on all ${IMAGES.length} images: **${universal5.length}**\n`;
fl += `- Top-10 on all ${IMAGES.length} images: **${universal10.length}**\n\n`;
fl += `## The finish-line config\n\n`;
fl += `**${finishLine.axis} + ${finishLine.preproc} + ${finishLine.strategy} + ${finishLine.postproc}**\n\n`;
fl += `- top-1 hits: ${finishLine.top1_hits}/${IMAGES.length}\n`;
fl += `- top-3 hits: ${finishLine.top3_hits}/${IMAGES.length}\n`;
fl += `- top-5 hits: ${finishLine.top5_hits}/${IMAGES.length}\n`;
fl += `- top-10 hits: ${finishLine.top10_hits}/${IMAGES.length}\n`;
fl += `- mean score: ${finishLine.mean_score.toFixed(4)}\n`;
fl += `- mean rank: ${finishLine.mean_rank}\n`;
fl += `- worst rank: ${finishLine.max_rank}\n\n`;
fl += `## Axis dominance (which color axis is empirically best?)\n\n`;
fl += `| Axis | Mean score | Top-1 wins per image |\n|---|---:|---:|\n`;
for (const [ax, s] of Object.entries(axisStats)) fl += `| ${ax} | ${s.mean_score.toFixed(3)} | ${s.top1_wins}/${IMAGES.length} |\n`;
fl += `\n## Binder dominance (which binder wins most often?)\n\n`;
fl += `| Binder | Top-1 wins per image |\n|---|---:|\n`;
for (const [b, s] of Object.entries(binderStats)) fl += `| ${b} | ${s.top1_wins_per_image}/${IMAGES.length} |\n`;
fl += `\n## Top 20 cross-image configs\n\n`;
fl += `| # | Top-10 | Top-3 | Top-1 | Mean | Worst rank | Config |\n|---:|---:|---:|---:|---:|---:|---|\n`;
for (let i = 0; i < 20 && i < configTable.length; i++) {
  const c = configTable[i];
  fl += `| ${i+1} | ${c.top10_hits}/${IMAGES.length} | ${c.top3_hits}/${IMAGES.length} | ${c.top1_hits}/${IMAGES.length} | ${c.mean_score.toFixed(3)} | ${c.max_rank} | ${c.axis}+${c.preproc}+${c.strategy}+${c.postproc} |\n`;
}
fs.writeFileSync(path.join(OUT_DIR, "finish-line.md"), fl);
console.log(`\nreports: ${OUT_DIR}`);
