// 07-VISUAL/structural/ingest/fps-sweep-sampler.mjs
//
// #108 — Farthest-point-sample configs from a big sweep grid.
//
// active-curation.mjs applies FPS to SIGNATURE diversity. This applies
// the same idea to CONFIG diversity: instead of sweeping all N configs,
// pick K configs whose parameter vectors are maximally spread. Covers the
// diversity of the full grid at 25× less compute per AE7's recommendation.
//
// Zero learned parameters, deterministic, Bun-native.

/**
 * Sample K configs from a grid via farthest-point-sampling in normalized
 * parameter space.
 *
 * @param {Array<object>} allConfigs   full grid of config dicts
 * @param {number} K                    how many to select
 * @param {Array<string>} numericAxes  which config keys to treat as numeric
 * @param {Array<string>} [categoricalAxes]  keys treated as one-hot categorical
 * @returns {{ selected: object[], selectedIndices: number[] }}
 */
export function fpsSampleConfigs(allConfigs, K, numericAxes, categoricalAxes = []) {
  const N = allConfigs.length;
  if (N <= K) return { selected: allConfigs, selectedIndices: allConfigs.map((_, i) => i) };

  // Normalize numeric axes to [0, 1]
  const ranges = {};
  for (const k of numericAxes) {
    let mn = Infinity, mx = -Infinity;
    for (const c of allConfigs) {
      const v = Number(c[k]);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ranges[k] = { mn, mx, span: Math.max(1e-9, mx - mn) };
  }

  // Build one-hot for categorical axes
  const categoricalValues = {};
  for (const k of categoricalAxes) {
    const set = new Set(allConfigs.map((c) => c[k]));
    categoricalValues[k] = [...set];
  }

  function distance(a, b) {
    let s = 0;
    for (const k of numericAxes) {
      const norm = (v) => (Number(v) - ranges[k].mn) / ranges[k].span;
      s += (norm(a[k]) - norm(b[k])) ** 2;
    }
    for (const k of categoricalAxes) {
      s += (a[k] === b[k]) ? 0 : 1;
    }
    return Math.sqrt(s);
  }

  // FPS
  const selected = [0];
  const minDist = new Array(N).fill(Infinity);
  for (let j = 0; j < N; j++) minDist[j] = j === 0 ? 0 : distance(allConfigs[j], allConfigs[0]);
  while (selected.length < K) {
    let bestI = -1, bestD = -1;
    for (let j = 0; j < N; j++) {
      if (selected.includes(j)) continue;
      if (minDist[j] > bestD) { bestD = minDist[j]; bestI = j; }
    }
    if (bestI === -1) break;
    selected.push(bestI);
    for (let j = 0; j < N; j++) {
      if (selected.includes(j)) continue;
      const d = distance(allConfigs[j], allConfigs[bestI]);
      if (d < minDist[j]) minDist[j] = d;
    }
  }
  return { selected: selected.map((i) => allConfigs[i]), selectedIndices: selected };
}
