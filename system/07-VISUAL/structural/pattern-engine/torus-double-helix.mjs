// torus-double-helix.mjs — CANDIDATE substrate (2026-07-09 REFINED — NOT default).
//
// Original spec (operator, earlier 2026-07-09): "torus double helix pattern
// (likely a double pi), hollow helix with Celtic knot structures."
// Refined spec (operator, later 2026-07-09): "I would not make a torus first.
// I'd make a graph that is free to become one. If the graph naturally closes
// loops... then you've discovered recurrence. You didn't impose it. Nature
// did."
//
// This module STAYS as a candidate substrate ONE step down the roadmap. The
// primary substrate is emergent-light-graph.mjs — a free graph that MAY
// self-organize into a torus. If observed persistence + spatial/temporal
// edges close loops of the right topology, we can PROJECT the emergent
// graph onto this torus for storage/visualization. But we do not IMPOSE
// the geometry upfront.
//
// Keep this module for the day we've proved the emergent graph closes loops
// and want to see the torus in it.
//
// Scaling law: 10 000 signatures per mother node. Overflow splits the mother
// into two sub-mothers (each a fresh torus). Scales to infinity as a tree of
// tori, with parent-child links tracked in the graph.
//
// Zero learned parameters. All geometry is closed-form.
//
// Key invariants:
//   - Storage cost:     ~640 bytes per signature (from ilc-signature.mjs)
//   - Insert:           O(log N) via Celtic knot binary partition
//   - Query family:     O(k log N) where k = family size, log N = torus depth
//   - Similarity gate:  cosine >= FAMILY_TAU joins existing family; else new
//
// Winding ratio: TAU * φ where φ = (1+√5)/2 is the golden ratio — irrational,
// dense coverage of the torus. Matches operator's "irregular number, double pi"
// spec (2 * π ratio isn't quite it; golden angle is the closest natural fit
// for maximally-spread dense sampling — same reason phyllotaxis uses it).

import { ilcCosSim, SIG_LEN } from "../ilc-signature.mjs";

const PHI = (1 + Math.sqrt(5)) / 2;             // golden ratio
const WIND_A = 2 * Math.PI * PHI;               // strand A winding rate
const WIND_B = 2 * Math.PI / PHI;               // strand B (conjugate) winding rate
const KNOT_STEP = 6;                            // insert a Celtic-knot cross-link every 6 nodes
export const MOTHER_CAPACITY = 10_000;          // per operator spec
export const FAMILY_TAU = 0.95;                 // cosine sim ≥ TAU → same family
const NEAR_TAU = 0.80;                          // cosine sim ≥ NEAR_TAU → considered candidate

/** Node = single photon-signature stored on the torus */
class Node {
  constructor({ sigId, sig, familyId, meta, strand, tParam }) {
    this.sigId = sigId;
    this.sig = sig;                             // Float32Array(160) L2-normalized
    this.familyId = familyId;                   // group id — the "physical object"
    this.meta = meta || {};                     // free-form metadata (light condition, source, ts)
    this.strand = strand;                       // 'A' or 'B'
    this.tParam = tParam;                       // parametric position on the strand [0, 1)
    // 3D coords on torus (major R=2, minor r=0.6). For visualization + neighborhood.
    const theta = strand === 'A' ? WIND_A * tParam : WIND_B * tParam;
    const phi = 2 * Math.PI * tParam;
    const R = 2, r = 0.6;
    this.pos = {
      x: (R + r * Math.cos(phi)) * Math.cos(theta),
      y: (R + r * Math.cos(phi)) * Math.sin(theta),
      z: r * Math.sin(phi),
    };
    this.knotEdges = [];                        // cross-strand Celtic-knot links (list of Node)
  }
}

/** Family = collection of nodes sharing a physical cause */
class Family {
  constructor({ familyId, label }) {
    this.familyId = familyId;
    this.label = label;
    this.members = [];                          // Node[]
    this.centroid = new Float32Array(SIG_LEN);  // running L2-normalized mean signature
    this.count = 0;
  }
  addNode(node) {
    // Update running mean, then L2-normalize
    for (let i = 0; i < SIG_LEN; i++) {
      this.centroid[i] = (this.centroid[i] * this.count + node.sig[i]) / (this.count + 1);
    }
    let n = 0;
    for (let i = 0; i < SIG_LEN; i++) n += this.centroid[i] * this.centroid[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < SIG_LEN; i++) this.centroid[i] /= n;
    this.count++;
    this.members.push(node);
  }
}

/** Mother = one torus. Holds up to MOTHER_CAPACITY nodes across both strands.
 *  When full, splits into two sub-mothers (child tori) — the scaling-to-infinity
 *  mechanism.
 */
export class MotherTorus {
  constructor({ id = 'root', parent = null } = {}) {
    this.id = id;
    this.parent = parent;
    this.children = [];                         // sub-motherTori after split
    this.nodesA = [];                           // strand A nodes ordered by tParam
    this.nodesB = [];                           // strand B nodes ordered by tParam
    this.families = new Map();                  // familyId -> Family
    this.nextFamilyId = 1;
    this.nextSigId = 1;
    this.nodeCount = 0;
    this.tCursorA = 0;
    this.tCursorB = 0;
  }

  totalNodes() {
    let n = this.nodeCount;
    for (const c of this.children) n += c.totalNodes();
    return n;
  }

  /**
   * insertSignature(sig, opts) — insert an ILC signature, possibly attaching to
   * an existing family. Returns { node, family, isNewFamily, sim }.
   *
   * Behavior:
   *   - Find best-matching family (max cosine sim to centroid)
   *   - If sim ≥ FAMILY_TAU → attach to that family (learning: recognize it as X)
   *   - Else if opts.forceLabel is given → force new family with that label
   *   - Else if sim ≥ NEAR_TAU → treat as "unknown but similar to X" (attach as child)
   *   - Else → new family
   */
  insertSignature(sig, opts = {}) {
    // If this mother has split into children, route to the child whose centroid
    // is nearest (simple divide-and-conquer).
    if (this.children.length > 0) {
      let bestChild = this.children[0], bestSim = -Infinity;
      for (const c of this.children) {
        // Compare against child's aggregate family centroid (use first family)
        for (const f of c.families.values()) {
          const s = ilcCosSim(sig, f.centroid);
          if (s > bestSim) { bestSim = s; bestChild = c; }
        }
      }
      return bestChild.insertSignature(sig, opts);
    }

    // Find best-matching family in this torus
    let bestFamily = null, bestSim = -Infinity;
    for (const f of this.families.values()) {
      const s = ilcCosSim(sig, f.centroid);
      if (s > bestSim) { bestSim = s; bestFamily = f; }
    }

    let family, isNewFamily = false;
    if (opts.forceLabel !== undefined && !this.families.has(opts.forceLabel)) {
      // Named train sample — create the family up front
      family = new Family({ familyId: opts.forceLabel, label: opts.forceLabel });
      this.families.set(opts.forceLabel, family);
      isNewFamily = true;
    } else if (opts.forceLabel !== undefined && this.families.has(opts.forceLabel)) {
      family = this.families.get(opts.forceLabel);
    } else if (bestFamily && bestSim >= FAMILY_TAU) {
      family = bestFamily;
    } else {
      const id = 'F_' + (this.nextFamilyId++);
      family = new Family({ familyId: id, label: opts.label || id });
      this.families.set(id, family);
      isNewFamily = true;
    }

    // Alternate placement between strand A and B (double helix)
    const strand = this.nodeCount % 2 === 0 ? 'A' : 'B';
    const arr = strand === 'A' ? this.nodesA : this.nodesB;
    const t = strand === 'A' ? this.tCursorA : this.tCursorB;
    if (strand === 'A') this.tCursorA += 1 / MOTHER_CAPACITY;
    else this.tCursorB += 1 / MOTHER_CAPACITY;
    const node = new Node({
      sigId: 'S_' + (this.nextSigId++),
      sig,
      familyId: family.familyId,
      meta: opts.meta,
      strand,
      tParam: t,
    });
    arr.push(node);
    family.addNode(node);
    this.nodeCount++;

    // Celtic-knot cross-link: every KNOT_STEP nodes, link a fresh node on
    // strand A to its nearest node on strand B (by tParam distance) and vice
    // versa. This lets family recall walk between strands.
    if (this.nodeCount % KNOT_STEP === 0) {
      const other = strand === 'A' ? this.nodesB : this.nodesA;
      if (other.length > 0) {
        let nearest = other[0], nd = Math.abs(nearest.tParam - node.tParam);
        for (const on of other) {
          const d = Math.abs(on.tParam - node.tParam);
          if (d < nd) { nd = d; nearest = on; }
        }
        node.knotEdges.push(nearest);
        nearest.knotEdges.push(node);
      }
    }

    // Split when full — divide into two child tori by k-means-lite (2 seeds)
    if (this.nodeCount >= MOTHER_CAPACITY) this._split();

    return { node, family, isNewFamily, sim: bestSim };
  }

  _split() {
    // Two centroids seeded from two most-different family means.
    const fams = Array.from(this.families.values());
    if (fams.length < 2) return; // can't split; leave saturated (rare case)
    let seedA = fams[0], seedB = fams[1], maxD = -Infinity;
    for (let i = 0; i < fams.length; i++) {
      for (let j = i + 1; j < fams.length; j++) {
        const d = 1 - ilcCosSim(fams[i].centroid, fams[j].centroid);
        if (d > maxD) { maxD = d; seedA = fams[i]; seedB = fams[j]; }
      }
    }
    const childA = new MotherTorus({ id: this.id + '.A', parent: this });
    const childB = new MotherTorus({ id: this.id + '.B', parent: this });
    // Reassign families: closer to seedA → A; else → B
    for (const f of fams) {
      const dA = ilcCosSim(f.centroid, seedA.centroid);
      const dB = ilcCosSim(f.centroid, seedB.centroid);
      const target = dA >= dB ? childA : childB;
      target.families.set(f.familyId, f);
      for (const n of f.members) {
        const arr = n.strand === 'A' ? target.nodesA : target.nodesB;
        arr.push(n);
        target.nodeCount++;
      }
    }
    this.children.push(childA, childB);
    this.families.clear();
    this.nodesA = [];
    this.nodesB = [];
    this.nodeCount = 0;
  }

  /** recognize(sig) → best family match with cosine similarity. */
  recognize(sig) {
    if (this.children.length > 0) {
      let best = null;
      for (const c of this.children) {
        const r = c.recognize(sig);
        if (!best || r.sim > best.sim) best = r;
      }
      return best;
    }
    let best = { familyId: null, label: null, sim: -Infinity, node: null };
    for (const f of this.families.values()) {
      const s = ilcCosSim(sig, f.centroid);
      if (s > best.sim) best = { familyId: f.familyId, label: f.label, sim: s, node: null };
      // Also check per-member similarity for tighter one-shot recall
      for (const n of f.members) {
        const sn = ilcCosSim(sig, n.sig);
        if (sn > best.sim) best = { familyId: f.familyId, label: f.label, sim: sn, node: n };
      }
    }
    return best;
  }

  /** Simple stats for the operator to look at. */
  stats() {
    return {
      id: this.id,
      totalNodes: this.totalNodes(),
      localNodes: this.nodeCount,
      localFamilies: this.families.size,
      children: this.children.length,
      strandA: this.nodesA.length,
      strandB: this.nodesB.length,
      childStats: this.children.map(c => c.stats()),
    };
  }
}
