// 07-VISUAL/structural/identity/skin-tone-synthesis-ita.mjs
//
// ITA-parameterized skin synthesis — SIBLING to skin-tone-synthesis.mjs.
// Does NOT replace Fitzpatrick. Both coexist.
//
// Individual Typology Angle (Chardon et al., 1991):
//   ITA (degrees) = arctan((L_star minus 50) / b_star) times (180 over PI)
//
// Six ITA classifications: Very Light, Light, Intermediate, Tan, Brown, Dark.
//
// Callers can register either the Fitzpatrick concept, the ITA concept,
// or both. Both concepts coexist in the store as separate labels.
//
// Bun-native, zero learned parameters, deterministic.

import { hueRotateSignature } from "./skin-tone-synthesis.mjs";
import { attachSignaturesV2, updateChannelWeights } from "./identity-store-v2.mjs";

//
// ITA anchor angles (radians) from orange-family origin. Empirically
// calibrated so canonical ITA classes map to specific (RG, BY) rotations
// from the trained orange concept. Chardon 1991 gives the L-star over
// b-star thresholds; we translate them to opponent-space rotations that
// approximate the same chromatic destination in our descriptor space.
//
export const ITA_HUE_OFFSETS = [
  { label: "ita_very_light", rad: 0.05, ita_deg_center: 65 },
  { label: "ita_light",      rad: 0.15, ita_deg_center: 48 },
  { label: "ita_intermediate", rad: 0.25, ita_deg_center: 34 },
  { label: "ita_tan",        rad: 0.35, ita_deg_center: 19 },
  { label: "ita_brown",      rad: 0.50, ita_deg_center: -10 },
  { label: "ita_dark",       rad: 0.65, ita_deg_center: -45 },
];

export function synthesizeSkinConceptITA(store, opts = {}) {
  const baseLabel = opts.baseLabel ?? "orange";
  const newLabel = opts.newLabel ?? "human_skin_ita";
  const offsets = opts.offsets ?? ITA_HUE_OFFSETS;
  const timestamp = opts.timestamp ?? new Date().toISOString();

  const baseRow = store.labels.find((r) => r.label === baseLabel);
  if (!baseRow) throw new Error("no " + baseLabel + " concept in store");

  const synthesizedSigs = [];
  const perTypeSummary = [];
  for (const off of offsets) {
    const rotated = baseRow.signatures.map((s) => hueRotateSignature(s.sig, off.rad));
    for (const rotSig of rotated) synthesizedSigs.push(rotSig);
    let sumRG = 0, sumBY = 0;
    for (let i = 0; i < baseRow.signatures.length; i++) {
      sumRG += rotated[i].color.mean_RG - baseRow.signatures[i].sig.color.mean_RG;
      sumBY += rotated[i].color.mean_BY - baseRow.signatures[i].sig.color.mean_BY;
    }
    perTypeSummary.push({
      type: off.label,
      ita_deg_center: off.ita_deg_center,
      n_signatures: baseRow.signatures.length,
      mean_RG_shift: sumRG / baseRow.signatures.length,
      mean_BY_shift: sumBY / baseRow.signatures.length,
    });
  }

  attachSignaturesV2(store, newLabel, synthesizedSigs, "synthesized from " + baseLabel + " via ITA offsets", timestamp);
  updateChannelWeights(store, newLabel, {
    color: 1.2, edge: 0.5, texture: 1.3, specular: 0.4, spatial: 0.8,
  });

  return {
    newLabel,
    signatures_added: synthesizedSigs.length,
    ita_types: offsets.length,
    summary_per_type: perTypeSummary,
  };
}
