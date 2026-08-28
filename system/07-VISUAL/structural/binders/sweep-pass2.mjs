#!/usr/bin/env bun
// Sweep Pass 2 — Pass-1 winners × 20 images.
//
// Reads `sweep-pass1/winners.json` (top 8 configs from Pass 1).
// Runs each on 20 images (10 Pass-1 images + up to 10 new).
// Watch for: a config that lands top-3 across all 20 = massive result.
//
// Writes: fixtures/sweep-pass2/analysis.md + metrics.json + top-3 overlays per image

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageLuminance } from "../luminance-ffmpeg.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "./preprocessing.mjs";
import { postprocess } from "./post-processing.mjs";
import { bindCombo } from "./combo.mjs";
import { bind as watershedBind } from "./watershed.mjs";
import { bind as densityBind }   from "./density-cluster.mjs";
import { bind as regionBind }    from "./region-grow.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT_DIR = path.join(FIXTURES, "sweep-pass2");
fs.mkdirSync(OUT_DIR, { recursive: true });

const winners = JSON.parse(fs.readFileSync(path.join(FIXTURES, "sweep-pass1", "winners.json"), "utf8"));
console.log(`loaded ${winners.length} winners from Pass 1`);

// Discover images: use whatever real .jpg/.png files exist in fixtures.
// This picks up whatever we fetched.
const CANDIDATES = [
  "fruits.jpg", "baboon.jpg", "messi5.jpg", "home.jpg", "starry_night.jpg",
  "lena.jpg", "apple.jpg", "orange.jpg", "building.jpg", "basketball1.png",
  "pic1.png", "pic2.png", "pic4.png", "pic5.png", "pic6.png",
  "butterfly.jpg", "board.jpg", "basketball2.png", "gradient.png", "notes.png",
];
const IMAGES = CANDIDATES
  .map((f) => ({ name: f.replace(/\.[^.]+$/, ""), file: f, path: path.join(FIXTURES, f) }))
  .filter((img) => fs.existsSync(img.path));
console.log(`found ${IMAGES.length} test images available on disk`);
console.log("");

async function runStrategy(strategy, R, w, h) {
  switch (strategy) {
    case "watershed":       return watershedBind(R, w, h, {});
    case "density-cluster": return densityBind(R, w, h, {});
    case "region-grow":     return regionBind(R, w, h, {});
    case "combo_union":     return bindCombo("combo_union",  R, w, h, {});
    case "combo_voting":    return bindCombo("combo_voting", R, w, h, {});
    case "combo_smart":     return bindCombo("combo_smart",  R, w, h, {});
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

async function drawOverlay(entities, srcImg, outPath) {
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const boxes = entities.slice().sort((a, b) => ((b.region?.[2] ?? 0) * (b.region?.[3] ?? 0)) - ((a.region?.[2] ?? 0) * (a.region?.[3] ?? 0))).slice(0, 12);
  const filters = boxes.map((e, i) => `drawbox=x=${e.region[0]}:y=${e.region[1]}:w=${e.region[2]}:h=${e.region[3]}:color=${colors[i % colors.length]}:thickness=2`).join(",");
  const proc = Bun.spawnSync({ cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", srcImg, "-vf", filters || "null", outPath] });
  return proc.exitCode === 0;
}

const results = []; // rows: {image, winner_rank, winner_config, entity_count, coverage, score}
const perImage = {}; // per-image ranking of all winners

const t0 = Date.now();
for (const img of IMAGES) {
  const { data, width, height } = await extractImageLuminance(img.path);
  const IMG_AREA = width * height;
  const L = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) L[i] = data[i] / 255;
  const pr = photoreceptorResponse(L, initAdaptationState(), null);
  const R_base = pr.R;

  const imgRes = [];
  for (let wi = 0; wi < winners.length; wi++) {
    const w = winners[wi];
    const { R2 } = preprocess(w.preproc, R_base, width, height);
    let rawEntities = [];
    try { rawEntities = (await runStrategy(w.strategy, R2, width, height)).entities || []; } catch {}
    const { entities } = postprocess(w.postproc, rawEntities, { frameArea: IMG_AREA });
    const areas = entities.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
    const totalArea = areas.reduce((a, b) => a + b, 0);
    const coverage = totalArea / IMG_AREA;
    const largest = areas.length ? Math.max(...areas) : 0;
    const largestFrac = largest / IMG_AREA;
    const sc = score(entities, coverage, largestFrac, IMG_AREA);
    imgRes.push({
      image: img.name, winner_idx: wi,
      config: `${w.preproc}+${w.strategy}+${w.postproc}`,
      entity_count: entities.length, coverage_frac: coverage, largest_frac: largestFrac, score: sc,
      entities,
    });
  }
  imgRes.sort((a, b) => b.score - a.score);
  perImage[img.name] = imgRes;
  results.push(...imgRes.map(r => ({ image: r.image, winner_idx: r.winner_idx, config: r.config, entity_count: r.entity_count, coverage_frac: Number(r.coverage_frac.toFixed(4)), largest_frac: Number(r.largest_frac.toFixed(4)), score: Number(r.score.toFixed(4)) })));

  // Overlay top-3 per image (writes ~60 pngs total = manageable)
  for (let i = 0; i < 3; i++) {
    const r = imgRes[i];
    const cfgSafe = r.config.replace(/[+/]/g, "_");
    await drawOverlay(r.entities, img.path, path.join(OUT_DIR, `${img.name}-r${i+1}-${cfgSafe}.png`));
  }
  console.log(`${img.name.padEnd(15)} best: rank=${imgRes[0].winner_idx+1} score=${imgRes[0].score.toFixed(3)} n=${imgRes[0].entity_count} — ${imgRes[0].config}`);
}
const totalMs = Date.now() - t0;

// Cross-image analysis: for each winner, count how often it landed in top-3 / top-5 / top-1
const winnerStats = winners.map((w, wi) => {
  const key = `${w.preproc}+${w.strategy}+${w.postproc}`;
  let top1 = 0, top3 = 0, top5 = 0;
  const ranks = [];
  const scores = [];
  for (const [imgName, imgRes] of Object.entries(perImage)) {
    const rank = imgRes.findIndex((r) => r.winner_idx === wi) + 1;
    ranks.push(rank);
    scores.push(imgRes.find((r) => r.winner_idx === wi).score);
    if (rank === 1) top1++;
    if (rank <= 3) top3++;
    if (rank <= 5) top5++;
  }
  return { winner_idx: wi, config: key, top1_hits: top1, top3_hits: top3, top5_hits: top5,
           mean_rank: ranks.reduce((a, b) => a + b, 0) / ranks.length,
           mean_score: scores.reduce((a, b) => a + b, 0) / scores.length };
});
winnerStats.sort((a, b) => b.top3_hits - a.top3_hits || a.mean_rank - b.mean_rank);

console.log("");
console.log(`=== PASS 2 done: ${results.length} experiments in ${(totalMs/1000).toFixed(1)}s ===`);
console.log("");
console.log(`=== WINNERS ranked by top-3 hit rate across ${IMAGES.length} images ===`);
for (const w of winnerStats) {
  console.log(`  rank=${(w.mean_rank).toFixed(1)}, top-1=${w.top1_hits}/${IMAGES.length}, top-3=${w.top3_hits}/${IMAGES.length}, top-5=${w.top5_hits}/${IMAGES.length}, mean_score=${w.mean_score.toFixed(3)}  ${w.config}`);
}

const universalTop3 = winnerStats.filter((w) => w.top3_hits === IMAGES.length);
if (universalTop3.length) {
  console.log("");
  console.log(`*** MASSIVE RESULT: ${universalTop3.length} config(s) landed top-3 on ALL ${IMAGES.length} images ***`);
  for (const u of universalTop3) console.log(`  ${u.config}`);
}

fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify({
  winners_source: winners,
  images: IMAGES.map((i) => i.name),
  total_experiments: results.length,
  wall_ms: totalMs,
  results,
  per_image_ranked: Object.fromEntries(Object.entries(perImage).map(([k, v]) => [k, v.map((r) => ({ config: r.config, winner_idx: r.winner_idx, entity_count: r.entity_count, score: r.score }))])),
  winner_stats: winnerStats,
}, null, 2));

let md = `# Sweep Pass 2 — winners × ${IMAGES.length} images\n\n${results.length} experiments in ${(totalMs/1000).toFixed(1)}s.\n\n`;
md += `## Cross-image winner ranking\n\n| Config | Top-1 | Top-3 | Top-5 | Mean rank | Mean score |\n|---|---:|---:|---:|---:|---:|\n`;
for (const w of winnerStats) md += `| ${w.config} | ${w.top1_hits}/${IMAGES.length} | ${w.top3_hits}/${IMAGES.length} | ${w.top5_hits}/${IMAGES.length} | ${w.mean_rank.toFixed(1)} | ${w.mean_score.toFixed(3)} |\n`;
md += `\n## Per-image best config\n\n| Image | Best config | Score |\n|---|---|---:|\n`;
for (const [n, r] of Object.entries(perImage)) md += `| ${n} | ${r[0].config} | ${r[0].score.toFixed(3)} |\n`;
fs.writeFileSync(path.join(OUT_DIR, "analysis.md"), md);
console.log("");
console.log(`analysis: ${path.join(OUT_DIR, "analysis.md")}`);
