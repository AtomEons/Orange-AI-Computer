// Experiment 45 — Celtic equations for geometric data sequencing
//
// Apply Celtic geometric reorderings to the 1,567-shape dictionary.
// Each Celtic structure defines a 2D/3D arrangement; we traverse and brotli.
//
// References: Fisher gcd(p,q) plait, Tetlow turning keys, Dunham hyperbolic,
// trefoil parametric, triskele, Hilbert curve (space-filling),
// Penrose (golden ratio), wallpaper groups, Möbius.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

const otherIdx = [];
for (let i = 0; i < N; i++) if (detReceipts[i].action !== 'mesh.compress') otherIdx.push(i);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const uniqShapes = new Set();
for (const i of otherIdx) uniqShapes.add(shapeKey(detReceipts[i]));
const shapes = [...uniqShapes];
const M = shapes.length;
console.log(`Shapes: ${M}\n`);

const baseline = brotli11(Buffer.from(shapes.join('\n') + '\n', 'utf8')).length;
const b8sorted = [...shapes].map(s => ({ s, p: JSON.parse(s) }));
b8sorted.sort((a, b) => {
  if (a.p.action !== b.p.action) return a.p.action.localeCompare(b.p.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const b8size = brotli11(Buffer.from(b8sorted.map(x => x.s).join('\n') + '\n', 'utf8')).length;
console.log(`Baseline (insertion order): ${baseline} B`);
console.log(`B8 (action+length+lex):     ${b8size} B  (Method 9 baseline)\n`);

const results = [];
function test(name, ordering) {
  if (ordering.length !== M) { console.log(`${name}: SKIP — bad ordering length ${ordering.length}`); return; }
  const reordered = ordering.map(i => shapes[i]).join('\n') + '\n';
  const enc = brotli11(Buffer.from(reordered, 'utf8'));
  const size = enc.length;
  const dB = size - baseline;
  const dB8 = size - b8size;
  results.push({ name, size, dBaseline: dB, dB8 });
  console.log(`${name.padEnd(58)} ${size.toString().padStart(6)} B  Δbase ${dB > 0 ? '+' : ''}${dB.toString().padStart(5)}  ΔB8 ${dB8 > 0 ? '+' : ''}${dB8}`);
}

// ── C1: Hilbert curve order on (action_idx, length) ──────────────────
// Map each shape to (action_idx, length_bucket) → 2D point; Hilbert order
function hilbertD2XY(n, d) {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
    x += s * rx; y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}
function hilbertXY2D(n, x, y) {
  let d = 0;
  for (let s = n / 2; s >= 1; s = Math.floor(s / 2)) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
  }
  return d;
}
{
  // Map to grid: x = action_idx (0..65), y = length percentile (0..bucket)
  const actionsSeen = new Set();
  for (const s of shapes) actionsSeen.add(JSON.parse(s).action);
  const actList = [...actionsSeen].sort();
  const actIdx = new Map(actList.map((a, i) => [a, i]));
  // Grid size: 64×64 covers 4096; 1567 shapes fit
  const gridN = 64;
  // For each shape: x = action_idx (truncated to 0..63), y = length percentile in (0..63)
  const lens = shapes.map(s => s.length);
  const lensSorted = [...lens].sort((a, b) => a - b);
  const lenPercentile = l => {
    const idx = lensSorted.findIndex(v => v >= l);
    return Math.min(gridN - 1, Math.floor((idx / lensSorted.length) * gridN));
  };
  const shapeXY = shapes.map(s => {
    const p = JSON.parse(s);
    return [actIdx.get(p.action) % gridN, lenPercentile(s.length)];
  });
  // Hilbert d-index per shape
  const shapeD = shapeXY.map(([x, y]) => hilbertXY2D(gridN, x, y));
  const ordering = shapes.map((_, i) => i).sort((a, b) => shapeD[a] - shapeD[b]);
  test('C1: Hilbert curve on (action, length-bucket)', ordering);
}

// ── C2: Plait gcd(p,q) — embed in p×q grid, traverse one strand at a time
{
  const p = 47, q = 34;  // gcd(47, 34) = 1 → single strand traversing all (p×q = 1598 cells)
  // Place shapes in grid row-major
  const ordering = [];
  // Walk one strand: start at (0,0), move (+1, +1) mod (p, q) each step
  let x = 0, y = 0;
  const visited = new Uint8Array(p * q);
  for (let step = 0; step < p * q && ordering.length < M; step++) {
    const cell = y * p + x;
    if (cell < M && !visited[cell]) {
      ordering.push(cell);
      visited[cell] = 1;
    }
    x = (x + 1) % p;
    y = (y + 1) % q;
  }
  // Fill any remaining
  for (let i = 0; i < M; i++) if (!visited[i]) ordering.push(i);
  test('C2: plait gcd(p=47,q=34) strand walk', ordering);
}

// ── C3: Triskele (3-fold interleaved)
{
  // Split shapes into 3 groups (by action_idx mod 3), interleave
  const actMap = new Map();
  for (const s of shapes) {
    const a = JSON.parse(s).action;
    if (!actMap.has(a)) actMap.set(a, actMap.size);
  }
  const groups = [[], [], []];
  for (let i = 0; i < M; i++) {
    const a = JSON.parse(shapes[i]).action;
    groups[actMap.get(a) % 3].push(i);
  }
  groups.forEach(g => g.sort((a, b) => shapes[a].localeCompare(shapes[b])));
  const ordering = [];
  const maxLen = Math.max(...groups.map(g => g.length));
  for (let i = 0; i < maxLen; i++) for (const g of groups) if (i < g.length) ordering.push(g[i]);
  test('C3: triskele 3-fold action-interleave', ordering);
}

// ── C4: N-fold rotational (n = number of actions)
{
  const actMap = new Map();
  for (const s of shapes) {
    const a = JSON.parse(s).action;
    if (!actMap.has(a)) actMap.set(a, actMap.size);
  }
  const n = actMap.size;
  const groups = Array.from({length: n}, () => []);
  for (let i = 0; i < M; i++) groups[actMap.get(JSON.parse(shapes[i]).action)].push(i);
  groups.forEach(g => g.sort((a, b) => shapes[a].localeCompare(shapes[b])));
  const ordering = [];
  const maxLen = Math.max(...groups.map(g => g.length));
  for (let i = 0; i < maxLen; i++) for (const g of groups) if (i < g.length) ordering.push(g[i]);
  test('C4: N-fold ' + n + '-action interleave', ordering);
}

// ── C5: Trefoil parametric — sort by trefoil curve parameter t
{
  // Embed shapes in 3D trefoil: x=sin(t)+2sin(2t), y=cos(t)-2cos(2t), z=-sin(3t)
  // Map each shape to a t-value (by index ordering of shape), traverse by t
  // For meaningful Celtic curve: map (action_idx, length_pct) to (t1, t2)
  const actionsSeen = new Set();
  for (const s of shapes) actionsSeen.add(JSON.parse(s).action);
  const actList = [...actionsSeen].sort();
  const actIdx = new Map(actList.map((a, i) => [a, i]));
  const lens = shapes.map(s => s.length);
  const lensSorted = [...lens].sort((a, b) => a - b);
  const lenPct = l => {
    const idx = lensSorted.findIndex(v => v >= l);
    return idx / lensSorted.length;
  };
  // t = 2π * (action_idx + length_pct) / max
  const trefT = shapes.map(s => {
    const p = JSON.parse(s);
    const ai = actIdx.get(p.action) / actList.length;
    const lp = lenPct(s.length);
    return 2 * Math.PI * (ai + lp / 100);  // length weights less, action dominates
  });
  const ordering = shapes.map((_, i) => i).sort((a, b) => trefT[a] - trefT[b]);
  test('C5: trefoil-parametric t-ordering', ordering);
}

// ── C6: Wallpaper p4mm — 4-fold rotation+mirror
{
  // Map shapes to 4 quadrants by (action_idx mod 4), within each by length, interleave by mirror
  const actionsSeen = new Set();
  for (const s of shapes) actionsSeen.add(JSON.parse(s).action);
  const actList = [...actionsSeen].sort();
  const actIdx = new Map(actList.map((a, i) => [a, i]));
  const quads = [[], [], [], []];
  for (let i = 0; i < M; i++) {
    const ai = actIdx.get(JSON.parse(shapes[i]).action);
    quads[ai % 4].push(i);
  }
  quads.forEach(g => g.sort((a, b) => shapes[a].length - shapes[b].length || shapes[a].localeCompare(shapes[b])));
  // p4mm traversal: Q0 forward, Q1 forward, Q2 reverse, Q3 reverse (mirror)
  const ordering = [...quads[0], ...quads[1], ...quads[2].reverse(), ...quads[3].reverse()];
  test('C6: wallpaper p4mm 4-fold mirror', ordering);
}

// ── C7: Annular keys (concentric rings)
{
  // Sort by length, group into "rings" of √M each, traverse ring-by-ring
  const idxs = shapes.map((_, i) => i).sort((a, b) => shapes[a].length - shapes[b].length);
  const ringSize = Math.ceil(Math.sqrt(M));
  const rings = [];
  for (let i = 0; i < idxs.length; i += ringSize) rings.push(idxs.slice(i, i + ringSize));
  const ordering = rings.flatMap(r => r.sort((a, b) => shapes[a].localeCompare(shapes[b])));
  test('C7: annular ' + ringSize + '-ring length-then-lex', ordering);
}

// ── C8: Penrose / Golden Ratio order
{
  const phi = (1 + Math.sqrt(5)) / 2;
  const ordering = shapes.map((_, i) => i).sort((a, b) => {
    // Golden angle index: ((i+1) * phi) mod 1
    const aP = ((a + 1) * phi) % 1;
    const bP = ((b + 1) * phi) % 1;
    return aP - bP;
  });
  test('C8: Penrose golden-angle ordering', ordering);
}

// ── C9: Möbius strip (1-sided twist)
{
  // Embed in 2D, but with a twist: positions are (x, y) where y=length, x=action,
  // but at "x = max" we wrap with y → -y. Traversal is a Möbius walk.
  const actionsSeen = new Set();
  for (const s of shapes) actionsSeen.add(JSON.parse(s).action);
  const actList = [...actionsSeen].sort();
  const actIdx = new Map(actList.map((a, i) => [a, i]));
  const grid = [];
  for (let i = 0; i < actList.length; i++) grid.push([]);
  for (let i = 0; i < M; i++) {
    const ai = actIdx.get(JSON.parse(shapes[i]).action);
    grid[ai].push(i);
  }
  grid.forEach(g => g.sort((a, b) => shapes[a].length - shapes[b].length));
  // Möbius walk: go down each column, alternating direction
  const ordering = [];
  for (let c = 0; c < grid.length; c++) {
    const col = c % 2 === 0 ? grid[c] : [...grid[c]].reverse();
    ordering.push(...col);
  }
  test('C9: Möbius column-walk (alternating direction)', ordering);
}

// ── C10: Hyperbolic Poincaré disk (Dunham) — bring distant points close
{
  // Hyperbolic distance metric: d_H(p, q) = arctanh(|p-q|/|1-p*conj(q)|)
  // Approximate by sorting by (action+length+lex) descending then ascending — alternating
  // For now: greedy nearest-neighbor in hyperbolic metric proxy
  // Use action_idx and length as the disk coordinates (normalized to <1)
  const actionsSeen = new Set();
  for (const s of shapes) actionsSeen.add(JSON.parse(s).action);
  const actList = [...actionsSeen].sort();
  const actIdx = new Map(actList.map((a, i) => [a, i]));
  const lens = shapes.map(s => s.length);
  const maxLen = Math.max(...lens);
  const coords = shapes.map(s => {
    const p = JSON.parse(s);
    return [(actIdx.get(p.action) + 0.5) / actList.length, s.length / maxLen];
  });
  // Greedy NN by Euclidean distance in disk space
  const ordering = [0];
  const used = new Set([0]);
  while (used.size < M) {
    const cur = coords[ordering[ordering.length - 1]];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < M; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(coords[i][0] - cur[0], coords[i][1] - cur[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    used.add(best); ordering.push(best);
  }
  test('C10: hyperbolic Poincaré greedy NN', ordering);
}

// ── C11: Knot signature — sort by content hash mod 7 (3-bridge knot proxy)
{
  const sigs = shapes.map(s => {
    const h = crypto.createHash('sha256').update(s).digest();
    return h[0] % 7;  // 7-fold knot bridge index
  });
  const groups = Array.from({length: 7}, () => []);
  for (let i = 0; i < M; i++) groups[sigs[i]].push(i);
  groups.forEach(g => g.sort((a, b) => shapes[a].localeCompare(shapes[b])));
  const ordering = groups.flat();
  test('C11: 7-fold knot-sig (sha mod 7) cluster', ordering);
}

// ── C12: Turning Key d=2 (Tetlow d=2 ring pairs)
{
  // Halve the corpus, interleave first half with second half
  const half = Math.ceil(M / 2);
  const lex = shapes.map((_, i) => i).sort((a, b) => shapes[a].localeCompare(shapes[b]));
  const ordering = [];
  for (let i = 0; i < half; i++) {
    ordering.push(lex[i]);
    if (i + half < M) ordering.push(lex[i + half]);
  }
  test('C12: Tetlow turning-key d=2 ring-pair interleave', ordering);
}

// ── C13: B8 + within-bucket Hilbert
{
  // Group by action, sort within bucket by Hilbert(length, lex_rank)
  const buckets = new Map();
  for (let i = 0; i < M; i++) {
    const a = JSON.parse(shapes[i]).action;
    if (!buckets.has(a)) buckets.set(a, []);
    buckets.get(a).push(i);
  }
  const ordering = [];
  const sortedActions = [...buckets.keys()].sort();
  for (const a of sortedActions) {
    const idxs = buckets.get(a);
    // Within bucket: 2D Hilbert on (length, lex_rank)
    const lens = idxs.map(i => shapes[i].length);
    const lensSorted = [...lens].sort((a, b) => a - b);
    const lexRank = new Map();
    [...idxs].sort((a, b) => shapes[a].localeCompare(shapes[b])).forEach((i, r) => lexRank.set(i, r));
    const gridN = 8;  // small grid per bucket
    const ds = idxs.map(i => {
      const lp = Math.min(gridN - 1, Math.floor((lensSorted.indexOf(shapes[i].length) / lens.length) * gridN));
      const lr = Math.min(gridN - 1, Math.floor((lexRank.get(i) / idxs.length) * gridN));
      return hilbertXY2D(gridN, lp, lr);
    });
    const subOrder = [...idxs].sort((a, b) => ds[idxs.indexOf(a)] - ds[idxs.indexOf(b)]);
    ordering.push(...subOrder);
  }
  test('C13: B8 + within-bucket Hilbert(length, lex_rank)', ordering);
}

// ── C14: B8 with reversed strings (suffix-aware)
{
  // Sort by reversed-string within action+length groups
  const ordering = shapes.map((_, i) => i).sort((a, b) => {
    const A = JSON.parse(shapes[a]), B = JSON.parse(shapes[b]);
    if (A.action !== B.action) return A.action.localeCompare(B.action);
    if (shapes[a].length !== shapes[b].length) return shapes[a].length - shapes[b].length;
    const ra = shapes[a].split('').reverse().join('');
    const rb = shapes[b].split('').reverse().join('');
    return ra.localeCompare(rb);
  });
  test('C14: B8 with reverse-string tiebreaker', ordering);
}

// ── C15: B8 with summary-then-payload tiebreaker
{
  const ordering = shapes.map((_, i) => i).sort((a, b) => {
    const A = JSON.parse(shapes[a]), B = JSON.parse(shapes[b]);
    if (A.action !== B.action) return A.action.localeCompare(B.action);
    if (shapes[a].length !== shapes[b].length) return shapes[a].length - shapes[b].length;
    const sumCmp = (A.summary || '').localeCompare(B.summary || '');
    if (sumCmp !== 0) return sumCmp;
    return (A.payload_json || '').localeCompare(B.payload_json || '');
  });
  test('C15: B8 + summary→payload tiebreaker', ordering);
}

// ── Sort final results ──
console.log(`\n=== SORTED BY SIZE (smaller = better) ===`);
results.sort((a, b) => a.size - b.size);
for (const r of results) {
  console.log(`${r.size.toString().padStart(6)} B   Δbase ${r.dBaseline > 0 ? '+' : ''}${r.dBaseline}   ΔB8 ${r.dB8 > 0 ? '+' : ''}${r.dB8}   ${r.name}`);
}
console.log(`\nBaseline: ${baseline} | B8 (Method 9): ${b8size}`);

const winner = results[0];
if (winner.size < b8size) {
  const oldM9 = 49310;  // Method 9 total
  const newTotal = oldM9 - b8size + winner.size;
  const detSize = 2075585;
  console.log(`\nPROJECTED: replace B8 with ${winner.name}:`);
  console.log(`  Method 9 total ${oldM9} B → new ${newTotal} B`);
  console.log(`  Ratio: ${(detSize / oldM9).toFixed(2)}x → ${(detSize / newTotal).toFixed(2)}x`);
}

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '45-celtic-sequencing', baseline, b8_size: b8size, results
}, null, 2));
