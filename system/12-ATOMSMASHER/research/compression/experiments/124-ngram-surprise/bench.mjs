// Experiment 124 — N-gram surprise over field→value token sequences
//
// Build a 3-gram model over the token stream (field-name → value-id), encode
// only the surprise tokens, and let brotli handle the residual. This is
// fundamentally about exploiting the high *order-3 conditional* predictability
// of receipt streams beyond what brotli's order-0/1 ANS can see (brotli's
// context modeling is byte-level, not token-level).
//
// Approach (tractable & honest):
//   1. Tokenize each receipt into 6 (field, value) pairs in canonical order.
//   2. Build a 3-gram model: P(token_i | token_{i-1}, token_{i-2}) over the
//      whole corpus.
//   3. For each token, compute rank = position in the model's predicted
//      distribution (most-likely=0, next=1, ...). Most tokens should be rank 0.
//   4. Encode rank stream + a fallback "literal" stream (tokens not predicted at
//      all) with brotli q11.
//   5. Compare to brotli alone on the raw corpus.
//
// IMPORTANT: this is a research probe to measure structure, not a finished
// codec. We report rank-distribution entropy as the "model surprise budget"
// and the actual encoded size including the model side info. Side info is the
// killer for n-gram models, and we expose that honestly.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) {
  return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16);
}
function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// Tokenization: 5 fields (skip id, derivable from seed)
const FIELDS = ['action', 'status', 'summary', 'payload_json', 'created_at'];

// Build a global value vocabulary indexed by (field, value-string) so a single
// token id space covers everything. Special sentinel for null.
const tokVocab = new Map();
const tokList = [];
function tokId(field, val) {
  const v = val === null || val === undefined ? '\0NULL\0' : String(val);
  const k = field + '\x01' + v;
  let i = tokVocab.get(k);
  if (i === undefined) { i = tokList.length; tokVocab.set(k, i); tokList.push(k); }
  return i;
}

const allTokens = [];
for (const r of detReceipts) {
  for (const f of FIELDS) allTokens.push(tokId(f, r[f]));
}
console.log(`Total tokens: ${allTokens.length}, unique: ${tokList.length}`);

// Build 3-gram model. Use 2-token context. For each context, sort possible
// next-tokens by frequency. Predict rank = position in that sorted list.
const ngram = new Map(); // ctxKey -> Map(token -> count)
const encStart = performance.now();
for (let i = 2; i < allTokens.length; i++) {
  const ctx = allTokens[i - 2] + ',' + allTokens[i - 1];
  let m = ngram.get(ctx);
  if (!m) { m = new Map(); ngram.set(ctx, m); }
  m.set(allTokens[i], (m.get(allTokens[i]) || 0) + 1);
}
// Build prediction tables: for each context, sorted token list by descending count.
const predTable = new Map();
for (const [ctx, m] of ngram.entries()) {
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  predTable.set(ctx, arr);
}

// Encode: for each token i>=2, output rank (or LITERAL=255 + token-id when miss).
const ranks = [];
const literals = [];
let hits = 0, misses = 0;
const RANK_CAP = 253; // 0..253 = rank, 254 = unseen-context, 255 = ctx-seen-but-rank>253
ranks.push(allTokens[0], allTokens[1]); // bootstrap — first 2 tokens as literals
for (let i = 2; i < allTokens.length; i++) {
  const ctx = allTokens[i - 2] + ',' + allTokens[i - 1];
  const pred = predTable.get(ctx);
  const tok = allTokens[i];
  if (!pred) {
    ranks.push(254);
    literals.push(tok);
    misses++;
  } else {
    const r = pred.indexOf(tok);
    if (r >= 0 && r <= RANK_CAP) {
      ranks.push(r);
      hits++;
    } else if (r >= 0) {
      ranks.push(255);
      literals.push(tok);
      hits++;
    } else {
      ranks.push(254);
      literals.push(tok);
      misses++;
    }
  }
}
console.log(`Hits: ${hits}, Misses: ${misses}, Rank-0 share will determine ratio`);

// Histogram of ranks
const rankHist = new Map();
for (const r of ranks) rankHist.set(r, (rankHist.get(r) || 0) + 1);
const top = [...rankHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`Top ranks:`, top);

// Serialize: varint-encoded rank stream, varint-encoded literal stream,
// brotli-compress both. Plus the vocab.
function varintBytes(arr) {
  const out = [];
  for (const v of arr) {
    let n = v;
    while (n >= 128) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n & 0x7f);
  }
  return Buffer.from(out);
}
const rankBuf = varintBytes(ranks);
const litBuf = varintBytes(literals);
const rankBr = brotli11(rankBuf);
const litBr = brotli11(litBuf);

// Side info: token vocab. THIS IS THE COST. Every distinct (field,value) pair
// must be reconstructable.
const vocabStr = tokList.join('\n');
const vocabBr = brotli11(Buffer.from(vocabStr, 'utf8'));

// Also: the n-gram prediction table itself? For decode we need predTable.
// That's the crushing side info — we don't ship it, instead we ship the original
// counts compactly. Encode (ctx_a, ctx_b, [(tok,count),...]) — but that's huge.
//
// HONEST TRADEOFF: to make this decodable without shipping the table, we serialize
// the (sorted-by-count) prediction lists per context as the actual predTable.
// That's the model. For N contexts, this is the cost.
// We compress it via brotli.
const predEntries = [...predTable.entries()];
const predStrParts = [];
for (const [ctx, arr] of predEntries) {
  predStrParts.push(ctx + ':' + arr.join(','));
}
const predStr = predStrParts.join('\n');
const predBr = brotli11(Buffer.from(predStr, 'utf8'));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = rankBr.length + litBr.length + vocabBr.length + predBr.length + seedR.length;
const ratio = detBytes.length / total;
const encMs = performance.now() - encStart;

// Decode
const decStart = performance.now();
function readVarints(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let n = 0, m = 1, b;
    do { b = buf[i++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    out.push(n);
  }
  return out;
}
const ranksDec = readVarints(zlib.brotliDecompressSync(rankBr));
const litsDec = readVarints(zlib.brotliDecompressSync(litBr));
const vocabDec = zlib.brotliDecompressSync(vocabBr).toString('utf8').split('\n');
const predLines = zlib.brotliDecompressSync(predBr).toString('utf8').split('\n');
const predDec = new Map();
for (const l of predLines) {
  const ci = l.indexOf(':');
  const ctx = l.slice(0, ci);
  const arr = l.slice(ci + 1).split(',').map(Number);
  predDec.set(ctx, arr);
}

const tokRecon = [ranksDec[0], ranksDec[1]];
let litCur = 0;
for (let i = 2; i < ranksDec.length; i++) {
  const ctx = tokRecon[i - 2] + ',' + tokRecon[i - 1];
  const r = ranksDec[i];
  if (r === 254 || r === 255) {
    tokRecon.push(litsDec[litCur++]);
  } else {
    const pred = predDec.get(ctx);
    tokRecon.push(pred[r]);
  }
}

// Tokens -> receipts
const FIELDS_D = ['action', 'status', 'summary', 'payload_json', 'created_at'];
const reconstructed = [];
for (let i = 0; i < N; i++) {
  const obj = { id: detId(SEED, i) };
  for (let f = 0; f < FIELDS_D.length; f++) {
    const tk = vocabDec[tokRecon[i * FIELDS_D.length + f]];
    const sep = tk.indexOf('\x01');
    const field = tk.slice(0, sep);
    let val = tk.slice(sep + 1);
    if (val === '\0NULL\0') val = null;
    obj[field] = val;
  }
  reconstructed.push(obj);
}
const decMs = performance.now() - decStart;

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`rankBr:  ${rankBr.length}`);
console.log(`litBr:   ${litBr.length}`);
console.log(`vocabBr: ${vocabBr.length}`);
console.log(`predBr:  ${predBr.length}`);
console.log(`seedR:   ${seedR.length}`);
console.log(`TOTAL:   ${total}`);
console.log(`Ratio:   ${ratio.toFixed(2)}x`);
console.log(`vs M19 (47.07x): ${ratio > 47.07 ? `+${(ratio - 47.07).toFixed(2)}` : `-${(47.07 - ratio).toFixed(2)}`}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '124-ngram-surprise',
  corpus_sha256: '5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4',
  raw_bytes: detBytes.length,
  rank_br: rankBr.length,
  lit_br: litBr.length,
  vocab_br: vocabBr.length,
  pred_br: predBr.length,
  seed_r: seedR.length,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  m19_ratio: 47.07,
  delta_vs_m19: Number((ratio - 47.07).toFixed(4)),
  enc_ms: Number(encMs.toFixed(1)),
  dec_ms: Number(decMs.toFixed(1)),
  hits, misses,
  unique_tokens: tokList.length,
  unique_contexts: ngram.size,
  lossless,
  verdict: lossless && ratio >= 47.07 ? 'GREEN' : lossless ? 'AMBER' : 'RED',
}, null, 2));
