#!/usr/bin/env bun
// 100k-orange-stress — Kurzweil-scale surity for the knot vector index.
//
// Operator: "100,000 experiments on ai box using orange".
//
// Since Codexa's AI Box is Phase-2-pending (SSH unreachable from dev box,
// OrangeBrain offline), the AI Box is unreachable. We run the 100k
// experiment locally on the dev box against the Æyes knot vector index —
// that's the machinery that DOES exist and is the load-bearing storage
// substrate for the 100k Kurzweil expert threshold.
//
// The five measurements:
//   1. Ingest throughput at 100k (sigs/sec)
//   2. Query latency (p50, p95, p99) at 100k
//   3. Recall accuracy — inject 5 "planted needle" signatures deterministically
//      seeded, query them back, verify they surface top-K
//   4. Family-bucket distribution — does the color wheel spread evenly?
//   5. Memory footprint — final index size on disk
//
// Everything deterministic (seeded RNG). Zero learned parameters.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { KnotIndex, FAMILY_NAMES, familyOf, radiusBucketOf } from "./knot-vector-index.mjs";
import { richDistance } from "./identity-store-v2.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "100k-orange-stress");
fs.mkdirSync(OUT, { recursive: true });

// ── Deterministic RNG (mulberry32) ──────────────────────────────────
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
  // Box-Muller
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Load the trained orange signature ─────────────────────────────
const STORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));
const orangeRow = STORE.labels.find((r) => r.label === "orange");
const appleRow = STORE.labels.find((r) => r.label === "apple");
const orangePrototype = orangeRow.signatures[0].sig;
const applePrototype = appleRow.signatures[0].sig;
console.log("prototype orange sig loaded, prototype apple sig loaded");
console.log(`  orange color: R=${orangePrototype.color.mean_R.toFixed(3)} G=${orangePrototype.color.mean_G.toFixed(3)} B=${orangePrototype.color.mean_B.toFixed(3)} RG=${orangePrototype.color.mean_RG.toFixed(3)} BY=${orangePrototype.color.mean_BY.toFixed(3)}`);

// ── Perturbation generator ────────────────────────────────────────
function perturbSig(base, rng, jitter = 0.10) {
  const s = JSON.parse(JSON.stringify(base));  // deep clone
  // Perturb each scalar field of the color descriptor
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

// ── STEP 1: INGEST 100k ────────────────────────────────────────────
const N = 100_000;
console.log(`\n=== STEP 1 — ingest ${N.toLocaleString()} synthetic sigs ===`);
const idx = new KnotIndex({ radiusBuckets: 5 });

// 5 planted "needles" (deterministic seeds so we know where they are)
const NEEDLE_COUNT = 5;
const needles = [];
{
  const nrng = mulberry32(42);
  for (let i = 0; i < NEEDLE_COUNT; i++) {
    const s = perturbSig(orangePrototype, nrng, 0.03);   // low jitter — near-orange
    const meta = { label: "orange_needle", id: `needle_${i}`, source: "planted" };
    idx.add(s, meta);
    needles.push({ sig: s, meta });
  }
}

// Bulk fill: mixture of orange-family + apple-family + off-family
const rng = mulberry32(1337);
const tIngestStart = Date.now();
let orangeCount = NEEDLE_COUNT, appleCount = 0, offCount = 0;
for (let i = NEEDLE_COUNT; i < N; i++) {
  const roll = rng();
  let base, label;
  if (roll < 0.55) { base = orangePrototype; label = "orange_synth"; orangeCount++; }
  else if (roll < 0.85) { base = applePrototype; label = "apple_synth"; appleCount++; }
  else {
    // Off-family: strongly perturb one prototype, jitter 0.6
    base = rng() < 0.5 ? orangePrototype : applePrototype;
    label = "off_synth"; offCount++;
  }
  const jitter = label === "off_synth" ? 0.6 : 0.15;
  const s = perturbSig(base, rng, jitter);
  idx.add(s, { label, id: `s${i}`, source: "synth" });
  if ((i + 1) % 20000 === 0) {
    const elapsed = (Date.now() - tIngestStart) / 1000;
    console.log(`  ${((i + 1) / 1000).toFixed(0)}k ingested  ${(i / elapsed).toFixed(0)} sigs/sec`);
  }
}
const tIngestEnd = Date.now();
const ingestSec = (tIngestEnd - tIngestStart) / 1000;
const ingestThroughput = N / ingestSec;
console.log(`\n  total: ${N.toLocaleString()} in ${ingestSec.toFixed(1)}s → ${ingestThroughput.toFixed(0)} sigs/sec`);
console.log(`  label mix: orange_synth=${orangeCount.toLocaleString()}, apple_synth=${appleCount.toLocaleString()}, off_synth=${offCount.toLocaleString()}, needles=${NEEDLE_COUNT}`);

// ── STEP 2: BUCKET DISTRIBUTION ────────────────────────────────────
console.log("\n=== STEP 2 — bucket distribution ===");
const stats = idx.stats();
console.log(`  buckets filled: ${stats.buckets_filled}/${stats.buckets_capacity}  utilization=${(stats.utilization * 100).toFixed(1)}%`);
console.log(`  max bucket size: ${stats.max_bucket_size.toLocaleString()}`);
console.log(`  per-family sig counts:`);
for (let i = 0; i < FAMILY_NAMES.length; i++) {
  const bar = "█".repeat(Math.round(stats.per_family[i] / (stats.total / 40)));
  console.log(`    ${i} ${FAMILY_NAMES[i].padEnd(15)} ${stats.per_family[i].toString().padStart(7)}  ${bar}`);
}
console.log(`  per-radius sig counts:`);
for (let i = 0; i < stats.per_radius.length; i++) {
  const bar = "█".repeat(Math.round(stats.per_radius[i] / (stats.total / 40)));
  console.log(`    ring ${i}: ${stats.per_radius[i].toString().padStart(7)}  ${bar}`);
}

// ── STEP 3: QUERY LATENCY ─────────────────────────────────────────
console.log("\n=== STEP 3 — query latency (1000 queries) ===");
const qrng = mulberry32(999);
const queryCount = 1000;
const latencies = new Float32Array(queryCount);
for (let q = 0; q < queryCount; q++) {
  const probe = perturbSig(orangePrototype, qrng, 0.15);
  const tQ = performance.now();
  idx.query(probe, 5);
  latencies[q] = performance.now() - tQ;
}
const sorted = Array.from(latencies).sort((a, b) => a - b);
const p50 = sorted[Math.floor(queryCount * 0.50)];
const p95 = sorted[Math.floor(queryCount * 0.95)];
const p99 = sorted[Math.floor(queryCount * 0.99)];
const pMax = sorted[queryCount - 1];
const meanLat = sorted.reduce((a, b) => a + b, 0) / queryCount;
console.log(`  ${queryCount} queries at k=5 on ${N.toLocaleString()}-sig index`);
console.log(`  mean=${meanLat.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${pMax.toFixed(2)}ms`);

// ── STEP 4: RECALL ACCURACY ───────────────────────────────────────
console.log("\n=== STEP 4 — recall accuracy (5 planted needles) ===");
let needleFoundAtK = { 1: 0, 5: 0, 20: 0, 100: 0 };
for (let i = 0; i < NEEDLE_COUNT; i++) {
  const probe = perturbSig(needles[i].sig, mulberry32(1000 + i), 0.02);
  const results = idx.query(probe, 100);
  const targetId = needles[i].meta.id;
  let foundIdx = -1;
  for (let k = 0; k < results.length; k++) {
    if (results[k].meta.id === targetId) { foundIdx = k; break; }
  }
  const rank = foundIdx >= 0 ? foundIdx + 1 : "not-in-top-100";
  console.log(`  ${targetId}: found at rank ${rank}`);
  if (foundIdx >= 0) {
    if (foundIdx < 1) needleFoundAtK[1]++;
    if (foundIdx < 5) needleFoundAtK[5]++;
    if (foundIdx < 20) needleFoundAtK[20]++;
    if (foundIdx < 100) needleFoundAtK[100]++;
  }
}
console.log(`  Recall @1=${needleFoundAtK[1]}/${NEEDLE_COUNT}  @5=${needleFoundAtK[5]}/${NEEDLE_COUNT}  @20=${needleFoundAtK[20]}/${NEEDLE_COUNT}  @100=${needleFoundAtK[100]}/${NEEDLE_COUNT}`);

// ── STEP 5: LABEL RECALL AT SCALE ─────────────────────────────────
console.log("\n=== STEP 5 — label recall on synthetic queries ===");
const labelTests = 500;
let orangeCorrect = 0, appleCorrect = 0;
for (let q = 0; q < labelTests; q++) {
  const useOrange = q < labelTests / 2;
  const probe = perturbSig(useOrange ? orangePrototype : applePrototype, mulberry32(50000 + q), 0.15);
  const conceptRanking = idx.queryConcepts(probe, { k: 20 });
  const top = conceptRanking[0]?.label;
  if (useOrange && (top === "orange_synth" || top === "orange_needle")) orangeCorrect++;
  else if (!useOrange && top === "apple_synth") appleCorrect++;
}
console.log(`  orange probes → orange_* top-1: ${orangeCorrect}/${labelTests/2} (${(orangeCorrect / (labelTests/2) * 100).toFixed(1)}%)`);
console.log(`  apple probes  → apple_synth top-1: ${appleCorrect}/${labelTests/2} (${(appleCorrect / (labelTests/2) * 100).toFixed(1)}%)`);

// ── STEP 6: PERSIST + SIZE ────────────────────────────────────────
console.log("\n=== STEP 6 — persist to disk ===");
const savePath = path.join(OUT, "100k-orange-index.json");
const tSaveStart = Date.now();
idx.save(savePath);
const saveSec = (Date.now() - tSaveStart) / 1000;
const bytes = fs.statSync(savePath).size;
console.log(`  save time: ${saveSec.toFixed(1)}s`);
console.log(`  file size: ${(bytes / (1024*1024)).toFixed(1)} MB  (${(bytes / N).toFixed(0)} bytes/signature avg)`);

// ── FINAL SUMMARY ────────────────────────────────────────────────
const summary = {
  N,
  ingest_seconds: ingestSec,
  ingest_throughput_sigs_per_sec: ingestThroughput,
  label_mix: { orange_synth: orangeCount, apple_synth: appleCount, off_synth: offCount, needles: NEEDLE_COUNT },
  bucket_stats: stats,
  query_latency_ms: { mean: meanLat, p50, p95, p99, max: pMax },
  needle_recall: needleFoundAtK,
  label_recall: {
    orange_top1_pct: orangeCorrect / (labelTests/2) * 100,
    apple_top1_pct: appleCorrect / (labelTests/2) * 100,
  },
  disk_bytes: bytes,
  bytes_per_signature: bytes / N,
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

console.log("\n=== FINAL ===");
console.log(`✓ 100,000 signatures ingested at ${ingestThroughput.toFixed(0)} sigs/sec`);
console.log(`✓ query latency p50/p95/p99 = ${p50.toFixed(2)}/${p95.toFixed(2)}/${p99.toFixed(2)} ms on 100k-sig index`);
console.log(`✓ needle recall @1: ${needleFoundAtK[1]}/${NEEDLE_COUNT}, @5: ${needleFoundAtK[5]}/${NEEDLE_COUNT}`);
console.log(`✓ label recall — orange top-1 ${(orangeCorrect / (labelTests/2) * 100).toFixed(1)}% · apple top-1 ${(appleCorrect / (labelTests/2) * 100).toFixed(1)}%`);
console.log(`✓ disk footprint: ${(bytes / (1024*1024)).toFixed(1)} MB (${(bytes / N).toFixed(0)} B/sig)`);
console.log(`\nartifacts: ${OUT}`);
