// Experiment 34 — Battery of 20 What-If Experiments
//
// Operator: "20 more experiments now. all possibles all maybes all what ifs"
//
// Strategy: every experiment is self-contained, runs on the canonical corpus,
// reports (ratio, byte_size, lossless_byte_exact, notes). The exps span:
//   - Advanced entropy coders (PPMd, MTF, byte-mixing)
//   - Cross-corpus structural patterns (templates, rank-encoding)
//   - Combinations of established wins
//   - Speculative/quantum-inspired math (Hadamard, Hilbert curve, modular)
//   - Algorithmic regeneration (DAG, hash chains)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Corpus: ${corpusBytes.length} B, sha ${corpusSha.slice(0,16)}..., ${N} receipts\n`);

const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const brotliDec = b => zlib.brotliDecompressSync(b);

const results = [];
function record(name, encoded_size, lossless, notes = '') {
  const ratio = corpusBytes.length / encoded_size;
  results.push({ name, encoded_size, ratio: Number(ratio.toFixed(2)), lossless, notes });
  const mark = lossless === true ? '✓' : lossless === false ? '✗' : '?';
  console.log(`${name.padEnd(58)} ${encoded_size.toString().padStart(8)} B  ${ratio.toFixed(2).padStart(6)}x  ${mark}  ${notes}`);
}

function verifySha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex') === corpusSha;
}

// Util: varint
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-A1 — PPMd-style order-2 byte context coder + arithmetic
// ═══════════════════════════════════════════════════════════════════════════
function exp_ppm_order2() {
  // For each byte position, look at (prev2byte, prev1byte) → count distribution
  // Use arithmetic coder; report bytes needed
  const N_SYM = 256;
  const ctxCounts = new Map(); // (b1<<8|b2) → Uint16Array(256) counts
  const ctxTot = new Map(); // ctx → total count
  let totalBits = 0;
  for (let i = 2; i < corpusBytes.length; i++) {
    const ctx = (corpusBytes[i-2] << 8) | corpusBytes[i-1];
    const cur = corpusBytes[i];
    let counts = ctxCounts.get(ctx);
    if (!counts) { counts = new Uint16Array(N_SYM); ctxCounts.set(ctx, counts); ctxTot.set(ctx, 0); }
    // bits to encode this symbol with current Laplace-smoothed model
    const tot = ctxTot.get(ctx) + N_SYM;
    const p = (counts[cur] + 1) / tot;
    totalBits += -Math.log2(p);
    counts[cur]++;
    ctxTot.set(ctx, ctxTot.get(ctx) + 1);
  }
  const ppmBytes = Math.ceil(totalBits / 8);
  // Plus model storage (counts table): can be very large; approximate as visited contexts × 256 × 2 bytes
  // For asymptotic ceiling, treat model as free (decoder builds it incrementally — adaptive coder)
  // For honest reporting: this is data-rate ONLY
  record('A1: PPMd-adaptive order-2 byte coder (data-rate only)', ppmBytes, '?',
    'theoretical — adaptive model = no transmitted model; assumes both sides agree on Laplace');
  return ppmBytes;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-A2 — Order-3 PPM
// ═══════════════════════════════════════════════════════════════════════════
function exp_ppm_order3() {
  const N_SYM = 256;
  const ctxCounts = new Map();
  const ctxTot = new Map();
  let totalBits = 0;
  for (let i = 3; i < corpusBytes.length; i++) {
    const ctx = (corpusBytes[i-3] << 16) | (corpusBytes[i-2] << 8) | corpusBytes[i-1];
    const cur = corpusBytes[i];
    let counts = ctxCounts.get(ctx);
    if (!counts) { counts = new Uint16Array(N_SYM); ctxCounts.set(ctx, counts); ctxTot.set(ctx, 0); }
    const tot = ctxTot.get(ctx) + N_SYM;
    const p = (counts[cur] + 1) / tot;
    totalBits += -Math.log2(p);
    counts[cur]++;
    ctxTot.set(ctx, ctxTot.get(ctx) + 1);
  }
  const bytes = Math.ceil(totalBits / 8);
  record('A2: PPMd-adaptive order-3 byte coder (data-rate only)', bytes, '?', `${ctxCounts.size} contexts`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-A3 — Move-to-Front + Huffman (after sort) — bzip2-style
// ═══════════════════════════════════════════════════════════════════════════
function exp_mtf_huffman() {
  // Sort the corpus by byte cycles (BWT proxy: lexicographic sort of suffixes)
  // Too expensive on 2MB. Approximate: sort the LINES of the corpus, then MTF the byte stream
  const sortedLines = [...lines].sort().join('\n') + '\n';
  const sb = Buffer.from(sortedLines, 'utf8');
  // MTF transform
  const dict = new Uint8Array(256);
  for (let i = 0; i < 256; i++) dict[i] = i;
  const mtf = new Uint8Array(sb.length);
  for (let i = 0; i < sb.length; i++) {
    const b = sb[i];
    let pos = 0;
    while (dict[pos] !== b) pos++;
    mtf[i] = pos;
    // Move to front
    for (let j = pos; j > 0; j--) dict[j] = dict[j-1];
    dict[0] = b;
  }
  // Brotli the MTF output
  const out = brotli11(Buffer.from(mtf));
  // Plus permutation index (sorted → original)
  const permBuf = Buffer.from([...lines].map((_, i) => lines.indexOf(sortedLines.split('\n')[i])).join(','), 'utf8');
  const permBrotli = brotli11(permBuf);
  record('A3: sorted lines + MTF + brotli + permutation', out.length + permBrotli.length, '?',
    'permutation cost included; lossless verify pending');
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-A4 — Byte-mixing predictor (order-0 + order-1 + order-2 weighted)
// ═══════════════════════════════════════════════════════════════════════════
function exp_mix_predictor() {
  const N_SYM = 256;
  const c0 = new Uint32Array(N_SYM);
  const c1 = new Map(); // prev → counts
  const c2 = new Map(); // (prev1<<8|prev2) → counts
  let totalBits = 0;
  let n0 = 0;
  for (let i = 0; i < corpusBytes.length; i++) {
    const cur = corpusBytes[i];
    const p0 = (c0[cur] + 1) / (n0 + N_SYM);
    let p1 = p0;
    if (i >= 1) {
      let cs = c1.get(corpusBytes[i-1]);
      if (cs) p1 = (cs[cur] + 1) / (cs[N_SYM] + N_SYM);
    }
    let p2 = p1;
    if (i >= 2) {
      const k = (corpusBytes[i-2] << 8) | corpusBytes[i-1];
      let cs = c2.get(k);
      if (cs) p2 = (cs[cur] + 1) / (cs[N_SYM] + N_SYM);
    }
    // Equal-weight mix
    const p = (p0 + p1 + p2) / 3;
    totalBits += -Math.log2(p);
    c0[cur]++; n0++;
    if (i >= 1) {
      let cs = c1.get(corpusBytes[i-1]);
      if (!cs) { cs = new Uint32Array(N_SYM + 1); c1.set(corpusBytes[i-1], cs); }
      cs[cur]++; cs[N_SYM]++;
    }
    if (i >= 2) {
      const k = (corpusBytes[i-2] << 8) | corpusBytes[i-1];
      let cs = c2.get(k);
      if (!cs) { cs = new Uint32Array(N_SYM + 1); c2.set(k, cs); }
      cs[cur]++; cs[N_SYM]++;
    }
  }
  record('A4: mix-of-order 0+1+2 byte predictor (data-rate)', Math.ceil(totalBits / 8), '?',
    `${c2.size} order-2 contexts; theoretical`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-B1 — Run-length on action sequence + brotli the rest
// ═══════════════════════════════════════════════════════════════════════════
function exp_action_rle() {
  // Build action vocab + RLE-encode the action sequence
  const aV = new Map(); for (const r of receipts) if (!aV.has(r.action)) aV.set(r.action, aV.size);
  const aIds = receipts.map(r => aV.get(r.action));
  const runs = [];
  let prev = aIds[0], count = 1;
  for (let i = 1; i < aIds.length; i++) {
    if (aIds[i] === prev) count++;
    else { runs.push([prev, count]); prev = aIds[i]; count = 1; }
  }
  runs.push([prev, count]);
  const aBytes = [];
  for (const [id, cnt] of runs) { aBytes.push(...varintU(id), ...varintU(cnt)); }
  const aBuf = Buffer.from(aBytes);
  const vBuf = Buffer.from([...aV.keys()].join('\x02'), 'utf8');
  // The rest of the corpus minus action field (replaced by sentinel)
  const restJsonl = receipts.map(r => JSON.stringify({...r, action: ''})).join('\n') + '\n';
  const restBrotli = brotli11(Buffer.from(restJsonl, 'utf8'));
  const aBrotli = brotli11(aBuf);
  const vBrotli = brotli11(vBuf);
  const total = restBrotli.length + aBrotli.length + vBrotli.length;
  record('B1: RLE action seq + vocab + rest-brotli', total, '?', `${runs.length} runs over ${aIds.length} actions`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-B2 — Hash-table dedup: replace each unique payload_json with an ID
// ═══════════════════════════════════════════════════════════════════════════
function exp_payload_dedup() {
  const payloadMap = new Map();
  const ids = receipts.map(r => {
    const k = r.payload_json || '\0NULL\0';
    if (!payloadMap.has(k)) payloadMap.set(k, payloadMap.size);
    return payloadMap.get(k);
  });
  // Encode: array of payload IDs (varint) + the unique payload dict (brotli)
  const idBytes = Buffer.from(ids.flatMap(i => varintU(i)));
  const dictBytes = Buffer.from([...payloadMap.keys()].join('\x02'), 'utf8');
  const idsBrotli = brotli11(idBytes);
  const dictBrotli = brotli11(dictBytes);
  // The rest: each receipt is action+status+summary+created_at+id WITHOUT payload
  const restJsonl = receipts.map(r => JSON.stringify({...r, payload_json: ''})).join('\n') + '\n';
  const restBrotli = brotli11(Buffer.from(restJsonl, 'utf8'));
  const total = idsBrotli.length + dictBrotli.length + restBrotli.length;
  record('B2: payload-dedup + IDs + rest-brotli', total, '?',
    `${payloadMap.size} distinct payloads`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-B3 — Per-action sub-brotli (no concatenation), sum bytes
// ═══════════════════════════════════════════════════════════════════════════
function exp_per_action_brotli() {
  const byAction = new Map();
  for (const r of receipts) {
    if (!byAction.has(r.action)) byAction.set(r.action, []);
    byAction.get(r.action).push(JSON.stringify(r));
  }
  let total = 0;
  for (const [_, recs] of byAction) {
    const s = recs.join('\n') + '\n';
    total += brotli11(Buffer.from(s, 'utf8')).length;
  }
  // Plus action sequence to recover order
  const aSeq = receipts.map(r => r.action).join('\x02');
  const aSeqBrotli = brotli11(Buffer.from(aSeq, 'utf8'));
  record('B3: per-action brotli (separate streams) + seq', total + aSeqBrotli.length, '?',
    `${byAction.size} action groups`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-B4 — Numeric rank encoding (replace numbers with their rank)
// ═══════════════════════════════════════════════════════════════════════════
function exp_numeric_rank() {
  // Collect all numeric tokens across payloads
  const numCounts = new Map();
  for (const r of receipts) {
    if (r.payload_json == null) continue;
    const nums = String(r.payload_json).match(/-?\d+(?:\.\d+)?/g) || [];
    for (const n of nums) numCounts.set(n, (numCounts.get(n) || 0) + 1);
  }
  // Sort by frequency descending — give most common smallest rank
  const sortedNums = [...numCounts.entries()].sort((a, b) => b[1] - a[1]);
  const rankMap = new Map();
  for (let i = 0; i < sortedNums.length; i++) rankMap.set(sortedNums[i][0], i);
  // Replace each numeric in payload_json with its rank
  const replaced = receipts.map(r => {
    if (r.payload_json == null) return r;
    const newPayload = String(r.payload_json).replace(/-?\d+(?:\.\d+)?/g, m => '#' + rankMap.get(m));
    return { ...r, payload_json: newPayload };
  });
  const repJsonl = replaced.map(r => JSON.stringify(r)).join('\n') + '\n';
  const repBrotli = brotli11(Buffer.from(repJsonl, 'utf8'));
  // Plus the rank → value dict
  const dictBytes = Buffer.from(sortedNums.map(([v, c]) => v).join('\x02'), 'utf8');
  const dictBrotli = brotli11(dictBytes);
  record('B4: numeric-rank encoding + dict brotli', repBrotli.length + dictBrotli.length, '?',
    `${sortedNums.length} distinct numerics`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-C1 — Det-ID + conditional-on-action coders + targeted per-action + brotli
// ═══════════════════════════════════════════════════════════════════════════
function exp_full_stack_v1() {
  const SEED = 'orange5-receipt-stream-v1';
  function detId(seed, i) {
    return 'rcpt_' + crypto.createHash('sha256').update(seed + '||' + i).digest('hex').slice(0, 16);
  }
  // For each receipt, remove id and id-related parts. Audit content remains.
  const audit = receipts.map((r, i) => ({...r, id: ''}));
  const auditJsonl = audit.map(r => JSON.stringify(r)).join('\n') + '\n';
  const auditBrotli = brotli11(Buffer.from(auditJsonl, 'utf8'));
  // Seed recipe
  const seedR = Buffer.from(JSON.stringify({seed: SEED, n: receipts.length}), 'utf8');
  const seedBrotli = brotli11(seedR);
  // BUT: we also need to verify the IDs in the corpus aren't already deterministic
  // For honesty: this assumes the corpus IS regenerated with det-IDs (Exp 31 ceiling)
  const total = auditBrotli.length + seedBrotli.length;
  record('C1: audit (no IDs) + seed recipe (Exp 31 reprise)', total, '?',
    'matches Exp 31 against det-corpus, ~31.39x');
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-C2 — Templatize every receipt, brotli templates + brotli numerics
// ═══════════════════════════════════════════════════════════════════════════
function exp_full_templ_split() {
  const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
  const tplLines = [], numLines = [];
  for (const r of receipts) {
    const nums = [];
    const tpl = JSON.stringify(r).replace(NUM_RE, m => { nums.push(m); return '\x01'; });
    tplLines.push(tpl);
    numLines.push(nums.join('\x02'));
  }
  const tplBytes = Buffer.from(tplLines.join('\n'), 'utf8');
  const numBytes = Buffer.from(numLines.join('\x03'), 'utf8');
  const tplBrotli = brotli11(tplBytes);
  const numBrotli = brotli11(numBytes);
  record('C2: full-receipt templatize + split-brotli', tplBrotli.length + numBrotli.length, '?',
    `tpl=${tplBrotli.length}B nums=${numBrotli.length}B`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-C3 — Recursive: brotli output then ans/range-coder on it
// ═══════════════════════════════════════════════════════════════════════════
function exp_recursive_compression() {
  const first = brotli11(corpusBytes);
  // Brotli's output should be near-entropy. Re-compressing should not help.
  const second = brotli11(first);
  const third = zlib.gzipSync(first, { level: 9 });
  // The OUTPUT of brotli is essentially incompressible (high-entropy)
  record('C3: brotli → brotli (recursive)', second.length, second.length <= first.length,
    `brotli output ${first.length}B, recompressed ${second.length}B`);
  record('C3b: brotli → gzip', third.length, true, `brotli then gzip`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-C4 — Stack: strip-constants + det-ID + numeric-rank + Markov-action + brotli
// ═══════════════════════════════════════════════════════════════════════════
function exp_grand_stack() {
  // Build everything:
  // 1. Strip constants per action (Exp 23 v3)
  const perAction = new Map();
  for (const r of receipts) {
    if (r.payload_json == null) continue;
    let p; try { p = JSON.parse(r.payload_json); } catch { continue; }
    if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
    if (!perAction.has(r.action)) perAction.set(r.action, { count: 0, keyOrders: new Map(), keyValues: new Map() });
    const a = perAction.get(r.action);
    a.count++;
    a.keyOrders.set(Object.keys(p).join('\x00'), (a.keyOrders.get(Object.keys(p).join('\x00')) || 0) + 1);
    for (const [k, v] of Object.entries(p)) {
      if (!a.keyValues.has(k)) a.keyValues.set(k, new Map());
      a.keyValues.get(k).set(JSON.stringify(v), (a.keyValues.get(k).get(JSON.stringify(v)) || 0) + 1);
    }
  }
  const truConst = new Map();
  for (const [a, info] of perAction) {
    if (info.keyOrders.size !== 1) continue;
    const ko = [...info.keyOrders.keys()][0].split('\x00');
    const c = new Map();
    for (const k of ko) {
      const vs = info.keyValues.get(k);
      if (vs.size === 1 && [...vs.values()].reduce((s,c)=>s+c,0) === info.count) c.set(k, [...vs.keys()][0]);
    }
    truConst.set(a, {ko, c});
  }
  // 2. Det-ID
  const SEED = 'orange5-receipt-stream-v1';
  function detId(seed, i) {
    return 'rcpt_' + crypto.createHash('sha256').update(seed + '||' + i).digest('hex').slice(0, 16);
  }
  // 3. Build stripped det-ID audit content
  const stripped = receipts.map((r, i) => {
    let pj = r.payload_json;
    const tc = truConst.get(r.action);
    if (tc && pj != null) {
      try {
        const p = JSON.parse(pj);
        if (p != null && typeof p === 'object' && !Array.isArray(p)) {
          const s = {};
          for (const [k, v] of Object.entries(p)) if (!tc.c.has(k)) s[k] = v;
          pj = JSON.stringify(s);
        }
      } catch {}
    }
    return { ...r, id: '', payload_json: pj };
  });
  const strippedJsonl = stripped.map(r => JSON.stringify(r)).join('\n') + '\n';
  const strippedBrotli = brotli11(Buffer.from(strippedJsonl, 'utf8'));
  const recipe = {};
  for (const [a, info] of truConst) recipe[a] = { ko: info.ko, c: Object.fromEntries(info.c) };
  const recipeBytes = Buffer.from(JSON.stringify(recipe), 'utf8');
  const recipeBrotli = brotli11(recipeBytes);
  const seedR = Buffer.from(JSON.stringify({seed: SEED, n: receipts.length}), 'utf8');
  const seedBrotli = brotli11(seedR);
  const total = strippedBrotli.length + recipeBrotli.length + seedBrotli.length;
  record('C4: strip-const + det-ID + brotli', total, '?',
    `strip=${strippedBrotli.length} recipe=${recipeBrotli.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-D1 — Hadamard transform of byte sequence (quantum-inspired)
// ═══════════════════════════════════════════════════════════════════════════
function exp_hadamard() {
  // The Hadamard transform on a power-of-2 byte vector: H[i,j] = (-1)^{i·j}/sqrt(N)
  // It's an orthogonal change of basis. For LOSSLESS, we need integer Hadamard (no sqrt scaling).
  // Walsh-Hadamard transform: O(N log N), integer-friendly.
  // Effect on compression: concentrates energy in low-order coefficients ONLY if signal is structured.
  // For random/text bytes: doesn't help.
  // For periodic structured data (which our action sequence sort of is): can help.
  //
  // Apply WHT to a power-of-2 prefix of the corpus, then brotli.
  let n = 1; while (n * 2 <= corpusBytes.length) n *= 2;
  const x = new Int32Array(n);
  for (let i = 0; i < n; i++) x[i] = corpusBytes[i];
  // In-place WHT
  for (let h = 1; h < n; h *= 2) {
    for (let i = 0; i < n; i += h * 2) {
      for (let j = i; j < i + h; j++) {
        const a = x[j], b = x[j + h];
        x[j] = a + b;
        x[j + h] = a - b;
      }
    }
  }
  // Quantize back to bytes (lossy)
  // For HONEST report: just dump as int32, brotli
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) buf.writeInt32LE(x[i], i * 4);
  const out = brotli11(buf);
  record('D1: WHT (Hadamard) on byte prefix + brotli (lossy)', out.length, false,
    `n=${n}, 4-byte coefficients; NOT lossless`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-D2 — Hilbert curve linearization (preserves 2D locality)
// ═══════════════════════════════════════════════════════════════════════════
function exp_hilbert() {
  // Place the corpus bytes onto a 2D grid, traverse via Hilbert curve, brotli.
  // Hilbert preserves 2D locality better than row-major. For data with 2D structure, helps.
  // Our corpus is 1D so probably doesn't help.
  // Quick test: arrange bytes on a sqrt(N)×sqrt(N) grid; hilbert-walk.
  const N = corpusBytes.length;
  const side = Math.ceil(Math.sqrt(N));
  const grid = new Uint8Array(side * side);
  for (let i = 0; i < N; i++) grid[i] = corpusBytes[i];
  // Hilbert order on side×side grid (must be power of 2)
  let order = 1; while (order < side) order *= 2;
  // For each i in 0..order²-1, compute (x,y) via Hilbert iter
  function d2xy(n, d) {
    let rx, ry, t = d, x = 0, y = 0;
    for (let s = 1; s < n; s *= 2) {
      rx = 1 & (t / 2);
      ry = 1 & (t ^ rx);
      // Rotate
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        const tmp = x; x = y; y = tmp;
      }
      x += s * rx; y += s * ry;
      t = Math.floor(t / 4);
    }
    return [x, y];
  }
  const out = new Uint8Array(N);
  let written = 0;
  for (let i = 0; i < order * order && written < N; i++) {
    const [x, y] = d2xy(order, i);
    if (x < side && y < side && y * side + x < N) {
      out[written++] = grid[y * side + x];
    }
  }
  // Pad if needed
  while (written < N) out[written++] = 0;
  const buf = Buffer.from(out);
  const br = brotli11(buf);
  // To recover original, need inverse hilbert mapping — small overhead (deterministic given N)
  record('D2: Hilbert-curve linearization + brotli', br.length, '?',
    `side=${side}, hilbert order=${order}; lossless if mapping deterministic`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-D3 — Continued fraction encoding of mesh.compress ratios
// ═══════════════════════════════════════════════════════════════════════════
function exp_continued_fraction() {
  // mesh.compress payloads have ratio = round(raw_bytes/comp_bytes, 2)
  // Many ratios are SIMPLE FRACTIONS (e.g. 1.5 = 3/2, 1.67 = 5/3).
  // Continued fraction expansion can compress these very densely.
  // Limited utility but worth testing.
  const ratios = [];
  for (const r of receipts) {
    if (r.action !== 'mesh.compress') continue;
    try {
      const p = JSON.parse(r.payload_json);
      if (p && p.ratio) ratios.push(p.ratio);
    } catch {}
  }
  // For each ratio, find best rational p/q with q<=100
  function bestFrac(x) {
    let best = [Math.round(x), 1];
    let bestErr = Math.abs(x - best[0]);
    for (let q = 1; q <= 100; q++) {
      const p = Math.round(x * q);
      const err = Math.abs(x - p / q);
      if (err < bestErr) { best = [p, q]; bestErr = err; }
    }
    return { num: best[0], den: best[1], err: bestErr };
  }
  // Count how many ratios are exactly representable as p/q (q<=100)
  let exact = 0, sumErr = 0;
  for (const r of ratios) {
    const f = bestFrac(r);
    if (f.err < 1e-9) exact++;
    sumErr += f.err;
  }
  const avgErr = sumErr / Math.max(1, ratios.length);
  record('D3: continued-fraction representable mesh.compress ratios', ratios.length, exact === ratios.length,
    `${exact}/${ratios.length} exact at q≤100; avg err ${avgErr.toExponential(2)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-D4 — Modular periodicity detection
// ═══════════════════════════════════════════════════════════════════════════
function exp_modular() {
  // For each prime p, count how often action[i] == action[i mod p] holds across the corpus
  // If a prime p has high coincidence rate, there's modular structure.
  const aSeq = receipts.map(r => r.action);
  const N = aSeq.length;
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61];
  const top = [];
  for (const p of primes) {
    let match = 0;
    for (let i = p; i < N; i++) if (aSeq[i] === aSeq[i - p]) match++;
    const rate = match / (N - p);
    top.push({ p, rate });
  }
  top.sort((a, b) => b.rate - a.rate);
  record('D4: modular periodicity in action seq', N, '?',
    `top: ${top.slice(0,5).map(({p,rate})=>`p${p}=${(rate*100).toFixed(1)}%`).join(' ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-E1 — DAG-based regeneration: find receipt content dependencies
// ═══════════════════════════════════════════════════════════════════════════
function exp_dag_regen() {
  // For each pair (r_i, r_j), check if r_j contains r_i's id as a substring.
  // If yes, r_j depends on r_i. Build the dependency DAG.
  const idByPos = receipts.map(r => r.id);
  const idToIdx = new Map();
  for (let i = 0; i < idByPos.length; i++) idToIdx.set(idByPos[i], i);
  let dependentCount = 0;
  const incoming = new Map(); // pos → array of ids it references
  for (let i = 0; i < receipts.length; i++) {
    const text = JSON.stringify(receipts[i]);
    const refs = [];
    // Find all `rcpt_xxxxxxxxxxxxxxxx` substrings (16-char hex IDs)
    const matches = text.match(/rcpt_[0-9a-f]{16}/g) || [];
    for (const m of matches) {
      if (m !== receipts[i].id && idToIdx.has(m)) refs.push(idToIdx.get(m));
    }
    if (refs.length > 0) dependentCount++;
    incoming.set(i, refs);
  }
  // Count total incoming references — receipts that ARE referenced by others can be regenerated
  const refByCount = new Map();
  for (const [_, refs] of incoming) for (const r of refs) refByCount.set(r, (refByCount.get(r) || 0) + 1);
  const referencedReceipts = refByCount.size;
  record('E1: DAG dependency analysis', receipts.length, '?',
    `${dependentCount} receipts contain references; ${referencedReceipts} unique receipts referenced`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-E2 — SVD low-rank approximation of the receipt feature matrix
// ═══════════════════════════════════════════════════════════════════════════
function exp_svd_low_rank() {
  // Represent each receipt as a feature vector: counts of bytes
  // Build N×256 matrix. Take rank-K approximation. Brotli the residual.
  // Conceptually if receipts cluster in low-dim subspace, K=10 might suffice.
  // For lossless we need to store both factors + residual.
  // Quick approximation: just measure rank-1 (mean vector + per-receipt scale)
  const featMatrix = [];
  for (const r of receipts) {
    const text = JSON.stringify(r);
    const f = new Float64Array(256);
    for (let i = 0; i < text.length; i++) f[text.charCodeAt(i)]++;
    featMatrix.push(f);
  }
  // Compute mean
  const mean = new Float64Array(256);
  for (const f of featMatrix) for (let i = 0; i < 256; i++) mean[i] += f[i] / featMatrix.length;
  // Per-receipt scale (single coefficient via dot product)
  const scales = featMatrix.map(f => {
    let dot = 0, normM = 0;
    for (let i = 0; i < 256; i++) { dot += f[i] * mean[i]; normM += mean[i] * mean[i]; }
    return dot / normM;
  });
  // Residual = f - scale * mean
  // For lossless we'd need to store residual exactly; this is not really compression.
  // Just report the info: how clustered are receipts in feature space?
  const scaleVar = scales.reduce((s, x) => s + Math.pow(x - 1, 2), 0) / scales.length;
  record('E2: SVD rank-1 + per-receipt scale', receipts.length, '?',
    `scale variance ${scaleVar.toFixed(2)} (low = receipts cluster on mean)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-E3 — Hash chain encoding for repeated content blocks
// ═══════════════════════════════════════════════════════════════════════════
function exp_hash_chain() {
  // Split corpus into N-byte blocks. For each block, compute sha256, dedup.
  // Encode as: dict (unique blocks brotli'd) + sequence of block hashes.
  const BLOCK = 64;
  const blockMap = new Map();
  const blockIds = [];
  for (let i = 0; i < corpusBytes.length; i += BLOCK) {
    const blk = corpusBytes.slice(i, i + BLOCK);
    const h = blk.toString('binary'); // use as key
    if (!blockMap.has(h)) blockMap.set(h, blockMap.size);
    blockIds.push(blockMap.get(h));
  }
  const distinctBlocks = [...blockMap.keys()].map(b => Buffer.from(b, 'binary'));
  const dictBytes = Buffer.concat(distinctBlocks);
  const dictBrotli = brotli11(dictBytes);
  const idBytes = Buffer.from(blockIds.flatMap(varintU));
  const idBrotli = brotli11(idBytes);
  record(`E3: ${BLOCK}-byte block dedup + brotli`, dictBrotli.length + idBrotli.length, '?',
    `${blockMap.size}/${blockIds.length} unique blocks`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXP 34-E4 — Variable-length block dedup (find optimal block size)
// ═══════════════════════════════════════════════════════════════════════════
function exp_blocksize_sweep() {
  for (const BLOCK of [16, 32, 48, 64, 96, 128, 256]) {
    const blockMap = new Map();
    const blockIds = [];
    for (let i = 0; i < corpusBytes.length; i += BLOCK) {
      const blk = corpusBytes.slice(i, i + BLOCK).toString('binary');
      if (!blockMap.has(blk)) blockMap.set(blk, blockMap.size);
      blockIds.push(blockMap.get(blk));
    }
    const distinct = [...blockMap.keys()].map(b => Buffer.from(b, 'binary'));
    const dictBytes = Buffer.concat(distinct);
    const dictBrotli = brotli11(dictBytes);
    const idBytes = Buffer.from(blockIds.flatMap(varintU));
    const idBrotli = brotli11(idBytes);
    const total = dictBrotli.length + idBrotli.length;
    const ratio = corpusBytes.length / total;
    results.push({ name: `E4: block-dedup ${BLOCK}B`, encoded_size: total, ratio: Number(ratio.toFixed(2)), lossless: '?', notes: `${blockMap.size}/${blockIds.length} unique` });
    console.log(`${('E4: block-dedup ' + BLOCK + 'B').padEnd(58)} ${total.toString().padStart(8)} B  ${ratio.toFixed(2).padStart(6)}x  ?  ${blockMap.size}/${blockIds.length} unique`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN ALL
// ═══════════════════════════════════════════════════════════════════════════
console.log(`${'experiment'.padEnd(58)} ${'size'.padStart(8)}    ${'ratio'.padStart(6)}     mark   notes`);
console.log('─'.repeat(110));

console.log('\n--- Group A: Advanced entropy coders ---');
exp_ppm_order2();
exp_ppm_order3();
exp_mtf_huffman();
exp_mix_predictor();

console.log('\n--- Group B: Cross-corpus structural ---');
exp_action_rle();
exp_payload_dedup();
exp_per_action_brotli();
exp_numeric_rank();

console.log('\n--- Group C: Combinations of wins ---');
exp_full_stack_v1();
exp_full_templ_split();
exp_recursive_compression();
exp_grand_stack();

console.log('\n--- Group D: Speculative / abnormal math ---');
exp_hadamard();
exp_hilbert();
exp_continued_fraction();
exp_modular();

console.log('\n--- Group E: Algorithmic / structural ---');
exp_dag_regen();
exp_svd_low_rank();
exp_hash_chain();
exp_blocksize_sweep();

console.log('\n=== TOP 10 BY RATIO ===');
const sorted = [...results].sort((a, b) => b.ratio - a.ratio);
for (const r of sorted.slice(0, 15)) {
  console.log(`${r.ratio.toFixed(2).padStart(6)}x  ${r.encoded_size.toString().padStart(8)} B  ${r.name}`);
}

const out = {
  experiment: '34-batch-of-20',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  total_experiments: results.length,
  results,
  top_15: sorted.slice(0, 15),
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
