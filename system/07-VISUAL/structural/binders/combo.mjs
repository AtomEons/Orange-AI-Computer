// 07-VISUAL/structural/binders/combo.mjs
//
// The combo binder — runs multiple base binders and fuses their entities.
// Three fusion strategies exposed:
//
//   combo_union      — every entity from every binder, deduplicated by
//                      spatial overlap. Broad recall, may over-cover.
//   combo_voting     — only keep entities that at least 2 binders detected
//                      (measured by spatial overlap ≥ 0.4 IoU). High
//                      precision, might miss singleton correct detections.
//   combo_smart      — union, then keep tightest bounding box among
//                      overlapping entities from different binders.
//
// All deterministic, pure JS, no RNG.

import { bind as watershedBind } from "./watershed.mjs";
import { bind as densityBind }  from "./density-cluster.mjs";
import { bind as regionBind }   from "./region-grow.mjs";

export const COMBO_STRATEGIES = ["combo_union", "combo_voting", "combo_smart"];

/**
 * Run all three winning binders + fuse per strategy.
 * @param {"combo_union"|"combo_voting"|"combo_smart"} strategy
 * @param {Float32Array} R  photoreceptor-processed input
 * @param {number} width
 * @param {number} height
 * @returns {{ discipline, entities, notes, per_binder_counts }}
 */
export function bindCombo(strategy, R, width, height, opts = {}) {
  const ws = safeCall(watershedBind, R, width, height, opts, "watershed");
  const dc = safeCall(densityBind,   R, width, height, opts, "density-cluster");
  const rg = safeCall(regionBind,    R, width, height, opts, "region-grow");

  const tagged = [
    ...ws.entities.map((e) => ({ ...e, _src: "ws" })),
    ...dc.entities.map((e) => ({ ...e, _src: "dc" })),
    ...rg.entities.map((e) => ({ ...e, _src: "rg" })),
  ];
  const perBinderCounts = { ws: ws.entities.length, dc: dc.entities.length, rg: rg.entities.length };

  let entities;
  let stratNote;
  switch (strategy) {
    case "combo_union":  ({ entities, note: stratNote } = fusionUnion(tagged)); break;
    case "combo_voting": ({ entities, note: stratNote } = fusionVoting(tagged)); break;
    case "combo_smart":  ({ entities, note: stratNote } = fusionSmart(tagged)); break;
    default: throw new Error(`unknown combo strategy: ${strategy}`);
  }

  return {
    discipline: strategy,
    entities,
    per_binder_counts: perBinderCounts,
    notes: [
      `combo: watershed=${perBinderCounts.ws}, density=${perBinderCounts.dc}, region-grow=${perBinderCounts.rg} entities pre-fusion`,
      stratNote,
      ...(ws.notes || []).map((n) => `[ws] ${n}`),
      ...(dc.notes || []).map((n) => `[dc] ${n}`),
      ...(rg.notes || []).map((n) => `[rg] ${n}`),
    ],
  };
}

function safeCall(fn, R, w, h, opts, name) {
  try { return fn(R, w, h, opts) || { entities: [], notes: [] }; }
  catch (e) { return { entities: [], notes: [`${name} threw: ${e.message}`] }; }
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (aw * ah + bw * bh - inter);
}

function areaOf(e) { const r = e.region || [0, 0, 0, 0]; return r[2] * r[3]; }

// Union: all entities, dedupe by IoU > 0.5 (keep first seen).
function fusionUnion(tagged) {
  const kept = [];
  const seenIndices = new Uint8Array(tagged.length);
  for (let i = 0; i < tagged.length; i++) {
    if (seenIndices[i]) continue;
    kept.push(tagged[i]);
    for (let j = i + 1; j < tagged.length; j++) {
      if (seenIndices[j]) continue;
      if (iou(tagged[i].region, tagged[j].region) > 0.5) seenIndices[j] = 1;
    }
  }
  return {
    entities: kept.map((e, id) => ({ ...e, id })),
    note: `combo_union: ${tagged.length} raw → ${kept.length} after dedup (IoU>0.5)`,
  };
}

// Voting: entities agreed on by ≥2 binders (IoU ≥ 0.4). Very precise.
function fusionVoting(tagged) {
  const kept = [];
  const claimed = new Uint8Array(tagged.length);
  for (let i = 0; i < tagged.length; i++) {
    if (claimed[i]) continue;
    const supporters = new Set([tagged[i]._src]);
    const overlappingIdx = [i];
    for (let j = i + 1; j < tagged.length; j++) {
      if (claimed[j]) continue;
      if (iou(tagged[i].region, tagged[j].region) >= 0.4) {
        supporters.add(tagged[j]._src);
        overlappingIdx.push(j);
      }
    }
    if (supporters.size >= 2) {
      // Merge: union bbox
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const idx of overlappingIdx) {
        const r = tagged[idx].region;
        if (r[0] < x1) x1 = r[0];
        if (r[1] < y1) y1 = r[1];
        if (r[0] + r[2] > x2) x2 = r[0] + r[2];
        if (r[1] + r[3] > y2) y2 = r[1] + r[3];
        claimed[idx] = 1;
      }
      kept.push({
        ...tagged[i],
        region: [x1, y1, x2 - x1, y2 - y1],
        _voters: [...supporters],
      });
    }
  }
  return {
    entities: kept.map((e, id) => ({ ...e, id })),
    note: `combo_voting: ${kept.length} entities agreed on by ≥2 binders (IoU≥0.4)`,
  };
}

// Smart: union, then for overlapping entities from different binders,
// keep the TIGHTEST (smallest) bounding box — assumes tighter = truer.
function fusionSmart(tagged) {
  const claimed = new Uint8Array(tagged.length);
  const kept = [];
  // Sort by area ascending: smallest boxes get first claim.
  const idxByArea = tagged.map((_, i) => i).sort((a, b) => areaOf(tagged[a]) - areaOf(tagged[b]));
  for (const i of idxByArea) {
    if (claimed[i]) continue;
    kept.push(tagged[i]);
    // Claim overlapping larger boxes
    for (const j of idxByArea) {
      if (j === i || claimed[j]) continue;
      if (iou(tagged[i].region, tagged[j].region) > 0.3) claimed[j] = 1;
    }
    claimed[i] = 1;
  }
  return {
    entities: kept.map((e, id) => ({ ...e, id })),
    note: `combo_smart: kept tightest box among overlapping (IoU>0.3); ${tagged.length} → ${kept.length}`,
  };
}
