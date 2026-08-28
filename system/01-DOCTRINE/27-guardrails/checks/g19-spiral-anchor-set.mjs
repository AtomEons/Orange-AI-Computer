// G19 — Spiral Reasoning anchor (z_0 = Soul Genome) is set.
//
// Soul Genome must declare spiral_reasoning.anchor_set === true. We don't
// validate the math here — that's the SoT integrator's job — only the contract.

import { ensureSoulGenome } from "../lib/soul-genome.mjs";

export async function run() {
  const g = ensureSoulGenome();
  const sr = g?.spiral_reasoning || {};
  if (sr.anchor_set !== true) {
    return {
      pass: false,
      details: { reason: "Soul Genome spiral_reasoning.anchor_set is not true", value: sr.anchor_set },
    };
  }
  return {
    pass: true,
    details: {
      anchor_set: true,
      alpha_bound_radians: sr.alpha_bound_radians ?? null,
      integration_doc: sr.integration_doc ?? null,
    },
  };
}
