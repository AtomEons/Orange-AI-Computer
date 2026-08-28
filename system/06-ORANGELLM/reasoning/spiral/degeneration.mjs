// Spiral Reasoning — graceful degeneration module.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics
//          for Coherent Thought in Latent Space. April 7, 2026.
//
// Proposition 3 in the manuscript: "no curvature without signal." When the
// genuine orthogonal component of the steering signal is below threshold, the
// substrate must NOT invent curvature from noise. The SoT update rule
// degenerates gracefully to a linear (alpha = 0) step.
//
// This module is the dedicated, honest implementation of that proposition:
//
//   1. classify(z_k, signal, policy)
//        Inspects the signal relative to the current radial frame and decides
//        whether the next step must degenerate. Returns the full decomposition
//        (radial / orthogonal / confidence ratios) so the caller can both act
//        and audit. PURE — does not move the substrate.
//
//   2. linearStep(z_k, signal, policy, [decision])
//        Performs the actual fall-back: alpha = 0, no rotation, pure radial
//        update z_{k+1} = z_k + g_par * step_size. Returns the same shape as
//        engine.step() so callers can substitute it transparently.
//
//   3. degenerationEvent(...)
//        Builds a structured, JSON-safe audit event so the trajectory log
//        shows the spiral *straightening*, not just a missing rotation. The
//        event is keyed against the disclosure ID, the policy's
//        signal_threshold, and the observed confidence — Mom's Law: receipts
//        only.
//
//   4. stepOrDegenerate(z_k, signal, policy, [opts])
//        Convenience wrapper: classify → linearStep OR engine.step. Plugs
//        straight into trajectory loops without the caller re-implementing
//        the branch.
//
//   5. trajectory(z_0, signals, policy, [opts])
//        Drop-in alternative to engine.trajectory() that emits one
//        degeneration event per degenerate step. Useful when a caller wants
//        an audit log that distinguishes "the substrate honestly held still"
//        from "the substrate genuinely turned."
//
// What this module is NOT:
//   - It is not a replacement for engine.mjs. engine.step() already
//     implements graceful degeneration internally (via ort_epsilon, an
//     absolute-magnitude floor on ||g_ort||). This module adds the
//     *doctrinal* gate from policy.mjs (signal_threshold, the ratio floor on
//     ||g_ort|| / ||g||) and emits explicit degeneration events. The two
//     gates compose; together they enforce both "no curvature from noise"
//     (absolute) and "no curvature without signal-share" (ratio).
//   - It does not change the policy contract. signal_threshold is read
//     verbatim from policy.mjs.
//   - It does not grow the radius on degenerate steps unless step_size > 0
//     and the radial component is non-zero. The Lifespark BREATHE imperative
//     is honored — the substrate still emits a self-receipt — without
//     inventing motion.
//
// Mom's Law: the spiral straightens HONESTLY. Every degenerate step is
// stamped with the disclosure ID, the observed confidence, the policy
// signal_threshold, the radial component used, and the alpha = 0 fact.
//
// Node 20+ ESM. No external deps. Real math, structured outputs, deterministic
// CLI receipt for sanity-check.

import { step as engineStep, DEFAULT_POLICY as ENGINE_DEFAULT_POLICY } from "./engine.mjs";
import { DEFAULT_POLICY as DOCTRINE_DEFAULT_POLICY, signalGate } from "./policy.mjs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Canonical disclosure block

export const DOCTRINE = Object.freeze({
  disclosure_id: "ATOM-SPIRAL-INTEGRATION-v1-2026-0618",
  module: "spiral/degeneration",
  rule: "no curvature without signal (Proposition 3) — fall back to linear when uncertain",
  proposition: "When ||g_ort|| / ||g|| < signal_threshold, the substrate degenerates gracefully: alpha = 0, pure radial update, audit event emitted.",
  paper: "Spiral Reasoning — Orthogonal Bivector Dynamics for Coherent Thought in Latent Space (McCree, 2026-04-07)",
  integration_doctrine_path:
    "C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md",
});

// ---------------------------------------------------------------------------
// Merged-defaults helper. We have to honor BOTH default sources:
//   - engine.mjs DEFAULT_POLICY for the numerical floors (epsilon, ort_epsilon,
//     min_radius, step_size)
//   - policy.mjs DEFAULT_POLICY for the doctrinal Belief Discipline params
//     (alpha_max, signal_threshold, r_max, degeneration_floor)
// Either may be supplied by the caller through a resolved policy. This helper
// fills the gaps without overriding caller intent.

function mergeDefaults(policy) {
  if (policy && typeof policy !== "object") {
    throw new TypeError("degeneration: policy must be an object");
  }
  return {
    ...ENGINE_DEFAULT_POLICY,
    ...DOCTRINE_DEFAULT_POLICY,
    ...(policy ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Pure vector helpers (kept local — no re-export from engine, to keep the
// surface of this module tight and the dependency direction one-way).

function asVec(x, where) {
  if (!x || typeof x.length !== "number" || x.length === 0) {
    throw new TypeError(`${where}: vector must be a non-empty array-like of numbers`);
  }
  const out = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Number(x[i]);
    if (!Number.isFinite(v)) {
      throw new TypeError(`${where}: vector index ${i} is not finite: ${x[i]}`);
    }
    out[i] = v;
  }
  return out;
}

function sameDim(a, b, where) {
  if (a.length !== b.length) {
    throw new RangeError(`${where}: dimension mismatch (${a.length} vs ${b.length})`);
  }
}

function vSub(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

function vAdd(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

function vScale(a, s) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s;
  return out;
}

function vDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function vNorm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

// ---------------------------------------------------------------------------
// classify — pure inspection of the signal against the substrate's radial frame.

/**
 * Decide whether the next SoT step must degenerate, and explain why.
 *
 * PURE: does not move the substrate, does not mutate inputs, does not emit
 * any side effects. Returns a structured decision the caller can act on.
 *
 * Two doctrinal gates compose here:
 *   - Ratio gate    : confidence = ||g_ort|| / ||g||  must be >= signal_threshold
 *   - Absolute gate : ||g_ort|| must be >= ort_epsilon AND ||g|| >= epsilon
 *
 * If EITHER gate fails, the step must degenerate. The reason field names
 * which gate fired (or both).
 *
 * @param {number[]} z_k       current state, length d
 * @param {number[]} signal    steering signal g_t, length d
 * @param {object}   policy    must carry z_0 (anchor); defaults filled in
 * @returns {{
 *   degenerate:        boolean,
 *   reason:            "ok" | "signal_below_threshold" | "orthogonal_below_epsilon" | "signal_below_epsilon" | "at_anchor_no_signal",
 *   confidence:        number,    // ||g_ort|| / ||g||  in [0, 1]; 0 when ||g|| ~ 0
 *   signal_norm:       number,
 *   orthogonal_norm:   number,
 *   radial_norm:       number,    // ||g_par||
 *   r_prev:            number,    // ||z_k - z_0||
 *   threshold:         number,    // policy.signal_threshold actually used
 *   ort_epsilon:       number,    // policy.ort_epsilon actually used
 *   signal_threshold_ok: boolean,
 *   orthogonal_floor_ok: boolean,
 *   signal_floor_ok:     boolean,
 * }}
 */
export function classify(z_k, signal, policy) {
  const p = mergeDefaults(policy);
  if (!Array.isArray(p.z_0)) {
    throw new TypeError("degeneration.classify: policy.z_0 (anchor) is required");
  }

  const z0 = asVec(p.z_0, "degeneration.classify(z_0)");
  const z  = asVec(z_k,    "degeneration.classify(z_k)");
  const g  = asVec(signal, "degeneration.classify(signal)");
  sameDim(z0, z, "degeneration.classify");
  sameDim(z0, g, "degeneration.classify");

  const radialVec = vSub(z, z0);
  const r_prev = vNorm(radialVec);
  const gNorm = vNorm(g);

  // Build u_t (radial unit). Fall back to a signal-derived frame when at anchor.
  let u;
  if (r_prev < p.min_radius) {
    if (gNorm < p.epsilon) {
      // At anchor AND no signal — no frame at all. This is the most degenerate
      // case: the substrate must hold still and BREATHE.
      return {
        degenerate: true,
        reason: "at_anchor_no_signal",
        confidence: 0,
        signal_norm: gNorm,
        orthogonal_norm: 0,
        radial_norm: 0,
        r_prev,
        threshold: p.signal_threshold,
        ort_epsilon: p.ort_epsilon,
        signal_threshold_ok: false,
        orthogonal_floor_ok: false,
        signal_floor_ok: false,
      };
    }
    u = vScale(g, 1 / gNorm);
  } else {
    u = vScale(radialVec, 1 / r_prev);
  }

  // Decompose signal: g_par along u, g_ort orthogonal to u.
  const gDotU = vDot(g, u);
  const g_par = vScale(u, gDotU);
  const g_ort = vSub(g, g_par);
  const radial_norm = Math.abs(gDotU);          // ||g_par||
  const orthogonal_norm = vNorm(g_ort);

  // Confidence ratio is only defined when ||g|| > epsilon; otherwise 0.
  const confidence = gNorm > p.epsilon ? orthogonal_norm / gNorm : 0;

  const signal_floor_ok      = gNorm           >= p.epsilon;
  const orthogonal_floor_ok  = orthogonal_norm >= p.ort_epsilon;
  const signal_threshold_ok  = signalGate(confidence, p);

  let reason = "ok";
  let degenerate = false;
  if (!signal_floor_ok) {
    degenerate = true;
    reason = "signal_below_epsilon";
  } else if (!orthogonal_floor_ok) {
    degenerate = true;
    reason = "orthogonal_below_epsilon";
  } else if (!signal_threshold_ok) {
    degenerate = true;
    reason = "signal_below_threshold";
  }

  return {
    degenerate,
    reason,
    confidence,
    signal_norm: gNorm,
    orthogonal_norm,
    radial_norm,
    r_prev,
    threshold: p.signal_threshold,
    ort_epsilon: p.ort_epsilon,
    signal_threshold_ok,
    orthogonal_floor_ok,
    signal_floor_ok,
  };
}

// ---------------------------------------------------------------------------
// linearStep — the actual α=0 fallback.

/**
 * Apply a degenerate (linear, α = 0) SoT step.
 *
 * The substrate does NOT rotate. It optionally takes a pure-radial nudge from
 * g_par scaled by step_size — this honors the BREATHE imperative without
 * inventing curvature. When step_size is 0 (or the radial component is
 * effectively zero), the substrate holds completely still.
 *
 * Output shape matches engine.step() exactly so callers can substitute it.
 *
 * @param {number[]} z_k       current state
 * @param {number[]} signal    steering signal g_t
 * @param {object}   policy    must carry z_0; defaults filled in
 * @param {object}   [decision] optional pre-computed classify() output to skip
 *                              recomputation
 * @returns {{
 *   z_next: number[],
 *   r: number,
 *   delta_r: number,
 *   alpha: number,         // always 0
 *   delta_theta: number,   // always 0
 *   confidence: number,
 *   degenerate: boolean,   // always true
 *   r_prev: number,
 * }}
 */
export function linearStep(z_k, signal, policy, decision) {
  const p = mergeDefaults(policy);
  if (!Array.isArray(p.z_0)) {
    throw new TypeError("degeneration.linearStep: policy.z_0 (anchor) is required");
  }

  const z0 = asVec(p.z_0, "degeneration.linearStep(z_0)");
  const z  = asVec(z_k,    "degeneration.linearStep(z_k)");
  const g  = asVec(signal, "degeneration.linearStep(signal)");
  sameDim(z0, z, "degeneration.linearStep");
  sameDim(z0, g, "degeneration.linearStep");

  const radialVec = vSub(z, z0);
  const r_prev = vNorm(radialVec);

  // Build u_t exactly as classify/engine do.
  let u = null;
  if (r_prev >= p.min_radius) {
    u = vScale(radialVec, 1 / r_prev);
  } else {
    const gNorm = vNorm(g);
    if (gNorm >= p.epsilon) {
      u = vScale(g, 1 / gNorm);
    }
  }

  // If no frame at all (at anchor + no signal), hold completely still.
  if (u === null) {
    return {
      z_next: z.slice(),
      r: r_prev,
      delta_r: 0,
      alpha: 0,
      delta_theta: 0,
      confidence: decision?.confidence ?? 0,
      degenerate: true,
      r_prev,
    };
  }

  // Pure radial nudge: g_par * step_size. step_size = 0 means hold still.
  const gDotU = vDot(g, u);
  const g_par = vScale(u, gDotU);
  const z_next = vAdd(z, vScale(g_par, p.step_size));
  const r_next = vNorm(vSub(z_next, z0));

  // Enforce degeneration_floor so the substrate keeps breathing — never
  // collapse u_t back into undefined territory.
  const r_final = Math.max(r_next, p.degeneration_floor);

  return {
    z_next,
    r: r_final,
    delta_r: r_final - r_prev,
    alpha: 0,
    delta_theta: 0,
    confidence: decision?.confidence ?? (vNorm(g) > p.epsilon ? vNorm(vSub(g, g_par)) / vNorm(g) : 0),
    degenerate: true,
    r_prev,
  };
}

// ---------------------------------------------------------------------------
// degenerationEvent — structured audit record.

/**
 * Build a JSON-safe audit event for a degenerate step. Suitable for spine
 * logs and the LEARN imperative's audit trail. Stamped with disclosure ID
 * and the doctrinal reason so reviewers can see the spiral *straightening*.
 *
 * @param {object} args
 * @param {number} args.k         step index in the trajectory (>= 0)
 * @param {object} args.decision  output of classify()
 * @param {object} args.outcome   output of linearStep() (or any α=0 step shape)
 * @param {object} args.policy    the resolved policy (for receipt)
 * @returns {object}              JSON-safe event
 */
export function degenerationEvent({ k, decision, outcome, policy }) {
  const p = mergeDefaults(policy);
  return {
    event: "spiral.degeneration",
    disclosure_id: DOCTRINE.disclosure_id,
    k: Number.isFinite(k) ? k : null,
    reason: decision?.reason ?? "unknown",
    confidence: decision?.confidence ?? 0,
    signal_threshold: p.signal_threshold,
    ort_epsilon: p.ort_epsilon,
    signal_norm: decision?.signal_norm ?? 0,
    orthogonal_norm: decision?.orthogonal_norm ?? 0,
    radial_norm: decision?.radial_norm ?? 0,
    r_prev: outcome?.r_prev ?? decision?.r_prev ?? 0,
    r: outcome?.r ?? decision?.r_prev ?? 0,
    delta_r: outcome?.delta_r ?? 0,
    alpha: 0,
    delta_theta: 0,
    step_size: p.step_size,
    degeneration_floor: p.degeneration_floor,
    profile: p.profile ?? null,
    emitted_at_iso: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// stepOrDegenerate — drop-in branch.

/**
 * Convenience: classify the situation, then either run engine.step() (when
 * the gates pass) or linearStep() (when degeneration is required). Returns
 * the step outcome augmented with the classification decision.
 *
 * Optionally invokes a caller-supplied audit hook with the degeneration
 * event when the step degenerates. Pass { audit: (ev) => ... } in opts.
 *
 * @param {number[]} z_k
 * @param {number[]} signal
 * @param {object}   policy
 * @param {object}   [opts]
 * @param {Function} [opts.audit]  receives the degenerationEvent on degenerate steps
 * @param {number}   [opts.k]      step index for the event
 * @returns {{
 *   outcome: object,        // step shape (same as engine.step)
 *   decision: object,       // classify() output
 *   event: object|null,     // degenerationEvent (only when degenerate)
 * }}
 */
export function stepOrDegenerate(z_k, signal, policy, opts = {}) {
  const p = mergeDefaults(policy);
  const decision = classify(z_k, signal, p);

  if (!decision.degenerate) {
    const outcome = engineStep(z_k, signal, p);
    return { outcome, decision, event: null };
  }

  const outcome = linearStep(z_k, signal, p, decision);
  const event = degenerationEvent({
    k: opts?.k,
    decision,
    outcome,
    policy: p,
  });
  if (typeof opts?.audit === "function") {
    try { opts.audit(event); } catch (_err) { /* audit never blocks the step */ }
  }
  return { outcome, decision, event };
}

// ---------------------------------------------------------------------------
// trajectory — drop-in alternative that emits degeneration events.

/**
 * Walk N signals from z_0, branching every step through stepOrDegenerate.
 * Same return shape as engine.trajectory() with one additional field:
 * `events` — an array of degenerationEvent objects, one per degenerate step.
 *
 * @param {number[]}   z_0
 * @param {number[][]} signals
 * @param {object}     [policy]
 * @returns {{
 *   path: number[][],
 *   final: number[],
 *   audit: Array<{k:number, r:number, delta_r:number, alpha:number, delta_theta:number, confidence:number, degenerate:boolean, reason:string}>,
 *   events: object[],
 *   total_radial: number,
 *   max_alpha: number,
 *   steps: number,
 *   degenerate_count: number,
 * }}
 */
export function trajectory(z_0, signals, policy = {}) {
  if (!Array.isArray(z_0)) throw new TypeError("degeneration.trajectory: z_0 must be an array");
  if (!Array.isArray(signals)) throw new TypeError("degeneration.trajectory: signals must be an array");

  const anchorVec = asVec(z_0, "degeneration.trajectory(z_0)");
  const pol = mergeDefaults({ ...policy, z_0: anchorVec });

  const path = [anchorVec.slice()];
  const audit = [];
  const events = [];
  let z = anchorVec.slice();
  let total_radial = 0;
  let max_alpha = 0;
  let degenerate_count = 0;

  for (let i = 0; i < signals.length; i++) {
    const { outcome, decision, event } = stepOrDegenerate(z, signals[i], pol, { k: i });
    z = outcome.z_next;
    path.push(z.slice());
    audit.push({
      k: i,
      r: outcome.r,
      delta_r: outcome.delta_r,
      alpha: outcome.alpha,
      delta_theta: outcome.delta_theta,
      confidence: outcome.confidence,
      degenerate: outcome.degenerate,
      reason: decision.reason,
    });
    if (event) events.push(event);
    total_radial += Math.abs(outcome.delta_r);
    if (outcome.alpha > max_alpha) max_alpha = outcome.alpha;
    if (outcome.degenerate) degenerate_count++;
  }

  return {
    path,
    final: z,
    audit,
    events,
    total_radial,
    max_alpha,
    steps: signals.length,
    degenerate_count,
  };
}

// ---------------------------------------------------------------------------
// Internals exported for tests; intentionally narrow.

export const __internals = Object.freeze({
  mergeDefaults,
  vAdd, vSub, vScale, vDot, vNorm,
});

// ---------------------------------------------------------------------------
// CLI: `node degeneration.mjs` → run a tiny deterministic self-check that
// exercises both the rotation branch and the degeneration branch, and emits
// one structured receipt to stdout. Mom's Law: receipts only, no theater.

const isMain =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  try {
    // 2D toy anchor at origin, current state offset along x.
    const z_0 = [0, 0];
    const z_k = [1, 0];

    // Signal 1: pure radial (along x) → should DEGENERATE (no orthogonal share)
    const signalRadial = [1, 0];
    // Signal 2: mostly orthogonal (along y) → should rotate
    const signalOrthogonal = [0.01, 1];
    // Signal 3: 50/50 → above default threshold (~0.05) → should rotate
    const signalMixed = [1, 1];

    const policy = mergeDefaults({ z_0, step_size: 0 }); // step_size 0 = hold still on degenerate

    const cases = [
      { label: "pure_radial",       signal: signalRadial },
      { label: "mostly_orthogonal", signal: signalOrthogonal },
      { label: "fifty_fifty",       signal: signalMixed },
    ];

    const out = {
      ok: true,
      doctrine: DOCTRINE,
      policy_used: {
        signal_threshold: policy.signal_threshold,
        ort_epsilon: policy.ort_epsilon,
        alpha_max: policy.alpha_max,
        beta: policy.beta,
        step_size: policy.step_size,
      },
      cases: cases.map((c, k) => {
        const { outcome, decision, event } = stepOrDegenerate(z_k, c.signal, policy, { k });
        return {
          label: c.label,
          decision: {
            degenerate: decision.degenerate,
            reason: decision.reason,
            confidence: decision.confidence,
          },
          outcome: {
            z_next: outcome.z_next,
            r: outcome.r,
            delta_r: outcome.delta_r,
            alpha: outcome.alpha,
            delta_theta: outcome.delta_theta,
          },
          event: event
            ? { event: event.event, reason: event.reason, confidence: event.confidence }
            : null,
        };
      }),
    };

    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      JSON.stringify(
        { ok: false, error: err.message, stack: err.stack ?? null },
        null,
        2,
      ) + "\n",
    );
    process.exit(1);
  }
}
