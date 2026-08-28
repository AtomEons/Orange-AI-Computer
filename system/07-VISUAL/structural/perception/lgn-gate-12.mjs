// 07-VISUAL/structural/perception/lgn-gate-12.mjs
//
// LGN gate extended to the biological 12-channel Werblin bundle.
//
// The gate is a 12-float vector, one weight per retinal channel:
//   [gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, gate9, gate10, gate11, gate12]
//
// Memory-graph state modulates the vector. "Looking for a dog" amplifies
// channels 9 (edge), 5-8 (direction), 10 (object motion) and suppresses
// channel 11 (uniformity — background is not interesting when hunting).
//
// Concept nodes in the graph can carry a preferred_channel_weights field
// (12-dim vector). LGN blend combines active concepts' preferences.

export const CHANNEL_NAMES = [
  "onSustained","offSustained","onTransient","offTransient",
  "up","down","right","left",
  "localEdge","objectMotion","uniformity","sustainedDS",
];

export const NEUTRAL_12 = () => new Array(12).fill(1.0);

/**
 * Concept prototypes — what channels each broad concept-type wants amplified.
 * These are DEFAULTS; individual concept nodes may override.
 */
export const CONCEPT_PREFERENCES = {
  // Fruit: mostly static object, edges + surface + sustained brightness matter
  fruit:     [1.2, 0.8, 0.5, 0.5, 0.4, 0.4, 0.4, 0.4, 1.6, 0.8, 0.6, 0.4],
  // Skin (chromatic-family sibling to fruit): similar to fruit but higher uniformity weight
  skin:      [1.0, 0.9, 0.5, 0.5, 0.4, 0.4, 0.4, 0.4, 1.2, 0.7, 1.4, 0.4],
  // Dog: motion channels amplified, uniformity suppressed
  dog:       [1.0, 0.8, 1.0, 0.8, 1.2, 1.2, 1.2, 1.2, 1.5, 1.8, 0.3, 0.8],
  // Vehicle: sustained direction (ego-motion counter), object motion, edges
  vehicle:   [0.8, 0.8, 0.7, 0.7, 0.6, 0.6, 1.2, 1.2, 1.3, 1.7, 0.4, 1.6],
  // Landscape / scene: uniformity + sustained luminance
  landscape: [1.5, 1.2, 0.3, 0.3, 0.2, 0.2, 0.2, 0.2, 0.8, 0.3, 1.8, 0.5],
};

/**
 * Blend the 12-vector gate given a set of active concepts with activations.
 *
 * @param {Array<{label: string, activation: number, weights?: number[]}>} actives
 * @returns {number[]}  12-float gate vector
 */
export function computeGate12(actives) {
  if (!actives?.length) return NEUTRAL_12();
  const gate = new Array(12).fill(0);
  let total = 0;
  for (const c of actives) total += c.activation;
  if (total <= 0) return NEUTRAL_12();
  for (const c of actives) {
    const w = c.activation / total;
    const pref = c.weights ?? CONCEPT_PREFERENCES[c.label] ?? NEUTRAL_12();
    for (let i = 0; i < 12; i++) gate[i] += w * (pref[i] ?? 1.0);
  }
  return gate;
}

/**
 * Apply the gate to a 12-channel summary vector. Element-wise multiply +
 * renormalize so downstream distance functions still see a comparable scale.
 */
export function applyGate12(channelSummary, gate) {
  const out = { ...channelSummary };
  for (let i = 0; i < 12; i++) {
    const key = CHANNEL_NAMES[i];
    if (out[key] !== undefined) out[key] = out[key] * gate[i];
  }
  return out;
}

/**
 * Convert a 12-channel summary object into a flat 12-D Float32Array in
 * canonical channel order — for use in Hopfield attractor retrieval or
 * signature-distance computation.
 */
export function channels12ToVector(summary) {
  const out = new Float32Array(12);
  for (let i = 0; i < 12; i++) {
    const key = CHANNEL_NAMES[i];
    out[i] = summary[key] ?? 0;
  }
  return out;
}

/**
 * L2 distance between two 12-channel vectors (gate-aware if gate is passed).
 */
export function channels12Distance(a, b, gate = null) {
  const av = a instanceof Float32Array ? a : channels12ToVector(a);
  const bv = b instanceof Float32Array ? b : channels12ToVector(b);
  let s = 0;
  for (let i = 0; i < 12; i++) {
    const g = gate ? gate[i] : 1.0;
    s += g * (av[i] - bv[i]) ** 2;
  }
  return Math.sqrt(s);
}
