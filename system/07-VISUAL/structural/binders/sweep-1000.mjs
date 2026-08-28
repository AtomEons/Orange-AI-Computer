#!/usr/bin/env bun
// AE Eyes — 1000-config sweep across 5 real images. Finds the pattern that
// generalizes: which (preproc, binder, postproc) combination consistently
// ranks in the top-10 on every image? If one exists, that's the light-string.
// If none does, perception is regime-dependent — honest report.
//
// Total configs: 10 preproc × 5 binders × 4 postproc × 5 images = 1000.
//
// Writes:
//   fixtures/binder-sweep-1000/metrics.json              — every row
//   fixtures/binder-sweep-1000/ranked-per-image.md       — top-15 per image
//   fixtures/binder-sweep-1000/cross-image-pattern.md    — the pattern found
//   fixtures/binder-sweep-1000/<img>-<config>-overlay.png  (only top-3 per image, to save disk)

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageLuminance } from "../luminance-ffmpeg.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess, PREPROCESSORS } from "./preprocessing.mjs";
import { postprocess, POSTPROCESSORS } from "./post-processing.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT_DIR = path.join(FIXTURES, "binder-sweep-1000");
fs.mkdirSync(OUT_DIR, { recursive: true });

const IMAGES = [
  { name: "fruits",        file: "fruits.jpg",        regime: "multi-object close-up" },
  { name: "baboon",        file: "baboon.jpg",        regime: "textured single subject" },
  { name: "messi5",        file: "messi5.jpg",        regime: "person in scene" },
  { name: "home",          file: "home.jpg",          regime: "indoor scene, clutter" },
  { name: "starry_night",  file: "starry_night.jpg",  regime: "painterly / high-frequency" },
];
const BINDERS = ["watershed", "density-cluster", "region-grow", "persistent-homology-lite", "predictive-error-grouping"];

console.log("=== AE Eyes sweep-1000 — 5 images × 10 preproc × 5 binder × 4 postproc ===");
console.log(`total configs: ${IMAGES.length * PREPROCESSORS.length * BINDERS.length * POSTPROCESSORS.length}`);
console.log("");

const binderCache = {};
async function loadBinder(name) {
  if (binderCache[name]) return binderCache[name];
  const mod = await import(path.join(__dir, `${name}.mjs`));
  binderCache[name] = mod;
  return mod;
}

// Composite score (directional, same as sweep-50).
function score(entities, coverageFrac, largestFrac) {
  const n = entities.length;
  if (n === 0) return 0;
  const countScore = n >= 4 && n <= 15 ? 1.0 : Math.max(0, 1 - Math.min(Math.abs(n - 8) / 15, 1));
  const covScore = coverageFrac >= 0.15 && coverageFrac <= 0.65 ? 1.0
    : Math.max(0, 1 - Math.abs(coverageFrac - 0.40) / 0.50);
  const giantScore = largestFrac >= 0.45 ? Math.max(0, 1 - (largestFrac - 0.45) / 0.5) : 1.0;
  return 0.40 * countScore + 0.30 * covScore + 0.30 * giantScore;
}

async function drawOverlay(entities, srcImg, outPath) {
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const boxes = entities
    .slice()
    .sort((a, b) => ((b.region?.[2] ?? 0) * (b.region?.[3] ?? 0)) - ((a.region?.[2] ?? 0) * (a.region?.[3] ?? 0)))
    .slice(0, 12);
  const filters = boxes.map((e, i) => {
    const r = e.region || [0, 0, 0, 0];
    const c = colors[i % colors.length];
    return `drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${c}:thickness=2`;
  }).join(",");
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", srcImg, "-vf", filters || "null", outPath],
  });
  return proc.exitCode === 0;
}

const allRows = [];
const perImage = {};
const t0 = Date.now();
let configIdx = 0;

for (const img of IMAGES) {
  const imgPath = path.join(FIXTURES, img.file);
  console.log(`\n--- image: ${img.name} (${img.regime}) ---`);
  const { data, width, height } = await extractImageLuminance(imgPath);
  const IMG_AREA = width * height;
  const L = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) L[i] = data[i] / 255;
  const pr = photoreceptorResponse(L, initAdaptationState(), null);
  const R_base = pr.R;
  console.log(`  ${width}x${height}, K=${pr.state.K.toFixed(4)}, meanL=${pr.meta.meanL.toFixed(3)}`);

  const imgRows = [];
  for (const preprocName of PREPROCESSORS) {
    const { R2 } = preprocess(preprocName, R_base, width, height);
    for (const binderName of BINDERS) {
      let rawEntities;
      const bindStart = Date.now();
      try {
        const mod = await loadBinder(binderName);
        const res = mod.bind(R2, width, height, {});
        rawEntities = Array.isArray(res?.entities) ? res.entities : [];
      } catch (e) {
        rawEntities = [];
      }
      const bindMs = Date.now() - bindStart;

      for (const postprocName of POSTPROCESSORS) {
        configIdx++;
        const { entities } = postprocess(postprocName, rawEntities, { frameArea: IMG_AREA });
        const areas = entities.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
        const totalArea = areas.reduce((a, b) => a + b, 0);
        const coverage = totalArea / IMG_AREA;
        const largest = areas.length ? Math.max(...areas) : 0;
        const largestFrac = largest / IMG_AREA;
        const sc = score(entities, coverage, largestFrac);
        const row = {
          image: img.name, preproc: preprocName, binder: binderName, postproc: postprocName,
          entity_count: entities.length,
          coverage_frac: Number(coverage.toFixed(4)),
          largest_frac: Number(largestFrac.toFixed(4)),
          score: Number(sc.toFixed(4)),
          bind_ms: bindMs,
        };
        allRows.push(row);
        imgRows.push({ ...row, entities });
      }
    }
  }

  // Sort this image's rows, remember the top-3 configs for overlay.
  imgRows.sort((a, b) => b.score - a.score);
  perImage[img.name] = imgRows;
  console.log(`  best score: ${imgRows[0].score.toFixed(3)} — ${imgRows[0].preproc}+${imgRows[0].binder}+${imgRows[0].postproc} (n=${imgRows[0].entity_count})`);

  // Overlays for top-3 (kept small — 15 images total instead of 1000).
  for (let i = 0; i < 3; i++) {
    const r = imgRows[i];
    const outPath = path.join(OUT_DIR, `${img.name}-top${i + 1}-${r.preproc}_${r.binder}_${r.postproc}-overlay.png`);
    await drawOverlay(r.entities, imgPath, outPath);
  }
}

const totalMs = Date.now() - t0;
console.log(`\n=== sweep done: ${configIdx} configs in ${(totalMs / 1000).toFixed(1)}s ===\n`);

// --- cross-image analysis: find configs that consistently rank well ---
// For each (preproc, binder, postproc) tuple, compute:
//   - mean score across images
//   - min score across images (worst-case)
//   - rank on each image
//   - top-10 hit rate (how many images this config lands in the top 10 on)
const configKey = (r) => `${r.preproc}::${r.binder}::${r.postproc}`;
const configStats = {};
const perImageRanked = {};
for (const [name, rows] of Object.entries(perImage)) {
  const sorted = rows.slice().sort((a, b) => b.score - a.score);
  perImageRanked[name] = sorted;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const k = configKey(r);
    if (!configStats[k]) configStats[k] = { config: { preproc: r.preproc, binder: r.binder, postproc: r.postproc }, scores: {}, ranks: {}, top10_count: 0 };
    configStats[k].scores[name] = r.score;
    configStats[k].ranks[name] = i + 1;
    if (i < 10) configStats[k].top10_count++;
  }
}

const configTable = Object.values(configStats).map((s) => {
  const scores = Object.values(s.scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return {
    preproc: s.config.preproc,
    binder: s.config.binder,
    postproc: s.config.postproc,
    top10_hit: s.top10_count,
    mean_score: Number(mean.toFixed(4)),
    min_score: Number(min.toFixed(4)),
    max_score: Number(max.toFixed(4)),
    scores: s.scores,
    ranks: s.ranks,
  };
});

// The "light-string pattern": config with highest top10_hit, then mean_score.
configTable.sort((a, b) => b.top10_hit - a.top10_hit || b.mean_score - a.mean_score);

// --- write reports ---
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify({
  total_configs: configIdx,
  wall_ms: totalMs,
  images: IMAGES,
  all_rows: allRows,
  per_image_top15: Object.fromEntries(Object.entries(perImageRanked).map(([k, v]) => [k, v.slice(0, 15).map(r => ({ preproc: r.preproc, binder: r.binder, postproc: r.postproc, entity_count: r.entity_count, coverage_frac: r.coverage_frac, largest_frac: r.largest_frac, score: r.score }))])),
  cross_image: configTable.slice(0, 30),
}, null, 2));

let md = "# AE Eyes sweep-1000 — the pattern search\n\n";
md += `1000 configurations swept across 5 images in ${(totalMs / 1000).toFixed(1)}s.\n\n`;
md += "## Cross-image pattern — configs that rank in the top-10 on the most images\n\n";
md += "| Top-10 hits | Preproc | Binder | Postproc | Mean score | Min score | Max score |\n";
md += "|---:|---|---|---|---:|---:|---:|\n";
for (let i = 0; i < Math.min(20, configTable.length); i++) {
  const c = configTable[i];
  md += `| ${c.top10_hit}/5 | ${c.preproc} | ${c.binder} | ${c.postproc} | ${c.mean_score.toFixed(3)} | ${c.min_score.toFixed(3)} | ${c.max_score.toFixed(3)} |\n`;
}
md += "\n## Per-image top 5 (verify the pattern makes sense per image)\n\n";
for (const [name, rows] of Object.entries(perImageRanked)) {
  md += `\n### ${name} (${IMAGES.find(i => i.name === name).regime})\n\n`;
  md += "| Rank | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |\n";
  md += "|---:|---|---|---|---:|---:|---:|---:|\n";
  for (let i = 0; i < 5; i++) {
    const r = rows[i];
    md += `| ${i + 1} | ${r.preproc} | ${r.binder} | ${r.postproc} | ${r.entity_count} | ${(r.coverage_frac * 100).toFixed(1)} | ${(r.largest_frac * 100).toFixed(1)} | ${r.score.toFixed(3)} |\n`;
  }
}
fs.writeFileSync(path.join(OUT_DIR, "ranked-per-image.md"), md);

// Cross-image pattern honest interpretation
let pattern = "# The cross-image pattern (honest reading)\n\n";
const winner = configTable[0];
pattern += `**Top config by top-10-hit + mean score:** ${winner.preproc} + ${winner.binder} + ${winner.postproc}\n\n`;
pattern += `- Ranked in the top-10 on ${winner.top10_hit}/${IMAGES.length} images.\n`;
pattern += `- Mean score: ${winner.mean_score.toFixed(3)} (min ${winner.min_score.toFixed(3)}, max ${winner.max_score.toFixed(3)}).\n\n`;
if (winner.top10_hit === IMAGES.length) {
  pattern += "**Verdict: THE PATTERN EXISTS.** This single config lands in the top-10 across every regime tested. Perception is not regime-dependent at this level.\n";
} else if (winner.top10_hit >= IMAGES.length - 1) {
  pattern += "**Verdict: pattern with one exception.** Nearly universal — one regime breaks it. Honest: not quite perfection, close.\n";
} else {
  pattern += "**Verdict: perception is regime-dependent** at this level of testing. No single config dominates all 5 image types. This is honest information — the light-string is a *family* of configs, not one. See per-image ranking to route by regime.\n";
}
pattern += `\n## Top-3 configs (by top-10-hit)\n\n`;
for (let i = 0; i < Math.min(3, configTable.length); i++) {
  const c = configTable[i];
  pattern += `${i + 1}. ${c.preproc} + ${c.binder} + ${c.postproc} — ${c.top10_hit}/5 top-10 hits, mean ${c.mean_score.toFixed(3)}\n`;
}
fs.writeFileSync(path.join(OUT_DIR, "cross-image-pattern.md"), pattern);

console.log("=== CROSS-IMAGE TOP 5 ===");
for (let i = 0; i < 5 && i < configTable.length; i++) {
  const c = configTable[i];
  console.log(`  #${i + 1}: ${c.preproc}+${c.binder}+${c.postproc} → ${c.top10_hit}/5 top-10 hits, mean ${c.mean_score.toFixed(3)}`);
}
console.log("");
console.log(`reports written to: ${OUT_DIR}`);
