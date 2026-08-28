// Experiment 99 — Empirical entropy lower bound on the canonical corpus.
// Measure H(byte) and conditional H(byte | prev k bytes) for k=1,2,3.
// Compare Shannon ceiling against brotli q11 and M19.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const buf = Buffer.from(detJsonl, 'utf8');
const N = buf.length;
console.log(`Corpus size: ${N} bytes, ${detReceipts.length} receipts`);

// ---- H(byte) order-0
const h0Counts = new Uint32Array(256);
for (let i = 0; i < N; i++) h0Counts[buf[i]]++;
let H0 = 0;
for (let s = 0; s < 256; s++) {
  if (h0Counts[s] === 0) continue;
  const p = h0Counts[s] / N;
  H0 -= p * Math.log2(p);
}

// ---- Order-k conditional entropy using context-table H(X_n | X_{n-k..n-1})
// H(X|C) = -sum_{c,x} p(c,x) log2 p(x|c) = sum_c p(c) H(X|C=c)
// Encoded compressed_bits ≈ N * H_k. So Shannon ceiling bytes = ceil(N*H_k/8).
function condEntropy(k) {
  // build context counts via integer key
  // for k=1: 256 contexts, 256 outcomes. Use Uint32Array of size 256*256 = 65536.
  // for k=2: 256^2 contexts, but sparse. Use Map.
  // for k=3: very sparse. Use Map keyed by uint32 packed.
  if (k === 1) {
    const tab = new Uint32Array(256 * 256);
    const ctxSum = new Uint32Array(256);
    for (let i = k; i < N; i++) {
      const c = buf[i - 1];
      const x = buf[i];
      tab[c * 256 + x]++;
      ctxSum[c]++;
    }
    const total = N - k;
    let Hk = 0;
    for (let c = 0; c < 256; c++) {
      const sum = ctxSum[c];
      if (sum === 0) continue;
      const pc = sum / total;
      let Hxc = 0;
      const base = c * 256;
      for (let x = 0; x < 256; x++) {
        const cnt = tab[base + x];
        if (cnt === 0) continue;
        const pxc = cnt / sum;
        Hxc -= pxc * Math.log2(pxc);
      }
      Hk += pc * Hxc;
    }
    return Hk;
  }
  // k >= 2: Map context -> [sum, Map(x->count)]
  const ctxMap = new Map();
  for (let i = k; i < N; i++) {
    // pack k bytes into a string key (faster than number for k>=4)
    let key = '';
    for (let j = 0; j < k; j++) key += String.fromCharCode(buf[i - k + j]);
    let e = ctxMap.get(key);
    if (!e) { e = { sum: 0, outcomes: new Uint32Array(256) }; ctxMap.set(key, e); }
    e.sum++;
    e.outcomes[buf[i]]++;
  }
  const total = N - k;
  let Hk = 0;
  for (const e of ctxMap.values()) {
    const sum = e.sum;
    const pc = sum / total;
    let Hxc = 0;
    for (let x = 0; x < 256; x++) {
      const cnt = e.outcomes[x];
      if (cnt === 0) continue;
      const pxc = cnt / sum;
      Hxc -= pxc * Math.log2(pxc);
    }
    Hk += pc * Hxc;
  }
  return Hk;
}

const t0 = performance.now();
const H1 = condEntropy(1); const t1 = performance.now();
const H2 = condEntropy(2); const t2 = performance.now();
const H3 = condEntropy(3); const t3 = performance.now();
console.log(`H0 = ${H0.toFixed(4)} bits/byte`);
console.log(`H1 = ${H1.toFixed(4)} bits/byte (${(t1-t0).toFixed(0)}ms)`);
console.log(`H2 = ${H2.toFixed(4)} bits/byte (${(t2-t1).toFixed(0)}ms)`);
console.log(`H3 = ${H3.toFixed(4)} bits/byte (${(t3-t2).toFixed(0)}ms)`);

function ceilingBytes(Hbits) { return Math.ceil(N * Hbits / 8); }
const ceil0 = ceilingBytes(H0);
const ceil1 = ceilingBytes(H1);
const ceil2 = ceilingBytes(H2);
const ceil3 = ceilingBytes(H3);
const ratio0 = N / ceil0;
const ratio1 = N / ceil1;
const ratio2 = N / ceil2;
const ratio3 = N / ceil3;
console.log(`\nShannon ceiling (raw=${N} bytes):`);
console.log(`  order-0: ${ceil0} bytes -> ${ratio0.toFixed(2)}x`);
console.log(`  order-1: ${ceil1} bytes -> ${ratio1.toFixed(2)}x`);
console.log(`  order-2: ${ceil2} bytes -> ${ratio2.toFixed(2)}x`);
console.log(`  order-3: ${ceil3} bytes -> ${ratio3.toFixed(2)}x`);

const brotli11 = 17.13;
const m19 = 47.07;
console.log(`\nbrotli q11 (17.13x) sits at ${(brotli11/ratio3*100).toFixed(1)}% of order-3 ceiling`);
console.log(`M19 (47.07x) sits at ${(m19/ratio3*100).toFixed(1)}% of order-3 ceiling`);
// M19 EXCEEDS the order-3 finite-context byte ceiling. Why? Because M19 uses
// structural reasoning (deterministic id regeneration via seed, mesh-receipt
// templating, action-vocab strip, position-class RLE) — it removes information
// the byte-stream entropy model has no notion of. The byte-level Shannon bound
// is NOT the true compressibility ceiling for structured data; it's a sanity
// reference only.

const summary = {
  experiment: '99-entropy-bound',
  corpus_size_bytes: N,
  receipts: detReceipts.length,
  H_bits_per_byte: { order0: H0, order1: H1, order2: H2, order3: H3 },
  shannon_ceiling_bytes: { order0: ceil0, order1: ceil1, order2: ceil2, order3: ceil3 },
  shannon_ceiling_ratio: { order0: Number(ratio0.toFixed(3)), order1: Number(ratio1.toFixed(3)), order2: Number(ratio2.toFixed(3)), order3: Number(ratio3.toFixed(3)) },
  brotli_q11_ratio: brotli11,
  m19_ratio: m19,
  m19_pct_of_order3_ceiling: Number((m19/ratio3*100).toFixed(2)),
  brotli_pct_of_order3_ceiling: Number((brotli11/ratio3*100).toFixed(2)),
  finding: m19 > ratio3
    ? `M19 EXCEEDS order-3 byte-Shannon ceiling (${ratio3.toFixed(2)}x). Structural pipeline reasons outside the byte stream — seed-regenerated ids + mesh templating + action vocab + position RLE remove information the byte-Markov model has no concept of. The byte-level bound is NOT the true compressibility ceiling for this structured corpus; it is a sanity reference.`
    : `M19 at ${(m19/ratio3*100).toFixed(1)}% of order-3 ceiling — finite headroom remains.`
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\nWrote summary.json');
