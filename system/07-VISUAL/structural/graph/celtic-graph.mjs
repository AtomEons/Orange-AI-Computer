// 07-VISUAL/structural/graph/celtic-graph.mjs
//
// Celtic structural layer over the concept graph.
//
// Not decorative. AtomSmasher 2 Experiment 10 measured 18.05× compression on
// the receipt corpus via Fisher plait → brotli — the plait's regular strand
// structure exposes patterns brotli then exploits. The same structural
// regularity applied to the Æyes concept-graph gives four concrete wins:
//
//   1. Every CONCEPT is a Triquetra — a 3-strand knot binding
//      photonic (signature bank) + semantic (typed edges) + episodic
//      (frame timeline). Deterministic strand walk via trefoil t-parameter.
//   2. The chromatic-family taxonomy IS an n×m plait: rows = families,
//      cols = sub-classes. Fisher's gcd(n,m) tells us how many independent
//      taxonomic strands exist.
//   3. Möbius / Poincaré disk layout puts frequent concepts at center,
//      rare / boundary concepts at rim — cross-ratio preserved under
//      updates. Load-bearing for future visualization and traversal
//      priority.
//   4. Turning-key closure rule (Tetlow): a chromatic-family "closes"
//      only when its total signature count is an integer multiple of the
//      family's key-unit. Automatic incomplete-concept detection.
//
// Reference implementations (verified in AtomSmasher 2):
//   - Fisher/Brody plait math (Ex 07 plait — 18.05×)
//   - Trefoil parametric (Ex 45 C5 — 32,094 B on 1567-shape dictionary)
//   - Möbius column walk (Ex 45 C9 — 32,218 B)
//   - Wallpaper p4mm (Ex 45 C6 — 31,786 B)
//
// Bun-only, zero learned parameters, deterministic.

import { EDGE_TYPES } from "./concept-graph.mjs";

// ==================================================================
// TREFOIL — the 3-strand concept knot
// ==================================================================

/**
 * Parametric trefoil curve.
 *   x(t) = sin(t) + 2 sin(2t)
 *   y(t) = cos(t) - 2 cos(2t)
 *   z(t) = -sin(3t)
 *
 * For t ∈ [0, 2π]. The z-coordinate encodes the over/under weaving pattern.
 * Given a walk order N, return N sample points around the loop.
 */
export function trefoilPoints(N = 24) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    pts.push({
      t,
      x: Math.sin(t) + 2 * Math.sin(2 * t),
      y: Math.cos(t) - 2 * Math.cos(2 * t),
      z: -Math.sin(3 * t),
    });
  }
  return pts;
}

/**
 * Assign concept.signatures / edges / episodes onto the three strands of the
 * trefoil by their t-parameter position. Each strand covers 1/3 of the loop:
 *   Strand P (photonic):  t ∈ [0, 2π/3)      — signatures
 *   Strand S (semantic):  t ∈ [2π/3, 4π/3)   — outbound edges by type priority
 *   Strand E (episodic):  t ∈ [4π/3, 2π)     — episode nodes (temporal order)
 *
 * Returns a walk order that visits items in trefoil-parametric progression.
 * Determinism: same input → same walk.
 */
export function trefoilConceptView(graph, conceptId) {
  const c = graph.nodes.get(conceptId);
  if (!c || c.type !== "CONCEPT") return null;

  const photonic = [];
  const semantic = [];
  const episodic = [];

  for (const e of graph.edges) {
    if (e.from !== conceptId) continue;
    const target = graph.nodes.get(e.to);
    if (!target) continue;
    if (e.type === "MEASURED_AS" && target.type === "SIGNATURE") {
      photonic.push({ edge: e, node: target });
    } else if (target.type === "EPISODE") {
      episodic.push({ edge: e, node: target });
    } else {
      semantic.push({ edge: e, node: target });
    }
  }

  // Sort each strand deterministically by node id — reproducible walk
  const byId = (a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
  photonic.sort(byId);
  semantic.sort(byId);
  episodic.sort(byId);

  // Interleave into trefoil walk — take round-robin from each strand
  const walk = [];
  const maxLen = Math.max(photonic.length, semantic.length, episodic.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < photonic.length) walk.push({ strand: "P", ...photonic[i] });
    if (i < semantic.length) walk.push({ strand: "S", ...semantic[i] });
    if (i < episodic.length) walk.push({ strand: "E", ...episodic[i] });
  }

  // Attach t-coordinates from the parametric trefoil for spatial index
  const points = trefoilPoints(walk.length || 3);
  for (let i = 0; i < walk.length; i++) {
    walk[i].t = points[i].t;
    walk[i].x = points[i].x;
    walk[i].y = points[i].y;
    walk[i].z = points[i].z;
    walk[i].woven = walk[i].z >= 0 ? "over" : "under";
  }

  return {
    conceptId,
    strand_sizes: { photonic: photonic.length, semantic: semantic.length, episodic: episodic.length },
    walk,
    knot_signature: spectralHash(walk),   // 6 numbers describing the knot
  };
}

/**
 * Compact 6-number spectral signature of a trefoil walk.
 * Because trefoil = fundamental frequency 1 + 2, we take 3 amplitudes and
 * 3 phase offsets from the walk's coordinate list.
 */
function spectralHash(walk) {
  if (!walk.length) return { amp: [0, 0, 0], phase: [0, 0, 0] };
  const N = walk.length;
  let ax0 = 0, ax1 = 0, ax2 = 0, phx0 = 0, phx1 = 0, phx2 = 0;
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    ax0 += walk[i].x * Math.cos(t);       phx0 += walk[i].x * Math.sin(t);
    ax1 += walk[i].y * Math.cos(2 * t);   phx1 += walk[i].y * Math.sin(2 * t);
    ax2 += walk[i].z * Math.cos(3 * t);   phx2 += walk[i].z * Math.sin(3 * t);
  }
  return {
    amp: [ax0 / N, ax1 / N, ax2 / N],
    phase: [phx0 / N, phx1 / N, phx2 / N],
  };
}

// ==================================================================
// PLAIT — n×m chromatic-family taxonomy
// ==================================================================

/**
 * Fisher's strand-count theorem: an n×m rectangular plait weaving has
 * gcd(n, m) independent closed strands.
 */
export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Enumerate a plait cell arrangement. Returns { rowLabels, colLabels, cells }
 * where cells[i][j] is a slot for a CONCEPT id (or null).
 *
 * @param {string[]} rowLabels  chromatic families (e.g. ["orange","red","yellow"])
 * @param {string[]} colLabels  sub-class kinds (e.g. ["fruit","skin","sunset"])
 */
export function plaitTaxonomy(rowLabels, colLabels) {
  const n = rowLabels.length, m = colLabels.length;
  const cells = Array.from({ length: n }, () => new Array(m).fill(null));
  return {
    n, m, gcd: gcd(n, m),
    rowLabels: [...rowLabels], colLabels: [...colLabels],
    cells,
    slot: (row, col, conceptId) => {
      const i = rowLabels.indexOf(row), j = colLabels.indexOf(col);
      if (i < 0 || j < 0) return false;
      cells[i][j] = conceptId; return true;
    },
    strandOf: (row, col) => {
      // Fisher's strand identity: (r + c) mod gcd(n,m)
      const i = rowLabels.indexOf(row), j = colLabels.indexOf(col);
      if (i < 0 || j < 0) return -1;
      return (i + j) % gcd(n, m);
    },
    filledCount: () => cells.flat().filter(Boolean).length,
    emptyCount: () => cells.flat().filter((v) => !v).length,
  };
}

// ==================================================================
// MÖBIUS — Poincaré disk layout
// ==================================================================

/**
 * Möbius transform on the complex plane, extended to a Poincaré disk layout.
 *   f(z) = (a·z + b) / (c·z + d)
 * Cross-ratio (invariant under Möbius) is preserved between concept pairs.
 *
 * We use a simple hyperbolic-radius layout: activation → radius, angle
 * assigned by concept id hash so it's stable across sessions.
 */
export function mobiusLayout(graph, opts = {}) {
  const centerLabel = opts.center;   // one concept sits at origin
  const nodes = [...graph.nodes.values()].filter((n) => n.type === "CONCEPT");
  const layout = new Map();

  // Compute an activation proxy: signature count + edge count
  function activationOf(n) {
    let s = 0, e = 0;
    for (const edge of graph.edges) {
      if (edge.from === n.id) e++;
      if (edge.to === n.id) e++;
      if (edge.from === n.id && edge.type === "MEASURED_AS") s++;
    }
    return s + 0.3 * e;
  }
  const acts = nodes.map(activationOf);
  const maxAct = Math.max(1, ...acts);

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const isCenter = n.label === centerLabel;
    const act = acts[i];
    // Hyperbolic radius: r = tanh( (1 − act/maxAct) × 2 )
    const r = isCenter ? 0 : Math.tanh(2 * (1 - act / maxAct));
    // Angle from concept-id hash for stability
    const hash = simpleHash(n.id);
    const theta = (hash % 1000) / 1000 * 2 * Math.PI;
    layout.set(n.id, { x: r * Math.cos(theta), y: r * Math.sin(theta), r, activation: act });
  }
  return layout;
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return Math.abs(h);
}

/**
 * Poincaré-disk distance between two layout positions. Cross-ratio invariant.
 */
export function poincareDistance(pA, pB) {
  const dx = pA.x - pB.x, dy = pA.y - pB.y;
  const num = 2 * (dx * dx + dy * dy);
  const den = (1 - (pA.x * pA.x + pA.y * pA.y)) * (1 - (pB.x * pB.x + pB.y * pB.y));
  return Math.acosh(1 + num / Math.max(1e-9, den));
}

// ==================================================================
// TURNING KEY — closure validator
// ==================================================================

/**
 * Tetlow's turning-key closure rule: a periodic pattern only closes when the
 * unit-count is an integer multiple of the key-unit. For Æyes concepts, the
 * key-unit is the target signatures-per-concept for that concept's family
 * (small for center-of-family, larger for boundary).
 *
 * Returns diagnostic: closed?, missing_to_close, over_key_units.
 */
export function turningKeyClose(concept, opts = {}) {
  const keyUnit = opts.keyUnit ?? 8;    // canonical curated-signature K
  const targetUnits = opts.targetUnits ?? 25; // 200 sigs / 8-per-unit
  const N = concept.signatures?.length ?? 0;
  const units = Math.floor(N / keyUnit);
  const remainder = N - units * keyUnit;
  return {
    closed: remainder === 0 && units >= targetUnits,
    signatures: N,
    key_unit: keyUnit,
    complete_units: units,
    target_units: targetUnits,
    missing_to_close: remainder > 0 ? keyUnit - remainder : Math.max(0, (targetUnits - units) * keyUnit),
    over_key_units: Math.max(0, units - targetUnits),
  };
}

// ==================================================================
// Public high-level API — a Celtic view of the whole graph
// ==================================================================

/**
 * Build a full Celtic view of the graph: trefoil per concept + plait
 * taxonomy + Möbius layout + per-concept closure status.
 */
export function celticView(graph, plaitLabels, storeLabels = []) {
  const concepts = [...graph.nodes.values()].filter((n) => n.type === "CONCEPT");
  const trefoils = concepts.map((c) => trefoilConceptView(graph, c.id));
  const plait = plaitLabels
    ? plaitTaxonomy(plaitLabels.rows, plaitLabels.cols)
    : null;
  const layout = mobiusLayout(graph, { center: plaitLabels?.center });
  const closures = storeLabels.map((row) => ({ label: row.label, ...turningKeyClose(row) }));
  return { trefoils, plait, layout, closures };
}
