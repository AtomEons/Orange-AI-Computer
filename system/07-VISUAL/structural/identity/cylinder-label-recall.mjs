#!/usr/bin/env bun
// Cylinder label recall — the metric that matters.
//
// The 100k needle-identity metric on the earlier knot stress was
// misleading: at 100k with 55k orange_synth signatures near the same
// prototype, no specific 0.03-jitter needle is the actual nearest
// neighbor. The real question is "does the winning LABEL match?"
//
// This test: 100,000 synthetic signatures on the cylinder index, then
// 1,000 held-out probes (500 orange, 500 apple). Report:
//   - Label recall (top-1 accuracy)
//   - Latency distribution p50/p95/p99
//   - Bytes per signature at scale

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CylinderIndex } from "./cylinder-index.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "cylinder-100k-labels");
fs.mkdirSync(OUT, { recursive: true });

const STORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));
const orangePrototype = STORE.labels.find(l => l.label === "orange").signatures[0].sig;
const applePrototype = STORE.labels.find(l => l.label === "apple").signatures[0].sig;

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function seededGaussian(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function perturbSig(base, rng, jitter = 0.10) {
  const s = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(s.color)) {
    if (typeof s.color[k] === "number") {
      s.color[k] += seededGaussian(rng) * jitter * Math.max(0.05, Math.abs(s.color[k]));
    }
  }
  s.edge.meanEnergy = Math.max(0, s.edge.meanEnergy + seededGaussian(rng) * jitter * 0.1);
  s.edge.orientationEntropy = Math.max(0, s.edge.orientationEntropy + seededGaussian(rng) * jitter);
  for (let i = 0; i < s.edge.orientationHistogram.length; i++) {
    s.edge.orientationHistogram[i] = Math.max(0, s.edge.orientationHistogram[i] + seededGaussian(rng) * jitter * 0.1);
  }
  s.texture.meanVariance = Math.max(1e-6, s.texture.meanVariance + seededGaussian(rng) * jitter * 0.05);
  s.texture.lbpEntropy = Math.max(0, s.texture.lbpEntropy + seededGaussian(rng) * jitter);
  s.specular.cov += seededGaussian(rng) * jitter * 0.1;
  s.specular.glossinessScore = Math.max(0, s.specular.glossinessScore + seededGaussian(rng) * jitter * 0.05);
  s.specular.brightFraction = Math.max(0, s.specular.brightFraction + seededGaussian(rng) * jitter * 0.05);
  for (let i = 0; i < s.spatial.cells.length; i++) {
    s.spatial.cells[i] = Math.max(0, Math.min(1, s.spatial.cells[i] + seededGaussian(rng) * jitter * 0.1));
  }
  return s;
}

const N = 100_000;
console.log(`=== CYLINDER 100k LABEL RECALL ===\n`);
console.log(`ingesting ${N.toLocaleString()} synthetic signatures...`);

const idx = new CylinderIndex();
const rng = mulberry32(1337);
let orangeCount = 0, appleCount = 0, offCount = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const roll = rng();
  let base, label;
  if (roll < 0.55) { base = orangePrototype; label = "orange"; orangeCount++; }
  else if (roll < 0.85) { base = applePrototype; label = "apple"; appleCount++; }
  else {
    base = rng() < 0.5 ? orangePrototype : applePrototype;
    label = "off"; offCount++;
  }
  const jitter = label === "off" ? 0.6 : 0.15;
  idx.add(perturbSig(base, rng, jitter), { label, id: "s" + i });
  if ((i + 1) % 25000 === 0) {
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${((i + 1) / 1000).toFixed(0)}k in  ${((i + 1) / el).toFixed(0)} sigs/sec`);
  }
}
const ingestSec = (Date.now() - t0) / 1000;
console.log(`\ningested ${N.toLocaleString()} in ${ingestSec.toFixed(1)}s → ${(N / ingestSec).toFixed(0)} sigs/sec`);
console.log(`label mix: orange=${orangeCount.toLocaleString()}, apple=${appleCount.toLocaleString()}, off=${offCount.toLocaleString()}`);

// Force _sorted build (one-time cost)
const tSortStart = Date.now();
idx._rebuild();
const sortSec = (Date.now() - tSortStart) / 1000;
console.log(`sort-by-theta: ${sortSec.toFixed(1)}s (one-time)`);

// ── Label recall test ──
console.log(`\nrunning 1000 label-recall probes...`);
const probes = 1000;
let orangeCorrect = 0, appleCorrect = 0;
const latencies = new Float32Array(probes);
for (let q = 0; q < probes; q++) {
  const useOrange = q < probes / 2;
  const probe = perturbSig(useOrange ? orangePrototype : applePrototype, mulberry32(90000 + q), 0.15);
  const tQ = performance.now();
  const ranking = idx.queryConcepts(probe, { kProbes: 40 });
  latencies[q] = performance.now() - tQ;
  const top = ranking[0]?.label;
  if (useOrange && top === "orange") orangeCorrect++;
  else if (!useOrange && top === "apple") appleCorrect++;
}
const sorted = Array.from(latencies).sort((a, b) => a - b);
const p50 = sorted[Math.floor(probes * 0.50)];
const p95 = sorted[Math.floor(probes * 0.95)];
const p99 = sorted[Math.floor(probes * 0.99)];
const meanL = sorted.reduce((a, b) => a + b, 0) / probes;
const orangeRecall = orangeCorrect / (probes / 2);
const appleRecall = appleCorrect / (probes / 2);

// ── Persist ──
const savePath = path.join(OUT, "cylinder-100k.json");
const tSaveStart = Date.now();
idx.save(savePath);
const saveSec = (Date.now() - tSaveStart) / 1000;
const diskBytes = fs.statSync(savePath).size;

console.log(`\n=== RESULTS ===`);
console.log(`ingest throughput:   ${(N / ingestSec).toFixed(0)} sigs/sec`);
console.log(`query latency:       mean=${meanL.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms`);
console.log(`orange label recall: ${(orangeRecall * 100).toFixed(1)}%  (${orangeCorrect}/${probes/2})`);
console.log(`apple label recall:  ${(appleRecall * 100).toFixed(1)}%  (${appleCorrect}/${probes/2})`);
console.log(`combined:            ${((orangeCorrect + appleCorrect) / probes * 100).toFixed(1)}%`);
console.log(`disk footprint:      ${(diskBytes / (1024*1024)).toFixed(1)} MB  (${(diskBytes / N).toFixed(0)} B/sig)`);

const summary = {
  N,
  ingest_seconds: ingestSec,
  ingest_throughput_sigs_per_sec: N / ingestSec,
  sort_seconds: sortSec,
  latency_ms: { mean: meanL, p50, p95, p99, max: sorted[probes - 1] },
  label_recall: {
    orange: orangeRecall,
    apple: appleRecall,
    combined: (orangeCorrect + appleCorrect) / probes,
  },
  disk_bytes: diskBytes,
  bytes_per_signature: diskBytes / N,
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nsummary: ${path.join(OUT, "summary.json")}`);
