#!/usr/bin/env bun
// Standard test harness for any object-binder — runs it on fruits.jpg,
// reports metrics, and generates a debug overlay via ffmpeg drawbox so the
// entity boxes can be visually scored.
//
// Usage:  bun run-on-fruits.mjs <binder-module>
// Example: bun run-on-fruits.mjs ./watershed.mjs
//
// Requires ffmpeg. Deterministic. Prints a Summary line.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageLuminance } from "../luminance-ffmpeg.mjs";
import {
  initAdaptationState,
  photoreceptorResponse,
} from "../photoreceptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const IMG = path.join(FIXTURES, "fruits.jpg");

const binderPath = process.argv[2];
if (!binderPath) {
  console.error("usage: bun run-on-fruits.mjs <binder-module>");
  process.exit(2);
}
const binderAbs = path.isAbsolute(binderPath) ? binderPath : path.resolve(process.cwd(), binderPath);

const mod = await import(binderAbs);
if (typeof mod.bind !== "function") {
  console.error(`binder ${binderPath} does not export bind()`);
  process.exit(2);
}
const discipline = mod.DISCIPLINE || path.basename(binderPath).replace(/\.mjs$/, "");

console.log(`=== AE Eyes binder trial — ${discipline} — fruits.jpg ===`);

const t0 = Date.now();
const { data, width, height } = await extractImageLuminance(IMG);
const L = new Float32Array(data.length);
for (let i = 0; i < data.length; i++) L[i] = data[i] / 255;

// Photoreceptor stage — the SAME R for every binder.
const prState = initAdaptationState();
const pr = photoreceptorResponse(L, prState, null);
const R = pr.R;

const bindStart = Date.now();
const result = mod.bind(R, width, height, {});
const bindMs = Date.now() - bindStart;
const totalMs = Date.now() - t0;

if (!result || !Array.isArray(result.entities)) {
  console.error(`binder returned invalid result: ${JSON.stringify(result).slice(0, 200)}`);
  process.exit(1);
}
const entities = result.entities;

// --- metrics ---
const IMG_AREA = width * height;
const areas = entities.map((e) => {
  const r = e.region || [0, 0, 0, 0];
  return r[2] * r[3];
});
const totalArea = areas.reduce((a, b) => a + b, 0);
const coverage = totalArea / IMG_AREA;

// top 5 largest
const sorted = entities
  .map((e, i) => ({ e, i, area: areas[i] }))
  .sort((a, b) => b.area - a.area)
  .slice(0, 5);

console.log(`\nphotoreceptor K=${pr.state.K.toFixed(4)}, meanL=${pr.meta.meanL.toFixed(3)}, saturated=${(pr.meta.saturatedFraction * 100).toFixed(1)}%`);
console.log(`bind took ${bindMs}ms (total incl. i/o: ${totalMs}ms)`);
console.log(`entities: ${entities.length}, total coverage: ${(coverage * 100).toFixed(1)}% of frame`);
console.log(`\ntop-5 largest entities:`);
for (const { e, area } of sorted) {
  const r = e.region || [0, 0, 0, 0];
  const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
  const fx = ((cx / width) * 100).toFixed(0);
  const fy = ((cy / height) * 100).toFixed(0);
  const pct = ((area / IMG_AREA) * 100).toFixed(2);
  console.log(`  #${e.id}: (${r[0]},${r[1]}) ${r[2]}x${r[3]} · ${pct}% of frame · center@ ${fx}%x, ${fy}%y`);
}

const binderNotes = Array.isArray(result.notes) ? result.notes : [];
if (binderNotes.length) {
  console.log(`\nbinder honest notes:`);
  for (const n of binderNotes) console.log(`  · ${n}`);
}

// --- debug overlay via ffmpeg drawbox ---
const overlayPath = path.join(FIXTURES, `binder-overlay-${discipline}.png`);
try {
  // Build a drawbox chain: one -vf drawbox per top-15 entity, distinct colors.
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const boxEntities = entities
    .map((e, i) => ({ e, area: areas[i] }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 15);
  const filters = boxEntities
    .map(({ e }, i) => {
      const r = e.region || [0, 0, 0, 0];
      const c = colors[i % colors.length];
      return `drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${c}:thickness=2`;
    })
    .join(",");
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", IMG, "-vf", filters || "null", overlayPath],
  });
  if (proc.exitCode === 0 && fs.existsSync(overlayPath)) {
    console.log(`\ndebug overlay: ${overlayPath}`);
  } else {
    console.log(`\ndebug overlay: FAILED (ffmpeg exit ${proc.exitCode})`);
  }
} catch (e) {
  console.log(`\ndebug overlay: FAILED (${e.message})`);
}

console.log(`\nSummary: ${discipline} produced ${entities.length} entities, ${(coverage * 100).toFixed(1)}% coverage, in ${bindMs}ms`);
