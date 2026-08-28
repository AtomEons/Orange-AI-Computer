// 07-VISUAL/structural/binders/post-processing.mjs
//
// Post-processors applied to a binder's entities[] output. Deterministic,
// pure JS. Sweep uses these to test whether overlap-merging fixes the
// over-segmentation problem some binders exhibit.

export const POSTPROCESSORS = ["identity", "merge_overlap", "filter_tiny", "keep_top_10"];

/**
 * Apply a named post-processor to an entities array. Returns new entities +
 * notes describing what happened.
 * @returns { entities, notes }
 */
export function postprocess(name, entities, opts = {}) {
  switch (name) {
    case "identity":       return { entities, notes: ["postproc:identity — entities passed through unchanged"] };
    case "merge_overlap":  return mergeOverlap(entities);
    case "filter_tiny":    return filterTiny(entities, opts.frameArea || 1);
    case "keep_top_10":    return keepTopK(entities, 10);
    default:               throw new Error(`unknown postprocessor: ${name}`);
  }
}

function filterTiny(entities, frameArea) {
  const minArea = frameArea * 0.005; // 0.5% of frame
  const kept = entities.filter((e) => {
    const r = e.region || [0, 0, 0, 0];
    return r[2] * r[3] >= minArea;
  }).map((e, i) => ({ ...e, id: i }));
  return { entities: kept, notes: [`postproc:filter_tiny — dropped entities <0.5% of frame; ${entities.length} → ${kept.length}`] };
}

function keepTopK(entities, k) {
  const sorted = entities.slice().sort((a, b) => {
    const ar = a.region || [0, 0, 0, 0], br = b.region || [0, 0, 0, 0];
    return (br[2] * br[3]) - (ar[2] * ar[3]);
  }).slice(0, k).map((e, i) => ({ ...e, id: i }));
  return { entities: sorted, notes: [`postproc:keep_top_${k} — kept ${sorted.length}/${entities.length} largest`] };
}

// Merge pairs of entities whose bounding boxes overlap significantly.
// Rule: if IoU > 0.5 OR (smaller_area entirely contained within larger by
// >70%), merge — union bbox, deduplicate texture_codes.
function mergeOverlap(entities) {
  if (!Array.isArray(entities) || entities.length < 2) {
    return { entities: entities || [], notes: ["postproc:merge_overlap — nothing to merge (<2 entities)"] };
  }
  // Working copy.
  let ents = entities.map((e) => ({ ...e, region: e.region ? [...e.region] : [0, 0, 0, 0] }));
  let merges = 0;
  let changed = true;

  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const rel = overlapMetric(ents[i].region, ents[j].region);
        if (rel.iou > 0.5 || rel.contained_frac > 0.7) {
          const merged = mergeTwo(ents[i], ents[j]);
          ents.splice(j, 1);
          ents.splice(i, 1);
          ents.push(merged);
          merges++;
          changed = true;
          break outer;
        }
      }
    }
  }
  // Re-number ids for cleanliness.
  ents = ents.map((e, i) => ({ ...e, id: i }));
  return {
    entities: ents,
    notes: [`postproc:merge_overlap — ${merges} merges applied, ${entities.length} → ${ents.length} entities`],
  };
}

function overlapMetric(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return { iou: 0, contained_frac: 0 };
  const inter = (x2 - x1) * (y2 - y1);
  const areaA = aw * ah;
  const areaB = bw * bh;
  const union = areaA + areaB - inter;
  const iou = inter / (union || 1);
  const smaller = Math.min(areaA, areaB) || 1;
  const contained_frac = inter / smaller;
  return { iou, contained_frac };
}

function mergeTwo(a, b) {
  const [ax, ay, aw, ah] = a.region;
  const [bx, by, bw, bh] = b.region;
  const x1 = Math.min(ax, bx), y1 = Math.min(ay, by);
  const x2 = Math.max(ax + aw, bx + bw), y2 = Math.max(ay + ah, by + bh);
  const texture = new Set([...(a.texture_codes || []), ...(b.texture_codes || [])]);
  return {
    id: 0, // renumbered by caller
    first_seen_ms: Math.min(a.first_seen_ms || 0, b.first_seen_ms || 0),
    last_seen_ms:  Math.max(a.last_seen_ms  || 0, b.last_seen_ms  || 0),
    region: [x1, y1, x2 - x1, y2 - y1],
    motion_field: [],
    texture_codes: [...texture],
    prediction_residual_norm: 0,
  };
}
