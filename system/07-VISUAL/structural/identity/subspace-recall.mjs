// subspace-recall.mjs — Fable Move 6: photon-genome storage + orbit-fit recall.
//
// Instead of storing per-concept a bag of raw signatures and asking "which
// stored signature is closest", we store each concept as an AFFINE SUBSPACE
// (prototype + nuisance basis) and ask "does the query fit ANY concept's
// subspace with a physically-plausible residual?" Recall answers with:
//   winner (or null), residual, alternatives, unknown-gate verdict.
//
// The unknown gate — reject when the best-fit residual exceeds the concept's
// own 95th-percentile training residual — is the "never lies" mechanism.
// The system refuses to name what it cannot explain.
//
// Zero parameters. Closed-form: median, SVD (Jacobi on Xᵀ X), projection.
// Bun-native Float64Array only.

// ============================================================================
// Small numerics
// ============================================================================

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

// Per-dim median across an array of vectors (Float64/Float32Array).
function elementwiseMedian(vecs) {
  const D = vecs[0].length;
  const out = new Float64Array(D);
  for (let f = 0; f < D; f++) {
    const col = [];
    for (const v of vecs) if (Number.isFinite(v[f])) col.push(v[f]);
    out[f] = col.length ? median(col) : 0;
  }
  return out;
}

// Sanitize a vector (NaN → 0). Same convention used in whitened-metric.mjs.
function sanitize(v) {
  const D = v.length;
  const out = new Float64Array(D);
  for (let i = 0; i < D; i++) out[i] = Number.isFinite(v[i]) ? v[i] : 0;
  return out;
}

// ============================================================================
// SVD of a THIN matrix (n × D, n << D) via eigendecomposition of Xᵀ X.
// For our case: n = per-concept sample count (~8), D = flatten dims (~185).
// We want the k right singular vectors (D-dim); these are eigenvectors of XᵀX.
// XᵀX is D×D but only rank ≤ n, so we compute X Xᵀ (n×n) instead, cheap,
// then transform its eigenvectors to right-singular vectors via
//   v_i = Xᵀ u_i / σ_i .
// ============================================================================

function xxT(X) {
  // X: n × D (array of n Float64Array of length D). Returns n × n symmetric matrix.
  const n = X.length;
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let j = 0; j <= i; j++) {
      const xj = X[j];
      let s = 0;
      for (let d = 0; d < xi.length; d++) s += xi[d] * xj[d];
      M[i * n + j] = s;
      M[j * n + i] = s;
    }
  }
  return M;
}

// Jacobi eigendecomposition of an n×n symmetric matrix (Float64Array).
// n is small (typically ≤ 12 for our use case), so cost is negligible.
function jacobiEig(A_in, n) {
  const A = new Float64Array(A_in); // copy
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  const MAX_SWEEPS = 60;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += Math.abs(A[p * n + q]);
    if (off < 1e-14) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-16) continue;
        const app = A[p * n + p], aqq = A[q * n + q];
        const diff = aqq - app;
        let t;
        if (Math.abs(diff) < 1e-30) t = 1;
        else {
          const theta = diff / (2 * apq);
          t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        }
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        A[p * n + p] = app - t * apq;
        A[q * n + q] = aqq + t * apq;
        A[p * n + q] = 0;
        A[q * n + p] = 0;
        for (let r = 0; r < n; r++) {
          if (r !== p && r !== q) {
            const arp = A[r * n + p], arq = A[r * n + q];
            A[r * n + p] = c * arp - s * arq;
            A[r * n + q] = s * arp + c * arq;
            A[p * n + r] = A[r * n + p];
            A[q * n + r] = A[r * n + q];
          }
          const vrp = V[r * n + p], vrq = V[r * n + q];
          V[r * n + p] = c * vrp - s * vrq;
          V[r * n + q] = s * vrp + c * vrq;
        }
      }
    }
  }
  const evals = new Array(n);
  for (let i = 0; i < n; i++) evals[i] = A[i * n + i];
  const idx = evals.map((_, i) => i).sort((a, b) => evals[b] - evals[a]);
  const sortedVals = idx.map(i => evals[i]);
  const sortedVecs = idx.map(i => {
    const v = new Float64Array(n);
    for (let r = 0; r < n; r++) v[r] = V[r * n + i];
    return v;
  });
  return { eigenvalues: sortedVals, eigenvectors: sortedVecs };
}

// ============================================================================
// Build the concept model (prototype + nuisance basis + residual quantiles).
// vecs: array of D-length Float32/Float64Array (already flattened + sanitized).
// kMax: max nuisance basis rank to retain (default 4).
// ============================================================================

export function buildConceptSubspace(vecs, opts = {}) {
  const kMax = opts.kMax ?? 4;
  const n = vecs.length;
  const D = vecs[0].length;
  if (n < 2) {
    // Single-sample concept: no subspace to speak of; degenerate case.
    const p = sanitize(vecs[0]);
    return {
      prototype: p, basis: [], singVals: [], sampleResiduals: [0], residualQ95: 0,
      residualQ50: 0, n: 1, D, kEff: 0,
    };
  }
  // 1) Robust prototype = elementwise median
  const proto = elementwiseMedian(vecs.map(sanitize));

  // 2) Center vectors and stack rows for SVD via eigendecomp of X Xᵀ
  const centered = vecs.map(v => {
    const s = sanitize(v);
    const c = new Float64Array(D);
    for (let d = 0; d < D; d++) c[d] = s[d] - proto[d];
    return c;
  });
  const M = xxT(centered); // n × n
  const { eigenvalues, eigenvectors } = jacobiEig(M, n);
  // Discard tiny / negative eigenvalues; effective rank k
  const totalEnergy = eigenvalues.reduce((a, x) => a + Math.max(0, x), 0) || 1;
  // FABLE FIX (perfect-fit degeneracy): cap basis rank at n-3, not n-1.
  // With rank n-1 the basis reproduces the training set exactly → all
  // training residuals are 0 → radius Q95 = 0 → the unknown gate can never
  // pass for that concept (structural false-unknown). Leaving ≥2 residual
  // degrees of freedom keeps the concept's own residual scale measurable.
  const kEffCap = Math.min(kMax, Math.max(0, n - 3));
  let k = 0;
  const cumu = [];
  for (let i = 0; i < kEffCap; i++) {
    if (eigenvalues[i] <= totalEnergy * 1e-6) break;
    cumu.push(eigenvalues[i]);
    k++;
  }
  // 3) Right-singular vectors (D-dim) via v_i = Xᵀ u_i / σ_i
  const basis = [];
  const singVals = [];
  for (let i = 0; i < k; i++) {
    const sig = Math.sqrt(Math.max(0, eigenvalues[i]));
    if (sig < 1e-9) break;
    singVals.push(sig);
    const u = eigenvectors[i]; // n-vector
    const v = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += centered[r][d] * u[r];
      v[d] = s / sig;
    }
    basis.push(v);
  }
  // 4) Per-sample residuals AFTER projecting onto the basis: measure "how far
  //    is each training sample from the subspace we just fit?" These set the
  //    concept's own scale — the unknown gate is quantile of THIS distribution.
  const residuals = centered.map(c => residualToSubspace(c, basis));
  const residualQ95 = quantile(residuals, 0.95);
  const residualQ50 = quantile(residuals, 0.50);
  return {
    prototype: proto,
    basis, singVals,
    sampleResiduals: residuals,
    residualQ95, residualQ50,
    n, D, kEff: basis.length,
  };
}

/**
 * Distance from a centered vector to the span of a set of basis vectors (v ⊥ span).
 * residual = ||c - Σ_i (basis_i · c) · basis_i||.
 * Basis is assumed orthonormal (from our SVD it is).
 */
function residualToSubspace(centered, basis) {
  const D = centered.length;
  const rem = new Float64Array(D);
  for (let d = 0; d < D; d++) rem[d] = centered[d];
  for (const b of basis) {
    let coef = 0;
    for (let d = 0; d < D; d++) coef += b[d] * centered[d];
    for (let d = 0; d < D; d++) rem[d] -= coef * b[d];
  }
  let s = 0;
  for (let d = 0; d < D; d++) s += rem[d] * rem[d];
  return Math.sqrt(s);
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * Given a query vector q (D-dim), the concept's subspace model, return the
 * fit residual and the projection coordinate ("θ" — how far along the nuisance
 * axes the query lies; used by plausibility gates later).
 */
export function fitToSubspace(q, model) {
  const qs = sanitize(q);
  const D = qs.length;
  const centered = new Float64Array(D);
  for (let d = 0; d < D; d++) centered[d] = qs[d] - model.prototype[d];
  const theta = [];
  const rem = new Float64Array(D);
  for (let d = 0; d < D; d++) rem[d] = centered[d];
  for (const b of model.basis) {
    let coef = 0;
    for (let d = 0; d < D; d++) coef += b[d] * centered[d];
    theta.push(coef);
    for (let d = 0; d < D; d++) rem[d] -= coef * b[d];
  }
  let s = 0;
  for (let d = 0; d < D; d++) s += rem[d] * rem[d];
  const residual = Math.sqrt(s);
  return { residual, theta };
}

/**
 * Recognize against a set of concept models. Returns:
 *   winner, residual, alternatives (top-K), unknownGate (true = "unknown").
 *
 * Unknown gate: winner's residual must be below its OWN training-residual
 * q95. This is the never-lies primitive — the system refuses to name what
 * it cannot explain.
 */
export function recognizeAgainstSubspaces(q, conceptModels, opts = {}) {
  const topK = opts.topK ?? 5;
  const scores = [];
  for (const [label, model] of conceptModels.entries()) {
    const { residual, theta } = fitToSubspace(q, model);
    // Normalize by the concept's typical residual scale so different-scale
    // concepts are comparable. Small ε avoids divide-by-zero on rank-perfect fits.
    const scale = Math.max(1e-6, model.residualQ50);
    const normResidual = residual / scale;
    scores.push({ label, residual, normResidual, radius: model.residualQ95, theta });
  }
  scores.sort((a, b) => a.normResidual - b.normResidual);
  const winner = scores[0];
  // Unknown gate: raw residual must be below concept's own 95th percentile
  const passes = winner.residual <= winner.radius * 1.0;
  return {
    winner: passes ? winner.label : null,
    winnerResidual: winner.residual,
    winnerNormResidual: winner.normResidual,
    winnerRadius: winner.radius,
    unknownGate: !passes,
    alternatives: scores.slice(0, topK).map(s => ({
      label: s.label, residual: s.residual, normResidual: s.normResidual, radius: s.radius,
    })),
  };
}

/**
 * Aggregate multiple candidates from one frame into a per-concept score.
 * We take the BEST-residual candidate per concept (min-cand), which mirrors
 * how the other classifiers handle multi-region queries.
 */
export function recognizeFrameMultiCandidate(candidateVecs, conceptModels, opts = {}) {
  const perConcept = new Map();
  for (const [label, model] of conceptModels.entries()) {
    let best = { residual: Infinity, normResidual: Infinity };
    for (const q of candidateVecs) {
      const r = fitToSubspace(q, model);
      const scale = Math.max(1e-6, model.residualQ50);
      const normResidual = r.residual / scale;
      if (r.residual < best.residual) best = { residual: r.residual, normResidual };
    }
    perConcept.set(label, { ...best, radius: model.residualQ95 });
  }
  const ranked = [...perConcept.entries()]
    .map(([label, s]) => ({ label, ...s }))
    .sort((a, b) => a.normResidual - b.normResidual);
  const winner = ranked[0];
  const passes = winner && winner.residual <= winner.radius * 1.0;
  return {
    winner: passes ? winner.label : null,
    winnerResidual: winner?.residual ?? Infinity,
    winnerRadius: winner?.radius ?? 0,
    unknownGate: !passes,
    alternatives: ranked.slice(0, opts.topK ?? 5),
  };
}
