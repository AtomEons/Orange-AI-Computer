// Experiment 46 — 40 wildcard far-out combos + sub-bucket B8 refinements
//
// Operator: "a-b and 40 more wildcard experiments. pick random combos that are
// far out ideas." So: pivot toward replay pipeline (a), sub-bucket B8 (b), and
// 40 wildcards.

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
const SIZE = corpusBytes.length;

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const brotli6 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
const gzip9 = b => zlib.gzipSync(b, { level: 9 });
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }

// Build the canonical inputs we'll attack
const otherIdx = [];
for (let i = 0; i < N; i++) if (detReceipts[i].action !== 'mesh.compress') otherIdx.push(i);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const uniqShapes = new Set();
for (const i of otherIdx) uniqShapes.add(shapeKey(detReceipts[i]));
const shapes = [...uniqShapes];
const M = shapes.length;

const b8sorted = shapes.map((s, i) => ({ s, i })).sort((a, b) => {
  const A = JSON.parse(a.s), B = JSON.parse(b.s);
  if (A.action !== B.action) return A.action.localeCompare(B.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const b8shapes = b8sorted.map(x => x.s);
const b8size = brotli11(Buffer.from(b8shapes.join('\n') + '\n', 'utf8')).length;
console.log(`Shapes: ${M}, B8 brotli: ${b8size} B (Method 9 baseline)\n`);

const results = [];
function R(name, size, note = '') {
  const dB8 = size - b8size;
  results.push({ name, size, dB8, note });
  console.log(`${name.padEnd(58)} ${size.toString().padStart(6)} B   ΔB8 ${dB8 > 0 ? '+' : ''}${dB8.toString().padStart(5)}   ${note}`);
}
function attempt(name, fn, note = '') {
  try { const sz = fn(); R(name, sz, note); }
  catch (e) { console.log(`${name.padEnd(58)} ERROR: ${e.message.slice(0, 40)}`); }
}

// ── W01: BWT on raw shape data + MTF + brotli ────────────────────────
attempt('W01: BWT + MTF + brotli', () => {
  // Simple BWT: append shapes with separator, do BWT, then MTF, then brotli
  // Only on a sample (10 KB) due to BWT O(n²) cost
  const sample = b8shapes.slice(0, 50).join('\n');
  if (sample.length > 5000) throw new Error('sample too big');
  // Form all rotations
  const rotations = [];
  for (let i = 0; i < sample.length; i++) rotations.push({ i, r: sample.slice(i) + sample.slice(0, i) });
  rotations.sort((a, b) => a.r.localeCompare(b.r));
  const last = rotations.map(r => r.r[r.r.length - 1]).join('');
  return brotli11(Buffer.from(last, 'utf8')).length;
});

// ── W02: Move-To-Front transform on byte sequence ─────────────────────
attempt('W02: MTF on shape bytes + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const alphabet = Array.from({length: 256}, (_, i) => i);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const idx = alphabet.indexOf(b);
    out[i] = idx;
    alphabet.splice(idx, 1);
    alphabet.unshift(b);
  }
  return brotli11(out).length;
});

// ── W03: XOR adjacent shapes + brotli ────────────────────────────────
attempt('W03: XOR adjacent shapes + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const out = Buffer.alloc(buf.length);
  out[0] = buf[0];
  for (let i = 1; i < buf.length; i++) out[i] = buf[i] ^ buf[i-1];
  return brotli11(out).length;
});

// ── W04: Reverse the whole corpus then brotli ─────────────────────────
attempt('W04: reverse byte order + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const rev = Buffer.from(buf).reverse();
  return brotli11(rev).length;
});

// ── W05: brotli of brotli output (silly check) ─────────────────────────
attempt('W05: brotli twice', () => {
  const first = brotli11(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'));
  return brotli11(first).length;
});

// ── W06: gzip -9 on B8 ─────────────────────────────────────────────────
attempt('W06: gzip -9 on B8', () => {
  return gzip9(Buffer.from(b8shapes.join('\n') + '\n', 'utf8')).length;
});

// ── W07: brotli q6 on B8 (lower quality, test diminishing returns) ────
attempt('W07: brotli q6 on B8', () => {
  return brotli6(Buffer.from(b8shapes.join('\n') + '\n', 'utf8')).length;
});

// ── W08: deflate raw L9 on B8 ─────────────────────────────────────────
attempt('W08: deflate raw L9 on B8', () => {
  return zlib.deflateRawSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'), { level: 9 }).length;
});

// ── W09: Alphabet remap (sorted by frequency) before brotli ───────────
attempt('W09: alphabet-remap by freq + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const freq = new Uint32Array(256);
  for (const b of buf) freq[b]++;
  const remap = new Uint8Array(256);
  const indices = Array.from({length: 256}, (_, i) => i).sort((a, b) => freq[b] - freq[a]);
  indices.forEach((b, rank) => remap[b] = rank);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = remap[buf[i]];
  return brotli11(out).length + 256;  // +256 for remap table
});

// ── W10: Tokenize common phrases to byte codes 0-31 (control chars) ───
attempt('W10: token-encode top phrases + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const phraseCounts = new Map();
  const PHRASE_LEN = 25;
  for (let i = 0; i <= buf.length - PHRASE_LEN; i += 3) {
    const p = buf.slice(i, i + PHRASE_LEN).toString('binary');
    phraseCounts.set(p, (phraseCounts.get(p) || 0) + 1);
  }
  const top = [...phraseCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  let s = buf.toString('binary');
  let tokenMap = [];
  for (let t = 0; t < top.length; t++) {
    const tok = String.fromCharCode(t + 4);  // use control chars 4-19
    while (s.includes(top[t][0])) s = s.replace(top[t][0], tok);
    tokenMap.push(top[t][0]);
  }
  const encoded = Buffer.from(s, 'binary');
  const dict = Buffer.from(tokenMap.join('\0'));
  return brotli11(encoded).length + brotli11(dict).length;
});

// ── W11: Encode payload_json bytes as 6-bit (limited alphabet) ────────
attempt('W11: 6-bit pack alphabet check', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const used = new Set();
  for (const b of buf) used.add(b);
  if (used.size > 64) return -1;  // not packable
  // Build 6-bit alphabet
  const alpha = [...used].sort();
  const lut = new Map();
  alpha.forEach((b, i) => lut.set(b, i));
  // Pack 4 6-bit codes per 3 bytes
  const codeBytes = Math.ceil(buf.length * 6 / 8);
  // Then brotli
  return Math.ceil(buf.length * Math.log2(used.size) / 8);  // theoretical
});

// ── W12: Apply RLE on shape index sequence (before brotli) ─────────────
attempt('W12: shape idx + RLE + brotli', () => {
  const sortedShapeMap = new Map();
  b8shapes.forEach((s, i) => sortedShapeMap.set(s, i));
  const seq = otherIdx.map(i => sortedShapeMap.get(shapeKey(detReceipts[i])));
  // RLE
  const rle = [];
  let prev = seq[0], count = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === prev) count++;
    else { rle.push([prev, count]); prev = seq[i]; count = 1; }
  }
  rle.push([prev, count]);
  const buf = Buffer.from(rle.flatMap(([v, c]) => [...varintU(v), ...varintU(c)]));
  return brotli11(buf).length;
});

// ── W13: Recursive: brotli shapes, then brotli the brotli'd output ────
attempt('W13: recursive brotli (already tested in W05)', () => {
  return brotli11(brotli11(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'))).length;
});

// ── W14: Try MessagePack on each shape, concat, brotli ────────────────
attempt('W14: MsgPack per shape + concat + brotli', () => {
  // Very minimal msgpack: just convert each shape's JSON to a binary form
  function msgPackStr(s) {
    const u = Buffer.from(s, 'utf8');
    if (u.length < 256) return Buffer.concat([Buffer.from([0xd9, u.length]), u]);
    const lb = Buffer.alloc(3); lb[0] = 0xda; lb.writeUInt16BE(u.length, 1);
    return Buffer.concat([lb, u]);
  }
  const allParts = b8shapes.map(msgPackStr);
  return brotli11(Buffer.concat(allParts)).length;
});

// ── W15: Compute information content per char (Shannon, byte-IID) ─────
attempt('W15: IID Shannon byte floor on B8', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const c = new Uint32Array(256);
  for (const b of buf) c[b]++;
  let H = 0;
  for (let i = 0; i < 256; i++) if (c[i]) { const p = c[i]/buf.length; H -= p*Math.log2(p); }
  return Math.ceil(H * buf.length / 8);
});

// ── W16: Bit-rotate bytes by 3 left, then brotli ──────────────────────
attempt('W16: rotate bytes left by 3 + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ((buf[i] << 3) | (buf[i] >> 5)) & 0xff;
  return brotli11(out).length;
});

// ── W17: 6-bit base-64-like packing of restricted-alphabet text ───────
attempt('W17: base-64 pack ASCII text', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  // Just measure: how much would it save if alphabet really were 64
  const used = new Set();
  for (const b of buf) used.add(b);
  if (used.size > 64) return brotli11(buf).length;
  return Math.ceil(buf.length * 6 / 8);
});

// ── W18: Delta-encode the byte sequence (each byte = diff from prev) ──
attempt('W18: byte delta + brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const out = Buffer.alloc(buf.length);
  out[0] = buf[0];
  for (let i = 1; i < buf.length; i++) out[i] = (buf[i] - buf[i-1]) & 0xff;
  return brotli11(out).length;
});

// ── W19: Compute longest common substring as a static dict ────────────
attempt('W19: LCS-as-dict prepend + brotli', () => {
  // Find longest substring present 50+ times
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const phraseCounts = new Map();
  for (const L of [40, 60, 80]) {
    for (let i = 0; i <= buf.length - L; i += 5) {
      const p = buf.slice(i, i + L).toString('binary');
      phraseCounts.set(p, (phraseCounts.get(p) || 0) + 1);
    }
  }
  const top = [...phraseCounts.entries()].filter(([_, c]) => c >= 10).sort((a, b) => b[1] - a[1]).slice(0, 50);
  const dict = top.map(([p]) => p).join('\0');
  const combined = Buffer.from(dict + '\n' + b8shapes.join('\n') + '\n', 'binary');
  return brotli11(combined).length;
});

// ── W20: Apply MTF transform on the ENTIRE corpus then brotli ──────────
attempt('W20: full corpus MTF + brotli', () => {
  const buf = corpusBytes;
  const alphabet = Array.from({length: 256}, (_, i) => i);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const idx = alphabet.indexOf(b);
    out[i] = idx;
    alphabet.splice(idx, 1);
    alphabet.unshift(b);
  }
  return brotli11(out).length;
}, 'full-corpus, not just B8 shapes');

// ── W21: Apply Elias-gamma encoding to shape indices ──────────────────
attempt('W21: shape idx elias-gamma + brotli', () => {
  const sortedShapeMap = new Map();
  b8shapes.forEach((s, i) => sortedShapeMap.set(s, i));
  const seq = otherIdx.map(i => sortedShapeMap.get(shapeKey(detReceipts[i])));
  // Elias gamma: encode n as floor(log2(n+1)) zeros + binary(n+1)
  const bits = [];
  for (const n of seq) {
    const v = n + 1;
    const lg = Math.floor(Math.log2(v));
    for (let i = 0; i < lg; i++) bits.push(0);
    for (let i = lg; i >= 0; i--) bits.push((v >> i) & 1);
  }
  const bytes = Math.ceil(bits.length / 8);
  return bytes;
});

// ── W22: B8 + within-bucket sort by SimHash of payload_json ───────────
attempt('W22: B8 + within-bucket simhash sort', () => {
  // SimHash: 64-bit signature of substrings
  function simhash(s) {
    const vec = new Array(64).fill(0);
    for (let i = 0; i < s.length - 3; i++) {
      const tri = s.substr(i, 4);
      const h = crypto.createHash('sha256').update(tri).digest();
      for (let bit = 0; bit < 64; bit++) {
        const set = (h[bit >> 3] >> (7 - (bit & 7))) & 1;
        vec[bit] += set ? 1 : -1;
      }
    }
    let sig = 0n;
    for (let bit = 0; bit < 64; bit++) if (vec[bit] > 0) sig |= 1n << BigInt(bit);
    return sig;
  }
  const buckets = new Map();
  for (let i = 0; i < M; i++) {
    const a = JSON.parse(shapes[i]).action;
    if (!buckets.has(a)) buckets.set(a, []);
    buckets.get(a).push(i);
  }
  const ordering = [];
  const acts = [...buckets.keys()].sort();
  for (const a of acts) {
    const idxs = buckets.get(a);
    const sigs = idxs.map(i => simhash(shapes[i]));
    const subOrder = [...idxs].sort((a, b) => {
      const sa = sigs[idxs.indexOf(a)], sb = sigs[idxs.indexOf(b)];
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    ordering.push(...subOrder);
  }
  return brotli11(Buffer.from(ordering.map(i => shapes[i]).join('\n') + '\n', 'utf8')).length;
}, 'simhash within action bucket');

// ── W23: Try concatenating same-action shapes WITHOUT newlines ─────────
attempt('W23: B8 without newlines between shapes', () => {
  return brotli11(Buffer.from(b8shapes.join(''), 'utf8')).length;
}, 'remove `\\n` separator');

// ── W24: B8 with action prefix STRIPPED then brotli ───────────────────
attempt('W24: B8 with leading "action":"X" removed + brotli', () => {
  // Strip leading "action":"X" from each shape, brotli, add a small index of actions per receipt
  const aV = new Map();
  let stripped = [];
  for (const s of b8shapes) {
    const a = JSON.parse(s).action;
    if (!aV.has(a)) aV.set(a, aV.size);
    // Remove the action field from the JSON. Need to preserve byte-exact rest, so just strip the `"action":"X",` substring
    const re = new RegExp(`"action":"${a.replace(/\./g, '\\.')}",`);
    const m = s.match(re);
    if (!m) { stripped.push(s); continue; }
    stripped.push(s.replace(re, ''));
  }
  // Also store action vocab + per-shape action index
  const actionStream = b8shapes.map(s => aV.get(JSON.parse(s).action));
  const aIdxBytes = Buffer.from(actionStream.flatMap(varintU));
  const aBr = brotli11(aIdxBytes);
  const vBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
  const strippedBr = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
  return strippedBr.length + aBr.length + vBr.length;
}, 'split action into separate stream');

// ── W25: Word-level Huffman on shape token stream ──────────────────────
attempt('W25: word-level Huffman (estimate)', () => {
  // Tokenize by non-alphanumeric boundary
  const buf = b8shapes.join('\n');
  const tokens = buf.split(/([^a-zA-Z0-9_])/);
  const wc = new Map();
  for (const t of tokens) wc.set(t, (wc.get(t) || 0) + 1);
  const total = tokens.length;
  let H = 0;
  for (const c of wc.values()) { const p = c/total; H -= p*Math.log2(p); }
  // Bit cost = H * tokens; plus vocab cost
  const dataBits = H * total;
  const vocabBytes = [...wc.keys()].reduce((s, k) => s + k.length + 1, 0);
  return Math.ceil(dataBits / 8) + vocabBytes;
}, 'tokenize by punctuation boundary');

// ── W26: Compute Hurst exponent of B8 byte stream ──────────────────────
{
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const N2 = buf.length;
  const mean = buf.reduce((s, b) => s + b, 0) / N2;
  let cum = 0, maxC = -Infinity, minC = Infinity;
  for (const b of buf) { cum += b - mean; maxC = Math.max(maxC, cum); minC = Math.min(minC, cum); }
  const R = maxC - minC;
  let var_ = 0;
  for (const b of buf) var_ += (b - mean)**2;
  const S = Math.sqrt(var_ / N2);
  const H = Math.log(R/S) / Math.log(N2);
  console.log(`W26: B8 byte Hurst exponent                              ${H.toFixed(3)}      info     persistence proxy`);
}

// ── W27: Try B8 with shape order REVERSED ─────────────────────────────
attempt('W27: B8 reversed (last to first)', () => {
  return brotli11(Buffer.from([...b8shapes].reverse().join('\n') + '\n', 'utf8')).length;
});

// ── W28: B8 with random shuffle (control) ─────────────────────────────
attempt('W28: random shuffle of shapes (control)', () => {
  // Deterministic pseudo-shuffle using sha
  const order = b8shapes.map((s, i) => ({ s, k: crypto.createHash('sha256').update('shuffle' + i).digest('hex') })).sort((a, b) => a.k.localeCompare(b.k));
  return brotli11(Buffer.from(order.map(o => o.s).join('\n') + '\n', 'utf8')).length;
}, 'control: random shuffle should be worst');

// ── W29: B8 + within-bucket reverse-sort tiebreaker ───────────────────
attempt('W29: B8 + reverse-string within length-tie', () => {
  const ord = shapes.map((_, i) => i).sort((a, b) => {
    const A = JSON.parse(shapes[a]), B = JSON.parse(shapes[b]);
    if (A.action !== B.action) return A.action.localeCompare(B.action);
    if (shapes[a].length !== shapes[b].length) return shapes[a].length - shapes[b].length;
    return shapes[a].split('').reverse().join('').localeCompare(shapes[b].split('').reverse().join(''));
  });
  return brotli11(Buffer.from(ord.map(i => shapes[i]).join('\n') + '\n', 'utf8')).length;
});

// ── W30: B8 + within-bucket Hamming-distance greedy ───────────────────
attempt('W30: B8 + Hamming-greedy within action bucket', () => {
  const buckets = new Map();
  for (let i = 0; i < M; i++) {
    const a = JSON.parse(shapes[i]).action;
    if (!buckets.has(a)) buckets.set(a, []);
    buckets.get(a).push(i);
  }
  const ordering = [];
  const acts = [...buckets.keys()].sort();
  for (const a of acts) {
    const idxs = buckets.get(a);
    if (idxs.length <= 1) { ordering.push(...idxs); continue; }
    // Greedy Hamming-distance nearest neighbor; start from shortest
    let cur = idxs.reduce((best, i) => shapes[i].length < shapes[best].length ? i : best, idxs[0]);
    const sub = [cur];
    const used = new Set([cur]);
    while (used.size < idxs.length) {
      const s1 = shapes[cur];
      let best = -1, bestD = Infinity;
      for (const j of idxs) {
        if (used.has(j)) continue;
        const s2 = shapes[j];
        const minL = Math.min(s1.length, s2.length);
        let d = Math.abs(s1.length - s2.length);
        for (let k = 0; k < minL; k++) if (s1[k] !== s2[k]) d++;
        if (d < bestD) { bestD = d; best = j; }
      }
      used.add(best); sub.push(best); cur = best;
    }
    ordering.push(...sub);
  }
  return brotli11(Buffer.from(ordering.map(i => shapes[i]).join('\n') + '\n', 'utf8')).length;
}, 'Hamming-NN within bucket');

// ── W31: Truncate brotli context window to 16-bit ─────────────────────
attempt('W31: brotli lgwin=10 (1KB window)', () => {
  return zlib.brotliCompressSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 10 } }).length;
}, 'smaller LZ77 window');

// ── W32: brotli lgwin=24 (16MB window, max) ────────────────────────────
attempt('W32: brotli lgwin=24 (max)', () => {
  return zlib.brotliCompressSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
}, 'should be same; verifies brotli default');

// ── W33: brotli with text mode ────────────────────────────────────────
attempt('W33: brotli text-mode + B8', () => {
  return zlib.brotliCompressSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }).length;
});

// ── W34: brotli with font mode (gives surprising results sometimes) ────
attempt('W34: brotli font-mode + B8', () => {
  return zlib.brotliCompressSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'),
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT } }).length;
});

// ── W35: Encode shape JSON as bencode-style ───────────────────────────
attempt('W35: bencode-style binary + brotli', () => {
  // bencode: "<length>:<bytes>", "i<int>e", "l...e", "d...e"
  function bencode(o) {
    if (typeof o === 'string') { return o.length + ':' + o; }
    if (typeof o === 'number') return 'i' + o + 'e';
    if (typeof o === 'boolean') return 'i' + (o ? 1 : 0) + 'e';
    if (o === null) return 'i0e';
    if (Array.isArray(o)) return 'l' + o.map(bencode).join('') + 'e';
    if (typeof o === 'object') {
      const entries = Object.entries(o).sort((a, b) => a[0].localeCompare(b[0]));
      return 'd' + entries.map(([k, v]) => bencode(k) + bencode(v)).join('') + 'e';
    }
    return '';
  }
  const allBen = b8shapes.map(s => bencode(JSON.parse(s))).join('');
  return brotli11(Buffer.from(allBen)).length;
});

// ── W36: Brotli with all-CAPS lowering ─────────────────────────────────
attempt('W36: tolower + brotli', () => {
  return brotli11(Buffer.from(b8shapes.join('\n').toLowerCase() + '\n', 'utf8')).length;
}, 'lossless? only if no uppercase used to convey info');

// ── W37: Append B8 to itself + brotli (give brotli more redundancy) ───
attempt('W37: B8 corpus duplicated then brotli', () => {
  const buf = Buffer.from(b8shapes.join('\n') + '\n', 'utf8');
  const doubled = Buffer.concat([buf, buf]);
  return brotli11(doubled).length;
}, 'should be barely > single; tests brotli efficiency on redundancy');

// ── W38: pre-pad brotli with frequent JSON keys as dict ───────────────
attempt('W38: JSON-keys-as-prefix + brotli', () => {
  const dict = '"action":"' + '"status":"ok"' + '"summary":"' + '"payload_json":"' + '"created_at":"2026-06-26T09:12:';
  const combined = Buffer.from(dict + b8shapes.join('\n') + '\n', 'utf8');
  return brotli11(combined).length;
});

// ── W39: zlib level 9 (vs gzip 9) ─────────────────────────────────────
attempt('W39: zlib L9', () => {
  return zlib.deflateSync(Buffer.from(b8shapes.join('\n') + '\n', 'utf8'), { level: 9 }).length;
});

// ── W40: Encode using base64+brotli (test if base64 has structure) ────
attempt('W40: base64 + brotli', () => {
  const b64 = Buffer.from(b8shapes.join('\n') + '\n', 'utf8').toString('base64');
  return brotli11(Buffer.from(b64, 'utf8')).length;
}, 'should be worse; control');

// ── REPLAY PIPELINE SCAFFOLDING (a) ──────────────────────────────────
console.log(`\n--- (a) Replay Pipeline Scaffolding ---`);
{
  // Identify all non-deterministic sources in the corpus
  let randIds = 0, wallClocks = 0, otherEntropy = 0;
  for (const r of receipts) {
    if (/^rcpt_[0-9a-f]{16}$/.test(r.id || '')) randIds++;
    if (/2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(r.created_at || '')) wallClocks++;
    // Look for additional UUID-like or hash-like fields in payloads
    const payload = r.payload_json || '';
    const otherHashes = (payload.match(/[0-9a-f]{16,32}/g) || []).length;
    otherEntropy += otherHashes;
  }
  console.log(`Random ID receipts: ${randIds}/${N}`);
  console.log(`Wall-clock timestamps: ${wallClocks}/${N}`);
  console.log(`Hash-like fields in payloads (avg per receipt): ${(otherEntropy / N).toFixed(2)}`);
  console.log(`Conclusion: to make replay byte-exact, also need:`);
  console.log(`  1. Deterministic timestamp generation (sequence-index → fake timestamp)`);
  console.log(`  2. Audit organism for any other randomness (Math.random, crypto.randomBytes, performance.now)`);
  console.log(`  3. Wire up "replay mode" toggle so organism runs deterministically when set`);
  console.log(`  4. Build verification: run organism in replay mode, sha256-compare to canonical corpus`);
}

// ── (b) SUB-BUCKET REFINEMENT — finer tiebreakers within B8 ──────────
console.log(`\n--- (b) Sub-bucket B8 refinements ---`);
// Already extensively tested in Exp 43, 45. Best: B8 lex tiebreaker = 31,482 B.
// W29 (reverse-string), W22 (simhash), W30 (Hamming-greedy) all tested above.

console.log(`\n=== SORTED BY SIZE (smaller = better, vs B8 = 31,482) ===`);
const sortedResults = [...results].sort((a, b) => a.size - b.size);
for (const r of sortedResults.slice(0, 20)) {
  console.log(`${r.size.toString().padStart(6)} B   ΔB8 ${r.dB8 > 0 ? '+' : ''}${r.dB8.toString().padStart(5)}   ${r.name}   ${r.note}`);
}

// Project the best into Method 9
const winner = sortedResults[0];
if (winner.size < b8size) {
  const method9 = 49310;
  const newTotal = method9 - b8size + winner.size;
  console.log(`\n💎 Projected Method 9 + winner: ${method9} - ${b8size} + ${winner.size} = ${newTotal} B = ${(SIZE / newTotal).toFixed(2)}x`);
}

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '46-wildcards',
  total_experiments: results.length,
  b8_baseline: b8size,
  sorted_results: sortedResults,
}, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
