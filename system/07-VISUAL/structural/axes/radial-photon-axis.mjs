// 07-VISUAL/structural/axes/radial-photon-axis.mjs
//
// RADIAL PHOTON PROFILE — how R/G/B/L vary from the region CENTROID
// outward to the region edge. Captures spatial arrangement of color
// in a ROTATION-INVARIANT way (radius only, angle averaged).
//
// - Orange: R uniform across radii (all peel same color)
// - Tomato: R uniform, slight bright ring from specular highlight
// - Strawberry: R uniform but Hu-moments capture seed-cluster texture
//               and Hu-moments will separate it from tomato/orange
// - Watermelon slice: R HIGH near center (flesh), LOW near edge (rind)
//                     G LOW near center, HIGH near edge — flip pattern
// - Banana: L HIGH along principal axis (curved shape averages)
// - Human skin: R/G/B all track L (smooth pigmentation gradient)
//
// Design:
//   - Compute centroid via mean of warm-mask coordinates
//   - Compute max radius = distance from centroid to farthest region pixel
//   - Bin pixels by (radius / max_radius) into 8 rings
//   - Per ring, mean of R, G, B, L
//   - 8 rings × 4 channels = 32 scalars per region
//   - Illumination-affine but rotation-invariant
//
// Zero learned parameters. Deterministic. Bun-native, Float32-only.

const NUM_RINGS = 8;

export function radialPhotonProfileForRegion(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);

  // Centroid of warm content (or bbox center if no warm)
  let sX = 0, sY = 0, warmCount = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      if (R[i] > B[i] + 0.03 && R[i] + G[i] > 0.5) {
        sX += x; sY += y; warmCount++;
      }
    }
  }
  const cx = warmCount > 0 ? sX / warmCount : (xs + x1) / 2;
  const cy = warmCount > 0 ? sY / warmCount : (ys + y1) / 2;

  // Max radius from centroid to any region pixel
  let maxR = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > maxR) maxR = r;
    }
  }
  if (maxR <= 0) {
    return { rings: new Array(NUM_RINGS * 4).fill(0), max_radius: 0 };
  }

  // Bin all pixels by radius ratio + track region overall mean for log-ratio reference
  const sumR = new Float32Array(NUM_RINGS);
  const sumG = new Float32Array(NUM_RINGS);
  const sumB = new Float32Array(NUM_RINGS);
  const sumL = new Float32Array(NUM_RINGS);
  const counts = new Int32Array(NUM_RINGS);
  let totalR = 0, totalG = 0, totalB = 0, totalL = 0, totalN = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      let bin = Math.floor((r / maxR) * NUM_RINGS);
      if (bin >= NUM_RINGS) bin = NUM_RINGS - 1;
      const i = y * width + x;
      const L = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
      sumR[bin] += R[i]; sumG[bin] += G[i]; sumB[bin] += B[i]; sumL[bin] += L;
      totalR += R[i]; totalG += G[i]; totalB += B[i]; totalL += L;
      counts[bin]++; totalN++;
    }
  }

  // FABLE MOVE 4 (invariant coordinates): ring values become log-ratio against
  // the region's overall channel mean. log(ring_c / region_mean_c) — invariant
  // to illumination color/intensity under diagonal von Kries.
  //
  // GPT doctrine v5 correction (spine seq post-117):
  //   - Guard log argument against non-positive input (post-CAT02 negatives)
  //   - When a ring has ZERO SUPPORT (counts[bin]==0), emit null NOT zero.
  //     Zero would falsely claim "measured mean at detection floor."
  //     Null with a per-ring valid mask means "measurement could not be computed."
  const eps = 1e-3;
  const regionMeanR = totalN ? Math.max(0, totalR / totalN) : 0;
  const regionMeanG = totalN ? Math.max(0, totalG / totalN) : 0;
  const regionMeanB = totalN ? Math.max(0, totalB / totalN) : 0;
  const regionMeanL = totalN ? Math.max(0, totalL / totalN) : 0;
  const logRegionR = Math.log(regionMeanR + eps);
  const logRegionG = Math.log(regionMeanG + eps);
  const logRegionB = Math.log(regionMeanB + eps);
  const logRegionL = Math.log(regionMeanL + eps);
  const rings = [];
  const ringValid = [];   // per-ring validity mask (4-tuple: R, G, B, L)
  for (let bin = 0; bin < NUM_RINGS; bin++) {
    if (counts[bin] > 0) {
      // Guard: post-CAT02 pixel means can go slightly negative. Clip to 0 before log
      // so log argument is at least eps. This says "at or below detection floor",
      // which is a legitimate measurement, not a semantic-null.
      const mR = Math.max(0, sumR[bin] / counts[bin]);
      const mG = Math.max(0, sumG[bin] / counts[bin]);
      const mB = Math.max(0, sumB[bin] / counts[bin]);
      const mL = Math.max(0, sumL[bin] / counts[bin]);
      rings.push(
        Math.log(mR + eps) - logRegionR,
        Math.log(mG + eps) - logRegionG,
        Math.log(mB + eps) - logRegionB,
        Math.log(mL + eps) - logRegionL,
      );
      ringValid.push(true, true, true, true);
    } else {
      // ZERO_SUPPORT: no pixels binned into this ring. Do NOT emit zero.
      // Emit null with valid=false so downstream can honor the distinction.
      rings.push(null, null, null, null);
      ringValid.push(false, false, false, false);
    }
  }
  return { rings, ringValid, max_radius: maxR, centroid_x: cx, centroid_y: cy };
}

/**
 * Compact summary: 8 rings × (R, G, B, L) means = 32 scalars.
 * Named for direct injection into flattenSignature.
 */
export function radialPhotonSummary(R, G, B, width, height, region) {
  const p = radialPhotonProfileForRegion(R, G, B, width, height, region);
  // GPT doctrine v5 correction: NEVER convert "measurement could not be computed"
  // to zero. Zero is a valid measurement. Nulls flow into buildAxisLanes flags
  // metadata (per-key validity), not into the numeric feature vector.
  const summary = {};
  const ringValidity = [];
  for (let bin = 0; bin < NUM_RINGS; bin++) {
    const rV = p.rings[bin * 4 + 0];
    const gV = p.rings[bin * 4 + 1];
    const bV = p.rings[bin * 4 + 2];
    const lV = p.rings[bin * 4 + 3];
    summary["ring" + bin + "_R"] = rV;   // null when ring has ZERO_SUPPORT
    summary["ring" + bin + "_G"] = gV;
    summary["ring" + bin + "_B"] = bV;
    summary["ring" + bin + "_L"] = lV;
    ringValidity.push({
      bin,
      valid: p.ringValid?.[bin * 4] ?? Number.isFinite(rV),
      reason: p.ringValid?.[bin * 4] === false ? "ZERO_SUPPORT" : null,
    });
  }
  summary.max_radius_norm = Number.isFinite(p.max_radius) && p.max_radius > 0
    ? Math.log(p.max_radius + 1)
    : null;
  // Preserve per-ring validity as a first-class array-of-objects. buildAxisLanes
  // will route this to structuredFields (arrays go there, not summary).
  summary.ring_validity = ringValidity;
  return summary;
}
