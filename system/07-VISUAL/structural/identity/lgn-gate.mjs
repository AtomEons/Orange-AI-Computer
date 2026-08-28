// lgn-gate.mjs — Lateral Geniculate Nucleus memory-primed attention gate.
//
// ZERO learned parameters. Purely a deterministic Bayesian-flavored prior
// carried across frames of a single held-out video.
//
// Biological intuition: the LGN receives massive cortico-thalamic feedback
// from V1 that acts as a temporal prior on which retinal signals get
// amplified. When you see a cat at frame 1, the LGN pre-activates cat-like
// features for frame 2, sharpening the KNN metric in favor of continuity
// while still allowing a strong dissenting signal to override.
//
// Contract:
//   const gate = createLGNGate({ conceptLabels, decay: 0.5, gain: 0.30 });
//   for each frame:
//     const perLabelDist = computeKnnDistPerLabel(frame);      // Map<label, minD>
//     const primed = gate.applyPrior(perLabelDist);            // Map<label, primedD>
//     const winner = argmin(primed);
//     gate.observe(winner, marginConfidence);                  // Hebbian update
//
// Rules:
//   - Prior is a probability distribution over concepts (sums to 1).
//   - On each frame, the prior multiplies distance by (1 - gain * prior[label]).
//     A concept with 100% prior mass gets its distance shrunk by up to `gain`.
//     A concept with 0% prior mass is untouched.
//   - After each frame, the observed winner adds Hebbian mass equal to its
//     margin-confidence (softmax-flavored). Mass then decays by `decay` factor.
//   - First frame: uniform prior → no bias.

export function createLGNGate({ conceptLabels, decay = 0.5, gain = 0.30 } = {}) {
  if (!Array.isArray(conceptLabels) || conceptLabels.length === 0) {
    throw new Error("createLGNGate: conceptLabels required");
  }
  const N = conceptLabels.length;
  // Start uniform.
  let prior = new Map();
  for (const l of conceptLabels) prior.set(l, 1 / N);
  let framesSeen = 0;

  function applyPrior(perLabelDist) {
    // perLabelDist: Map<label, minD>. Return Map<label, primedD>.
    const out = new Map();
    for (const [label, d] of perLabelDist.entries()) {
      const p = prior.get(label) ?? 0;
      // Distance is shrunk in favor of prior-heavy labels.
      const primedD = d * (1 - gain * p);
      out.set(label, primedD);
    }
    return out;
  }

  function observe(winnerLabel, confidence = 1.0) {
    if (!winnerLabel) return;
    // Decay all mass, then add confidence-weighted Hebbian bump to winner.
    const decayed = new Map();
    let sum = 0;
    for (const [l, p] of prior.entries()) {
      const v = p * decay;
      decayed.set(l, v);
      sum += v;
    }
    // Hebbian bump: add `confidence` mass to winner.
    const bump = Math.max(0, Math.min(1, confidence));
    decayed.set(winnerLabel, (decayed.get(winnerLabel) || 0) + bump);
    sum += bump;
    // Renormalize.
    const inv = sum > 0 ? 1 / sum : 0;
    const norm = new Map();
    for (const [l, v] of decayed.entries()) norm.set(l, v * inv);
    prior = norm;
    framesSeen++;
  }

  function reset() {
    prior = new Map();
    for (const l of conceptLabels) prior.set(l, 1 / N);
    framesSeen = 0;
  }

  function snapshot() {
    const arr = [...prior.entries()].sort((a, b) => b[1] - a[1]);
    return { framesSeen, topK: arr.slice(0, 5) };
  }

  return { applyPrior, observe, reset, snapshot };
}
