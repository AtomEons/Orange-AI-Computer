// Experiment 89 — Receipt-pair delta encoding.
// For each receipt N, find the nearest prior receipt with the same action.
// Encode as (prior_idx, JSON-diff). Brotli the diff stream. Decode by walking forward.
// sha256 verify.

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

const t0 = performance.now();

// Compute a tiny JSON diff. Diff format we encode as JSON object:
//   { _base: priorIdx, +k: newValue, -k: 1, *k: newValue (changed) }
// We strip `id` for the diff because it's regen'd at decode.
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

// Find nearest prior receipt with same action.
const lastByAction = new Map();
const encoded = [];
for (let i = 0; i < N; i++) {
  const r = stripId(detReceipts[i]);
  const act = r.action;
  const priorIdx = lastByAction.get(act);
  if (priorIdx === undefined) {
    // No prior — emit full receipt
    encoded.push({ base: -1, payload: r });
  } else {
    const prior = stripId(detReceipts[priorIdx]);
    const diff = jsonDiff(prior, r);
    encoded.push({ base: priorIdx, payload: diff });
  }
  lastByAction.set(act, i);
}

// Serialize: stream is [base(varint, -1 -> 0, real idx -> i+1)][payload-json][\n]
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
    if (baseEnc === 0) {
      decoded.push(payload);
    } else {
      const prev = decoded[baseEnc - 1];
      decoded.push(applyDiff(prev, payload));
    }
  }
}
// Reattach id and rebuild jsonl
const reconstructed = decoded.map((shape, i) => ({
  id: detId(seedDec.seed, i),
  ...shape,
}));
// Need to match key order of det receipts (id, action, status, summary, payload_json, created_at)
const ORDER = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
function orderKeys(r) {
  const o = {};
  for (const k of ORDER) if (k in r) o[k] = r[k];
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
  return o;
}
const recJsonl = reconstructed.map(r => JSON.stringify(orderKeys(r))).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decMs = performance.now() - d0;

const summary = {
  experiment: '89-pair-delta',
  total_bytes: total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - M19_BASELINE).toFixed(3)),
  stream_bytes: streamBr.length,
  seed_bytes: seedR.length,
  enc_ms: Math.round(encMs),
  dec_ms: Math.round(decMs),
  lossless,
  N,
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
