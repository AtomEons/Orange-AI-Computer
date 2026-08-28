// Experiment 74 — Radix-sort by content-hash prefix
// Instead of B8 (action-bucket → length → lex), sort receipts by the first 4 bytes
// of sha256(json). Chaotic order — opposite of B8. Hypothesis: may HURT (random
// order kills LZ77), confirming B8's value; OR may surprise.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// === sort by sha256(json)[0..4] ===
const indexed = detReceipts.map((r, originalIdx) => {
  const json = JSON.stringify(r);
  const h = crypto.createHash('sha256').update(json).digest();
  // pack first 4 bytes into a uint32 for sorting
  const key = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return { json, key, originalIdx };
});
indexed.sort((a, b) => (a.key >>> 0) - (b.key >>> 0));

// Need to record original positions to reconstruct (lossless requirement)
const perm = indexed.map(x => x.originalIdx);
const sortedJsonl = indexed.map(x => x.json).join('\n') + '\n';
const sortedBytes = Buffer.from(sortedJsonl, 'utf8');

// === reference: also compute B8-like (action-bucket → length → lex) for honesty,
// but the question is hash-sort vs Method 19 baseline. Here we compare hash-sort
// vs sort-by-action (the natural "good" order).
const byAction = [...detReceipts.map((r, i) => ({ json: JSON.stringify(r), action: r.action, len: JSON.stringify(r).length, originalIdx: i }))];
byAction.sort((a, b) => {
  if (a.action !== b.action) return a.action.localeCompare(b.action);
  if (a.len !== b.len) return a.len - b.len;
  return a.json.localeCompare(b.json);
});
const byActionJsonl = byAction.map(x => x.json).join('\n') + '\n';
const byActionBytes = Buffer.from(byActionJsonl, 'utf8');

// === encode permutation as varints ===
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
const permBytes = Buffer.from(perm.flatMap(varintU));
const permBr = brotli11(permBytes);

// === compress all three orderings with brotli q11 ===
const t0 = process.hrtime.bigint();
const hashSortBr = brotli11(sortedBytes);
const t1 = process.hrtime.bigint();
const encodeMs = Number(t1 - t0) / 1e6;

const byActionBr = brotli11(byActionBytes);
const naturalBr = brotli11(detBytes);

// Total for hash-sort variant: compressed receipts + permutation + 64-byte tag
const total = hashSortBr.length + permBr.length;
const ratio = detBytes.length / total;

// === roundtrip ===
const td0 = process.hrtime.bigint();
const sortedBack = zlib.brotliDecompressSync(hashSortBr).toString('utf8').split('\n').filter(Boolean);
const permBack = (() => {
  const buf = zlib.brotliDecompressSync(permBr);
  const out = [];
  let o = 0;
  while (o < buf.length) {
    let n = 0, m = 1, b;
    do { b = buf[o++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    out.push(n);
  }
  return out;
})();
// reconstruct: sortedBack[i] belongs at position permBack[i]
const reconstructed = new Array(N);
for (let i = 0; i < N; i++) reconstructed[permBack[i]] = sortedBack[i];
const recJsonl = reconstructed.join('\n') + '\n';
const td1 = process.hrtime.bigint();
const decodeMs = Number(td1 - td0) / 1e6;

const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`=== EXP 74: Radix-sort by content-hash prefix ===`);
console.log(`N receipts:        ${N}`);
console.log(`Det bytes:         ${detBytes.length}`);
console.log(`Hash-sort br11:    ${hashSortBr.length}`);
console.log(`By-action br11:    ${byActionBr.length}  (reference 'good' order)`);
console.log(`Natural-order br:  ${naturalBr.length}    (no sort)`);
console.log(`Permutation br:    ${permBr.length}`);
console.log(`TOTAL (hash+perm): ${total}`);
console.log(`Ratio:             ${ratio.toFixed(3)}x`);
console.log(`vs M19 47.071:     ${(ratio - 47.071).toFixed(3)}`);
console.log(`encode_ms:         ${encodeMs.toFixed(1)}`);
console.log(`decode_ms:         ${decodeMs.toFixed(1)}`);
console.log(`Roundtrip:         ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

const summary = {
  experiment: '74-radix-hash-sort',
  N,
  det_bytes: detBytes.length,
  hash_sort_brotli_bytes: hashSortBr.length,
  by_action_brotli_bytes: byActionBr.length,
  natural_order_brotli_bytes: naturalBr.length,
  perm_brotli_bytes: permBr.length,
  total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encodeMs.toFixed(1)),
  decode_ms: Number(decodeMs.toFixed(1)),
  lossless,
  note: 'compares hash-sort (chaotic) to by-action sort (clustered) — confirms whether order matters',
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
