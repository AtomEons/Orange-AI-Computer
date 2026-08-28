// 07-VISUAL/structural/identity/descriptor.mjs
//
// The identity descriptor — a compact perceptual signature for an entity.
//
// Design principle: descriptor is what remains INVARIANT across views of
// the same object. A red apple viewed from different angles, brightnesses,
// or slight rotations should produce similar descriptors. Two different
// objects (red apple vs orange fruit) should produce different descriptors.
//
// The features:
//   mean_R, mean_G, mean_B          — mean color in the region
//   mean_RG, mean_BY                — mean opponent chromaticity (illumination-invariant)
//   texture_variance                — log-variance of luminance within region
//   log_size                        — normalized area (log-scale)
//   aspect_ratio                    — width/height (log-scale)
//
// All features are deterministic. No neural nets. No RNG.

/**
 * Compute a descriptor for a single entity region on an image.
 * @param {[number,number,number,number]} region [x, y, w, h] in pixel coords
 * @param {Float32Array} R  red channel 0..1, w*h
 * @param {Float32Array} G  green channel 0..1, w*h
 * @param {Float32Array} B  blue channel 0..1, w*h
 * @param {number} width
 * @param {number} height
 * @returns {object}  descriptor
 */
export function computeDescriptor(region, R, G, B, width, height) {
  const [x0, y0, w, h] = region;
  if (w < 2 || h < 2) {
    return null; // too small — descriptor would be meaningless
  }
  // Sum inside the region.
  let sumR = 0, sumG = 0, sumB = 0;
  let sumLum = 0, sumLum2 = 0;
  let count = 0;
  const x1 = Math.min(width, x0 + w);
  const y1 = Math.min(height, y0 + h);
  const x00 = Math.max(0, x0);
  const y00 = Math.max(0, y0);
  for (let y = y00; y < y1; y++) {
    for (let x = x00; x < x1; x++) {
      const i = y * width + x;
      const r = R[i], g = G[i], b = B[i];
      sumR += r;
      sumG += g;
      sumB += b;
      const lum = 0.30 * r + 0.59 * g + 0.11 * b;
      sumLum += lum;
      sumLum2 += lum * lum;
      count++;
    }
  }
  if (count === 0) return null;

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const meanLum = sumLum / count;
  const varLum = Math.max(0, sumLum2 / count - meanLum * meanLum);
  // Opponent channels from the means — these are the illumination-invariant bits.
  const meanRG = meanR - meanG;
  const meanBY = meanB - 0.5 * (meanR + meanG);
  const frameArea = width * height;
  const areaFrac = (w * h) / frameArea;

  return {
    mean_R: meanR,
    mean_G: meanG,
    mean_B: meanB,
    mean_RG: meanRG,
    mean_BY: meanBY,
    texture_var: varLum,
    log_size: Math.log(areaFrac + 1e-6),
    log_aspect: Math.log((w + 1) / (h + 1)),
  };
}

/**
 * Weighted distance between two descriptors.
 * Chromatic axes (RG, BY) are weighted highest — they carry the most
 * illumination-invariant identity information.
 */
export function descriptorDistance(a, b) {
  if (!a || !b) return Infinity;
  const wR = 1.0, wG = 1.0, wB = 1.0;
  const wRG = 3.0, wBY = 3.0;  // chromatic axes weighted 3x — identity-carrying
  const wTex = 1.5;
  const wSize = 0.5;
  const wAspect = 0.5;
  let d = 0;
  d += wR   * (a.mean_R      - b.mean_R)      ** 2;
  d += wG   * (a.mean_G      - b.mean_G)      ** 2;
  d += wB   * (a.mean_B      - b.mean_B)      ** 2;
  d += wRG  * (a.mean_RG     - b.mean_RG)     ** 2;
  d += wBY  * (a.mean_BY     - b.mean_BY)     ** 2;
  d += wTex * (Math.log(a.texture_var + 1e-6) - Math.log(b.texture_var + 1e-6)) ** 2;
  d += wSize   * (a.log_size   - b.log_size)   ** 2;
  d += wAspect * (a.log_aspect - b.log_aspect) ** 2;
  return Math.sqrt(d);
}

/**
 * Aggregate multiple descriptors (from e.g. multiple video frames of the
 * same object) into ONE robust descriptor. Uses the mean of each feature.
 */
export function aggregateDescriptors(descriptors) {
  if (!descriptors.length) return null;
  const keys = Object.keys(descriptors[0]);
  const out = {};
  for (const k of keys) {
    let sum = 0;
    for (const d of descriptors) sum += d[k];
    out[k] = sum / descriptors.length;
  }
  return out;
}

/**
 * Compute a single descriptor from the UNION of pixel sets across
 * multiple regions. This is how a baby actually experiences an object —
 * as one contiguous chromatic entity even if attention splits it into
 * many salience regions.
 *
 * @param {Array<[number,number,number,number]>} regions
 * @param {Float32Array} R
 * @param {Float32Array} G
 * @param {Float32Array} B
 * @param {number} width
 * @param {number} height
 * @returns {object} descriptor from the union
 */
export function computeUnionDescriptor(regions, R, G, B, width, height) {
  if (!regions.length) return null;
  let sumR = 0, sumG = 0, sumB = 0;
  let sumLum = 0, sumLum2 = 0;
  let count = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const seen = new Set();
  for (const [x0, y0, w, h] of regions) {
    if (w < 1 || h < 1) continue;
    const x1 = Math.min(width, x0 + w);
    const y1 = Math.min(height, y0 + h);
    const xs = Math.max(0, x0);
    const ys = Math.max(0, y0);
    if (xs < minX) minX = xs;
    if (ys < minY) minY = ys;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
    for (let y = ys; y < y1; y++) {
      for (let x = xs; x < x1; x++) {
        const i = y * width + x;
        if (seen.has(i)) continue;
        seen.add(i);
        const r = R[i], g = G[i], b = B[i];
        sumR += r; sumG += g; sumB += b;
        const lum = 0.30 * r + 0.59 * g + 0.11 * b;
        sumLum += lum;
        sumLum2 += lum * lum;
        count++;
      }
    }
  }
  if (count === 0) return null;
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const meanLum = sumLum / count;
  const varLum = Math.max(0, sumLum2 / count - meanLum * meanLum);
  const meanRG = meanR - meanG;
  const meanBY = meanB - 0.5 * (meanR + meanG);
  const bbW = maxX - minX;
  const bbH = maxY - minY;
  const frameArea = width * height;
  const areaFrac = count / frameArea;
  return {
    mean_R: meanR,
    mean_G: meanG,
    mean_B: meanB,
    mean_RG: meanRG,
    mean_BY: meanBY,
    texture_var: varLum,
    log_size: Math.log(areaFrac + 1e-6),
    log_aspect: Math.log((bbW + 1) / (bbH + 1)),
  };
}
