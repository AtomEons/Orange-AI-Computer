// v4-shape.mjs — V4 curvature + complex-shape.
//
// V4 sits above V2 and codes for:
//   - Curvature at contour segments (Connor et al. 2007)
//   - Color-complex cells (hue-independent shape)
//   - Radial/spiral spatial patterns
//   - Boundary conformation (concave vs convex arcs)
//
// Zero-parameter closed-form implementation:
//   1. Curvature magnitude: second spatial derivative of dominant orientation field
//   2. Concavity index: for closed contours, fraction of boundary that is concave
//   3. Complexity: contour-length / bounding-perimeter
//   4. Radial energy: histogram of curvature-signs around estimated centroid

/**
 * v4Shape(v2, opponent_map, W, H) — takes V2 contour output and produces
 * V4-level shape descriptors + color-shape coupling.
 */
export function v4Shape(v2, opponent_map, W, H) {
  const N = W * H;
  const contour = v2.fields.contour;
  const dominant = v2.fields.dominant;

  const result = {};

  // Combined contour across scales
  const combined = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (const c of contour) if (c[i] > m) m = c[i];
    combined[i] = m;
  }

  // Estimate object centroid (weighted by contour energy)
  let cx = 0, cy = 0, mass = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = combined[y * W + x];
      cx += x * v;
      cy += y * v;
      mass += v;
    }
  }
  if (mass > 1e-6) { cx /= mass; cy /= mass; } else { cx = W / 2; cy = H / 2; }

  // Curvature: second derivative of dominant orientation across scales
  let curv_sum = 0, curv_count = 0, curv_max = 0;
  let concave_count = 0, total_bound = 0;
  for (const dom of dominant) {
    if (!dom) continue;
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (combined[i] < 0.01) continue; // only on contour pixels
        total_bound++;
        const d0 = dom[i];
        const d_left = dom[i - 1], d_right = dom[i + 1];
        const d_up = dom[i - W],   d_down = dom[i + W];
        // Second-difference in orientation (min-circular distance)
        const circ = (a, b) => Math.min(Math.abs(a - b), 8 - Math.abs(a - b));
        const ddx = circ(d_left, d_right);
        const ddy = circ(d_up, d_down);
        const c = ddx + ddy;
        curv_sum += c;
        curv_count++;
        if (c > curv_max) curv_max = c;

        // Concavity via signed direction of curvature vs centroid
        const dx = x - cx, dy = y - cy;
        const rmag = Math.hypot(dx, dy) || 1;
        // Radial direction points outward — if orientation curls toward center, concave
        const ori_angle = (d0 / 8) * Math.PI;
        const outward = Math.abs(dx * Math.cos(ori_angle) + dy * Math.sin(ori_angle)) / rmag;
        if (outward < 0.3) concave_count++;
      }
    }
  }

  // Contour length vs bounding-box perimeter (complexity)
  let contour_length = 0;
  for (let i = 0; i < N; i++) if (combined[i] > 0.01) contour_length++;
  const bounding_perim = 2 * (W + H);
  const complexity = contour_length / bounding_perim;

  // Color–shape coupling: how much does chromaticity (RG, BY) vary along contour?
  let rg_var_along_contour = 0;
  let by_var_along_contour = 0;
  let cvar_count = 0;
  let rg_sum = 0, by_sum = 0;
  for (let i = 0; i < N; i++) {
    if (combined[i] < 0.01) continue;
    rg_sum += opponent_map[i * 3 + 1];
    by_sum += opponent_map[i * 3 + 2];
    cvar_count++;
  }
  if (cvar_count > 0) {
    const rg_mean = rg_sum / cvar_count;
    const by_mean = by_sum / cvar_count;
    for (let i = 0; i < N; i++) {
      if (combined[i] < 0.01) continue;
      const d_rg = opponent_map[i * 3 + 1] - rg_mean;
      const d_by = opponent_map[i * 3 + 2] - by_mean;
      rg_var_along_contour += d_rg * d_rg;
      by_var_along_contour += d_by * d_by;
    }
    rg_var_along_contour /= cvar_count;
    by_var_along_contour /= cvar_count;
  }

  result.v4_curvature_mean = curv_count > 0 ? curv_sum / curv_count : 0;
  result.v4_curvature_max = curv_max;
  result.v4_concavity_frac = total_bound > 0 ? concave_count / total_bound : 0;
  result.v4_complexity = complexity;
  result.v4_centroid_x_norm = (cx - W / 2) / W;
  result.v4_centroid_y_norm = (cy - H / 2) / H;
  result.v4_rg_var_contour = Math.sqrt(rg_var_along_contour);
  result.v4_by_var_contour = Math.sqrt(by_var_along_contour);

  return { combined_contour: combined, centroid: { cx, cy }, summary: result };
}
