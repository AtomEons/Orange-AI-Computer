// 07-VISUAL/structural/optical-flow.mjs
//
// Block-matching optical flow — the missing piece under flow-geometry.mjs.
//
// For each block in frame_t, search a window in frame_{t+1} for the
// displacement that minimizes SAD (sum of absolute differences) in
// luminance. The winning offset is the block's (u, v) displacement vector.
// This is classical Farneback-adjacent block matching, no learning, no
// external deps. Deterministic given a fixed traversal order.
//
// Physics:
//   Under camera translation with parallel projection, u_pixel = f * T / Z.
//   Larger |u| = closer object (smaller Z). Block-matching flow gives us a
//   direct depth cue — motion parallax.
//
// Under camera rotation, the flow is a global rotation field — divergence
// and curl (from flow-geometry) then indicate boundary discontinuities but
// not depth. That's why we separately compute depth AND flow-geometry.

/**
 * Compute per-block optical flow between two luminance frames.
 *
 * @param {Float32Array} L1  first-frame luminance [0,1]
 * @param {Float32Array} L2  second-frame luminance
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 *   opts.blockSize     block edge in pixels (default 16)
 *   opts.searchRadius  max displacement to consider in pixels (default 8)
 * @returns {{
 *   vx: Float32Array, vy: Float32Array,
 *   confidence: Float32Array,
 *   cols: number, rows: number,
 *   meanMagnitude: number, maxMagnitude: number
 * }}
 */
export function blockMatchFlow(L1, L2, width, height, opts = {}) {
  if (L1.length !== L2.length) throw new Error("blockMatchFlow: frame size mismatch");
  const B = opts.blockSize ?? 16;
  const R = opts.searchRadius ?? 8;
  const cols = Math.floor(width / B);
  const rows = Math.floor(height / B);
  const N = cols * rows;
  const vx = new Float32Array(N);
  const vy = new Float32Array(N);
  const confidence = new Float32Array(N);

  const idxFn = (x, y) => y * width + x;

  let sumMag = 0, maxMag = 0;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * B, y0 = by * B;
      // Search in [-R, R] for offset (du, dv). Skip if search would go OOB.
      let bestSAD = Infinity, bestU = 0, bestV = 0;
      // We compute SAD relative to a reference (du=0, dv=0) — the STATIC score.
      let staticSAD = 0;
      for (let dv = -R; dv <= R; dv++) {
        const y2 = y0 + dv;
        if (y2 < 0 || y2 + B > height) continue;
        for (let du = -R; du <= R; du++) {
          const x2 = x0 + du;
          if (x2 < 0 || x2 + B > width) continue;
          let sad = 0;
          for (let py = 0; py < B; py++) {
            for (let px = 0; px < B; px++) {
              sad += Math.abs(L1[idxFn(x0 + px, y0 + py)] - L2[idxFn(x2 + px, y2 + py)]);
              if (sad > bestSAD) break;
            }
            if (sad > bestSAD) break;
          }
          if (du === 0 && dv === 0) staticSAD = sad;
          if (sad < bestSAD) { bestSAD = sad; bestU = du; bestV = dv; }
        }
      }
      const i = by * cols + bx;
      vx[i] = bestU;
      vy[i] = bestV;
      // Confidence: relative improvement over the no-motion baseline.
      // 1 means huge improvement (strong motion signal); 0 means no benefit
      // from displacement (either no motion or texture-less block).
      confidence[i] = staticSAD > 0 ? (1 - bestSAD / staticSAD) : 0;
      const mag = Math.sqrt(bestU * bestU + bestV * bestV);
      sumMag += mag;
      if (mag > maxMag) maxMag = mag;
    }
  }
  return {
    vx, vy, confidence, cols, rows,
    meanMagnitude: sumMag / N,
    maxMagnitude: maxMag,
  };
}

/**
 * Depth prior derived from optical-flow magnitude under camera translation.
 * Larger displacement → closer object. Returns per-block depth in [0,1]
 * where 0 = closest, 1 = farthest.
 *
 * Depth is proportional to 1/|v|; we invert and normalize by the maximum
 * magnitude seen. Blocks with low confidence (no reliable motion signal)
 * are returned as depth=0.5 (neutral).
 */
export function depthFromFlow(vx, vy, confidence, opts = {}) {
  const minConf = opts.minConfidence ?? 0.1;
  const N = vx.length;
  const depth = new Float32Array(N);
  let maxMag = 0;
  for (let i = 0; i < N; i++) {
    const mag = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    if (confidence[i] >= minConf && mag > maxMag) maxMag = mag;
  }
  if (maxMag === 0) { for (let i = 0; i < N; i++) depth[i] = 0.5; return depth; }
  for (let i = 0; i < N; i++) {
    if (confidence[i] < minConf) { depth[i] = 0.5; continue; }
    const mag = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    // Inverse-proportional: closer = smaller depth value
    depth[i] = 1 - (mag / maxMag);
  }
  return depth;
}

/**
 * Convert a per-block field to per-pixel (nearest-neighbor upsample).
 * Useful for overlays.
 */
export function upsampleField(field, cols, rows, width, height, blockSize) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const by = Math.min(rows - 1, Math.floor(y / blockSize));
    for (let x = 0; x < width; x++) {
      const bx = Math.min(cols - 1, Math.floor(x / blockSize));
      out[y * width + x] = field[by * cols + bx];
    }
  }
  return out;
}
