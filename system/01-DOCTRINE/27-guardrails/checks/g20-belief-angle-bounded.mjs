// G20 — Belief angle alpha is bounded.
//
// Spiral Reasoning v3: alpha must be in (0, pi/2). Soul Genome declares
// alpha_bound_radians as the operator's policy ceiling. A missing or
// out-of-range value is a violation.

import { ensureSoulGenome } from "../lib/soul-genome.mjs";

const PI_OVER_TWO = Math.PI / 2;

export async function run() {
  const g = ensureSoulGenome();
  const a = g?.spiral_reasoning?.alpha_bound_radians;
  if (typeof a !== "number" || Number.isNaN(a)) {
    return {
      pass: false,
      details: { reason: "alpha_bound_radians missing or not a number", value: a },
    };
  }
  if (a <= 0 || a >= PI_OVER_TWO) {
    return {
      pass: false,
      details: {
        reason: "alpha_bound_radians outside (0, pi/2)",
        value: a,
        pi_over_two: PI_OVER_TWO,
      },
    };
  }
  return {
    pass: true,
    details: { alpha_bound_radians: a, ceiling_pi_over_two: PI_OVER_TWO },
  };
}
