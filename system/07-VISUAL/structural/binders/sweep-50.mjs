#!/usr/bin/env bun
// AE Eyes — 50-config sweep on fruits.jpg.
//
// Axes:
//   preprocessor  ∈ {identity, gaussian_1, gaussian_3, median_3, log_normalize}   (5)
//   primary_binder∈ {watershed, density-cluster, region-grow,
//                    persistent-homology-lite, predictive-error-grouping}         (5)
//   post_processor∈ {identity, merge_overlap}                                     (2)
// Total: 5 × 5 × 2 = 50 configs.
//
// For each config: run pipeline, compute metrics, emit overlay png, log a row.
// Then rank by composite score. Writes:
//   fixtures/binder-sweep-50/<config-id>-overlay.png     (visual)
//   fixtures/binder-sweep-50/sweep-50-metrics.json       (all rows)
//   fixtures/binder-sweep-50/sweep-50-ranked.md          (human-readable rank)

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageLuminance } from "../luminance-ffmpeg.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess, PREPROCESSORS } from "./preprocessing.mjs";
import { postprocess, POSTPROCESSORS } from "./post-processing.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.resolve(__dir, "..", "..", "fixtures", "fruits.jpg");
const OUT_DIR = path.resolve(__dir, "..", "..", "fixtures", "binder-sweep-50");
fs.mkdirSync(OUT_DIR, { recursive: true });

const BINDERS = [
  "watershed",
  "density-cluster",
  "region-grow",
  "persistent-homology-lite",
  "predictive-error-grouping",
];

console.log("=== AE Eyes sweep — 50 configs on fruits.jpg ===");
console.log(`preprocessors: ${PREPROCESSORS.join(", ")}`);
console.log(`binders:       ${BINDERS.join(", ")}`);
console.log(`postprocs:     ${POSTPROCESSORS.join(", ")}`);
console.log(`total configs: ${PREPROCESSORS.length * BINDERS.length * POSTPROCESSORS.length}`);
console.log("");

// One-time image load + photoreceptor.
const { data, width, height } = await extractImageLuminance(IMG);
const IMG_AREA = width * height;
const L = new Float32Array(data.length);
for (let i = 0; i < data.length; i++) L[i] = data[i] / 255;
const prState = initAdaptationState();
const pr = photoreceptorResponse(L, prState, null);
const R_base = pr.R;
console.log(`image: ${width}x${height}, K=${pr.state.K.toFixed(4)}, meanL=${pr.meta.meanL.toFixed(3)}`);
console.log("");

// Lazy-load binders on demand.
const binderCache = {};
async function loadBinder(name) {
  if (binderCache[name]) return binderCache[name];
  const mod = await import(path.join(__dir, `${name}.mjs`));
  if (typeof mod.bind !== "function") throw new Error(`binder ${name} has no bind()`);
  binderCache[name] = mod;
  return mod;
}

// Composite score. Not benchmark-tied; directional.
//   good entity count 4–12
//   good coverage 20–60% of frame
//   penalize a giant single box > 40% of frame
//   penalize zero entities
function score(entities, coverageFrac, largestFrac) {
  let s = 0;
  const n = entities.length;
  if (n === 0) return { total: 0, breakdown: { count: 0, coverage: 0, giant: 0 } };
  const countScore = n >= 4 && n <= 12 ? 1.0 : Math.max(0, 1 - Math.min(Math.abs(n - 8) / 12, 1));
  const covScore = coverageFrac >= 0.20 && coverageFrac <= 0.60 ? 1.0
    : Math.max(0, 1 - Math.abs(coverageFrac - 0.40) / 0.40);
  const giantScore = largestFrac >= 0.40 ? Math.max(0, 1 - (largestFrac - 0.40) / 0.5) : 1.0;
  s = 0.40 * countScore + 0.30 * covScore + 0.30 * giantScore;
  return { total: s, breakdown: { count: countScore, coverage: covScore, giant: giantScore } };
}

async function drawOverlay(entities, outPath) {
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const boxes = entities
    .slice()
    .sort((a, b) => ((b.region?.[2] ?? 0) * (b.region?.[3] ?? 0)) - ((a.region?.[2] ?? 0) * (a.region?.[3] ?? 0)))
    .slice(0, 15);
  const filters = boxes.map((e, i) => {
    const r = e.region || [0, 0, 0, 0];
    const c = colors[i % colors.length];
    return `drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${c}:thickness=2`;
  }).join(",");
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", IMG, "-vf", filters || "null", outPath],
  });
  return proc.exitCode === 0;
}

const rows = [];
let idx = 0;
const t0 = Date.now();

for (const preprocName of PREPROCESSORS) {
  for (const binderName of BINDERS) {
    for (const postprocName of POSTPROCESSORS) {
      idx++;
      const configId = `c${String(idx).padStart(2, "0")}_${preprocName}_${binderName}_${postprocName}`;
      const cfgStart = Date.now();

      // Preprocess R.
      const { R2, notes: prepNotes } = preprocess(preprocName, R_base, width, height);

      // Bind.
      let binderResult;
      try {
        const mod = await loadBinder(binderName);
        binderResult = mod.bind(R2, width, height, {});
      } catch (e) {
        console.log(`  [FAIL] ${configId}: bind threw ${e.message}`);
        rows.push({ configId, error: e.message });
        continue;
      }
      const rawEntities = Array.isArray(binderResult?.entities) ? binderResult.entities : [];

      // Post-process.
      const { entities, notes: postNotes } = postprocess(postprocName, rawEntities);

      // Metrics.
      const areas = entities.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
      const totalArea = areas.reduce((a, b) => a + b, 0);
      const coverage = totalArea / IMG_AREA;
      const largest = areas.length ? Math.max(...areas) : 0;
      const largestFrac = largest / IMG_AREA;
      const sc = score(entities, coverage, largestFrac);
      const cfgMs = Date.now() - cfgStart;

      // Overlay.
      const overlayPath = path.join(OUT_DIR, `${configId}-overlay.png`);
      const overlayOk = await drawOverlay(entities, overlayPath);

      const row = {
        idx,
        configId,
        preproc: preprocName,
        binder: binderName,
        postproc: postprocName,
        entity_count: entities.length,
        coverage_frac: Number(coverage.toFixed(4)),
        largest_frac: Number(largestFrac.toFixed(4)),
        score: Number(sc.total.toFixed(4)),
        score_breakdown: sc.breakdown,
        ms: cfgMs,
        overlay_ok: overlayOk,
        notes_head: [...prepNotes, ...(binderResult?.notes || []), ...postNotes].slice(0, 4),
      };
      rows.push(row);

      const flag = sc.total >= 0.85 ? "★" : sc.total >= 0.7 ? "•" : " ";
      console.log(
        `  ${flag} #${String(idx).padStart(2, "0")} ${preprocName.padEnd(14)} ${binderName.padEnd(26)} ${postprocName.padEnd(14)} ` +
        `n=${String(entities.length).padStart(3)} cov=${(coverage*100).toFixed(1).padStart(5)}% ` +
        `max=${(largestFrac*100).toFixed(1).padStart(5)}% score=${sc.total.toFixed(3)} ${cfgMs}ms`
      );
    }
  }
}

const totalMs = Date.now() - t0;
console.log("");
console.log(`sweep done: ${idx} configs in ${totalMs}ms`);

// Rank & write.
const ranked = rows
  .filter((r) => !r.error)
  .sort((a, b) => b.score - a.score);

fs.writeFileSync(
  path.join(OUT_DIR, "sweep-50-metrics.json"),
  JSON.stringify({ image: IMG, w: width, h: height, generated_at: totalMs, rows }, null, 2),
);

let md = "# AE Eyes sweep 50 — ranked results on fruits.jpg\n\n";
md += `Image: ${width}x${height}, generated in ${totalMs}ms.\n\n`;
md += "| Rank | Config | Preproc | Binder | Postproc | N | Cov% | MaxBox% | Score |\n";
md += "|---:|---|---|---|---|---:|---:|---:|---:|\n";
for (let i = 0; i < Math.min(15, ranked.length); i++) {
  const r = ranked[i];
  md += `| ${i + 1} | ${r.configId} | ${r.preproc} | ${r.binder} | ${r.postproc} | ${r.entity_count} | ${(r.coverage_frac * 100).toFixed(1)} | ${(r.largest_frac * 100).toFixed(1)} | ${r.score.toFixed(3)} |\n`;
}
md += "\n## Overlay images\n\nTop-3 overlay PNGs to visually verify:\n";
for (let i = 0; i < Math.min(3, ranked.length); i++) {
  md += `${i + 1}. \`fixtures/binder-sweep-50/${ranked[i].configId}-overlay.png\` (score ${ranked[i].score.toFixed(3)})\n`;
}
fs.writeFileSync(path.join(OUT_DIR, "sweep-50-ranked.md"), md);

console.log("");
console.log("=== TOP 5 CONFIGS ===");
for (let i = 0; i < Math.min(5, ranked.length); i++) {
  const r = ranked[i];
  console.log(`  #${i + 1}: ${r.configId} → n=${r.entity_count}, cov=${(r.coverage_frac*100).toFixed(1)}%, max=${(r.largest_frac*100).toFixed(1)}%, score=${r.score.toFixed(3)}`);
}
console.log("");
console.log(`metrics json: ${path.join(OUT_DIR, "sweep-50-metrics.json")}`);
console.log(`ranked md:    ${path.join(OUT_DIR, "sweep-50-ranked.md")}`);
