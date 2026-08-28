// 07-VISUAL/structural/object-predictability.mjs
//
// The OPERATIONAL DEFINITION of an object, applied as a validator.
//
// Directional theory (not tied to a specific benchmark number):
//   A region R is an object at time t iff:
//     I( R_inside(t) ; R_inside(t+1) )  >>  I( R_inside(t) ; R_outside(t) )
//
// In plain terms: a real object is more predictable from its own future than
// from other regions at the same instant. The stronger the internal
// predictability vs external, the more "object-like" the region is.
//
// This module is not a discovery algorithm. It is a validator: given a set
// of extracted entities and the frames they were extracted from, we score
// each entity's predictability ratio and surface anything below a directional
// threshold as a Mom's-Law note.
//
// MI is estimated via the Gaussian bound  I ≥ -½ log(1 - ρ²)  where ρ is
// Pearson correlation. This is a lower bound, cheap, deterministic, and
// robust enough for a validator. No neural nets. No RNG.
//
// The threshold used to flag "not object-like" is directional (2×), not a
// benchmark. Empirical toy work has shown natural objects hitting ~5× on
// bouncing-ball scenes — but a strict number is not the point. Below 2×
// means the region is roughly as predictable from other regions as from
// its own past, which contradicts the operational definition.

/**
 * Pearson correlation of two equally-sized numeric arrays. Deterministic.
 * Returns 0 for constant inputs (avoids NaN — honest fallback).
 */
export function pearson(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db;
    va += da * da;
    vb += db * db;
  }
  const den = Math.sqrt(va * vb);
  if (!(den > 0)) return 0;
  const r = num / den;
  if (r > 1) return 1;
  if (r < -1) return -1;
  return r;
}

/**
 * Gaussian MI lower bound from correlation.
 */
export function gaussianMIBound(rho) {
  const r2 = rho * rho;
  if (r2 >= 0.999999) return 6.908; // -½ log(1e-6), cap the singularity
  return -0.5 * Math.log(1 - r2);
}

/**
 * Extract a rectangular crop as a flat array from a Float32 luminance frame.
 */
function crop(L, w, h, x0, y0, cw, ch) {
  const out = new Float32Array(cw * ch);
  let idx = 0;
  for (let y = y0; y < y0 + ch; y++) {
    if (y < 0 || y >= h) { idx += cw; continue; }
    for (let x = x0; x < x0 + cw; x++) {
      if (x >= 0 && x < w) out[idx] = L[y * w + x];
      idx++;
    }
  }
  return out;
}

/**
 * Score an entity's object-predictability on two consecutive frames.
 *
 * @param {Object} entity                       has {region: [x, y, w, h]}
 * @param {Float32Array} frameT / frameTplus1   luminance frames, 0..1
 * @param {number} width / height
 * @param {Object[]} otherEntities              other entities' regions to
 *                                              compare against for I_external
 * @returns { I_internal, I_external_mean, ratio, verdict }
 *   verdict is 'object_like' | 'ambiguous' | 'not_object_like' — the
 *   directional flag, not a benchmark grade.
 */
export function scoreEntityPredictability(entity, frameT, frameTplus1, width, height, otherEntities = []) {
  const [x, y, w, h] = entity.region || [0, 0, 0, 0];
  if (w < 2 || h < 2) {
    return { I_internal: 0, I_external_mean: 0, ratio: 0, verdict: "region_too_small" };
  }
  const inside_t = crop(frameT, width, height, x, y, w, h);
  const inside_t1 = crop(frameTplus1, width, height, x, y, w, h);
  const rho_internal = pearson(inside_t, inside_t1);
  const I_internal = gaussianMIBound(rho_internal);

  // External: mean I over other entities' crops at same t.
  let I_ext_sum = 0;
  let counted = 0;
  for (const other of otherEntities) {
    if (other === entity) continue;
    const [ox, oy, ow, oh] = other.region || [0, 0, 0, 0];
    if (ow < 2 || oh < 2) continue;
    // Match crop sizes for pearson: sample the other region resized to the
    // same w×h via simple nearest-neighbor. Deterministic; not fancy.
    const other_t = cropResize(frameT, width, height, ox, oy, ow, oh, w, h);
    const rho_ext = pearson(inside_t, other_t);
    I_ext_sum += gaussianMIBound(rho_ext);
    counted++;
  }
  const I_external_mean = counted > 0 ? I_ext_sum / counted : 0;

  const ratio = I_external_mean > 1e-6 ? I_internal / I_external_mean : (I_internal > 0 ? Infinity : 0);
  let verdict;
  if (ratio === Infinity || ratio >= 3) verdict = "object_like";
  else if (ratio >= 2) verdict = "object_like";
  else if (ratio >= 1) verdict = "ambiguous";
  else verdict = "not_object_like";

  return { I_internal, I_external_mean, ratio, verdict };
}

/**
 * Score a full set of extracted entities and return a summary + honest
 * disclosures. This is a Mom's-Law validator — anything below the
 * directional bar is surfaced, not hidden.
 */
export function validateEntitiesArePredictable(entities, frameT, frameTplus1, width, height) {
  if (!Array.isArray(entities) || entities.length === 0) {
    return {
      count: 0,
      pass_fraction: 0,
      mean_ratio: 0,
      per_entity: [],
      notes: ["object-predictability: 0 entities to validate"],
    };
  }
  const per = [];
  let passing = 0;
  let ratioSum = 0;
  let ratioCount = 0;
  for (const e of entities) {
    const s = scoreEntityPredictability(e, frameT, frameTplus1, width, height, entities);
    per.push({ id: e.id ?? null, ...s });
    if (s.verdict === "object_like") passing++;
    if (Number.isFinite(s.ratio)) { ratioSum += s.ratio; ratioCount++; }
  }
  const mean_ratio = ratioCount > 0 ? ratioSum / ratioCount : Infinity;
  const pass_fraction = passing / entities.length;

  const notes = [];
  if (pass_fraction < 0.5) {
    notes.push(
      `object-predictability: only ${passing}/${entities.length} extracted entities ` +
        `satisfy the internal-vs-external predictability definition (ratio >= 2). ` +
        `The other regions may be spatial artifacts rather than objects.`,
    );
  } else {
    notes.push(
      `object-predictability: ${passing}/${entities.length} extracted entities satisfy ` +
        `the operational object definition (I_internal / I_external >= 2).`,
    );
  }
  if (Number.isFinite(mean_ratio) && mean_ratio < 1.5) {
    notes.push(
      `object-predictability: mean I_internal / I_external = ${mean_ratio.toFixed(2)} ` +
        `— below the directional threshold. Downstream reasoning should treat these ` +
        `entities as candidate regions, not confirmed objects.`,
    );
  }
  return { count: entities.length, passing, pass_fraction, mean_ratio, per_entity: per, notes };
}

// ---- helpers ----
function cropResize(L, w, h, x0, y0, cw, ch, tw, th) {
  // Nearest-neighbor rescale of a (cw, ch) crop to (tw, th). Deterministic.
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const sy = Math.min(ch - 1, Math.max(0, Math.floor((ty * ch) / th)));
    for (let tx = 0; tx < tw; tx++) {
      const sx = Math.min(cw - 1, Math.max(0, Math.floor((tx * cw) / tw)));
      const y = y0 + sy;
      const x = x0 + sx;
      if (y >= 0 && y < h && x >= 0 && x < w) out[ty * tw + tx] = L[y * w + x];
    }
  }
  return out;
}
