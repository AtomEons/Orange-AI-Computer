// Experiment 82 — Tensor-decomp predictor + residual codec
//
// Hypothesis: T[action × receipt × field] has low effective tensor rank.
// Predictor: per (action, field), keep top-K most-frequent values; predict
// the one that matches the prior-of-same-action's value if any, else top-1.
// Encode only the residual: '.' = match, '!' + serialized value = miss.
// Brotli q11 the residual stream. Roundtrip sha256 must match.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }

// Build det corpus identical to Method 19 sha base
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// Canonical field order matches the JSON.stringify output:
// id, action, status, summary, payload_json, created_at
const FIELDS = ['action', 'status', 'summary', 'payload_json', 'created_at'];
// id is regenerated deterministically — never predicted/emitted.

// Build per-(action, field) value frequency table
function buildFreqTable() {
  const tbl = new Map(); // action -> field -> Map(value -> count)
  for (const r of detReceipts) {
    let af = tbl.get(r.action);
    if (!af) { af = new Map(); tbl.set(r.action, af); }
    for (const f of FIELDS) {
      let vf = af.get(f);
      if (!vf) { vf = new Map(); af.set(f, vf); }
      const v = r[f] == null ? '\0NULL\0' : String(r[f]);
      vf.set(v, (vf.get(v) || 0) + 1);
    }
  }
  return tbl;
}

const freqTable = buildFreqTable();

// For a given rank K, build per-(action, field) top-K list ordered by frequency desc
function buildTopK(K) {
  const top = new Map(); // action -> field -> [value]
  for (const [a, af] of freqTable) {
    const fmap = new Map();
    for (const [f, vf] of af) {
      const arr = [...vf.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      fmap.set(f, arr.slice(0, K).map(([v]) => v));
    }
    top.set(a, fmap);
  }
  return top;
}

// Encode the corpus at rank K
function encodeAtRank(K) {
  const topK = buildTopK(K);

  // Track previous-of-same-action receipt for the recurrence
  const prevByAction = new Map();

  // Residual stream: bytes
  //   0x2E '.' = match top-K candidate (then varint candidate idx)
  //   0x21 '!' = miss, followed by length-prefixed UTF-8 value
  //   0x40 '@' = match prior-of-same-action recurrence (no length needed)
  // We use the prior-recurrence ONLY when K >= 10 per the spec.
  const useRecur = K >= 10;
  const resBytes = [];

  function writeVarint(n) {
    while (n >= 128) { resBytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    resBytes.push(n & 0x7f);
  }

  let matches = 0, recurMatches = 0, misses = 0;

  for (let i = 0; i < N; i++) {
    const r = detReceipts[i];
    const af = topK.get(r.action);
    const prior = useRecur ? prevByAction.get(r.action) : null;

    for (const f of FIELDS) {
      const v = r[f] == null ? '\0NULL\0' : String(r[f]);
      const candidates = af.get(f) || [];
      const idx = candidates.indexOf(v);

      if (idx >= 0) {
        resBytes.push(0x2E); // '.'
        writeVarint(idx);
        matches++;
      } else if (useRecur && prior && (prior[f] == null ? '\0NULL\0' : String(prior[f])) === v) {
        resBytes.push(0x40); // '@'
        recurMatches++;
      } else {
        resBytes.push(0x21); // '!'
        const vb = Buffer.from(v, 'utf8');
        writeVarint(vb.length);
        for (const x of vb) resBytes.push(x);
        misses++;
      }
    }

    prevByAction.set(r.action, r);
  }

  // Serialize predictor tables: brotli the JSON of action -> field -> [topK values]
  const tableObj = {};
  for (const [a, fmap] of topK) {
    tableObj[a] = {};
    for (const [f, arr] of fmap) tableObj[a][f] = arr;
  }
  const tableJson = JSON.stringify(tableObj);
  const tableBr = brotli11(Buffer.from(tableJson, 'utf8'));

  // Meta: { K, seed, n, useRecur }
  const metaJson = JSON.stringify({ K, seed: SEED, n: N, useRecur });
  const metaBr = brotli11(Buffer.from(metaJson, 'utf8'));

  // Brotli the residual
  const resBuf = Buffer.from(resBytes);
  const resBr = brotli11(resBuf);

  return {
    K, matches, recurMatches, misses,
    resBytes: resBr.length,
    tableBytes: tableBr.length,
    metaBytes: metaBr.length,
    total: resBr.length + tableBr.length + metaBr.length,
    // Hand decode payload back to verifier
    _resBr: resBr, _tableBr: tableBr, _metaBr: metaBr,
  };
}

// Decode a rank-K bundle and check sha256 match
function decodeAndVerify(enc) {
  const meta = JSON.parse(zlib.brotliDecompressSync(enc._metaBr).toString('utf8'));
  const tableObj = JSON.parse(zlib.brotliDecompressSync(enc._tableBr).toString('utf8'));
  const resBuf = zlib.brotliDecompressSync(enc._resBr);

  // Rebuild topK per (action, field)
  const topK = new Map();
  for (const a in tableObj) {
    const fmap = new Map();
    for (const f in tableObj[a]) fmap.set(f, tableObj[a][f]);
    topK.set(a, fmap);
  }

  let ofs = 0;
  function readVarint() {
    let n = 0, m = 1, b;
    do { b = resBuf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    return n;
  }

  // We don't have action stream — we need to know action to look up tables.
  // CRITICAL: actions must be known to decode. We store action as the FIRST
  // field in FIELDS order, so the decoder learns action from the first decoded
  // value per receipt before looking up subsequent fields.
  // Wait — but to look up the top-K for the FIRST field (action), we need... action.
  // Resolution: action is the FIRST field. For action, we use a GLOBAL top-K
  // (all receipts collapsed) so it can be decoded without knowing action yet.

  // Decode N receipts. For each receipt, first field is action.
  // We need a GLOBAL top-K for the action field that doesn't depend on knowing action.
  // Build it now from the predictor tables: union all top-K[a].action lists.

  // Actually simpler: emit a separate small global-action top-K table and use it
  // ONLY for the action field. The (action, field) tables apply to fields after action.

  // For this experiment we accept that the encoder/decoder share the convention:
  // The encoder writes the action value WITH the action it was bucketed under.
  // To decode: for the first field of each receipt we look up the predictor by
  // the action value we're trying to decode... which is circular.
  //
  // FIX: build a special "global" predictor entry under key "*" that holds top-K
  // for the action field, and use that for the first field only.

  // Rebuild global action top-K from raw frequency data on the encoder side and
  // ship it as table["*"].action. Decoder uses table["*"] for FIELDS[0].

  if (!tableObj['*']) throw new Error('missing global table for action field');

  const reconstructed = [];
  const prevByAction = new Map();

  for (let i = 0; i < meta.n; i++) {
    const rec = {};
    let actionVal = null;

    for (let fi = 0; fi < FIELDS.length; fi++) {
      const f = FIELDS[fi];
      const tag = resBuf[ofs++];
      let v;

      if (tag === 0x2E) { // match
        const idx = readVarint();
        const candidates = fi === 0 ? tableObj['*'][f] : tableObj[actionVal][f];
        v = candidates[idx];
      } else if (tag === 0x40) { // recurrence
        const prior = prevByAction.get(actionVal);
        v = prior[f] == null ? '\0NULL\0' : String(prior[f]);
      } else if (tag === 0x21) { // miss
        const len = readVarint();
        v = resBuf.slice(ofs, ofs + len).toString('utf8');
        ofs += len;
      } else {
        throw new Error('bad tag ' + tag + ' at ofs ' + (ofs - 1));
      }

      if (fi === 0) actionVal = v;
      rec[f] = v === '\0NULL\0' ? null : v;
    }

    // Regenerate id deterministically
    const out = {
      id: detId(meta.seed, i),
      action: rec.action,
      status: rec.status,
      summary: rec.summary,
      payload_json: rec.payload_json,
      created_at: rec.created_at,
    };
    reconstructed.push(out);
    prevByAction.set(rec.action, rec);
  }

  const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  return { lossless: recSha === detSha, recSha };
}

// Augment encoder to also emit the global action top-K under key "*"
function encodeAtRankWithGlobal(K) {
  // Build global action frequencies (across all receipts)
  const globalAction = new Map();
  for (const r of detReceipts) {
    const v = String(r.action);
    globalAction.set(v, (globalAction.get(v) || 0) + 1);
  }
  const globalActionTopK = [...globalAction.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, K).map(([v]) => v);

  const topK = buildTopK(K);

  const tableObj = { '*': { action: globalActionTopK } };
  for (const [a, fmap] of topK) {
    tableObj[a] = {};
    for (const [f, arr] of fmap) tableObj[a][f] = arr;
  }
  const tableJson = JSON.stringify(tableObj);
  const tableBr = brotli11(Buffer.from(tableJson, 'utf8'));

  const useRecur = K >= 10;
  const metaJson = JSON.stringify({ K, seed: SEED, n: N, useRecur });
  const metaBr = brotli11(Buffer.from(metaJson, 'utf8'));

  const prevByAction = new Map();
  const resBytes = [];
  function writeVarint(n) {
    while (n >= 128) { resBytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    resBytes.push(n & 0x7f);
  }

  let matches = 0, recurMatches = 0, misses = 0;
  let totalFields = 0;

  for (let i = 0; i < N; i++) {
    const r = detReceipts[i];
    const af = topK.get(r.action);
    const prior = useRecur ? prevByAction.get(r.action) : null;

    for (let fi = 0; fi < FIELDS.length; fi++) {
      const f = FIELDS[fi];
      const v = r[f] == null ? '\0NULL\0' : String(r[f]);
      const candidates = fi === 0 ? globalActionTopK : af.get(f);
      const idx = candidates.indexOf(v);
      totalFields++;

      if (idx >= 0) {
        resBytes.push(0x2E);
        writeVarint(idx);
        matches++;
      } else if (useRecur && fi > 0 && prior && (prior[f] == null ? '\0NULL\0' : String(prior[f])) === v) {
        // Recurrence is only legal for fi > 0 because decoder needs actionVal first
        resBytes.push(0x40);
        recurMatches++;
      } else {
        resBytes.push(0x21);
        const vb = Buffer.from(v, 'utf8');
        writeVarint(vb.length);
        for (const x of vb) resBytes.push(x);
        misses++;
      }
    }

    prevByAction.set(r.action, r);
  }

  const resBuf = Buffer.from(resBytes);
  const resBr = brotli11(resBuf);

  return {
    K, matches, recurMatches, misses, totalFields,
    accuracy: (matches + recurMatches) / totalFields,
    resBytes: resBr.length,
    tableBytes: tableBr.length,
    metaBytes: metaBr.length,
    total: resBr.length + tableBr.length + metaBr.length,
    _resBr: resBr, _tableBr: tableBr, _metaBr: metaBr,
  };
}

// Sweep
const M19_RATIO = 47.07;
const ranks = [1, 3, 5, 10];
const results = [];

console.log(`Corpus: ${N} receipts, ${detBytes.length} bytes, sha256 ${detSha.slice(0, 16)}...`);
console.log(`Method 19 baseline ratio: ${M19_RATIO}×\n`);

for (const K of ranks) {
  const t0 = Date.now();
  const enc = encodeAtRankWithGlobal(K);
  const encMs = Date.now() - t0;

  const t1 = Date.now();
  const { lossless } = decodeAndVerify(enc);
  const decMs = Date.now() - t1;

  const ratio = detBytes.length / enc.total;
  const delta = ratio - M19_RATIO;
  console.log(`Rank ${K}: residual=${enc.resBytes}B  table=${enc.tableBytes}B  meta=${enc.metaBytes}B  total=${enc.total}B  ratio=${ratio.toFixed(2)}×  vs M19 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}  acc=${(enc.accuracy * 100).toFixed(1)}%  roundtrip=${lossless ? 'yes' : 'NO'}  (enc ${encMs}ms / dec ${decMs}ms)`);

  results.push({
    K,
    residual_bytes: enc.resBytes,
    predictor_tables_bytes: enc.tableBytes + enc.metaBytes,
    total: enc.total,
    ratio: Number(ratio.toFixed(2)),
    vs_M19: Number(delta.toFixed(2)),
    accuracy_pct: Number((enc.accuracy * 100).toFixed(1)),
    matches: enc.matches,
    recur_matches: enc.recurMatches,
    misses: enc.misses,
    total_fields: enc.totalFields,
    roundtrip: lossless,
    enc_ms: encMs,
    dec_ms: decMs,
  });
}

// Calibration finding
const accBySaturation = results.map(r => r.accuracy_pct);
let saturationRank = 1;
for (let i = 1; i < results.length; i++) {
  if (results[i].accuracy_pct - results[i-1].accuracy_pct > 0.5) saturationRank = results[i].K;
}
const peakAcc = Math.max(...accBySaturation);

console.log(`\neffective rank of corpus ≈ ${saturationRank} (prediction accuracy ${peakAcc.toFixed(1)}% saturates at rank ${saturationRank})`);

const summary = {
  experiment: '82-tensor-residual',
  corpus_sha256_prefix: detSha.slice(0, 16),
  N,
  raw_bytes: detBytes.length,
  M19_baseline_ratio: M19_RATIO,
  results,
  effective_rank: saturationRank,
  peak_accuracy_pct: peakAcc,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nsummary.json written.`);
