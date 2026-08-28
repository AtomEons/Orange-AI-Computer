// saccades.mjs — active sampling / multiple fixations.
//
// The eye samples the world through a series of rapid rotations (saccades)
// separated by fixations. Every saccade lands at a NEW attention target,
// usually driven by bottom-up saliency + top-down goal. Each fixation
// produces a fresh foveal canonical.
//
// Multi-fixation vision is HOW humans achieve wide field of view without
// sacrificing acuity — the fovea is only 1° wide, but saccades sample
// dozens of foveal windows per second.
//
// For a static photograph: pick N attention targets from a saliency map,
// crop a window around each, run captureCanonicalPhoton on each. Then
// fuse the descriptors.
//
// Zero learned parameters. Saliency-driven.

/**
 * pickFixationTargets(saliency_field, W, H, N, minSep)
 *
 * Pick the top-N saliency peaks with a minimum separation. Uses
 * greedy suppression: pick global max, zero out a radius-minSep window
 * around it, repeat.
 *
 * @returns Array<{ x, y, score }>
 */
export function pickFixationTargets(saliency_field, W, H, N = 5, minSep = null) {
  const sep = minSep ?? Math.max(8, Math.floor(Math.min(W, H) * 0.15));
  const buf = new Float32Array(saliency_field);
  const picks = [];
  for (let k = 0; k < N; k++) {
    let mx = -Infinity, mxIdx = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > mx) { mx = buf[i]; mxIdx = i; }
    }
    if (mxIdx < 0 || mx <= 0) break;
    const px = mxIdx % W;
    const py = Math.floor(mxIdx / W);
    picks.push({ x: px, y: py, score: mx });
    // Suppression: zero a disc of radius sep
    for (let yy = Math.max(0, py - sep); yy < Math.min(H, py + sep); yy++) {
      for (let xx = Math.max(0, px - sep); xx < Math.min(W, px + sep); xx++) {
        const dx = xx - px, dy = yy - py;
        if (dx * dx + dy * dy < sep * sep) buf[yy * W + xx] = 0;
      }
    }
  }
  return picks;
}

/**
 * captureWithSaccades(frame, options)
 *
 * Run captureCanonicalPhoton on the whole frame, then again on N saccade
 * windows chosen from the resulting saliency map. Returns:
 *   {
 *     global: base canonical,
 *     fixations: [ { region, canonical } × N ],
 *     fixation_summary: aggregated IT signatures + peaks
 *   }
 *
 * Region size defaults to 40% of the frame's short dimension — foveal window.
 */
export async function captureWithSaccades(frame, capture_fn, {
  numFixations = 5,
  regionFrac = 0.4,
  minSepFrac = 0.15,
} = {}) {
  const W = frame.W ?? frame.width;
  const H = frame.H ?? frame.height;

  // First capture: whole scene, produces saliency
  const global_can = capture_fn(frame, { x: 0, y: 0, w: W, h: H });

  // Rescale saliency (canonical 256×256) back to input coords by simple stretch
  const CW = 256, CH = 256; // canonical (matches CANON_W/H in photon-canonical)
  const sal = global_can.saliency_map;
  const saliency_input_space = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.floor((x / W) * CW);
      const cy = Math.floor((y / H) * CH);
      saliency_input_space[y * W + x] = sal[cy * CW + cx];
    }
  }
  const targets = pickFixationTargets(saliency_input_space, W, H, numFixations, Math.floor(Math.min(W, H) * minSepFrac));

  // For each target, capture a foveal window centered on it
  const regionSize = Math.floor(Math.min(W, H) * regionFrac);
  const fixations = [];
  for (const t of targets) {
    const x0 = Math.max(0, Math.min(W - regionSize, t.x - Math.floor(regionSize / 2)));
    const y0 = Math.max(0, Math.min(H - regionSize, t.y - Math.floor(regionSize / 2)));
    const region = { x: x0, y: y0, w: regionSize, h: regionSize };
    const can = capture_fn(frame, region);
    fixations.push({ target: t, region, canonical: can });
  }

  return {
    global: global_can,
    fixations,
    num_fixations: fixations.length,
    fixation_targets: targets,
  };
}
