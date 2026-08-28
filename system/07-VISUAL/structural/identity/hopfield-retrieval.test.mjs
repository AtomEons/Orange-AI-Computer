import { describe, expect, test } from "bun:test";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";

function signature(edgeSoftness) {
  return {
    color: { mean_R: 0, mean_G: 0, mean_B: 0, mean_RG: 0, mean_BY: 0, texture_var: 0, log_size: 0, log_aspect: 0 },
    edge: { meanEnergy: 0, orientationEntropy: 0, orientationHistogram: new Array(8).fill(0) },
    texture: { meanVariance: 0, lbpEntropy: 0, lbpTopCodes: [] },
    specular: { cov: 0, brightFraction: 0, glossinessScore: 0 },
    spatial: { cells: new Array(27).fill(0) },
    subsurface: { edgeSoftness, shadowGlowRatio: 0, translucencyScore: 0, boundaryWarmShift: 0 },
  };
}

describe("Hopfield optional-channel continuity", () => {
  test("keeps 8-axis evidence active through repeated retrieval updates", () => {
    const store = { labels: [
      { label: "flat", signatures: [{ sig: signature(0) }], channel_weights: { color: 0, edge: 0, texture: 0, specular: 0, spatial: 0, subsurface: 1 } },
      { label: "soft", signatures: [{ sig: signature(1) }], channel_weights: { color: 0, edge: 0, texture: 0, specular: 0, spatial: 0, subsurface: 1 } },
    ] };
    const result = hopfieldRetrieve(signature(1), store, { beta: 20, iters: 3 });
    expect(result.winner).toBe("soft");
    expect(result.retrievedPattern.subsurface).not.toBeNull();
    expect(result.retrievedPattern.subsurface.edgeSoftness).toBeGreaterThan(0.99);
  });
});
