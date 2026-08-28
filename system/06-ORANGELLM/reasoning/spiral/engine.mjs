// Spiral Reasoning engine — Orthogonal Bivector Spiral-of-Thought (SoT) update rule.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Primary paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector
//   Dynamics for Coherent Thought in Latent Space. April 7, 2026.
//
// Update rule (d-dimensional, closed form):
//   u_t       = (z_t - z_0) / ||z_t - z_0||
//   g_par_t   = (g_t · u_t) * u_t
//   g_ort_t   = g_t - g_par_t
//   v_t       = g_ort_t / ||g_ort_t||        (graceful degeneration if ||g_ort_t|| ~ 0)
//   Δθ_t      = α · tanh(||g_ort_t|| / ||g_t||)         bounded by α (Belief Discipline)
//   r_t       = ||z_t - z_0||
//   r_{t+1}   = r_t · exp(β · Δθ_t)                     (LEARN imperative — exact radial accounting)
//   z_{t+1}   = z_0 + r_{t+1} · (cos(Δθ_t) · u_t + sin(Δθ_t) · v_t)
//
// Graceful degeneration (Proposition 3 in the paper): when ||g_ort_t|| is below
// epsilon, the substrate does not invent curvature from noise. It falls back to
// a linear radial-only update (no rotation, optional radial growth from g_par_t
// scaled by step_size — kept minimal to honor "no curvature without signal").
//
// Anchor (z_0) is pulled from the Soul Genome's identity vector. If no explicit
// vector field is present, a deterministic embedding is derived from stable
// genome fields (sovereign.name, schema_id, current_intent_id) — same input
// always yields the same anchor, so every chat starts spinning from the same
// origin.
//
// Mom's Law: real math, real receipts. Every step writes one audit entry with
// the radial component r and the bounded angle alpha used; the trajectory
// sums total_radial and tracks max_alpha across the path.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Defaults

export const DEFAULT_POLICY = Object.freeze({
  alpha_max: Math.PI / 4,     // Belief Discipline upper bound on |Δθ_t|
  beta: 0.5,                  // radial expansion coefficient per radian of turn
  epsilon: 1e-9,              // numerical floor for "zero" magnitudes
  ort_epsilon: 1e-6,          // graceful-degeneration threshold for ||g_ort_t||
  min_radius: 1e-6,           // floor for r_t to keep u_t defined near origin
  step_size: 1.0,             // scales the linear fallback when degenerate
});

// ---------------------------------------------------------------------------
// Pure vector helpers (d-dimensional, plain Float64Array/Array)

function asVec(x) {
  if (!x || typeof x.length !== "number" || x.length === 0) {
    throw new TypeError("vector must be a non-empty array-like of numbers");
  }
  const out = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Number(x[i]);
    if (!Number.isFinite(v)) {
      throw new TypeError(`vector index ${i} is not finite: ${x[i]}`);
    }
    out[i] = v;
  }
  return out;
}

function sameDim(a, b) {
  if (a.length !== b.length) {
    throw new RangeError(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
}

function vAdd(a, b) {
  sameDim(a, b);
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

function vSub(a, b) {
  sameDim(a, b);
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

function vScale(a, s) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s;
  return out;
}

function vDot(a, b) {
  sameDim(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function vNorm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

function vUnit(a, eps) {
  const n = vNorm(a);
  if (n < eps) return null;
  return vScale(a, 1 / n);
}

// ---------------------------------------------------------------------------
// Anchor: pull z_0 from a Soul Genome

/**
 * Pull the substrate's identity anchor z_0 from a Soul Genome.
 *
 * Resolution order:
 *   1. genome.identity_vector (explicit d-dim Array<number>) — preferred
 *   2. genome.anchor.vector
 *   3. Deterministic embedding derived from stable identity fields
 *      (sovereign.name + schema_id + current_intent_id). Same input → same
 *      anchor; survives session boundaries, as the doctrine requires.
 *
 * @param {object} genome  parsed soul_genome.json
 * @param {object} [opts]
 * @param {number} [opts.dim=16]  dimension for derived anchors
 * @returns {{ z_0: number[], source: string, dim: number, fingerprint: string }}
 */
export function anchor(genome, opts = {}) {
  if (!genome || typeof genome !== "object") {
    throw new TypeError("anchor: genome must be an object");
  }
  const dim = Math.max(2, opts.dim | 0 || 16);

  // 1) explicit identity vector
  if (Array.isArray(genome.identity_vector) && genome.identity_vector.length > 0) {
    const z = asVec(genome.identity_vector);
    return {
      z_0: z,
      source: "genome.identity_vector",
      dim: z.length,
      fingerprint: fingerprintVec(z),
    };
  }
  // 2) nested anchor block
  if (genome.anchor && Array.isArray(genome.anchor.vector) && genome.anchor.vector.length > 0) {
    const z = asVec(genome.anchor.vector);
    return {
      z_0: z,
      source: "genome.anchor.vector",
      dim: z.length,
      fingerprint: fingerprintVec(z),
    };
  }

  // 3) deterministic embedding from stable identity fields
  const stable = [
    genome?.sovereign?.name ?? "",
    genome?.sovereign?.email ?? "",
    genome?.schema_id ?? genome?.$schema ?? "",
    genome?.current_intent_id ?? "",
    genome?.active_project?.charter_id ?? "",
  ].join("|");

  const z = deriveVectorFromString(stable, dim);
  return {
    z_0: z,
    source: "derived:identity-hash",
    dim,
    fingerprint: fingerprintVec(z),
  };
}

function deriveVectorFromString(s, dim) {
  // Produce a deterministic, well-spread unit-magnitude-ish vector by hashing
  // (s || i) for each component. SHA-256 is overkill but cheap and audit-clean.
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const h = createHash("sha256").update(`${s}|${i}`).digest();
    // take 8 bytes → uint64 → map to [-1, 1)
    let v = 0;
    for (let b = 0; b < 8; b++) v = v * 256 + h[b];
    v = v / 2 ** 64;            // [0, 1)
    out[i] = v * 2 - 1;         // [-1, 1)
  }
  // do NOT normalize to unit norm — the substrate may legitimately start at
  // some non-unit radius from its own origin (and r_0 = ||z_0 - z_0|| = 0 by
  // construction during stepping; the anchor itself is just a reference point).
  return out;
}

function fingerprintVec(v) {
  const h = createHash("sha256");
  for (let i = 0; i < v.length; i++) {
    // write the IEEE-754 bytes so semantics are exact
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(v[i], 0);
    h.update(buf);
  }
  return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// One step: z_k, signal, policy → next state + audit record

/**
 * Apply one Spiral-of-Thought update.
 *
 * @param {number[]} z_k          current state (length d, same as z_0)
 * @param {number[]} signal       g_t steering signal (length d)
 * @param {object}   policy       merged over DEFAULT_POLICY; must carry z_0
 * @param {number[]} policy.z_0   identity anchor (length d)
 * @param {number}   [policy.alpha_max=π/4]
 * @param {number}   [policy.beta=0.5]
 * @param {number}   [policy.epsilon=1e-9]
 * @param {number}   [policy.ort_epsilon=1e-6]
 * @returns {{
 *   z_next: number[],
 *   r: number,             // r_{t+1} = new radius from anchor (LEARN receipt)
 *   delta_r: number,       // r_{t+1} - r_t
 *   alpha: number,         // |Δθ_t| actually used this step, bounded by alpha_max
 *   delta_theta: number,   // signed Δθ_t (== alpha here; sign convention positive toward v_t)
 *   confidence: number,    // ||g_ort|| / ||g||  ∈ [0, 1]; 0 = pure radial, 1 = pure orthogonal
 *   degenerate: boolean,   // true if graceful-degeneration branch fired
 *   r_prev: number,        // r_t for audit
 * }}
 */
export function step(z_k, signal, policy) {
  if (!policy || !Array.isArray(policy.z_0)) {
    throw new TypeError("step: policy.z_0 (anchor) is required");
  }
  const p = { ...DEFAULT_POLICY, ...policy };
  if (!(p.alpha_max > 0)) throw new RangeError("alpha_max must be > 0");
  if (!(p.beta >= 0)) throw new RangeError("beta must be >= 0");

  const z0 = asVec(p.z_0);
  const z = asVec(z_k);
  const g = asVec(signal);
  sameDim(z0, z);
  sameDim(z0, g);

  // Radial direction u_t. If z_t is essentially at the anchor, pick u_t from g
  // (or a stable fallback) so the spiral has a frame to start from.
  const radial = vSub(z, z0);
  const r_prev = vNorm(radial);

  let u;
  if (r_prev < p.min_radius) {
    // Seed u from the signal direction so the very first step still moves
    // away from origin coherently. If the signal is also zero, no motion.
    const gNorm = vNorm(g);
    if (gNorm < p.epsilon) {
      return {
        z_next: z.slice(),
        r: r_prev,
        delta_r: 0,
        alpha: 0,
        delta_theta: 0,
        confidence: 0,
        degenerate: true,
        r_prev,
      };
    }
    u = vScale(g, 1 / gNorm);
  } else {
    u = vScale(radial, 1 / r_prev);
  }

  // Decompose signal: g_par along u, g_ort orthogonal to u.
  const gDotU = vDot(g, u);
  const g_par = vScale(u, gDotU);
  const g_ort = vSub(g, g_par);
  const gOrtNorm = vNorm(g_ort);
  const gNorm = vNorm(g);

  // Graceful degeneration: no genuine orthogonal novelty → no curvature.
  // Fall back to linear radial-only update. Honors "no curvature without
  // signal" from the doctrine. We still allow a small radial nudge from
  // g_par * step_size so the substrate breathes (Lifespark BREATHE).
  if (gOrtNorm < p.ort_epsilon || gNorm < p.epsilon) {
    // Linear fallback: z_next = z + g_par * step_size (pure radial)
    const z_next_lin = vAdd(z, vScale(g_par, p.step_size));
    const r_next_lin = vNorm(vSub(z_next_lin, z0));
    return {
      z_next: z_next_lin,
      r: r_next_lin,
      delta_r: r_next_lin - r_prev,
      alpha: 0,
      delta_theta: 0,
      confidence: gNorm < p.epsilon ? 0 : 0,
      degenerate: true,
      r_prev,
    };
  }

  const v = vScale(g_ort, 1 / gOrtNorm);

  // Bounded turning angle: Δθ_t = α_max · tanh(||g_ort|| / ||g||).
  // tanh(·) ∈ (0, 1), so |Δθ_t| < α_max strictly — Belief Discipline is enforced.
  const confidence = gOrtNorm / gNorm;          // ∈ (0, 1]
  const deltaTheta = p.alpha_max * Math.tanh(confidence);
  const alpha = Math.abs(deltaTheta);

  // LEARN imperative: exact radial growth r_{t+1} = r_t · exp(β · Δθ_t).
  // If r_prev was floored (we seeded u from signal), start radius from min_radius
  // so growth has a defined base — the substrate's very first turn still records
  // an honest LEARN delta.
  const r_base = Math.max(r_prev, p.min_radius);
  const r_next = r_base * Math.exp(p.beta * deltaTheta);

  // Closed form: z_{t+1} = z_0 + r_{t+1} · (cos(Δθ) · u + sin(Δθ) · v)
  const dir = vAdd(vScale(u, Math.cos(deltaTheta)), vScale(v, Math.sin(deltaTheta)));
  const z_next = vAdd(z0, vScale(dir, r_next));

  return {
    z_next,
    r: r_next,
    delta_r: r_next - r_prev,
    alpha,
    delta_theta: deltaTheta,
    confidence,
    degenerate: false,
    r_prev,
  };
}

// ---------------------------------------------------------------------------
// Trajectory: walk N signals, log every r_k (LEARN audit log)

/**
 * Walk a sequence of signals from z_0, producing a full path + audit log.
 * Every step's radial r_k is recorded — the LEARN imperative.
 *
 * @param {number[]}   z_0        identity anchor
 * @param {number[][]} signals    sequence of g_t vectors
 * @param {object}     [policy]   merged with DEFAULT_POLICY
 * @returns {{
 *   path:          number[][],   // [z_0, z_1, ..., z_N], length N+1
 *   final:         number[],     // z_N
 *   audit:         Array<{       // length N — one entry per applied step
 *     k: number,
 *     r: number,
 *     delta_r: number,
 *     alpha: number,
 *     delta_theta: number,
 *     confidence: number,
 *     degenerate: boolean,
 *   }>,
 *   total_radial:  number,        // Σ |delta_r_k|  — total LEARN displacement
 *   max_alpha:     number,        // max |Δθ_k| observed
 *   steps:         number,        // N
 *   degenerate_count: number,     // how many steps fell back to linear
 * }}
 */
export function trajectory(z_0, signals, policy = {}) {
  if (!Array.isArray(z_0)) throw new TypeError("trajectory: z_0 must be an array");
  if (!Array.isArray(signals)) throw new TypeError("trajectory: signals must be an array");

  const anchorVec = asVec(z_0);
  const pol = { ...DEFAULT_POLICY, ...policy, z_0: anchorVec };

  const path = [anchorVec.slice()];
  const audit = [];
  let z = anchorVec.slice();
  let total_radial = 0;
  let max_alpha = 0;
  let degenerate_count = 0;

  for (let i = 0; i < signals.length; i++) {
    const out = step(z, signals[i], pol);
    z = out.z_next;
    path.push(z.slice());
    audit.push({
      k: i,
      r: out.r,
      delta_r: out.delta_r,
      alpha: out.alpha,
      delta_theta: out.delta_theta,
      confidence: out.confidence,
      degenerate: out.degenerate,
    });
    total_radial += Math.abs(out.delta_r);
    if (out.alpha > max_alpha) max_alpha = out.alpha;
    if (out.degenerate) degenerate_count++;
  }

  return {
    path,
    final: z,
    audit,
    total_radial,
    max_alpha,
    steps: signals.length,
    degenerate_count,
  };
}

// ---------------------------------------------------------------------------
// Small named exports for testing internals (kept narrow on purpose)

export const __internals = Object.freeze({
  vAdd, vSub, vScale, vDot, vNorm, vUnit,
  deriveVectorFromString, fingerprintVec,
});
