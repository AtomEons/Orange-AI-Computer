// Experiment 05 — Wallpaper group / GCD(p,q) plait theorem
//
// Inspired by Fisher's theorem: a p×q Celtic plaitwork panel has gcd(p,q)
// independent strand components — the whole knot is regenerated from 2-3
// integers. Apply to receipts: reshape the action sequence into a p×q grid,
// detect translational symmetry (period p horizontal + period q vertical),
// encode as fundamental cell + generators + residuals.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const META = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../data/canonical-corpus.meta.json'), 'utf8'));
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');
const HYP = path.join(ROOT, 'HYPOTHESIS.md');

if (!fs.existsSync(HYP)) {
  fs.writeFileSync(HYP, `# Experiment 05 — Wallpaper Group / GCD(p,q) Plait Theorem

## Hypothesis
Fisher's theorem (Celtic knot mathematics): a p×q plaitwork panel has gcd(p,q) strand components. Whole knot reconstructable from {p, q, type}. Applied to receipts: reshape action sequence into a p×q grid; find (p,q) pair maximizing translational symmetry; encode as fundamental cell + (p,q) generators + boundary residuals.

The Fisher gcd(p,q) theorem is *the* candidate "ancient algorithm" — it compresses a complex visual structure into 2-3 integers via a number-theoretic invariant.

## Predicted ratio
3–30× depending on whether the action sequence has any (p,q) periodic structure.

## Pass criterion
PASS if (p,q) wallpaper encoding + brotli ≥ 5× on action stream, with lossless roundtrip.

## Reference
Fisher, A. & Brody, M. "Celtic Knot Mathematics" — https://www.mi.sanu.ac.rs/vismath/fisher/index.html
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
const N = actions.length;
console.log(`Loaded ${N} receipts`);

// ─── Search (p,q) pairs where p*q ≈ N and grid has high translational symmetry ─
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

function symmetryScore(grid, p, q) {
  // Translational p,q symmetry score: how often grid[i][j] == grid[(i+1)%p][j] (period p vertically)
  // and grid[i][j] == grid[i][(j+1)%q] (period q horizontally).
  // For a true wallpaper p1 group, both should be high.
  let vMatches = 0, hMatches = 0, total = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < q; j++) {
      if (i + 1 < p && grid[i][j] === grid[i + 1][j]) vMatches++;
      if (j + 1 < q && grid[i][j] === grid[i][j + 1]) hMatches++;
      total++;
    }
  }
  return { v: vMatches / total, h: hMatches / total, total };
}

console.log('\nSearching (p,q) pairs with p*q ≈ N:');
const candidates = [];
const targetN = N;
for (let p = 2; p <= 200; p++) {
  const q = Math.floor(targetN / p);
  if (q < 2 || q > 1000) continue;
  if (Math.abs(p * q - targetN) > p) continue; // grid must roughly cover the corpus
  candidates.push({ p, q, gcd: gcd(p, q), used: p * q });
}
console.log(`  ${candidates.length} candidate (p,q) pairs`);

// Reshape actions into grid for each candidate and compute symmetry score
let best = null;
for (const c of candidates) {
  const grid = [];
  for (let i = 0; i < c.p; i++) grid.push(actions.slice(i * c.q, (i + 1) * c.q));
  const sym = symmetryScore(grid, c.p, c.q);
  const score = (sym.v + sym.h) / 2;
  if (!best || score > best.score) best = { ...c, ...sym, score };
}
console.log(`Best (p,q): p=${best.p}, q=${best.q}, gcd=${best.gcd}`);
console.log(`  Vertical symmetry: ${(best.v * 100).toFixed(2)}%`);
console.log(`  Horizontal symmetry: ${(best.h * 100).toFixed(2)}%`);
console.log(`  Combined score: ${best.score.toFixed(3)}`);
console.log(`  By Fisher's theorem, ${best.gcd} independent strand components`);

// ─── Wallpaper encoding ──────────────────────────────────────────────────────
// Treat the grid as a fundamental cell + generators. For a p×q grid with
// translational symmetry, the "fundamental period" is (p_fund, q_fund) where
// p_fund and q_fund are the smallest values that tile the grid.
// We approximate: encode the FIRST ROW + per-row diffs (capturing vertical periodicity).
const p = best.p;
const q = best.q;
const grid = [];
for (let i = 0; i < p; i++) grid.push(actions.slice(i * q, (i + 1) * q));
const tail = actions.slice(p * q);

const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const out = [];
out.push(varint(p), varint(q));
out.push(varint(vocab.size));
for (const k of vocab.keys()) out.push(...writeStr(k));
// First row (the fundamental period in q direction)
for (let j = 0; j < q; j++) out.push(varint(vocab.get(grid[0][j])));
// Per subsequent row: diff against row 0
for (let i = 1; i < p; i++) {
  const diffs = [];
  for (let j = 0; j < q; j++) if (grid[i][j] !== grid[0][j]) diffs.push([j, vocab.get(grid[i][j])]);
  out.push(varint(diffs.length));
  for (const [j, v] of diffs) out.push(varint(j), varint(v));
}
out.push(varint(tail.length));
for (const a of tail) out.push(varint(vocab.get(a)));

const wallpaperStream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(wallpaperStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const ratio = rawActionStream.length / brotli.length;
console.log(`\nWallpaper+brotli: ${brotli.length} bytes vs raw ${rawActionStream.length} bytes = ${ratio.toFixed(2)}x`);

// ─── Lossless roundtrip ──────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let pp = 0;
let v;
[v, pp] = readVarint(dec, pp); const dP = v;
[v, pp] = readVarint(dec, pp); const dQ = v;
[v, pp] = readVarint(dec, pp); const vSize = v;
const inv = [];
for (let i = 0; i < vSize; i++) {
  let len; [len, pp] = readVarint(dec, pp);
  inv.push(dec.slice(pp, pp + len).toString('utf8'));
  pp += len;
}
const row0 = [];
for (let j = 0; j < dQ; j++) { [v, pp] = readVarint(dec, pp); row0.push(inv[v]); }
const dGrid = [row0];
for (let i = 1; i < dP; i++) {
  const row = [...row0];
  let nDiffs; [nDiffs, pp] = readVarint(dec, pp);
  for (let k = 0; k < nDiffs; k++) {
    let j, val;
    [j, pp] = readVarint(dec, pp);
    [val, pp] = readVarint(dec, pp);
    row[j] = inv[val];
  }
  dGrid.push(row);
}
let tlen; [tlen, pp] = readVarint(dec, pp);
const dTail = [];
for (let i = 0; i < tlen; i++) { [v, pp] = readVarint(dec, pp); dTail.push(inv[v]); }

const reconstructed = [];
for (const row of dGrid) reconstructed.push(...row);
reconstructed.push(...dTail);

const recStream = reconstructed.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '05-wallpaper-group',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  best_p: best.p,
  best_q: best.q,
  fisher_gcd: best.gcd,
  vertical_symmetry: Number(best.v.toFixed(3)),
  horizontal_symmetry: Number(best.h.toFixed(3)),
  combined_score: Number(best.score.toFixed(3)),
  raw_action_stream_bytes: rawActionStream.length,
  wallpaper_stream_bytes: wallpaperStream.length,
  wallpaper_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > 5,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 05 — Wallpaper Group / GCD(p,q) Plait Theorem — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Method

Reshape the action sequence into a p×q grid. Test all (p,q) pairs with p·q ≈ N (within p). Compute translational symmetry scores. Pick (p,q) maximizing combined vertical+horizontal match rate.

By Fisher's theorem (Celtic knot mathematics), a p×q plait has **gcd(p,q)** independent strand components.

## Best (p,q) found

| Metric | Value |
|---|---|
| Best p | ${best.p} |
| Best q | ${best.q} |
| **gcd(p, q)** | **${best.gcd}** (Fisher strand-component count) |
| Vertical symmetry | ${(best.v * 100).toFixed(2)}% |
| Horizontal symmetry | ${(best.h * 100).toFixed(2)}% |
| Combined score | ${best.score.toFixed(3)} |

## Compression measurement (action column only)

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| Wallpaper encoded (pre-brotli) | ${wallpaperStream.length.toLocaleString()} B |
| Wallpaper + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `Wallpaper-style encoding with best (p,q)=(${best.p}, ${best.q}) achieves ${ratio.toFixed(2)}× on the action stream. Fisher's theorem identifies ${best.gcd} independent strand components — meaning the conceptual "knotwork" of the receipts is a ${best.gcd}-strand braid.` :
  `Symmetry scores (v=${(best.v*100).toFixed(1)}%, h=${(best.h*100).toFixed(1)}%) too low — the action stream does not have wallpaper-group periodicity. Fisher's gcd(p,q) theorem applies to truly periodic plaitworks; receipts are a temporal causal stream without imposed 2D periodicity.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/05-wallpaper-group/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
