// whitened-metric.mjs — Full within-class covariance whitening (Mahalanobis)
// with closed-form Ledoit-Wolf shrinkage.
//
// FABLE'S MOVE 1: replaces the diagonal Fisher-ratio metric with the real
// thing. Diagonal per-dim weighting cannot cancel CORRELATED nuisance —
// a lighting change moves many dims coherently. The full within-class
// covariance captures those correlations; inverting it discounts entire
// nuisance directions.
//
// Zero parameters. Closed-form throughout:
//   - pooled within-class covariance W
//   - Ledoit-Wolf shrinkage intensity λ* (Ledoit & Wolf 2004 estimator)
//   - Cholesky factorization L L^T = W_shrunk
//   - whitening: y = L^(-1) x   (forward substitution)
//   - distance: d²(q,c) = ||L^(-1)(q - μ_c)||²  =  ||ỹ_q - ỹ_c||² in whitened space
//
// Everything is Float32/Float64 typed arrays in Bun. No native deps.

/**
 * Compute per-concept means (μ_c) and the pooled within-class covariance
 * matrix W (D×D). Vectors is an array of concept groups; each group is an
 * array of D-length Float32Arrays.
 *
 * Pooled within-class covariance:
 *   W = (1 / (N - K)) · Σ_c Σ_{x∈c} (x - μ_c)(x - μ_c)^T
 * where N = total samples, K = number of concepts.
 */
export function computeWithinClassCov(conceptVecs) {
  const D = conceptVecs[0][0].length;
  const K = conceptVecs.length;
  let N = 0;
  const means = new Array(K);

  // Per-concept means
  for (let c = 0; c < K; c++) {
    const vs = conceptVecs[c];
    N += vs.length;
    const mu = new Float64Array(D);
    for (const v of vs) {
      for (let i = 0; i < D; i++) {
        const val = v[i];
        if (Number.isFinite(val)) mu[i] += val;
      }
    }
    for (let i = 0; i < D; i++) mu[i] /= vs.length;
    means[c] = mu;
  }

  // Pooled within-class covariance (unbiased: divide by N - K)
  const W = new Float64Array(D * D);
  for (let c = 0; c < K; c++) {
    const vs = conceptVecs[c];
    const mu = means[c];
    for (const v of vs) {
      // Compute deviation vector
      const d = new Float64Array(D);
      for (let i = 0; i < D; i++) {
        const val = v[i];
        d[i] = Number.isFinite(val) ? val - mu[i] : 0;
      }
      // Outer product d dᵀ accumulated into W
      for (let i = 0; i < D; i++) {
        const di = d[i];
        if (di === 0) continue;
        const rowOff = i * D;
        for (let j = 0; j <= i; j++) {
          W[rowOff + j] += di * d[j];
        }
      }
    }
  }
  // Mirror upper triangle + normalize
  const denom = Math.max(1, N - K);
  for (let i = 0; i < D; i++) {
    for (let j = 0; j <= i; j++) {
      W[i * D + j] /= denom;
      W[j * D + i] = W[i * D + j];
    }
  }
  return { means, W, D, N, K };
}

/**
 * Compute Ledoit-Wolf shrinkage intensity λ* against the identity-scaled
 * target t = (tr(S)/D) · I.
 *
 *   π̂ = Σ_ij (1/N) · Σ_k [(x_ki - μ_i)(x_kj - μ_j) - S_ij]²
 *   γ̂ = ||S - t||²_F
 *   λ* = min(1, π̂ / (γ̂ · N))         (clamped to [0, 1])
 *
 * Returns { lambda, target_scalar }. Applied as:
 *   W_shrunk = (1 - λ) · S + λ · target_scalar · I
 */
export function ledoitWolfShrinkage(conceptVecs, S, means, N) {
  const D = S.length ** 0.5;
  const Di = Math.round(D);
  // target scalar
  let trace = 0;
  for (let i = 0; i < Di; i++) trace += S[i * Di + i];
  const target = trace / Di;

  // γ̂ = ||S - target·I||²_F
  let gamma = 0;
  for (let i = 0; i < Di; i++) {
    for (let j = 0; j < Di; j++) {
      const t = i === j ? target : 0;
      const diff = S[i * Di + j] - t;
      gamma += diff * diff;
    }
  }

  // π̂ estimator — sum over all samples of ||(x-μ)(x-μ)^T - S||²_F / N
  // Efficient equivalent form:
  //   π_ij = (1/N) Σ_k [(x_ki - μ_ki)(x_kj - μ_kj)]² - S_ij²
  // We compute a running sum of (x_ki - μ_ki)²·(x_kj - μ_kj)² across all samples.
  const piSum = new Float64Array(Di * Di);
  let K = conceptVecs.length;
  for (let c = 0; c < K; c++) {
    const vs = conceptVecs[c];
    const mu = means[c];
    for (const v of vs) {
      const d = new Float64Array(Di);
      for (let i = 0; i < Di; i++) {
        const val = v[i];
        d[i] = Number.isFinite(val) ? val - mu[i] : 0;
      }
      for (let i = 0; i < Di; i++) {
        const di2 = d[i] * d[i];
        if (di2 === 0) continue;
        const rowOff = i * Di;
        for (let j = 0; j < Di; j++) {
          piSum[rowOff + j] += di2 * d[j] * d[j];
        }
      }
    }
  }
  let piHat = 0;
  for (let i = 0; i < Di; i++) {
    for (let j = 0; j < Di; j++) {
      const piIJ = piSum[i * Di + j] / N - S[i * Di + j] * S[i * Di + j];
      piHat += piIJ;
    }
  }

  const denom = gamma * N;
  let lambda = denom > 0 ? piHat / denom : 1;
  if (lambda < 0) lambda = 0;
  if (lambda > 1) lambda = 1;
  return { lambda, target };
}

/**
 * Apply shrinkage: W_shrunk = (1-λ)·S + λ·target·I
 */
export function applyShrinkage(S, lambda, target) {
  const D = Math.round(S.length ** 0.5);
  const W = new Float64Array(S.length);
  for (let i = 0; i < D; i++) {
    for (let j = 0; j < D; j++) {
      W[i * D + j] = (1 - lambda) * S[i * D + j];
    }
    W[i * D + i] += lambda * target;
  }
  return W;
}

/**
 * Cholesky factorization: W = L L^T, L lower triangular.
 * Returns L as a D×D Float64Array (upper triangle zeros).
 * Adds a small diagonal jitter if numerically indefinite.
 */
export function cholesky(W) {
  const D = Math.round(W.length ** 0.5);
  const L = new Float64Array(W.length);
  const jitter = 1e-8;
  for (let i = 0; i < D; i++) {
    // Diagonal
    let sum = W[i * D + i];
    for (let k = 0; k < i; k++) sum -= L[i * D + k] * L[i * D + k];
    if (sum <= 0) sum = jitter;
    L[i * D + i] = Math.sqrt(sum);
    // Below-diagonal
    const inv = 1 / L[i * D + i];
    for (let j = i + 1; j < D; j++) {
      let s = W[j * D + i];
      for (let k = 0; k < i; k++) s -= L[j * D + k] * L[i * D + k];
      L[j * D + i] = s * inv;
    }
  }
  return L;
}

/**
 * Solve L y = x by forward substitution, in-place friendly.
 * L is lower triangular (D×D). x length D. Returns y (D-length Float64Array).
 */
export function forwardSubstitute(L, x) {
  const D = x.length;
  const y = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    let sum = x[i];
    for (let k = 0; k < i; k++) sum -= L[i * D + k] * y[k];
    y[i] = sum / L[i * D + i];
  }
  return y;
}

/**
 * Build a WHITENER from a store. Returns:
 *   - whiten(x) → whitened vector (still D-dim)
 *   - meansWhitened: Map<label, Float64Array>
 *   - lambda: shrinkage intensity used
 *
 * conceptVecs: array of { label, vecs: Float32Array[] } (standardized already, NaN-safe)
 */
export function buildWhitener(conceptGroups) {
  const conceptVecs = conceptGroups.map(g => g.vecs);
  const { means, W: S, D, N, K } = computeWithinClassCov(conceptVecs);
  const { lambda, target } = ledoitWolfShrinkage(conceptVecs, S, means, N);
  const W = applyShrinkage(S, lambda, target);
  const L = cholesky(W);
  // Pre-whiten each concept mean
  const meansWhitened = new Map();
  for (let c = 0; c < K; c++) {
    const yc = forwardSubstitute(L, means[c]);
    meansWhitened.set(conceptGroups[c].label, yc);
  }
  // Return whitening function + metadata
  return {
    whiten(x) { return forwardSubstitute(L, x); },
    meansWhitened,
    L,
    lambda,
    target,
    D, N, K,
    W,
  };
}

/**
 * Also whiten every training instance for KNN-in-whitened-space.
 */
export function buildWhitenerAndInstances(conceptGroups) {
  const w = buildWhitener(conceptGroups);
  const whitenedInstances = [];
  for (const g of conceptGroups) {
    for (const v of g.vecs) {
      const y = w.whiten(v);
      whitenedInstances.push({ label: g.label, vec: y });
    }
  }
  return { ...w, whitenedInstances };
}

/**
 * Squared Euclidean distance in whitened space (== Mahalanobis in raw).
 */
export function euclideanSq(a, b) {
  let s = 0;
  const D = a.length;
  for (let i = 0; i < D; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}
