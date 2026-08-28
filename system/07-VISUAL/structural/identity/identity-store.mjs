// 07-VISUAL/structural/identity/identity-store.mjs
//
// DEPRECATED (v1). See identity-store-v2.mjs for the multi-signature
// substrate. Kept live because 5 files still import it. New code SHOULD
// use v2.
//
// The identity knowledge base — persist labels + descriptors as JSON.
// One-shot learning: "parent says apple" writes ONE row. Recognition
// finds nearest match. Deterministic. Portable.

import fs from "node:fs";
import path from "node:path";
import { descriptorDistance } from "./descriptor.mjs";

/**
 * Load or create an identity store from a JSON file.
 * @param {string} storePath  path to the JSON store
 * @returns {{ labels: Array<{ label, descriptor, source, learned_at }> }}
 */
export function loadStore(storePath) {
  if (!fs.existsSync(storePath)) return { labels: [] };
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return { labels: [] };
  }
}

/**
 * Save the identity store.
 */
export function saveStore(storePath, store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

/**
 * "Baby learns 'apple'" — bind one label to one descriptor.
 * If the label already exists, this REPLACES it (single-descriptor mode).
 * To average across multiple exposures, aggregate the descriptors first.
 */
export function learnLabel(store, label, descriptor, source = "unknown", timestamp = null) {
  store.labels = store.labels.filter((row) => row.label !== label);
  store.labels.push({
    label,
    descriptor,
    source,
    learned_at: timestamp ?? new Date().toISOString(),
  });
  return store;
}

/**
 * Given a new descriptor and the store, find the best-matching label
 * with confidence. Returns nulls when no label is close enough.
 * @param {object} descriptor
 * @param {object} store
 * @param {object} [opts]
 *   opts.max_distance? number   — reject matches beyond this distance
 * @returns {{ label: string, distance: number, confidence: number } | null}
 */
export function recognize(descriptor, store, opts = {}) {
  if (!descriptor || !store.labels?.length) return null;
  // Empirical default from sweep-108 (2026-07-06): 1.0 gives 4/4 with the
  // tri-axis pipeline; 1.5 was too permissive and let warm skin pass.
  const maxDist = opts.max_distance ?? 1.0;
  let best = null;
  for (const row of store.labels) {
    const d = descriptorDistance(descriptor, row.descriptor);
    if (best === null || d < best.distance) {
      best = { label: row.label, distance: d };
    }
  }
  if (!best) return null;
  if (best.distance > maxDist) return { ...best, confidence: 0, rejected_reason: `distance ${best.distance.toFixed(3)} > max ${maxDist}` };
  const confidence = Math.max(0, 1 - best.distance / maxDist);
  return { ...best, confidence };
}

/**
 * Sort entities by their recognition confidence for a specific label,
 * returning ranked candidates. Useful for "find the apple in this image."
 */
export function rankByLabel(entityDescriptors, store, label) {
  const target = store.labels.find((r) => r.label === label);
  if (!target) return [];
  return entityDescriptors
    .map((d, i) => ({ index: i, distance: descriptorDistance(d, target.descriptor) }))
    .sort((a, b) => a.distance - b.distance);
}
