#!/usr/bin/env bun
// Sweep Pass 1 — 50 configs × 10 images = 500 experiments.
//
// Design (data-driven, dropping the dead preprocessors identified in sweep-1000):
//   5 preprocessors × 5 binder strategies × 2 postprocs = 50 configs.
//
//   preprocessors: identity, gaussian_1, gaussian_2, median_3, median_5
//   binder strategies:
//     watershed       - baseline
//     density-cluster - baseline
//     region-grow     - baseline
//     combo_union     - the combo (union with dedup)
//     combo_voting    - the combo (≥2-binder agreement)
//   postprocessors: identity, merge_overlap
//
// Writes:
//   fixtures/sweep-pass1/metrics.json
//   fixtures/sweep-pass1/analysis.md
//   fixtures/sweep-pass1/winners.json  ← used by pass 2

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
const OUT_DIR = path.join(FIXTURES, "sweep-pass1");
fs.mkdirSync(OUT_DIR, { recursive: true });

const IMAGES = [
  { name: "fruits",       file: "fruits.jpg",       regime: "multi-object close-up" },
  { name: "baboon",       file: "baboon.jpg",       regime: "textured single subject" },
  { name: "messi5",       file: "messi5.jpg",       regime: "person in scene" },
  { name: "home",         file: "home.jpg",         regime: "indoor cluttered" },
  { name: "starry_night", file: "starry_night.jpg", regime: "painterly" },
  { name: "lena",         file: "lena.jpg",         regime: "portrait" },
  { name: "apple",        file: "apple.jpg",        regime: "single object close-up" },
  { name: "orange",       file: "orange.jpg",       regime: "single object close-up" },
  { name: "building",     file: "building.jpg",     regime: "architecture" },
  { name: "basketball1",  file: "basketball1.png",  regime: "sports action" },
];

const PREPROCS  = ["identity", "gaussian_1", "gaussian_2", "median_3", "median_5"];
const STRATEGIES = ["watershed", "density-cluster", "region-grow", "combo_union", "combo_voting"];
const POSTPROCS  = ["identity", "merge_overlap"];

console.log(`=== SWEEP PASS 1 — ${PREPROCS.length} × ${STRATEGIES.length} × ${POSTPROCS.length} = ${PREPROCS.length*STRATEGIES.length*POSTPROCS.length} configs × ${IMAGES.length} images = ${PREPROCS.length*STRATEGIES.length*POSTPROCS.length*IMAGES.length} experiments ===`);
console.log("");

async function runBinder(strategy, R, w, h) {
  switch (strategy) {
    case "watershed":       return watershedBind(R, w, h, {});
    case "density-cluster": return densityBind(R, w, h, {});
    case "region-grow":     return regionBind(R, w, h, {});
    case "combo_union":     return bindCombo("combo_union",  R, w, h, {});
    case "combo_voting":    return bindCombo("combo_voting", R, w, h, {});
    case "combo_smart":     return bindCombo("combo_smart",  R, w, h, {});
  }
  throw new Error(`unknown strategy: ${strategy}`);
}

// A stronger score — penalize scanline-swallowing, reward mid-count entities
// AND reward entities of similar size (real objects tend to be within a bounded
// size range for a given image, not one giant + many tiny).
function score(entities, coverageFrac, largestFrac, IMG_AREA) {
  const n = entities.length;
  if (n === 0) return { total: 0, comp: { count: 0, cov: 0, giant: 0, size_var: 0 } };
  const countScore = n >= 4 && n <= 15 ? 1.0 : Math.max(0, 1 - Math.min(Math.abs(n - 8) / 15, 1));
  const covScore = coverageFrac >= 0.15 && coverageFrac <= 0.65 ? 1.0
    : Math.max(0, 1 - Math.abs(coverageFrac - 0.40) / 0.50);
  const giantScore = largestFrac >= 0.45 ? Math.max(0, 1 - (largestFrac - 0.45) / 0.5) : 1.0;
  // Size-variance component: reward when entities have similar size (log-scale variance)
  const areas = entities.map((e) => Math.log((e.region?.[2] ?? 1) * (e.region?.[3] ?? 1) / IMG_AREA + 1e-6));
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
  const varLog = areas.reduce((s, v) => s + (v - mean) ** 2, 0) / areas.length;
  // Lower variance = more consistent sizes. Score is 1 when varLog ≤ 1, drops off.
  const sizeVarScore = varLog <= 1 ? 1 : Math.max(0, 1 - (varLog - 1) / 4);
  const total = 0.30 * countScore + 0.25 * covScore + 0.25 * giantScore + 0.20 * sizeVarScore;
  return { total, comp: { count: countScore, cov: covScore, giant: giantScore, size_var: sizeVarScore } };
}

const allRows = [];
const perImageRows = {};
const t0 = Date.now();

for (const img of IMAGES) {
  const imgPath = path.join(FIXTURES, img.file);
  console.log(`\n--- image: ${img.name} (${img.regime}) ---`);
  const { data, width, height } = await extractImageLuminance(imgPath);
  const IMG_AREA = width * height;
  const L = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) L[i] = data[i] / 255;
  const pr = photoreceptorResponse(L, initAdaptationState(), null);
  const R_base = pr.R;

  const imgResults = [];
  for (const preprocName of PREPROCS) {
    const { R2 } = preprocess(preprocName, R_base, width, height);
    for (const strategyName of STRATEGIES) {
      let rawEntities = [];
      const t = Date.now();
      try {
        const res = await runBinder(strategyName, R2, width, height);
        rawEntities = res.entities || [];
      } catch (e) {}
      const bindMs = Date.now() - t;
      for (const postprocName of POSTPROCS) {
        const { entities } = postprocess(postprocName, rawEntities, { frameArea: IMG_AREA });
        const areas = entities.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
        const totalArea = areas.reduce((a, b) => a + b, 0);
        const coverage = totalArea / IMG_AREA;
        const largest = areas.length ? Math.max(...areas) : 0;
        const largestFrac = largest / IMG_AREA;
        const sc = score(entities, coverage, largestFrac, IMG_AREA);
        const row = {
          image: img.name, preproc: preprocName, strategy: strategyName, postproc: postprocName,
          entity_count: entities.length,
          coverage_frac: Number(coverage.toFixed(4)),
          largest_frac: Number(largestFrac.toFixed(4)),
          score: Number(sc.total.toFixed(4)),
          size_var: Number(sc.comp.size_var.toFixed(4)),
          bind_ms: bindMs,
        };
        allRows.push(row);
        imgResults.push(row);
      }
    }
  }
  imgResults.sort((a, b) => b.score - a.score);
  perImageRows[img.name] = imgResults;
  const top = imgResults[0];
  console.log(`  best: ${top.strategy}+${top.preproc}+${top.postproc} score=${top.score.toFixed(3)} n=${top.entity_count} cov=${(top.coverage_frac*100).toFixed(1)}%`);
}

const totalMs = Date.now() - t0;
console.log(`\n=== pass-1 sweep done: ${allRows.length} experiments in ${(totalMs/1000).toFixed(1)}s ===\n`);

// --- cross-image analysis ---
const configKey = (r) => `${r.preproc}::${r.strategy}::${r.postproc}`;
const configStats = {};
for (const [name, rows] of Object.entries(perImageRows)) {
  rows.forEach((r, i) => {
    const k = configKey(r);
    if (!configStats[k]) configStats[k] = { preproc: r.preproc, strategy: r.strategy, postproc: r.postproc, ranks: {}, scores: {}, top5: 0, top10: 0 };
    configStats[k].ranks[name] = i + 1;
    configStats[k].scores[name] = r.score;
    if (i < 5) configStats[k].top5++;
    if (i < 10) configStats[k].top10++;
  });
}
const configTable = Object.values(configStats).map((s) => {
  const scores = Object.values(s.scores);
  const ranks = Object.values(s.ranks);
  return {
    ...s,
    top5_hits: s.top5,
    top10_hits: s.top10,
    mean_score: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)),
    min_score:  Number(Math.min(...scores).toFixed(4)),
    max_rank:   Math.max(...ranks),
    mean_rank:  Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)),
  };
});
configTable.sort((a, b) => b.top10_hits - a.top10_hits || b.mean_score - a.mean_score);

const top10Universal = configTable.filter((c) => c.top10_hits === IMAGES.length);
const top10AtLeast8 = configTable.filter((c) => c.top10_hits >= 8);
console.log(`configs in top-10 of all ${IMAGES.length} images: ${top10Universal.length}`);
console.log(`configs in top-10 of ≥8 images: ${top10AtLeast8.length}`);
console.log("");
console.log("=== CROSS-IMAGE TOP 10 (by top-10 hit rate then mean score) ===");
for (let i = 0; i < Math.min(10, configTable.length); i++) {
  const c = configTable[i];
  console.log(`  #${i + 1}: ${c.top10_hits}/${IMAGES.length} top-10, mean=${c.mean_score.toFixed(3)}, worst_rank=${c.max_rank}  ${c.preproc}+${c.strategy}+${c.postproc}`);
}

// Write outputs
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify({
  images: IMAGES,
  preprocs: PREPROCS,
  strategies: STRATEGIES,
  postprocs: POSTPROCS,
  total_experiments: allRows.length,
  wall_ms: totalMs,
  all_rows: allRows,
  per_image_ranked: Object.fromEntries(Object.entries(perImageRows).map(([k, v]) => [k, v.slice(0, 20)])),
  cross_image_table: configTable,
}, null, 2));

// Winners for Pass 2 (top 8 by top-10 hits, then top by mean score if tied)
const WINNERS_N = 8;
const winners = configTable.slice(0, WINNERS_N);
fs.writeFileSync(path.join(OUT_DIR, "winners.json"), JSON.stringify(winners, null, 2));

let md = `# Sweep Pass 1 — analysis\n\n`;
md += `${allRows.length} experiments (${PREPROCS.length*STRATEGIES.length*POSTPROCS.length} configs × ${IMAGES.length} images) in ${(totalMs/1000).toFixed(1)}s.\n\n`;
md += `## Universal configs (top-10 on all ${IMAGES.length} images)\n\n`;
md += top10Universal.length === 0 ? "**None.** No config lands in top-10 across every image.\n\n" :
  top10Universal.slice(0, 10).map((c, i) => `${i+1}. ${c.preproc} + ${c.strategy} + ${c.postproc} (mean ${c.mean_score.toFixed(3)}, min ${c.min_score.toFixed(3)})`).join("\n") + "\n\n";
md += `## Near-universal (top-10 on ≥8 images)\n\n`;
md += top10AtLeast8.slice(0, 15).map((c, i) => `${i+1}. ${c.top10_hits}/${IMAGES.length} — ${c.preproc} + ${c.strategy} + ${c.postproc} (mean ${c.mean_score.toFixed(3)})`).join("\n") + "\n\n";
md += `## Winners chosen for Pass 2 (top ${WINNERS_N})\n\n`;
md += winners.map((c, i) => `${i+1}. ${c.preproc} + ${c.strategy} + ${c.postproc} — top-10 ${c.top10_hits}/${IMAGES.length}, mean ${c.mean_score.toFixed(3)}`).join("\n") + "\n";
fs.writeFileSync(path.join(OUT_DIR, "analysis.md"), md);

console.log("");
console.log(`analysis:   ${path.join(OUT_DIR, "analysis.md")}`);
console.log(`winners:    ${path.join(OUT_DIR, "winners.json")}`);
console.log(`metrics:    ${path.join(OUT_DIR, "metrics.json")}`);
