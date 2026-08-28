// Experiment 90 — K-nearest-receipt prediction (k=3).
// Embed each receipt as a feature vector (action one-hot + numeric fields + summary length).
// For each receipt N, find k=3 nearest neighbors in receipts 0..N-1 via Hamming on action +
// Euclidean on numeric features. Encode the best as (neighbor_idx, diff) if diff_size < raw_size,
// else (none, raw). Brotli the stream.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.071;

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

function stripId(r) { const { id, ...rest } = r; return rest; }
function jsonDiff(prev, cur) {
  const diff = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  for (const k of keys) {
    if (!(k in cur)) diff['-' + k] = 1;
    else if (!(k in prev)) diff['+' + k] = cur[k];
    else if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) diff['*' + k] = cur[k];
  }
  return diff;
}
function applyDiff(prev, diff) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(diff)) {
    const key = k.slice(1);
    if (k[0] === '+' || k[0] === '*') out[key] = v;
    else if (k[0] === '-') delete out[key];
  }
  return out;
}

const t0 = performance.now();

// Action vocab
const actions = [...new Set(detReceipts.map(r => r.action))];
const actionIdx = new Map(actions.map((a, i) => [a, i]));

// Feature vector: [actionIdx (categorical), summary_length, payload_length, has_payload (0/1), status_idx]
const statuses = [...new Set(detReceipts.map(r => r.status))];
const statusIdx = new Map(statuses.map((s, i) => [s, i]));
function featureVec(r) {
  return [
    actionIdx.get(r.action),
    (r.summary?.length ?? 0),
    (r.payload_json?.length ?? 0),
    r.payload_json ? 1 : 0,
    statusIdx.get(r.status),
  ];
}
const features = detReceipts.map(featureVec);

// Distance: action mismatch costs 1000, else Euclidean over numeric features (excl action).
function dist(a, b) {
  if (a[0] !== b[0]) return 1e9;
  let s = 0;
  for (let i = 1; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// Bucket receipts by action to make k-NN cheap (only scan same-action prior receipts)
const byAction = new Map();
const encoded = [];
const stats = { used_neighbor: 0, used_raw: 0, total_diff_bytes: 0, total_raw_bytes: 0 };

for (let i = 0; i < N; i++) {
  const r = stripId(detReceipts[i]);
  const f = features[i];
  const act = detReceipts[i].action;
  const bucket = byAction.get(act);
  let bestIdx = -1, bestDiffLen = Infinity, bestDiff = null;
  const rawJson = JSON.stringify(r);
  const rawLen = Buffer.byteLength(rawJson, 'utf8');

  if (bucket && bucket.length > 0) {
    // scan up to last 64 same-action receipts for nearest k=3
    const candidates = bucket.slice(-64);
    const dists = candidates.map(j => ({ j, d: dist(f, features[j]) }));
    dists.sort((a, b) => a.d - b.d);
    const top3 = dists.slice(0, 3);
    for (const { j } of top3) {
      const prev = stripId(detReceipts[j]);
      const diff = jsonDiff(prev, r);
      const diffJson = JSON.stringify(diff);
      const diffLen = Buffer.byteLength(diffJson, 'utf8');
      if (diffLen < bestDiffLen) { bestDiffLen = diffLen; bestIdx = j; bestDiff = diff; }
    }
  }

  if (bestIdx >= 0 && bestDiffLen + 4 < rawLen) {
    encoded.push({ base: bestIdx, payload: bestDiff });
    stats.used_neighbor++;
    stats.total_diff_bytes += bestDiffLen;
  } else {
    encoded.push({ base: -1, payload: r });
    stats.used_raw++;
    stats.total_raw_bytes += rawLen;
  }

  if (!byAction.has(act)) byAction.set(act, []);
  byAction.get(act).push(i);
}

// Serialize
const streamParts = [];
for (const e of encoded) {
  const baseEnc = e.base === -1 ? 0 : e.base + 1;
  streamParts.push(...varintU(baseEnc));
  const json = JSON.stringify(e.payload);
  const jsonBuf = Buffer.from(json, 'utf8');
  streamParts.push(...varintU(jsonBuf.length));
  for (const b of jsonBuf) streamParts.push(b);
}
const streamBuf = Buffer.from(streamParts);
const streamBr = brotli11(streamBuf);
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));
const total = streamBr.length + seedR.length;
const ratio = detBytes.length / total;
const encMs = performance.now() - t0;

// Decode
const d0 = performance.now();
const streamDec = zlib.brotliDecompressSync(streamBr);
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));
const decoded = [];
{
  let ofs = 0;
  for (let i = 0; i < N; i++) {
    const [baseEnc, n1] = readVarintU(streamDec, ofs); ofs = n1;
    const [len, n2] = readVarintU(streamDec, ofs); ofs = n2;
    const json = streamDec.slice(ofs, ofs + len).toString('utf8');
    ofs += len;
    const payload = JSON.parse(json);
    if (baseEnc === 0) decoded.push(payload);
    else decoded.push(applyDiff(decoded[baseEnc - 1], payload));
  }
}
const ORDER = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
function orderKeys(r) {
  const o = {};
  for (const k of ORDER) if (k in r) o[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
  return o;
}
const reconstructed = decoded.map((shape, i) => orderKeys({ id: detId(seedDec.seed, i), ...shape }));
const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decMs = performance.now() - d0;

const summary = {
  experiment: '90-knn-prediction',
  total_bytes: total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - M19_BASELINE).toFixed(3)),
  stream_bytes: streamBr.length,
  seed_bytes: seedR.length,
  enc_ms: Math.round(encMs),
  dec_ms: Math.round(decMs),
  lossless,
  stats,
  N,
  k: 3,
  bucket_window: 64,
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
