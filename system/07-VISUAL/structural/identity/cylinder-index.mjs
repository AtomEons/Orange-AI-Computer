// 07-VISUAL/structural/identity/cylinder-index.mjs
//
// Infinite Circular Cylinder — continuous-coordinate vector index.
//
// Fixes the recall bug in knot-vector-index.mjs. Discrete family × radius
// shards missed 3/5 planted needles at 100k because signatures near a shard
// boundary landed in a different bucket than their similar neighbors. The
// cylinder has no discrete boundaries: every signature has continuous
// (θ, r, z) coordinates. Queries walk a continuous angular window and rank
// by full rich distance.
//
// Coordinates:
//   θ (theta)  — continuous color-wheel angle in [0, 2π], WRAPS at 2π→0
//                (no modular-index hacks; near-boundary items are adjacent
//                in the sorted array via wrap-around lookup)
//   r          — chromatic saturation = √(RG² + BY²); 0 at grayscale rim
//   z          — unbounded depth axis. Default: log_size (spatial scale).
//                Callers can override with timestamp for episodic ordering.
//
// Query flow:
//   1. Compute probe's (θ, r, z)
//   2. Binary-search sorted-by-θ array for probe's angular position
//   3. Walk outward in both directions (with wrap-around) collecting candidates
//   4. Rank candidates by full richDistance — no shard boundary can hide a match
//
// Bun-native, zero-param, deterministic.

import fs from "node:fs";
import path from "node:path";
import { richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";

// Same wheel rotation as knot-vector-index — orange sits at θ = 0
const ORANGE_ORIGIN = -0.966;

export function thetaOf(sig) {
  const c = sig.color;
  if (!c) return 0;
  const RG = c.mean_RG ?? 0, BY = c.mean_BY ?? 0;
  const raw = Math.atan2(BY, RG);
  return ((raw - ORANGE_ORIGIN) + 2 * Math.PI) % (2 * Math.PI);
}

export function saturationOf(sig) {
  const c = sig.color;
  if (!c) return 0;
  const RG = c.mean_RG ?? 0, BY = c.mean_BY ?? 0;
  return Math.sqrt(RG * RG + BY * BY);
}

/**
 * Default z coordinate: use log_size for spatial scale (small object at
 * one z, big object at another). Callers can override via meta.z or via
 * the zFn constructor option.
 */
export function defaultZOf(sig, meta) {
  if (meta && typeof meta.z === "number") return meta.z;
  if (meta && typeof meta.timestamp === "number") return meta.timestamp;
  return sig.color?.log_size ?? 0;
}

/**
 * Signed angular difference in [-π, π]. Handles the wrap-around at 2π.
 */
export function angularDelta(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Absolute angular distance in [0, π].
 */
export function angularDistance(a, b) {
  return Math.abs(angularDelta(a, b));
}

export class CylinderIndex {
  constructor(opts = {}) {
    this.channelWeights = opts.channelWeights ?? DEFAULT_CHANNEL_WEIGHTS;
    this.zFn = opts.zFn ?? defaultZOf;
    this.zWeight = opts.zWeight ?? 0.3;    // cylindrical distance weight for z
    this.rWeight = opts.rWeight ?? 1.0;
    this.thetaWeight = opts.thetaWeight ?? 1.0;
    this.items = [];        // append-only flat array
    this._sorted = null;    // lazy-built sorted-by-theta view
    this._dirty = false;
  }

  add(sig, meta = {}) {
    const theta = thetaOf(sig);
    const r = saturationOf(sig);
    const z = this.zFn(sig, meta);
    this.items.push({ sig, meta, theta, r, z });
    this._dirty = true;
    return { theta, r, z };
  }

  _rebuild() {
    if (!this._dirty && this._sorted) return;
    this._sorted = [...this.items].sort((a, b) => a.theta - b.theta);
    this._dirty = false;
  }

  /**
   * Cylindrical distance from a probe to a stored item.
   */
  cylDistance(probeTheta, probeR, probeZ, item) {
    const dTheta = angularDistance(probeTheta, item.theta);
    const dR = probeR - item.r;
    const dZ = probeZ - item.z;
    return Math.sqrt(
      (this.thetaWeight * dTheta) ** 2 +
      (this.rWeight * dR) ** 2 +
      (this.zWeight * dZ) ** 2,
    );
  }

  /**
   * Query nearest-k signatures.
   *
   * @param {object} sig
   * @param {number} k
   * @param {object} opts
   *   opts.candidatePoolMultiplier — how many cylindrical neighbors to
   *     rich-rank (default k * 40). Higher = better recall, slower.
   *   opts.maxAngularWindow — cap the angular walk to save latency
   *     (default π, i.e. half the cylinder — effectively unlimited)
   */
  query(sig, k = 5, opts = {}) {
    this._rebuild();
    const pool = opts.candidatePoolMultiplier ?? 40;
    const maxWindow = opts.maxAngularWindow ?? Math.PI;
    const probeTheta = thetaOf(sig);
    const probeR = saturationOf(sig);
    const probeZ = this.zFn(sig, opts);

    const arr = this._sorted;
    const N = arr.length;
    if (N === 0) return [];

    // Binary-search for probe θ
    let lo = 0, hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].theta < probeTheta) lo = mid + 1;
      else hi = mid;
    }
    // arr[lo] is first item with theta >= probeTheta (or N if none)

    // Walk outward in both directions, using wrap-around
    const target = Math.min(N, k * pool);
    const collected = [];
    let leftIdx = (lo - 1 + N) % N;
    let rightIdx = lo % N;
    let leftDelta = 0, rightDelta = 0;

    for (let step = 0; step < target && leftDelta <= maxWindow && rightDelta <= maxWindow; step++) {
      // Compute wrap-aware distances to next-left and next-right candidates
      const leftItem = arr[leftIdx];
      const rightItem = arr[rightIdx];
      const lDist = angularDistance(probeTheta, leftItem.theta);
      const rDist = angularDistance(probeTheta, rightItem.theta);
      if (rDist <= lDist) {
        collected.push(rightItem);
        rightIdx = (rightIdx + 1) % N;
        rightDelta = rDist;
      } else {
        collected.push(leftItem);
        leftIdx = (leftIdx - 1 + N) % N;
        leftDelta = lDist;
      }
      // Safety: bail when both walks come around
      if (collected.length >= N) break;
    }

    // De-duplicate (in the pathological case where left+right cross)
    const seen = new Set();
    const uniq = [];
    for (const c of collected) {
      const key = c.meta?.id ?? uniq.length;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(c);
    }

    // Rank by full rich distance
    const scored = uniq.map((c) => ({
      meta: c.meta,
      distance: richDistance(sig, c.sig, this.channelWeights),
      cylindrical_distance: this.cylDistance(probeTheta, probeR, probeZ, c),
      coords: { theta: c.theta, r: c.r, z: c.z },
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }

  /**
   * Aggregate query result per concept label — nearest-of-N style.
   */
  queryConcepts(sig, opts = {}) {
    const kProbes = opts.kProbes ?? 40;
    const results = this.query(sig, kProbes, opts);
    const perLabel = new Map();
    for (const r of results) {
      const label = r.meta.label ?? "(unlabeled)";
      const prev = perLabel.get(label);
      if (!prev || r.distance < prev.distance) {
        perLabel.set(label, { distance: r.distance, hits: (prev?.hits ?? 0) + 1 });
      } else prev.hits++;
    }
    return [...perLabel.entries()]
      .map(([label, v]) => ({ label, distance: v.distance, hits: v.hits }))
      .sort((a, b) => a.distance - b.distance);
  }

  stats() {
    this._rebuild();
    const N = this.items.length;
    if (N === 0) return { total: 0 };
    let minTheta = Infinity, maxTheta = -Infinity, minR = Infinity, maxR = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const it of this.items) {
      if (it.theta < minTheta) minTheta = it.theta;
      if (it.theta > maxTheta) maxTheta = it.theta;
      if (it.r < minR) minR = it.r;
      if (it.r > maxR) maxR = it.r;
      if (it.z < minZ) minZ = it.z;
      if (it.z > maxZ) maxZ = it.z;
    }
    return {
      total: N,
      theta_range: [minTheta, maxTheta],
      r_range: [minR, maxR],
      z_range: [minZ, maxZ],
      wrap: { near_zero: this.items.filter((i) => i.theta < 0.2).length, near_2pi: this.items.filter((i) => i.theta > 2 * Math.PI - 0.2).length },
    };
  }

  save(pathToFile) {
    fs.mkdirSync(path.dirname(pathToFile), { recursive: true });
    fs.writeFileSync(pathToFile, JSON.stringify({
      count: this.items.length,
      thetaWeight: this.thetaWeight,
      rWeight: this.rWeight,
      zWeight: this.zWeight,
      channelWeights: this.channelWeights,
      items: this.items,
    }));
  }

  static load(pathToFile, opts = {}) {
    const raw = JSON.parse(fs.readFileSync(pathToFile, "utf8"));
    const idx = new CylinderIndex({
      channelWeights: raw.channelWeights,
      zWeight: raw.zWeight,
      rWeight: raw.rWeight,
      thetaWeight: raw.thetaWeight,
      ...opts,
    });
    idx.items = raw.items;
    idx._dirty = true;
    return idx;
  }
}
