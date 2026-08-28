// 07-VISUAL/structural/flow-geometry.mjs
//
// KEY C — flow divergence + curl. Optical-flow geometry as an additional
// structural field on top of the four base retinal fields.
//
// Directional signal from empirical work: div/curl of the flow field is the
// only tested enhancement that helped object recovery. Everything else
// (multi-scale pyramid, phase-only features, ∂²L/∂t² acceleration) was
// refuted for principled physical reasons — see AE_STRUCTURAL_TOKENS_v1.md
// "Empirical directional findings" section.
//
// Physics (why this is real, not decoration):
//   - divergence ∇·v measures local expansion/contraction of the flow field.
//     Object interiors have low divergence (rigid translation); object
//     BOUNDARIES have high divergence (flow discontinuity).
//   - curl ∇×v (scalar in 2D) measures rotation. Object interiors are
//     rotation-consistent; boundaries produce a rotation flip.
//
// Both quantities are computed from a per-block motion vector field (vx, vy)
// via finite differences. Deterministic. Cheap. Pure JS.
//
// This module is a helper; the retinal-transform pipeline reads its outputs
// and populates the record's retinal_fields with the two summary scalars
// (divergence_energy_mean, curl_energy_mean). Full per-block tensors are
// summary-only in the record — never persisted as pixels.

/**
 * Compute divergence and curl of a per-block motion vector field.
 *
 * @param {Float32Array} vx    horizontal component, length cols*rows
 * @param {Float32Array} vy    vertical component, same shape
 * @param {number} cols        number of blocks across
 * @param {number} rows        number of blocks down
 * @returns {{ divergence: Float32Array, curl: Float32Array,
 *            divergenceEnergyMean: number, curlEnergyMean: number,
 *            boundaryScore: number }}
 *   boundaryScore is a scalar in [0,1] combining local |div| + |curl| — an
 *   honest proxy for "object-boundary density" without claiming a benchmark.
 */
export function flowDivergenceAndCurl(vx, vy, cols, rows) {
  if (vx.length !== cols * rows || vy.length !== cols * rows) {
    throw new Error("flowDivergenceAndCurl: vx/vy length must equal cols*rows");
  }
  const N = cols * rows;
  const divergence = new Float32Array(N);
  const curl = new Float32Array(N);
  let divEnergy = 0;
  let curlEnergy = 0;

  // Central differences on the interior; forward/backward on borders. Border
  // cells are set to zero rather than extrapolated — safer and disclosed.
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      const dvxdx = (vx[i + 1] - vx[i - 1]) * 0.5;
      const dvydy = (vy[i + cols] - vy[i - cols]) * 0.5;
      const dvydx = (vy[i + 1] - vy[i - 1]) * 0.5;
      const dvxdy = (vx[i + cols] - vx[i - cols]) * 0.5;
      const div = dvxdx + dvydy;
      const crl = dvydx - dvxdy;
      divergence[i] = div;
      curl[i] = crl;
      divEnergy += div * div;
      curlEnergy += crl * crl;
    }
  }

  const interiorCount = Math.max(1, (cols - 2) * (rows - 2));
  const divergenceEnergyMean = Math.sqrt(divEnergy / interiorCount);
  const curlEnergyMean = Math.sqrt(curlEnergy / interiorCount);

  // Boundary score: normalize combined |div|+|curl| into [0,1] via a soft
  // squash. Reported as a proxy signal, not a benchmark score.
  const combined = divergenceEnergyMean + curlEnergyMean;
  const boundaryScore = combined / (1 + combined);

  return {
    divergence,
    curl,
    divergenceEnergyMean,
    curlEnergyMean,
    boundaryScore,
  };
}

/**
 * Honest disclosure text a caller SHOULD append to record.notes[] when the
 * flow-geometry field is populated.
 */
export function flowGeometryNote({ divergenceEnergyMean, curlEnergyMean, boundaryScore }) {
  return (
    `flow-geometry: div_energy=${divergenceEnergyMean.toFixed(4)}, ` +
    `curl_energy=${curlEnergyMean.toFixed(4)}, boundary_score=${boundaryScore.toFixed(3)}. ` +
    `Border cells zeroed (finite-difference edge handling); interior-only support. ` +
    `Directional enhancement over 4-field baseline; magnitude of contribution is corpus-dependent.`
  );
}
