// AWE-1.9 node-graph substrate — zero-parameter pattern recognition.
// VERTICES = canonicals from canonical-corpus.
// EDGES = K-nearest by canonicalPhotonMSE.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPhotonMSE } from './photon-canonical.mjs';

function rehydrateTA(o) {
  if (!o || typeof o !== 'object' || !o.dtype || !o.base64) return o;
  const buf = Buffer.from(o.base64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  switch (o.dtype) {
    case 'float32': return new Float32Array(ab);
    case 'float64': return new Float64Array(ab);
    case 'int32':   return new Int32Array(ab);
    case 'uint8':   return new Uint8Array(ab);
    case 'uint16':  return new Uint16Array(ab);
    default: throw new Error('unknown dtype: ' + o.dtype);
  }
}
function rehydrateCanon(c) {
  const out = { meta: c.meta };
  for (const k of ['reflectance_map','opponent_map','retinal_map','depth_map',
                   'multiscale_edges','saliency_map','shape_moments','spectral_moments',
                   'temporal_map']) {
    if (c[k] !== undefined) out[k] = rehydrateTA(c[k]);
  }
  return out;
}

const CORPUS = 'C:/AtomEons/Orange5/07-VISUAL/fixtures/canonical-corpus';
const OUT    = join(CORPUS, '_node_graph.json');
const K = 10;
const MAX_N = 500;

console.log('[graph] scanning', CORPUS);
const conceptDirs = readdirSync(CORPUS).filter(f => {
  try { return statSync(join(CORPUS, f)).isDirectory() && !f.startsWith('_'); }
  catch { return false; }
});

const allVerts = [];
for (const concept of conceptDirs) {
  const dir = join(CORPUS, concept);
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const p = join(dir, f);
    let doc;
    try { doc = JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { console.warn('[graph] skip', p, e.message); continue; }
    const clip = f.replace(/\.json$/, '');
    for (let i = 0; i < doc.canonicals.length; i++) {
      allVerts.push({
        id: `${concept}:${clip}:${i}`,
        concept, path: p, frame_idx: i, canon: rehydrateCanon(doc.canonicals[i])
      });
    }
  }
}

console.log('[graph] discovered', allVerts.length, 'canonicals across', conceptDirs.length, 'concepts');

let verts = allVerts;
let sampled = false;
if (allVerts.length > MAX_N) {
  const shuf = allVerts.slice();
  for (let i = shuf.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuf[i], shuf[j]] = [shuf[j], shuf[i]];
  }
  verts = shuf.slice(0, MAX_N);
  sampled = true;
  console.log('[graph] SAMPLED', MAX_N, 'of', allVerts.length);
}

const N = verts.length;
console.log('[graph] computing O(N^2) MSE with N =', N, '→', (N*(N-1))/2, 'pairs');

// symmetric MSE matrix
const mse = Array.from({ length: N }, () => new Float64Array(N));
let pairs = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    let m;
    try { m = canonicalPhotonMSE(verts[i].canon, verts[j].canon); }
    catch (e) { m = Infinity; }
    mse[i][j] = m; mse[j][i] = m;
    pairs++;
    if (pairs % 25 === 0) {
      const dt = (Date.now() - t0) / 1000;
      console.log(`[graph] pair ${pairs} — ${(pairs/dt).toFixed(2)} pair/s`);
    }
  }
}
console.log('[graph] pairs done in', ((Date.now()-t0)/1000).toFixed(1), 's');

// k-nearest per vertex
const edges = [];
const edgeWeights = [];
const kEff = Math.min(K, N - 1);
for (let i = 0; i < N; i++) {
  const scores = [];
  for (let j = 0; j < N; j++) if (j !== i) scores.push({ j, m: mse[i][j] });
  scores.sort((a, b) => a.m - b.m);
  for (let k = 0; k < kEff; k++) {
    const { j, m } = scores[k];
    edges.push({ from: verts[i].id, to: verts[j].id, mse: m });
    edgeWeights.push(m);
  }
}

edgeWeights.sort((a,b)=>a-b);
const mean = edgeWeights.reduce((a,b)=>a+b,0) / edgeWeights.length;
const median = edgeWeights[Math.floor(edgeWeights.length/2)];

const graph = {
  version: 'AWE-NG-1.0',
  built_at: new Date().toISOString(),
  sampled,
  nodes: verts.map(v => ({ id: v.id, concept: v.concept, path: v.path, frame_idx: v.frame_idx })),
  edges,
  stats: {
    total_nodes: N,
    total_edges: edges.length,
    k: kEff,
    mean_edge_mse: mean,
    median_edge_mse: median,
    min_edge_mse: edgeWeights[0],
    max_edge_mse: edgeWeights[edgeWeights.length-1],
    n_concepts: new Set(verts.map(v=>v.concept)).size,
    pool_size: allVerts.length
  }
};

writeFileSync(OUT, JSON.stringify(graph));
console.log('[graph] wrote', OUT);
console.log('[graph] stats', graph.stats);
