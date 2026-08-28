// emergent-light-graph.mjs — AEyes¹ Research Grade, Stage 1-3.
//
// The one question this module answers:
//   "Given only streams of light, can the system discover stable visual
//    entities that persist across time and changing conditions?"
//
// No imposed torus. No mandatory Celtic knots. No object labels. The graph
// is free to become whatever the recurrence structure of the light demands.
// If it closes loops, we've discovered recurrence — the operator refined:
// "You didn't impose it. Nature did."
//
// Every frame carries invariant light structures (ILC signatures). We ask:
// "Which existing nodes explain this incoming light?" — nearest neighbor
// by cosine similarity. Above threshold → strengthen (persistence++). Below
// → new node. Co-occurring signatures in the same frame get spatial edges.
// Adjacent frames get temporal edges. Persistence and confidence emerge.
//
// Stages this covers (operator roadmap):
//   Stage 1: stable light atoms
//   Stage 2: co-occurrence clusters
//   Stage 3: persistence across time → "something exists"
//
// NOT covered here (intentionally — operator discipline: "solve ONE question"):
//   Stage 4: transformation learning
//   Stage 5: object emergence
//   Stage 6: scene understanding
// Those layer on top of a solid Stage-3 graph.
//
// Zero learned parameters. All updates closed-form.

import { ilcCosSim, SIG_LEN } from "../ilc-signature.mjs";

// Recognition threshold — cosine sim above which we consider "same light structure"
export const RECOGNIZE_TAU = 0.90;
// Persistence threshold — nodes with fewer observations than this are "unconfirmed"
export const CONFIRM_MIN = 3;

class LightNode {
  constructor({ id, sig, firstSeen, meta }) {
    this.id = id;
    // Running mean signature; incoming signals blend in via reciprocal averaging
    this.signature = new Float32Array(sig);
    this.persistence = 1;                         // observation count
    this.spatialNeighbors = new Map();            // otherNodeId -> co-occurrence count
    this.temporalNeighbors = new Map();           // otherNodeId -> adjacent-frame count
    this.transformLinks = new Map();              // otherNodeId -> {count, condition}
    this.firstSeen = firstSeen;
    this.lastSeen = firstSeen;
    this.meta = meta || {};                       // free-form (source, lighting condition, etc.)
    this.variance = 0;                            // running MSE from mean
  }
  get confidence() {
    // Simple monotone: confidence = 1 - 1/(persistence+1). At persistence 100 → 0.99.
    return 1 - 1 / (this.persistence + 1);
  }
  strengthen(sig, frameNum, meta) {
    // Blend the observation into the mean signature (reciprocal averaging)
    let sqDiff = 0;
    const n = this.persistence + 1;
    for (let i = 0; i < SIG_LEN; i++) {
      const prev = this.signature[i];
      const next = (prev * this.persistence + sig[i]) / n;
      const d = sig[i] - prev;
      sqDiff += d * d;
      this.signature[i] = next;
    }
    // L2-renormalize
    let norm = 0;
    for (let i = 0; i < SIG_LEN; i++) norm += this.signature[i] * this.signature[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < SIG_LEN; i++) this.signature[i] /= norm;
    // Running variance
    this.variance = (this.variance * this.persistence + sqDiff) / n;
    this.persistence = n;
    this.lastSeen = frameNum;
    // Merge meta.conditions into a set of seen conditions
    if (meta && meta.condition) {
      this.meta.conditions ??= new Set();
      this.meta.conditions.add(meta.condition);
    }
  }
}

export class EmergentLightGraph {
  constructor({ tau = RECOGNIZE_TAU } = {}) {
    this.tau = tau;
    this.nodes = new Map();                 // id -> LightNode
    this.families = new Map();              // familyLabel -> { nodes: Set<id>, count }
    this.nodeToFamily = new Map();          // nodeId -> familyLabel (for reverse lookup)
    this.nextId = 1;
    this.frameCount = 0;
    this.prevFrameNodeIds = [];             // ids observed in previous frame → temporal edges
  }

  /**
   * train(sig, familyLabel, meta) — supervised: assert this signature belongs
   * to the given family. Operator's "1-shot then 10-100 train" spec.
   *   - If the family has an existing node with cosine sim ≥ tau to this sig →
   *     strengthen it (blend into that node's mean).
   *   - Else create a new node and register it in the family.
   * Recognition uses max sim across all nodes in a family, so a family with
   * N observation-nodes covers N distinct viewing/lighting/pose conditions.
   */
  train(sig, familyLabel, meta = {}) {
    this.frameCount++;
    if (!this.families.has(familyLabel)) {
      this.families.set(familyLabel, { nodes: new Set(), count: 0 });
    }
    const fam = this.families.get(familyLabel);
    // Find best matching node WITHIN this family
    let bestId = null, bestSim = -Infinity;
    for (const id of fam.nodes) {
      const n = this.nodes.get(id);
      const s = ilcCosSim(sig, n.signature);
      if (s > bestSim) { bestSim = s; bestId = id; }
    }
    let node, wasNew = false;
    if (bestId !== null && bestSim >= this.tau) {
      node = this.nodes.get(bestId);
      node.strengthen(sig, this.frameCount, meta);
    } else {
      const id = 'N_' + (this.nextId++);
      node = new LightNode({ id, sig, firstSeen: this.frameCount, meta: { conditions: new Set(meta.condition ? [meta.condition] : []), family: familyLabel, ...meta } });
      this.nodes.set(id, node);
      fam.nodes.add(id);
      this.nodeToFamily.set(id, familyLabel);
      wasNew = true;
    }
    fam.count++;
    return { nodeId: node.id, familyLabel, wasNew, sim: bestSim };
  }

  /**
   * recognize(sig) — SUPERVISED recall.
   * Returns the family whose best-matching node has highest cosine sim, with
   * second-best margin (confidence).
   */
  recognize(sig) {
    let best = { familyLabel: null, sim: -Infinity, nodeId: null };
    let second = { familyLabel: null, sim: -Infinity };
    for (const [label, fam] of this.families) {
      let famBest = -Infinity, famBestNode = null;
      for (const id of fam.nodes) {
        const s = ilcCosSim(sig, this.nodes.get(id).signature);
        if (s > famBest) { famBest = s; famBestNode = id; }
      }
      if (famBest > best.sim) {
        second = { familyLabel: best.familyLabel, sim: best.sim };
        best = { familyLabel: label, sim: famBest, nodeId: famBestNode };
      } else if (famBest > second.sim) {
        second = { familyLabel: label, sim: famBest };
      }
    }
    return { ...best, secondFamily: second.familyLabel, secondSim: second.sim, margin: best.sim - second.sim };
  }

  /**
   * observe(signatures, meta) — feed a frame's-worth of ILC signatures.
   *   signatures: Float32Array[]  each already L2-normalized (from ilc-signature)
   *   meta: { source, condition, ... }  passed to each node updated/created
   * Returns: { frame, updated: [{nodeId, wasNew, sim}], nodeCount }
   */
  observe(signatures, meta = {}) {
    this.frameCount++;
    const framePersistIds = new Set();
    const updated = [];
    const sigsArr = Array.isArray(signatures) ? signatures : [signatures];

    for (const sig of sigsArr) {
      let bestId = null, bestSim = -Infinity;
      for (const [id, n] of this.nodes) {
        const s = ilcCosSim(sig, n.signature);
        if (s > bestSim) { bestSim = s; bestId = id; }
      }
      let node, wasNew = false;
      if (bestId !== null && bestSim >= this.tau) {
        node = this.nodes.get(bestId);
        node.strengthen(sig, this.frameCount, meta);
      } else {
        const id = 'N_' + (this.nextId++);
        node = new LightNode({ id, sig, firstSeen: this.frameCount, meta: { conditions: new Set(meta.condition ? [meta.condition] : []), ...meta } });
        this.nodes.set(id, node);
        wasNew = true;
      }
      framePersistIds.add(node.id);
      updated.push({ nodeId: node.id, wasNew, sim: bestSim });
    }

    // Spatial edges: every pair of nodes seen in this same frame
    const inFrame = Array.from(framePersistIds);
    for (let i = 0; i < inFrame.length; i++) {
      const a = this.nodes.get(inFrame[i]);
      for (let j = i + 1; j < inFrame.length; j++) {
        const bId = inFrame[j];
        a.spatialNeighbors.set(bId, (a.spatialNeighbors.get(bId) || 0) + 1);
        const b = this.nodes.get(bId);
        b.spatialNeighbors.set(inFrame[i], (b.spatialNeighbors.get(inFrame[i]) || 0) + 1);
      }
    }
    // Temporal edges: link this frame's nodes to previous frame's
    for (const prev of this.prevFrameNodeIds) {
      const pn = this.nodes.get(prev);
      if (!pn) continue;
      for (const cur of framePersistIds) {
        if (cur === prev) continue;
        pn.temporalNeighbors.set(cur, (pn.temporalNeighbors.get(cur) || 0) + 1);
        const cn = this.nodes.get(cur);
        cn.temporalNeighbors.set(prev, (cn.temporalNeighbors.get(prev) || 0) + 1);
      }
    }
    this.prevFrameNodeIds = inFrame;
    return { frame: this.frameCount, updated, nodeCount: this.nodes.size };
  }

  /** Ask the graph: what nodes explain this incoming light? */
  explain(sig) {
    let best = null, bestSim = -Infinity;
    for (const n of this.nodes.values()) {
      const s = ilcCosSim(sig, n.signature);
      if (s > bestSim) { bestSim = s; best = n; }
    }
    if (!best) return { nodeId: null, sim: -Infinity, confidence: 0, confirmed: false };
    return {
      nodeId: best.id,
      sim: bestSim,
      persistence: best.persistence,
      confidence: best.confidence,
      confirmed: best.persistence >= CONFIRM_MIN,
      variance: best.variance,
      conditions: best.meta.conditions ? Array.from(best.meta.conditions) : [],
    };
  }

  /** Confirmed nodes = ones observed enough times to be considered stable */
  confirmedNodes() {
    return Array.from(this.nodes.values()).filter(n => n.persistence >= CONFIRM_MIN);
  }

  /** Summary telemetry the operator can read */
  stats() {
    const confirmed = this.confirmedNodes();
    return {
      frames: this.frameCount,
      totalNodes: this.nodes.size,
      confirmedNodes: confirmed.length,
      unconfirmedNodes: this.nodes.size - confirmed.length,
      meanPersistence: this.nodes.size ? Array.from(this.nodes.values()).reduce((s, n) => s + n.persistence, 0) / this.nodes.size : 0,
      maxPersistence: this.nodes.size ? Math.max(...Array.from(this.nodes.values()).map(n => n.persistence)) : 0,
    };
  }
}
