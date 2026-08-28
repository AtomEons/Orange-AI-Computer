// 07-VISUAL/structural/identity/knot-vector-index.mjs
//
// DEPRECATED — see cylinder-index.mjs. The knot index missed 3/5 planted
// needles at 100k due to discrete shard boundaries. Cylinder is 420× faster
// (617 ms → 1.47 ms at 20k) with continuous coordinates and no boundary
// misses. Kept live per "don't drop" doctrine; new code SHOULD use
// cylinder-index.mjs.
//
// Æyes Knot Vector Index — FAISS-caliber ANN at 100k, routed by Celtic
// topology instead of pure IVF/HNSW.
//
// Design:
//   Level 1 — chromatic family shard (from prism color reading)
//   Level 2 — trefoil strand within family (P / S / E)
//   Level 3 — Möbius radius bucket (0=center-of-space, K=rim/boundary)
//   Level 4 — within-bucket linear scan
//
// At 100k signatures spread across ~15 families × ~3 strands × ~5 radius
// buckets = ~225 buckets, each averaging ~450 signatures. Query hits one
// bucket → ~450 distance computations. ~O(1) per query at 100k scale, no
// external deps.
//
// Storage: per-signature record + 3 routing bytes (family, strand, radius).
// Fully quantized at 8-bit gives ~55 B per signature × 100k = 5.5 MB total.
// Below FAISS storage overhead at this scale.
//
// Bun-only, zero learned parameters, deterministic.

import fs from "node:fs";
import path from "node:path";
import { richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";

/**
 * Chromatic-family assignment from a rich signature. 12 canonical families.
 */
export const FAMILY_NAMES = [
  "orange", "red", "yellow", "green",
  "cyan", "blue", "violet", "magenta",
  "warm_neutral", "cool_neutral", "dark", "bright",
];

/**
 * Compute the family shard id for a signature. Deterministic.
 */
export function familyOf(sig) {
  const c = sig.color;
  if (!c) return 8; // fallback warm_neutral
  const R = c.mean_R, G = c.mean_G, B = c.mean_B;
  const L = 0.30 * R + 0.59 * G + 0.11 * B;
  const RG = c.mean_RG ?? (R - G);
  const BY = c.mean_BY ?? (B - 0.5 * (R + G));

  // Bright / dark first — override chromatic family if extreme luminance
  if (L > 0.85) return 11; // bright
  if (L < 0.15) return 10; // dark

  // Saturation gate
  const sat = Math.max(Math.abs(RG), Math.abs(BY));
  if (sat < 0.05) return (L > 0.5) ? 8 : 9; // warm/cool neutral

  // Angular position in RG × BY plane maps to color wheel.
  // We rotate the origin so ORANGE lands at family 0 (per operator doctrine
  // — orange-family is the seed / center of the chromatic taxonomy).
  // Orange's canonical (RG, BY) direction — measured from orange.jpg's rich
  // signature: RG=+0.139, BY=−0.478 → atan2 ≈ −1.286 rad. Subtracting that
  // rotates the wheel so orange sits at bucket 0. Going counterclockwise
  // from there: 0=orange, 1=red, 2=magenta, 3=violet, 4=blue, 5=cyan,
  // 6=green, 7=yellow.
  const ORANGE_ORIGIN = -1.30;
  const theta = Math.atan2(BY, RG);
  const rel = ((theta - ORANGE_ORIGIN) + 2 * Math.PI) % (2 * Math.PI);
  const norm = rel / (2 * Math.PI);
  const wheelIdx = Math.floor(norm * 8) % 8;
  return wheelIdx;
}

/**
 * Trefoil strand for a signature within a family. For retrieval we only
 * populate the Photonic strand (P=0). S and E are edge-type strands used
 * by the concept-graph, not the signature index.
 */
export function strandOf(_sig) { return 0; }   // photonic

/**
 * Möbius radius bucket. Uses signature's local "salience" — how well-
 * measured is this specimen? — as the activation proxy.
 *   High salience (well-lit, clear specular, tight edges) → center bucket 0
 *   Low salience (blurry, ambiguous edges) → outer bucket K-1
 */
export function radiusBucketOf(sig, opts = {}) {
  const buckets = opts.buckets ?? 5;
  const c = sig.color ?? {};
  const e = sig.edge ?? {};
  const s = sig.specular ?? {};
  const salience =
      0.4 * Math.min(1, Math.abs(c.mean_RG ?? 0) + Math.abs(c.mean_BY ?? 0))
    + 0.3 * Math.min(1, (e.meanEnergy ?? 0) * 5)
    + 0.3 * Math.min(1, (s.glossinessScore ?? 0) * 3);
  // 1 - salience → radius (higher radius = further from center)
  const rIdx = Math.min(buckets - 1, Math.floor((1 - salience) * buckets));
  return rIdx;
}

/**
 * The knot index.
 *
 *   buckets[familyIdx][strandIdx][radiusIdx] = Array<{sig, meta}>
 */
export class KnotIndex {
  constructor(opts = {}) {
    this.families = FAMILY_NAMES.length;
    this.strands = 1;         // photonic only for now
    this.radiusBuckets = opts.radiusBuckets ?? 5;
    this.channelWeights = opts.channelWeights ?? DEFAULT_CHANNEL_WEIGHTS;
    this.buckets = new Map(); // key = "F/S/R"
    this.count = 0;
  }

  _key(f, s, r) { return `${f}/${s}/${r}`; }

  /**
   * Add a signature with metadata (label, source, id).
   */
  add(sig, meta = {}) {
    const f = familyOf(sig);
    const s = strandOf(sig);
    const r = radiusBucketOf(sig, { buckets: this.radiusBuckets });
    const key = this._key(f, s, r);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push({ sig, meta, f, s, r });
    this.count++;
    return { f, s, r, bucket_key: key };
  }

  /**
   * Query nearest-k signatures.
   * Expands from home bucket outward through adjacent radius buckets +
   * adjacent color-wheel families if k not reached.
   *
   * Per-bucket candidate cap keeps hot-bucket cost bounded (a family bucket
   * with 65k signatures otherwise dominates a single query).
   */
  query(sig, k = 5, opts = {}) {
    // Precise mode: turn off caps for high-recall use cases (planted-needle
    // retrieval, exhaustive sweep). Costs latency, guarantees no near-boundary
    // signature is missed.
    const precise = opts.precise ?? false;
    const maxRadiusExpansion = opts.maxRadiusExpansion ?? (precise ? this.radiusBuckets : this.radiusBuckets);
    const maxFamilyExpansion = opts.maxFamilyExpansion ?? (precise ? this.families >> 1 : 3);
    const perBucketCap = opts.perBucketCap ?? (precise ? Infinity : 2048);
    const totalCandidateCap = opts.totalCandidateCap ?? (precise ? Infinity : Math.max(k * 100, 4096));
    const homeF = familyOf(sig);
    const homeS = strandOf(sig);
    const homeR = radiusBucketOf(sig, { buckets: this.radiusBuckets });

    // Ordered list of buckets to visit
    const visitPlan = [];
    for (let dR = 0; dR <= maxRadiusExpansion; dR++) {
      for (const rSign of dR === 0 ? [0] : [+1, -1]) {
        const r = homeR + rSign * dR;
        if (r < 0 || r >= this.radiusBuckets) continue;
        for (let dF = 0; dF <= maxFamilyExpansion; dF++) {
          for (const fSign of dF === 0 ? [0] : [+1, -1]) {
            const f = (homeF + fSign * dF + this.families) % this.families;
            visitPlan.push({ f, s: homeS, r });
          }
        }
      }
    }

    const candidates = [];
    for (const { f, s, r } of visitPlan) {
      const bucket = this.buckets.get(this._key(f, s, r));
      if (!bucket) continue;
      const scan = Math.min(bucket.length, perBucketCap);
      for (let i = 0; i < scan; i++) {
        const item = bucket[i];
        const d = richDistance(sig, item.sig, this.channelWeights);
        candidates.push({ meta: item.meta, distance: d, bucket: { f, s, r } });
      }
      if (candidates.length >= totalCandidateCap) break;
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates.slice(0, k);
  }

  /**
   * Aggregate query result per concept label — nearest-of-N style.
   * Returns concepts ranked by their best-match distance.
   */
  queryConcepts(sig, opts = {}) {
    const kProbes = opts.k ?? 20;
    const results = this.query(sig, kProbes, opts);
    const perLabel = new Map();
    for (const r of results) {
      const label = r.meta.label ?? "(unlabeled)";
      const prev = perLabel.get(label);
      if (!prev || r.distance < prev.distance) perLabel.set(label, { distance: r.distance, hits: (prev?.hits ?? 0) + 1 });
      else prev.hits++;
    }
    return [...perLabel.entries()]
      .map(([label, v]) => ({ label, distance: v.distance, hits: v.hits }))
      .sort((a, b) => a.distance - b.distance);
  }

  stats() {
    const perFamily = new Array(this.families).fill(0);
    const perRadius = new Array(this.radiusBuckets).fill(0);
    let filled = 0, maxBucket = 0;
    for (const [key, arr] of this.buckets.entries()) {
      const [f, , r] = key.split("/").map(Number);
      perFamily[f] += arr.length;
      perRadius[r] += arr.length;
      filled++;
      if (arr.length > maxBucket) maxBucket = arr.length;
    }
    const capacity = this.families * this.strands * this.radiusBuckets;
    return {
      total: this.count,
      families: FAMILY_NAMES,
      per_family: perFamily,
      per_radius: perRadius,
      buckets_filled: filled,
      buckets_capacity: capacity,
      utilization: filled / capacity,
      max_bucket_size: maxBucket,
    };
  }

  save(pathToFile) {
    fs.mkdirSync(path.dirname(pathToFile), { recursive: true });
    const rows = [];
    for (const [key, arr] of this.buckets.entries()) {
      for (const item of arr) rows.push({ key, ...item });
    }
    fs.writeFileSync(pathToFile, JSON.stringify({
      count: this.count,
      radiusBuckets: this.radiusBuckets,
      channelWeights: this.channelWeights,
      rows,
    }));
  }

  static load(pathToFile, opts = {}) {
    const raw = JSON.parse(fs.readFileSync(pathToFile, "utf8"));
    const idx = new KnotIndex({ ...opts, radiusBuckets: raw.radiusBuckets, channelWeights: raw.channelWeights });
    for (const row of raw.rows) {
      if (!idx.buckets.has(row.key)) idx.buckets.set(row.key, []);
      idx.buckets.get(row.key).push({ sig: row.sig, meta: row.meta, f: row.f, s: row.s, r: row.r });
    }
    idx.count = raw.count;
    return idx;
  }
}
