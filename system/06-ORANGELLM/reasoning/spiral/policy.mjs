// Spiral Reasoning policy — Belief Discipline parameters and presets.
//
// Source doctrine:
//   C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md
//   Disclosure ID: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
//   Paper: McCree A. (2026). Spiral Reasoning — Orthogonal Bivector Dynamics
//          for Coherent Thought in Latent Space. April 7, 2026.
//
// What this file owns:
//   - The four canonical Belief Discipline parameters:
//        alpha_max           upper bound on |Δθ_t| per step (radians)
//        r_max               cap on the substrate's radial displacement from z_0
//                            — the LEARN imperative gets a ceiling so unbounded
//                              growth cannot masquerade as "learning"
//        signal_threshold    minimum ||g_t^⊥|| / ||g_t|| required to count as
//                            genuine orthogonal novelty (graceful-degeneration
//                            gate — no curvature without signal)
//        degeneration_floor  minimum radius preserved during graceful
//                            degeneration so u_t stays defined and the
//                            substrate keeps breathing
//   - Three preset profiles the Sovereign can name explicitly:
//        tight        α ≤ π/8   conservative, holds course under pressure
//        balanced     α ≤ π/4   default operational stance
//        exploratory  α ≤ π/2   frontier / search lane (Misfit-Rebels)
//   - resolve() / merge() — produce a frozen, engine-ready policy object that
//     plugs straight into engine.mjs `step()` and `trajectory()`.
//   - validate() — hard refusal on any out-of-domain parameter; Mom's Law.
//
// Doctrine constraints enforced here (from §4 of the integration doctrine):
//   1. α is the Sovereign-configured maximum revision per cycle. Small = holds
//      course, large = flips on every signal. We bound α ∈ (0, π].
//   2. Graceful degeneration: a "new direction" with no genuine orthogonal
//      component does not turn the substrate. signal_threshold makes that gate
//      explicit and tunable.
//   3. Radial growth (LEARN) is gated through turning. r_max prevents a
//      runaway radius even when β is high.
//   4. The substrate must keep breathing when degenerate. degeneration_floor
//      keeps u_t defined and the spiral honest.
//
// Node 20+ ESM. No external deps. Real math, structured outputs, frozen
// returns, deterministic CLI receipt.

import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Canonical disclosure block

export const DOCTRINE = Object.freeze({
  disclosure_id: "ATOM-SPIRAL-INTEGRATION-v1-2026-0618",
  paper: "Spiral Reasoning — Orthogonal Bivector Dynamics for Coherent Thought in Latent Space (McCree, 2026-04-07)",
  integration_doctrine_path:
    "C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md",
  rule: "Belief Discipline — bounded angle α, exact radial accounting, graceful degeneration.",
  constraints: Object.freeze([
    "alpha_max bounded ∈ (0, π]",
    "r_max bounded > 0 or Infinity",
    "signal_threshold ∈ [0, 1)",
    "degeneration_floor > 0",
  ]),
});

// ---------------------------------------------------------------------------
// Hard parameter bounds

const ALPHA_MIN = Number.EPSILON;
const ALPHA_MAX_HARD = Math.PI;      // a full π would let the substrate U-turn;
                                     // values > π are nonsense for the bivector
                                     // rotation (angles wrap).
const R_MAX_MIN = Number.EPSILON;
const SIGNAL_THRESHOLD_MIN = 0;
const SIGNAL_THRESHOLD_MAX = 1 - Number.EPSILON; // a threshold of exactly 1
                                                 // would refuse every signal
                                                 // since confidence is in [0, 1].
const FLOOR_MIN = Number.EPSILON;

// ---------------------------------------------------------------------------
// Core four Belief Discipline parameters (defaults = "balanced")

export const DEFAULT_POLICY = Object.freeze({
  alpha_max:          Math.PI / 4, // balanced default
  r_max:              16,          // ceiling on ||z_t - z_0||; LEARN cap
  signal_threshold:   0.05,        // require ≥5% orthogonal share to turn
  degeneration_floor: 1e-6,        // min radius preserved during degeneration
});

// ---------------------------------------------------------------------------
// Engine-side parameters policy.resolve() fills in so the output plugs straight
// into engine.mjs without the caller re-merging defaults.

const ENGINE_DEFAULTS = Object.freeze({
  beta:        0.5,    // radial expansion coefficient per radian of turn
  epsilon:     1e-9,   // numerical floor for "zero" magnitudes
  ort_epsilon: 1e-6,   // engine.mjs graceful-degeneration threshold on ||g_ort||
  min_radius:  1e-6,   // floor for r_t to keep u_t defined near origin
  step_size:   1.0,    // scales linear fallback during degeneration
});

// ---------------------------------------------------------------------------
// Three preset profiles (named in the spec)

export const PRESETS = Object.freeze({
  tight: Object.freeze({
    name: "tight",
    description:
      "Conservative Belief Discipline — α ≤ π/8. Holds course under contradicting evidence. Use for adjudication, audit-anchored emission, Lethality Matrix decisions.",
    alpha_max:          Math.PI / 8,
    r_max:              8,
    signal_threshold:   0.10,
    degeneration_floor: 1e-6,
    beta:               0.25,        // slow radial growth — small steps
    ort_epsilon:        1e-5,        // stricter "no curvature without signal"
  }),

  balanced: Object.freeze({
    name: "balanced",
    description:
      "Default operational Belief Discipline — α ≤ π/4. The standing Sovereign-configured stance for Orange5 chat reasoning. Matches the integration doctrine's bounded ablation value (α = 0.25 ≈ π/12, here π/4 — wider but still bounded).",
    alpha_max:          Math.PI / 4,
    r_max:              16,
    signal_threshold:   0.05,
    degeneration_floor: 1e-6,
    beta:               0.5,
    ort_epsilon:        1e-6,
  }),

  exploratory: Object.freeze({
    name: "exploratory",
    description:
      "Frontier Belief Discipline — α ≤ π/2. Misfit-Rebels lane; allows large turns when genuine orthogonal novelty is present. Cap radius higher and lower the signal threshold so the substrate is permitted to chase signal. Never spammed into routine work.",
    alpha_max:          Math.PI / 2,
    r_max:              64,
    signal_threshold:   0.02,
    degeneration_floor: 1e-6,
    beta:               0.75,
    ort_epsilon:        1e-7,
  }),
});

/**
 * The set of preset names, in canonical order tight → balanced → exploratory.
 * @type {readonly string[]}
 */
export const PRESET_NAMES = Object.freeze(["tight", "balanced", "exploratory"]);

// ---------------------------------------------------------------------------
// Validation

/**
 * Validate a policy candidate. Returns { ok, errors[] }. Does not throw.
 *
 * Checks each of the four Belief Discipline parameters against the doctrine's
 * hard bounds, and the engine-side numerical floors when present.
 *
 * @param {object} p   candidate policy
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(p) {
  const errors = [];
  if (!p || typeof p !== "object") {
    return { ok: false, errors: ["policy must be an object"] };
  }

  // alpha_max
  if (!Number.isFinite(p.alpha_max)) {
    errors.push("alpha_max must be a finite number");
  } else if (p.alpha_max <= ALPHA_MIN) {
    errors.push(`alpha_max must be > 0 (got ${p.alpha_max})`);
  } else if (p.alpha_max > ALPHA_MAX_HARD) {
    errors.push(
      `alpha_max must be <= π (${ALPHA_MAX_HARD}); got ${p.alpha_max}. ` +
        "Angles beyond π wrap and the bivector rotation loses physical meaning.",
    );
  }

  // r_max — finite > 0 OR Infinity (explicit "no ceiling")
  if (p.r_max === Infinity) {
    // allowed
  } else if (!Number.isFinite(p.r_max)) {
    errors.push("r_max must be a finite positive number or Infinity");
  } else if (p.r_max <= R_MAX_MIN) {
    errors.push(`r_max must be > 0 (got ${p.r_max})`);
  }

  // signal_threshold
  if (!Number.isFinite(p.signal_threshold)) {
    errors.push("signal_threshold must be a finite number");
  } else if (p.signal_threshold < SIGNAL_THRESHOLD_MIN) {
    errors.push(`signal_threshold must be >= 0 (got ${p.signal_threshold})`);
  } else if (p.signal_threshold > SIGNAL_THRESHOLD_MAX) {
    errors.push(
      `signal_threshold must be < 1 (got ${p.signal_threshold}). ` +
        "A threshold of 1 would refuse every signal since confidence is in [0, 1].",
    );
  }

  // degeneration_floor
  if (!Number.isFinite(p.degeneration_floor)) {
    errors.push("degeneration_floor must be a finite number");
  } else if (p.degeneration_floor <= FLOOR_MIN) {
    errors.push(
      `degeneration_floor must be > 0 (got ${p.degeneration_floor})`,
    );
  }

  // engine-side params (only checked when present — resolve() fills defaults)
  if (p.beta !== undefined) {
    if (!Number.isFinite(p.beta) || p.beta < 0) {
      errors.push(`beta must be a finite number >= 0 (got ${p.beta})`);
    }
  }
  if (p.epsilon !== undefined) {
    if (!Number.isFinite(p.epsilon) || p.epsilon <= 0) {
      errors.push(`epsilon must be > 0 (got ${p.epsilon})`);
    }
  }
  if (p.ort_epsilon !== undefined) {
    if (!Number.isFinite(p.ort_epsilon) || p.ort_epsilon <= 0) {
      errors.push(`ort_epsilon must be > 0 (got ${p.ort_epsilon})`);
    }
  }
  if (p.min_radius !== undefined) {
    if (!Number.isFinite(p.min_radius) || p.min_radius <= 0) {
      errors.push(`min_radius must be > 0 (got ${p.min_radius})`);
    }
  }
  if (p.step_size !== undefined) {
    if (!Number.isFinite(p.step_size) || p.step_size < 0) {
      errors.push(`step_size must be finite and >= 0 (got ${p.step_size})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate-or-throw. Mom's Law shortcut: if the policy is malformed, fail
 * loudly with the full error list rather than silently slipping forward.
 *
 * @param {object} p
 * @returns {object}  the same `p` (frozen if it was already an object), so the
 *                    caller can write `const pol = assertValid(merge(...))`.
 */
export function assertValid(p) {
  const { ok, errors } = validate(p);
  if (!ok) {
    const e = new Error(
      `spiral/policy: invalid policy — ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`,
    );
    e.errors = errors;
    throw e;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Preset access

/**
 * Look up a preset profile by name.
 *
 * @param {string} name   one of "tight" | "balanced" | "exploratory"
 * @returns {object}      the frozen preset object
 * @throws {RangeError}   if the name is not a known preset
 */
export function preset(name) {
  if (typeof name !== "string") {
    throw new TypeError("preset: name must be a string");
  }
  const p = PRESETS[name];
  if (!p) {
    throw new RangeError(
      `preset: unknown profile "${name}". Known: ${PRESET_NAMES.join(", ")}`,
    );
  }
  return p;
}

// ---------------------------------------------------------------------------
// Merge + resolve

/**
 * Shallow-merge overrides onto a base policy. Used internally by resolve();
 * exported so callers can compose layers (e.g. preset + per-call override)
 * without going through resolve() if they want raw merging.
 *
 * Unknown keys are preserved verbatim — useful for caller-specific extras —
 * but the four canonical Belief Discipline keys always take precedence over
 * undefined values in the override.
 *
 * @param {object} base
 * @param {object} [overrides]
 * @returns {object}
 */
export function merge(base, overrides = {}) {
  if (!base || typeof base !== "object") {
    throw new TypeError("merge: base must be an object");
  }
  if (overrides && typeof overrides !== "object") {
    throw new TypeError("merge: overrides must be an object");
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Resolve a Sovereign-facing policy spec into an engine-ready, frozen object
 * that plugs straight into engine.mjs `step()` / `trajectory()`.
 *
 * Layering (each layer overwrites only the keys it defines):
 *   1. ENGINE_DEFAULTS   (beta, epsilon, ort_epsilon, min_radius, step_size)
 *   2. DEFAULT_POLICY    (alpha_max, r_max, signal_threshold, degeneration_floor)
 *   3. preset(profile)   if `profile` is provided — preset values override defaults
 *   4. overrides         per-call surgical adjustments
 *
 * The resolved policy is then validated. On any violation, throws (Mom's Law:
 * no fake-green; bad policy never reaches the engine).
 *
 * @param {object} [spec]
 * @param {string} [spec.profile]    "tight" | "balanced" | "exploratory"
 * @param {object} [spec.overrides]  surgical overrides (any of the four
 *                                   Belief Discipline params or engine-side)
 * @returns {Readonly<object>}       frozen, engine-ready policy carrying:
 *   {
 *     alpha_max, r_max, signal_threshold, degeneration_floor,   // Belief Discipline
 *     beta, epsilon, ort_epsilon, min_radius, step_size,        // engine-side
 *     ort_epsilon: max(ort_epsilon, derived-from-signal_threshold-hint),
 *     profile: string|null,
 *     doctrine: DOCTRINE,
 *   }
 */
export function resolve(spec = {}) {
  if (spec && typeof spec !== "object") {
    throw new TypeError("resolve: spec must be an object");
  }
  const profile = spec.profile ?? null;
  const overrides = spec.overrides ?? {};

  let pol = merge(ENGINE_DEFAULTS, DEFAULT_POLICY);
  if (profile != null) {
    const pre = preset(profile);
    // Strip presentational fields from the preset before merging.
    const { name: _n, description: _d, ...preParams } = pre;
    pol = merge(pol, preParams);
  }
  pol = merge(pol, overrides);

  // Cross-parameter coherence: the engine's ort_epsilon is the absolute-magnitude
  // floor on ||g_ort||; the doctrine's signal_threshold is the *ratio* floor on
  // ||g_ort|| / ||g||. They are different gates, but a signal_threshold of 0 is
  // doctrinally permitted (always-turn). We keep them independent and only attach
  // documentation, not coupling, so each gate stays meaningful.

  // Stamp the profile + doctrine onto the resolved object for receipts.
  pol.profile = profile;
  pol.doctrine = DOCTRINE;

  assertValid(pol);
  return Object.freeze(pol);
}

// ---------------------------------------------------------------------------
// Doctrinal gate helpers (used by callers wrapping engine.mjs step)

/**
 * Signal-threshold gate. The substrate refuses to turn when orthogonal share
 * is below threshold — "no curvature without signal" made explicit.
 *
 * @param {number} confidence   ||g_ort|| / ||g||  ∈ [0, 1]
 * @param {object} policy       a resolved policy
 * @returns {boolean}           true if the signal is strong enough to rotate
 */
export function signalGate(confidence, policy) {
  if (!Number.isFinite(confidence)) return false;
  if (!policy || !Number.isFinite(policy.signal_threshold)) return false;
  return confidence >= policy.signal_threshold;
}

/**
 * Radius cap. The LEARN imperative is gated by r_max so unbounded growth
 * cannot masquerade as learning.
 *
 * @param {number} r          candidate next radius
 * @param {object} policy     a resolved policy
 * @returns {number}          min(r, r_max), never below degeneration_floor
 */
export function capRadius(r, policy) {
  if (!Number.isFinite(r)) return policy.degeneration_floor;
  const capped = Math.min(r, policy.r_max);
  return Math.max(capped, policy.degeneration_floor);
}

// ---------------------------------------------------------------------------
// Receipt — a compact, log-shaped record of which profile/policy was applied.

/**
 * Build a small JSON-safe receipt of the resolved policy. Suitable for spine
 * logs, audit trails, and the LEARN imperative's per-step record.
 *
 * @param {object} policy   a resolved policy
 * @returns {object}
 */
export function receipt(policy) {
  return {
    profile:             policy.profile,
    alpha_max:           policy.alpha_max,
    r_max:               policy.r_max === Infinity ? "Infinity" : policy.r_max,
    signal_threshold:    policy.signal_threshold,
    degeneration_floor:  policy.degeneration_floor,
    beta:                policy.beta,
    ort_epsilon:         policy.ort_epsilon,
    disclosure_id:       policy.doctrine?.disclosure_id ?? DOCTRINE.disclosure_id,
    resolved_at_iso:     new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internals exported for tests; intentionally narrow.

export const __internals = Object.freeze({
  ALPHA_MIN,
  ALPHA_MAX_HARD,
  R_MAX_MIN,
  SIGNAL_THRESHOLD_MIN,
  SIGNAL_THRESHOLD_MAX,
  FLOOR_MIN,
  ENGINE_DEFAULTS,
});

// ---------------------------------------------------------------------------
// CLI: `node policy.mjs [tight|balanced|exploratory]` → print the resolved
// policy receipt. Defaults to balanced. Mom's Law: receipts only, no theater.

const isMain =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const arg = process.argv[2];
  try {
    if (arg === "--list" || arg === "list") {
      const out = PRESET_NAMES.map((n) => {
        const p = PRESETS[n];
        return {
          name: p.name,
          description: p.description,
          alpha_max: p.alpha_max,
          r_max: p.r_max,
          signal_threshold: p.signal_threshold,
          degeneration_floor: p.degeneration_floor,
          beta: p.beta,
        };
      });
      process.stdout.write(JSON.stringify({ ok: true, presets: out }, null, 2) + "\n");
    } else {
      const profile = arg && PRESETS[arg] ? arg : "balanced";
      const pol = resolve({ profile });
      const out = {
        ok: true,
        profile,
        policy: receipt(pol),
        doctrine: pol.doctrine,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    }
  } catch (err) {
    process.stderr.write(
      JSON.stringify(
        { ok: false, error: err.message, errors: err.errors ?? null },
        null,
        2,
      ) + "\n",
    );
    process.exit(1);
  }
}
