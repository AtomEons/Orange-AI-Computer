// AWE-NG-ANALYZE-1.0 — ground-truth the node-graph substrate
// Metrics:
//  - SCNF: same-concept-neighbor-fraction (per vertex, top-K by MSE)
//  - concept-clean fraction (SCNF >= 0.8)
//  - hardest concepts (lowest mean SCNF)
//  - top confusion clusters (which foreign concept steals neighbors)
//  - physics-invariance: mean MSE same-concept vs different-concept edges

import fs from 'node:fs';
import path from 'node:path';

const GRAPH_PATH = 'C:/AtomEons/Orange5/07-VISUAL/fixtures/canonical-corpus/_node_graph.json';

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
const nodes = graph.nodes;
const edges = graph.edges;

// index nodes by id
const byId = new Map();
for (const n of nodes) byId.set(n.id, n);

// adjacency: node -> [{to, mse}] sorted by mse asc
const adj = new Map();
for (const n of nodes) adj.set(n.id, []);
for (const e of edges) {
  // edges stored one-directional K-NN from source vertex.
  // treat as directed; SCNF uses outgoing edges (vertex's own K neighbors)
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push({ to: e.to, mse: e.mse });
}
for (const [k, v] of adj) v.sort((a, b) => a.mse - b.mse);

// SCNF per vertex
const scnfByVertex = [];
const scnfByConcept = new Map(); // concept -> [scnf, ...]
const confusion = new Map(); // "hostConcept->foreignConcept" -> count

for (const n of nodes) {
  const nbrs = adj.get(n.id) || [];
  if (!nbrs.length) continue;
  let same = 0;
  const foreignCounts = new Map();
  for (const nb of nbrs) {
    const other = byId.get(nb.to);
    if (!other) continue;
    if (other.concept === n.concept) {
      same++;
    } else {
      foreignCounts.set(other.concept, (foreignCounts.get(other.concept) || 0) + 1);
    }
  }
  const scnf = same / nbrs.length;
  scnfByVertex.push({ id: n.id, concept: n.concept, scnf, k: nbrs.length });
  if (!scnfByConcept.has(n.concept)) scnfByConcept.set(n.concept, []);
  scnfByConcept.get(n.concept).push(scnf);
  for (const [fc, c] of foreignCounts) {
    const key = `${n.concept} -> ${fc}`;
    confusion.set(key, (confusion.get(key) || 0) + c);
  }
}

const meanSCNF = scnfByVertex.reduce((s, x) => s + x.scnf, 0) / scnfByVertex.length;
const cleanCount = scnfByVertex.filter((x) => x.scnf >= 0.8).length;
const cleanFrac = cleanCount / scnfByVertex.length;

// hardest concepts (lowest mean scnf) — need at least 2 vertices for stability
const conceptStats = [];
for (const [c, arr] of scnfByConcept) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  conceptStats.push({ concept: c, n: arr.length, mean_scnf: m });
}
conceptStats.sort((a, b) => a.mean_scnf - b.mean_scnf);
const hardest = conceptStats.slice(0, 10);

// confusion clusters (top by count)
const confusionList = [...confusion.entries()]
  .map(([k, v]) => ({ pair: k, count: v }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);

// physics-invariance ledger — mean MSE same-concept vs different-concept edges
let sumSame = 0, nSame = 0, sumDiff = 0, nDiff = 0;
let minSame = Infinity, maxSame = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
for (const e of edges) {
  const a = byId.get(e.from), b = byId.get(e.to);
  if (!a || !b) continue;
  if (a.concept === b.concept) {
    sumSame += e.mse; nSame++;
    if (e.mse < minSame) minSame = e.mse;
    if (e.mse > maxSame) maxSame = e.mse;
  } else {
    sumDiff += e.mse; nDiff++;
    if (e.mse < minDiff) minDiff = e.mse;
    if (e.mse > maxDiff) maxDiff = e.mse;
  }
}
const meanSame = nSame ? sumSame / nSame : NaN;
const meanDiff = nDiff ? sumDiff / nDiff : NaN;
const sep = meanSame > 0 ? meanDiff / meanSame : NaN;

const report = {
  version: 'AWE-NG-ANALYZE-1.0',
  built_at: new Date().toISOString(),
  graph_path: GRAPH_PATH,
  vertices: scnfByVertex.length,
  edges: edges.length,
  K_per_vertex: (edges.length / scnfByVertex.length) | 0,
  scnf: {
    mean: meanSCNF,
    clean_ge_0p8_count: cleanCount,
    clean_ge_0p8_frac: cleanFrac,
    distribution: {
      eq_0: scnfByVertex.filter((x) => x.scnf === 0).length,
      lt_0p3: scnfByVertex.filter((x) => x.scnf < 0.3).length,
      lt_0p5: scnfByVertex.filter((x) => x.scnf < 0.5).length,
      ge_0p5: scnfByVertex.filter((x) => x.scnf >= 0.5).length,
      ge_0p8: cleanCount,
      eq_1: scnfByVertex.filter((x) => x.scnf === 1).length,
    },
  },
  concept_stats: conceptStats,
  hardest_concepts_top10: hardest,
  confusion_top10: confusionList,
  physics_invariance: {
    edges_same_concept: nSame,
    edges_diff_concept: nDiff,
    mean_mse_same: meanSame,
    mean_mse_diff: meanDiff,
    separation_ratio_diff_over_same: sep,
    min_mse_same: minSame,
    max_mse_same: maxSame,
    min_mse_diff: minDiff,
    max_mse_diff: maxDiff,
  },
  honest_note:
    'SCNF is a downstream classification-flavored metric, not the mission signal. It measures whether the canonical pipeline puts same-concept observations near each other under MSE. Read it as a yes/no on whether node-graph recognition is viable on top of the current canonical.',
};

const outPath = path.join(path.dirname(GRAPH_PATH), '_node_graph_analysis.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

// terse console print
console.log('vertices:', report.vertices, 'edges:', report.edges, 'K:', report.K_per_vertex);
console.log('mean SCNF:', meanSCNF.toFixed(4));
console.log('clean (SCNF>=0.8):', cleanCount, '/', report.vertices, `(${(cleanFrac * 100).toFixed(1)}%)`);
console.log('distribution:', report.scnf.distribution);
console.log('hardest concepts:');
for (const h of hardest) console.log('  ', h.concept, 'n=' + h.n, 'mean_scnf=' + h.mean_scnf.toFixed(3));
console.log('top confusion pairs:');
for (const c of confusionList) console.log('  ', c.pair, 'count=' + c.count);
console.log('physics-invariance:');
console.log('  same-concept edges:', nSame, 'mean MSE:', meanSame.toFixed(4));
console.log('  diff-concept edges:', nDiff, 'mean MSE:', meanDiff.toFixed(4));
console.log('  separation ratio (diff/same):', sep.toFixed(4));
console.log('report:', outPath);
