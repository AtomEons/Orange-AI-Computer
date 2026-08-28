// v2-contours.mjs — V2 contour integration + texture boundaries.
//
// V2 receives V1 orientation-column output and adds:
//   - Cross-orientation combination (contour continuity)
//   - Illusory-contour cells (Kanizsa-style boundary from occlusion)
//   - Texture-boundary cells (statistical difference across orientations)
//   - Border-ownership (which side is the object, which is background)
//
// We implement a simplified version:
//   1. Contour energy = maximum V1 response per pixel across orientations
//   2. Orientation dominance = strongest orientation at each pixel
//   3. Cross-orientation suppression = |maxOri| - mean(otherOris)
//   4. Texture boundary = spatial derivative of orientation histogram
//
// Zero learned parameters. Uses only V1 fields.

/**
 * v2Contours(v1) — takes v1Response output and computes contour + texture fields.
 *   v1.fields[i] = { scale, orientation, field }
 *
 * Returns per-scale contour + texture signature scalars.
 */
export function v2Contours(v1) {
  const W = v1.W, H = v1.H;
  const N = W * H;
  const numOri = 8;
  const numScales = 3;

  const result = {
    contour_energy: 0,
    contour_max: 0,
    ori_dominance: 0,
    cross_ori_suppression: 0,
    texture_boundary_energy: 0,
  };

  // For each scale, compute the max-across-orientations response
  const scaleContour = new Array(numScales);
  const scaleDominantOri = new Array(numScales);
  for (let s = 0; s < numScales; s++) {
    const maxField = new Float32Array(N);
    const dominant = new Uint8Array(N);
    // For each pixel, find max response across all 8 orientations at this scale
    for (let i = 0; i < N; i++) {
      let mx = -Infinity, mxIdx = 0;
      let sumOthers = 0;
      const fields = v1.fields.filter(f => f.scale === s);
      for (const f of fields) {
        const v = f.field[i];
        if (v > mx) { mx = v; mxIdx = f.orientation; }
      }
      // Cross-orientation suppression
      for (const f of fields) {
        if (f.orientation !== mxIdx) sumOthers += f.field[i];
      }
      const meanOthers = sumOthers / (numOri - 1);
      maxField[i] = Math.max(0, mx - meanOthers);
      dominant[i] = mxIdx;
    }
    scaleContour[s] = maxField;
    scaleDominantOri[s] = dominant;

    let contourSum = 0, contourMx = -Infinity;
    for (let i = 0; i < N; i++) {
      contourSum += maxField[i];
      if (maxField[i] > contourMx) contourMx = maxField[i];
    }
    result[`v2_scale_${s}_contour_mean`] = contourSum / N;
    result[`v2_scale_${s}_contour_max`] = contourMx;
    result.contour_energy += contourSum / N;
    if (contourMx > result.contour_max) result.contour_max = contourMx;
  }

  // Texture boundary: spatial derivative of dominant orientation
  // (rapid change in orientation = boundary between textures)
  let boundarySum = 0;
  for (const dominant of scaleDominantOri) {
    if (!dominant) continue;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const d0 = dominant[i];
        const d1 = dominant[i + 1];
        const d2 = dominant[i + W];
        // Circular difference on orientation
        const dx = Math.min(Math.abs(d0 - d1), 8 - Math.abs(d0 - d1));
        const dy = Math.min(Math.abs(d0 - d2), 8 - Math.abs(d0 - d2));
        boundarySum += dx + dy;
      }
    }
  }
  result.texture_boundary_energy = boundarySum / (N * numScales);

  return { fields: { contour: scaleContour, dominant: scaleDominantOri }, summary: result, W, H };
}
